import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { BrowserController } from "./browser.js";
import { tools } from "./tools.js";

const CLAUDE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";

interface ClaudeOAuthCreds {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

function getCredentialsPath(): string {
  return join(homedir(), ".claude", ".credentials.json");
}

/** Read OAuth credentials from Claude Code's credentials file. */
function readClaudeOAuth(): ClaudeOAuthCreds | null {
  try {
    const raw = readFileSync(getCredentialsPath(), "utf-8");
    const creds = JSON.parse(raw);
    const oauth = creds?.claudeAiOauth;
    if (oauth?.accessToken && oauth?.refreshToken) return oauth;
  } catch {}
  return null;
}

/** Read just the access token (backward compat). */
function readClaudeOAuthToken(): string | null {
  return readClaudeOAuth()?.accessToken ?? null;
}

/** Refresh the OAuth access token using the refresh token, and save to credentials file. */
async function refreshOAuthToken(): Promise<string | null> {
  const oauth = readClaudeOAuth();
  if (!oauth?.refreshToken) return null;

  console.log("\x1b[36m[Auth] Обновление OAuth-токена...\x1b[0m");
  try {
    const res = await fetch(CLAUDE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: CLAUDE_OAUTH_CLIENT_ID,
        refresh_token: oauth.refreshToken,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.log(`\x1b[31m[Auth] Refresh failed: ${res.status} ${body.substring(0, 100)}\x1b[0m`);
      return null;
    }

    const data = await res.json() as any;
    console.log(`\x1b[90m[Auth] Response keys: ${Object.keys(data).join(", ")}\x1b[0m`);
    const newToken = data.access_token;
    if (newToken) {
      console.log(`\x1b[90m[Auth] Token prefix: ${newToken.substring(0, 20)}... (len=${newToken.length})\x1b[0m`);
    } else {
      console.log(`\x1b[31m[Auth] No access_token in response: ${JSON.stringify(data).substring(0, 200)}\x1b[0m`);
      return null;
    }

    // Save updated credentials back to file
    try {
      const raw = readFileSync(getCredentialsPath(), "utf-8");
      const creds = JSON.parse(raw);
      creds.claudeAiOauth.accessToken = newToken;
      if (data.refresh_token) creds.claudeAiOauth.refreshToken = data.refresh_token;
      if (data.expires_in) creds.claudeAiOauth.expiresAt = Date.now() + data.expires_in * 1000;
      const { writeFileSync } = await import("fs");
      writeFileSync(getCredentialsPath(), JSON.stringify(creds));
    } catch {}

    console.log("\x1b[32m[Auth] Токен обновлён!\x1b[0m");
    return newToken;
  } catch (err: any) {
    console.log(`\x1b[31m[Auth] Refresh error: ${err.message}\x1b[0m`);
    return null;
  }
}

const SYSTEM_PROMPT = `You are an autonomous browser automation agent. You control a real web browser to complete tasks given by the user. You think and act step by step.

## How You See the Page
- Use get_page_state to see the current URL, page title, visible text, and a numbered list of interactive elements
- Use screenshot to visually see the page (useful for complex layouts, visual verification, captchas)
- Elements are numbered [0], [1], [2], etc. — reference them by number in click, type_text, hover, select_option

## Workflow
1. Understand the user's task
2. Navigate to the appropriate website
3. Observe the page (get_page_state is auto-included after navigate)
4. Plan your next action
5. Execute the action
6. Observe the result — call get_page_state after any action that changes the page
7. Repeat steps 4–6 until the task is done
8. Call task_complete with a summary

## Important Rules
- NEVER assume page structure, URLs, or selectors — always discover them from the page content
- ALWAYS call get_page_state after clicks that open menus, submit forms, or change content
- Element numbers change after page updates — always refresh before interacting
- If text content is unclear, use screenshot for visual context
- If an element doesn't work, try alternatives (different element, keyboard shortcut, etc.)
- For search: type query then press Enter or click the search button
- For dropdowns/menus: try click or hover to open, then get_page_state to see new options
- Handle cookie banners, popups, and overlays by interacting with them (close/accept)
- If stuck, scroll to find more content or try a different approach
- When task is done, call task_complete — don't just describe what you did, signal completion

## Communication
- If you need info from the user, use ask_user (e.g., login credentials, preferences)
- Think aloud briefly in text before each action to show your reasoning
`;

type AskUserFn = (question: string) => Promise<string>;

export class Agent {
  private client: Anthropic;
  private browser: BrowserController;
  private messages: Anthropic.MessageParam[] = [];
  private askUser: AskUserFn;
  private model: string;
  private maxSteps: number;
  private useOAuth: boolean = false;

