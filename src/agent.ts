import { execFileSync } from "child_process";
import { BrowserController } from "./browser.js";

// ── Tool descriptions for the prompt ──────────────────────────

const TOOLS_DESC = `Available tools (respond with JSON to use):
- navigate: {"tool":"navigate","args":{"url":"..."}} — open a URL
- click: {"tool":"click","args":{"element_id":N}} — click element by number
- type_text: {"tool":"type_text","args":{"element_id":N,"text":"..."}} — type into input
- press_key: {"tool":"press_key","args":{"key":"Enter"}} — press keyboard key
- scroll: {"tool":"scroll","args":{"direction":"down"}} — scroll page
- get_page_state: {"tool":"get_page_state","args":{}} — get current page elements
- hover: {"tool":"hover","args":{"element_id":N}} — hover over element
- go_back: {"tool":"go_back","args":{}} — browser back
- wait: {"tool":"wait","args":{"ms":2000}} — wait
- query_dom: {"tool":"query_dom","args":{"query":"..."}} — ask sub-agent to analyze page DOM
- ask_user: {"tool":"ask_user","args":{"question":"..."}} — ask user a question
- task_complete: {"tool":"task_complete","args":{"summary":"..."}} — finish task with results`;

const SYSTEM_PROMPT = `You are an autonomous browser agent. You control a real browser via tools.

${TOOLS_DESC}

RULES:
1. On EVERY turn, respond with EXACTLY ONE JSON tool call. Nothing else.
2. After navigate, page state is returned — find inputs by element numbers like [3], [10].
3. For search: type_text into the search input, then press_key Enter.
4. After actions that change the page, call get_page_state.
5. When you have the answer, call task_complete with results.
6. Respond in the user's language.

SECURITY — ALWAYS ask_user before:
- Clicking payment/checkout/buy buttons
- Deleting emails, files, or messages
- Submitting forms with personal data
- Any irreversible action
Example: {"tool":"ask_user","args":{"question":"Подтвердите: удалить 3 письма-спама?"}}

EXAMPLE:
User: Find jobs on hh.ru
You: {"tool":"navigate","args":{"url":"https://hh.ru"}}
[tool result: page state with elements...]
You: {"tool":"type_text","args":{"element_id":3,"text":"AI engineer"}}
[tool result: typed]
You: {"tool":"press_key","args":{"key":"Enter"}}
[tool result: pressed]
You: {"tool":"get_page_state","args":{}}
[tool result: search results...]
You: {"tool":"task_complete","args":{"summary":"Found 3 vacancies: ..."}}`;

// ── Sub-agent prompts for specialized tasks ───────────────

const SUB_AGENTS: Record<string, string> = {
  search: `You specialize in SEARCH tasks. Strategy:
1. Navigate to the search engine or website
2. Find the search input field
3. Type the query and press Enter
4. Extract results from the page
5. Return structured results via task_complete`,

  email: `You specialize in EMAIL tasks. Strategy:
1. Navigate to the email service (user is already logged in)
2. Find the inbox/folder
3. Read email subjects and senders
4. For spam detection: look for promotional keywords, suspicious senders, phishing patterns
5. SECURITY: Always ask_user before deleting any emails
6. Report what was found/done via task_complete`,

  shopping: `You specialize in SHOPPING/ORDERING tasks. Strategy:
1. Navigate to the delivery/shopping service (user is already logged in)
2. Use search to find the requested items
3. Add items to cart
4. Navigate to checkout
5. SECURITY: STOP before payment — ask_user to confirm the order
6. Report the order summary via task_complete`,

  general: "",
};

function detectSubAgent(task: string): string {
  const t = task.toLowerCase();
  if (t.includes("почт") || t.includes("письм") || t.includes("спам") || t.includes("mail") || t.includes("email") || t.includes("inbox"))
    return "email";
  if (t.includes("заказ") || t.includes("купи") || t.includes("доставк") || t.includes("корзин") || t.includes("бургер") || t.includes("еда") || t.includes("order") || t.includes("delivery"))
    return "shopping";
  if (t.includes("найди") || t.includes("поиск") || t.includes("search") || t.includes("вакан") || t.includes("google"))
    return "search";
  return "general";
}

type AskUserFn = (question: string) => Promise<string>;

export class Agent {
  private browser: BrowserController;
  private askUser: AskUserFn;
  private maxSteps: number;
  private conversationFile: string | null = null;

  constructor(browser: BrowserController, askUser: AskUserFn) {
    this.browser = browser;
    this.askUser = askUser;
    this.maxSteps = parseInt(process.env.MAX_STEPS || "40", 10);
  }

