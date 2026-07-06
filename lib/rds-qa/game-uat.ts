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
const PLAYTEST_MS = Math.min(Math.max(Number(arg("playtest-ms", process.env.RDS_GAME_UAT_PLAYTEST_MS || "12000")), 5000), 90000);

if (!BASE_URL || !OUT_DIR) {
  console.error("FATAL: --base-url and --out-dir are required");
  process.exit(2);
}

mkdirSync(OUT_DIR, { recursive: true });

async function signature(page: Page): Promise<string> {
  return page.evaluate(() => {
    const text = document.body?.innerText || "";
    const canvases = Array.from(document.querySelectorAll("canvas")).slice(0, 3).map((canvas) => {
      try {
        const ctx = (canvas as HTMLCanvasElement).getContext("2d", { willReadFrequently: true });
        if (!ctx) return "";
        const width = (canvas as HTMLCanvasElement).width;
        const height = (canvas as HTMLCanvasElement).height;
        const sample = ctx.getImageData(0, 0, width, height).data;
        let hash = 2166136261;
        const stride = Math.max(4, Math.floor(sample.length / 5000));
        for (let i = 0; i < sample.length; i += stride) {
          hash ^= sample[i];
          hash = Math.imul(hash, 16777619);
        }
        return `${width}x${height}:${hash >>> 0}`;
      } catch {
        return "";
      }
    });
    const controls = Array.from(document.querySelectorAll("button, a, input, [role=button]"))
      .map((el) => (el.textContent || el.getAttribute("aria-label") || "").trim())
      .filter(Boolean)
      .join("|");
    return JSON.stringify({ href: location.href, text: text.slice(0, 4000), controls, canvases });
  });
}

async function visibleText(page: Page): Promise<string> {
  return page.evaluate(() => (document.body?.innerText || "").toLowerCase()).catch(() => "");
}

function scoreItem(ok: boolean, points: number): number {
  return ok ? points : 0;
}

type PlaytestPhase = {
  phase: string;
  actions: string[];
  before: string;
  after: string;
  changed: boolean;
  elapsedMs: number;
  screenshot?: string;
};

async function capturePhase(page: Page, outDir: string, phase: string, actions: string[], run: () => Promise<void>): Promise<PlaytestPhase> {
  const before = await signature(page).catch(() => "");
  const started = Date.now();
  await run().catch(() => {});
  await page.waitForTimeout(350);
  const after = await signature(page).catch(() => "");
  const screenshot = `game-phase-${phase.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.png`;
  await page.screenshot({ path: join(outDir, screenshot), fullPage: true }).catch(() => {});
  return {
    phase,
    actions,
    before,
    after,
    changed: !!before && !!after && before !== after,
    elapsedMs: Date.now() - started,
    screenshot,
  };
}

async function runSustainedPlaytest(page: Page, outDir: string, baseUrl: string): Promise<PlaytestPhase[]> {
  const phases: PlaytestPhase[] = [];
  await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: TIMEOUT }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 2500 }).catch(() => {});

  phases.push(await capturePhase(page, outDir, "start", ["click start/play or canvas center"], async () => {
    const button = page.getByRole("button", { name: /start|play|new game|restart|again/i }).first();
    const link = page.getByRole("link", { name: /start|play|new game|quick play|restart|again/i }).first();
    if (await button.count().catch(() => 0)) {
      await button.click({ timeout: 1500 });
    } else if (await link.count().catch(() => 0)) {
      await link.click({ timeout: 1500 });
    } else {
      await page.mouse.click(640, 400);
    }
  }));

  phases.push(await capturePhase(page, outDir, "movement", ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"], async () => {
    for (const key of ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"]) {
      await page.keyboard.press(key);
      await page.waitForTimeout(220);
    }
  }));

  phases.push(await capturePhase(page, outDir, "primary-action", ["Space", "Enter", "canvas tap"], async () => {
    await page.keyboard.press("Space");
    await page.waitForTimeout(220);
    await page.keyboard.press("Enter");
    const box = await page.locator("canvas").first().boundingBox().catch(() => null);
    if (box) await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
  }));

  const escalationEnd = Date.now() + PLAYTEST_MS;
  const escalationActions: string[] = [];
  phases.push(await capturePhase(page, outDir, "sustained-play", [`${PLAYTEST_MS}ms scripted play`], async () => {
    const keys = ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Space"];
    let index = 0;
    while (Date.now() < escalationEnd) {
      const key = keys[index % keys.length];
      escalationActions.push(key);
      await page.keyboard.press(key);
      await page.waitForTimeout(300);
      index += 1;
    }
  }));
  phases.at(-1)!.actions = escalationActions.slice(0, 40);

  phases.push(await capturePhase(page, outDir, "restart", ["KeyR", "click restart/again if visible"], async () => {
    await page.keyboard.press("KeyR");
    const button = page.getByRole("button", { name: /restart|again|new game|play/i }).first();
    const link = page.getByRole("link", { name: /restart|again|new game|play/i }).first();
    if (await button.count().catch(() => 0)) {
      await button.click({ timeout: 1200 }).catch(() => {});
    } else if (await link.count().catch(() => 0)) {
      await link.click({ timeout: 1200 }).catch(() => {});
    }
  }));

  return phases;
}

