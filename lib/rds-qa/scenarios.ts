import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright";

export type ScenarioSummary = {
  available: boolean;
  count: number;
  titles: string[];
};

export type QaScenario = {
  id?: string;
  title: string;
  objective?: string;
  mustVerify?: string[];
  actions?: ScenarioAction[];
  expectations?: ScenarioExpectation[];
  blockingIfMissing?: boolean;
  screenshot?: boolean;
};

export type ScenarioAction = {
  type: "click" | "fill" | "press" | "goto" | "wait";
  target?: string;
  value?: string;
  key?: string;
  ms?: number;
};

export type ScenarioExpectation = {
  type: "text" | "url" | "state-change" | "visible" | "business-state";
  target?: string;
  value?: string;
};

export type ScenarioFailureKind = "product_behavior" | "scenario_brittle" | "missing_evidence" | "ambiguous";

export type ScenarioTranscriptStep = {
  step: string;
  status: "pass" | "fail";
  detail: string;
};

export type ScenarioCheck = {
  id: string;
  title: string;
  status: "pass" | "fail";
  evidence: string;
  actionTaken?: string;
  transcript?: ScenarioTranscriptStep[];
  screenshots?: string[];
  urlBefore?: string;
  urlAfter?: string;
  assertionType?: string;
  failureKind?: ScenarioFailureKind;
  recoveryHint?: string;
  blocking: boolean;
};

export type ScenarioVerdict = {
  schema: "rds.qa.scenario-verdict.v1";
  status: "pass" | "fail" | "missing";
  baseUrl: string;
  scenarioCount: number;
  blockingFailures: number;
  failureBreakdown?: Record<ScenarioFailureKind, number>;
  checks: ScenarioCheck[];
};

const STOP_WORDS = new Set([
  "about", "across", "action", "actions", "after", "again", "against", "allows", "before",
  "blocking", "button", "changes", "clear", "click", "complete", "confirm", "controls",
  "could", "first", "flow", "from", "hero", "into", "main", "must", "normal", "open",
  "page", "primary", "reaches", "result", "review", "screen", "selected", "state", "team",
  "that", "the", "then", "through", "user", "verify", "visible", "visitor", "with",
]);

export function loadScenarioSummary(path?: string): ScenarioSummary {
  const scenarios = loadScenarios(path);
  if (!scenarios.length) return { available: false, count: 0, titles: [] };
  return {
    available: true,
    count: scenarios.length,
    titles: scenarios.map((item) => item.title).filter(Boolean).slice(0, 8),
  };
}

export function loadScenarios(path?: string): QaScenario[] {
  if (!path || !existsSync(path)) return [];
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    const scenarios = Array.isArray(data.scenarios) ? data.scenarios : [];
    return scenarios
      .map((item: any) => ({
        id: String(item?.id || ""),
        title: String(item?.title || "").trim(),
        objective: String(item?.objective || "").trim(),
        mustVerify: Array.isArray(item?.mustVerify) ? item.mustVerify.map((v: any) => String(v || "").trim()).filter(Boolean) : [],
        actions: normalizeActions(item?.actions),
        expectations: normalizeExpectations(item?.expectations),
        blockingIfMissing: item?.blockingIfMissing !== false,
        screenshot: item?.screenshot !== false,
      }))
      .filter((item: QaScenario) => item.title);
  } catch {
    return [];
  }
}

function normalizeActions(value: unknown): ScenarioAction[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((raw: any) => {
      const type = String(raw?.type || "").trim().toLowerCase();
      if (!["click", "fill", "press", "goto", "wait"].includes(type)) return null;
      return {
        type: type as ScenarioAction["type"],
        target: String(raw?.target || "").trim(),
        value: String(raw?.value || "").trim(),
        key: String(raw?.key || "").trim(),
        ms: Number(raw?.ms || 0),
      };
    })
    .filter(Boolean) as ScenarioAction[];
}

