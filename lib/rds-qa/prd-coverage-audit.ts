import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";

function arg(name: string, def?: string): string | undefined {
  for (const a of process.argv.slice(2)) {
    if (a.startsWith(`--${name}=`)) return a.slice(name.length + 3);
  }
  return def;
}

const OUT_DIR = arg("out-dir");
const SOURCE_DIR = arg("source-dir");
const BASE_URL = arg("base-url", "");

if (!OUT_DIR) {
  console.error("FATAL: --out-dir is required");
  process.exit(2);
}

mkdirSync(OUT_DIR, { recursive: true });

type Json = Record<string, any>;

const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "dist", "build", "coverage", ".turbo", "tmp", "log"]);
const SOURCE_EXTENSIONS = new Set([".md", ".json", ".ts", ".tsx"]);
const UI_ROUTE_PREFIXES = [
  "dashboard",
  "orders",
  "settings",
  "channels",
  "episodes",
  "sources",
  "sources-browser",
  "costs",
  "generation-log",
  "library",
  "brain-ab",
  "period-library",
  "corrections",
  "about",
  "login",
];
const ACTION_TERMS = [
  "create",
  "submit",
  "approve",
  "reject",
  "cancel",
  "pause",
  "toggle",
  "filter",
  "search",
  "save",
  "edit",
  "lock",
  "upload",
  "connect",
];
const PERSONA_TERMS = [
  "operator",
  "admin",
  "reviewer",
  "visitor",
  "public",
  "customer",
  "user",
  "manager",
  "csr",
  "supervisor",
];

function readJson(path: string): Json | null {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function sourceTexts(dir: string, limit = { files: 0 }): string[] {
  if (!existsSync(dir) || limit.files > 700) return [];
  const out: string[] = [];
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
    if (!stats.isFile() || stats.size > 900_000 || !SOURCE_EXTENSIONS.has(extname(entry))) continue;
    limit.files += 1;
    out.push(readFileSync(path, "utf8").slice(0, 900_000));
  }
  return out;
}

