import { chromium, type Page } from "playwright";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";

function arg(name: string, def?: string): string | undefined {
  for (const a of process.argv.slice(2)) {
    if (a.startsWith(`--${name}=`)) return a.slice(name.length + 3);
  }
  return def;
}

const BASE_URL = arg("base-url");
const OUT_DIR = arg("out-dir");
const SOURCE_DIR = arg("source-dir");
const TIMEOUT = Number(arg("timeout-ms", "12000"));

if (!BASE_URL || !OUT_DIR) {
  console.error("FATAL: --base-url and --out-dir are required");
  process.exit(2);
}

mkdirSync(OUT_DIR, { recursive: true });

type SourceFinding = {
  path: string;
  category: "seeded_data" | "fake_costs" | "stubbed_integration" | "placeholder_workflow";
  evidence: string;
};

type RouteText = {
  url: string;
  title: string;
  text: string;
};

const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
  ".html",
  ".css",
]);

const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "dist", "build", "coverage", ".turbo", "tmp", "log"]);

function scanFiles(dir: string, root = dir, limit = { files: 0 }): SourceFinding[] {
  if (!existsSync(dir) || limit.files > 900) return [];
  const findings: SourceFinding[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(".") && ![".env", ".well-known"].includes(entry)) continue;
    const path = join(dir, entry);
    let stats;
    try {
      stats = statSync(path);
    } catch {
      continue;
    }
    if (stats.isDirectory()) {
      if (!SKIP_DIRS.has(entry)) findings.push(...scanFiles(path, root, limit));
      continue;
    }
    if (!stats.isFile() || stats.size > 700_000 || !SOURCE_EXTENSIONS.has(extname(entry))) continue;
    limit.files += 1;
    const rel = path.slice(root.length + 1);
    const text = readFileSync(path, "utf8").slice(0, 700_000);
    const lower = text.toLowerCase();
    const hasSeedLanguage = /\b(seed(?:ed)?|fallback|mock|demo|sample|fixture|placeholder|hard[- ]?coded|local review|test data)\b/i.test(text);
    const hasCostLanguage = /\b(spend|cost|budget|revenue|payment|invoice|stripe|credits?|dollars?|usd)\b/i.test(text) || /\$[0-9][0-9,]*(?:\.[0-9]{2})?/.test(text);
    const hasIntegrationLanguage = /\b(api key|provider|openrouter|stripe|notion|gmail|webhook|integration|ingest|source|rag|database_url|external)\b/i.test(text);
    const hasWorkflowLanguage = /\b(todo|stub|not implemented|coming soon|wire up|replace with|simulate|fake)\b/i.test(text);
    if (hasSeedLanguage && hasCostLanguage) {
      findings.push({ path: rel, category: "fake_costs", evidence: excerpt(text, /(seed(?:ed)?|fallback|mock|demo|sample|fixture|placeholder|hard[- ]?coded|test data|spend|cost|budget|revenue|\$[0-9])/i) });
    }
    if (hasSeedLanguage && /\b(order|customer|operator|job|video|source|event|activity|task|database)\b/i.test(text)) {
      findings.push({ path: rel, category: "seeded_data", evidence: excerpt(text, /(seed(?:ed)?|fallback|mock|demo|sample|fixture|placeholder|test data)/i) });
    }
    if ((hasSeedLanguage || hasWorkflowLanguage) && hasIntegrationLanguage) {
      findings.push({ path: rel, category: "stubbed_integration", evidence: excerpt(text, /(api key|provider|stripe|webhook|integration|ingest|source|rag|simulate|fake|stub|not implemented)/i) });
    }
    if (hasWorkflowLanguage && /\b(click|button|link|route|dashboard|settings|operator|workflow|console)\b/i.test(text)) {
      findings.push({ path: rel, category: "placeholder_workflow", evidence: excerpt(text, /(todo|stub|not implemented|coming soon|wire up|replace with|simulate|fake)/i) });
    }
  }
  return findings.slice(0, 80);
}

