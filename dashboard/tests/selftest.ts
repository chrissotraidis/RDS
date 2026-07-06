// dashboard/tests/selftest.ts
//
// RDS self-test: a Playwright smoke run that verifies the high-value UX
// invariants of the Hub. Designed to be run by `bin/rds-selftest` (or
// `bun run dashboard/tests/selftest.ts`) — exits 0 on pass, 1 on fail,
// dumps screenshots into builds/_selftest/<ts>/ for debugging.
//
// What it checks:
//   1. /health responds 200
//   2. Hub renders and token storage can be cleared/set
//   3. /builds renders authenticated build rows
//   4. Clicking a row navigates to /b/<id>
//   5. The build view renders action controls, labelled stream pills, and tabs
//   6. Files/chat/Playwright affordances added during the Pong run remain visible
//
// Failures: throw, the harness catches, screenshot, exit 1.

import { chromium, type Browser, type Page } from "playwright";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const BASE = process.env.RDS_DASHBOARD_URL || "http://localhost:4000";
const TOKEN = process.env.RDS_DASHBOARD_TOKEN || "";
const BASIC_USER = process.env.RDS_DASHBOARD_USER || "rds";
const BASIC_PASS = process.env.RDS_DASHBOARD_PASSWORD || "";

const ts = new Date().toISOString().replace(/[:.]/g, "-");
const RDS_ROOT = process.env.RDS_ROOT || (existsSync(join(process.cwd(), "AGENT.md")) ? process.cwd() : join(process.cwd(), ".."));
const BUILDS_DIR = process.env.RDS_BUILDS_DIR || join(RDS_ROOT, "builds");
const INBOX_DIR = process.env.RDS_INBOX_DIR || join(RDS_ROOT, "inbox");
const CHAT_DIR = process.env.RDS_DASHBOARD_CHAT_DIR || join(RDS_ROOT, "dashboard", "chat");
const DASHBOARD_STATE_DIR = process.env.RDS_DASHBOARD_STATE_DIR || join(RDS_ROOT, "dashboard");
const outDir = join(BUILDS_DIR, "_selftest", ts);
mkdirSync(outDir, { recursive: true });

let browser: Browser | undefined;
let page: Page | undefined;
const failures: string[] = [];
let selectedBuildHref = "";
let selectedBuildId = "";

async function shot(name: string) {
  if (!page) return;
  await page.screenshot({ path: join(outDir, `${name}.png`), fullPage: true }).catch(() => {});
}

function writeResult(status: "passed" | "failed" | "fatal", extra: Record<string, unknown> = {}) {
  writeFileSync(join(outDir, "result.json"), JSON.stringify({
    status,
    target: BASE,
    failures,
    ...extra,
  }, null, 2) + "\n");
}

async function check(label: string, fn: () => Promise<void>) {
  process.stdout.write(`  ${label} … `);
  try {
    await fn();
    console.log("ok");
  } catch (err) {
    console.log("FAIL");
    failures.push(`${label}: ${(err as Error).message}`);
    await shot(label.replace(/\s+/g, "_"));
  }
}

