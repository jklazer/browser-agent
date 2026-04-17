/**
 * Per-task logging: every step, tool call, and result is saved to logs/run-<timestamp>.json
 * Great for demo videos and debugging.
 */
import { mkdirSync, writeFileSync, appendFileSync } from "fs";
import { join } from "path";

export interface LogStep {
  step: number;
  ts: string;
  type: "thought" | "tool_call" | "tool_result" | "error" | "usage";
  tool?: string;
  input?: any;
  output?: string;
  tokens_in?: number;
  tokens_out?: number;
  cache_read?: number;
  cache_write?: number;
  text?: string;
}

export class TaskLogger {
  private file: string;
  private step = 0;
  private startTime = Date.now();
  readonly task: string;

  constructor(task: string) {
    this.task = task;
    mkdirSync("logs", { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    this.file = join("logs", `run-${ts}.jsonl`);
    this.write({ type: "thought", step: 0, ts: new Date().toISOString(), text: `Task: ${task}` });
  }

  nextStep(): number {
    return ++this.step;
  }

  write(entry: Partial<LogStep>): void {
    const full: LogStep = {
      step: this.step,
      ts: new Date().toISOString(),
      type: "thought",
      ...entry,
    } as LogStep;
    appendFileSync(this.file, JSON.stringify(full) + "\n");
  }

  thought(text: string): void {
    this.write({ type: "thought", text });
  }

  toolCall(tool: string, input: any): void {
    this.write({ type: "tool_call", tool, input });
  }

  toolResult(tool: string, output: string): void {
    this.write({ type: "tool_result", tool, output: output.substring(0, 2000) });
  }

  error(message: string): void {
    this.write({ type: "error", text: message });
  }

  usage(u: { input_tokens?: number | null; output_tokens?: number | null; cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null }): void {
    this.write({
      type: "usage",
      tokens_in: u.input_tokens ?? undefined,
      tokens_out: u.output_tokens ?? undefined,
      cache_write: u.cache_creation_input_tokens ?? undefined,
      cache_read: u.cache_read_input_tokens ?? undefined,
    });
  }

  finalize(summary: string): string {
    this.write({ type: "thought", text: `TASK COMPLETE (${((Date.now() - this.startTime) / 1000).toFixed(1)}s): ${summary}` });
    return this.file;
  }
}

// ── Cost tracking ─────────────────────────────────────────────
// Claude Sonnet 4 pricing per 1M tokens
const PRICING: Record<string, { input: number; output: number; cache_write: number; cache_read: number }> = {
  "claude-sonnet-4-6": { input: 3, output: 15, cache_write: 3.75, cache_read: 0.3 },
  "claude-sonnet-4-5": { input: 3, output: 15, cache_write: 3.75, cache_read: 0.3 },
  "claude-opus-4-6": { input: 15, output: 75, cache_write: 18.75, cache_read: 1.5 },
  "claude-opus-4-7": { input: 15, output: 75, cache_write: 18.75, cache_read: 1.5 },
  "claude-haiku-4-5-20251001": { input: 0.8, output: 4, cache_write: 1, cache_read: 0.08 },
};

export class UsageTracker {
  private model: string;
  private totalIn = 0;
  private totalOut = 0;
  private totalCacheWrite = 0;
  private totalCacheRead = 0;

  constructor(model: string) {
    this.model = model;
  }

  add(u: { input_tokens?: number | null; output_tokens?: number | null; cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null }) {
    this.totalIn += u.input_tokens || 0;
    this.totalOut += u.output_tokens || 0;
    this.totalCacheWrite += u.cache_creation_input_tokens || 0;
    this.totalCacheRead += u.cache_read_input_tokens || 0;
  }

  summary(): { tokens: number; cost: number; cacheHitRate: number } {
    const pricing = PRICING[this.model] || PRICING["claude-sonnet-4-6"];
    const cost =
      (this.totalIn * pricing.input +
        this.totalOut * pricing.output +
        this.totalCacheWrite * pricing.cache_write +
        this.totalCacheRead * pricing.cache_read) /
      1_000_000;
    const tokens = this.totalIn + this.totalOut + this.totalCacheWrite + this.totalCacheRead;
    const cacheTotal = this.totalCacheRead + this.totalCacheWrite;
    const cacheHitRate = cacheTotal > 0 ? this.totalCacheRead / cacheTotal : 0;
    return { tokens, cost, cacheHitRate };
  }

  format(): string {
    const s = this.summary();
    return `${(s.tokens / 1000).toFixed(1)}K tokens, $${s.cost.toFixed(4)} (cache ${(s.cacheHitRate * 100).toFixed(0)}%)`;
  }
}
