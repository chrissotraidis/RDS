import { chromium, type Page } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { executeScenarioChecks, loadScenarioSummary, writeScenarioVerdict } from "./scenarios";

function arg(name: string, def?: string): string | undefined {
  for (const a of process.argv.slice(2)) {
    if (a.startsWith(`--${name}=`)) return a.slice(name.length + 3);
  }
  return def;
}

const BASE_URL = arg("base-url");
const OUT_DIR = arg("out-dir");
const TIMEOUT = Number(arg("timeout-ms", "12000"));
const SCENARIOS_PATH = arg("scenarios");

if (!BASE_URL || !OUT_DIR) {
  console.error("FATAL: --base-url and --out-dir are required");
  process.exit(2);
}

mkdirSync(OUT_DIR, { recursive: true });

async function visibleText(page: Page): Promise<string> {
  return page.evaluate(() => (document.body?.innerText || "").trim()).catch(() => "");
}

async function viewportIssues(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const issues: string[] = [];
    const doc = document.documentElement;
    if (doc.scrollWidth > doc.clientWidth + 2) issues.push("horizontal overflow");
    const firstViewportText = Array.from(document.querySelectorAll("h1,h2,p,a,button"))
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.top < innerHeight && rect.bottom > 0 && rect.width > 0 && rect.height > 0 && style.visibility !== "hidden";
      })
      .map((el) => (el.textContent || "").trim())
      .filter(Boolean);
    if (firstViewportText.join(" ").length < 80) issues.push("thin first viewport");
    const brokenLayout = Array.from(document.querySelectorAll("a,button,h1,h2,p")).some((el) => {
      const rect = el.getBoundingClientRect();
      return rect.width > doc.clientWidth + 4 || rect.left < -4 || rect.right > doc.clientWidth + 4;
    });
    if (brokenLayout) issues.push("content spills outside viewport");
    return issues;
  });
}

async function clickThrough(page: Page): Promise<{ checked: number; broken: string[] }> {
  const broken: string[] = [];
  const links = page.locator("a[href]").filter({ hasNotText: /^$/ });
  const count = Math.min(8, await links.count().catch(() => 0));
  for (let i = 0; i < count; i += 1) {
    const href = await links.nth(i).getAttribute("href").catch(() => "");
    const label = (await links.nth(i).innerText().catch(() => href || "link")).trim().slice(0, 80);
    if (!href || href === "#" || href.startsWith("javascript:")) {
      broken.push(`${label}: empty/no-op href`);
      continue;
    }
    if (href.startsWith("mailto:") || href.startsWith("tel:") || href.startsWith("http")) continue;
    const response = await page.goto(new URL(href, BASE_URL).toString(), { waitUntil: "domcontentloaded", timeout: TIMEOUT }).catch(() => null);
    if (!response || response.status() >= 400) broken.push(`${label}: ${href} returned ${response?.status() || "no response"}`);
    await page.goto(BASE_URL!, { waitUntil: "domcontentloaded", timeout: TIMEOUT }).catch(() => {});
  }
  return { checked: count, broken };
}

async function run() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const startedAt = new Date().toISOString();
  const response = await page.goto(BASE_URL!, { waitUntil: "domcontentloaded", timeout: TIMEOUT });
  await page.waitForLoadState("networkidle", { timeout: 2500 }).catch(() => {});
  const scenarios = loadScenarioSummary(SCENARIOS_PATH);
  const scenarioVerdict = await executeScenarioChecks(page, BASE_URL!, SCENARIOS_PATH, OUT_DIR!);
  writeScenarioVerdict(OUT_DIR!, scenarioVerdict);
  await page.goto(BASE_URL!, { waitUntil: "domcontentloaded", timeout: TIMEOUT }).catch(() => {});
  await page.screenshot({ path: join(OUT_DIR!, "website-desktop.png"), fullPage: true }).catch(() => {});
  const desktopIssues = await viewportIssues(page);
  const text = await visibleText(page);
  const h1Count = await page.locator("h1").count().catch(() => 0);
  const ctaCount = await page.locator("a,button").filter({ hasText: /get started|start|try|contact|book|learn|view|open|sign up|download/i }).count().catch(() => 0);
  const links = await clickThrough(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(BASE_URL!, { waitUntil: "domcontentloaded", timeout: TIMEOUT });
  await page.screenshot({ path: join(OUT_DIR!, "website-mobile.png"), fullPage: true }).catch(() => {});
  const mobileIssues = await viewportIssues(page);
  await context.close();
  await browser.close();

  const criteria = [
    { name: "page_loads", ok: (response?.status() || 0) < 400, evidence: `HTTP ${response?.status() || 0}` },
    { name: "clear_first_screen", ok: text.length >= 160 && h1Count >= 1, evidence: `${text.length} visible chars, ${h1Count} h1` },
    { name: "primary_cta_or_navigation", ok: ctaCount >= 1 || links.checked >= 2, evidence: `${ctaCount} CTA-like controls, ${links.checked} links checked` },
    { name: "links_work", ok: links.broken.length === 0, evidence: links.broken.slice(0, 5).join(" | ") || "sampled links ok" },
    { name: "desktop_layout", ok: desktopIssues.length === 0, evidence: desktopIssues.join(", ") || "desktop layout ok" },
    { name: "mobile_layout", ok: mobileIssues.length === 0, evidence: mobileIssues.join(", ") || "mobile layout ok" },
    { name: "prd_scenarios_available", ok: scenarios.available && scenarios.count >= 3, evidence: scenarios.available ? `${scenarios.count} QA scenarios loaded` : "qa-scenarios.json missing" },
    { name: "prd_scenarios_executed", ok: scenarioVerdict.status === "pass", evidence: scenarioVerdict.status === "pass" ? `${scenarioVerdict.scenarioCount} scenario journeys passed` : `${scenarioVerdict.blockingFailures} blocking scenario failures` },
  ];
  const score = Math.round(criteria.filter((c) => c.ok).length / criteria.length * 100);
  const failed = criteria.filter((c) => !c.ok);
  const status = failed.length === 0 ? "pass" : score >= 50 ? "needs_iteration" : "fail";
  const payload = { schema: "rds.qa.website-uat.v1", status, score, threshold: 100, baseUrl: BASE_URL, startedAt, finishedAt: new Date().toISOString(), criteria, scenarios, scenarioVerdict, failedRequiredCriteria: failed, screenshots: ["website-desktop.png", "website-mobile.png", "scenario-verdict.json"] };
  writeFileSync(join(OUT_DIR!, "website-verdict.json"), JSON.stringify(payload, null, 2));
  console.log(JSON.stringify({ status, score, path: join(OUT_DIR!, "website-verdict.json") }));
  process.exit(status === "pass" ? 0 : 1);
}

run().catch((err) => {
  console.error("[website-uat] FATAL:", err);
  process.exit(2);
});
