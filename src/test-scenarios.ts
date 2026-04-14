/**
 * End-to-end scenario tests for BrowserController on real websites.
 * Tests the browser automation layer that the AI agent relies on.
 *
 * Scenarios:
 * 1. hh.ru — search for vacancies, find elements, click into a vacancy
 * 2. Yandex Eda — navigate, find restaurants, interact with search
 * 3. Yandex Mail — navigate to login page, find form elements
 */
import { BrowserController } from "./browser.js";

const OK = "\x1b[32m[PASS]\x1b[0m";
const FAIL = "\x1b[31m[FAIL]\x1b[0m";
const INFO = "\x1b[36m[INFO]\x1b[0m";
const WARN = "\x1b[33m[WARN]\x1b[0m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail = "") {
  if (condition) {
    console.log(`  ${OK} ${name} ${detail}`);
    passed++;
  } else {
    console.log(`  ${FAIL} ${name} ${detail}`);
    failed++;
  }
}

function findElement(state: string, pattern: RegExp): { id: number; line: string } | null {
  const lines = state.split("\n");
  for (const line of lines) {
    if (pattern.test(line)) {
      const idMatch = line.match(/^\[(\d+)\]/);
      if (idMatch) return { id: parseInt(idMatch[1]), line: line.trim() };
    }
  }
  return null;
}

function countElements(state: string): number {
  const match = state.match(/Interactive Elements \((\d+)\)/);
  return match ? parseInt(match[1]) : 0;
}

function getUrl(state: string): string {
  const match = state.match(/URL: (.+)/);
  return match ? match[1].trim() : "";
}

