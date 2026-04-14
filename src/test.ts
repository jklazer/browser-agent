/**
 * Smoke test for BrowserController — verifies Playwright integration
 * without requiring an API key.
 */
import { BrowserController } from "./browser.js";

const OK = "\x1b[32m[PASS]\x1b[0m";
const FAIL = "\x1b[31m[FAIL]\x1b[0m";
const INFO = "\x1b[36m[INFO]\x1b[0m";

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail = "") {
  if (condition) {
    console.log(`${OK} ${name}`);
    passed++;
  } else {
    console.log(`${FAIL} ${name} ${detail}`);
    failed++;
  }
}

async function main() {
  console.log("\n=== BrowserController Smoke Test ===\n");

  const browser = new BrowserController();

  // 1. Launch
  console.log(`${INFO} Launching browser...`);
  await browser.launch();
  check("Browser launched", true);

  // 2. Navigate to a real page
  console.log(`${INFO} Navigating to example.com...`);
  const navResult = await browser.navigate("https://example.com");
  check("Navigate returned result", navResult.includes("example.com"));
  check("Page state included in navigate result", navResult.includes("=== Interactive Elements"));
  check("Page content included", navResult.includes("Example Domain"));

  // 3. Get page state separately
  console.log(`${INFO} Getting page state...`);
  const state = await browser.getPageState();
  check("getPageState returns URL", state.includes("URL:"));
  check("getPageState returns title", state.includes("Title:"));
  check("getPageState returns elements", state.includes("Interactive Elements"));

  // Parse element count
  const elemMatch = state.match(/Interactive Elements \((\d+)\)/);
  const elemCount = elemMatch ? parseInt(elemMatch[1]) : 0;
  check("Found interactive elements", elemCount > 0, `(found ${elemCount})`);
  console.log(`${INFO} Elements found: ${elemCount}`);

  // Print first few elements for inspection
  const elemLines = state.split("\n").filter((l) => l.match(/^\[\d+\]/));
  for (const line of elemLines.slice(0, 5)) {
    console.log(`${INFO}   ${line}`);
  }

  // 4. Screenshot
  console.log(`${INFO} Taking screenshot...`);
  const screenshotB64 = await browser.screenshot();
  check("Screenshot returns base64", screenshotB64.length > 1000);
  console.log(`${INFO} Screenshot size: ${(screenshotB64.length / 1024).toFixed(0)}KB base64`);

  // 5. Navigate to a more complex page (Wikipedia)
  console.log(`${INFO} Navigating to Wikipedia (ru)...`);
  const wikiResult = await browser.navigate("https://ru.wikipedia.org");
  check("Wikipedia navigation succeeded", wikiResult.includes("wikipedia"));

  const wikiState = await browser.getPageState();
  const wikiElemMatch = wikiState.match(/Interactive Elements \((\d+)\)/);
  const wikiElemCount = wikiElemMatch ? parseInt(wikiElemMatch[1]) : 0;
  check("Wikipedia has many elements", wikiElemCount > 10, `(found ${wikiElemCount})`);
  console.log(`${INFO} Wikipedia elements: ${wikiElemCount}`);

  // Find search input
  const searchLine = wikiState
    .split("\n")
    .find((l) => l.includes("placeholder") && (l.includes("search") || l.includes("Поиск") || l.includes("поиск") || l.includes("Искать") || l.includes("Найти")));
  if (searchLine) {
    console.log(`${INFO} Search field: ${searchLine.trim()}`);
    const idMatch = searchLine.match(/^\[(\d+)\]/);
    if (idMatch) {
      const searchId = parseInt(idMatch[1]);

      // 6. Type into search
      console.log(`${INFO} Typing "Искусственный интеллект" into search [${searchId}]...`);
      const typeResult = await browser.typeText(searchId, "Искусственный интеллект");
      check("Type text succeeded", typeResult.includes("Typed"));

      // 7. Press Enter
      console.log(`${INFO} Pressing Enter...`);
      const keyResult = await browser.pressKey("Enter");
      check("Press key succeeded", keyResult.includes("Pressed"));

      // Wait for navigation
      await browser.wait(2000);

      // 8. Check new page
      const searchState = await browser.getPageState();
      check(
        "Search navigated to results",
        searchState.includes("Искусственный интеллект") || searchState.includes("искусственн")
      );
      console.log(`${INFO} Current URL after search: ${searchState.split("\n")[0]}`);
    }
  } else {
    console.log(`${INFO} Search field not found in page state, skipping type test`);
    // Print some elements for debugging
    const lines = wikiState.split("\n").filter((l) => l.match(/^\[\d+\]/));
    for (const line of lines.slice(0, 10)) {
      console.log(`${INFO}   ${line.substring(0, 120)}`);
    }
  }

  // 9. Click test — click first link
  console.log(`${INFO} Testing click on first link...`);
  const freshState = await browser.getPageState();
  const firstLink = freshState.split("\n").find((l) => l.match(/^\[\d+\]/) && l.includes("<a"));
  if (firstLink) {
    const linkId = parseInt(firstLink.match(/^\[(\d+)\]/)![1]);
    console.log(`${INFO} Clicking [${linkId}]: ${firstLink.substring(0, 100)}`);
    const clickResult = await browser.click(linkId);
    check("Click returned result", clickResult.includes("Clicked") || clickResult.includes("error"));
  }

  // 10. Go back
  console.log(`${INFO} Testing go_back...`);
  const backResult = await browser.goBack();
  check("Go back succeeded", backResult.includes("back") || backResult.includes("URL:"));

  // 11. Scroll
  console.log(`${INFO} Testing scroll...`);
  const scrollResult = await browser.scroll("down", 500);
  check("Scroll succeeded", scrollResult.includes("Scrolled"));

  // 12. Hover (on first element)
  const hoverState = await browser.getPageState();
  const firstElem = hoverState.split("\n").find((l) => l.match(/^\[0\]/));
  if (firstElem) {
    const hoverResult = await browser.hover(0);
    check("Hover succeeded", hoverResult.includes("Hovered"));
  }

  // 13. Stale element handling
  console.log(`${INFO} Testing stale element error handling...`);
  const staleResult = await browser.click(9999);
  check("Stale element returns helpful error", staleResult.includes("not found"));

  // 14. Tab info
  const tabsResult = await browser.getTabsInfo();
  check("Tabs info available", tabsResult.includes("Open tabs"));

  // 15. Dangerous URL blocking
  const fileResult = await browser.navigate("file:///etc/passwd");
  check("file:// URL blocked", fileResult.includes("Blocked"));
  const jsResult = await browser.navigate("javascript:alert(1)");
  check("javascript: URL blocked", jsResult.includes("Blocked"));

  // Cleanup
  console.log(`\n${INFO} Closing browser...`);
  await browser.close();

  // Summary
  console.log(`\n${"=".repeat(40)}`);
  console.log(`${OK} Passed: ${passed}`);
  if (failed > 0) console.log(`${FAIL} Failed: ${failed}`);
  else console.log(`\x1b[32mAll tests passed!\x1b[0m`);
  console.log(`${"=".repeat(40)}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`\x1b[31mTest crashed: ${err.message}\x1b[0m`);
  console.error(err.stack);
  process.exit(1);
});