  constructor(browser: BrowserController, askUser: AskUserFn) {
    const opts: ConstructorParameters<typeof Anthropic>[0] = {};

    // Priority: env ANTHROPIC_API_KEY > env AUTH_TOKEN > Claude subscription OAuth
    if (process.env.ANTHROPIC_BASE_URL) {
      opts.baseURL = process.env.ANTHROPIC_BASE_URL;
    }
    if (process.env.ANTHROPIC_AUTH_TOKEN) {
      opts.apiKey = process.env.ANTHROPIC_AUTH_TOKEN;
    }
    if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
      const oauthToken = readClaudeOAuthToken();
      if (oauthToken) {
        opts.apiKey = oauthToken;
        this.useOAuth = true;
        console.log(
          "\x1b[36m[Auth] Используется OAuth-токен подписки Claude Code.\x1b[0m"
        );
        console.log(
          "\x1b[33m[!] Закройте Claude Code перед запуском, чтобы избежать rate limit.\x1b[0m"
        );
      }
    }

    this.client = new Anthropic(opts);
    this.browser = browser;
    this.askUser = askUser;
    this.model = process.env.CLAUDE_MODEL || "claude-sonnet-4-6";
    this.maxSteps = parseInt(process.env.MAX_STEPS || "60", 10);
  }