async function main() {
  console.log(`[rds-selftest] target=${BASE} out=${outDir}`);

  // 1) health
  const healthHeaders: Record<string, string> = {};
  if (BASIC_PASS) {
    healthHeaders.Authorization = `Basic ${Buffer.from(`${BASIC_USER}:${BASIC_PASS}`).toString("base64")}`;
  }
  const healthPath = BASIC_PASS ? "/health" : "/healthz";
  const health = await fetch(`${BASE}${healthPath}`, { headers: healthHeaders }).catch((e) => ({ ok: false, status: 0, _err: e }));
  if (!("ok" in health) || !health.ok) {
    failures.push(`${healthPath}: ${health.status ?? "unreachable"}`);
  }

  browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    httpCredentials: BASIC_PASS ? { username: BASIC_USER, password: BASIC_PASS } : undefined,
  });
  page = await ctx.newPage();

  await check("hub renders", async () => {
    const res = await page!.goto(BASE, { waitUntil: "domcontentloaded" });
    if (!res || res.status() >= 400) throw new Error(`status=${res?.status()}`);
    await page!.waitForSelector("h1");
  });

  await check("hub surfaces hosted live builds before stale recent builds", async () => {
    await page!.goto(BASE, { waitUntil: "domcontentloaded" });
    const body = await page!.locator("body").innerText();
    if (!body.includes("Zo Hosting") || !body.includes("Zo live")) return;
    const recentText = await page!.locator("text=Recent Builds").locator("xpath=ancestor::div[contains(@class,'bg-surface-container')]").innerText();
    if (!recentText.includes("Zo live")) throw new Error("Recent Builds did not include the live hosted build");
    const firstRecent = await page!.locator("text=Recent Builds").locator("xpath=ancestor::div[contains(@class,'bg-surface-container')]").locator(`a[href^="/b/"]`).first().innerText();
    if (!firstRecent.includes("Zo live")) throw new Error(`first recent build is not the live hosted build: ${firstRecent}`);
  });

  await check("dashboard token storage can be cleared", async () => {
    await page!.evaluate(() => localStorage.removeItem("rds_token"));
    const stored = await page!.evaluate(() => localStorage.getItem("rds_token"));
    if (stored !== null) throw new Error("rds_token was not cleared");
  });

  await check("dashboard token storage can be set", async () => {
    if (!TOKEN) {
      console.log("(skipped — no RDS_DASHBOARD_TOKEN env)");
      return;
    }
    await page!.evaluate((t) => localStorage.setItem("rds_token", t), TOKEN);
    const stored = await page!.evaluate(() => localStorage.getItem("rds_token"));
    if (stored !== TOKEN) throw new Error("rds_token was not stored");
  });

  await check("toast notifications are readable", async () => {
    await page!.goto(BASE, { waitUntil: "domcontentloaded" });
    await page!.evaluate(() => {
      const toast = (window as unknown as { rdsToast?: (message: string, kind?: string) => void }).rdsToast;
      if (!toast) throw new Error("rdsToast missing");
      toast("Alert dismissed.", "info");
    });
    const toast = page!.locator(".rds-toast").first();
    await toast.waitFor({ timeout: 3000 });
    if ((await toast.getAttribute("role")) !== "status") throw new Error("toast should expose status role");
    const box = await toast.boundingBox();
    if (!box || box.width < 280) throw new Error(`toast is too narrow: ${box?.width}`);
    const styles = await toast.evaluate((el) => {
      const computed = window.getComputedStyle(el);
      return {
        display: computed.display,
        fontSize: Number.parseFloat(computed.fontSize),
        lineHeight: Number.parseFloat(computed.lineHeight),
        color: computed.color,
        backgroundColor: computed.backgroundColor,
      };
    });
    if (styles.display !== "grid") throw new Error(`toast layout regressed: ${styles.display}`);
    if (styles.fontSize < 13 || styles.lineHeight < 18) throw new Error(`toast text is too small: ${styles.fontSize}/${styles.lineHeight}`);
    if (styles.color === styles.backgroundColor) throw new Error("toast text/background colors match");
    await toast.getByRole("button", { name: "Dismiss notification" }).click();
    await toast.waitFor({ state: "detached", timeout: 1000 });
  });

  await check("hub can dismiss needs-review cards", async () => {
    if (!TOKEN) {
      console.log("(skipped — no RDS_DASHBOARD_TOKEN env)");
      return;
    }
    const buildId = "selftest-review-dismiss";
    const buildDir = join(BUILDS_DIR, buildId);
    const dismissedPath = join(DASHBOARD_STATE_DIR, "dismissed-reviews.json");
    mkdirSync(buildDir, { recursive: true });
    if (existsSync(dismissedPath)) {
      const dismissed = JSON.parse(readFileSync(dismissedPath, "utf8"));
      if (Array.isArray(dismissed.ids)) {
        dismissed.ids = dismissed.ids.filter((id: string) => id !== buildId);
        writeFileSync(dismissedPath, JSON.stringify(dismissed, null, 2) + "\n");
      }
    }
    writeFileSync(join(buildDir, "state.json"), JSON.stringify({
      id: buildId,
      build_id: buildId,
      display_name: "Selftest Review Dismiss",
      stack: "nextjs",
      mode: "green",
      status: "pending_review",
      stage: "taste-review",
      review: { status: "pending" },
      updated_at: new Date().toISOString(),
    }, null, 2) + "\n");
    try {
      await page!.goto(BASE, { waitUntil: "domcontentloaded" });
      const card = page!.locator(`[data-review-card="${buildId}"]`);
      await card.waitFor({ state: "visible", timeout: 3000 });
      await card.getByRole("button", { name: "Dismiss" }).click();
      await page!.waitForSelector("text=Review dismissed from hub", { timeout: 3000 });
      await card.waitFor({ state: "detached", timeout: 3000 });
      const dismissed = existsSync(dismissedPath) ? JSON.parse(readFileSync(dismissedPath, "utf8")) : {};
      if (!Array.isArray(dismissed.ids) || !dismissed.ids.includes(buildId)) {
        throw new Error("dismissed-reviews.json did not record the build id");
      }
    } finally {
      rmSync(buildDir, { recursive: true, force: true });
      if (existsSync(dismissedPath)) {
        const dismissed = JSON.parse(readFileSync(dismissedPath, "utf8"));
        dismissed.ids = (dismissed.ids || []).filter((id: string) => id !== buildId);
        writeFileSync(dismissedPath, JSON.stringify({ ...dismissed, updated_at: new Date().toISOString() }, null, 2) + "\n");
      }
    }
  });

  await check("new build page renders V1 stacks and skills", async () => {
    const res = await page!.goto(`${BASE}/new`, { waitUntil: "domcontentloaded" });
    if (!res || res.status() >= 400) throw new Error(`status=${res?.status()}`);
    const initialRecommendation = await page!.locator("#rds-rec-stack").textContent();
    if (initialRecommendation?.trim() !== "Waiting for PRD") throw new Error(`expected neutral recommendation, got ${initialRecommendation}`);
    const checkedStacks = await page!.locator(`input[name="stack"]:checked`).count();
    if (checkedStacks !== 0) throw new Error(`expected no default desktop stack, got ${checkedStacks}`);
    if (!(await page!.locator("#rds-use-plan-button").isDisabled())) throw new Error("Apply plan should be disabled before analysis");
    if (!(await page!.locator("#rds-start-build-button").isDisabled())) throw new Error("Start build should be disabled before source + stack");
    const expectedStacks = [
      "rails-web",
      "nextjs-fullstack",
      "python-ai-service",
      "astro-thin-web",
      "web-3d",
      "game-engine",
      "game-asset-pipeline",
      "mobile-native",
      "browser-extension",
    ];
    const stackChoices = await page!.locator(`input[name="stack"]`).count();
    if (stackChoices !== expectedStacks.length) throw new Error(`expected ${expectedStacks.length} stack cards, got ${stackChoices}`);
    for (const stack of expectedStacks) {
      const count = await page!.locator(`input[name="stack"][value="${stack}"]`).count();
      if (count !== 1) throw new Error(`missing stack card: ${stack}`);
    }
    const expectedSkills = ["rds-context7-mount", "rds-mockup-fidelity", "rds-secrets-broker"];
    for (const skill of expectedSkills) {
      const count = await page!.locator(`input[name="skill"][value="${skill}"]`).count();
      if (count !== 1) throw new Error(`missing skill chip: ${skill}`);
    }
    if (await page!.locator(`a[href="/settings?tab=reference"]`).count() < 1) throw new Error("missing Stack guide link");
    if (await page!.locator(`a[href="/settings?tab=catalog"]`).count() < 1) throw new Error("missing Skills guide link");
    if (await page!.locator(`a[href="/settings?tab=reference"]`).count() < 2) throw new Error("missing per-stack help link");
    if (await page!.locator(`a[href="/settings?tab=catalog"]`).count() < 2) throw new Error("missing per-skill help link");
  });

  await check("new build PRD analysis recommends stack and skills", async () => {
    await page!.goto(`${BASE}/new`, { waitUntil: "domcontentloaded" });
    await page!.locator("#trigger-textarea").fill("Build a Chrome extension with a popup, content script, OAuth login, and clear acceptance criteria.");
    await page!.getByRole("button", { name: "Analyze source" }).click();
    await page!.waitForFunction(() => {
      return /Remote analyzer completed/.test(document.querySelector("#rds-analysis-status")?.textContent || "");
    });
    const recommendation = await page!.locator("#rds-rec-stack").textContent();
    if (!recommendation?.includes("Browser extension")) throw new Error(`bad recommendation: ${recommendation}`);
    await page!.getByRole("button", { name: "Apply plan" }).click();
    const checkedStack = await page!.locator(`input[name="stack"]:checked`).inputValue();
    if (checkedStack !== "browser-extension") throw new Error(`expected browser-extension, got ${checkedStack}`);
    const secretsChecked = await page!.locator(`input[name="skill"][value="rds-secrets-broker"]`).isChecked();
    if (!secretsChecked) throw new Error("expected secrets skill to be recommended");
    if (await page!.locator("#rds-start-build-button").isDisabled()) throw new Error("Start build should enable after source + applied stack");
  });

  await check("new build text attachment imports before recommending", async () => {
    await page!.goto(`${BASE}/new`, { waitUntil: "domcontentloaded" });
    const prdPath = join(outDir, "browser-extension-prd.md");
    writeFileSync(prdPath, "# PRD\n\nBuild a browser extension using Manifest V3 with a popup, content script, and clear acceptance criteria.\n");
    await page!.locator("#prompt-file").setInputFiles(prdPath);
    await page!.waitForFunction(() => {
      const ta = document.querySelector<HTMLTextAreaElement>("#trigger-textarea");
      return !!ta?.value.includes("Manifest V3");
    });
    const note = await page!.locator("#prompt-ingest-note").textContent();
    if (!note?.includes("text file")) throw new Error(`missing ingest note: ${note}`);
    const recommendation = await page!.locator("#rds-rec-stack").textContent();
    if (!recommendation?.includes("Browser extension")) throw new Error(`bad attachment recommendation: ${recommendation}`);
  });

  await check("new build PDF attachment is extracted for shared analysis", async () => {
    await page!.goto(`${BASE}/new`, { waitUntil: "domcontentloaded" });
    const pageSpecPath = join(outDir, "pdf-prd-page.txt");
    const pdfPath = join(outDir, "browser-extension-prd.pdf");
    writeFileSync(pageSpecPath, [
      "%%MediaBox 0 0 612 792",
      "%%Font F1 Helvetica",
      "BT",
      "/F1 18 Tf",
      "72 720 Td",
      "(Build a browser extension using Manifest V3.) Tj",
      "0 -28 Td",
      "(Include a popup, content script, OAuth login, and clear acceptance criteria.) Tj",
      "ET",
      "",
    ].join("\n"));
    const created = spawnSync("mutool", ["create", "-o", pdfPath, pageSpecPath], { encoding: "utf8" });
    if (created.status !== 0 || !existsSync(pdfPath)) throw new Error(`failed to create PDF fixture: ${created.stderr || created.stdout}`);
    await page!.locator("#prompt-file").setInputFiles(pdfPath);
    const note = await page!.locator("#prompt-ingest-note").textContent();
    if (!note?.includes("source asset")) throw new Error(`missing PDF ingest note: ${note}`);
    await page!.getByRole("button", { name: "Analyze source" }).click();
    await page!.waitForFunction(() => {
      const title = document.querySelector("#rds-rec-stack")?.textContent || "";
      return title.includes("Browser extension");
    });
    const recommendation = await page!.locator("#rds-rec-stack").textContent();
    if (!recommendation?.includes("Browser extension")) throw new Error(`bad PDF recommendation: ${recommendation}`);
  });

  await check("new build ZIP attachment is extracted for shared analysis", async () => {
    await page!.goto(`${BASE}/new`, { waitUntil: "domcontentloaded" });
    const zipSrc = join(outDir, "stitch-export");
    const zipPath = join(outDir, "stitch-export.zip");
    mkdirSync(join(zipSrc, "mockups"), { recursive: true });
    writeFileSync(join(zipSrc, "README.md"), "# Stitch export\n\nBuild a polished Next.js full-stack dashboard with authentication, file uploads, and chart-heavy operator workflows.\n");
    writeFileSync(join(zipSrc, "mockups", "home.html"), "<main><h1>Operator dashboard</h1><section>Charts, upload queue, and review states</section></main>\n");
    const zipped = spawnSync("python3", ["-c", "import pathlib, sys, zipfile\nroot=pathlib.Path(sys.argv[1]); out=pathlib.Path(sys.argv[2])\nwith zipfile.ZipFile(out, 'w') as z:\n    for path in root.rglob('*'):\n        if path.is_file(): z.write(path, path.relative_to(root))", zipSrc, zipPath], { encoding: "utf8" });
    if (zipped.status !== 0 || !existsSync(zipPath)) throw new Error(`failed to create ZIP fixture: ${zipped.stderr || zipped.stdout}`);
    await page!.locator("#prompt-file").setInputFiles(zipPath);
    const note = await page!.locator("#prompt-ingest-note").textContent();
    if (!note?.includes("source asset")) throw new Error(`missing ZIP ingest note: ${note}`);
    await page!.getByRole("button", { name: "Analyze source" }).click();
    await page!.waitForFunction(() => {
      const title = document.querySelector("#rds-rec-stack")?.textContent || "";
      return title.includes("Next.js");
    });
    const folderInputAttrs = await page!.locator("#prompt-folder").evaluate((el) => ({
      webkitdirectory: el.hasAttribute("webkitdirectory"),
      multiple: el.hasAttribute("multiple"),
    }));
    if (!folderInputAttrs.webkitdirectory || !folderInputAttrs.multiple) throw new Error("folder upload input is not wired");
    const submittedNames = await page!.evaluate(async () => {
      const file = new File(["<main>Folder mockup</main>"], "home.html", { type: "text/html" });
      Object.defineProperty(file, "webkitRelativePath", { value: "stitch-folder/mockups/home.html" });
      const systemFile = new File(["junk"], ".DS_Store", { type: "application/octet-stream" });
      Object.defineProperty(systemFile, "webkitRelativePath", { value: "stitch-folder/.DS_Store" });
      (window as any).rdsPromptAttachments = [];
      (window as any).rdsPromptIgnoredFiles = [];
      (window as any).rdsHandlePromptFiles([file, systemFile]);
      const originalFetch = window.fetch;
      const names: string[] = [];
      window.fetch = async (_input, init) => {
        const body = init?.body as FormData;
        for (const [key, value] of body.entries()) {
          if (key === "attachments" && value instanceof File) names.push(value.name);
        }
        window.fetch = originalFetch;
        return new Response(JSON.stringify({ ok: true, analysis: { stack: "nextjs-fullstack", confidence: "high", skills: [], questions: [] } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      };
      await (window as any).rdsAnalyzeBuildInputRemote(document.getElementById("new-build"), false, true);
      return names;
    });
    if (!submittedNames.includes("stitch-folder/mockups/home.html")) throw new Error(`folder relative path not submitted: ${submittedNames.join(",")}`);
    if (submittedNames.includes("stitch-folder/.DS_Store")) throw new Error(`system file submitted: ${submittedNames.join(",")}`);
    const ignoredNote = await page!.locator("#prompt-ingest-note").textContent();
    if (!ignoredNote?.includes("system file ignored")) throw new Error(`missing ignored-file note: ${ignoredNote}`);
  });

  await check("new build provider controls hide irrelevant model options", async () => {
    await page!.goto(`${BASE}/new`, { waitUntil: "domcontentloaded" });
    const codexInput = page!.locator(`input[name="codex_model"]`);
    const claudeSelect = page!.locator(`select[name="claude_model"]`);
    await page!.locator(`select[name="provider"]`).selectOption("claude");
    if (await codexInput.isVisible()) throw new Error("Codex model input visible while Claude is selected");
    if (!(await codexInput.isDisabled())) throw new Error("Codex model input enabled while Claude is selected");
    if (!(await claudeSelect.isVisible())) throw new Error("Claude model select hidden while Claude is selected");
    await page!.locator(`select[name="provider"]`).selectOption("codex");
    if (await claudeSelect.isVisible()) throw new Error("Claude model select visible while Codex is selected");
    if (!(await claudeSelect.isDisabled())) throw new Error("Claude model select enabled while Codex is selected");
    if (!(await codexInput.isVisible())) throw new Error("Codex model input hidden while Codex is selected");
  });

  await check("settings page renders organized RDS controls", async () => {
    const res = await page!.goto(`${BASE}/settings`, { waitUntil: "domcontentloaded" });
    if (!res || res.status() >= 400) throw new Error(`status=${res?.status()}`);
    await page!.getByRole("heading", { name: "Start a build" }).waitFor();
    await page!.getByRole("heading", { name: "Builder defaults" }).waitFor();
    await page!.getByText("templates", { exact: true }).waitFor();
    await page!.getByText("skills", { exact: true }).first().waitFor();
    await page!.getByText("writes", { exact: true }).waitFor();
    await page!.locator(`[data-settings-tab="reference"]`).click();
    await page!.getByRole("heading", { name: "Stacks and app types" }).waitFor();
    await page!.getByRole("heading", { name: "Launchable stacks" }).waitFor();
    await page!.locator(`[data-settings-tab="catalog"]`).click();
    await page!.getByRole("heading", { name: "Skills catalog" }).waitFor();
    await page!.locator("#skill-category-filter").waitFor();
    await page!.getByText("Catalog audit").waitFor();
    await page!.locator("#skill-search").fill("context7");
    await page!.locator("#skill-filter-count").getByText(/1 skills shown|[1-9][0-9]* skills shown/).waitFor();
    await page!.locator(`[data-settings-tab="inventory"]`).click();
    await page!.getByRole("heading", { name: "Components: what RDS is built from" }).waitFor();
    await page!.locator(`[data-settings-tab="runtime"]`).click();
    await page!.getByRole("heading", { name: "Runtime" }).waitFor();
    await page!.locator(`[data-settings-tab="start"]`).click();
    await page!.locator(`select[name="inferenceProvider"]`).selectOption("claude");
    if (await page!.locator(`input[name="codexModel"]`).isVisible()) throw new Error("Codex model visible while Claude selected on settings");
    await page!.locator(`select[name="inferenceProvider"]`).selectOption("codex");
    if (await page!.locator(`select[name="claudeModel"]`).isVisible()) throw new Error("Claude model visible while Codex selected on settings");
  });

  await check("stack and skill reference pages explain choices", async () => {
    let res = await page!.goto(`${BASE}/settings/stacks`, { waitUntil: "domcontentloaded" });
    if (!res || res.status() >= 400) throw new Error(`/settings/stacks status=${res?.status()}`);
    await page!.getByRole("heading", { name: "Build Types" }).waitFor();
    await page!.locator("#build-types").waitFor();
    await page!.getByRole("heading", { name: "Stack map" }).waitFor();
    await page!.locator("#stack-rails-web").waitFor();
    await page!.locator("#stack-browser-extension").waitFor();
    await page!.getByText("Why RDS trusts this stack").first().waitFor();
    await page!.getByText("Use when").first().waitFor();
    res = await page!.goto(`${BASE}/settings/skills`, { waitUntil: "domcontentloaded" });
    if (!res || res.status() >= 400) throw new Error(`/settings/skills status=${res?.status()}`);
    await page!.getByRole("heading", { name: "Skills Catalog" }).waitFor();
    await page!.getByText("Skills are RDS capability packs").waitFor();
    await page!.getByRole("heading", { name: "Find a skill" }).waitFor();
    await page!.getByText("Quick category filters").waitFor();
    await page!.locator("#skill-search").fill("context7");
    await page!.locator("#skill-filter-count").getByText(/1 skills shown|[1-9][0-9]* skills shown/).waitFor();
    await page!.locator("#skill-status-filter").selectOption("ready");
    await page!.locator("#skill-sort").selectOption("name");
    await page!.locator("#skill-rds-context7-mount").waitFor();
    await page!.locator("#skill-rds-context7-mount summary").click();
    await page!.locator(`a[href="https://context7.com/"]`).first().waitFor();
    await page!.locator("#skill-search").fill("");
    await page!.locator("#skill-status-filter").selectOption("ready");
    await page!.locator("#skill-filter-count").getByText(/[1-9][0-9]* skills shown/).waitFor();
    res = await page!.goto(`${BASE}/settings/components`, { waitUntil: "domcontentloaded" });
    if (!res || res.status() >= 400) throw new Error(`/settings/components status=${res?.status()}`);
    await page!.getByRole("heading", { name: "Components", exact: true }).waitFor();
    await page!.getByRole("heading", { name: "Pipeline components" }).waitFor();
    await page!.getByText("Vendored path").first().waitFor();
  });

  await check("agent sessions page renders chat-driven session management", async () => {
    const res = await page!.goto(`${BASE}/agents`, { waitUntil: "domcontentloaded" });
    if (!res || res.status() >= 400) throw new Error(`/agents status=${res?.status()}`);
    await page!.getByRole("heading", { name: "Agent Sessions" }).first().waitFor();
    await page!.getByRole("heading", { name: "Worker sessions are chat-driven" }).waitFor();
    await page!.getByText("Runtime health").waitFor();
    await page!.getByPlaceholder("/home/workspace/Projects/foo").waitFor({ timeout: 1000, state: "detached" });
    await page!.getByRole("button", { name: "Launch worker" }).waitFor({ timeout: 1000, state: "detached" });
    await page!.getByRole("button", { name: "New Claude" }).waitFor({ timeout: 1000, state: "detached" });
    await page!.getByRole("button", { name: "New Codex" }).waitFor({ timeout: 1000, state: "detached" });
    await page!.getByText("Review").first().waitFor();
    await page!.getByText("Handoff").first().waitFor();
    await page!.getByText("Merge").first().waitFor();
  });

  await check("builds page has row-clickable builds", async () => {
    const res = await page!.goto(`${BASE}/builds`, { waitUntil: "domcontentloaded" });
    if (!res || res.status() >= 400) throw new Error(`status=${res?.status()}`);
    const rows = await page!.locator("tr.row-clickable").count();
    if (rows === 0) throw new Error("no row-clickable rows in builds table");
    const hrefs = await page!.locator("tr.row-clickable").evaluateAll((els) =>
      els.map((el) => el.getAttribute("data-href") || "").filter(Boolean)
    );
    selectedBuildHref = hrefs.find((href) => href.includes("pong")) || hrefs[0] || "";
    if (!selectedBuildHref || !selectedBuildHref.startsWith("/b/")) throw new Error(`bad data-href: ${selectedBuildHref}`);
    selectedBuildId = decodeURIComponent(selectedBuildHref.replace(/^\/b\//, "").split(/[?#]/)[0]);
  });

  await check("clicking a build row navigates to /b/<id>", async () => {
    if (!selectedBuildHref) throw new Error("no selected build href");
    const row = page!.locator(`tr.row-clickable[data-href="${selectedBuildHref}"]`).first();
    await row.click();
    await page!.waitForURL(`**${selectedBuildHref}`, { timeout: 4000 });
  });

  await check("build view: action bar + tab strip render", async () => {
    const actions = await page!.locator("button[onclick], a[href*='playwright'], a[href*='cost']").count();
    if (actions < 4) throw new Error(`actions count=${actions} (expected >=4 controls)`);
    const tabs = await page!.locator("[data-tab]").count();
    if (tabs < 5) throw new Error(`tabs count=${tabs} (expected >=5: Overview, Live log, Agent terminal, Browser, Files, Diff, Chat)`);
  });

  await check("build view: elapsed timer is visible", async () => {
    await page!.locator("[data-build-elapsed-pill]").waitFor({ timeout: 2000 });
    const label = (await page!.locator("[data-build-elapsed-label]").first().innerText()).trim();
    if (!label || label === "-") throw new Error(`bad elapsed label: ${label}`);
  });

  await check("build view: command center renders before build context details", async () => {
    await page!.waitForSelector("text=Build status", { timeout: 2000 });
    await page!.waitForSelector("text=Top blockers", { timeout: 2000 });
    await page!.waitForSelector("text=Evidence summary", { timeout: 2000 });
    const detail = page!.locator("summary", { hasText: "Build context" }).first();
    if (!(await detail.count())) throw new Error("missing collapsed pipeline/input/plan disclosure");
    const order = await page!.evaluate(() => {
      const command = document.querySelector(".rds-command-center")?.getBoundingClientRect().top ?? 0;
      const details = Array.from(document.querySelectorAll("summary")).find((el) => el.textContent?.includes("Build context"))?.getBoundingClientRect().top ?? 0;
      return { command, details };
    });
    if (!(order.command > 0 && order.details > 0 && order.command < order.details)) {
      throw new Error(`expected command center above pipeline/source details, got ${JSON.stringify(order)}`);
    }
  });

  await check("build view: stage chips reveal visible stage inspector", async () => {
    await page!.locator("summary", { hasText: "Build context" }).first().click();
    await page!.locator("[data-stage-chip]").first().click();
    const visible = await page!.locator("[data-stage-summary]:not(.hidden)").count();
    if (visible < 1) throw new Error("no visible stage summary after clicking stage chip");
    await page!.waitForSelector("text=Selected pipeline step", { timeout: 2000 });
  });

  await check("pending-review build suppresses stale iteration state", async () => {
    const troveId = "ok-this-is-the-plan-for-trove-review-the-prd-fil-20260523-220809";
    if (!existsSync(join(BUILDS_DIR, troveId, "state.json"))) {
      console.log("(skipped — Trove fixture build not present)");
      return;
    }
    const res = await page!.goto(`${BASE}/b/${encodeURIComponent(troveId)}`, { waitUntil: "domcontentloaded" });
    if (!res || res.status() >= 400) throw new Error(`status=${res?.status()}`);
    const text = await page!.locator("body").innerText();
    if (!text.includes("Trove Vinyl Portfolio")) throw new Error("build detail did not use the curated Trove display name");
    if (!text.includes("Pending Review")) throw new Error("pending-review verdict is not visible");
    if (text.includes("Iteration running")) throw new Error("stale iteration banner is still visible");
    if (text.includes("RDS is actively iterating")) throw new Error("stale active-iteration copy is still visible");
    if (!text.includes("Open the preview, inspect the app, then approve or reject.")) throw new Error("canonical next action is missing");
  });

  await check("build view: engine picker lets operator switch provider and pin a model", async () => {
    const picker = page!.locator(".rds-command-engine");
    if (!(await picker.count())) {
      console.log("(skipped — current build state exposes no goal/iteration action)");
      return;
    }
    const providerOptions = (await page!.locator("#engine-provider option").allInnerTexts()).map((t) => t.toLowerCase());
    if (!providerOptions.some((t) => t.includes("claude")) || !providerOptions.some((t) => t.includes("codex"))) {
      throw new Error(`engine provider select missing Claude/Codex options: ${JSON.stringify(providerOptions)}`);
    }
    if (!(await page!.locator("#engine-model").count())) throw new Error("engine model input is missing");
    await page!.selectOption("#engine-provider", "codex");
    if ((await page!.locator("#engine-model").getAttribute("list")) !== "rds-engine-codex") {
      throw new Error("switching to Codex did not rebind the model suggestion list");
    }
    await page!.selectOption("#engine-provider", "claude");
    if ((await page!.locator("#engine-model").getAttribute("list")) !== "rds-engine-claude") {
      throw new Error("switching back to Claude did not rebind the model suggestion list");
    }
    await page!.fill("#engine-model", "claude-opus-4-8");
    if ((await page!.locator("#engine-model").inputValue()) !== "claude-opus-4-8") {
      throw new Error("engine model input did not accept a free-text model id");
    }
  });

  await check("build view: command center stays readable on narrow desktop", async () => {
    await page!.setViewportSize({ width: 930, height: 900 });
    await page!.reload({ waitUntil: "domcontentloaded" });
    await page!.waitForSelector(".rds-command-center", { timeout: 3000 });
    const metrics = await page!.evaluate(() => {
      const grid = document.querySelector(".rds-command-grid") as HTMLElement | null;
      const firstBlockerText = document.querySelector(".rds-command-panel li span") as HTMLElement | null;
      const center = document.querySelector(".rds-command-center") as HTMLElement | null;
      return {
        columns: grid ? getComputedStyle(grid).gridTemplateColumns.split(" ").length : 0,
        textWidth: firstBlockerText?.getBoundingClientRect().width ?? 0,
        centerRight: center?.getBoundingClientRect().right ?? 0,
        viewport: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
      };
    });
    if (metrics.columns !== 1) throw new Error(`expected one command-grid column, got ${JSON.stringify(metrics)}`);
    if (metrics.textWidth > 0 && metrics.textWidth < 240) throw new Error(`blocker text too narrow: ${JSON.stringify(metrics)}`);
    if (metrics.scrollWidth > metrics.viewport + 2) throw new Error(`horizontal overflow: ${JSON.stringify(metrics)}`);
    await page!.setViewportSize({ width: 1280, height: 900 });
  });

  await check("build view: core affordances remain visible", async () => {
    if (selectedBuildHref && !page!.url().includes(selectedBuildHref)) {
      await page!.goto(`${BASE}${selectedBuildHref}`, { waitUntil: "domcontentloaded" });
    }
    await page!.waitForSelector("text=Live connections", { timeout: 2000 });
    await page!.waitForSelector("text=Events", { timeout: 2000 });
    await page!.waitForSelector("text=Terminal", { timeout: 2000 });
    await page!.waitForSelector("text=/Make review-ready|Continue RDS Goal|One-off iteration/", { timeout: 2000 });
    await page!.waitForSelector("text=Ask RDS", { timeout: 2000 });
    await page!.locator("[data-tab='files']").click();
    await page!.locator("#files-tree").waitFor({ timeout: 3000 });
    await page!.waitForFunction(() => {
      const status = document.querySelector("#files-status")?.textContent || "";
      return status.trim().length > 0 && !/Loading/i.test(status);
    }, null, { timeout: 5000 });
    const filesText = `${await page!.locator("#files-status").innerText()} ${await page!.locator("#files-tree").innerText()}`;
    const fileButtons = await page!.locator("#files-tree button").count();
    if (fileButtons === 0 && !filesText.match(/\d+ files|no files|empty|not found/i)) throw new Error(`Files tab rendered without file buttons or an empty-state message: ${filesText}`);
    await page!.locator("[data-tab='chat']").click();
    await page!.waitForSelector("#chat-input", { timeout: 2000 });
    await page!.waitForSelector("#chat-file-input", { timeout: 2000, state: "attached" });
    await page!.locator("#chat-build-actions").waitFor({ timeout: 2000 });
    await page!.getByRole("link", { name: "Open build" }).waitFor({ timeout: 2000 });
    await page!.getByRole("button", { name: "Run iteration" }).waitFor({ timeout: 1000, state: "detached" });
    await page!.getByRole("button", { name: "Add files" }).waitFor({ timeout: 2000 });
    await page!.locator("#chat-agent-console").waitFor({ timeout: 3000, state: "detached" });
    await page!.getByRole("button", { name: "New Claude" }).waitFor({ timeout: 1000, state: "detached" });
    await page!.getByRole("button", { name: "New Codex" }).waitFor({ timeout: 1000, state: "detached" });
    await page!.waitForSelector("text=Ask for a fix, attach screenshots", { timeout: 2000 });
    await page!.getByRole("button", { name: "Attach files" }).waitFor({ timeout: 2000 });
    await page!.getByRole("button", { name: "Send" }).waitFor({ timeout: 2000 });
  });

  await check("full chat page exposes build-linked operator actions", async () => {
    if (!selectedBuildId) throw new Error("no selected build id");
    await page!.goto(`${BASE}/chat?b=${encodeURIComponent(selectedBuildId)}`, { waitUntil: "domcontentloaded" });
    await page!.locator("#chat-build-actions").waitFor({ timeout: 4000 });
    await page!.getByRole("link", { name: "Open build" }).waitFor({ timeout: 2000 });
    await page!.getByRole("button", { name: "Add files" }).waitFor({ timeout: 2000 });
    await page!.locator("#chat-agent-console").waitFor({ timeout: 3000, state: "detached" });
    await page!.getByRole("button", { name: "New Claude" }).waitFor({ timeout: 1000, state: "detached" });
    await page!.getByRole("button", { name: "New Codex" }).waitFor({ timeout: 1000, state: "detached" });
    await page!.waitForSelector("text=Ask for a fix, attach screenshots", { timeout: 2000 });
  });

  await check("build view exposes Agent Sessions controls", async () => {
    if (!selectedBuildHref) throw new Error("no selected build href");
    await page!.goto(`${BASE}${selectedBuildHref}`, { waitUntil: "domcontentloaded" });
    await page!.locator("[data-tab='overview']").click();
    await page!.getByRole("heading", { name: "Agent Sessions" }).first().waitFor({ timeout: 3000 });
    await page!.getByRole("button", { name: /Open chat/ }).waitFor({ timeout: 2000 });
    await page!.getByRole("button", { name: "Start Claude worker" }).waitFor({ timeout: 1000, state: "detached" });
    await page!.getByRole("button", { name: "Start Codex worker" }).waitFor({ timeout: 1000, state: "detached" });
    const body = await page!.locator("body").innerText();
    if (!body.includes("tmux") || !body.includes("isolated git worktree")) {
      throw new Error("agent session safety/attach language missing");
    }
  });

  await check("build view exposes original PRD and spec documents", async () => {
    const buildId = "_selftest-input-docs";
    const buildDir = join(BUILDS_DIR, buildId);
    const inboxDir = INBOX_DIR;
    const prdPath = join(inboxDir, "selftest-input-docs-prd.md");
    mkdirSync(buildDir, { recursive: true });
    mkdirSync(inboxDir, { recursive: true });
    writeFileSync(prdPath, "# Original PRD\n\nSubmitted operator requirements.\n");
    writeFileSync(join(buildDir, "spec.md"), "# Generated Spec\n\nImplementation requirements.\n");
    writeFileSync(join(buildDir, "build-plan.json"), JSON.stringify({ profile: "selftest" }, null, 2) + "\n");
    mkdirSync(join(buildDir, "scaffold-out"), { recursive: true });
    writeFileSync(join(buildDir, "scaffold-out", "tasks.json"), JSON.stringify([{ title: "Build UI" }], null, 2) + "\n");
    writeFileSync(join(buildDir, "state.json"), JSON.stringify({
      id: buildId,
      build_id: buildId,
      display_name: "Selftest Input Docs",
      status: "pending_review",
      stage: "qa",
      trigger: prdPath,
      updated_at: new Date().toISOString(),
    }, null, 2) + "\n");
    try {
      const res = await page!.goto(`${BASE}/b/${encodeURIComponent(buildId)}`, { waitUntil: "domcontentloaded" });
      if (!res || res.status() >= 400) throw new Error(`status=${res?.status()}`);
      await page!.locator("summary", { hasText: "Source files" }).first().click();
      await page!.waitForSelector("text=Original PRD / submitted input", { timeout: 3000 });
      await page!.waitForSelector("text=Generated implementation spec", { timeout: 3000 });
      await page!.waitForSelector("text=Scaffold task list", { timeout: 3000 });
      const raw = await fetch(`${BASE}/b/${encodeURIComponent(buildId)}/docs/raw?key=original-prd`, {
        headers: BASIC_PASS ? { Authorization: `Basic ${Buffer.from(`${BASIC_USER}:${BASIC_PASS}`).toString("base64")}` } : {},
      });
      if (!raw.ok) throw new Error(`raw original PRD status=${raw.status}`);
      const body = await raw.text();
      if (!body.includes("Submitted operator requirements")) throw new Error(`bad raw PRD body: ${body.slice(0, 80)}`);
    } finally {
      rmSync(buildDir, { recursive: true, force: true });
      if (existsSync(prdPath)) unlinkSync(prdPath);
    }
  });

  await check("build view renders row-level PRD blockers", async () => {
    const buildId = "_selftest-prd-ledger";
    const buildDir = join(BUILDS_DIR, buildId);
    mkdirSync(buildDir, { recursive: true });
    writeFileSync(join(buildDir, "state.json"), JSON.stringify({
      id: buildId,
      build_id: buildId,
      display_name: "Selftest PRD Ledger",
      status: "pending_review",
      stage: "qa",
      app_dest: "/tmp/rds-selftest-prd-ledger",
      updated_at: new Date().toISOString(),
    }, null, 2) + "\n");
    writeFileSync(join(buildDir, "quality-ledger.json"), JSON.stringify({
      blocking: ["prdCoverage"],
      verdicts: { prdCoverage: "needs_iteration" },
      prdCoverage: {
        available: true,
        status: "needs_iteration",
        score: 71,
        summary: { total: 12, verified: 10, missing: 2, missingByKind: { route: 1, action: 1 } },
        blockingRows: [{
          id: "route:/period-library",
          kind: "route",
          promise: "Visitor can open the period library and browse cited historical eras.",
          routeFamily: "/period-library",
          status: "missing",
          repairHint: "Implement /period-library or remove the PRD promise.",
        }, {
          id: "action:approve",
          kind: "action",
          promise: "Operator can approve a source-backed episode from the review queue.",
          action: "approve",
          status: "missing",
          repairHint: "Make approve mutate review state and show confirmation.",
        }],
        verdictPath: "playwright/iter-selftest/prd-coverage-verdict.json",
      },
    }, null, 2) + "\n");
    writeFileSync(join(buildDir, "iterate-selftest.repair-jobs.json"), JSON.stringify({
      schema: "rds.iteration.repair-jobs.v1",
      buildId,
      status: "needs_iteration",
      jobs: [{
        id: "job-01-prd_route_implementation",
        type: "prd_route_implementation",
        status: "partially_closed",
        filesTouched: [{ path: "src/app/period-library/page.tsx", change: "added" }],
        checksRun: [{ name: "qa", status: "fail", artifact: `builds/${buildId}/logs/qa.log` }],
        targets: [{
          id: "prd-promise:route:/period-library",
          gate: "prd-coverage",
          promiseKind: "route",
          routeFamily: "/period-library",
          requirement: "Visitor can open the period library and browse cited historical eras.",
        }],
        remainingBlockers: [{
          id: "prd-promise:route:/period-library",
          gate: "prd-coverage",
          requirement: "Visitor can open the period library and browse cited historical eras.",
        }],
      }],
    }, null, 2) + "\n");
    try {
      const res = await page!.goto(`${BASE}/b/${encodeURIComponent(buildId)}`, { waitUntil: "domcontentloaded" });
      if (!res || res.status() >= 400) throw new Error(`status=${res?.status()}`);
      await page!.locator("#quality-ledger-details > summary").click();
      await page!.waitForSelector("text=Unmet PRD requirements", { timeout: 3000 });
      await page!.waitForSelector("text=Visitor can open the period library", { timeout: 3000 });
      await page!.waitForSelector("text=Make approve mutate review state", { timeout: 3000 });
      await page!.waitForSelector("text=job-01-prd_route_implementation", { timeout: 3000 });
      await page!.waitForSelector("text=still blocking", { timeout: 3000 });
    } finally {
      rmSync(buildDir, { recursive: true, force: true });
    }
  });

  await check("goal panel surfaces quota provider fallback", async () => {
    const buildId = "_selftest-goal-quota-fallback";
    const buildDir = join(BUILDS_DIR, buildId);
    mkdirSync(buildDir, { recursive: true });
    writeFileSync(join(buildDir, "state.json"), JSON.stringify({
      id: buildId,
      build_id: buildId,
      display_name: "Selftest Goal Quota Fallback",
      status: "pending_review",
      stage: "qa",
      app_dest: "/tmp/rds-selftest-goal-quota-fallback",
      updated_at: new Date().toISOString(),
    }, null, 2) + "\n");
    writeFileSync(join(buildDir, "goal.json"), JSON.stringify({
      buildId,
      objective: "Make this build review-ready.",
      status: "running",
      phase: "iterate",
      cycle: 2,
      maxCycles: 3,
      engine: {
        provider: "claude",
        model: "claude-opus-4-8",
        switchedFrom: "codex",
        reason: "usage_limit",
        switchedAt: new Date().toISOString(),
      },
      exhaustedProviders: ["codex"],
      actions: [{
        cycle: 2,
        type: "provider_switch",
        status: "passed",
        from: "codex",
        to: "claude",
        reason: "usage_limit",
      }],
      updatedAt: new Date().toISOString(),
    }, null, 2) + "\n");
    try {
      const res = await page!.goto(`${BASE}/b/${encodeURIComponent(buildId)}`, { waitUntil: "domcontentloaded" });
      if (!res || res.status() >= 400) throw new Error(`status=${res?.status()}`);
      await page!.waitForSelector("text=Codex → Claude", { timeout: 3000 });
      await page!.waitForSelector("text=(was Codex)", { timeout: 3000 });
    } finally {
      rmSync(buildDir, { recursive: true, force: true });
    }
  });

  await check("approved terminal builds hide stale fixer controls", async () => {
    const terminalBuildId = "the-web-agnostic-master-prompt-1777549671354-20260430-114751";
    const res = await page!.goto(`${BASE}/b/${encodeURIComponent(terminalBuildId)}`, { waitUntil: "domcontentloaded" });
    if (!res || res.status() === 404) {
      console.log("(skipped — fixture build not present)");
      return;
    }
    if (res.status() >= 400) throw new Error(`status=${res.status()}`);
    const text = await page!.locator("body").innerText();
    if (text.includes("Fixer running") || text.includes("Spawn fixer")) throw new Error("terminal approved build still exposes fixer controls");
    if (text.includes("Build is idle")) throw new Error("terminal approved build still shows idle retry banner");
  });

  await check("Chat edit intent proposes confirmed iteration", async () => {
    if (!TOKEN) {
      console.log("(skipped — no RDS_DASHBOARD_TOKEN env)");
      return;
    }
    const result = await page!.evaluate(async (id) => {
      const t = localStorage.getItem("rds_token") || "";
      const byBuild = await fetch(`/chat/sessions/by-build/${encodeURIComponent(id)}`, {
        method: "POST",
        headers: { "X-RDS-Token": t },
      });
      if (!byBuild.ok) return { ok: false, status: byBuild.status, body: await byBuild.text() };
      const session = (await byBuild.json()).session;
      const send = await fetch(`/chat/sessions/${encodeURIComponent(session.id)}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-RDS-Token": t },
        body: JSON.stringify({ message: "make the paddle movement 10 percent faster" }),
      });
      if (!send.ok) return { ok: false, status: send.status, body: await send.text() };
      const fresh = await fetch(`/chat/sessions/${encodeURIComponent(session.id)}`);
      const data = await fresh.json();
      const last = data.session.turns[data.session.turns.length - 1];
      const prev = data.session.turns[data.session.turns.length - 2];
      return { ok: true, sessionId: session.id, turnIds: [prev?.id, last?.id].filter(Boolean), action: last.action, text: last.text };
    }, selectedBuildId);
    if (!result.ok) throw new Error(`chat proposal failed status=${result.status} body=${String(result.body || "").slice(0, 120)}`);
    if (!result.action || result.action.kind !== "iterate") throw new Error(`expected iterate action, got ${JSON.stringify(result.action)}`);
    if (result.sessionId && Array.isArray(result.turnIds)) {
      const turnIds = result.turnIds.filter((id): id is string => typeof id === "string");
      const chatPath = join(CHAT_DIR, `${result.sessionId}.json`);
      if (existsSync(chatPath)) {
        const chat = JSON.parse(readFileSync(chatPath, "utf8"));
        chat.turns = (chat.turns || []).filter((t: { id?: string }) => !t.id || !turnIds.includes(t.id));
        chat.updated_at = chat.turns.length ? chat.updated_at : chat.created_at;
        chat.last_read_at = chat.turns.length ? chat.last_read_at : chat.created_at;
        writeFileSync(chatPath, JSON.stringify(chat, null, 2) + "\n");
      }
    }
  });

  await check("Chat goal intent proposes review-ready supervisor", async () => {
    if (!TOKEN) {
      console.log("(skipped — no RDS_DASHBOARD_TOKEN env)");
      return;
    }
    const result = await page!.evaluate(async (id) => {
      const t = localStorage.getItem("rds_token") || "";
      const byBuild = await fetch(`/chat/sessions/by-build/${encodeURIComponent(id)}`, {
        method: "POST",
        headers: { "X-RDS-Token": t },
      });
      if (!byBuild.ok) return { ok: false, status: byBuild.status, body: await byBuild.text() };
      const session = (await byBuild.json()).session;
      const send = await fetch(`/chat/sessions/${encodeURIComponent(session.id)}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-RDS-Token": t },
        body: JSON.stringify({ message: "continue building until this is review-ready" }),
      });
      if (!send.ok) return { ok: false, status: send.status, body: await send.text() };
      const fresh = await fetch(`/chat/sessions/${encodeURIComponent(session.id)}`);
      const data = await fresh.json();
      const last = data.session.turns[data.session.turns.length - 1];
      const prev = data.session.turns[data.session.turns.length - 2];
      return { ok: true, sessionId: session.id, turnIds: [prev?.id, last?.id].filter(Boolean), action: last.action, text: last.text };
    }, selectedBuildId);
    if (!result.ok) throw new Error(`goal proposal failed status=${result.status} body=${String(result.body || "").slice(0, 120)}`);
    if (!result.action || result.action.kind !== "goal") throw new Error(`expected goal action, got ${JSON.stringify(result.action)}`);
    if (!String(result.text || "").includes("review-ready")) throw new Error(`goal proposal text does not explain review-ready loop: ${result.text}`);
    if (result.sessionId && Array.isArray(result.turnIds)) {
      const turnIds = result.turnIds.filter((id): id is string => typeof id === "string");
      const chatPath = join(CHAT_DIR, `${result.sessionId}.json`);
      if (existsSync(chatPath)) {
        const chat = JSON.parse(readFileSync(chatPath, "utf8"));
        chat.turns = (chat.turns || []).filter((t: { id?: string }) => !t.id || !turnIds.includes(t.id));
        writeFileSync(chatPath, JSON.stringify(chat, null, 2) + "\n");
      }
    }
  });

  await check("Chat agent intent proposes confirmed worker start", async () => {
    if (!TOKEN) {
      console.log("(skipped — no RDS_DASHBOARD_TOKEN env)");
      return;
    }
    const result = await page!.evaluate(async (id) => {
      const t = localStorage.getItem("rds_token") || "";
      const byBuild = await fetch(`/chat/sessions/by-build/${encodeURIComponent(id)}`, {
        method: "POST",
        headers: { "X-RDS-Token": t },
      });
      if (!byBuild.ok) return { ok: false, status: byBuild.status, body: await byBuild.text() };
      const session = (await byBuild.json()).session;
      const send = await fetch(`/chat/sessions/${encodeURIComponent(session.id)}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-RDS-Token": t },
        body: JSON.stringify({ message: "Start a Codex worker to review the diff" }),
      });
      if (!send.ok) return { ok: false, status: send.status, body: await send.text() };
      const fresh = await fetch(`/chat/sessions/${encodeURIComponent(session.id)}`);
      const data = await fresh.json();
      const last = data.session.turns[data.session.turns.length - 1];
      const prev = data.session.turns[data.session.turns.length - 2];
      return { ok: true, sessionId: session.id, turnIds: [prev?.id, last?.id].filter(Boolean), action: last.action, text: last.text };
    }, selectedBuildId);
    if (!result.ok) throw new Error(`agent proposal failed status=${result.status} body=${String(result.body || "").slice(0, 120)}`);
    if (!result.action || result.action.kind !== "agent-start" || result.action.provider !== "codex") {
      throw new Error(`expected codex agent-start action, got ${JSON.stringify(result.action)}`);
    }
    if (result.sessionId && Array.isArray(result.turnIds)) {
      const turnIds = result.turnIds.filter((id): id is string => typeof id === "string");
      const chatPath = join(CHAT_DIR, `${result.sessionId}.json`);
      if (existsSync(chatPath)) {
        const chat = JSON.parse(readFileSync(chatPath, "utf8"));
        chat.turns = (chat.turns || []).filter((t: { id?: string }) => !t.id || !turnIds.includes(t.id));
        writeFileSync(chatPath, JSON.stringify(chat, null, 2) + "\n");
      }
    }
  });

  await check("Chat approve/delete intents propose confirmed actions", async () => {
    if (!TOKEN) {
      console.log("(skipped — no RDS_DASHBOARD_TOKEN env)");
      return;
    }
    const result = await page!.evaluate(async (id) => {
      const t = localStorage.getItem("rds_token") || "";
      const byBuild = await fetch(`/chat/sessions/by-build/${encodeURIComponent(id)}`, {
        method: "POST",
        headers: { "X-RDS-Token": t },
      });
      if (!byBuild.ok) return { ok: false, status: byBuild.status, body: await byBuild.text() };
      const session = (await byBuild.json()).session;
      const sent: Array<{ message: string; action?: { kind?: string }; turnIds: string[] }> = [];
      for (const message of ["approve this build", "delete the Zo service for this build"]) {
        const send = await fetch(`/chat/sessions/${encodeURIComponent(session.id)}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-RDS-Token": t },
          body: JSON.stringify({ message }),
        });
        if (!send.ok) return { ok: false, status: send.status, body: await send.text() };
        const fresh = await fetch(`/chat/sessions/${encodeURIComponent(session.id)}`);
        const data = await fresh.json();
        const last = data.session.turns[data.session.turns.length - 1];
        const prev = data.session.turns[data.session.turns.length - 2];
        sent.push({ message, action: last.action, turnIds: [prev?.id, last?.id].filter(Boolean) });
      }
      return { ok: true, sessionId: session.id, sent };
    }, selectedBuildId);
    if (!result.ok) throw new Error(`chat action proposal failed status=${result.status} body=${String(result.body || "").slice(0, 120)}`);
    const kinds = (result.sent || []).map((x: { action?: { kind?: string } }) => x.action?.kind).join(",");
    if (kinds !== "approve,delete-service") throw new Error(`expected approve,delete-service actions, got ${kinds}`);
    if (result.sessionId && Array.isArray(result.sent)) {
      const ids = result.sent.flatMap((x: { turnIds?: string[] }) => x.turnIds || []);
      const chatPath = join(CHAT_DIR, `${result.sessionId}.json`);
      if (existsSync(chatPath)) {
        const chat = JSON.parse(readFileSync(chatPath, "utf8"));
        chat.turns = (chat.turns || []).filter((t: { id?: string }) => !t.id || !ids.includes(t.id));
        writeFileSync(chatPath, JSON.stringify(chat, null, 2) + "\n");
      }
    }
  });

  await check("Chat session stream emits live session event", async () => {
    const sessionId = "selftest-stream";
    const chatPath = join(CHAT_DIR, `${sessionId}.json`);
    writeFileSync(chatPath, JSON.stringify({
      id: sessionId,
      title: "Selftest stream",
      created_at: Date.now(),
      updated_at: Date.now(),
      last_read_at: Date.now(),
      turns: []
    }, null, 2) + "\n");
    try {
      const result = await page!.evaluate(async (sid) => {
        return await new Promise<{ ok: boolean; event?: string; title?: string; error?: string }>((resolve) => {
          const ev = new EventSource(`/chat/sessions/${encodeURIComponent(sid)}/stream`);
          const timer = setTimeout(() => {
            ev.close();
            resolve({ ok: false, error: "timeout waiting for stream event" });
          }, 4000);
          ev.addEventListener("session", (msg) => {
            clearTimeout(timer);
            ev.close();
            const data = JSON.parse((msg as MessageEvent).data || "{}");
            resolve({ ok: true, event: "session", title: data.session?.title });
          });
          ev.onerror = () => {
            clearTimeout(timer);
            ev.close();
            resolve({ ok: false, error: "stream error" });
          };
        });
      }, sessionId);
      if (!result.ok || result.event !== "session" || result.title !== "Selftest stream") {
        throw new Error(`bad stream result ${JSON.stringify(result)}`);
      }
    } finally {
      if (existsSync(chatPath)) unlinkSync(chatPath);
    }
  });

  await check("Chat mobile layout has sticky composer and no horizontal overflow", async () => {
    await page!.setViewportSize({ width: 390, height: 780 });
    const res = await page!.goto(`${BASE}/chat`, { waitUntil: "domcontentloaded" });
    if (!res || res.status() >= 400) throw new Error(`status=${res?.status()}`);
    await page!.waitForSelector("#chat-form", { timeout: 3000 });
    const metrics = await page!.evaluate(() => {
      const form = document.querySelector("#chat-form") as HTMLElement | null;
      const rail = document.querySelector("#chat-sessions-rail") as HTMLElement | null;
      const style = form ? getComputedStyle(form) : null;
      return {
        scrollWidth: document.documentElement.scrollWidth,
        viewport: window.innerWidth,
        composerPosition: style?.position || "",
        composerBottom: form?.getBoundingClientRect().bottom ?? 0,
        viewportHeight: window.innerHeight,
        railDisplay: rail ? getComputedStyle(rail).display : "",
        hasFileInput: !!document.querySelector("#chat-file-input"),
        hasAttachmentTray: !!document.querySelector("#chat-attachments"),
      };
    });
    if (metrics.scrollWidth > metrics.viewport + 2) throw new Error(`horizontal overflow: ${JSON.stringify(metrics)}`);
    if (metrics.composerPosition !== "sticky") throw new Error(`composer not sticky: ${JSON.stringify(metrics)}`);
    if (Math.abs(metrics.viewportHeight - metrics.composerBottom) > 4) throw new Error(`composer not at bottom: ${JSON.stringify(metrics)}`);
    if (metrics.railDisplay !== "none") throw new Error(`mobile thread rail should be collapsed by default: ${JSON.stringify(metrics)}`);
    if (!metrics.hasFileInput || !metrics.hasAttachmentTray) throw new Error(`chat attachments UI missing: ${JSON.stringify(metrics)}`);
    await page!.getByRole("button", { name: "Threads" }).click();
    const openRail = await page!.locator("#chat-sessions-rail").evaluate((el) => getComputedStyle(el as HTMLElement).display);
    if (openRail !== "flex") throw new Error(`mobile thread rail did not open: ${openRail}`);
    await page!.setViewportSize({ width: 1280, height: 900 });
  });

  await check("Chat message accepts screenshot attachment context", async () => {
    const buildId = "_selftest-chat-attachment";
    const buildDir = join(BUILDS_DIR, buildId);
    rmSync(buildDir, { recursive: true, force: true });
    mkdirSync(buildDir, { recursive: true });
    writeFileSync(join(buildDir, "state.json"), JSON.stringify({ id: buildId, status: "pending-review", stage: "review" }, null, 2) + "\n");
    const result = await page!.evaluate(async () => {
      const create = await fetch(`/chat/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-RDS-Token": localStorage.getItem("rds_token") || "" },
        body: JSON.stringify({ title: "selftest attachment chat", build_id: "_selftest-chat-attachment" }),
      });
      if (!create.ok) return { ok: false, status: create.status, body: await create.text() };
      const session = (await create.json()).session;
      const fd = new FormData();
      fd.set("message", "fix the mobile layout using this screenshot as evidence");
      fd.append("attachments", new File(["fake image bytes"], "mobile-chat.png", { type: "image/png" }));
      const send = await fetch(`/chat/sessions/${encodeURIComponent(session.id)}/messages`, {
        method: "POST",
        headers: { "X-RDS-Token": localStorage.getItem("rds_token") || "" },
        body: fd,
      });
      const body = await send.text();
      const fresh = await fetch(`/chat/sessions/${encodeURIComponent(session.id)}`);
      const data = fresh.ok ? await fresh.json() : null;
      await fetch(`/chat/sessions/${encodeURIComponent(session.id)}`, {
        method: "DELETE",
        headers: { "X-RDS-Token": localStorage.getItem("rds_token") || "" },
      }).catch(() => {});
      const first = data?.session?.turns?.[0];
      return {
        ok: send.ok,
        status: send.status,
        body,
        attachmentName: first?.attachments?.[0]?.originalName || "",
        attachmentPath: first?.attachments?.[0]?.path || "",
        actionPrompt: data?.session?.turns?.[1]?.action?.prompt || "",
      };
    });
    try {
      if (!result.ok) throw new Error(`attachment send failed status=${result.status} body=${String(result.body).slice(0, 160)}`);
      if (result.attachmentName !== "mobile-chat.png") throw new Error(`bad attachment metadata: ${JSON.stringify(result)}`);
      if (!String(result.attachmentPath || "").includes("builds/_selftest-chat-attachment/chat-attachments")) throw new Error(`attachment not persisted in build artifacts: ${JSON.stringify(result)}`);
      if (!String(result.actionPrompt || "").includes("mobile-chat.png")) throw new Error(`attachment context missing from action prompt: ${JSON.stringify(result)}`);
    } finally {
      rmSync(buildDir, { recursive: true, force: true });
    }
  });

  await check("Chat action endpoint rejects missing write token", async () => {
    const res = await page!.evaluate(async () => {
      const original = localStorage.getItem("rds_token");
      localStorage.removeItem("rds_token");
      const denied = await fetch(`/chat/sessions/selftest-missing/actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ turn_id: "none", confirm: "RUN_ACTION" }),
      });
      if (original) localStorage.setItem("rds_token", original);
      return { status: denied.status, body: await denied.text() };
    });
    if (![401, 403].includes(res.status)) throw new Error(`expected auth denial, got ${res.status}: ${res.body.slice(0, 120)}`);
  });

  await check("rds-iterate refuses missing app_dest", async () => {
    const buildId = "_selftest-iterate-missing-app-dest";
    const buildDir = join(BUILDS_DIR, buildId);
    rmSync(buildDir, { recursive: true, force: true });
    mkdirSync(buildDir, { recursive: true });
    writeFileSync(join(buildDir, "state.json"), JSON.stringify({ id: buildId, inference: { provider: "codex" } }, null, 2) + "\n");
    try {
      const res = spawnSync(join(RDS_ROOT, "bin", "rds-iterate"), [buildId, "--prompt=make a harmless test change", "--no-qa", "--no-deploy"], {
        cwd: RDS_ROOT,
        encoding: "utf8",
        timeout: 10000,
      });
      if (res.status === 0) throw new Error("rds-iterate unexpectedly passed without app_dest");
      if (!`${res.stdout}\n${res.stderr}`.includes("no app_dest")) throw new Error(`unexpected output: ${res.stdout} ${res.stderr}`);
    } finally {
      rmSync(buildDir, { recursive: true, force: true });
    }
  });

  await check("rds-iterate failed checks do not redeploy", async () => {
    const buildId = "_selftest-iterate-failed-checks";
    const buildDir = join(BUILDS_DIR, buildId);
    const appDir = join(buildDir, "app");
    rmSync(buildDir, { recursive: true, force: true });
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(buildDir, "state.json"), JSON.stringify({ id: buildId, app_dest: appDir, inference: { provider: "codex" } }, null, 2) + "\n");
    writeFileSync(join(buildDir, "preview-url.txt"), "https://example.invalid/selftest\n");
    writeFileSync(join(appDir, "package.json"), JSON.stringify({ scripts: { build: "exit 7" } }, null, 2) + "\n");
    try {
      const res = spawnSync(join(RDS_ROOT, "bin", "rds-iterate"), [buildId, "--prompt=make a harmless test change", "--no-qa"], {
        cwd: RDS_ROOT,
        encoding: "utf8",
        timeout: 20000,
        env: { ...process.env, RDS_ITERATE_TEST_SKIP_APPLY: "1" },
      });
      if (res.status === 0) throw new Error("rds-iterate unexpectedly passed with failing checks");
      const preview = readFileSync(join(buildDir, "preview-url.txt"), "utf8").trim();
      if (preview !== "https://example.invalid/selftest") throw new Error(`preview changed after failed checks: ${preview}`);
      const files = spawnSync("bash", ["-lc", `find ${JSON.stringify(buildDir)} -name 'iterate-*.deploy.log' -print`], { encoding: "utf8" });
      if (files.stdout.trim()) throw new Error(`deploy log exists after failed checks: ${files.stdout}`);
    } finally {
      rmSync(buildDir, { recursive: true, force: true });
    }
  });

  await check("rds-iterate prompt includes structured QA repair context", async () => {
    const buildId = "_selftest-iterate-qa-context";
    const buildDir = join(BUILDS_DIR, buildId);
    const appDir = join(buildDir, "app");
    const qaDir = join(buildDir, "playwright", "iter-001");
    rmSync(buildDir, { recursive: true, force: true });
    mkdirSync(appDir, { recursive: true });
    mkdirSync(qaDir, { recursive: true });
    writeFileSync(join(buildDir, "state.json"), JSON.stringify({ id: buildId, app_dest: appDir, inference: { provider: "codex" } }, null, 2) + "\n");
    writeFileSync(join(appDir, "package.json"), JSON.stringify({ scripts: {} }, null, 2) + "\n");
    writeFileSync(join(qaDir, "truthfulness-verdict.json"), JSON.stringify({
      status: "fail",
      score: 40,
      failedRequiredCriteria: [{ name: "sample_data_labeled", evidence: "fake $1,800 spend appears without seeded-data disclosure" }],
    }, null, 2) + "\n");
    writeFileSync(join(qaDir, "persona-verdict.json"), JSON.stringify({
      status: "needs_iteration",
      score: 60,
      failedRequiredCriteria: [{ name: "operator_login_walkthrough", evidence: "no working review login path found" }],
    }, null, 2) + "\n");
    writeFileSync(join(qaDir, "prd-coverage-verdict.json"), JSON.stringify({
      status: "needs_iteration",
      score: 55,
      missingRouteFamilies: ["/sources"],
      missingActions: ["approve"],
      promiseLedger: [{
        id: "action:approve",
        kind: "action",
        promise: "Operator can approve a source-backed episode from the review queue",
        action: "approve",
        status: "missing",
        evidence: "No verified approve state transition evidence was captured",
        repairHint: "Implement the approve action and add visible confirmation that queue state changed.",
      }],
    }, null, 2) + "\n");
    writeFileSync(join(qaDir, "scenario-verdict.json"), JSON.stringify({
      status: "fail",
      scenarioCount: 1,
      blockingFailures: 1,
      checks: [{
        id: "operator-approve-episode",
        title: "Operator approves episode",
        status: "fail",
        evidence: "0/1 structured expectations passed",
        screenshots: ["scenario-operator-approve-episode.png"],
      }],
    }, null, 2) + "\n");
    try {
      const res = spawnSync(join(RDS_ROOT, "bin", "rds-iterate"), [buildId, "--prompt=repair the app", "--no-qa", "--no-deploy"], {
        cwd: RDS_ROOT,
        encoding: "utf8",
        timeout: 20000,
        env: { ...process.env, RDS_ITERATE_TEST_SKIP_APPLY: "1" },
      });
      if (res.status !== 0) throw new Error(`rds-iterate failed: ${res.stdout} ${res.stderr}`);
      const promptName = readdirSync(buildDir).find((name) => /^iterate-.*\.apply\.prompt\.md$/.test(name));
      if (!promptName) throw new Error("missing iterate apply prompt");
      const prompt = readFileSync(join(buildDir, promptName), "utf8");
      for (const needle of ["Latest failing QA repair context", "Autonomous repair plan", "truthfulness", "fake $1,800 spend", "persona", "operator_login_walkthrough", "prd_coverage", "/sources", "approve", "Operator can approve a source-backed episode", "Implement the approve action", "operator-approve-episode", "scenario-operator-approve-episode.png"]) {
        if (!prompt.includes(needle)) throw new Error(`prompt missing ${needle}`);
      }
      const planName = readdirSync(buildDir).find((name) => /^iterate-.*\.repair-plan\.json$/.test(name));
      if (!planName) throw new Error("missing iterate repair plan");
      const plan = JSON.parse(readFileSync(join(buildDir, planName), "utf8"));
      if (plan.schema !== "rds.iteration.repair-plan.v1") throw new Error(`bad repair plan schema: ${plan.schema}`);
      if ((plan.targets || []).length < 4) throw new Error(`repair plan too thin: ${JSON.stringify(plan)}`);
      for (const gate of ["truthfulness", "persona", "prd-coverage", "scenario"]) {
        if (!(plan.targets || []).some((target: any) => target.gate === gate)) throw new Error(`repair plan missing gate ${gate}`);
      }
      if (!(plan.targets || []).some((target: any) => target.promise?.includes("Operator can approve") && target.repairHint?.includes("approve action"))) {
        throw new Error(`repair plan missing row-level PRD promise: ${JSON.stringify(plan.targets || [])}`);
      }
      const jobsName = readdirSync(buildDir).find((name) => /^iterate-.*\.repair-jobs\.json$/.test(name));
      if (!jobsName) throw new Error("missing iterate repair jobs");
      const jobs = JSON.parse(readFileSync(join(buildDir, jobsName), "utf8"));
      if (jobs.schema !== "rds.iteration.repair-jobs.v1") throw new Error(`bad repair jobs schema: ${jobs.schema}`);
      const jobTypes = (jobs.jobs || []).map((job: any) => job.type);
      for (const type of ["truth_disclosure", "persona_path_repair", "prd_action_implementation", "workflow_behavior_repair"]) {
        if (!jobTypes.includes(type)) throw new Error(`repair jobs missing ${type}: ${JSON.stringify(jobs.jobs || [])}`);
      }
      if ((jobs.jobs || [])[0]?.type !== "truth_disclosure") throw new Error(`truth job should run first: ${JSON.stringify(jobs.jobs || [])}`);
      if (!prompt.includes("Ordered autonomous repair jobs") || !prompt.includes("prd_action_implementation")) {
        throw new Error("prompt missing ordered repair jobs context");
      }
      if (!(jobs.jobs || []).every((job: any) => job.status === "applied_unverified" && Array.isArray(job.filesTouched) && Array.isArray(job.checksRun))) {
        throw new Error(`repair jobs missing post-run trace fields: ${JSON.stringify(jobs.jobs || [])}`);
      }
      const summaryName = readdirSync(buildDir).find((name) => /^iterate-.*\.summary\.json$/.test(name));
      if (!summaryName) throw new Error("missing iterate summary");
      const summary = JSON.parse(readFileSync(join(buildDir, summaryName), "utf8"));
      if (!summary.repair_jobs || !summary.repair_jobs.endsWith(".repair-jobs.json")) {
        throw new Error(`summary missing repair_jobs artifact: ${JSON.stringify(summary)}`);
      }
    } finally {
      rmSync(buildDir, { recursive: true, force: true });
    }
  });

  await check("Completed chat action appends final summary once", async () => {
    const buildId = selectedBuildId;
    if (!buildId) throw new Error("no selected build id");
    const sessionId = "selftest-action-final";
    const turnId = "selftest-action-turn";
    const chatPath = join(CHAT_DIR, `${sessionId}.json`);
    const actionsDir = join(BUILDS_DIR, buildId, "actions");
    const actionPath = join(actionsDir, "action-selftest-final.json");
    mkdirSync(actionsDir, { recursive: true });
    writeFileSync(chatPath, JSON.stringify({
      id: sessionId,
      title: "Selftest action final",
      build_id: buildId,
      created_at: Date.now(),
      updated_at: Date.now(),
      last_read_at: Date.now(),
      turns: [{
        id: turnId,
        role: "rds",
        text: "test action",
        ts: Date.now(),
        status: "complete",
        action: {
          kind: "iterate",
          build_id: buildId,
          prompt: "test prompt",
          label: "Run controlled iteration",
          confirm_label: "Run",
          description: "test"
        }
      }]
    }, null, 2) + "\n");
    writeFileSync(actionPath, JSON.stringify({
      ok: true,
      status: "passed",
      phase: "complete",
      build_id: buildId,
      action_kind: "iterate",
      chat_session_id: sessionId,
      chat_turn_id: turnId,
      summary_file: `builds/${buildId}/iterate-selftest.summary.json`,
      repair_jobs: `builds/${buildId}/iterate-selftest.repair-jobs.json`,
      repair_convergence: `builds/${buildId}/iterate-selftest.repair-convergence.json`,
      preview_url: "",
      updated_at: new Date().toISOString()
    }, null, 2) + "\n");
    try {
      const result = await page!.evaluate(async (sid) => {
        const first = await fetch(`/chat/sessions/${encodeURIComponent(sid)}`);
        const one = await first.json();
        const second = await fetch(`/chat/sessions/${encodeURIComponent(sid)}`);
        const two = await second.json();
        return {
          firstTurns: one.session.turns.length,
          secondTurns: two.session.turns.length,
          finalText: two.session.turns[two.session.turns.length - 1].text,
          finalId: two.session.turns[two.session.turns.length - 1].id,
          actionRun: two.session.turns[0].action.action_run,
          finalized: two.session.turns[0].action.action_status.final_chat_turn_id,
        };
      }, sessionId);
      if (result.firstTurns !== 2 || result.secondTurns !== 2) throw new Error(`expected exactly one final turn, got ${result.firstTurns}/${result.secondTurns}`);
      if (!String(result.finalText || "").includes("Action passed")) throw new Error(`missing final summary: ${result.finalText}`);
      if (!String(result.finalText || "").includes("Repair jobs:")) throw new Error(`missing repair jobs link: ${result.finalText}`);
      if (!String(result.finalText || "").includes("Repair convergence:")) throw new Error(`missing repair convergence link: ${result.finalText}`);
      if (!result.actionRun || !result.finalized || result.finalized !== result.finalId) throw new Error(`missing action linkage ${JSON.stringify(result)}`);
    } finally {
      if (existsSync(chatPath)) unlinkSync(chatPath);
      if (existsSync(actionPath)) unlinkSync(actionPath);
    }
  });

  await check("Playwright page explains iteration scope", async () => {
    const buildId = selectedBuildId;
    if (!buildId) throw new Error("no selected build id");
    const res = await page!.goto(`${BASE}/b/${encodeURIComponent(buildId)}/playwright`, { waitUntil: "domcontentloaded" });
    if (!res || res.status() >= 400) throw new Error(`status=${res?.status()}`);
    await page!.waitForSelector("text=not capped at three", { timeout: 3000 });
    await page!.waitForSelector("text=semantic audit", { timeout: 3000 });
  });

  await check("Status action returns 2xx with state.json shape", async () => {
    if (!TOKEN) {
      console.log("(skipped — no RDS_DASHBOARD_TOKEN env)");
      return;
    }
    // Use the page so the request sends localStorage token via X-RDS-Token.
    const result = await page!.evaluate(async (id) => {
      const t = localStorage.getItem("rds_token") || "";
      const res = await fetch(`/b/${id}/cmd`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-RDS-Token": t },
        body: JSON.stringify({ verb: "status" }),
      });
      const body = await res.text();
      return { status: res.status, ok: res.ok, body };
    }, selectedBuildId);
    if (result.status >= 400 || !result.ok) throw new Error(`cmd status=${result.status} ok=${result.ok} body=${result.body.slice(0, 120)}`);
  });

  await shot("99-final");
  await browser.close();

  if (failures.length) {
    console.log(`\n[rds-selftest] ${failures.length} failure(s):`);
    for (const f of failures) console.log(`  - ${f}`);
    writeFileSync(join(outDir, "failures.txt"), failures.join("\n") + "\n");
    writeResult("failed");
    process.exit(1);
  }
  writeResult("passed");
  console.log(`\n[rds-selftest] all checks passed (artifacts: ${outDir})`);
}

main().catch(async (e) => {
  console.error("[rds-selftest] fatal:", e);
  failures.push(`fatal: ${(e as Error).message}`);
  writeResult("fatal");
  await shot("fatal");
  if (browser) await browser.close().catch(() => {});
  process.exit(2);
});