function excerpt(text: string, pattern: RegExp): string {
  const match = pattern.exec(text);
  const index = match?.index ?? 0;
  return text.slice(Math.max(0, index - 80), Math.min(text.length, index + 180)).replace(/\s+/g, " ").trim();
}

async function collectLinks(page: Page, origin: string): Promise<string[]> {
  return page.evaluate((origin) => {
    const links = new Set<string>();
    for (const el of Array.from(document.querySelectorAll("a[href]"))) {
      const raw = el.getAttribute("href") || "";
      if (!raw || raw === "#" || raw.startsWith("mailto:") || raw.startsWith("tel:") || raw.startsWith("javascript:")) continue;
      try {
        const url = new URL(raw, location.href);
        url.hash = "";
        if (url.origin === origin) links.add(url.href);
      } catch {}
    }
    return Array.from(links).slice(0, 24);
  }, origin).catch(() => []);
}

async function crawlVisibleText(page: Page): Promise<RouteText[]> {
  const origin = new URL(BASE_URL!).origin;
  const queue = [BASE_URL!];
  const seen = new Set<string>();
  const routes: RouteText[] = [];
  while (queue.length && routes.length < 18) {
    const url = queue.shift();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: TIMEOUT }).catch(() => null);
    await page.waitForLoadState("networkidle", { timeout: 1800 }).catch(() => {});
    const title = await page.title().catch(() => "");
    const text = await page.evaluate(() => (document.body?.innerText || "").replace(/\s+/g, " ").trim()).catch(() => "");
    routes.push({ url: page.url(), title, text });
    for (const link of await collectLinks(page, origin)) {
      if (!seen.has(link) && !queue.includes(link)) queue.push(link);
    }
  }
  return routes;
}

function containsDisclosure(text: string, topic: "data" | "cost" | "integration" | "workflow"): boolean {
  const lower = text.toLowerCase();
  const truthWords = /\b(seed(?:ed)?|sample|demo|mock|test|placeholder|fallback|stub(?:bed)?|not yet connected|not connected|simulated|local review|review mode)\b/;
  if (!truthWords.test(lower)) return false;
  if (topic === "cost") return /\b(spend|cost|budget|revenue|payment|invoice|usd|\$|billing)\b/.test(lower);
  if (topic === "integration") return /\b(sources?|providers?|integrations?|api|webhooks?|ingest(?:ion)?|stripe|openrouter|databases?|rag|connected)\b/.test(lower);
  if (topic === "workflow") return /\b(workflow|button|link|route|feature|action|operator|console|coming soon|not implemented)\b/.test(lower);
  return /\b(data|record|order|customer|job|task|activity|source)\b/.test(lower);
}

function visibleCurrencyConcern(routes: RouteText[]): string[] {
  const concerns: string[] = [];
  for (const route of routes) {
    const matches = route.text.match(/\$[0-9][0-9,]*(?:\.[0-9]{2})?/g) || [];
    const large = matches.filter((value) => Number(value.replace(/[$,]/g, "")) >= 100);
    if (large.length && !containsDisclosure(route.text, "cost")) {
      concerns.push(`${route.url}: visible operational currency ${large.slice(0, 4).join(", ")} has no sample/demo disclosure`);
    }
  }
  return concerns;
}

function hasReviewReadinessSurface(text: string): boolean {
  const lower = text.toLowerCase();
  if (!/\b(review mode|review build|not production-ready|not production ready|production readiness|what works)\b/.test(lower)) {
    return false;
  }
  const signals = [
    /\bwhat works|working review|working surfaces\b/,
    /\bseeded|sample|demo|fallback\b/,
    /\bstubbed|not connected|simulated|placeholder\b/,
    /\bmissing|still required|required|unfinished|not production\b/,
  ];
  return signals.filter((pattern) => pattern.test(lower)).length >= 3;
}