function normalizeExpectations(value: unknown): ScenarioExpectation[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((raw: any) => {
      const type = String(raw?.type || "").trim().toLowerCase();
      if (!["text", "url", "state-change", "visible", "business-state"].includes(type)) return null;
      return {
        type: type as ScenarioExpectation["type"],
        target: String(raw?.target || "").trim(),
        value: String(raw?.value || "").trim(),
      };
    })
    .filter(Boolean) as ScenarioExpectation[];
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "scenario";
}

function keywordsFor(scenario: QaScenario): string[] {
  const text = [scenario.title, scenario.objective, ...(scenario.mustVerify || [])].join(" ").toLowerCase();
  const words = text.match(/[a-z0-9]{4,}/g) || [];
  const expanded = new Set<string>();
  for (const word of words) {
    if (!STOP_WORDS.has(word)) expanded.add(word);
    if (word === "demo") expanded.add("contact");
    if (word === "started") expanded.add("start");
    if (word === "studies") expanded.add("case");
  }
  return Array.from(expanded).slice(0, 10);
}

function expectsAction(scenario: QaScenario): boolean {
  const text = [scenario.title, scenario.objective, ...(scenario.mustVerify || [])].join(" ").toLowerCase();
  return /\b(open|click|tap|book|contact|pricing|work|case|demo|approve|reject|export|start|play|move|restart|create|save|filter|search|submit|navigate)\b/.test(text);
}

function scenarioAssertionType(scenario: QaScenario): string {
  const types = new Set((scenario.expectations || []).map((item) => item.type));
  if (types.has("business-state")) return "business-state";
  if (types.has("state-change")) return "state-change";
  if (types.has("url")) return "navigation";
  if (types.has("visible") || types.has("text")) return "content";
  if (scenario.actions?.length) return "state-change";
  return expectsAction(scenario) ? "interaction" : "first-viewport";
}

function classifyScenarioFailure(scenario: QaScenario, evidence: string, transcript: ScenarioTranscriptStep[] = []): { failureKind: ScenarioFailureKind; recoveryHint: string } {
  const assertionType = scenarioAssertionType(scenario);
  const joined = [evidence, ...transcript.map((item) => `${item.step} ${item.detail}`)].join(" ").toLowerCase();
  if (!scenario.title || (!scenario.actions?.length && !scenario.expectations?.length && !expectsAction(scenario))) {
    return {
      failureKind: "missing_evidence",
      recoveryHint: "Strengthen qa-scenarios.json with executable actions or explicit expectations before treating this as an app defect.",
    };
  }
  if (/\b(no visible clickable target matched|no input target matched|generic action target|text only|keywords: none)\b/.test(joined)) {
    return {
      failureKind: "scenario_brittle",
      recoveryHint: "Tighten the scenario target/selector or regenerate a more specific scenario; do not spend app iteration budget on vague QA wording.",
    };
  }
  if (/\b(no matching visible control|href is missing|no-op|page signature did not change|did not find|text missing|0 matches)\b/.test(joined)) {
    return {
      failureKind: "product_behavior",
      recoveryHint: `Repair the app so the ${assertionType} expectation is visibly satisfied, then rerun browser QA.`,
    };
  }
  return {
    failureKind: "ambiguous",
    recoveryHint: "Review screenshot, transcript, and scenario wording before deciding whether to patch the app or recalibrate QA.",
  };
}

function failScenario(check: ScenarioCheck, scenario: QaScenario, evidence: string, transcript: ScenarioTranscriptStep[] = []): ScenarioCheck {
  const classification = classifyScenarioFailure(scenario, evidence, transcript);
  return {
    ...check,
    status: "fail",
    evidence,
    assertionType: scenarioAssertionType(scenario),
    failureKind: classification.failureKind,
    recoveryHint: classification.recoveryHint,
  };
}

async function pageSignature(page: Page): Promise<string> {
  return page.evaluate(() => JSON.stringify({
    href: location.href,
    text: (document.body?.innerText || "").slice(0, 5000),
    inputs: Array.from(document.querySelectorAll("input,textarea,select")).map((el) => (el as HTMLInputElement).value || "").join("|"),
    canvases: Array.from(document.querySelectorAll("canvas")).slice(0, 2).map((canvas) => {
      try {
        return (canvas as HTMLCanvasElement).toDataURL("image/png").slice(0, 5000);
      } catch {
        return "";
      }
    }),
  })).catch(() => "");
}

