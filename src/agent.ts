import OpenAI from "openai";
import { BrowserController } from "./browser.js";
import { tools as anthropicTools } from "./tools.js";

const SYSTEM_PROMPT = `You are an autonomous browser automation agent. You control a real web browser to complete tasks given by the user. You think and act step by step.

## How You See the Page
- Use get_page_state to see the current URL, page title, visible text, and a numbered list of interactive elements
- Use screenshot to take a screenshot (returns a description of the page)
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
- If an element doesn't work, try alternatives (different element, keyboard shortcut, etc.)
- For search: type query then press Enter or click the search button
- Handle cookie banners, popups, and overlays by interacting with them (close/accept)
- If stuck, scroll to find more content or try a different approach
- When task is done, call task_complete — don't just describe what you did, signal completion

## Communication
- If you need info from the user, use ask_user (e.g., login credentials, preferences)
- Think aloud briefly before each action to show your reasoning
- Always respond in the same language the user used
`;

// Convert Anthropic tool format to OpenAI function calling format
const openaiTools: OpenAI.ChatCompletionTool[] = anthropicTools.map((t) => ({
  type: "function" as const,
  function: {
    name: t.name,
    description: t.description,
    parameters: t.input_schema as Record<string, unknown>,
  },
}));

type AskUserFn = (question: string) => Promise<string>;

export class Agent {
  private client: OpenAI;
  private browser: BrowserController;
  private messages: OpenAI.ChatCompletionMessageParam[] = [];
  private askUser: AskUserFn;
  private model: string;
  private maxSteps: number;

  constructor(browser: BrowserController, askUser: AskUserFn) {
    const baseURL = process.env.OLLAMA_URL || "http://localhost:11434/v1";
    this.client = new OpenAI({
      baseURL,
      apiKey: "ollama", // Ollama doesn't need a real key
    });
    this.browser = browser;
    this.askUser = askUser;
    this.model = process.env.OLLAMA_MODEL || "qwen3:8b";
    this.maxSteps = parseInt(process.env.MAX_STEPS || "60", 10);
    console.log(`\x1b[36m[LLM] ${this.model} @ ${baseURL}\x1b[0m`);
  }

  async run(task: string): Promise<string> {
    this.messages = [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `Task: ${task}\n\nStart by navigating to the appropriate website or calling get_page_state to see the current page. Work step by step until the task is complete.`,
      },
    ];

    console.log("\x1b[36m[Agent] Starting task execution...\x1b[0m");

    for (let step = 1; step <= this.maxSteps; step++) {
      this.pruneOldMessages();
      console.log(`\x1b[90m── step ${step}/${this.maxSteps} ──\x1b[0m`);

      let response: OpenAI.ChatCompletion;
      try {
        response = await this.callAPI();
      } catch (err: any) {
        console.log(`\x1b[31m[API Error] ${err.message}\x1b[0m`);
        throw err;
      }

      const choice = response.choices[0];
      if (!choice) return "(Empty response from LLM)";

      const msg = choice.message;

      // Add assistant message to history
      this.messages.push(msg);

      // Print reasoning text
      if (msg.content?.trim()) {
        // Strip <think> blocks from qwen3 thinking mode
        const cleaned = msg.content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
        if (cleaned) {
          console.log(`\x1b[35m[Agent] ${cleaned.substring(0, 500)}\x1b[0m`);
        }
      }

      // No tool calls → agent finished
      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        return msg.content?.replace(/<think>[\s\S]*?<\/think>/g, "").trim() || "(Agent finished without summary)";
      }

      // Execute tool calls
      for (const toolCall of msg.tool_calls) {
        const fn = toolCall.type === "function" ? toolCall.function : (toolCall as any).function;
        if (!fn) continue;
        let input: Record<string, any>;
        try {
          input = JSON.parse(fn.arguments || "{}");
        } catch {
          input = {};
        }

        const display = this.formatToolCall(fn.name, input);
        console.log(`\x1b[33m  > ${display}\x1b[0m`);

        // task_complete → return
        if (fn.name === "task_complete") {
          const summary = input.summary || "Task completed.";
          console.log(`\x1b[32m[Done] ${summary}\x1b[0m`);
          return summary;
        }

        // ask_user → prompt terminal
        if (fn.name === "ask_user") {
          const answer = await this.askUser(input.question);
          this.messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: `User answered: ${answer}`,
          });
          continue;
        }

        // Execute browser tool
        const result = await this.executeBrowserTool(fn.name, input);

        // For screenshots, just describe (Ollama can't see images)
        const content =
          fn.name === "screenshot"
            ? "Screenshot taken. Use get_page_state for text content of the page."
            : result.length > 12000
              ? result.substring(0, 12000) + "\n...(truncated)"
              : result;

        this.messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content,
        });

        // Print short preview
        const preview = content.substring(0, 120).replace(/\n/g, " ");
        console.log(`\x1b[90m    ${preview}${content.length > 120 ? "..." : ""}\x1b[0m`);
      }
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
          return await this.browser.scroll(input.direction, input.amount || 600);
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

  // ── API call ────────────────────────────────────────────────

  private async callAPI(): Promise<OpenAI.ChatCompletion> {
    const maxRetries = 3;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await this.client.chat.completions.create({
          model: this.model,
          messages: this.messages,
          tools: openaiTools,
          max_tokens: 4096,
        });
      } catch (err: any) {
        if (attempt < maxRetries - 1) {
          console.log(`\x1b[33m  [Retry] ${err.message?.substring(0, 80)}...\x1b[0m`);
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }
        throw err;
      }
    }
    throw new Error("Max retries exceeded");
  }

  // ── Context management ──────────────────────────────────────

  private pruneOldMessages(): void {
    // Keep system + task + last 30 messages
    if (this.messages.length <= 32) return;
    const system = this.messages[0]; // system prompt
    const task = this.messages[1]; // user task
    const recent = this.messages.slice(-30);
    this.messages = [system, task, ...recent];
    console.log("\x1b[33m[Agent] Trimmed old messages to save context.\x1b[0m");
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
