import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Browser } from "playwright";
import type { AppConfig, PlaywrightConfig } from "../config.js";
import { imageResult, jsonResult, registerCloser, safe } from "../util.js";

let browser: Browser | undefined;
let launching: Promise<Browser> | undefined;

async function getBrowser(cfg: PlaywrightConfig): Promise<Browser> {
  if (browser?.isConnected()) return browser;
  if (!launching) {
    launching = (async () => {
      let chromium;
      try {
        ({ chromium } = await import("playwright"));
      } catch {
        throw new Error(
          "Playwright is not installed. Run `npm install playwright && npx playwright install chromium` (or use the playwright-enabled Docker image).",
        );
      }
      const b = await chromium.launch({
        headless: true,
        args: cfg.noSandbox ? ["--no-sandbox", "--disable-gpu"] : ["--disable-gpu"],
      });
      browser = b;
      launching = undefined;
      registerCloser("playwright", async () => {
        await browser?.close();
        browser = undefined;
      });
      return b;
    })().catch((err) => {
      launching = undefined;
      throw err;
    });
  }
  return launching;
}

/** Block non-web schemes (file://, chrome://…) and private/loopback/link-local/
 * metadata hosts so an agent (or prompt-injected content) can't turn the browser
 * into an SSRF / local-file-read primitive. Best-effort on IP literals; a public
 * hostname that DNS-resolves to a private IP is not caught here (documented) —
 * an exposed deployment should also apply network egress policy. */
function assertSafeUrl(raw: string): void {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`invalid url: ${raw}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`only http(s) URLs are allowed (got "${u.protocol}")`);
  }
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const blocked =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host === "::1" ||
    host === "::" ||
    host.startsWith("fe80:") ||
    host.startsWith("fc") ||
    host.startsWith("fd") ||
    (() => {
      const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/);
      if (!m) return false;
      const a = Number(m[1]);
      const b = Number(m[2]);
      return (
        a === 0 ||
        a === 127 || // loopback
        a === 10 || // private
        (a === 172 && b >= 16 && b <= 31) || // private
        (a === 192 && b === 168) || // private
        (a === 169 && b === 254) // link-local / cloud metadata
      );
    })();
  if (blocked) {
    throw new Error(`navigation to internal/loopback/link-local address "${host}" is blocked`);
  }
}

async function withPage<T>(cfg: PlaywrightConfig, url: string, timeoutMs: number, fn: (page: import("playwright").Page) => Promise<T>): Promise<T> {
  assertSafeUrl(url);
  const b = await getBrowser(cfg);
  const context = await b.newContext({ viewport: { width: 1280, height: 800 } });
  try {
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    return await fn(page);
  } finally {
    await context.close();
  }
}

export function registerPlaywright(server: McpServer, config: AppConfig): boolean {
  const cfg = config.integrations.playwright;
  if (!cfg) return false;

  server.registerTool(
    "browser_navigate",
    {
      title: "Open URL in headless browser",
      description: "Navigates to a URL and returns the page title, final URL (after redirects) and visible text content.",
      inputSchema: {
        url: z.string().url(),
        timeoutMs: z.number().int().min(1000).max(60_000).optional().describe("Navigation timeout (default 15000)"),
      },
      annotations: { readOnlyHint: true },
    },
    safe("browser_navigate", async ({ url, timeoutMs }) =>
      withPage(cfg, url, timeoutMs ?? 15_000, async (page) => {
        const [title, text] = await Promise.all([
          page.title(),
          page.evaluate(() => document.body?.innerText ?? ""),
        ]);
        return jsonResult({ title, url: page.url(), text: text.slice(0, 20_000) });
      }),
    ),
  );

  server.registerTool(
    "browser_screenshot",
    {
      title: "Screenshot a URL",
      description: "Navigates to a URL and returns a PNG screenshot as an image.",
      inputSchema: {
        url: z.string().url(),
        fullPage: z.boolean().optional().describe("Capture the entire scrollable page"),
        timeoutMs: z.number().int().min(1000).max(60_000).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    safe("browser_screenshot", async ({ url, fullPage, timeoutMs }) =>
      withPage(cfg, url, timeoutMs ?? 15_000, async (page) => {
        await page.waitForTimeout(500);
        const buf = await page.screenshot({ fullPage: fullPage ?? false, type: "png" });
        return imageResult(buf.toString("base64"), "image/png", `Screenshot of ${page.url()}`);
      }),
    ),
  );

  server.registerTool(
    "browser_extract",
    {
      title: "Extract elements from a URL",
      description: "Navigates to a URL and extracts text (or an attribute) from elements matching a CSS selector.",
      inputSchema: {
        url: z.string().url(),
        selector: z.string().describe('CSS selector, e.g. "table.results td" or "h1"'),
        attribute: z.string().optional().describe("Extract this attribute instead of text, e.g. href"),
        timeoutMs: z.number().int().min(1000).max(60_000).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    safe("browser_extract", async ({ url, selector, attribute, timeoutMs }) =>
      withPage(cfg, url, timeoutMs ?? 15_000, async (page) => {
        const values = await page.$$eval(
          selector,
          (els, attr) =>
            els.slice(0, 50).map((el) =>
              attr ? el.getAttribute(attr) : (el as HTMLElement).innerText?.trim() ?? el.textContent?.trim() ?? "",
            ),
          attribute ?? null,
        );
        return jsonResult({ url: page.url(), selector, matches: values.length, values });
      }),
    ),
  );

  return true;
}
