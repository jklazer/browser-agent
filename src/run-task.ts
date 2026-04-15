/**
 * Run a single task with the AI agent.
 * Usage: npx tsx src/run-task.ts "Найди 3 вакансии AI-инженера на hh.ru"
 */
import "dotenv/config";
import * as readline from "readline";
import { BrowserController } from "./browser.js";
import { Agent } from "./agent.js";

const C = {
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  reset: "\x1b[0m",
  bold: "\x1b[1m",
};

async function main() {
  const task = process.argv.slice(2).join(" ");
  if (!task) {
    console.error(`${C.red}Usage: npx tsx src/run-task.ts "Your task here"${C.reset}`);
    process.exit(1);
  }

  console.log(`${C.cyan}${C.bold}Task: ${task}${C.reset}\n`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const askUser = (q: string): Promise<string> =>
    new Promise((resolve) => {
      if ((rl as any).closed) { resolve("(user unavailable)"); return; }
      rl.question(`\n${C.yellow}[Agent asks] ${q}${C.reset}\n> `, resolve);
    });

  console.log(`${C.cyan}Launching browser...${C.reset}`);
  const browser = new BrowserController();
  await browser.launch();
  console.log(`${C.green}Browser launched!${C.reset}\n`);

  const shutdown = async () => {
    await browser.close().catch(() => {});
    rl.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);

  const agent = new Agent(browser, askUser);
  const startTime = Date.now();

  try {
    const result = await agent.run(task);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n${C.green}${C.bold}═══ Result ═══${C.reset}`);
    console.log(result);
    console.log(`${C.green}══════════════${C.reset} (${elapsed}s)\n`);
  } catch (err: any) {
    console.error(`\n${C.red}Error: ${err.message}${C.reset}`);
  }

  await browser.close();
  rl.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
