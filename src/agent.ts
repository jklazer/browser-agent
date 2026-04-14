import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { BrowserController } from "./browser.js";
import { tools } from "./tools.js";

// ── OAuth token management ────────────────────────────────────

const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";

function credPath(): string {
  return join(homedir(), ".claude", ".credentials.json");
}

function readOAuth(): { accessToken: string; refreshToken: string; expiresAt: number } | null {
  try {
    const creds = JSON.parse(readFileSync(credPath(), "utf-8"));
    const o = creds?.claudeAiOauth;
    if (o?.accessToken && o?.refreshToken) return o;
  } catch {}
  return null;
}

async function refreshToken(): Promise<string | null> {
  const oauth = readOAuth();
  if (!oauth?.refreshToken) return null;
  console.log("\x1b[36m[Auth] Refreshing token...\x1b[0m");
  try {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: OAUTH_CLIENT_ID,
        refresh_token: oauth.refreshToken,
      }),
    });
    if (!res.ok) {
      console.log(`\x1b[31m[Auth] Refresh failed: ${res.status}\x1b[0m`);
      return null;
    }
    const data = (await res.json()) as any;
    const token = data.access_token;
    if (!token) return null;
    // Save back
    try {
      const creds = JSON.parse(readFileSync(credPath(), "utf-8"));
      creds.claudeAiOauth.accessToken = token;
      if (data.refresh_token) creds.claudeAiOauth.refreshToken = data.refresh_token;
      if (data.expires_in) creds.claudeAiOauth.expiresAt = Date.now() + data.expires_in * 1000;
      writeFileSync(credPath(), JSON.stringify(creds));
    } catch {}
    console.log("\x1b[32m[Auth] Token refreshed!\x1b[0m");
    return token;
  } catch (err: any) {
    console.log(`\x1b[31m[Auth] ${err.message}\x1b[0m`);
    return null;
  }
}

// ── System prompt ─────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an autonomous browser automation agent. You control a real web browser via tools.

RULES:
- ALWAYS use tools to interact with the browser. Never just describe what you see.
- After navigate, page state is included — find input fields and buttons by their element numbers.
- For search: use type_text on the search input, then press_key "Enter".
- After any action that changes the page, call get_page_state to refresh element numbers.
- When done, call task_complete with results.
- Keep text responses SHORT (1 sentence). Focus on actions.
- Respond in the user's language.

