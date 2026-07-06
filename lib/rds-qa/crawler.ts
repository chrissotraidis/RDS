// lib/rds-qa/crawler.ts
//
// Playwright-driven BFS crawler for the RDS post-build QA stage (TD-025).
// Walks a deployed app starting from "/", records every clickable element
// it finds, and emits a JSON nav-graph + a flat gap list.
//
// v0 scope:
//   - No persona auth — crawls as anonymous (the gate-keeping for
//     persona-aware login lands when manifest.personas[] is wired in).
//   - BFS to depth 2 over same-origin links by default.
//   - Captures dead anchors, console errors, 4xx/5xx responses, and
//     buttons with no observable side-effect.
//   - Writes screenshots for every visited URL + a summary.json.
//
// Usage:
//   bun run lib/rds-qa/crawler.ts \
//     --base-url=http://localhost:3001 \
//     --out-dir=builds/<id>/playwright/iter-001 \
//     [--max-pages=20] [--depth=2] [--timeout-ms=10000]

import { chromium, type Browser, type Page, type ConsoleMessage, type Response as PWResponse } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface ElementObservation {
  selector: string;
  text: string;
  kind: "a" | "button" | "form" | "input_submit" | "other";
  href?: string;
  outcome:
    | "url_change"
    | "no_op"
    | "external"
    | "dead_anchor"
    | "console_error"
    | "http_4xx"
    | "http_5xx"
    | "skipped";
  outcomeDetail?: string;
}

interface PageObservation {
  url: string;
  title: string;
  status: number;
  consoleErrors: string[];
  networkErrors: { url: string; status: number }[];
  elements: ElementObservation[];
  visitedAt: string;
  screenshot?: string;
  mobileScreenshot?: string;
}

interface Gap {
  kind:
    | "dead_anchor"
    | "missing_destination"
    | "console_error"
    | "http_4xx"
    | "http_5xx"
    | "no_op_button";
  url: string;
  selector: string;
  observed: string;
  fixHint: string;
}

interface CrawlSummary {
  baseUrl: string;
  startedAt: string;
  finishedAt: string;
  pagesVisited: number;
  totalElements: number;
  gapsFound: number;
  durationMs: number;
  converged: boolean;
  pages: PageObservation[];
  gaps: Gap[];
}

// ---------- arg parsing ------------------------------------------------------

function arg(name: string, def?: string): string | undefined {
  for (const a of process.argv.slice(2)) {
    if (a.startsWith(`--${name}=`)) return a.slice(name.length + 3);
  }
  return def;
}

const BASE_URL = arg("base-url");
const OUT_DIR  = arg("out-dir");
const MAX_PAGES = Number(arg("max-pages", "20"));
const DEPTH    = Number(arg("depth", "2"));
const TIMEOUT  = Number(arg("timeout-ms", "10000"));

if (!BASE_URL || !OUT_DIR) {
  console.error("FATAL: --base-url and --out-dir are required");
  process.exit(2);
}

mkdirSync(OUT_DIR, { recursive: true });

// ---------- helpers ----------------------------------------------------------

function originOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "";
  }
}