async function run() {
  const sourceFindings = SOURCE_DIR ? scanFiles(SOURCE_DIR) : [];
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const routes = await crawlVisibleText(page);
  await context.close();
  await browser.close();

  const allText = routes.map((route) => route.text).join("\n").slice(0, 200_000);
  const sourceCategories = new Set(sourceFindings.map((finding) => finding.category));
  const currencyConcerns = visibleCurrencyConcern(routes);
  const needsReadinessSurface = sourceCategories.size > 0 || currencyConcerns.length > 0;
  const criteria = [
    {
      name: "review_readiness_surface_disclosed",
      ok: !needsReadinessSurface || hasReviewReadinessSurface(allText),
      evidence: needsReadinessSurface ? (hasReviewReadinessSurface(allText) ? "app-visible review readiness surface is present" : "review build has seeded/stubbed/fake signals but no app-visible what-works/seeded/stubbed/missing surface") : "no seeded/stubbed/fake signals require a readiness surface",
    },
    {
      name: "seeded_data_disclosed",
      ok: !sourceCategories.has("seeded_data") || containsDisclosure(allText, "data"),
      evidence: sourceCategories.has("seeded_data") ? (containsDisclosure(allText, "data") ? "seed/sample data disclosure is visible" : "source uses seeded/sample data but UI does not disclose it") : "no seeded data signals found",
    },
    {
      name: "fake_costs_disclosed",
      ok: !sourceCategories.has("fake_costs") || containsDisclosure(allText, "cost"),
      evidence: sourceCategories.has("fake_costs") ? (containsDisclosure(allText, "cost") ? "fake/sample cost disclosure is visible" : "source uses fake/sample costs but UI does not disclose it") : "no fake cost signals found",
    },
    {
      name: "visible_money_is_contextualized",
      ok: currencyConcerns.length === 0,
      evidence: currencyConcerns.slice(0, 5).join(" | ") || "visible currency values are absent or disclosed as sample/demo",
    },
    {
      name: "stubbed_integrations_disclosed",
      ok: !sourceCategories.has("stubbed_integration") || containsDisclosure(allText, "integration"),
      evidence: sourceCategories.has("stubbed_integration") ? (containsDisclosure(allText, "integration") ? "stubbed/not-connected integration disclosure is visible" : "source has stubbed integrations but UI does not disclose it") : "no stubbed integration signals found",
    },
    {
      name: "placeholder_workflows_disclosed",
      ok: !sourceCategories.has("placeholder_workflow") || containsDisclosure(allText, "workflow"),
      evidence: sourceCategories.has("placeholder_workflow") ? (containsDisclosure(allText, "workflow") ? "unfinished workflow disclosure is visible" : "source has placeholder workflow code but UI does not disclose it") : "no placeholder workflow signals found",
    },
  ];
  const failed = criteria.filter((criterion) => !criterion.ok);
  const score = Math.round(criteria.filter((criterion) => criterion.ok).length / criteria.length * 100);
  const status = failed.length === 0 ? "pass" : score >= 60 ? "needs_iteration" : "fail";
  const payload = {
    schema: "rds.qa.truthfulness-audit.v1",
    status,
    score,
    threshold: 100,
    baseUrl: BASE_URL,
    sourceDir: SOURCE_DIR || null,
    routesVisited: routes.length,
    criteria,
    failedRequiredCriteria: failed,
    sourceFindings: sourceFindings.slice(0, 30),
    routeSamples: routes.map((route) => ({ url: route.url, title: route.title, textSample: route.text.slice(0, 600) })),
  };
  writeFileSync(join(OUT_DIR!, "truthfulness-verdict.json"), JSON.stringify(payload, null, 2));
  console.log(JSON.stringify({ status, score, path: join(OUT_DIR!, "truthfulness-verdict.json") }));
  process.exit(status === "pass" ? 0 : 1);
}

run().catch((err) => {
  console.error("[truthfulness-audit] FATAL:", err);
  process.exit(2);
});