  async run(task: string): Promise<string> {
    // Reset conversation for new task
    this.messages = [
      {
        role: "user",
        content: `Task: ${task}\n\nStart by navigating to the appropriate website or calling get_page_state to see the current page. Work step by step until the task is complete.`,
      },
    ];

    // Only refresh OAuth token if it's expired or about to expire (< 5 min)
    if (this.useOAuth) {
      const oauth = readClaudeOAuth();
      const expiresIn = (oauth?.expiresAt ?? 0) - Date.now();
      if (expiresIn < 5 * 60 * 1000) {
        console.log("\x1b[33m[Auth] Токен истёк или истекает, обновляю...\x1b[0m");
        const freshToken = await refreshOAuthToken();
        if (freshToken) {
          this.client = new Anthropic({ apiKey: freshToken });
        }
      } else {
        // Re-read token from file (Claude Code may have refreshed it)
        const currentToken = oauth?.accessToken;
        if (currentToken) {
          this.client = new Anthropic({ apiKey: currentToken });
          console.log(`\x1b[36m[Auth] Токен валиден ещё ${Math.round(expiresIn / 60000)} мин.\x1b[0m`);
        }
      }
    }

    console.log("\x1b[36m[Agent] Starting task execution...\x1b[0m");

    for (let step = 1; step <= this.maxSteps; step++) {
      // Context management: replace old screenshots with placeholders
      this.pruneOldScreenshots();

      console.log(`\x1b[90m── step ${step}/${this.maxSteps} ──\x1b[0m`);

      let response: Anthropic.Message;
      try {
        response = await this.callAPI();
      } catch (err: any) {
        console.log(`\x1b[31m[API Error] ${err.message}\x1b[0m`);
        // If context is too long, try trimming
        if (
          err.message?.includes("too long") ||
          err.message?.includes("token")
        ) {
          const beforeLen = this.messages.length;
          this.trimConversation();
          if (this.messages.length >= beforeLen) {
            this.aggressiveTrim();
            if (this.messages.length >= beforeLen) {
              return "Error: conversation too large even after trimming. Please start a new task.";
            }
          }
          continue;
        }
        throw err;
      }

      // Add assistant response to history
      this.messages.push({ role: "assistant", content: response.content });

      // Print agent's text reasoning
      for (const block of response.content) {
        if (block.type === "text" && block.text.trim()) {
          console.log(`\x1b[35m[Agent] ${block.text}\x1b[0m`);
        }
      }

      // If no tool calls — agent is done speaking
      if (response.stop_reason === "end_turn") {
        const texts = response.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text);
        return texts.join("\n") || "(Agent finished without a summary)";
      }

      if (response.stop_reason !== "tool_use") {
        return "(Agent stopped unexpectedly)";
      }

      // Execute tool calls
      const toolUseBlocks = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
      );

      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const toolCall of toolUseBlocks) {
        const input = toolCall.input as Record<string, any>;
        const display = this.formatToolCall(toolCall.name, input);
        console.log(`\x1b[33m  > ${display}\x1b[0m`);

        // Handle task_complete — return immediately
        if (toolCall.name === "task_complete") {
          const summary = input.summary || "Task completed.";
          console.log(`\x1b[32m[Done] ${summary}\x1b[0m`);
          return summary;
        }

        // Handle ask_user — prompt in terminal
        if (toolCall.name === "ask_user") {
          const answer = await this.askUser(input.question);
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolCall.id,
            content: `User answered: ${answer}`,
          });
          continue;
        }

        // Execute browser tool
        const result = await this.executeBrowserTool(toolCall.name, input);

        // Screenshot returns base64 image — send as image content
        if (toolCall.name === "screenshot") {
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolCall.id,
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: result,
                },
              },
              {
                type: "text",
                text: "Screenshot of the current browser viewport.",
              },
            ],
          });
          console.log(`\x1b[90m    (screenshot captured)\x1b[0m`);
        } else {
          // Truncate very long results to save context
          const truncated =
            result.length > 15000
              ? result.substring(0, 15000) + "\n...(truncated)"
              : result;
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolCall.id,
            content: truncated,
          });
          // Print short preview of result
          const preview = result.substring(0, 120).replace(/\n/g, " ");
          console.log(`\x1b[90m    ${preview}${result.length > 120 ? "..." : ""}\x1b[0m`);
        }
      }

      // Add tool results as the next user message
      this.messages.push({ role: "user", content: toolResults });
    }

    return `Reached maximum steps (${this.maxSteps}). Task may be incomplete.`;
  }

  private async executeBrowserTool(
    name: string,
    input: Record<string, any>
  ): Promise<string> {
    try {
      switch (name) {
        case "navigate":
          return await this.browser.navigate(input.url);
        case "click":
          return await this.browser.click(input.element_id);
        case "hover":
          return await this.browser.hover(input.element_id);
        case "type_text":
          return await this.browser.typeText(
            input.element_id,
            input.text,
            input.clear_first !== false
          );
        case "press_key":
          return await this.browser.pressKey(input.key);
        case "select_option":
          return await this.browser.selectOption(input.element_id, input.value);
        case "scroll":
          return await this.browser.scroll(
            input.direction,
            input.amount || 600
          );
        case "get_page_state":
          return await this.browser.getPageState();
        case "screenshot":
          return await this.browser.screenshot();
        case "go_back":
          return await this.browser.goBack();
        case "wait":
          return await this.browser.wait(input.ms || 2000);
        case "switch_tab":
          return await this.browser.switchTab(input.tab_index);
        default:
          return `Unknown tool: ${name}`;
      }
    } catch (err: any) {
      return `Tool error (${name}): ${err.message}`;
    }
  }

  // ── Context management ──────────────────────────────────────

  /**
   * Replace screenshot image blocks older than 6 messages with text placeholders.
   * This prevents the context from growing unboundedly with images (~1K tokens each).
   */
  /**
   * Call the Anthropic API with retry + exponential backoff for 429 rate limits.
   */
  private async callAPI(): Promise<Anthropic.Message> {
    const maxRetries = 8;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await this.client.messages.create({
          model: this.model,
          max_tokens: 8192,
          system: SYSTEM_PROMPT,
          tools,
          messages: this.messages,
        });
      } catch (err: any) {
        const status = err?.status || err?.error?.status;

        // 401 = token expired → try refreshing
        if (status === 401 && this.useOAuth && attempt < 2) {
          console.log("\x1b[33m  [Auth] Токен истёк, обновляю...\x1b[0m");
          const freshToken = await refreshOAuthToken();
          if (freshToken) {
            this.client = new Anthropic({ apiKey: freshToken });
            continue;
          }
        }

        // 429 = rate limit → wait and retry
        if (status === 429 && attempt < maxRetries - 1) {
          const delay = Math.min(5000 * Math.pow(2, attempt), 60000);
          console.log(
            `\x1b[33m  [Rate limit] Retry ${attempt + 1}/${maxRetries} in ${(delay / 1000).toFixed(0)}s... (убедитесь что Claude Code закрыт)\x1b[0m`
          );
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        throw err;
      }
    }
    throw new Error("Max retries exceeded");
  }

  private pruneOldScreenshots(): void {
    const cutoff = this.messages.length - 6;
    for (let i = 0; i < cutoff; i++) {
      const msg = this.messages[i];
      if (msg.role !== "user" || !Array.isArray(msg.content)) continue;

      for (let j = 0; j < msg.content.length; j++) {
        const block = msg.content[j] as any;
        if (block.type === "tool_result" && Array.isArray(block.content)) {
          block.content = block.content.map((c: any) =>
            c.type === "image"
              ? {
                  type: "text" as const,
                  text: "[Previous screenshot — see recent screenshots for current state]",
                }
              : c
          );
        }
      }
    }
  }

  /**
   * Emergency conversation trimming when context gets too large.
   * Keeps the first message (task) and last 20 messages.
   */
  private trimConversation(): void {
    if (this.messages.length <= 22) return;
    console.log(
      "\x1b[33m[Agent] Trimming conversation to manage context window...\x1b[0m"
    );
    const first = this.messages[0];
    const recent = this.messages.slice(-20);

    // Ensure alternation: first is user, recent should start with assistant
    this.messages = [first];
    // Add bridge message if needed
    if (recent[0]?.role === "assistant") {
      this.messages.push(...recent);
    } else {
      this.messages.push(
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "(Previous steps were trimmed to save context. Continuing with the task.)",
            },
          ],
        },
        ...recent
      );
    }
  }

  /**
   * Last-resort trim: keep only the task message and last 8 messages,
   * and strip large text tool results to short summaries.
   */
  private aggressiveTrim(): void {
    console.log(
      "\x1b[33m[Agent] Aggressive trim — dropping most history...\x1b[0m"
    );
    const first = this.messages[0];
    const recent = this.messages.slice(-8);

    this.messages = [first];
    if (recent[0]?.role !== "assistant") {
      this.messages.push({
        role: "assistant",
        content: [
          {
            type: "text",
            text: "(Most history was trimmed due to context limits. Continuing with the task.)",
          },
        ],
      });
    }
    this.messages.push(...recent);

    // Truncate any large tool results in remaining messages
    for (const msg of this.messages) {
      if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
      for (let j = 0; j < msg.content.length; j++) {
        const block = msg.content[j] as any;
        if (
          block.type === "tool_result" &&
          typeof block.content === "string" &&
          block.content.length > 3000
        ) {
          block.content =
            block.content.substring(0, 3000) + "\n...(truncated)";
        }
      }
    }
  }

  // ── Display helpers ─────────────────────────────────────────

  private formatToolCall(name: string, input: Record<string, any>): string {
    switch (name) {
      case "navigate":
        return `navigate("${input.url}")`;
      case "click":
        return `click([${input.element_id}])`;
      case "hover":
        return `hover([${input.element_id}])`;
      case "type_text":
        return `type_text([${input.element_id}], "${input.text}")`;
      case "press_key":
        return `press_key("${input.key}")`;
      case "select_option":
        return `select_option([${input.element_id}], "${input.value}")`;
      case "scroll":
        return `scroll("${input.direction}", ${input.amount || 600})`;
      case "get_page_state":
        return "get_page_state()";
      case "screenshot":
        return "screenshot()";
      case "go_back":
        return "go_back()";
      case "wait":
        return `wait(${input.ms || 2000})`;
      case "switch_tab":
        return `switch_tab(${input.tab_index})`;
      case "ask_user":
        return `ask_user("${(input.question || "").substring(0, 80)}")`;
      case "task_complete": {
        const s = (input.summary || "").substring(0, 60);
        return `task_complete("${s}...")`;
      }
      default:
        return `${name}(${JSON.stringify(input).substring(0, 80)})`;
    }
  }
}