async function visibleSummary(page: Page): Promise<{ textLength: number; h1Count: number }> {
  return page.evaluate(() => ({
    textLength: (document.body?.innerText || "").trim().length,
    h1Count: document.querySelectorAll("h1").length,
  })).catch(() => ({ textLength: 0, h1Count: 0 }));
}

async function bestInteractive(page: Page, keywords: string[]): Promise<{ index: number; label: string; href: string | null; score: number } | null> {
  const controls = page.locator("a,button,[role=button],[role=link],input,select,textarea");
  const count = Math.min(40, await controls.count().catch(() => 0));
  let best: { index: number; label: string; href: string | null; score: number } | null = null;
  for (let i = 0; i < count; i += 1) {
    const item = controls.nth(i);
    if (!(await item.isVisible().catch(() => false))) continue;
    const label = [
      await item.innerText().catch(() => ""),
      await item.getAttribute("aria-label").catch(() => ""),
      await item.getAttribute("placeholder").catch(() => ""),
      await item.getAttribute("href").catch(() => ""),
    ].filter(Boolean).join(" ").toLowerCase();
    if (!label.trim()) continue;
    let score = 0;
    for (const keyword of keywords) {
      if (label.includes(keyword)) score += keyword.length >= 7 ? 3 : 2;
    }
    if (/\b(start|play|restart|contact|pricing|work|case|demo|approve|reject|export|save|submit)\b/.test(label)) score += 1;
    if (score > (best?.score || 0)) {
      best = {
        index: i,
        label: label.replace(/\s+/g, " ").trim().slice(0, 120),
        href: await item.getAttribute("href").catch(() => null),
        score,
      };
    }
  }
  return best && best.score > 0 ? best : null;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function targetLabel(target?: string): RegExp {
  const text = (target || "").trim();
  if (!text) return /./;
  const options = text.split("|").map((item) => item.trim()).filter(Boolean).map(escapeRegExp);
  return options.length ? new RegExp(options.join("|"), "i") : /./;
}

async function clickTarget(page: Page, target: string): Promise<string> {
  const byRole = page.getByRole("button", { name: targetLabel(target) })
    .or(page.getByRole("link", { name: targetLabel(target) }));
  if (await byRole.count().catch(() => 0)) {
    await byRole.first().click({ timeout: 2000 });
    return `clicked "${target}"`;
  }
  const textMatches = page.getByText(targetLabel(target));
  const count = Math.min(20, await textMatches.count().catch(() => 0));
  for (let i = 0; i < count; i += 1) {
    const item = textMatches.nth(i);
    const interactive = item.locator("xpath=ancestor-or-self::*[self::button or self::a or @role='button' or @role='link']").first();
    if (await interactive.count().catch(() => 0)) {
      await interactive.click({ timeout: 2000 });
      return `clicked interactive text "${target}"`;
    }
  }
  throw new Error(`no visible clickable target matched "${target}"`);
}

async function fillTarget(page: Page, target: string, value: string): Promise<string> {
  const locator = page.getByLabel(targetLabel(target))
    .or(page.getByPlaceholder(targetLabel(target)))
    .or(page.locator(`input[name="${target}"], textarea[name="${target}"]`).first());
  if (await locator.count().catch(() => 0)) {
    await locator.first().fill(value || "RDS QA scenario", { timeout: 2000 });
    return `filled "${target}"`;
  }
  throw new Error(`no input target matched "${target}"`);
}

async function checkExpectation(page: Page, expectation: ScenarioExpectation, beforeSignature: string, transcript: ScenarioTranscriptStep[]): Promise<boolean> {
  try {
    if (expectation.type === "business-state") {
      const target = expectation.target || "";
      const value = expectation.value || "";
      const result = await page.evaluate(({ target, value }) => {
        const normalize = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();
        const targetText = normalize(target);
        const valueText = normalize(value);
        if (!valueText) return { ok: false, detail: "missing expected state value" };
        const bodyText = normalize(document.body?.innerText || "");
        if (!targetText) {
          return { ok: bodyText.includes(valueText), detail: bodyText.includes(valueText) ? `found state "${value}"` : `missing state "${value}"` };
        }
        const blocks = Array.from(document.querySelectorAll("tr, li, article, section, [role=row], [data-testid], div"));
        for (const block of blocks) {
          const text = normalize((block as HTMLElement).innerText || block.textContent || "");
          if (!text || text.length > 1200) continue;
          if (text.includes(targetText) && text.includes(valueText)) {
            return { ok: true, detail: `found "${target}" with state "${value}" in same UI block` };
          }
        }
        const targetIndex = bodyText.indexOf(targetText);
        const valueIndex = bodyText.indexOf(valueText);
        const close = targetIndex >= 0 && valueIndex >= 0 && Math.abs(targetIndex - valueIndex) <= 300;
        return { ok: close, detail: close ? `found "${target}" near "${value}"` : `did not find "${target}" with state "${value}"` };
      }, { target, value }).catch((err) => ({ ok: false, detail: String(err).slice(0, 160) }));
      transcript.push({ step: `expect business-state ${target} => ${value}`, status: result.ok ? "pass" : "fail", detail: result.detail });
      return result.ok;
    }
    if (expectation.type === "state-change") {
      const after = await pageSignature(page);
      const ok = beforeSignature !== after;
      transcript.push({ step: "expect state-change", status: ok ? "pass" : "fail", detail: ok ? "page signature changed" : "page signature did not change" });
      return ok;
    }
    if (expectation.type === "url") {
      const needle = expectation.value || expectation.target || "";
      const ok = !!needle && page.url().toLowerCase().includes(needle.toLowerCase());
      transcript.push({ step: `expect url ${needle}`, status: ok ? "pass" : "fail", detail: page.url() });
      return ok;
    }
    if (expectation.type === "visible") {
      const target = expectation.target || expectation.value || "";
      const count = await page.getByText(targetLabel(target)).count().catch(() => 0);
      const ok = count > 0;
      transcript.push({ step: `expect visible ${target}`, status: ok ? "pass" : "fail", detail: `${count} matches` });
      return ok;
    }
    const needle = expectation.value || expectation.target || "";
    const text = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
    const normalizedText = text.toLowerCase();
    const terms = needle
      .split("|")
      .map((term) => term.trim().toLowerCase())
      .filter(Boolean);
    const ok = terms.length > 1
      ? terms.every((term) => normalizedText.includes(term))
      : !!needle && normalizedText.includes(needle.toLowerCase());
    transcript.push({ step: `expect text ${needle}`, status: ok ? "pass" : "fail", detail: ok ? "text found" : "text missing" });
    return ok;
  } catch (err) {
    transcript.push({ step: `expect ${expectation.type}`, status: "fail", detail: String(err).slice(0, 160) });
    return false;
  }
}

async function executeStructuredScenario(page: Page, baseUrl: string, scenario: QaScenario, blocking: boolean): Promise<ScenarioCheck> {
  const id = scenario.id || slug(scenario.title);
  const transcript: ScenarioTranscriptStep[] = [];
  await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 12000 });
  await page.waitForLoadState("networkidle", { timeout: 1500 }).catch(() => {});
  const before = await pageSignature(page);
  const urlBefore = page.url();

  for (const action of scenario.actions || []) {
    try {
      if (action.type === "goto") {
        const targetUrl = new URL(action.target || action.value || "/", baseUrl).toString();
        const response = await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 12000 });
        transcript.push({ step: `goto ${targetUrl}`, status: (response?.status() || 0) < 400 ? "pass" : "fail", detail: `HTTP ${response?.status() || 0}` });
      } else if (action.type === "click") {
        const detail = await clickTarget(page, action.target || action.value || "");
        transcript.push({ step: `click ${action.target || action.value || ""}`, status: "pass", detail });
      } else if (action.type === "fill") {
        const detail = await fillTarget(page, action.target || "", action.value || "");
        transcript.push({ step: `fill ${action.target || ""}`, status: "pass", detail });
      } else if (action.type === "press") {
        const key = action.key || action.value || "Enter";
        await page.keyboard.press(key);
        transcript.push({ step: `press ${key}`, status: "pass", detail: "keyboard event sent" });
      } else if (action.type === "wait") {
        const ms = Math.min(Math.max(action.ms || Number(action.value) || 500, 100), 5000);
        await page.waitForTimeout(ms);
        transcript.push({ step: `wait ${ms}ms`, status: "pass", detail: "wait completed" });
      }
      await page.waitForTimeout(250);
    } catch (err) {
      transcript.push({ step: `${action.type} ${action.target || action.value || action.key || ""}`.trim(), status: "fail", detail: String(err).slice(0, 180) });
      return failScenario({
        id,
        title: scenario.title,
        status: "fail",
        evidence: "",
        actionTaken: (scenario.actions || []).map((item) => item.type).join(" -> "),
        transcript,
        urlBefore,
        urlAfter: page.url(),
        blocking,
      }, scenario, `structured action failed: ${transcript.at(-1)?.detail || "unknown error"}`, transcript);
    }
  }

  const expectations = scenario.expectations?.length ? scenario.expectations : [{ type: "state-change" as const }];
  const results = [];
  for (const expectation of expectations) {
    results.push(await checkExpectation(page, expectation, before, transcript));
  }
  const ok = results.every(Boolean);
  const check: ScenarioCheck = {
    id,
    title: scenario.title,
    status: ok ? "pass" : "fail",
    evidence: ok ? `${results.length} structured expectations passed` : `${results.filter(Boolean).length}/${results.length} structured expectations passed`,
    actionTaken: (scenario.actions || []).map((item) => item.type).join(" -> "),
    transcript,
    urlBefore,
    urlAfter: page.url(),
    assertionType: scenarioAssertionType(scenario),
    blocking,
  };
  if (!ok) {
    const evidence = `${results.filter(Boolean).length}/${results.length} structured expectations passed`;
    return failScenario(check, scenario, evidence, transcript);
  }
  return check;
}

