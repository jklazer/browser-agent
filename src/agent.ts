import Anthropic from "@anthropic-ai/sdk";
import { execFileSync } from "child_process";
import { BrowserController } from "./browser.js";
import { tools } from "./tools.js";

// ── System prompt ─────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an autonomous browser automation agent. You control a real browser via tools.

RULES:
- ALWAYS use tools. Keep text responses to 1-2 sentences max.
- After navigate, page state is auto-included — find inputs by element numbers.
- For search: type_text into the search input, then press_key Enter.
- After actions that change the page, call get_page_state.
- Use query_dom to ask a sub-agent about page structure.
- When done, call task_complete with results.
- Respond in the user's language.

SECURITY — ALWAYS use ask_user before:
- Clicking payment/checkout/buy buttons
- Deleting emails, files, or messages
- Submitting forms with personal data
- Any irreversible action

TYPICAL FLOW: navigate → find search input → type_text → press_key Enter → get_page_state → query_dom for details → task_complete`;

// ── Sub-agent prompts ─────────────────────────────────────────

const SUB_AGENTS: Record<string, string> = {
  search: `You specialize in SEARCH tasks. Navigate to the site, find search input, type query, press Enter, extract results, return via task_complete.`,
  email: `You specialize in EMAIL tasks. User is already logged in. Read emails, detect spam (promotions, phishing, suspicious senders). ALWAYS ask_user before deleting.`,
  shopping: `You specialize in SHOPPING tasks. User is already logged in. Search for items, add to cart, go to checkout. ALWAYS ask_user before confirming payment.`,
  general: "",
};

function detectSubAgent(task: string): string {
  const t = task.toLowerCase();
  if (/почт|письм|спам|mail|email|inbox/.test(t)) return "email";
  if (/заказ|купи|доставк|корзин|бургер|еда|order|delivery|лавк/.test(t)) return "shopping";
  if (/найди|поиск|search|вакан|google/.test(t)) return "search";
  return "general";
}

type AskUserFn = (question: string) => Promise<string>;

// ── Agent ─────────────────────────────────────────────────────

export class Agent {
  private client: Anthropic;
  private browser: BrowserController;
  private messages: Anthropic.MessageParam[] = [];
  private askUser: AskUserFn;
  private model: string;
  private maxSteps: number;
  private useAPI: boolean;

  constructor(browser: BrowserController, askUser: AskUserFn) {
    this.browser = browser;
    this.askUser = askUser;
    this.maxSteps = parseInt(process.env.MAX_STEPS || "40", 10);
    this.model = process.env.CLAUDE_MODEL || "claude-sonnet-4-6";

    // Use Anthropic SDK if API key is set, otherwise fall back to CLI
    this.useAPI = !!process.env.ANTHROPIC_API_KEY;
    if (this.useAPI) {
      this.client = new Anthropic();
      console.log(`\x1b[36m[LLM] API mode: ${this.model}\x1b[0m`);
    } else {
      this.client = null as any; // Won't be used in CLI mode
      console.log(`\x1b[36m[LLM] CLI mode: claude -p\x1b[0m`);
    }
  }

  async run(task: string): Promise<string> {
    const agentType = detectSubAgent(task);
    const subPrompt = SUB_AGENTS[agentType];
    if (agentType !== "general") console.log(`\x1b[36m[Sub-agent] ${agentType}\x1b[0m`);
    console.log("\x1b[36m[Agent] Starting...\x1b[0m");

    if (this.useAPI) {
      return this.runAPI(task, subPrompt);
    } else {
      return this.runCLI(task, subPrompt);
    }
  }

  // ── API mode (fast, uses ANTHROPIC_API_KEY) ─────────────────

  private async runAPI(task: string, subPrompt: string): Promise<string> {
    const systemPrompt = SYSTEM_PROMPT + (subPrompt ? "\n\n" + subPrompt : "");
    this.messages = [{ role: "user", content: task }];

    for (let step = 1; step <= this.maxSteps; step++) {
      if (this.messages.length > 30) this.trimAPIMessages();
      console.log(`\x1b[90m── step ${step}/${this.maxSteps} ──\x1b[0m`);

      let response: Anthropic.Message;
      try {
        response = await this.client.messages.create({
          model: this.model,
          max_tokens: 4096,
          system: systemPrompt,
          tools,
          messages: this.messages,
        });
      } catch (err: any) {
        if (err?.status === 429) {
          const delay = Math.min(5000 * Math.pow(2, step % 5), 30000);
          console.log(`\x1b[33m  [429] Retry in ${(delay / 1000).toFixed(0)}s\x1b[0m`);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        throw err;
      }

      this.messages.push({ role: "assistant", content: response.content });

      for (const b of response.content) {
        if (b.type === "text" && b.text.trim()) {
          console.log(`\x1b[35m[Agent] ${b.text.substring(0, 300)}\x1b[0m`);
        }
      }

      if (response.stop_reason === "end_turn") {
        return response.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("\n") || "(Done)";
      }
      if (response.stop_reason !== "tool_use") return "(Stopped)";

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
        toolResults.push({
          type: "tool_result",
          tool_use_id: tc.id,
          content: result.length > 10000 ? result.substring(0, 10000) + "\n(truncated)" : result,
        });
        console.log(`\x1b[90m    ${result.substring(0, 100).replace(/\n/g, " ")}...\x1b[0m`);
      }
      this.messages.push({ role: "user", content: toolResults });
    }
    return `Max steps reached.`;
  }

  private trimAPIMessages(): void {
    const first = this.messages[0];
    const recent = this.messages.slice(-20);
    this.messages = [first, { role: "assistant", content: [{ type: "text", text: "(trimmed)" }] }, ...recent];
  }

  // ── CLI mode (free, uses claude -p) ─────────────────────────

  private async runCLI(task: string, subPrompt: string): Promise<string> {
    const toolsDesc = `Available tools (respond with JSON):
- navigate: {"tool":"navigate","args":{"url":"..."}}
- click: {"tool":"click","args":{"element_id":N}}
- type_text: {"tool":"type_text","args":{"element_id":N,"text":"..."}}
- press_key: {"tool":"press_key","args":{"key":"Enter"}}
- scroll: {"tool":"scroll","args":{"direction":"down"}}
- get_page_state: {"tool":"get_page_state","args":{}}
- hover: {"tool":"hover","args":{"element_id":N}}
- query_dom: {"tool":"query_dom","args":{"query":"..."}}
- go_back: {"tool":"go_back","args":{}}
- wait: {"tool":"wait","args":{"ms":2000}}
- ask_user: {"tool":"ask_user","args":{"question":"..."}}
- task_complete: {"tool":"task_complete","args":{"summary":"..."}}`;

    let context = `${SYSTEM_PROMPT}\n${toolsDesc}\n${subPrompt ? "\n" + subPrompt + "\n" : ""}\nUser task: ${task}\n\nRespond with a JSON tool call now.`;

    for (let step = 1; step <= this.maxSteps; step++) {
      console.log(`\x1b[90m── step ${step}/${this.maxSteps} ──\x1b[0m`);

      const response = this.callClaude(context);
      const toolCall = this.parseToolCall(response);

      if (!toolCall) {
        console.log(`\x1b[35m[Agent] ${response.substring(0, 300)}\x1b[0m`);
        context += `\nAssistant: ${response}\nUser: Use a tool now. Respond with JSON.`;
        continue;
      }

      const { tool, args } = toolCall;
      console.log(`\x1b[33m  > ${tool}(${JSON.stringify(args).substring(0, 80)})\x1b[0m`);

      if (tool === "task_complete") {
        console.log(`\x1b[32m[Done] ${args.summary}\x1b[0m`);
        return args.summary;
      }
      if (tool === "ask_user") {
        const answer = await this.askUser(args.question);
        context += `\nAssistant: ${JSON.stringify(toolCall)}\nTool result: User answered: ${answer}\nRespond with next JSON tool call.`;
        continue;
      }

      const result = await this.executeTool(tool, args);
      const truncated = result.length > 6000 ? result.substring(0, 6000) + "\n(truncated)" : result;
      console.log(`\x1b[90m    ${result.substring(0, 100).replace(/\n/g, " ")}...\x1b[0m`);

      context += `\nAssistant: ${JSON.stringify(toolCall)}\nTool result: ${truncated}\nRespond with next JSON tool call.`;
      if (context.length > 30000) {
        const sysEnd = context.indexOf("\nUser task:");
        context = context.substring(0, sysEnd + 200) + "\n...(trimmed)...\n" + context.substring(context.length - 15000);
      }
    }
    return `Max steps reached.`;
  }

  private callClaude(prompt: string): string {
    try {
      return execFileSync("claude", ["-p", "--output-format", "text"], {
        input: prompt, encoding: "utf-8", timeout: 120000, maxBuffer: 10 * 1024 * 1024,
      }).trim();
    } catch (err: any) {
      if (err.stdout) return err.stdout.toString().trim();
      throw err;
    }
  }

  private parseToolCall(text: string): { tool: string; args: Record<string, any> } | null {
    const match = text.match(/\{[\s]*"tool"[\s]*:[\s]*"[^"]+"/);
    if (match) {
      let depth = 0;
      for (let i = match.index!; i < text.length; i++) {
        if (text[i] === "{") depth++;
        if (text[i] === "}") depth--;
        if (depth === 0) {
          try { const j = JSON.parse(text.substring(match.index!, i + 1)); if (j.tool) return j; } catch {}
          break;
        }
      }
    }
    try { const j = JSON.parse(text.trim()); if (j.tool) return j; } catch {}
    const cb = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
    if (cb) { try { const j = JSON.parse(cb[1]); if (j.tool) return j; } catch {} }
    return null;
  }

  // ── Tool execution ──────────────────────────────────────────

  private async executeTool(name: string, args: Record<string, any>): Promise<string> {
    try {
      switch (name) {
        case "navigate": return await this.browser.navigate(args.url);
        case "click": return await this.browser.click(args.element_id);
        case "hover": return await this.browser.hover(args.element_id);
        case "type_text": return await this.browser.typeText(args.element_id, args.text, args.clear_first !== false);
        case "press_key": return await this.browser.pressKey(args.key);
        case "select_option": return await this.browser.selectOption(args.element_id, args.value);
        case "scroll": return await this.browser.scroll(args.direction, args.amount || 600);
        case "get_page_state": return await this.browser.getPageState();
        case "screenshot": return await this.browser.screenshot();
        case "query_dom": return await this.queryDom(args.query);
        case "go_back": return await this.browser.goBack();
        case "wait": return await this.browser.wait(args.ms || 2000);
        case "switch_tab": return await this.browser.switchTab(args.tab_index);
        default: return `Unknown tool: ${name}`;
      }
    } catch (err: any) {
      return `Error: ${err.message}`;
    }
  }

  /** query_dom sub-agent: separate Claude call to analyze page DOM */
  private async queryDom(query: string): Promise<string> {
    console.log(`\x1b[36m  [DOM Sub-agent] ${query.substring(0, 60)}...\x1b[0m`);
    const pageState = await this.browser.getPageState();
    const prompt = `Analyze this page and answer concisely:\n\n${pageState.substring(0, 8000)}\n\nQuestion: ${query}`;

    if (this.useAPI) {
      const resp = await this.client.messages.create({
        model: this.model,
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      });
      return resp.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("\n");
    } else {
      return this.callClaude(prompt);
    }
  }
}
