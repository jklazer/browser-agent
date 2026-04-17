/**
 * Summarize all task logs: steps, tokens, cost per run.
 */
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

const PRICING = { input: 3, output: 15, cache_write: 3.75, cache_read: 0.3 }; // per 1M tokens

const LOGS_DIR = "logs";
const files = readdirSync(LOGS_DIR).filter((f) => f.endsWith(".jsonl")).sort();

let grandIn = 0, grandOut = 0, grandCW = 0, grandCR = 0, grandSteps = 0, grandTools = 0;

for (const file of files) {
  const content = readFileSync(join(LOGS_DIR, file), "utf-8");
  const lines = content.trim().split("\n").filter(Boolean);
  let tokens_in = 0, tokens_out = 0, cache_write = 0, cache_read = 0;
  let maxStep = 0, toolCalls = 0, task = "", finalResult = "";

  for (const line of lines) {
    try {
      const e = JSON.parse(line);
      if (e.step > maxStep) maxStep = e.step;
      if (e.type === "usage") {
        tokens_in += e.tokens_in || 0;
        tokens_out += e.tokens_out || 0;
        cache_write += e.cache_write || 0;
        cache_read += e.cache_read || 0;
      }
      if (e.type === "tool_call") toolCalls++;
      if (e.step === 0 && e.text?.startsWith("Task: ")) task = e.text.substring(6).substring(0, 80);
      if (e.text?.startsWith("TASK COMPLETE")) finalResult = e.text.substring(0, 100);
    } catch {}
  }

  const cost = (tokens_in * PRICING.input + tokens_out * PRICING.output + cache_write * PRICING.cache_write + cache_read * PRICING.cache_read) / 1_000_000;
  const totalTokens = tokens_in + tokens_out + cache_write + cache_read;
  const cacheRate = (cache_read + cache_write) > 0 ? cache_read / (cache_read + cache_write) * 100 : 0;

  console.log(`\n\x1b[36m📋 ${file}\x1b[0m`);
  console.log(`   Task: ${task}...`);
  console.log(`   Steps: ${maxStep} | Tools: ${toolCalls}`);
  console.log(`   Tokens: ${(totalTokens / 1000).toFixed(1)}K (in: ${tokens_in}, out: ${tokens_out}, cache_w: ${cache_write}, cache_r: ${cache_read})`);
  console.log(`   Cache hit: ${cacheRate.toFixed(0)}%`);
  console.log(`   Cost: \x1b[32m$${cost.toFixed(4)}\x1b[0m`);
  if (finalResult) console.log(`   ${finalResult}`);

  grandIn += tokens_in;
  grandOut += tokens_out;
  grandCW += cache_write;
  grandCR += cache_read;
  grandSteps += maxStep;
  grandTools += toolCalls;
}

const grandCost = (grandIn * PRICING.input + grandOut * PRICING.output + grandCW * PRICING.cache_write + grandCR * PRICING.cache_read) / 1_000_000;
const grandTokens = grandIn + grandOut + grandCW + grandCR;

console.log(`\n\x1b[33m═══ ИТОГО ═══\x1b[0m`);
console.log(`Runs: ${files.length}`);
console.log(`Steps: ${grandSteps}`);
console.log(`Tool calls: ${grandTools}`);
console.log(`Total tokens: ${(grandTokens / 1000).toFixed(1)}K`);
console.log(`  input: ${grandIn.toLocaleString()}`);
console.log(`  output: ${grandOut.toLocaleString()}`);
console.log(`  cache write: ${grandCW.toLocaleString()}`);
console.log(`  cache read: ${grandCR.toLocaleString()}`);
console.log(`\x1b[32mTotal cost: $${grandCost.toFixed(4)}\x1b[0m`);
