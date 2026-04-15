import "dotenv/config";
import * as readline from "readline";
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

const BANNER = `
${C.cyan}${C.bold}╔═══════════════════════════════════════════════════╗
║           AI Browser Agent v1.0                   ║
║   Автономный AI-агент для управления браузером    ║
╠═══════════════════════════════════════════════════╣
║  Введите задачу текстом — агент выполнит её       ║
║  в реальном браузере.                             ║
║                                                   ║
║  Примеры:                                         ║
║  • Найди 3 вакансии AI-инженера на hh.ru          ║
║  • Закажи пиццу на delivery-club.ru               ║
║  • Прочитай последние 5 писем в почте             ║
║                                                   ║
║  Команды: exit — выход                            ║
╚═══════════════════════════════════════════════════╝${C.reset}
`;

async function main() {
  console.log(BANNER);

  // ── Check auth: API key or Claude CLI ─────────────────────
  if (process.env.ANTHROPIC_API_KEY) {
    console.log(`${C.green}API key found → fast mode.${C.reset}`);
  } else {
    try {
      const { execFileSync } = await import("child_process");
      execFileSync("claude", ["--version"], { encoding: "utf-8", timeout: 5000 });
      console.log(`${C.green}Claude CLI found → subscription mode.${C.reset}`);
    } catch {
      console.error(
        `${C.red}Neither ANTHROPIC_API_KEY nor Claude CLI found.${C.reset}\n\n` +
        `Options:\n` +
        `  1. Set ANTHROPIC_API_KEY in .env file\n` +
        `  2. Install Claude CLI: npm i -g @anthropic-ai/claude-code\n`
      );
      process.exit(1);
    }
  }

  // ── Setup readline ────────────────────────────────────────
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = (query: string): Promise<string> =>
    new Promise((resolve) => rl.question(query, resolve));

  const askUser = async (question: string): Promise<string> => {
    console.log(`\n${C.yellow}[Агент спрашивает] ${question}${C.reset}`);
    return await prompt(`${C.yellow}> ${C.reset}`);
  };

  // ── Launch browser ────────────────────────────────────────
  console.log(`${C.cyan}Запуск браузера...${C.reset}`);
  const browser = new BrowserController();
  try {
    await browser.launch();
  } catch (err: any) {
    console.error(`${C.red}Не удалось запустить браузер: ${err.message}${C.reset}`);
    console.error(`\nУстановите Chromium:\n  cd browser-agent && npx playwright install chromium`);
    rl.close();
    process.exit(1);
  }
  console.log(`${C.green}Браузер запущен!${C.reset}\n`);

  const agent = new Agent(browser, askUser);

  // ── Graceful shutdown ─────────────────────────────────────
  let isShuttingDown = false;
  const shutdown = async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`\n${C.cyan}Закрытие браузера...${C.reset}`);
    await browser.close().catch(() => {});
    rl.close();
    console.log("До свидания!");
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // ── Main loop ─────────────────────────────────────────────
  while (true) {
    let task: string;
    try {
      task = await prompt(`${C.cyan}${C.bold}Задача: ${C.reset}`);
    } catch {
      break; // EOF / Ctrl+D
    }

    const trimmed = task.trim();
    if (!trimmed) continue;
    if (trimmed === "exit" || trimmed === "quit" || trimmed === "выход") break;

    console.log();
    const startTime = Date.now();
    try {
      const result = await agent.run(trimmed);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`\n${C.green}${C.bold}═══ Результат ═══${C.reset}`);
      console.log(result);
      console.log(`${C.green}═════════════════${C.reset} ${C.gray}(${elapsed}s)${C.reset}\n`);
    } catch (err: any) {
      console.error(`\n${C.red}Ошибка: ${err.message}${C.reset}\n`);
    }
  }

  await shutdown();
}

main().catch((err) => {
  console.error(`\x1b[31mFatal: ${err.message}\x1b[0m`);
  process.exit(1);
});