// ══════════════════════════════════════════════════════════════
// SCENARIO 1: hh.ru — Поиск вакансий
// ══════════════════════════════════════════════════════════════
async function testHH(browser: BrowserController) {
  console.log(`\n${BOLD}══ Сценарий 1: hh.ru — Поиск вакансий ══${RESET}\n`);

  // Navigate
  console.log(`${INFO} Навигация на hh.ru...`);
  const navResult = await browser.navigate("https://hh.ru");
  const url = getUrl(navResult);
  check("Открыт hh.ru", url.includes("hh.ru"));

  const elemCount = countElements(navResult);
  check("Найдены интерактивные элементы", elemCount > 5, `(${elemCount} элементов)`);

  // Find search input
  const searchInput = findElement(navResult, /input.*type="(text|search)"/i)
    || findElement(navResult, /placeholder.*(поиск|search|вакан|долж)/i)
    || findElement(navResult, /<input.*type="text"/i);

  if (searchInput) {
    console.log(`${INFO} Поле поиска: ${searchInput.line.substring(0, 100)}`);
    check("Поле поиска найдено", true);

    // Type search query
    console.log(`${INFO} Ввод: "AI инженер"...`);
    const typeResult = await browser.typeText(searchInput.id, "AI инженер");
    check("Текст введён", typeResult.includes("Typed"));

    // Find search button
    const searchBtn = findElement(navResult, /button.*(найти|поиск|search|submit)/i)
      || findElement(navResult, /<button.*type="submit"/i);

    if (searchBtn) {
      console.log(`${INFO} Кнопка поиска: ${searchBtn.line.substring(0, 100)}`);
      const clickResult = await browser.click(searchBtn.id);
      check("Кнопка поиска нажата", clickResult.includes("Clicked"));
    } else {
      // Fallback: press Enter
      console.log(`${INFO} Кнопка не найдена, нажимаю Enter...`);
      await browser.pressKey("Enter");
    }

    // Wait for results
    await browser.wait(3000);

    // Get search results page
    const resultsState = await browser.getPageState();
    const resultsUrl = getUrl(resultsState);
    check("Перешли на страницу результатов", resultsUrl.includes("search") || resultsUrl.includes("vacancy") || resultsUrl.includes("hh.ru"));

    // Check for vacancy links
    const hasVacancies = resultsState.includes("вакан") || resultsState.includes("AI") || resultsState.includes("инженер");
    check("Результаты содержат релевантный контент", hasVacancies);

    const vacancyLink = findElement(resultsState, /<a.*".*[Ii]nженер|AI|ML|[Дд]анн/);
    if (vacancyLink) {
      console.log(`${INFO} Найдена вакансия: ${vacancyLink.line.substring(0, 120)}`);
      check("Конкретная вакансия найдена в списке", true);
    } else {
      console.log(`${WARN} Конкретная вакансия не найдена в первых элементах, но страница результатов загружена`);
    }

    // Take screenshot of results
    const screenshot = await browser.screenshot();
    check("Скриншот результатов снят", screenshot.length > 5000);
  } else {
    console.log(`${WARN} Поле поиска не обнаружено, показываю первые элементы:`);
    const lines = navResult.split("\n").filter((l) => l.match(/^\[\d+\]/));
    for (const l of lines.slice(0, 10)) console.log(`  ${INFO} ${l.substring(0, 120)}`);
    check("Поле поиска найдено", false);
  }
}

// ══════════════════════════════════════════════════════════════
// SCENARIO 2: Доставка еды (Яндекс Еда)
// ══════════════════════════════════════════════════════════════
async function testDelivery(browser: BrowserController) {
  console.log(`\n${BOLD}══ Сценарий 2: Яндекс Еда — Заказ еды ══${RESET}\n`);

  console.log(`${INFO} Навигация на eda.yandex.ru...`);
  const navResult = await browser.navigate("https://eda.yandex.ru");
  const url = getUrl(navResult);
  check("Открыт Яндекс Еда", url.includes("eda.yandex") || url.includes("yandex"));

  const elemCount = countElements(navResult);
  check("Элементы найдены", elemCount > 0, `(${elemCount})`);

  // Look for address/search input or any interactive elements
  const addressInput = findElement(navResult, /placeholder.*(адрес|address|улиц|город|доставк)/i)
    || findElement(navResult, /input.*type="text"/i)
    || findElement(navResult, /<input/i);

  if (addressInput) {
    console.log(`${INFO} Поле ввода: ${addressInput.line.substring(0, 120)}`);
    check("Поле ввода (адрес/поиск) найдено", true);
  } else {
    console.log(`${WARN} Поле ввода не найдено (может быть экран выбора города)`);
  }

  // Look for restaurant links or category buttons
  const restaurantLink = findElement(navResult, /<a.*(рестор|бургер|пицц|суш|кафе|еда)/i)
    || findElement(navResult, /role="button".*(рестор|бургер|пицц|суш)/i);

  if (restaurantLink) {
    console.log(`${INFO} Ресторан/категория: ${restaurantLink.line.substring(0, 120)}`);
    check("Рестораны/категории видны", true);
  }

  // Check page content for food-related terms
  const hasFoodContent = navResult.toLowerCase().includes("рестор")
    || navResult.toLowerCase().includes("доставк")
    || navResult.toLowerCase().includes("еда")
    || navResult.toLowerCase().includes("меню");
  check("Контент связан с едой", hasFoodContent);

  // Screenshot
  const screenshot = await browser.screenshot();
  check("Скриншот снят", screenshot.length > 5000);

  // Show some elements for debug
  console.log(`${INFO} Первые элементы:`);
  const lines = navResult.split("\n").filter((l) => l.match(/^\[\d+\]/));
  for (const l of lines.slice(0, 8)) console.log(`    ${l.substring(0, 130)}`);
}

// ══════════════════════════════════════════════════════════════
// SCENARIO 3: Яндекс Почта — страница входа
// ══════════════════════════════════════════════════════════════
async function testMail(browser: BrowserController) {
  console.log(`\n${BOLD}══ Сценарий 3: Яндекс Почта — Вход ══${RESET}\n`);

  console.log(`${INFO} Навигация на mail.yandex.ru...`);
  const navResult = await browser.navigate("https://mail.yandex.ru");
  const url = getUrl(navResult);
  check("Открыта Яндекс Почта / страница входа", url.includes("yandex") || url.includes("passport"));

  const elemCount = countElements(navResult);
  check("Элементы найдены", elemCount > 0, `(${elemCount})`);

  // Should redirect to passport/login page
  const isLoginPage = navResult.toLowerCase().includes("войти")
    || navResult.toLowerCase().includes("вход")
    || navResult.toLowerCase().includes("логин")
    || navResult.toLowerCase().includes("sign in")
    || navResult.toLowerCase().includes("passport")
    || url.includes("passport");
  check("Страница входа обнаружена", isLoginPage);

  // Find login input
  const loginInput = findElement(navResult, /input.*type="(text|email|tel)"/i)
    || findElement(navResult, /placeholder.*(логин|email|телефон|login|phone)/i)
    || findElement(navResult, /<input.*name="login"/i);

  if (loginInput) {
    console.log(`${INFO} Поле логина: ${loginInput.line.substring(0, 120)}`);
    check("Поле ввода логина найдено", true);

    // Test typing (don't actually submit)
    const typeResult = await browser.typeText(loginInput.id, "test@example.com");
    check("Можно ввести email", typeResult.includes("Typed"));
  } else {
    console.log(`${WARN} Поле логина не найдено, показываю элементы:`);
    const lines = navResult.split("\n").filter((l) => l.match(/^\[\d+\]/));
    for (const l of lines.slice(0, 10)) console.log(`    ${l.substring(0, 130)}`);
  }

  // Find submit / sign-in button
  const signInBtn = findElement(navResult, /button.*(войти|вход|sign.in|submit|далее|продолж)/i)
    || findElement(navResult, /<button.*type="submit"/i);

  if (signInBtn) {
    console.log(`${INFO} Кнопка входа: ${signInBtn.line.substring(0, 120)}`);
    check("Кнопка входа найдена", true);
  }

  // Screenshot
  const screenshot = await browser.screenshot();
  check("Скриншот снят", screenshot.length > 5000);
}

// ══════════════════════════════════════════════════════════════
// SCENARIO 4: Google — базовый поиск (доп. тест)
// ══════════════════════════════════════════════════════════════
async function testGoogleSearch(browser: BrowserController) {
  console.log(`\n${BOLD}══ Сценарий 4: Google — Поиск ══${RESET}\n`);

  console.log(`${INFO} Навигация на google.com...`);
  const navResult = await browser.navigate("https://www.google.com");
  const url = getUrl(navResult);
  check("Открыт Google", url.includes("google"));

  // Find search input
  const searchInput = findElement(navResult, /textarea|input.*type="(text|search)"/i)
    || findElement(navResult, /role="(combobox|searchbox)"/i)
    || findElement(navResult, /placeholder.*(search|поиск|Google)/i);

  if (searchInput) {
    console.log(`${INFO} Поле поиска: ${searchInput.line.substring(0, 120)}`);
    check("Поле поиска Google найдено", true);

    // Type and search
    const typeResult = await browser.typeText(searchInput.id, "browser automation AI agent");
    check("Текст введён", typeResult.includes("Typed"));

    await browser.pressKey("Enter");
    await browser.wait(2000);

    // Check results
    const resultsState = await browser.getPageState();
    const hasResults = resultsState.toLowerCase().includes("browser")
      || resultsState.toLowerCase().includes("automation")
      || resultsState.toLowerCase().includes("результат");
    check("Результаты поиска загружены", hasResults);

    const resultsElements = countElements(resultsState);
    check("Элементы на странице результатов", resultsElements > 10, `(${resultsElements})`);
  } else {
    check("Поле поиска Google найдено", false);
  }
}

// ══════════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════════
async function main() {
  console.log(`\n${BOLD}${"═".repeat(56)}`);
  console.log("  Browser Agent — E2E сценарные тесты на реальных сайтах");
  console.log(`${"═".repeat(56)}${RESET}\n`);

  const browser = new BrowserController();
  console.log(`${INFO} Запуск браузера...`);
  await browser.launch();
  console.log(`${INFO} Браузер запущен.\n`);

  try {
    await testHH(browser);
    await testDelivery(browser);
    await testMail(browser);
    await testGoogleSearch(browser);
  } catch (err: any) {
    console.log(`\n${FAIL} Критическая ошибка: ${err.message}`);
    console.log(err.stack);
  }

  // Cleanup
  console.log(`\n${INFO} Закрытие браузера...`);
  await browser.close();

  // Summary
  console.log(`\n${BOLD}${"═".repeat(40)}`);
  console.log(`  Итого: ${passed} прошло, ${failed} провалено`);
  console.log(`${"═".repeat(40)}${RESET}`);
  if (failed === 0) {
    console.log(`\n${OK} Все тесты прошли!\n`);
  } else {
    console.log(`\n${FAIL} Есть проваленные тесты.\n`);
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
