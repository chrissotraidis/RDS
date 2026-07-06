import { chromium, type Page } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function arg(name: string, def?: string): string | undefined {
  for (const a of process.argv.slice(2)) {
    if (a.startsWith(`--${name}=`)) return a.slice(name.length + 3);
  }
  return def;
}

const BASE_URL = arg("base-url");
const OUT_DIR = arg("out-dir");
const TIMEOUT = Number(arg("timeout-ms", "12000"));

if (!BASE_URL || !OUT_DIR) {
  console.error("FATAL: --base-url and --out-dir are required");
  process.exit(2);
}

mkdirSync(OUT_DIR, { recursive: true });

type Issue = {
  severity: "blocker" | "warn";
  kind: string;
  viewport: string;
  selector: string;
  observed: string;
  fixHint: string;
};

async function auditViewport(page: Page, viewport: string, width: number, height: number): Promise<Issue[]> {
  await page.setViewportSize({ width, height });
  await page.goto(BASE_URL!, { waitUntil: "domcontentloaded", timeout: TIMEOUT });
  await page.waitForLoadState("networkidle", { timeout: 2500 }).catch(() => {});
  await page.screenshot({ path: join(OUT_DIR!, `visual-${viewport}.png`), fullPage: true }).catch(() => {});

  return page.evaluate((viewportName) => {
    const issues: Issue[] = [];
    const selectorFor = (el: Element): string => {
      if (el.id) return `${el.tagName.toLowerCase()}#${el.id}`;
      const testId = el.getAttribute("data-testid");
      if (testId) return `${el.tagName.toLowerCase()}[data-testid="${testId}"]`;
      const text = (el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 32);
      return `${el.tagName.toLowerCase()}${text ? ` "${text}"` : ""}`;
    };
    const isVisible = (el: Element): boolean => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const doc = document.documentElement;
    if (doc.scrollWidth > doc.clientWidth + 2) {
      issues.push({
        severity: "blocker",
        kind: "horizontal_overflow",
        viewport: viewportName,
        selector: "document",
        observed: `scrollWidth ${doc.scrollWidth}px exceeds viewport ${doc.clientWidth}px`,
        fixHint: "Constrain grids/canvases/panels to the viewport and remove horizontal scrolling.",
      });
    }

    const interactive = Array.from(document.querySelectorAll("button, a, input, select, textarea, [role=button], [role=link]"))
      .filter(isVisible)
      .map((el) => ({ el, rect: el.getBoundingClientRect(), selector: selectorFor(el) }));

    for (const item of interactive) {
      const el = item.el as HTMLElement;
      if (item.rect.width < 32 || item.rect.height < 32) {
        issues.push({
          severity: "warn",
          kind: "tiny_target",
          viewport: viewportName,
          selector: item.selector,
          observed: `interactive target is ${Math.round(item.rect.width)}x${Math.round(item.rect.height)}px`,
          fixHint: "Make tappable controls at least 32px in each dimension, preferably 40px+.",
        });
      }
      if (el.scrollWidth > el.clientWidth + 2 || el.scrollHeight > el.clientHeight + 2) {
        issues.push({
          severity: "blocker",
          kind: "clipped_control_text",
          viewport: viewportName,
          selector: item.selector,
          observed: `content ${el.scrollWidth}x${el.scrollHeight}px exceeds box ${el.clientWidth}x${el.clientHeight}px`,
          fixHint: "Let control text wrap, widen the control, or reduce the label length.",
        });
      }
    }

    for (let i = 0; i < interactive.length; i += 1) {
      for (let j = i + 1; j < interactive.length; j += 1) {
        const a = interactive[i];
        const b = interactive[j];
        if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
        const x = Math.max(0, Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left));
        const y = Math.max(0, Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top));
        const overlap = x * y;
        const minArea = Math.min(a.rect.width * a.rect.height, b.rect.width * b.rect.height);
        if (overlap > 48 && overlap / Math.max(1, minArea) > 0.2) {
          issues.push({
            severity: "blocker",
            kind: "overlapping_controls",
            viewport: viewportName,
            selector: `${a.selector} / ${b.selector}`,
            observed: `visible controls overlap by ${Math.round(overlap)}px²`,
            fixHint: "Fix layout spacing/z-index so controls do not cover each other.",
          });
        }
      }
    }

    const canvases = Array.from(document.querySelectorAll("canvas")).filter(isVisible) as HTMLCanvasElement[];
    for (const canvas of canvases) {
      try {
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) continue;
        const sample = ctx.getImageData(0, 0, Math.min(canvas.width, 240), Math.min(canvas.height, 160)).data;
        let nonBlank = 0;
        for (let i = 0; i < sample.length; i += 4) {
          if (sample[i] + sample[i + 1] + sample[i + 2] > 24 && sample[i + 3] > 0) nonBlank += 1;
        }
        if (nonBlank / Math.max(1, sample.length / 4) < 0.02) {
          issues.push({
            severity: "blocker",
            kind: "blank_canvas",
            viewport: viewportName,
            selector: selectorFor(canvas),
            observed: "canvas pixel sample is effectively blank",
            fixHint: "Render visible game/content pixels before claiming the preview is playable.",
          });
        }
      } catch {
      }
    }

    return issues;
  }, viewport);
}

async function run() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const startedAt = new Date().toISOString();
  const issues = [
    ...(await auditViewport(page, "desktop", 1280, 800)),
    ...(await auditViewport(page, "mobile", 390, 844)),
  ];
  await context.close();
  await browser.close();

  const blockers = issues.filter((issue) => issue.severity === "blocker");
  const status = blockers.length === 0 ? "pass" : "needs_iteration";
  const payload = {
    schema: "rds.qa.visual-audit.v1",
    status,
    threshold: "zero blocker visual/layout issues",
    baseUrl: BASE_URL,
    startedAt,
    finishedAt: new Date().toISOString(),
    blockerCount: blockers.length,
    warningCount: issues.length - blockers.length,
    issues,
    screenshots: ["visual-desktop.png", "visual-mobile.png"],
  };
  writeFileSync(join(OUT_DIR!, "visual-verdict.json"), JSON.stringify(payload, null, 2));
  console.log(JSON.stringify({ status, blockerCount: blockers.length, warningCount: issues.length - blockers.length, path: join(OUT_DIR!, "visual-verdict.json") }));
  process.exit(status === "pass" ? 0 : 1);
}

run().catch((err) => {
  console.error("[visual-audit] FATAL:", err);
  process.exit(2);
});
