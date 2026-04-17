/**
 * Unit tests for the code-level safety guards in Agent.
 * Does NOT touch the real browser or LLM — uses mocks.
 */
import "dotenv/config";
import type { BrowserController, InteractiveElement } from "./browser.js";
import { Agent } from "./agent.js";

const OK = "\x1b[32m[PASS]\x1b[0m";
const FAIL = "\x1b[31m[FAIL]\x1b[0m";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    console.log(`${OK} ${name}`);
    passed++;
  } else {
    console.log(`${FAIL} ${name} ${detail}`);
    failed++;
  }
}

class MockBrowser {
  private elements: InteractiveElement[] = [];
  setElements(els: Partial<InteractiveElement>[]) {
    this.elements = els.map((e, i) => ({
      id: i,
      tag: "div",
      type: "",
      role: "",
      text: "",
      href: "",
      placeholder: "",
      value: "",
      checked: false,
      disabled: false,
      inViewport: true,
      ...e,
    })) as InteractiveElement[];
  }
  getElementInfo(id: number): InteractiveElement | null {
    return this.elements.find((e) => e.id === id) || null;
  }
  // Stub — guard bypass will try to call .click, returns a benign marker.
  async click(_id: number): Promise<string> {
    return "mock-clicked";
  }
}

async function main() {
  console.log("\n=== Safety Guard Unit Tests ===\n");

  let lastQuestion = "";
  let userAnswer = "NO";
  const askUser = async (q: string): Promise<string> => {
    lastQuestion = q;
    return userAnswer;
  };

  const mock = new MockBrowser();
  const agent = new Agent(mock as unknown as BrowserController, askUser);

  // ── Test 1: "Выбрать все N цепочек" — user says NO → blocked
  mock.setElements([
    { id: 0, tag: "button", text: "Выбрать все цепочки (2795) в разделе Промоакции" },
  ]);
  userAnswer = "NO";
  lastQuestion = "";
  let result = await (agent as any).executeTool("click", { element_id: 0 });
  check("Select all (RU) triggers guard", lastQuestion.includes("BULK-SELECTION"));
  check("Select all (RU) blocked on NO", result.includes("BLOCKED"));

  // ── Test 2: Same, user says YES → guard passes
  userAnswer = "YES";
  lastQuestion = "";
  result = await (agent as any).executeTool("click", { element_id: 0 });
  check("Select all (RU) bypassed on YES", !result.includes("BLOCKED"));

  // ── Test 3: "Select all N conversations" (EN)
  mock.setElements([
    { id: 0, tag: "button", text: "Select all 1500 conversations in Promotions" },
  ]);
  userAnswer = "NO";
  lastQuestion = "";
  result = await (agent as any).executeTool("click", { element_id: 0 });
  check("Select all (EN) triggers guard", lastQuestion.includes("BULK-SELECTION"));
  check("Select all (EN) blocked on NO", result.includes("BLOCKED"));

  // ── Test 4: Regular button — no guard
  mock.setElements([{ id: 0, tag: "button", text: "Submit form" }]);
  lastQuestion = "";
  result = await (agent as any).executeTool("click", { element_id: 0 });
  check("Regular button — no guard fired", lastQuestion === "");

  // ── Test 5: Checkboxes — first 10 clicks no guard, 11th triggers
  const cbAgent = new Agent(mock as unknown as BrowserController, askUser);
  mock.setElements(
    Array.from({ length: 20 }, (_, i) => ({
      id: i,
      tag: "input",
      type: "checkbox",
      text: `Email subject ${i}`,
    }))
  );
  userAnswer = "YES";
  let guardHitCount = 0;
  for (let i = 0; i < 10; i++) {
    lastQuestion = "";
    await (cbAgent as any).executeTool("click", { element_id: i });
    if (lastQuestion.includes("BULK-ACTION")) guardHitCount++;
  }
  check("First 10 checkbox clicks — no guard", guardHitCount === 0);

  lastQuestion = "";
  await (cbAgent as any).executeTool("click", { element_id: 10 });
  check("11th checkbox triggers guard", lastQuestion.includes("BULK-ACTION"));

  // ── Test 6: 11th checkbox with NO → blocked
  const cbAgent2 = new Agent(mock as unknown as BrowserController, askUser);
  userAnswer = "YES";
  for (let i = 0; i < 10; i++) {
    await (cbAgent2 as any).executeTool("click", { element_id: i });
  }
  userAnswer = "NO";
  lastQuestion = "";
  const blocked = await (cbAgent2 as any).executeTool("click", { element_id: 10 });
  check("11th checkbox blocked on NO", blocked.includes("BLOCKED"));

  // ── Test 7: Non-checkbox click resets the counter
  const cbAgent3 = new Agent(mock as unknown as BrowserController, askUser);
  userAnswer = "YES";
  mock.setElements([
    ...Array.from({ length: 10 }, (_, i) => ({
      id: i,
      tag: "input",
      type: "checkbox",
      text: `cb${i}`,
    })),
    { id: 10, tag: "button", text: "Unrelated button" },
    ...Array.from({ length: 5 }, (_, i) => ({
      id: 11 + i,
      tag: "input",
      type: "checkbox",
      text: `cb2-${i}`,
    })),
  ]);
  for (let i = 0; i < 10; i++) {
    await (cbAgent3 as any).executeTool("click", { element_id: i });
  }
  await (cbAgent3 as any).executeTool("click", { element_id: 10 }); // resets
  lastQuestion = "";
  for (let i = 11; i < 16; i++) {
    await (cbAgent3 as any).executeTool("click", { element_id: i });
  }
  check("Non-checkbox click resets counter", !lastQuestion.includes("BULK-ACTION"));

  // ── Test 8: role="checkbox" (no type attr) also counted
  const cbAgent4 = new Agent(mock as unknown as BrowserController, askUser);
  mock.setElements(
    Array.from({ length: 15 }, (_, i) => ({
      id: i,
      tag: "div",
      role: "checkbox",
      text: `aria-cb${i}`,
    }))
  );
  userAnswer = "YES";
  for (let i = 0; i < 10; i++) {
    await (cbAgent4 as any).executeTool("click", { element_id: i });
  }
  lastQuestion = "";
  await (cbAgent4 as any).executeTool("click", { element_id: 10 });
  check("role='checkbox' counted the same", lastQuestion.includes("BULK-ACTION"));

  // ── Summary
  console.log(`\n${"=".repeat(40)}`);
  console.log(`${OK} Passed: ${passed}`);
  if (failed > 0) {
    console.log(`${FAIL} Failed: ${failed}`);
    process.exit(1);
  }
  console.log("All safety-guard tests passed!");
  process.exit(0);
}

main().catch((err) => {
  console.error(`Test crashed: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
