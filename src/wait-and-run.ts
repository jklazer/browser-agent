/**
 * Waits for API rate limit to clear, then runs a task.
 * Usage: npx tsx src/wait-and-run.ts "Найди 3 вакансии AI-инженера на hh.ru"
 *
 * Close Claude Code BEFORE running this, then just wait.
 */
import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
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

function getToken(): string | null {
  try {
    const creds = JSON.parse(
      readFileSync(join(homedir(), ".claude", ".credentials.json"), "utf-8")
    );
    return creds?.claudeAiOauth?.accessToken ?? null;
  } catch {
    return null;
  }
}

async function waitForAPI(): Promise<void> {
  const token = getToken();
  if (!token) {
    console.error(`${C.red}OAuth-токен не найден${C.reset}`);
    process.exit(1);
  }

  const client = new Anthropic({ apiKey: token });
  console.log(`${C.yellow}Ожидание освобождения rate limit...${C.reset}`);
  console.log(`${C.gray}(Убедитесь что Claude Code полностью закрыт)${C.reset}\n`);

  for (let i = 1; i <= 30; i++) {
    try {
      await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 10,
        messages: [{ role: "user", content: "OK" }],
      });
      console.log(`${C.green}API доступен!${C.reset}\n`);
      return;
    } catch (err: any) {
      if (err?.status === 429) {
        process.stdout.write(`\r${C.yellow}  Попытка ${i}/30... rate limit ещё активен. Жду 10с...${C.reset}   `);
        await new Promise((r) => setTimeout(r, 10000));
      } else if (err?.status === 401) {
        console.log(`\n${C.red}Токен невалиден (401). Откройте Claude Code на 5 сек, закройте, и перезапустите.${C.reset}`);
        process.exit(1);
      } else {
        throw err;
      }
    }
  }
  console.log(`\n${C.red}Не удалось дождаться. Попробуйте позже.${C.reset}`);
  process.exit(1);
}

async function main() {
  const task = process.argv.slice(2).join(" ") || "";

  console.log(`\n${C.cyan}${C.bold}╔═══════════════════════════════════════════╗`);
  console.log(`║  Browser Agent — Wait & Run                ║`);
  console.log(`╚═══════════════════════════════════════════╝${C.reset}\n`);

  // Wait for API
  await waitForAPI();

  // Launch browser
  console.log(`${C.cyan}Запуск браузера...${C.reset}`);
  const browser = new BrowserController();
  await browser.launch();
  console.log(`${C.green}Браузер запущен!${C.reset}\n`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const prompt = (q: string): Promise<string> => new Promise((r) => rl.question(q, r));
  const askUser = async (q: string): Promise<string> => {
    console.log(`\n${C.yellow}[Агент спрашивает] ${q}${C.reset}`);
    return await prompt(`${C.yellow}> ${C.reset}`);
  };

  const shutdown = async () => {
    await browser.close().catch(() => {});
    rl.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);

  const agent = new Agent(browser, askUser);

  // Main loop
  let currentTask = task;
  while (true) {
    if (!currentTask) {
      currentTask = (await prompt(`${C.cyan}${C.bold}Задача: ${C.reset}`)).trim();
      if (!currentTask || currentTask === "exit") break;
    }

    const startTime = Date.now();
    try {
      const result = await agent.run(currentTask);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`\n${C.green}${C.bold}═══ Результат ═══${C.reset}`);
      console.log(result);
      console.log(`${C.green}═════════════════${C.reset} ${C.gray}(${elapsed}s)${C.reset}\n`);
    } catch (err: any) {
      console.error(`\n${C.red}Ошибка: ${err.message}${C.reset}\n`);
    }
    currentTask = "";
  }

  await shutdown();
}

main().catch((e) => { console.error(e.message); process.exit(1); });