function scoreBand(value: number, max: number): number {
  return Math.round((value / Math.max(1, max)) * 100);
}

async function run() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();
  const consoleErrors: string[] = [];
  // Suppress Next.js HMR / Turbopack websocket chatter (see workflow-uat).
  const HMR_NOISE = /\b(\[hmr\]|webpack-hmr|__webpack_hmr|turbopack|hmr (?:listener|update|handler) error|hmr-client|fast refresh|hydration mismatch)\b/i;
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text().slice(0, 500);
    if (HMR_NOISE.test(text)) return;
    consoleErrors.push(text);
  });

  const startedAt = new Date().toISOString();
  const response = await page.goto(BASE_URL!, { waitUntil: "domcontentloaded", timeout: TIMEOUT });
  await page.waitForLoadState("networkidle", { timeout: 2500 }).catch(() => {});
  await page.screenshot({ path: join(OUT_DIR!, "game-start.png"), fullPage: true }).catch(() => {});

  const hasCanvas = await page.locator("canvas").count().then((n) => n > 0).catch(() => false);
  const text0 = await visibleText(page);
  const before = await signature(page);
  const scenarios = loadScenarioSummary(SCENARIOS_PATH);
  const scenarioVerdict = await executeScenarioChecks(page, BASE_URL!, SCENARIOS_PATH, OUT_DIR!);
  writeScenarioVerdict(OUT_DIR!, scenarioVerdict);
  await page.goto(BASE_URL!, { waitUntil: "domcontentloaded", timeout: TIMEOUT }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 2500 }).catch(() => {});
  const playtest = await runSustainedPlaytest(page, OUT_DIR!, BASE_URL!);

  const startControl = page.getByRole("button", { name: /start|play|new game|restart|again/i }).first();
  const startLink = page.getByRole("link", { name: /start|play|new game|quick play|restart|again/i }).first();
  let startClicked = false;
  if (await startControl.count().catch(() => 0)) {
    await startControl.click({ timeout: 1500 }).then(() => { startClicked = true; }).catch(() => {});
  } else if (await startLink.count().catch(() => 0)) {
    await startLink.click({ timeout: 1500 }).then(() => { startClicked = true; }).catch(() => {});
  } else {
    await page.mouse.click(640, 400).catch(() => {});
  }

  const signatures = new Set<string>([before]);
  let meaningfulActions = 0;
  async function recordAction(action: () => Promise<void>) {
    const prev = await signature(page).catch(() => "");
    await action().catch(() => {});
    await page.waitForTimeout(450);
    const next = await signature(page).catch(() => "");
    signatures.add(next);
    if (prev && next && prev !== next) meaningfulActions += 1;
  }

  const canvasBox = await page.locator("canvas").first().boundingBox().catch(() => null);
  if (canvasBox) {
    const points = [
      [0.25, 0.25],
      [0.5, 0.5],
      [0.75, 0.75],
      [0.35, 0.65],
    ];
    for (const [px, py] of points) {
      await recordAction(() => page.mouse.click(canvasBox.x + canvasBox.width * px, canvasBox.y + canvasBox.height * py));
    }
  }
  for (const key of ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Space", "Enter"]) {
    await recordAction(() => page.keyboard.press(key));
  }
  const playableButtons = page.getByRole("button").filter({ hasText: /play|start|quick|move|next|confirm|end|pass|undo|restart|reset/i });
  const buttonCount = Math.min(4, await playableButtons.count().catch(() => 0));
  for (let i = 0; i < buttonCount; i += 1) {
    await recordAction(() => playableButtons.nth(i).click({ timeout: 1000 }));
  }

  await page.keyboard.press("Enter").catch(() => {});
  await page.keyboard.press("ArrowRight").catch(() => {});
  await page.keyboard.press("ArrowDown").catch(() => {});
  await page.keyboard.press("Space").catch(() => {});
  await page.waitForTimeout(1200);
  const afterAction = await signature(page);
  await page.screenshot({ path: join(OUT_DIR!, "game-after-action.png"), fullPage: true }).catch(() => {});

  await page.keyboard.press("ArrowLeft").catch(() => {});
  await page.keyboard.press("ArrowUp").catch(() => {});
  await page.keyboard.press("Space").catch(() => {});
  await page.waitForTimeout(3500);
  const afterWait = await signature(page);
  await page.screenshot({ path: join(OUT_DIR!, "game-after-wait.png"), fullPage: true }).catch(() => {});

  await page.keyboard.press("KeyR").catch(() => {});
  await page.waitForTimeout(700);
  const afterRestart = await signature(page);
  await page.screenshot({ path: join(OUT_DIR!, "game-after-restart-key.png"), fullPage: true }).catch(() => {});

  const text = `${text0}\n${await visibleText(page)}`;
  const playtestChangedPhases = playtest.filter((phase) => phase.changed).length;
  const playtestScreenshots = playtest.map((phase) => phase.screenshot).filter(Boolean) as string[];
  const changedAfterAction = afterAction !== before;
  const changedOverTime = afterWait !== afterAction;
  const restartChanged = afterRestart !== afterWait;
  const hasScore = /\b(score|points|high score|level|wave|lives|health|timer|time)\b/i.test(text);
  const hasControls = /\b(start|play|restart|arrow|wasd|space|move|controls|keyboard|touch|tap|click)\b/i.test(text) || startClicked;
  const hasFailureLoop = /\b(game over|restart|try again|lives|health|win|lose|lost)\b/i.test(text) || restartChanged;
  const hasPressureText = /\b(enemy|enemies|hazard|wave|level|timer|chase|boss|obstacle|difficulty)\b/i.test(text);
  const playedMultipleActions = meaningfulActions >= 2 && signatures.size >= 3;
  const sustainedPlayOk = playtest.length >= 5 && playtestChangedPhases >= 4;
  const statusOk = (response?.status() || 0) < 400;
  const noConsoleErrors = consoleErrors.length === 0;

  const subScores = {
    clarity: scoreBand([hasControls, hasScore, hasFailureLoop].filter(Boolean).length, 3),
    controlFeel: scoreBand([changedAfterAction, playedMultipleActions, sustainedPlayOk].filter(Boolean).length, 3),
    feedback: scoreBand([changedAfterAction, changedOverTime, playtestChangedPhases >= 3].filter(Boolean).length, 3),
    challenge: scoreBand([hasPressureText, changedOverTime, sustainedPlayOk].filter(Boolean).length, 3),
    progression: scoreBand([hasScore, changedOverTime, playtestChangedPhases >= 4].filter(Boolean).length, 3),
    replayability: scoreBand([hasFailureLoop, restartChanged, playtest.some((phase) => phase.phase === "restart" && phase.changed)].filter(Boolean).length, 3),
    visualSpecificity: scoreBand([hasCanvas, signatures.size >= 4, playtestScreenshots.length >= 5].filter(Boolean).length, 3),
  };

  const criteria = [
    { name: "page_loads", ok: statusOk, points: 10, evidence: `HTTP ${response?.status() || 0}` },
    { name: "game_surface", ok: hasCanvas || text.length > 80, points: 10, evidence: hasCanvas ? "canvas present" : "DOM game surface present" },
    { name: "controls_discoverable", ok: hasControls, points: 15, evidence: hasControls ? "control/start text or start button present" : "no visible control/start affordance found" },
    { name: "responds_to_input", ok: changedAfterAction, points: 20, evidence: changedAfterAction ? "state changed after click/keyboard input" : "no visible DOM/canvas change after input" },
    { name: "keeps_animating_or_escalates", ok: changedOverTime, points: 15, evidence: changedOverTime ? "state changed over time" : "no visible state change over wait period" },
    { name: "scoring_or_progression_visible", ok: hasScore, points: 15, evidence: hasScore ? "score/progression language visible" : "no score/progression signal visible" },
    { name: "failure_restart_loop", ok: hasFailureLoop, points: 10, evidence: hasFailureLoop ? "failure/restart signal found" : "no failure/restart signal found" },
    { name: "pressure_signal", ok: hasPressureText || changedOverTime, points: 5, evidence: hasPressureText ? "pressure language visible" : "runtime movement used as pressure proxy" },
    { name: "play_session_depth", ok: playedMultipleActions, points: 15, evidence: playedMultipleActions ? `${meaningfulActions} meaningful actions, ${signatures.size} unique runtime states` : `only ${meaningfulActions} meaningful actions and ${signatures.size} unique runtime states` },
    { name: "sustained_playtest", ok: sustainedPlayOk, points: 20, evidence: sustainedPlayOk ? `${playtestChangedPhases}/${playtest.length} scripted phases changed observable state over ${PLAYTEST_MS}ms` : `only ${playtestChangedPhases}/${playtest.length} scripted phases changed observable state` },
    { name: "no_console_errors", ok: noConsoleErrors, points: 10, evidence: noConsoleErrors ? "no console errors" : consoleErrors.slice(0, 3).join(" | ") },
    { name: "prd_scenarios_available", ok: scenarios.available && scenarios.count >= 3, points: 10, evidence: scenarios.available ? `${scenarios.count} QA scenarios loaded` : "qa-scenarios.json missing" },
    { name: "prd_scenarios_executed", ok: scenarioVerdict.status === "pass", points: 15, evidence: scenarioVerdict.status === "pass" ? `${scenarioVerdict.scenarioCount} scenario journeys passed` : `${scenarioVerdict.blockingFailures} blocking scenario failures` },
  ];
  const rawScore = criteria.reduce((sum, c) => sum + scoreItem(c.ok, c.points), 0);
  const maxScore = criteria.reduce((sum, c) => sum + c.points, 0);
  const score = Math.round((rawScore / Math.max(1, maxScore)) * 100);
  const requiredCriteria = new Set([
    "page_loads",
    "game_surface",
    "controls_discoverable",
    "responds_to_input",
    "keeps_animating_or_escalates",
    "scoring_or_progression_visible",
    "failure_restart_loop",
    "pressure_signal",
    "play_session_depth",
    "sustained_playtest",
    "no_console_errors",
    "prd_scenarios_executed",
  ]);
  const failedRequired = criteria.filter((item) => requiredCriteria.has(item.name) && !item.ok);
  const status = failedRequired.length > 0
    ? (score >= 55 ? "needs_iteration" : "fail")
    : (score >= 75 ? "pass" : score >= 55 ? "needs_iteration" : "fail");
  const payload = {
    schema: "rds.qa.game-uat.v1",
    status,
    score,
    threshold: 75,
    baseUrl: BASE_URL,
    startedAt,
    finishedAt: new Date().toISOString(),
    criteria,
    scenarios,
    scenarioVerdict,
    playtest: {
      durationMs: PLAYTEST_MS,
      changedPhases: playtestChangedPhases,
      phases: playtest.map((phase) => ({
        phase: phase.phase,
        actions: phase.actions,
        changed: phase.changed,
        elapsedMs: phase.elapsedMs,
        screenshot: phase.screenshot,
      })),
    },
    subScores,
    failedRequiredCriteria: failedRequired.map((item) => ({
      name: item.name,
      evidence: item.evidence,
    })),
    screenshots: [
      "game-start.png",
      "game-after-action.png",
      "game-after-wait.png",
      "game-after-restart-key.png",
      "scenario-verdict.json",
      ...playtestScreenshots,
    ],
    limitations: [
      "Deterministic v1 game UAT checks observable runtime signals. It does not replace human taste review.",
      "Canvas-only games may need explicit HUD/control text for stronger verification.",
    ],
  };

  writeFileSync(join(OUT_DIR!, "game-verdict.json"), JSON.stringify(payload, null, 2));
  console.log(JSON.stringify({ status, score, path: join(OUT_DIR!, "game-verdict.json") }));
  await context.close();
  await browser.close();
  process.exit(status === "pass" ? 0 : 1);
}

run().catch((err) => {
  console.error("[game-uat] FATAL:", err);
  process.exit(2);
});