async function captureScenarioScreenshot(page: Page, outDir: string | undefined, id: string): Promise<string[]> {
  if (!outDir) return [];
  const name = `scenario-${slug(id)}.png`;
  await page.screenshot({ path: join(outDir, name), fullPage: true }).catch(() => {});
  return [name];
}

export async function executeScenarioChecks(page: Page, baseUrl: string, scenariosPath?: string, outDir?: string): Promise<ScenarioVerdict> {
  const scenarios = loadScenarios(scenariosPath);
  if (!scenarios.length) {
    return { schema: "rds.qa.scenario-verdict.v1", status: "missing", baseUrl, scenarioCount: 0, blockingFailures: 1, failureBreakdown: { product_behavior: 0, scenario_brittle: 0, missing_evidence: 1, ambiguous: 0 }, checks: [] };
  }

  const checks: ScenarioCheck[] = [];
  for (const scenario of scenarios) {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 12000 }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 1500 }).catch(() => {});
    const id = scenario.id || slug(scenario.title);
    const blocking = scenario.blockingIfMissing !== false;
    if (scenario.actions?.length || scenario.expectations?.length) {
      const check = await executeStructuredScenario(page, baseUrl, scenario, blocking);
      if (scenario.screenshot !== false) {
        check.screenshots = await captureScenarioScreenshot(page, outDir, check.id);
      }
      checks.push(check);
      continue;
    }
    const keywords = keywordsFor(scenario);
    const shouldAct = expectsAction(scenario);

    if (!shouldAct) {
      const summary = await visibleSummary(page);
      const ok = summary.textLength >= 120 && summary.h1Count >= 1;
      const check: ScenarioCheck = {
        id,
        title: scenario.title,
        status: ok ? "pass" : "fail",
        evidence: ok ? `${summary.textLength} visible chars and ${summary.h1Count} h1` : "first viewport is too thin to verify this scenario",
        urlBefore: page.url(),
        urlAfter: page.url(),
        assertionType: scenarioAssertionType(scenario),
        blocking,
      };
      if (!ok) {
        Object.assign(check, failScenario(check, scenario, check.evidence));
      }
      if (scenario.screenshot !== false) {
        check.screenshots = await captureScenarioScreenshot(page, outDir, id);
      }
      checks.push(check);
      continue;
    }

    const control = await bestInteractive(page, keywords);
    if (!control) {
      const evidence = `no matching visible control for keywords: ${keywords.join(", ") || "none"}`;
      const check: ScenarioCheck = failScenario({ id, title: scenario.title, status: "fail", evidence, urlBefore: page.url(), urlAfter: page.url(), blocking }, scenario, evidence);
      if (scenario.screenshot !== false) {
        check.screenshots = await captureScenarioScreenshot(page, outDir, id);
      }
      checks.push(check);
      continue;
    }
    const before = await pageSignature(page);
    const urlBefore = page.url();
    const item = page.locator("a,button,[role=button],[role=link],input,select,textarea").nth(control.index);
    const tag = await item.evaluate((el) => el.tagName.toLowerCase()).catch(() => "");
    let responseStatus = 0;
    if (tag === "a" && (!control.href || control.href === "#" || control.href.startsWith("javascript:"))) {
      const evidence = `matched "${control.label}" but href is ${control.href || "missing/no-op"}`;
      const check: ScenarioCheck = failScenario({ id, title: scenario.title, status: "fail", evidence, actionTaken: control.label, urlBefore, urlAfter: page.url(), blocking }, scenario, evidence);
      if (scenario.screenshot !== false) {
        check.screenshots = await captureScenarioScreenshot(page, outDir, id);
      }
      checks.push(check);
      continue;
    }
    if (tag === "input" || tag === "textarea") {
      await item.fill("RDS QA scenario").catch(() => {});
    } else if (control.href && !control.href.startsWith("http") && !control.href.startsWith("mailto:") && !control.href.startsWith("tel:")) {
      const response = await page.goto(new URL(control.href, baseUrl).toString(), { waitUntil: "domcontentloaded", timeout: 12000 }).catch(() => null);
      responseStatus = response?.status() || 0;
    } else {
      await item.click({ timeout: 1500 }).catch(() => {});
    }
    await page.waitForTimeout(400);
    const after = await pageSignature(page);
    const changed = before !== after;
    const ok = responseStatus ? responseStatus < 400 : changed;
    const check: ScenarioCheck = {
      id,
      title: scenario.title,
      status: ok ? "pass" : "fail",
      evidence: responseStatus ? `matched "${control.label}", HTTP ${responseStatus}` : `matched "${control.label}", changed=${changed}`,
      actionTaken: control.label,
      urlBefore,
      urlAfter: page.url(),
      assertionType: scenarioAssertionType(scenario),
      blocking,
    };
    if (!ok) {
      Object.assign(check, failScenario(check, scenario, check.evidence));
    }
    if (scenario.screenshot !== false) {
      check.screenshots = await captureScenarioScreenshot(page, outDir, id);
    }
    checks.push(check);
  }

  const blockingFailures = checks.filter((check) => check.blocking && check.status !== "pass").length;
  const failureBreakdown: Record<ScenarioFailureKind, number> = { product_behavior: 0, scenario_brittle: 0, missing_evidence: 0, ambiguous: 0 };
  for (const check of checks) {
    if (check.status === "pass") continue;
    failureBreakdown[check.failureKind || "ambiguous"] += 1;
  }
  return {
    schema: "rds.qa.scenario-verdict.v1",
    status: blockingFailures ? "fail" : "pass",
    baseUrl,
    scenarioCount: scenarios.length,
    blockingFailures,
    failureBreakdown,
    checks,
  };
}

export function writeScenarioVerdict(outDir: string, verdict: ScenarioVerdict): void {
  writeFileSync(join(outDir, "scenario-verdict.json"), JSON.stringify(verdict, null, 2));
}
