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

type Credentials = { email?: string; password?: string };
type Visit = { url: string; finalUrl: string; status: number; redirectedToLogin: boolean; textSample: string };
type ControlInteraction = {
  persona: "operator";
  route: string;
  label: string;
  tag: string;
  href: string | null;
  outcome: "changed" | "unchanged" | "broken";
  detail?: string;
};

const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "dist", "build", "coverage", ".turbo", "tmp", "log"]);
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".json", ".md", ".html"]);

function sourceTexts(dir: string, limit = { files: 0 }): { path: string; text: string }[] {
  if (!existsSync(dir) || limit.files > 600) return [];
  const out: { path: string; text: string }[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(".") && entry !== ".env") continue;
    const path = join(dir, entry);
    let stats;
    try {
      stats = statSync(path);
    } catch {
      continue;
    }
    if (stats.isDirectory()) {
      if (!SKIP_DIRS.has(entry)) out.push(...sourceTexts(path, limit));
      continue;
    }
    if (!stats.isFile() || stats.size > 500_000 || !SOURCE_EXTENSIONS.has(extname(entry))) continue;
    limit.files += 1;
    out.push({ path, text: readFileSync(path, "utf8").slice(0, 500_000) });
  }
  return out;
}

function extractCredentials(texts: { text: string }[]): Credentials {
  const joined = texts.map((item) => item.text).join("\n").slice(0, 2_000_000);
  const email =
    /Email:\s*`([^`@\s]+@[^`\s]+)`/i.exec(joined)?.[1] ||
    /operatorEmail\s*=\s*["']([^"']+@[^"']+)["']/i.exec(joined)?.[1] ||
    /(?:email|operator_email)["']?\s*[:=]\s*["']([^"']+@[^"']+)["']/i.exec(joined)?.[1];
  const password =
    /Password:\s*`([^`\s]+)`/i.exec(joined)?.[1] ||
    /defaultOperatorPassword\s*=\s*["']([^"']+)["']/i.exec(joined)?.[1] ||
    /(?:password|operator_password)["']?\s*[:=]\s*["']([^"']{6,})["']/i.exec(joined)?.[1];
  return { email, password };
}

function authSignals(texts: { text: string }[]): { hasAuth: boolean; routes: string[]; evidence: string[] } {
  const joined = texts.map((item) => item.text).join("\n").slice(0, 2_000_000);
  const hasAuth = /\b(login|sign in|signin|nextauth|auth\.|password|operator credentials|protected route|unauthenticated)\b/i.test(joined);
  const routeMatches = Array.from(joined.matchAll(/(?:`|\s)(\/(?:dashboard|orders|settings|costs?|channels|episodes|sources-browser|generation-log|library|brain-ab|period-library)[a-zA-Z0-9_./:[\]-]*)`?/g))
    .map((match) => match[1])
    .filter(Boolean);
  const routes = Array.from(new Set(["/dashboard", ...routeMatches.map((route) => {
    const first = route.split("/").filter(Boolean)[0];
    return first ? `/${first}` : route;
  }).filter((route) => !route.includes("[") && !route.includes(":"))])).slice(0, 12);
  const evidence = [];
  if (hasAuth) evidence.push("source mentions login/auth/password/operator credentials");
  if (routes.length) evidence.push(`candidate protected routes: ${routes.join(", ")}`);
  return { hasAuth, routes, evidence };
}

async function clickIfVisible(page: Page, pattern: RegExp): Promise<boolean> {
  const locator = page.getByRole("button", { name: pattern }).first();
  if (await locator.isVisible().catch(() => false)) {
    await locator.click().catch(() => {});
    return true;
  }
  const link = page.getByRole("link", { name: pattern }).first();
  if (await link.isVisible().catch(() => false)) {
    await link.click().catch(() => {});
    return true;
  }
  return false;
}

async function fillLogin(page: Page, credentials: Credentials): Promise<string[]> {
  const actions: string[] = [];
  const usedHelper = await clickIfVisible(page, /fill.*local|review credentials|demo credentials|sample credentials/i);
  if (usedHelper) {
    actions.push("clicked visible review-credentials helper");
  }
  const emailInput = page.locator('input[type="email"], input[name*="email" i], input[autocomplete="email"]').first();
  if (!usedHelper && credentials.email && await emailInput.isVisible().catch(() => false)) {
    await emailInput.fill(credentials.email).catch(() => {});
    actions.push("filled operator email");
  }
  const passwordInput = page.locator('input[type="password"], input[name*="password" i]').first();
  if (!usedHelper && credentials.password && await passwordInput.isVisible().catch(() => false)) {
    await passwordInput.fill(credentials.password).catch(() => {});
    actions.push("filled operator password");
  }
  if (await clickIfVisible(page, /log in|sign in|continue|submit/i)) {
    actions.push("submitted login");
  } else {
    await page.keyboard.press("Enter").catch(() => {});
    actions.push("submitted login with Enter");
  }
  return actions;
}

async function visitRoute(page: Page, route: string): Promise<Visit> {
  const url = new URL(route, BASE_URL!).href;
  const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: TIMEOUT }).catch(() => null);
  await page.waitForLoadState("networkidle", { timeout: 1500 }).catch(() => {});
  const finalUrl = page.url();
  const text = await page.evaluate(() => (document.body?.innerText || "").replace(/\s+/g, " ").trim()).catch(() => "");
  return {
    url,
    finalUrl,
    status: response?.status() || 0,
    redirectedToLogin: /\/login\b/i.test(finalUrl),
    textSample: text.slice(0, 500),
  };
}

async function pageSignature(page: Page): Promise<string> {
  return page.evaluate(() => JSON.stringify({
    href: location.href,
    text: (document.body?.innerText || "").slice(0, 5000),
    controls: Array.from(document.querySelectorAll("button,a,input,select,textarea,[role=button]"))
      .map((el) => `${el.tagName}:${(el.textContent || el.getAttribute("aria-label") || (el as HTMLInputElement).placeholder || "").trim()}`)
      .join("|"),
  }));
}

async function exerciseAuthenticatedControls(page: Page, routes: string[]): Promise<{ sampled: number; meaningful: number; broken: string[]; actionGraph: Array<{ persona: "operator"; route: string; interactions: ControlInteraction[] }> }> {
  let sampled = 0;
  let meaningful = 0;
  const broken: string[] = [];
  const actionGraph: Array<{ persona: "operator"; route: string; interactions: ControlInteraction[] }> = [];
  for (const route of routes.slice(0, 6)) {
    await page.goto(new URL(route, BASE_URL!).href, { waitUntil: "domcontentloaded", timeout: TIMEOUT }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 1200 }).catch(() => {});
    if (/\/login\b/i.test(page.url())) continue;
    const controls = page.locator("button,a[href],[role=button],input,select,textarea");
    const count = Math.min(6, await controls.count().catch(() => 0));
    const interactions: ControlInteraction[] = [];
    for (let i = 0; i < count; i += 1) {
      const item = controls.nth(i);
      if (!(await item.isVisible().catch(() => false)) || !(await item.isEnabled().catch(() => true))) continue;
      const label = ((await item.innerText().catch(() => "")) || (await item.getAttribute("aria-label").catch(() => "")) || (await item.getAttribute("placeholder").catch(() => "")) || `control ${i}`).trim().slice(0, 80);
      const href = await item.getAttribute("href").catch(() => null);
      const tag = await item.evaluate((el) => el.tagName.toLowerCase()).catch(() => "");
      if (href === "#" || href?.startsWith("javascript:")) {
        broken.push(`${route}: ${label}: no-op href`);
        interactions.push({ persona: "operator", route, label, tag, href, outcome: "broken", detail: "no-op href" });
        continue;
      }
      const before = await pageSignature(page).catch(() => "");
      sampled += 1;
      if (tag === "input" || tag === "textarea") {
        await item.fill("RDS persona UAT").catch(() => {});
      } else {
        await item.click({ timeout: 1200 }).catch((err) => {
          const detail = `click failed ${String(err).slice(0, 80)}`;
          broken.push(`${route}: ${label}: ${detail}`);
          interactions.push({ persona: "operator", route, label, tag, href, outcome: "broken", detail });
        });
      }
      await page.waitForTimeout(300);
      const after = await pageSignature(page).catch(() => "");
      if (interactions[interactions.length - 1]?.label !== label || interactions[interactions.length - 1]?.outcome !== "broken") {
        if (before && after && before !== after) {
          meaningful += 1;
          interactions.push({ persona: "operator", route, label, tag, href, outcome: "changed" });
        } else {
          interactions.push({ persona: "operator", route, label, tag, href, outcome: "unchanged" });
        }
      }
      if (page.url() !== new URL(route, BASE_URL!).href) {
        await page.goto(new URL(route, BASE_URL!).href, { waitUntil: "domcontentloaded", timeout: TIMEOUT }).catch(() => {});
      }
    }
    actionGraph.push({ persona: "operator", route, interactions });
  }
  return { sampled, meaningful, broken: broken.slice(0, 20), actionGraph };
}

async function run() {
  const texts = SOURCE_DIR ? sourceTexts(SOURCE_DIR) : [];
  const credentials = extractCredentials(texts);
  const signals = authSignals(texts);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const loginUrl = new URL("/login?returnUrl=/dashboard", BASE_URL!).href;
  const loginResponse = await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: TIMEOUT }).catch(() => null);
  await page.waitForLoadState("networkidle", { timeout: 1500 }).catch(() => {});
  const loginText = await page.evaluate(() => (document.body?.innerText || "").replace(/\s+/g, " ").trim()).catch(() => "");
  const loginExists = (loginResponse?.status() || 0) < 400 && /\b(log in|login|sign in|password|email|credentials)\b/i.test(loginText);
  const authRequired = signals.hasAuth || signals.routes.length > 0 || loginExists;
  const loginActions = loginExists ? await fillLogin(page, credentials) : [];
  await page.waitForLoadState("networkidle", { timeout: 2500 }).catch(() => {});
  await page.waitForTimeout(800);
  const afterLoginUrl = page.url();
  const authenticated = loginExists && !/\/login\b/i.test(afterLoginUrl);
  const routeVisits: Visit[] = [];
  if (authenticated) {
    for (const route of signals.routes.slice(0, 10)) {
      routeVisits.push(await visitRoute(page, route));
    }
  }
  const accessibleRoutes = routeVisits.filter((visit) => visit.status > 0 && visit.status < 400 && !visit.redirectedToLogin);
  const controls = authenticated ? await exerciseAuthenticatedControls(page, signals.routes) : { sampled: 0, meaningful: 0, broken: [], actionGraph: [] };
  await page.screenshot({ path: join(OUT_DIR!, "persona-authenticated.png"), fullPage: true }).catch(() => {});
  await context.close();
  await browser.close();

  const criteria = [
    {
      name: "auth_need_detected",
      ok: signals.hasAuth || loginExists,
      evidence: signals.evidence.join(" | ") || (loginExists ? "login page exists" : "no auth signals found"),
    },
    {
      name: "review_credentials_discoverable",
      ok: !authRequired || Boolean(credentials.email && credentials.password) || /credential|sample|demo|local review/i.test(loginText),
      evidence: credentials.email && credentials.password ? "operator email/password found in review artifacts" : "no credentials found in source or login UI",
    },
    {
      name: "login_flow_completes",
      ok: !authRequired || authenticated,
      evidence: authenticated ? `login reached ${afterLoginUrl}` : `login stayed at ${afterLoginUrl || "<unknown>"}`,
    },
    {
      name: "protected_routes_accessible_after_login",
      ok: !authRequired || accessibleRoutes.length >= Math.min(2, signals.routes.length),
      evidence: accessibleRoutes.length ? `${accessibleRoutes.length}/${signals.routes.length} candidate protected routes loaded` : "no protected route loaded after login",
    },
    {
      name: "authenticated_controls_exercised",
      ok: !authRequired || controls.sampled >= Math.min(3, Math.max(1, signals.routes.length)),
      evidence: `${controls.sampled} authenticated controls sampled, ${controls.meaningful} changed state`,
    },
    {
      name: "authenticated_controls_not_obviously_broken",
      ok: controls.broken.length === 0,
      evidence: controls.broken.slice(0, 5).join(" | ") || "no broken authenticated controls in sample",
    },
  ];
  const failed = criteria.filter((criterion) => !criterion.ok);
  const score = Math.round(criteria.filter((criterion) => criterion.ok).length / criteria.length * 100);
  const status = failed.length === 0 ? "pass" : score >= 50 ? "needs_iteration" : "fail";
  const payload = {
    schema: "rds.qa.persona-uat.v1",
    status,
    score,
    threshold: 100,
    baseUrl: BASE_URL,
    sourceDir: SOURCE_DIR || null,
    credentials: { emailDiscovered: Boolean(credentials.email), passwordDiscovered: Boolean(credentials.password) },
    login: { loginExists, loginActions, afterLoginUrl, authenticated },
    candidateRoutes: signals.routes,
    routeVisits,
    controls,
    actionGraph: controls.actionGraph,
    criteria,
    failedRequiredCriteria: failed,
    screenshots: ["persona-authenticated.png"],
  };
  writeFileSync(join(OUT_DIR!, "persona-verdict.json"), JSON.stringify(payload, null, 2));
  console.log(JSON.stringify({ status, score, path: join(OUT_DIR!, "persona-verdict.json") }));
  process.exit(status === "pass" ? 0 : 1);
}

run().catch((err) => {
  console.error("[persona-uat] FATAL:", err);
  process.exit(2);
});