function normalizeUrl(href: string, base: string): string | null {
  try {
    const u = new URL(href, base);
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

function safeFilename(url: string): string {
  return url.replace(/[^a-z0-9]+/gi, "_").slice(0, 80);
}

async function pageSignature(page: Page): Promise<string> {
  return page.evaluate(() => {
    const bodyText = document.body?.innerText || "";
    const bodyHtml = document.body?.innerHTML || "";
    const canvasData = Array.from(document.querySelectorAll("canvas"))
      .slice(0, 3)
      .map((canvas) => {
        try {
          return (canvas as HTMLCanvasElement).toDataURL("image/png").slice(0, 256);
        } catch {
          return "";
        }
      })
      .join("|");
    return `${location.href}\n${bodyText}\n${bodyHtml.length}\n${canvasData}`;
  });
}

// ---------- main loop --------------------------------------------------------

async function crawl(): Promise<CrawlSummary> {
  const browser: Browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    ignoreHTTPSErrors: true,
  });
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  const baseOrigin = originOf(BASE_URL!);

  const queue: { url: string; depth: number }[] = [{ url: BASE_URL!, depth: 0 }];
  const visited = new Set<string>();
  const pages: PageObservation[] = [];
  const gaps: Gap[] = [];

  while (queue.length > 0 && pages.length < MAX_PAGES) {
    const { url, depth } = queue.shift()!;
    if (visited.has(url)) continue;
    visited.add(url);

    const page: Page = await context.newPage();
    const consoleErrors: string[] = [];
    const networkErrors: { url: string; status: number }[] = [];

    page.on("console", (msg: ConsoleMessage) => {
      if (msg.type() === "error") consoleErrors.push(msg.text().slice(0, 500));
    });
    page.on("response", (resp: PWResponse) => {
      const s = resp.status();
      if (s >= 400 && resp.url().startsWith(baseOrigin)) {
        networkErrors.push({ url: resp.url(), status: s });
      }
    });

    let status = 0;
    try {
      const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: TIMEOUT });
      status = resp?.status() ?? 0;
    } catch (err) {
      console.error(`[crawler] failed to load ${url}: ${(err as Error).message}`);
      pages.push({
        url,
        title: "<load-failed>",
        status: 0,
        consoleErrors: [(err as Error).message],
        networkErrors: [],
        elements: [],
        visitedAt: new Date().toISOString(),
      });
      gaps.push({
        kind: "http_5xx",
        url,
        selector: "<page>",
        observed: `load failed: ${(err as Error).message}`,
        fixHint: "Confirm the deployed URL is reachable and Rails boots cleanly.",
      });
      await page.close();
      continue;
    }

    // Best-effort settle
    await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});

    const title = await page.title().catch(() => "");
    const screenshot = `screen-${safeFilename(url)}.png`;
    await page.screenshot({ path: join(OUT_DIR!, screenshot), fullPage: true }).catch(() => {});

    // Collect element snapshot in the page context.
    const elements = await page.evaluate(() => {
      const list: any[] = [];
      const seen = new Set<string>();
      const cssEscape = (value: string): string => {
        if (window.CSS?.escape) return window.CSS.escape(value);
        return value.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
      };
      const cssPath = (el: Element): string => {
        const parts: string[] = [];
        let node: Element | null = el;
        while (node && node !== document.body && parts.length < 6) {
          let part = node.tagName.toLowerCase();
          if (node.id) { part += `#${cssEscape(node.id)}`; parts.unshift(part); break; }
          if (node.classList.length) {
            part += "." + Array.from(node.classList).slice(0, 2).map(cssEscape).join(".");
          }
          parts.unshift(part);
          node = node.parentElement;
        }
        return parts.join(" > ");
      };
      const sample = (root: ParentNode, sel: string) => {
        root.querySelectorAll(sel).forEach((el: Element) => {
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          const input = el as HTMLInputElement | HTMLButtonElement;
          if (
            input.disabled ||
            el.hasAttribute("hidden") ||
            el.getAttribute("aria-hidden") === "true" ||
            style.display === "none" ||
            style.visibility === "hidden" ||
            rect.width === 0 ||
            rect.height === 0
          ) {
            return;
          }
          const path = cssPath(el);
          if (seen.has(path)) return;
          seen.add(path);
          const tag = el.tagName.toLowerCase();
          const text = (el.textContent || "").trim().slice(0, 80);
          const href = el.getAttribute("href") || undefined;
          const hasHandler =
            !!el.getAttribute("data-action") ||
            !!el.getAttribute("data-controller") ||
            !!el.getAttribute("formaction") ||
            !!el.getAttribute("onclick") ||
            tag === "a" && !!href && href !== "#" && !href.startsWith("javascript:");
          list.push({ selector: path, tag, text, href, hasHandler });
        });
      };
      sample(document, "a, button, input[type=submit], [role=button]");
      return list;
    }).catch(() => [] as any[]);

    // Classify each element + queue same-origin links for further crawl.
    const observations: ElementObservation[] = [];
    for (const el of elements) {
      let kind: ElementObservation["kind"] = "other";
      if (el.tag === "a") kind = "a";
      else if (el.tag === "button") kind = "button";
      else if (el.tag === "input") kind = "input_submit";

      let outcome: ElementObservation["outcome"] = "skipped";
      let detail: string | undefined;

      if (kind === "a") {
        const h = (el.href || "").trim();
        if (!h || h === "#" || h.toLowerCase().startsWith("javascript:")) {
          outcome = "dead_anchor";
          gaps.push({
            kind: "dead_anchor",
            url,
            selector: el.selector,
            observed: `<a href="${h || ""}"> "${el.text}"`,
            fixHint: "Either remove the dead anchor from the layout/partial or wire it to a real route.",
          });
        } else {
          const abs = normalizeUrl(h, url);
          if (!abs) {
            outcome = "skipped";
          } else if (!abs.startsWith(baseOrigin)) {
            outcome = "external";
          } else {
            outcome = "url_change";
            detail = abs;
            if (depth < DEPTH && !visited.has(abs)) {
              queue.push({ url: abs, depth: depth + 1 });
            }
          }
        }
      } else if (kind === "button" || kind === "input_submit") {
        const beforeUrl = page.url();
        const beforeSignature = await pageSignature(page).catch(() => "");
        let clickChangedPage = false;
        let clickError = "";
        try {
          await page.locator(el.selector).first().click({ timeout: 1500 });
          await page.waitForLoadState("networkidle", { timeout: 1500 }).catch(() => {});
          await page.waitForTimeout(500);
          const afterSignature = await pageSignature(page).catch(() => "");
          clickChangedPage = page.url() !== beforeUrl || (!!afterSignature && afterSignature !== beforeSignature);
        } catch (err) {
          clickError = (err as Error).message.slice(0, 300);
        }

        if (clickChangedPage) {
          outcome = page.url() !== beforeUrl ? "url_change" : "skipped";
          detail = page.url() !== beforeUrl ? page.url() : "click changed page state";
          if (page.url() !== beforeUrl) {
            await page.goto(url, { waitUntil: "domcontentloaded", timeout: TIMEOUT }).catch(() => {});
            await page.waitForLoadState("networkidle", { timeout: 1500 }).catch(() => {});
          }
        } else {
          outcome = "no_op";
          gaps.push({
            kind: "no_op_button",
            url,
            selector: el.selector,
            observed: `<${el.tag}> "${el.text}" produced no observable URL, DOM, or canvas change${clickError ? ` (${clickError})` : ""}`,
            fixHint: "Wire the button to a real interaction or remove it from the rendered layout.",
          });
        }
      }

      observations.push({
        selector: el.selector,
        text: el.text,
        kind,
        href: el.href,
        outcome,
        outcomeDetail: detail,
      });
    }

    if (status >= 400 && status < 500) {
      gaps.push({
        kind: "http_4xx",
        url,
        selector: "<page>",
        observed: `HTTP ${status}`,
        fixHint: "Route or auth guard is rejecting the page; confirm the route exists for anonymous traffic or wire a dev-login.",
      });
    } else if (status >= 500) {
      gaps.push({
        kind: "http_5xx",
        url,
        selector: "<page>",
        observed: `HTTP ${status}`,
        fixHint: "Server error on page load — read Rails server log for the trace.",
      });
    }

    for (const ce of consoleErrors) {
      gaps.push({
        kind: "console_error",
        url,
        selector: "<window>",
        observed: ce,
        fixHint: "Resolve the JS error — usually a missing asset, broken Stimulus controller, or import error.",
      });
    }
    for (const ne of networkErrors) {
      gaps.push({
        kind: ne.status >= 500 ? "http_5xx" : "http_4xx",
        url,
        selector: ne.url,
        observed: `${ne.status} ${ne.url}`,
        fixHint: "Same-origin asset/XHR returned an error — check route + asset pipeline.",
      });
    }

    const mobileScreenshot = `screen-mobile-${safeFilename(url)}.png`;
    await page.setViewportSize({ width: 390, height: 844 }).catch(() => {});
    await page.waitForTimeout(300).catch(() => {});
    await page.screenshot({ path: join(OUT_DIR!, mobileScreenshot), fullPage: true }).catch(() => {});

    pages.push({
      url,
      title,
      status,
      consoleErrors,
      networkErrors,
      elements: observations,
      visitedAt: new Date().toISOString(),
      screenshot,
      mobileScreenshot,
    });

    await page.close();
  }

  await context.close();
  await browser.close();

  const finishedAt = new Date().toISOString();
  const summary: CrawlSummary = {
    baseUrl: BASE_URL!,
    startedAt,
    finishedAt,
    pagesVisited: pages.length,
    totalElements: pages.reduce((n, p) => n + p.elements.length, 0),
    gapsFound: gaps.length,
    durationMs: Date.now() - startMs,
    converged: gaps.length === 0,
    pages,
    gaps,
  };

  return summary;
}

crawl().then((summary) => {
  writeFileSync(join(OUT_DIR!, "summary.json"), JSON.stringify(summary, null, 2));
  writeFileSync(join(OUT_DIR!, "gaps.json"), JSON.stringify(summary.gaps, null, 2));
  console.log(JSON.stringify({
    pagesVisited: summary.pagesVisited,
    gapsFound: summary.gapsFound,
    converged: summary.converged,
    durationMs: summary.durationMs,
  }, null, 2));
  process.exit(summary.converged ? 0 : 1);
}).catch((err) => {
  console.error("[crawler] FATAL:", err);
  process.exit(2);
});
