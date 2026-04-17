import Anthropic from "@anthropic-ai/sdk";
import { execFileSync } from "child_process";
import { BrowserController } from "./browser.js";
import { tools } from "./tools.js";
import { TaskLogger, UsageTracker } from "./logger.js";

// ── System prompt ─────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an autonomous browser automation agent. You control a real browser via tools.

HOW YOU SEE THE PAGE:
- After navigate, page state (URL, title, text, numbered interactive elements) is auto-included.
- Elements are numbered [0], [1], [2]... — use these numbers with click, type_text, hover, select_option.
- Use screenshot when you need to see the page visually (complex layout, verify state, captchas).
- Use query_dom to ask a sub-agent specific questions about the page DOM.

CORE RULES:
- ALWAYS use tools. Keep text responses to 1-2 sentences max.
- After clicks/types that change the page → call get_page_state to refresh element numbers.
- For search: type_text into the search input, then press_key "Enter".
- Cookie banners, popups, overlays → interact with them (accept/close) before continuing.
- If an element isn't found, the page changed — call get_page_state first.
- If stuck, scroll to reveal more content or try a different approach.
- Handle slow loads by calling wait then get_page_state.

SECURITY — ALWAYS use ask_user before:
- Clicking payment/checkout/buy/confirm-order buttons
- Deleting emails, files, messages, or records
- Submitting forms that send personal data externally
- Any irreversible action

EDGE CASES:
- Login wall: ask_user if they want to log in (they may already be logged in).
- Captcha: ask_user to solve it in the browser, then continue.
- Multi-page results: scroll and collect, don't stop after first page.
- Authentication timeout: navigate back to the page after user logs in.

TRUTHFULNESS:
- NEVER fabricate results you haven't actually observed through tool calls.
- In task_complete, report ONLY what your tools actually returned. If you opened 4 emails out of 10, say "opened 4" — do not pad the list with items you only saw in a preview/list snippet.
- If the inbox page text shows headers for items you did not click into, treat those as "seen in list only, content not verified".
- Distinguish in your summary between "verified via tool calls" and "inferred from list preview".

WHEN DONE: call task_complete with a clear summary including all results/actions.

RESPOND IN THE USER'S LANGUAGE.`;

// ── Sub-agent prompts ─────────────────────────────────────────

const SUB_AGENTS: Record<string, string> = {
  search: `SUB-AGENT ROLE: SEARCH. Goal: find and return structured results matching the user's query (titles, key facts, relevant links). Do not perform destructive actions.`,
  email: `SUB-AGENT ROLE: EMAIL. Goal: analyze inbox content and help the user manage it.
READING PROTOCOL (STRICT):
- To "read" an email means: click to open it → call query_dom (or get_page_state) to read subject+sender+body → go_back to inbox.
- Seeing a subject line in the inbox-list preview is NOT reading. Do not count it toward the N items requested.
- If user asks to process N emails: click-open EACH of them in turn. After each, verify content via query_dom before navigating away.
- Keep a running mental count of verified-read items; stop only when you reach N or the inbox runs out.
BULK-ACTION RULES:
- NEVER click "Select all" / "Выбрать все" / "select all conversations" buttons.
- Click checkboxes ONE AT A TIME. Maximum 10 selections before calling ask_user to confirm.
- For any delete/archive/move: ask_user if there is ANY doubt about spam status.
- Blanket pre-authorization in the task prompt is advisory; code-level guards still apply.`,
  shopping: `SUB-AGENT ROLE: SHOPPING. Goal: help user order items. HARD STOP before any checkout / payment / confirm-order button — always ask_user to confirm the final cart and price first.`,
  profile: `SUB-AGENT ROLE: PROFILE. Goal: gather user-specific info (resume, saved data, preferences) read-only. Do not submit or change anything without ask_user.`,
  general: "",
};

/**
 * Extract an item-count requirement from the task prompt so we can gate
 * task_complete on a minimum number of query_dom calls. Heuristic: looks for
 * patterns like "10 писем", "прочитай 5 emails", "возьми 3 вакансии".
 * Returns null if no clear number/subject was found.
 */
