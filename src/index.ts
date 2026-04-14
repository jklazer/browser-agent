import "dotenv/config";
import * as readline from "readline";
import { BrowserController } from "./browser.js";
import { Agent } from "./agent.js";

// ── ANSI colors ───────────────────────────────────────────────
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

  // ── Check Ollama is running ──────────────────────────────
  const ollamaUrl = process.env.OLLAMA_URL || "http://localhost:11434";
  try {
    const res = await fetch(`${ollamaUrl}/api/tags`);
    if (!res.ok) throw new Error("Ollama not responding");
    const data = await res.json() as any;
    const models = data.models?.map((m: any) => m.name) || [];
    const target = process.env.OLLAMA_MODEL || "qwen3:8b";
    if (!models.some((m: string) => m.startsWith(target.split(":")[0]))) {
      console.error(`${C.red}Модель ${target} не найдена в Ollama.${C.reset}`);
      console.error(`Установленные: ${models.join(", ") || "(пусто)"}`);
      console.error(`\nСкачайте: ollama pull ${target}`);
      process.exit(1);
    }
    console.log(`${C.green}Ollama OK — модель ${target} найдена.${C.reset}`);
  } catch (err: any) {
    console.error(`${C.red}Ollama не доступен: ${err.message}${C.reset}`);
    console.error(`\nЗапустите Ollama и скачайте модель:\n  ollama pull qwen3:8b`);
    process.exit(1);
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
    const answer = await prompt(`${C.yellow}> ${C.reset}`);
    return answer;
  };

  // ── Launch browser ────────────────────────────────────────
  console.log(`${C.cyan}Запуск браузера...${C.reset}`);
  const browser = new BrowserController();
  try {
    await browser.launch();
  } catch (err: any) {
    console.error(`${C.red}Не удалось запустить браузер: ${err.message}${C.reset}`);
    console.error(
      `\nУстановите Chromium:\n  cd browser-agent && npx playwright install chromium`
    );
    rl.close();
    process.exit(1);
  }
  console.log(`${C.green}Браузер запущен!${C.reset}\n`);

  const agent = new Agent(browser, askUser);

  // ── Graceful shutdown on SIGINT ───────────────────────────
  const shutdown = async () => {
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
      // EOF / Ctrl+D
      break;
    }

    const trimmed = task.trim();
    if (!trimmed) continue;
    if (trimmed === "exit" || trimmed === "quit" || trimmed === "выход") break;

    console.log(); // spacing
    const startTime = Date.now();

    try {
      const result = await agent.run(trimmed);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

      console.log(`\n${C.green}${C.bold}═══ Результат ═══${C.reset}`);
      console.log(result);
      console.log(
        `${C.green}═════════════════${C.reset} ${C.gray}(${elapsed}s)${C.reset}\n`
      );
    } catch (err: any) {
      console.error(`\n${C.red}Ошибка выполнения: ${err.message}${C.reset}\n`);
    }
  }

  // ── Cleanup ───────────────────────────────────────────────
  console.log(`\n${C.cyan}Закрытие браузера...${C.reset}`);
  await browser.close();
  rl.close();
  console.log("До свидания!");
  process.exit(0);
}

main().catch(async (err) => {
  console.error(`${C.red}Fatal: ${err.message}${C.reset}`);
  // Attempt to close browser to avoid orphaned Chromium processes
  try {
    const { exec } = await import("child_process");
    exec("taskkill /F /IM chromium.exe 2>nul");
  } catch {}
  process.exit(1);
});