TYPICAL FLOW: navigate → find search input in elements → type_text → press_key Enter → get_page_state → extract info → task_complete`;

type AskUserFn = (question: string) => Promise<string>;

// ── Agent ─────────────────────────────────────────────────────

export class Agent {
  private client: Anthropic;
  private browser: BrowserController;
  private messages: Anthropic.MessageParam[] = [];
  private askUser: AskUserFn;
  private model: string;
  private maxSteps: number;

  constructor(browser: BrowserController, askUser: AskUserFn) {
    // Auth: ANTHROPIC_API_KEY > OAuth token from Claude subscription
    let apiKey = process.env.ANTHROPIC_API_KEY;
    const opts: ConstructorParameters<typeof Anthropic>[0] = {};

    if (process.env.ANTHROPIC_BASE_URL) opts.baseURL = process.env.ANTHROPIC_BASE_URL;
    if (process.env.ANTHROPIC_AUTH_TOKEN) apiKey = process.env.ANTHROPIC_AUTH_TOKEN;

    if (!apiKey) {
      const oauth = readOAuth();
      if (oauth?.accessToken) {
        apiKey = oauth.accessToken;
        console.log("\x1b[36m[Auth] Using Claude subscription OAuth token.\x1b[0m");
      }
    }

    if (apiKey) opts.apiKey = apiKey;
    this.client = new Anthropic(opts);
    this.browser = browser;
    this.askUser = askUser;
    this.model = process.env.CLAUDE_MODEL || "claude-sonnet-4-6";
    this.maxSteps = parseInt(process.env.MAX_STEPS || "60", 10);
  }

  async run(task: string): Promise<string> {
    this.messages = [
      { role: "user", content: task },
    ];

    // Refresh token if expired
    const oauth = readOAuth();
    if (oauth && Date.now() > (oauth.expiresAt || 0) - 60000) {
      const fresh = await refreshToken();
      if (fresh) this.client = new Anthropic({ apiKey: fresh });
    }

    console.log("\x1b[36m[Agent] Starting...\x1b[0m");

    for (let step = 1; step <= this.maxSteps; step++) {
      if (this.messages.length > 30) this.trimMessages();
      console.log(`\x1b[90m── step ${step}/${this.maxSteps} ──\x1b[0m`);

      let response: Anthropic.Message;
      try {
        response = await this.callAPI();
      } catch (err: any) {
        console.log(`\x1b[31m[Error] ${err.message?.substring(0, 120)}\x1b[0m`);
        if (err?.status === 401) {
          const fresh = await refreshToken();
          if (fresh) { this.client = new Anthropic({ apiKey: fresh }); continue; }
        }
        throw err;
      }

      this.messages.push({ role: "assistant", content: response.content });

      // Print text
      for (const b of response.content) {
        if (b.type === "text" && b.text.trim()) {
          console.log(`\x1b[35m[Agent] ${b.text.substring(0, 300)}\x1b[0m`);
        }
      }

      if (response.stop_reason === "end_turn") {
        return response.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("\n") || "(Done)";
      }

      if (response.stop_reason !== "tool_use") return "(Stopped)";

      // Execute tools
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const tc of response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")) {
        const input = tc.input as Record<string, any>;
        console.log(`\x1b[33m  > ${tc.name}(${JSON.stringify(input).substring(0, 80)})\x1b[0m`);

        if (tc.name === "task_complete") {
          console.log(`\x1b[32m[Done] ${input.summary}\x1b[0m`);
          return input.summary;
        }

        if (tc.name === "ask_user") {
          const answer = await this.askUser(input.question);
          toolResults.push({ type: "tool_result", tool_use_id: tc.id, content: `User: ${answer}` });
          continue;
        }

        const result = await this.executeTool(tc.name, input);
        const content = result.length > 10000 ? result.substring(0, 10000) + "\n(truncated)" : result;
        toolResults.push({ type: "tool_result", tool_use_id: tc.id, content });

        const preview = result.substring(0, 100).replace(/\n/g, " ");
        console.log(`\x1b[90m    ${preview}...\x1b[0m`);
      }

      this.messages.push({ role: "user", content: toolResults });
    }

    return `Max steps (${this.maxSteps}) reached.`;
  }

  private async executeTool(name: string, input: Record<string, any>): Promise<string> {
    try {
      switch (name) {
        case "navigate": return await this.browser.navigate(input.url);
        case "click": return await this.browser.click(input.element_id);
        case "hover": return await this.browser.hover(input.element_id);
        case "type_text": return await this.browser.typeText(input.element_id, input.text, input.clear_first !== false);
        case "press_key": return await this.browser.pressKey(input.key);
        case "select_option": return await this.browser.selectOption(input.element_id, input.value);
        case "scroll": return await this.browser.scroll(input.direction, input.amount || 600);
        case "get_page_state": return await this.browser.getPageState();
        case "screenshot": return await this.browser.screenshot();
        case "go_back": return await this.browser.goBack();
        case "wait": return await this.browser.wait(input.ms || 2000);
        case "switch_tab": return await this.browser.switchTab(input.tab_index);
        default: return `Unknown tool: ${name}`;
      }
    } catch (err: any) {
      return `Error: ${err.message}`;
    }
  }

  private async callAPI(): Promise<Anthropic.Message> {
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        return await this.client.messages.create({
          model: this.model,
          max_tokens: 4096,
          system: SYSTEM_PROMPT,
          tools,
          messages: this.messages,
        });
      } catch (err: any) {
        const s = err?.status;
        if (s === 429 && attempt < 7) {
          const delay = Math.min(5000 * Math.pow(2, attempt), 60000);
          console.log(`\x1b[33m  [429] Retry in ${(delay / 1000).toFixed(0)}s...\x1b[0m`);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        if (s === 401 && attempt < 2) {
          const fresh = await refreshToken();
          if (fresh) { this.client = new Anthropic({ apiKey: fresh }); continue; }
        }
        throw err;
      }
    }
    throw new Error("Max retries");
  }

  private trimMessages(): void {
    const first = this.messages[0];
    const recent = this.messages.slice(-20);
    this.messages = [first, { role: "assistant", content: [{ type: "text", text: "(history trimmed)" }] }, ...recent];
  }
}
