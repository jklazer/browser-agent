import { chromium, Browser, BrowserContext, Page } from "playwright";

export interface InteractiveElement {
  id: number;
  tag: string;
  type: string;
  role: string;
  text: string;
  href: string;
  placeholder: string;
  value: string;
  checked: boolean;
  disabled: boolean;
}

export class BrowserController {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  async launch(): Promise<void> {
    this.browser = await chromium.launch({
      headless: false,
      args: ["--start-maximized", "--disable-blink-features=AutomationControlled"],
    });
    this.context = await this.browser.newContext({
      viewport: { width: 1280, height: 900 },
      locale: "ru-RU",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    });
    this.page = await this.context.newPage();

    // Auto-accept dialogs (alert, confirm, prompt) and log them
    this.page.on("dialog", async (dialog) => {
      console.log(
        `\x1b[33m  [dialog] ${dialog.type()}: ${dialog.message()}\x1b[0m`
      );
      await dialog.accept();
    });

    // Track new tabs
    this.context.on("page", (newPage) => {
      console.log(
        `\x1b[33m  [tab] New tab opened: ${newPage.url()}\x1b[0m`
      );
    });

    await this.page.goto("about:blank");
  }

  private get activePage(): Page {
    if (!this.page) throw new Error("Browser not launched");
    return this.page;
  }

  // ── Navigation ──────────────────────────────────────────────