function detectCompletionRequirement(
  task: string
): { kind: "queryDom"; min: number } | null {
  // lazy match up to ~40 non-dot chars (covers Cyrillic; \w wouldn't)
  const m = task.match(
    /(\d+)[^.!?]{0,40}?(?:письм|писем|письмо|email|mess|вакан|позици|объявлен|items|пункт|\bшт\b|элемент)/i
  );
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n < 2 || n > 50) return null;
  return { kind: "queryDom", min: n };
}

function detectSubAgent(task: string): string {
  const t = task.toLowerCase();
  if (/профиль|резюм|profile|resume/.test(t) && !/вакан|поиск|vacanc|job/.test(t)) return "profile";
  if (/почт|письм|спам|mail|email|inbox|сообщ.*ящик/.test(t)) return "email";
  if (/заказ|купи|доставк|корзин|бургер|еда|order|delivery|cart|checkout/.test(t)) return "shopping";
  if (/найди|поиск|search|вакан|job|vacanc|find/.test(t)) return "search";
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
  private abortRequested = false;
  private checkboxClickCount = 0;
  private rateLimitRetries = 0;
  private queryDomCount = 0;
  private completionRequirement: { kind: "queryDom"; min: number } | null = null;
  private completionRejects = 0;
  private recentClickUrls: string[] = [];

  constructor(browser: BrowserController, askUser: AskUserFn) {
    this.browser = browser;
    this.askUser = askUser;
    this.maxSteps = parseInt(process.env.MAX_STEPS || "40", 10);
    this.model = process.env.CLAUDE_MODEL || "claude-sonnet-4-6";

    this.useAPI = !!process.env.ANTHROPIC_API_KEY;
    if (this.useAPI) {
      this.client = new Anthropic();
      console.log(`\x1b[36m[LLM] API mode: ${this.model}\x1b[0m`);
    } else {
      this.client = null as any;
      console.log(`\x1b[36m[LLM] CLI mode: claude -p\x1b[0m`);
    }
  }

  abort(): void {
    this.abortRequested = true;
  }

  async run(task: string): Promise<{ result: string; logFile: string; usage: string }> {
    this.abortRequested = false;
    this.checkboxClickCount = 0;
    this.rateLimitRetries = 0;
    this.queryDomCount = 0;
    this.completionRejects = 0;
    this.recentClickUrls = [];
    this.completionRequirement = detectCompletionRequirement(task);
    if (this.completionRequirement) {
      console.log(
        `\x1b[36m[Requirement] task_complete gated by ≥${this.completionRequirement.min} query_dom calls\x1b[0m`
      );
    }
    const logger = new TaskLogger(task);
    const tracker = new UsageTracker(this.model);

    const agentType = detectSubAgent(task);
    const subPrompt = SUB_AGENTS[agentType];
    if (agentType !== "general") {
      console.log(`\x1b[36m[Sub-agent] ${agentType}\x1b[0m`);
      logger.thought(`Sub-agent: ${agentType}`);
    }
    console.log(`\x1b[90m[Log] ${logger["file"]}\x1b[0m`);
    console.log("\x1b[36m[Agent] Starting...\x1b[0m");

    try {
      const result = this.useAPI
        ? await this.runAPI(task, subPrompt, logger, tracker)
        : await this.runCLI(task, subPrompt, logger);
      const usage = this.useAPI ? tracker.format() : "(CLI mode — no usage tracking)";
      logger.finalize(result);
      return { result, logFile: logger["file"], usage };
    } catch (err: any) {
      logger.error(err.message);
      logger.finalize(`ERROR: ${err.message}`);
      throw err;
    }
  }

  // ── API mode (fast, with prompt caching) ────────────────────

  private async runAPI(task: string, subPrompt: string, logger: TaskLogger, tracker: UsageTracker): Promise<string> {
    const systemPrompt = SYSTEM_PROMPT + (subPrompt ? "\n\n" + subPrompt : "");
    this.messages = [{ role: "user", content: task }];

    // Cached system prompt + tools — 90% discount on cached tokens
    const systemBlocks: Anthropic.TextBlockParam[] = [
      { type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } },
    ];
    const cachedTools = tools.map((t, i) =>
      i === tools.length - 1 ? { ...t, cache_control: { type: "ephemeral" as const } } : t
    );

    for (let step = 1; step <= this.maxSteps; step++) {
      if (this.abortRequested) {
        logger.thought("Aborted by user");
        return "(Aborted by user)";
      }
      if (this.messages.length > 50) this.trimAPIMessages();
      const stepNum = logger.nextStep();
      console.log(`\x1b[90m── step ${stepNum}/${this.maxSteps} ──\x1b[0m`);

      let response: Anthropic.Message;
      try {
        response = await this.client.messages.create({
          model: this.model,
          max_tokens: 4096,
          system: systemBlocks,
          tools: cachedTools,
          messages: this.messages,
        });
        this.rateLimitRetries = 0;
      } catch (err: any) {
        if (err?.status === 429) {
          this.rateLimitRetries++;
          if (this.rateLimitRetries > 5) {
            throw new Error(
              `Rate limit exceeded after 5 retries. Aborting. Last error: ${err.message}`
            );
          }
          const delay = Math.min(5000 * Math.pow(2, this.rateLimitRetries), 60000);
          console.log(
            `\x1b[33m  [429] Retry ${this.rateLimitRetries}/5 in ${(delay / 1000).toFixed(0)}s\x1b[0m`
          );
          logger.error(`rate limit retry ${this.rateLimitRetries}, waiting ${delay}ms`);
          await new Promise((r) => setTimeout(r, delay));
          step--;
          continue;
        }
        throw err;
      }

      // Track usage
      tracker.add(response.usage);
      logger.usage(response.usage);

      this.messages.push({ role: "assistant", content: response.content });

      for (const b of response.content) {
        if (b.type === "text" && b.text.trim()) {
          console.log(`\x1b[35m[Agent] ${b.text.substring(0, 300)}\x1b[0m`);
          logger.thought(b.text);
        }
      }

      if (response.stop_reason === "end_turn") {
        return (
          response.content
            .filter((b): b is Anthropic.TextBlock => b.type === "text")
            .map((b) => b.text)
            .join("\n") || "(Done without summary)"
        );
      }
      if (response.stop_reason !== "tool_use") return "(Stopped)";

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const tc of response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
      )) {
        if (this.abortRequested) {
          logger.thought("Aborted mid-step");
          return "(Aborted by user)";
        }
        const input = tc.input as Record<string, any>;
        console.log(`\x1b[33m  > ${tc.name}(${JSON.stringify(input).substring(0, 80)})\x1b[0m`);
        logger.toolCall(tc.name, input);

        if (tc.name === "task_complete") {
          const gate = this.checkCompletionGate();
          if (gate) {
            console.log(`\x1b[33m  [Gate] task_complete rejected: ${gate}\x1b[0m`);
            logger.thought(`task_complete rejected: ${gate}`);
            toolResults.push({ type: "tool_result", tool_use_id: tc.id, content: gate });
            continue;
          }
          console.log(`\x1b[32m[Done] ${input.summary}\x1b[0m`);
          return input.summary;
        }
        if (tc.name === "ask_user") {
          const answer = await this.askUser(input.question);
          toolResults.push({ type: "tool_result", tool_use_id: tc.id, content: `User: ${answer}` });
          logger.toolResult("ask_user", answer);
          continue;
        }

        // Screenshot → send as image content block
        if (tc.name === "screenshot") {
          const b64 = await this.browser.screenshot();
          toolResults.push({
            type: "tool_result",
            tool_use_id: tc.id,
            content: [
              { type: "image", source: { type: "base64", media_type: "image/png", data: b64 } },
              { type: "text", text: "Screenshot of current browser viewport." },
            ],
          });
          console.log(`\x1b[90m    (screenshot ${(b64.length / 1024).toFixed(0)}KB)\x1b[0m`);
          logger.toolResult("screenshot", `${(b64.length / 1024).toFixed(0)}KB PNG`);
          continue;
        }

        const result = await this.executeTool(tc.name, input);
        toolResults.push({
          type: "tool_result",
          tool_use_id: tc.id,
          content: result.length > 10000 ? result.substring(0, 10000) + "\n(truncated)" : result,
        });
        logger.toolResult(tc.name, result);
        const preview = result.substring(0, 100).replace(/\n/g, " ");
        console.log(`\x1b[90m    ${preview}${result.length > 100 ? "..." : ""}\x1b[0m`);
      }
      this.messages.push({ role: "user", content: toolResults });
      this.compactScreenshots();
    }
    return `Max steps (${this.maxSteps}) reached.`;
  }

  /**
   * Replace screenshot image blocks in all but the last user message with a
   * text placeholder. Keeps the most recent screenshot in context.
   */
  private compactScreenshots(): void {
    for (let i = 0; i < this.messages.length - 1; i++) {
      const m = this.messages[i];
      if (m.role !== "user" || !Array.isArray(m.content)) continue;
      for (let j = 0; j < m.content.length; j++) {
        const block: any = m.content[j];
        if (
          block?.type === "tool_result" &&
          Array.isArray(block.content) &&
          block.content.some((c: any) => c?.type === "image")
        ) {
          m.content[j] = {
            type: "tool_result",
            tool_use_id: block.tool_use_id,
            content:
              "[Earlier screenshot dropped to save context. Call screenshot again if you need the current page.]",
          };
        }
      }
    }
  }

  private trimAPIMessages(): void {
    const first = this.messages[0]; // user: original task
    const recent = this.messages.slice(-20);
    // Must start from an assistant message (not user with tool_result,
    // else its tool_result blocks orphan their tool_use blocks → API 400)
    const startIdx = recent.findIndex((m) => m.role === "assistant");
    if (startIdx < 0) return; // no safe trim point, keep all
    // Keep user task + assistant onwards: user→assistant→user→...
    this.messages = [first, ...recent.slice(startIdx)];
    console.log("\x1b[33m  [Trim] Context compressed\x1b[0m");
  }

  // ── CLI mode ────────────────────────────────────────────────

  private async runCLI(task: string, subPrompt: string, logger: TaskLogger): Promise<string> {
    const toolsDesc = `Available tools (respond with JSON):
- navigate: {"tool":"navigate","args":{"url":"..."}}
- click: {"tool":"click","args":{"element_id":N}}
- type_text: {"tool":"type_text","args":{"element_id":N,"text":"..."}}
- press_key: {"tool":"press_key","args":{"key":"Enter"}}
- scroll: {"tool":"scroll","args":{"direction":"down"}}
- get_page_state: {"tool":"get_page_state","args":{}}
- screenshot: {"tool":"screenshot","args":{}}
- hover: {"tool":"hover","args":{"element_id":N}}
- select_option: {"tool":"select_option","args":{"element_id":N,"value":"..."}}
- query_dom: {"tool":"query_dom","args":{"query":"..."}}
- switch_tab: {"tool":"switch_tab","args":{"tab_index":N}}
- go_back: {"tool":"go_back","args":{}}
- wait: {"tool":"wait","args":{"ms":2000}}
- ask_user: {"tool":"ask_user","args":{"question":"..."}}
- task_complete: {"tool":"task_complete","args":{"summary":"..."}}`;

    let context = `${SYSTEM_PROMPT}\n${toolsDesc}\n${subPrompt ? "\n" + subPrompt + "\n" : ""}\nUser task: ${task}\n\nRespond with a JSON tool call now.`;

    for (let step = 1; step <= this.maxSteps; step++) {
      if (this.abortRequested) return "(Aborted by user)";
      const stepNum = logger.nextStep();
      console.log(`\x1b[90m── step ${stepNum}/${this.maxSteps} ──\x1b[0m`);

      const response = this.callClaude(context);
      const toolCall = this.parseToolCall(response);

      if (!toolCall) {
        console.log(`\x1b[35m[Agent] ${response.substring(0, 300)}\x1b[0m`);
        logger.thought(response);
        context += `\nAssistant: ${response}\nUser: Use a tool now. Respond with JSON.`;
        continue;
      }

      const { tool, args } = toolCall;
      console.log(`\x1b[33m  > ${tool}(${JSON.stringify(args).substring(0, 80)})\x1b[0m`);
      logger.toolCall(tool, args);

      if (tool === "task_complete") {
        const gate = this.checkCompletionGate();
        if (gate) {
          console.log(`\x1b[33m  [Gate] task_complete rejected: ${gate}\x1b[0m`);
          logger.thought(`task_complete rejected: ${gate}`);
          context += `\nAssistant: ${JSON.stringify(toolCall)}\nTool result: ${gate}\nRespond with next JSON tool call.`;
          continue;
        }
        console.log(`\x1b[32m[Done] ${args.summary}\x1b[0m`);
        return args.summary;
      }
      if (tool === "ask_user") {
        const answer = await this.askUser(args.question);
        logger.toolResult("ask_user", answer);
        context += `\nAssistant: ${JSON.stringify(toolCall)}\nTool result: User answered: ${answer}\nRespond with next JSON tool call.`;
        continue;
      }

      const result = await this.executeTool(tool, args);
      const truncated = result.length > 6000 ? result.substring(0, 6000) + "\n(truncated)" : result;
      logger.toolResult(tool, result);
      console.log(`\x1b[90m    ${result.substring(0, 100).replace(/\n/g, " ")}...\x1b[0m`);

      context += `\nAssistant: ${JSON.stringify(toolCall)}\nTool result: ${truncated}\nRespond with next JSON tool call.`;
      if (context.length > 30000) {
        const sysEnd = context.indexOf("\nUser task:");
        context =
          context.substring(0, sysEnd + 200) +
          "\n...(trimmed)...\n" +
          context.substring(context.length - 15000);
      }
    }
    return `Max steps reached.`;
  }

  private callClaude(prompt: string): string {
    const cliModel = process.env.CLAUDE_CLI_MODEL || process.env.CLAUDE_MODEL || "opus";
    try {
      return execFileSync(
        "claude",
        ["-p", "--model", cliModel, "--output-format", "text"],
        {
          input: prompt,
          encoding: "utf-8",
          timeout: 300000,
          maxBuffer: 10 * 1024 * 1024,
        }
      ).trim();
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
          try {
            const j = JSON.parse(text.substring(match.index!, i + 1));
            if (j.tool) return j;
          } catch {}
          break;
        }
      }
    }
    try {
      const j = JSON.parse(text.trim());
      if (j.tool) return j;
    } catch {}
    const cb = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
    if (cb) {
      try {
        const j = JSON.parse(cb[1]);
        if (j.tool) return j;
      } catch {}
    }
    return null;
  }

  // ── Tool execution ──────────────────────────────────────────

  private async executeTool(name: string, args: Record<string, any>): Promise<string> {
    try {
      switch (name) {
        case "navigate":
          return await this.browser.navigate(args.url);
        case "click": {
          const guard = await this.clickSafetyCheck(args.element_id);
          if (guard) return guard;
          const result = await this.browser.click(args.element_id);
          // Detect repeated-URL clicks (agent stuck on same item)
          const urlMatch = result.match(/Current URL: (\S+)/);
          if (urlMatch) {
            const url = urlMatch[1];
            this.recentClickUrls.push(url);
            if (this.recentClickUrls.length > 6) this.recentClickUrls.shift();
            const sameUrlCount = this.recentClickUrls.filter((u) => u === url).length;
            if (sameUrlCount >= 3) {
              return (
                result +
                `\n\n⚠️ NOTICE: the last ${sameUrlCount} clicks landed on the SAME URL — you're stuck on one item. ` +
                `Element ids re-number after go_back; the same number ([${args.element_id}]) points to the same top item. ` +
                `To move to the next unread item: call get_page_state to refresh ids, then pick a DIFFERENT element_id (try a larger number, scroll down if needed).`
              );
            }
          }
          return result;
        }
        case "hover":
          return await this.browser.hover(args.element_id);
        case "type_text":
          return await this.browser.typeText(args.element_id, args.text, args.clear_first !== false);
        case "press_key":
          return await this.browser.pressKey(args.key);
        case "select_option":
          return await this.browser.selectOption(args.element_id, args.value);
        case "scroll":
          return await this.browser.scroll(args.direction, args.amount || 600);
        case "get_page_state":
          return await this.browser.getPageState();
        case "screenshot":
          return await this.browser.screenshot();
        case "query_dom":
          return await this.queryDom(args.query);
        case "go_back":
          return await this.browser.goBack();
        case "wait":
          return await this.browser.wait(args.ms || 2000);
        case "switch_tab":
          return await this.browser.switchTab(args.tab_index);
        default:
          return `Unknown tool: ${name}`;
      }
    } catch (err: any) {
      return `Error: ${err.message}`;
    }
  }

  /**
   * Gates task_complete. Returns an error string (injected as tool_result) when
   * the agent tries to finish before having made enough query_dom calls to
   * actually inspect the items requested by the task. Returns null when it's
   * OK to complete.
   */
  private checkCompletionGate(): string | null {
    const req = this.completionRequirement;
    if (!req) return null;
    if (req.kind === "queryDom" && this.queryDomCount < req.min) {
      this.completionRejects++;
      return (
        `task_complete BLOCKED by completion gate: you've only made ${this.queryDomCount}/${req.min} query_dom calls. ` +
        `The task requires inspecting ${req.min} items. Each item must be verified via query_dom on an OPEN DIFFERENT item. ` +
        `Do NOT summarise items you haven't verified. ` +
        `NEXT ACTION: scroll down OR pick a DIFFERENT element_id (not the same as previous clicks — element ids are re-numbered; after go_back the next unread may have a different id), click to open, query_dom, go_back. ` +
        `Repeat until query_dom count = ${req.min}. Then task_complete with ONLY the ${req.min} items you actually read.`
      );
    }
    return null;
  }

  /**
   * Code-level safety guard for `click`: blocks bulk-selection regardless of the
   * task prompt or any pre-authorization. Forces ask_user and returns an error
   * string if the user does not confirm — agent must change approach.
   */
  private async clickSafetyCheck(elementId: number): Promise<string | null> {
    const info = this.browser.getElementInfo(elementId);
    if (!info) return null;

    const haystack = `${info.text} ${info.placeholder} ${info.value}`.toLowerCase();

    // Pattern 1: explicit "select all" labels (EN/RU, Gmail variants)
    const SELECT_ALL_RE =
      /выбрать\s*(все|всё)|выделить\s*все|select\s*all|all\s+\d{2,}\s*(in|conversations?|цепоч|писем|сообщен)/i;
    if (SELECT_ALL_RE.test(haystack)) {
      const q = `⚠️ BULK-SELECTION GUARD: element [${elementId}] "${info.text.substring(0, 120)}" looks like "Select all". This can select hundreds/thousands of items at once. Type YES to proceed, anything else to cancel.`;
      const ans = (await this.askUser(q)).trim();
      if (!/^(yes|да)$/i.test(ans)) {
        this.checkboxClickCount = 0;
        return `BLOCKED by safety guard: user did not confirm bulk selection (answered "${ans}"). Do NOT click this element. Pick individual items instead, or call task_complete.`;
      }
      return null; // user confirmed
    }

    // Pattern 2: consecutive checkbox clicks → confirm every 10 after threshold
    const isCheckbox =
      info.type === "checkbox" || info.role === "checkbox" || /checkbox/i.test(info.role);
    if (isCheckbox) {
      this.checkboxClickCount++;
      if (this.checkboxClickCount > 10 && (this.checkboxClickCount - 11) % 10 === 0) {
        const q = `⚠️ BULK-ACTION GUARD: you've clicked ${this.checkboxClickCount} checkboxes in this run. Continue? Type YES to proceed, anything else to stop bulk selection.`;
        const ans = (await this.askUser(q)).trim();
        if (!/^(yes|да)$/i.test(ans)) {
          return `BLOCKED by safety guard: user stopped bulk checkbox selection after ${this.checkboxClickCount} items (answered "${ans}"). Do NOT click more checkboxes — proceed to the delete/action step on the already-selected items, or call task_complete.`;
        }
      }
    } else {
      this.checkboxClickCount = 0; // reset on any non-checkbox click
    }

    return null;
  }

  /** Sub-agent: separate Claude call analyzes page DOM and answers a specific question */
  private async queryDom(query: string): Promise<string> {
    this.queryDomCount++;
    console.log(
      `\x1b[36m  [DOM Sub-agent #${this.queryDomCount}] ${query.substring(0, 60)}...\x1b[0m`
    );
    const pageState = await this.browser.getPageState();
    const prompt = `Analyze this web page and answer concisely. Return element numbers or factual info only.\n\nPAGE STATE:\n${pageState.substring(0, 10000)}\n\nQUESTION: ${query}`;

    if (this.useAPI) {
      const resp = await this.client.messages.create({
        model: this.model,
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      });
      return resp.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n");
    } else {
      return this.callClaude(prompt);
    }
  }
}
