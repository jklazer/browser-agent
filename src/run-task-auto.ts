/**
 * Run a task with ask_user auto-answering YES.
 * WARNING: bypasses interactive confirmation — code-level safety guards still
 * apply only insofar as the user's YES "allows" bulk actions. Use only when
 * destructive actions are explicitly pre-authorized by the user.
 */
import "dotenv/config";
import { BrowserController } from "./browser.js";
import { Agent } from "./agent.js";

const C = {
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  gray: "\x1b[90m",
  reset: "\x1b[0m",
  bold: "\x1b[1m",
};

async function main() {
  const task = process.argv.slice(2).join(" ");
  if (!task) {
    console.error(`${C.red}Usage: npx tsx src/run-task-auto.ts "Your task"${C.reset}`);
    process.exit(1);
  }
  console.log(`${C.cyan}${C.bold}Task: ${task}${C.reset}`);
  console.log(
    `${C.yellow}⚠️  AUTO-YES MODE — all ask_user prompts auto-answer YES.${C.reset}\n`
  );

  const askUser = async (q: string): Promise<string> => {
    console.log(`\n${C.yellow}[Agent asks] ${q}${C.reset}`);
    console.log(`${C.green}[auto-YES]${C.reset}`);
    return "YES";
  };

  console.log(`${C.cyan}Launching browser...${C.reset}`);
  const browser = new BrowserController();
  await browser.launch();
  console.log(`${C.green}Browser launched.${C.reset}\n`);

  const agent = new Agent(browser, askUser);

  let isShuttingDown = false;
  const shutdown = async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`\n${C.yellow}Aborting...${C.reset}`);
    agent.abort();
    await new Promise((r) => setTimeout(r, 800));
    await browser.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const startTime = Date.now();
  try {
    const { result, logFile, usage } = await agent.run(task);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n${C.green}${C.bold}═══ Result ═══${C.reset}`);
    console.log(result);
    console.log(`${C.green}══════════════${C.reset}`);
    console.log(`${C.gray}Time: ${elapsed}s | Usage: ${usage} | Log: ${logFile}${C.reset}\n`);
  } catch (err: any) {
    console.error(`\n${C.red}Error: ${err.message}${C.reset}`);
  }

  await browser.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
