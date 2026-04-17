/**
 * Opens the persistent browser for manual login.
 * User logs in, closes terminal (Ctrl+C) when done — sessions saved.
 */
import { BrowserController } from "./browser.js";

async function main() {
  const browser = new BrowserController();
  await browser.launch();
  console.log("\n\x1b[32mБраузер открыт.\x1b[0m");
  console.log("\x1b[36mЗалогинься на нужных сайтах (mail.yandex.ru, hh.ru, и т.д.).\x1b[0m");
  console.log("\x1b[36mВсе сессии сохранятся. Когда закончишь — нажми Ctrl+C.\x1b[0m\n");

  const shutdown = async () => {
    console.log("\n\x1b[36mСохранение сессий и закрытие...\x1b[0m");
    await browser.close().catch(() => {});
    console.log("\x1b[32mГотово! Теперь запускай npm start или npm run task.\x1b[0m");
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Keep process alive
  await new Promise(() => {});
}

main();