  async run(task: string): Promise<string> {
    // Sub-agent detection
    const agentType = detectSubAgent(task);
    const subPrompt = SUB_AGENTS[agentType];
    if (agentType !== "general") {
      console.log(`\x1b[36m[Sub-agent] ${agentType}\x1b[0m`);
    }
    console.log("\x1b[36m[Agent] Starting...\x1b[0m");

    let context = `${SYSTEM_PROMPT}\n${subPrompt ? "\n" + subPrompt + "\n" : ""}\nUser task: ${task}\n\nRespond with a JSON tool call now.`;

    for (let step = 1; step <= this.maxSteps; step++) {
      console.log(`\x1b[90m── step ${step}/${this.maxSteps} ──\x1b[0m`);

      // Call Claude CLI
      let response: string;
      try {
        response = this.callClaude(context);
      } catch (err: any) {
        console.log(`\x1b[31m[Error] ${err.message?.substring(0, 120)}\x1b[0m`);
        throw err;
      }

      // Parse tool call from response
      const toolCall = this.parseToolCall(response);
      if (!toolCall) {
        console.log(`\x1b[35m[Agent] ${response.substring(0, 300)}\x1b[0m`);
        // Nudge to use tools
        context += `\nAssistant: ${response}\nUser: You must respond with a JSON tool call. Use one of the tools listed above.`;
        continue;
      }

      const { tool, args } = toolCall;
      console.log(`\x1b[33m  > ${tool}(${JSON.stringify(args).substring(0, 80)})\x1b[0m`);

      // task_complete → done
      if (tool === "task_complete") {
        const summary = args.summary || "Done.";
        console.log(`\x1b[32m[Done] ${summary}\x1b[0m`);
        return summary;
      }

      // ask_user
      if (tool === "ask_user") {
        const answer = await this.askUser(args.question);
        context += `\nAssistant: ${JSON.stringify(toolCall)}\nTool result: User answered: ${answer}\nRespond with next JSON tool call.`;
        continue;
      }

      // Execute browser tool
      const result = await this.executeTool(tool, args);
      const truncated = result.length > 6000 ? result.substring(0, 6000) + "\n(truncated)" : result;

      const preview = result.substring(0, 100).replace(/\n/g, " ");
      console.log(`\x1b[90m    ${preview}...\x1b[0m`);

      // Build next context
      context += `\nAssistant: ${JSON.stringify(toolCall)}\nTool result: ${truncated}\nRespond with next JSON tool call.`;

      // Trim context if too long (keep system prompt + last results)
      if (context.length > 30000) {
        const systemEnd = context.indexOf("\nUser task:");
        const system = context.substring(0, systemEnd + 200);
        const recent = context.substring(context.length - 15000);
        context = system + "\n...(history trimmed)...\n" + recent;
        console.log("\x1b[33m  [Trimmed context]\x1b[0m");
      }
    }

    return `Max steps (${this.maxSteps}) reached.`;
  }

  /**
   * query_dom sub-agent: sends page state + question to Claude for DOM analysis.
   */
  private async queryDom(query: string): Promise<string> {
    console.log(`\x1b[36m  [DOM Sub-agent] Analyzing: ${query.substring(0, 60)}...\x1b[0m`);
    const pageState = await this.browser.getPageState();
    const prompt = `You are a DOM analysis sub-agent. Given the page state below, answer the user's question concisely.

Page state:
${pageState.substring(0, 8000)}

Question: ${query}

Answer concisely — element numbers, selectors, or factual info. No tool calls.`;
    return this.callClaude(prompt);
  }

  private callClaude(prompt: string): string {
    try {
      const result = execFileSync("claude", ["-p", "--output-format", "text"], {
        input: prompt,
        encoding: "utf-8",
        timeout: 120000,
        maxBuffer: 10 * 1024 * 1024,
      });
      return result.trim();
    } catch (err: any) {
      if (err.stdout) return err.stdout.toString().trim();
      throw err;
    }
  }

  private parseToolCall(text: string): { tool: string; args: Record<string, any> } | null {
    // Try to find JSON in the response
    const patterns = [
      /\{[\s]*"tool"[\s]*:[\s]*"[^"]+"/,  // starts with {"tool":"...
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) {
        const start = match.index!;
        // Find matching closing brace
        let depth = 0;
        for (let i = start; i < text.length; i++) {
          if (text[i] === "{") depth++;
          if (text[i] === "}") depth--;
          if (depth === 0) {
            try {
              const json = JSON.parse(text.substring(start, i + 1));
              if (json.tool) return json;
            } catch {}
            break;
          }
        }
      }
    }

    // Try parsing entire response as JSON
    try {
      const json = JSON.parse(text.trim());
      if (json.tool) return json;
    } catch {}

    // Try extracting from markdown code block
    const codeBlock = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
    if (codeBlock) {
      try {
        const json = JSON.parse(codeBlock[1]);
        if (json.tool) return json;
      } catch {}
    }

    return null;
  }

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
        case "screenshot": return "Use get_page_state instead for text content.";
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
}