function normalizeFamily(raw: string): string | null {
  if (!raw.startsWith("/")) return null;
  if (raw.startsWith("/api") || raw.includes("[") || raw.includes(":") || raw.includes("*")) return null;
  const cleaned = raw.split(/[?#\s`'")]/)[0].replace(/\/+$/, "") || "/";
  if (cleaned === "/") return "/";
  const family = cleaned.split("/").filter(Boolean)[0];
  if (!UI_ROUTE_PREFIXES.includes(family)) return null;
  return `/${family}`;
}

function requiredFamilies(text: string): string[] {
  const routes = new Set<string>();
  for (const match of text.matchAll(/(?:GET|POST|PUT|PATCH|DELETE)?\s*(`?)(\/[a-zA-Z0-9_./:[\]-]+)\1/g)) {
    const family = normalizeFamily(match[2]);
    if (family) routes.add(family);
  }
  return Array.from(routes).sort();
}

function promisedActions(text: string): string[] {
  const actions = new Set<string>();
  for (const term of ACTION_TERMS) {
    const re = new RegExp(`\\b${term}(?:s|ed|ing)?\\b`, "i");
    if (re.test(text)) actions.add(term);
  }
  return Array.from(actions).sort();
}

function promisedPersonas(text: string): string[] {
  const personas = new Set<string>();
  for (const term of PERSONA_TERMS) {
    const re = new RegExp(`\\b${term}(?:s)?\\b`, "i");
    if (re.test(text)) personas.add(term);
  }
  return Array.from(personas).sort();
}

function actionTermFromLabel(label: string): string | null {
  const text = label.toLowerCase();
  for (const term of ACTION_TERMS) {
    if (new RegExp(`\\b${term}(?:s|ed|ing)?\\b`, "i").test(text)) return term;
  }
  return null;
}

function pathFamilyFromUrl(url: string): string | null {
  try {
    const path = new URL(url, BASE_URL || "http://example.test").pathname;
    return normalizeFamily(path);
  } catch {
    return null;
  }
}

function visitedFamilies(): string[] {
  const families = new Set<string>();
  const summary = readJson(join(OUT_DIR!, "summary.json"));
  if (summary && Array.isArray(summary.pages)) {
    for (const page of summary.pages) {
      const family = pathFamilyFromUrl(String(page.url || ""));
      if (family) families.add(family);
      for (const element of page.elements || []) {
        const href = String(element.href || "");
        const hrefFamily = normalizeFamily(href) || pathFamilyFromUrl(href);
        if (hrefFamily) families.add(hrefFamily);
      }
    }
  }
  const persona = readJson(join(OUT_DIR!, "persona-verdict.json"));
  if (persona && Array.isArray(persona.routeVisits)) {
    for (const visit of persona.routeVisits) {
      if (visit.redirectedToLogin) continue;
      const family = pathFamilyFromUrl(String(visit.finalUrl || visit.url || ""));
      if (family) families.add(family);
    }
  }
  return Array.from(families).sort();
}

function exercisedActions(): string[] {
  const textParts: string[] = [];
  for (const file of ["scenario-verdict.json", "workflow-verdict.json", "website-verdict.json", "persona-verdict.json"]) {
    const data = readJson(join(OUT_DIR!, file));
    if (data) textParts.push(JSON.stringify(data).toLowerCase());
  }
  const text = textParts.join("\n");
  return ACTION_TERMS.filter((term) => new RegExp(`\\b${term}(?:s|ed|ing)?\\b`, "i").test(text));
}

type ActionEvidence = {
  persona: string;
  route: string;
  routeFamily: string | null;
  action: string | null;
  label: string;
  outcome: string;
};

type PromiseLedgerRow = {
  id: string;
  kind: "route" | "action" | "persona";
  promise: string;
  routeFamily?: string;
  action?: string;
  persona?: string;
  status: "verified" | "missing";
  evidence: Json[];
  repairHint?: string;
};

function collectActionEvidence(): ActionEvidence[] {
  const evidence: ActionEvidence[] = [];
  const workflow = readJson(join(OUT_DIR!, "workflow-verdict.json"));
  const workflowGraph = workflow?.actionGraph;
  const pushInteraction = (persona: string, route: string, interaction: Json) => {
    const label = String(interaction?.label || "");
    const routeUrl = String(route || interaction?.route || "");
    evidence.push({
      persona,
      route: routeUrl,
      routeFamily: pathFamilyFromUrl(routeUrl),
      action: actionTermFromLabel(label),
      label,
      outcome: String(interaction?.outcome || "unknown"),
    });
  };
  if (workflowGraph && Array.isArray(workflowGraph.firstPageInteractions)) {
    for (const interaction of workflowGraph.firstPageInteractions) {
      pushInteraction("anonymous", BASE_URL || "/", interaction);
    }
  }
  if (workflowGraph && Array.isArray(workflowGraph.sampledRoutes)) {
    for (const route of workflowGraph.sampledRoutes) {
      for (const interaction of route?.interactions || []) {
        pushInteraction("anonymous", String(route?.url || ""), interaction);
      }
    }
  }
  const persona = readJson(join(OUT_DIR!, "persona-verdict.json"));
  if (persona && Array.isArray(persona.actionGraph)) {
    for (const route of persona.actionGraph) {
      for (const interaction of route?.interactions || []) {
        pushInteraction(String(interaction?.persona || route?.persona || "operator"), String(route?.route || interaction?.route || ""), interaction);
      }
    }
  }
  return evidence;
}

function compactPromise(text: string, fallback: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.slice(0, 220) || fallback;
}

function routePromiseRows(text: string, visited: string[]): PromiseLedgerRow[] {
  const rows: PromiseLedgerRow[] = [];
  const seen = new Set<string>();
  for (const rawLine of text.split(/\n+/)) {
    const line = rawLine.trim();
    if (!line.includes("/")) continue;
    for (const match of line.matchAll(/(?:GET|POST|PUT|PATCH|DELETE)?\s*(`?)(\/[a-zA-Z0-9_./:[\]-]+)\1/g)) {
      const family = normalizeFamily(match[2]);
      if (!family) continue;
      const key = `route:${family}:${compactPromise(line, family)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const ok = visited.includes(family);
      rows.push({
        id: `route-${rows.length + 1}`,
        kind: "route",
        promise: compactPromise(line, `Route ${family}`),
        routeFamily: family,
        status: ok ? "verified" : "missing",
        evidence: ok ? [{ routeFamily: family, status: "visited" }] : [],
        repairHint: ok ? undefined : `Implement or expose a reachable ${family} route and rerun PRD coverage QA.`,
      });
    }
  }
  return rows.slice(0, 80);
}

function actionPromiseRows(text: string, actionMap: Json[]): PromiseLedgerRow[] {
  const rows: PromiseLedgerRow[] = [];
  const seen = new Set<string>();
  const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  for (const action of promisedActions(text)) {
    const matchingLine = lines.find((line) => new RegExp(`\\b${action}(?:s|ed|ing)?\\b`, "i").test(line)) || `Action: ${action}`;
    const key = `action:${action}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const mapped = actionMap.find((item) => item.action === action);
    const evidence = Array.isArray(mapped?.evidence) ? mapped.evidence : [];
    const ok = mapped?.status === "exercised";
    rows.push({
      id: `action-${rows.length + 1}`,
      kind: "action",
      promise: compactPromise(matchingLine, `Action ${action}`),
      action,
      status: ok ? "verified" : "missing",
      evidence: evidence.slice(0, 5),
      repairHint: ok ? undefined : `Add or repair a visible ${action} control that changes the promised business state, then rerun workflow/persona QA.`,
    });
  }
  return rows;
}

function personaPromiseRows(text: string, personaMap: Json[]): PromiseLedgerRow[] {
  const rows: PromiseLedgerRow[] = [];
  const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  for (const persona of promisedPersonas(text)) {
    const matchingLine = lines.find((line) => new RegExp(`\\b${persona}s?\\b`, "i").test(line)) || `Persona: ${persona}`;
    const mapped = personaMap.find((item) => item.persona === persona);
    const evidence = Array.isArray(mapped?.evidence) ? mapped.evidence : [];
    const ok = mapped?.status === "exercised";
    rows.push({
      id: `persona-${rows.length + 1}`,
      kind: "persona",
      promise: compactPromise(matchingLine, `Persona ${persona}`),
      persona,
      status: ok ? "verified" : "missing",
      evidence: evidence.slice(0, 5),
      repairHint: ok ? undefined : `Walk or implement the ${persona} journey through normal entry points, then rerun persona QA.`,
    });
  }
  return rows;
}

function actionRequirementMap(actions: string[], evidence: ActionEvidence[]): Json[] {
  return actions.map((action) => {
    const matches = evidence
      .filter((item) => item.action === action && item.outcome === "changed")
      .slice(0, 8);
    return {
      action,
      status: matches.length ? "exercised" : "missing",
      evidence: matches,
    };
  });
}

function personaRequirementMap(personas: string[], evidence: ActionEvidence[]): Json[] {
  return personas.map((persona) => {
    const matches = evidence.filter((item) => {
      if (item.outcome !== "changed") return false;
      if (item.persona === persona) return true;
      if (["operator", "admin", "reviewer"].includes(persona) && item.persona === "operator") return true;
      if (["visitor", "public", "user", "customer"].includes(persona) && item.persona === "anonymous") return true;
      return false;
    }).slice(0, 8);
    return {
      persona,
      status: matches.length ? "exercised" : "missing",
      evidence: matches,
    };
  });
}

function scenarioQuality(): { scenarioCount: number; blockingFailures: number; genericIssues: number } {
  const scenario = readJson(join(OUT_DIR!, "scenario-verdict.json"));
  const workflow = readJson(join(OUT_DIR!, "workflow-verdict.json"));
  const genericIssues = Array.isArray(workflow?.scenarioIssues) ? workflow.scenarioIssues.length : 0;
  return {
    scenarioCount: Number(scenario?.scenarioCount || 0),
    blockingFailures: Number(scenario?.blockingFailures || 0),
    genericIssues,
  };
}

function run() {
  const texts = SOURCE_DIR ? sourceTexts(SOURCE_DIR) : [];
  const specText = texts.join("\n").slice(0, 2_500_000);
  const required = requiredFamilies(specText);
  const visited = visitedFamilies();
  const missingFamilies = required.filter((family) => !visited.includes(family));
  const actions = promisedActions(specText);
  const exercised = exercisedActions();
  const personas = promisedPersonas(specText);
  const actionEvidence = collectActionEvidence();
  const actionMap = actionRequirementMap(actions, actionEvidence);
  const personaMap = personaRequirementMap(personas, actionEvidence);
  const promiseLedger = [
    ...routePromiseRows(specText, visited),
    ...actionPromiseRows(specText, actionMap),
    ...personaPromiseRows(specText, personaMap),
  ];
  const missingPromiseRows = promiseLedger.filter((row) => row.status !== "verified");
  const missingActions = actions.filter((action) => !exercised.includes(action));
  const unmappedActions = actionMap.filter((item) => item.status !== "exercised").map((item) => String(item.action));
  const unmappedPersonas = personaMap.filter((item) => item.status !== "exercised").map((item) => String(item.persona));
  const scenarios = scenarioQuality();
  const minRouteCoverage = required.length >= 5 ? 0.65 : 0.5;
  const routeCoverage = required.length ? (required.length - missingFamilies.length) / required.length : 1;
  const actionCoverage = actions.length ? (actions.length - missingActions.length) / actions.length : 1;
  const actionGraphCoverage = actions.length ? (actions.length - unmappedActions.length) / actions.length : 1;
  const personaGraphCoverage = personas.length ? (personas.length - unmappedPersonas.length) / personas.length : 1;
  const criteria = [
    {
      name: "prd_routes_exercised",
      ok: routeCoverage >= minRouteCoverage,
      evidence: `${Math.round(routeCoverage * 100)}% route-family coverage; missing ${missingFamilies.slice(0, 8).join(", ") || "none"}`,
    },
    {
      name: "prd_actions_exercised",
      ok: actionCoverage >= 0.55,
      evidence: `${Math.round(actionCoverage * 100)}% promised action coverage; missing ${missingActions.slice(0, 8).join(", ") || "none"}`,
    },
    {
      name: "prd_actions_mapped_to_action_graph",
      ok: actionGraphCoverage >= 0.6,
      evidence: `${Math.round(actionGraphCoverage * 100)}% promised actions mapped to changed controls; missing ${unmappedActions.slice(0, 8).join(", ") || "none"}`,
    },
    {
      name: "prd_personas_mapped_to_action_graph",
      ok: personaGraphCoverage >= 0.6,
      evidence: `${Math.round(personaGraphCoverage * 100)}% promised personas mapped to changed controls; missing ${unmappedPersonas.slice(0, 8).join(", ") || "none"}`,
    },
    {
      name: "prd_scenarios_exist",
      ok: scenarios.scenarioCount >= 3,
      evidence: `${scenarios.scenarioCount} scenario checks executed`,
    },
    {
      name: "prd_scenarios_not_generic",
      ok: scenarios.genericIssues === 0,
      evidence: scenarios.genericIssues ? `${scenarios.genericIssues} generic scenario contract issue(s)` : "scenario contracts are specific",
    },
    {
      name: "prd_scenarios_pass",
      ok: scenarios.blockingFailures === 0,
      evidence: `${scenarios.blockingFailures} blocking scenario failure(s)`,
    },
  ];
  const failed = criteria.filter((criterion) => !criterion.ok);
  const score = Math.round(criteria.filter((criterion) => criterion.ok).length / criteria.length * 100);
  const status = failed.length === 0 ? "pass" : score >= 60 ? "needs_iteration" : "fail";
  const payload = {
    schema: "rds.qa.prd-coverage.v1",
    status,
    score,
    threshold: 100,
    baseUrl: BASE_URL || null,
    sourceDir: SOURCE_DIR || null,
    requiredRouteFamilies: required,
    visitedRouteFamilies: visited,
    missingRouteFamilies: missingFamilies,
    promisedActions: actions,
    exercisedActions: exercised,
    missingActions,
    promisedPersonas: personas,
    actionEvidence,
    actionRequirementMap: actionMap,
    personaRequirementMap: personaMap,
    promiseLedger,
    promiseLedgerSummary: {
      total: promiseLedger.length,
      verified: promiseLedger.length - missingPromiseRows.length,
      missing: missingPromiseRows.length,
      missingByKind: {
        route: missingPromiseRows.filter((row) => row.kind === "route").length,
        action: missingPromiseRows.filter((row) => row.kind === "action").length,
        persona: missingPromiseRows.filter((row) => row.kind === "persona").length,
      },
    },
    unmappedActions,
    unmappedPersonas,
    scenarios,
    criteria,
    failedRequiredCriteria: failed,
  };
  writeFileSync(join(OUT_DIR!, "prd-coverage-verdict.json"), JSON.stringify(payload, null, 2));
  console.log(JSON.stringify({ status, score, path: join(OUT_DIR!, "prd-coverage-verdict.json") }));
  process.exit(status === "pass" ? 0 : 1);
}

run();