  async navigate(url: string): Promise<string> {
    const page = this.activePage;
    // Block dangerous protocols
    if (url.startsWith("file://") || url.startsWith("javascript:")) {
      return `Blocked navigation to "${url}" — unsafe protocol.`;
    }
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      url = "https://" + url;
    }
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(1500);
      // Auto-return page state after navigation
      const state = await this.getPageState();
      return `Navigated to ${page.url()}\n\n${state}`;
    } catch (err: any) {
      return `Navigation error: ${err.message}. Current URL: ${page.url()}`;
    }
  }

  async goBack(): Promise<string> {
    const page = this.activePage;
    try {
      await page.goBack({ waitUntil: "domcontentloaded", timeout: 10000 });
      await page.waitForTimeout(1000);
      const state = await this.getPageState();
      return `Went back to ${page.url()}\n\n${state}`;
    } catch (err: any) {
      return `Go back error: ${err.message}`;
    }
  }

  // ── Element interactions ────────────────────────────────────

  async click(elementId: number): Promise<string> {
    const page = this.activePage;
    const selector = `[data-agent-id="${elementId}"]`;
    const urlBefore = page.url();
    const tabsBefore = this.context!.pages().length;

    try {
      const el = await page.$(selector);
      if (!el) {
        return `Element [${elementId}] not found. The page may have changed — call get_page_state for fresh element numbers.`;
      }
      await el.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
      await el.click({ timeout: 5000 });
      await page.waitForTimeout(1500);
    } catch (err: any) {
      return `Click error on [${elementId}]: ${err.message}. Call get_page_state to refresh elements.`;
    }

    const urlAfter = page.url();
    const tabsAfter = this.context!.pages().length;
    let result = `Clicked element [${elementId}]. Current URL: ${urlAfter}`;

    if (tabsAfter > tabsBefore) {
      const newest = this.context!.pages()[tabsAfter - 1];
      result += `\nA new tab was opened: ${newest.url()}. Use switch_tab to access it.`;
    }
    if (urlBefore !== urlAfter) {
      result += "\nPage navigated to a new URL. Call get_page_state to see the new page.";
    }
    return result;
  }

  async hover(elementId: number): Promise<string> {
    const page = this.activePage;
    const selector = `[data-agent-id="${elementId}"]`;
    try {
      const el = await page.$(selector);
      if (!el) {
        return `Element [${elementId}] not found. Call get_page_state to refresh.`;
      }
      await el.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
      await el.hover({ timeout: 5000 });
      await page.waitForTimeout(800);
      return `Hovered over element [${elementId}]. Call get_page_state if new elements appeared.`;
    } catch (err: any) {
      return `Hover error on [${elementId}]: ${err.message}`;
    }
  }

  async typeText(
    elementId: number,
    text: string,
    clearFirst = true
  ): Promise<string> {
    const page = this.activePage;
    const selector = `[data-agent-id="${elementId}"]`;

    try {
      const el = await page.$(selector);
      if (!el) {
        return `Element [${elementId}] not found. Call get_page_state to refresh.`;
      }
      await el.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});

      // Try fill() first (works with input/textarea)
      try {
        if (clearFirst) {
          await page.fill(selector, "");
        }
        await page.fill(selector, text);
        return `Typed "${text}" into element [${elementId}].`;
      } catch {
        // Fallback: click then type via keyboard
        await el.click();
        if (clearFirst) {
          await page.keyboard.press("Control+A");
          await page.keyboard.press("Backspace");
        }
        await page.keyboard.type(text, { delay: 30 });
        return `Typed "${text}" into element [${elementId}] (via keyboard).`;
      }
    } catch (err: any) {
      return `Type error on [${elementId}]: ${err.message}`;
    }
  }

  async pressKey(key: string): Promise<string> {
    const page = this.activePage;
    try {
      await page.keyboard.press(key);
      await page.waitForTimeout(800);
      return `Pressed key: ${key}. Current URL: ${page.url()}`;
    } catch (err: any) {
      return `Key press error: ${err.message}`;
    }
  }

  async selectOption(elementId: number, value: string): Promise<string> {
    const page = this.activePage;
    const selector = `[data-agent-id="${elementId}"]`;
    try {
      // Try by label first, then by value
      try {
        await page.selectOption(selector, { label: value });
      } catch {
        await page.selectOption(selector, value);
      }
      return `Selected "${value}" in element [${elementId}].`;
    } catch (err: any) {
      return `Select error on [${elementId}]: ${err.message}`;
    }
  }

  // ── Scrolling ───────────────────────────────────────────────

  async scroll(direction: string, amount = 600): Promise<string> {
    const page = this.activePage;
    const delta = direction === "down" ? amount : -amount;
    await page.mouse.wheel(0, delta);
    await page.waitForTimeout(600);
    return `Scrolled ${direction} by ${amount}px. Call get_page_state to see updated content.`;
  }

  // ── Screenshots ─────────────────────────────────────────────

  async screenshot(): Promise<string> {
    const page = this.activePage;
    const buffer = await page.screenshot({ type: "png" });
    return buffer.toString("base64");
  }

  // ── Page state extraction ───────────────────────────────────

  async getPageText(): Promise<string> {
    const page = this.activePage;
    const text = await page.evaluate(() => {
      const body = document.body;
      if (!body) return "(empty page)";

      // Clone body to avoid modifying the DOM
      const clone = body.cloneNode(true) as HTMLElement;
      clone
        .querySelectorAll("script, style, noscript, svg, link, meta")
        .forEach((el) => el.remove());

      const raw = clone.innerText || clone.textContent || "";
      const cleaned = raw
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .join("\n");

      if (cleaned.length > 4000) {
        return cleaned.substring(0, 4000) + "\n\n(truncated)";
      }
      return cleaned;
    });
    return text;
  }

  async getInteractiveElements(): Promise<InteractiveElement[]> {
    const page = this.activePage;

    const elements: InteractiveElement[] = await page.evaluate(() => {
      const selectors = [
        "a[href]",
        "button",
        'input:not([type="hidden"])',
        "textarea",
        "select",
        '[role="button"]',
        '[role="link"]',
        '[role="tab"]',
        '[role="menuitem"]',
        '[role="checkbox"]',
        '[role="radio"]',
        '[role="switch"]',
        '[role="combobox"]',
        '[role="searchbox"]',
        '[role="textbox"]',
        '[role="option"]',
        '[contenteditable="true"]',
        "summary",
        "label[for]",
      ];

      const allEls = document.querySelectorAll(selectors.join(", "));
      const results: any[] = [];
      let id = 0;
      const seen = new Set<Element>();

      for (const el of allEls) {
        if (seen.has(el)) continue;
        seen.add(el);

        const htmlEl = el as HTMLElement;

        // Visibility checks
        const rect = htmlEl.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        const style = window.getComputedStyle(htmlEl);
        if (style.display === "none" || style.visibility === "hidden") continue;
        if (parseFloat(style.opacity) === 0) continue;

        // Tag data-agent-id for targeting
        htmlEl.setAttribute("data-agent-id", String(id));

        const tag = htmlEl.tagName.toLowerCase();
        const innerText = (htmlEl.innerText || htmlEl.textContent || "").trim();
        const text = innerText.substring(0, 80);
        const ariaLabel = htmlEl.getAttribute("aria-label") || "";
        const placeholder = (htmlEl as HTMLInputElement).placeholder || "";
        const href = (htmlEl as HTMLAnchorElement).href || "";
        const value =
          (htmlEl as HTMLInputElement).value !== undefined
            ? String((htmlEl as HTMLInputElement).value)
            : "";
        const role = htmlEl.getAttribute("role") || "";
        const name = htmlEl.getAttribute("name") || "";
        const title = htmlEl.getAttribute("title") || "";
        const alt = htmlEl.getAttribute("alt") || "";
        const type = (htmlEl as HTMLInputElement).type || "";

        results.push({
          id,
          tag,
          type,
          role,
          text: text || ariaLabel || placeholder || title || alt || name,
          href: tag === "a" ? href : "",
          placeholder,
          value: ["input", "textarea", "select"].includes(tag)
            ? value.substring(0, 100)
            : "",
          checked: !!(htmlEl as HTMLInputElement).checked,
          disabled: !!(htmlEl as HTMLInputElement).disabled,
        });

        id++;
        if (id >= 200) break; // Limit to prevent overwhelming context
      }

      return results;
    });

    return elements;
  }

  async getPageState(): Promise<string> {
    const page = this.activePage;
    const url = page.url();
    const title = await page.title();

    const [pageText, elements] = await Promise.all([
      this.getPageText(),
      this.getInteractiveElements(),
    ]);

    // Keep page text short to avoid overwhelming local LLMs
    const shortText = pageText.substring(0, 2000);
    let state = `URL: ${url}\nTitle: ${title}\n\nPage text (short): ${shortText}\n\n`;
    state += `=== Interactive Elements (${elements.length}) ===\n`;

    for (const el of elements) {
      let desc = `[${el.id}] <${el.tag}`;
      if (el.type) desc += ` type="${el.type}"`;
      if (el.role) desc += ` role="${el.role}"`;
      desc += ">";
      if (el.text) desc += ` "${el.text}"`;
      if (el.href) {
        // Shorten very long URLs
        const shortHref =
          el.href.length > 80 ? el.href.substring(0, 80) + "..." : el.href;
        desc += ` -> ${shortHref}`;
      }
      if (el.placeholder) desc += ` placeholder="${el.placeholder}"`;
      if (el.value) desc += ` value="${el.value}"`;
      if (el.checked) desc += ` [checked]`;
      if (el.disabled) desc += ` [disabled]`;
      state += desc + "\n";
    }

    if (elements.length === 0) {
      state += "(No interactive elements found on this page)\n";
    }
    if (elements.length >= 200) {
      state +=
        "\n(Element list was truncated at 200. Scroll or navigate to see more.)\n";
    }

    return state;
  }

  // ── Tab management ──────────────────────────────────────────

  async getTabsInfo(): Promise<string> {
    if (!this.context) return "No browser context";
    const pages = this.context.pages();
    let info = `Open tabs (${pages.length}):\n`;
    for (let i = 0; i < pages.length; i++) {
      const marker = pages[i] === this.page ? " [ACTIVE]" : "";
      info += `  [${i}] ${pages[i].url()}${marker}\n`;
    }
    return info;
  }

  async switchTab(index: number): Promise<string> {
    if (!this.context) return "No browser context";
    const pages = this.context.pages();
    if (index < 0 || index >= pages.length) {
      return `Invalid tab index ${index}. Available: 0..${pages.length - 1}`;
    }
    this.page = pages[index];
    await this.page.bringToFront();
    await this.page.waitForTimeout(500);
    const tabsInfo = await this.getTabsInfo();
    return `Switched to tab [${index}]: ${this.page.url()}\n\n${tabsInfo}`;
  }

  // ── Wait ────────────────────────────────────────────────────

  async wait(ms = 2000): Promise<string> {
    const clamped = Math.min(ms, 10000);
    await this.activePage.waitForTimeout(clamped);
    return `Waited ${clamped}ms.`;
  }

  // ── Lifecycle ───────────────────────────────────────────────

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.context = null;
      this.page = null;
    }
  }
}
