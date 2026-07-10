// dashboard/src/server.ts — RDS Hub.
//
// Bun + Hono. Lives inside the RDS repo so `git clone + bootstrap +
// bin/rds-dashboard` boots a working control surface beside the pipeline.
//
// Surface:
//   GET  /                     — builds list + new-build composer
//   GET  /b/:id                — single build: timeline, terminal, logs, actions
//   GET  /b/:id/events.json    — raw events.jsonl
//   GET  /b/:id/timeline.json  — events folded into a per-stage timeline
//   GET  /b/:id/log/:stage     — plain-text per-stage log (intake.log etc.)
//   GET  /b/:id/stream         — SSE: newly appended events
//   GET  /b/:id/log            — SSE: tail of /dev/shm/<id>-launch-build.log
//   GET  /b/:id/playwright     — UAT viewer (placeholder until TD-025 lands)
//   POST /new/analyze          — analyze a source brief/PRD with the shared CLI analyzer
//   POST /new                  — start a new build (token-gated, calls bin/rds-start)
//   POST /b/:id/cmd            — run an RDS verb (start/stop/pause/resume/status, token-gated)
//   POST /b/:id/fix            — spawn a provider-aware fixer (token-gated, bin/rds-fix)
//   GET  /docs                 — local operator docs and autonomy roadmap
//   GET  /healthz              — liveness
//
// Auth model:
//   All endpoints (except /healthz) — gated by HTTP Basic Auth. Username is
//                     fixed (RDS_DASHBOARD_USER, default "rds"); password is
//                     RDS_DASHBOARD_PASSWORD. If the password env is unset the
//                     dashboard returns 503 since it's exposed publicly.
//   Write endpoints — additionally require X-RDS-Token header matching env
//                     RDS_DASHBOARD_TOKEN. The page auto-injects the token via
//                     localStorage once the user is logged in.
//
// Single file by design; factor when the surface stops fitting in one head.

import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import { getConnInfo } from "hono/bun";
import { stream } from "hono/streaming";
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync, appendFileSync, unlinkSync, readdirSync, rmSync, realpathSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, basename, dirname, resolve, relative } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const DEFAULT_RDS_ROOT = basename(process.cwd()) === "dashboard" ? dirname(process.cwd()) : process.cwd();
const RDS_ROOT        = process.env.RDS_ROOT          || DEFAULT_RDS_ROOT;
const PORT            = Number(process.env.PORT       || 4000);
const DASHBOARD_TOKEN = process.env.RDS_DASHBOARD_TOKEN || "";
const DASHBOARD_PASS  = process.env.RDS_DASHBOARD_PASSWORD || "";
const DASHBOARD_USER  = process.env.RDS_DASHBOARD_USER || "rds";
const ALLOWED_VERBS   = new Set(["start", "stop", "pause", "resume", "status"]);
// Watchdog auto-spawns a fixer after this much inactivity (matches bin/rds-watchdog --stuck-after).
const WATCHDOG_AUTOFIX_AFTER_MS = Number(process.env.RDS_WATCHDOG_STUCK_AFTER_MS || 10 * 60 * 1000); // 10 min
const STUCK_AFTER_MS  = Number(process.env.RDS_STUCK_AFTER_MS || WATCHDOG_AUTOFIX_AFTER_MS);

const BUILDS_DIR = process.env.RDS_BUILDS_DIR || join(RDS_ROOT, "builds");
const INBOX_DIR  = process.env.RDS_INBOX_DIR || join(RDS_ROOT, "inbox");
const ATTACHMENTS_DIR = join(INBOX_DIR, "attachments");
const AGENT_SESSIONS_DIR = join(RDS_ROOT, "agent-sessions");
const DASHBOARD_STATE_DIR = process.env.RDS_DASHBOARD_STATE_DIR || join(RDS_ROOT, "dashboard");
mkdirSync(DASHBOARD_STATE_DIR, { recursive: true });
const AUDIT_LOG  = join(DASHBOARD_STATE_DIR, "audit.jsonl");
const SHM_LOG    = (id: string) => `/dev/shm/${id}-launch-build.log`;
const DISMISSED_ALERTS_PATH = join(DASHBOARD_STATE_DIR, "dismissed-alerts.json");
const DISMISSED_REVIEWS_PATH = join(DASHBOARD_STATE_DIR, "dismissed-reviews.json");
const SETTINGS_PATH = join(RDS_ROOT, "config", "model.env");
const VERSION_LOCK_PATH = join(RDS_ROOT, "config", "versions.lock");
const DEFAULT_PROJECTS_DIR = process.env.RDS_PROJECTS_DIR || "/home/workspace/Projects";
const CLAUDE_MODELS = ["claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6", "opus", "sonnet"];
const CODEX_MODEL_SUGGESTIONS = ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex", "gpt-5.3-codex-spark", "gpt-5.2"];
const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
const MAX_ATTACHMENT_TOTAL_BYTES = 250 * 1024 * 1024;
const MAX_ATTACHMENTS = 250;
const MAX_ANALYSIS_BUNDLE_FILES = 120;
const ALLOWED_ATTACHMENT_EXTS = new Set([
  ".md", ".markdown", ".txt", ".pdf", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".zip",
  ".html", ".htm", ".css", ".js", ".jsx", ".ts", ".tsx", ".json", ".svg", ".csv", ".xml",
  ".yml", ".yaml", ".fig", ".sketch", ".webm", ".mp4", ".mov",
]);
const IGNORED_ATTACHMENT_NAMES = new Set([".ds_store", "thumbs.db", "desktop.ini", "__macosx"]);
const STACK_ALIAS_TO_RUNTIME: Record<string, string> = {
  "rails-web": "rails",
  "react-spa": "react",
  "nextjs-fullstack": "nextjs",
  "mobile-native": "react-native",
};

type SourceAnalysis = {
  stack?: string;
  appType?: string;
  confidence?: number;
  skills?: string[];
  questions?: string[];
  reasons?: string[];
};
const STACK_RUNTIME_TO_CANONICAL: Record<string, string> = {
  rails: "rails-web",
  react: "react-spa",
  nextjs: "nextjs-fullstack",
  "react-native": "mobile-native",
};

// ---------- types -----------------------------------------------------------

interface BuildRow {
  id: string;
  slug?: string;
  displayName?: string;
  mode?: string;
  appType?: string;
  stack?: string;
  stage?: string;
  status?: string;
  paused?: boolean;
  preview?: string;
  previewPending?: boolean;
  liveOnZo?: boolean;
  hasZoService?: boolean;
  serviceStatus?: "live" | "deregistered" | "unknown";
  localPreviewRunning?: boolean;
  appDest?: string;
  provider?: string;
  startedAt?: string;
  running: boolean;
  pid?: number;
  stuck?: boolean;
  lastActivityMs?: number;
  reviewStatus?: string;
  costUsd?: number;
  costTokens?: number;
  buildPlan?: BuildPlanState;
  runnerMissing?: boolean;
}

interface AgentSession {
  id: string;
  build_id?: string;
  provider?: string;
  mode?: string;
  task?: string;
  repo_root?: string;
  base_branch?: string;
  branch?: string;
  worktree_path?: string;
  tmux_session?: string;
  status?: string;
  created_at?: string;
  updated_at?: string;
  started_by?: string;
  log_path?: string;
  last_exit_code?: number | null;
  handoff_from?: string | null;
  handoff_to?: string | null;
  changed_files?: string[];
}

interface BuildPlanState {
  profile?: string;
  profile_name?: string;
  max_tasks?: number;
  task_timeout_sec?: number;
  target_minutes?: string;
  qa_max_pages?: number;
  qa_depth?: number;
  reasons?: string[];
  operator_questions?: string[];
  risks?: string[];
  path?: string;
}

interface ReviewState {
  status?: string;
  decided_at?: string | null;
  decided_by?: string | null;
  reason?: string | null;
}

interface CostState {
  total_usd?: number;
  total_tokens?: number;
  by_task?: Record<string, unknown>;
  updated_at?: string | null;
}

interface StateJson {
  build_id?: string;
  slug?: string;
  display_name?: string;
  mode?: string;
  app_type?: string;
  stack?: string;
  stage?: string;
  status?: string;
  current_stage?: string;
  preview_url?: string;
  app_dest?: string;
  trigger?: string | null;
  repo_url?: string | null;
  prd_source?: string | null;
  po_questions_file?: string | null;
  updated_at?: string | null;
  paused_at?: string | null;
  paused_from_stage?: string | null;
  inference?: { provider?: string; claude_model?: string | null; codex_model?: string | null };
  started_at?: string;
  error?: string;
  review?: ReviewState;
  cost?: CostState;
  build_plan?: BuildPlanState;
  stages?: Record<string, { status?: string }>;
}

interface IterationState {
  running: boolean;
  phase?: string;
  startedAt?: string;
  updatedAt?: string;
  summary?: string;
  exitCode?: number;
}

interface ActiveRunTiming {
  kind: "build" | "goal" | "iteration" | "fixer" | "stale_goal" | "idle";
  label: string;
  startedAt?: string;
  updatedAt?: string;
  durationMs?: number;
  running: boolean;
  stale?: boolean;
  hint: string;
}

interface RdsSettings {
  inferenceProvider: "claude" | "codex";
  claudeModel: string;
  codexModel: string;
  theme: "dark" | "light" | "system";
}

interface PipelineComponent {
  name: string;
  icon: string;
  path: string;
  remoteKey: string;
  commitKey: string;
  copiedAtKey?: string;
  stage: string;
  usedFor: string;
  upgradeEffect: string;
  limitations: string[];
  updateSteps: string[];
}

interface StackOption {
  id: string;
  name: string;
  label: string;
  shortLabel: string;
  subtitle: string;
  bestFor: string;
  status: "ready" | "stub" | "disabled" | "defer";
  notes?: string;
  supportsModes: string[];
  description?: string;
  category?: string;
  mockup?: string;
  sourceLinks: ReferenceLink[];
}

interface SkillOption {
  slug: string;
  name: string;
  status: string;
  appliesTo: string[];
  default: boolean;
  description?: string;
  category?: string;
  maturity?: string;
  rationale?: string;
  installMode: string;
  verifyCommand?: string;
  sourceLinks: ReferenceLink[];
}

interface ReferenceLink {
  label: string;
  url: string;
}

const STACK_FAMILIES: Record<string, string> = {
  "rails-web": "Data-backed apps",
  "nextjs-fullstack": "Product frontends",
  "python-ai-service": "AI/API services",
  "astro-thin-web": "Content and marketing",
  "web-3d": "Interactive media",
  "game-engine": "Games",
  "browser-extension": "Browser tools",
  "mobile-native": "Mobile apps",
  "game-asset-pipeline": "Asset tooling",
  "react-spa": "Legacy/deferred",
};

const STACK_PRESENTATION: Record<string, { label: string; shortLabel: string; subtitle: string; bestFor: string }> = {
  "rails-web": {
    label: "Rails business app",
    shortLabel: "Rails app",
    subtitle: "CRUD, dashboards, workflows",
    bestFor: "Best for internal tools, admin panels, customer portals, and data-backed products.",
  },
  "nextjs-fullstack": {
    label: "Next.js full-stack app",
    shortLabel: "Next.js app",
    subtitle: "Modern React product",
    bestFor: "Best for SaaS apps, polished web products, auth/payments, and interactive frontends.",
  },
  "python-ai-service": {
    label: "Python AI API",
    shortLabel: "AI API",
    subtitle: "FastAPI + agents",
    bestFor: "Best for LLM services, RAG APIs, agent backends, and tool endpoints.",
  },
  "astro-thin-web": {
    label: "Astro content site",
    shortLabel: "Astro site",
    subtitle: "Fast marketing/docs site",
    bestFor: "Best for landing pages, blogs, docs, content hubs, and lightweight web forms.",
  },
  "web-3d": {
    label: "3D web experience",
    shortLabel: "3D web",
    subtitle: "Three.js / R3F scene",
    bestFor: "Best for product configurators, interactive scenes, 3D explainers, and visual demos.",
  },
  "game-engine": {
    label: "Playable game",
    shortLabel: "Game",
    subtitle: "Canvas game preview",
    bestFor: "Best for arcade prototypes, browser games, playable loops, and Godot-ready projects.",
  },
  "browser-extension": {
    label: "Browser extension",
    shortLabel: "Extension",
    subtitle: "Chrome MV3 / WXT",
    bestFor: "Best for Chrome extensions, popup tools, content scripts, and browser automations.",
  },
  "mobile-native": {
    label: "Mobile app",
    shortLabel: "Mobile app",
    subtitle: "Expo / React Native",
    bestFor: "Best for iOS/Android apps with a Zo web preview and Expo/EAS upgrade path.",
  },
  "game-asset-pipeline": {
    label: "Game asset pipeline",
    shortLabel: "Assets",
    subtitle: "Validate and preview 3D assets",
    bestFor: "Best for GLTF/USD processing, model validation, downloadable assets, and previews.",
  },
  "react-spa": {
    label: "React SPA",
    shortLabel: "React SPA",
    subtitle: "Deferred Vite-only path",
    bestFor: "Use only for explicit Vite-only requests; Next.js is the default modern web path.",
  },
};
const NEW_BUILD_STACK_ORDER = [
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
const NEW_BUILD_CORE_SKILLS = [
  "rds-context7-mount",
  "rds-mockup-fidelity",
  "rds-secrets-broker",
];
// Stack→skills map is now derived from stacks/<runtime>/stack.yaml contracts
// via stackPrimarySkillMap(). See NEW_BUILD_STACK_ORDER for the list of stack ids.

const STACK_DECISION_NOTES: Record<string, { choose: string; avoid: string; example: string }> = {
  "rails-web": {
    choose: "Choose when the product is mostly records, workflows, admin operations, approvals, dashboards, or CRUD with real persistence.",
    avoid: "Avoid for highly animated consumer frontends, 3D scenes, native mobile apps, and tiny static sites.",
    example: "CRM, internal ops console, customer portal, marketplace admin.",
  },
  "nextjs-fullstack": {
    choose: "Choose when the frontend experience is the product and needs React, auth, payments, rich UI, or a polished public app shell.",
    avoid: "Avoid for plain content sites, pure APIs, native mobile, and Rails-shaped back-office software.",
    example: "SaaS onboarding app, account dashboard, paid web app, interactive landing app.",
  },
  "python-ai-service": {
    choose: "Choose when the deliverable is an API, agent service, RAG endpoint, eval endpoint, webhook processor, or Python-heavy backend.",
    avoid: "Avoid when the user primarily needs a polished web UI or database-backed business app.",
    example: "FastAPI LLM service, embedding/RAG endpoint, agent tool server.",
  },
  "astro-thin-web": {
    choose: "Choose for fast content-first websites: marketing pages, docs, blogs, newsletters, launch pages, and SEO-heavy static content.",
    avoid: "Avoid for dashboards, auth-heavy SaaS, native apps, and workflows requiring substantial backend state.",
    example: "Company homepage, docs hub, editorial site, product launch page.",
  },
  "web-3d": {
    choose: "Choose when the first preview must render an interactive Three.js/R3F scene or inspect 3D models in-browser.",
    avoid: "Avoid for normal web apps with a few decorative 3D assets; those usually belong in Next.js or Astro.",
    example: "Product configurator, 3D model viewer, spatial demo.",
  },
  "game-engine": {
    choose: "Choose when the core output is playable: rules, input, score/state, levels, loops, or game-feel matter more than app chrome.",
    avoid: "Avoid for asset validation pipelines or static 3D showcases.",
    example: "Browser arcade prototype, Godot-ready vertical slice, playable mechanic test.",
  },
  "game-asset-pipeline": {
    choose: "Choose when the output is a toolchain for importing, validating, transforming, previewing, or packaging game/3D assets.",
    avoid: "Avoid when the user wants a playable game or general-purpose 3D marketing page.",
    example: "GLTF/USD validator, asset preview portal, texture/model QA pipeline.",
  },
  "mobile-native": {
    choose: "Choose when the target product is iOS/Android and the first preview should map to Expo/React Native conventions.",
    avoid: "Avoid when a responsive web app is enough or App Store/device behavior is not central.",
    example: "Consumer mobile MVP, companion app, phone-first workflow tool.",
  },
  "browser-extension": {
    choose: "Choose when the app must run inside the browser with popup UI, content scripts, Manifest V3, storage sync, or page automation.",
    avoid: "Avoid for ordinary web apps that just need OAuth or scraping-like flows.",
    example: "Chrome productivity extension, page annotator, context-aware assistant popup.",
  },
  "react-spa": {
    choose: "Use only for explicit Vite-only compatibility work.",
    avoid: "Avoid for new V1 builds; Next.js is the default modern React stack.",
    example: "Legacy Vite SPA compatibility smoke.",
  },
};

const STACK_SOURCE_LINKS: Record<string, ReferenceLink[]> = {
  "rails-web": [
    { label: "Rails Guides", url: "https://guides.rubyonrails.org/" },
    { label: "Hotwire", url: "https://hotwired.dev/" },
  ],
  "nextjs-fullstack": [
    { label: "Next.js Docs", url: "https://nextjs.org/docs" },
    { label: "React Server Components", url: "https://react.dev/reference/rsc/server-components" },
  ],
  "python-ai-service": [
    { label: "FastAPI", url: "https://fastapi.tiangolo.com/" },
    { label: "Pydantic AI", url: "https://ai.pydantic.dev/" },
  ],
  "astro-thin-web": [
    { label: "Astro Docs", url: "https://docs.astro.build/" },
    { label: "Starlight", url: "https://starlight.astro.build/" },
  ],
  "web-3d": [
    { label: "React Three Fiber", url: "https://r3f.docs.pmnd.rs/" },
    { label: "Three.js", url: "https://threejs.org/docs/" },
  ],
  "game-engine": [
    { label: "Godot Docs", url: "https://docs.godotengine.org/" },
    { label: "Playwright", url: "https://playwright.dev/" },
  ],
  "game-asset-pipeline": [
    { label: "OpenUSD tools", url: "https://openusd.org/release/toolset.html" },
    { label: "glTF Validator", url: "https://github.khronos.org/glTF-Validator/" },
  ],
  "mobile-native": [
    { label: "Expo Docs", url: "https://docs.expo.dev/" },
    { label: "EAS Build", url: "https://docs.expo.dev/build/introduction/" },
  ],
  "browser-extension": [
    { label: "Chrome Extensions", url: "https://developer.chrome.com/docs/extensions/" },
    { label: "WXT", url: "https://wxt.dev/" },
  ],
  "react-spa": [
    { label: "Vite", url: "https://vite.dev/guide/" },
    { label: "React", url: "https://react.dev/" },
  ],
};

interface BuildServiceInfo {
  service_id?: string;
  label?: string;
  url?: string;
  local_port?: number;
  status?: "live" | "deregistered" | "unknown";
  updated_at?: string;
}

interface BuildBriefState {
  status: "fallback" | "running" | "ready" | "failed";
  source: "deterministic" | "ai";
  title: string;
  summary: string;
  key_points: string[];
  generated_at?: string;
  error?: string;
}

interface BuildInputDoc {
  key: string;
  label: string;
  kind: "input" | "spec" | "plan" | "qa" | "app";
  path: string;
  pathLabel: string;
  note: string;
  size?: number;
  mtimeMs?: number;
}

const ALLOWED_DEPLOY_TARGETS = new Set(["zo", "none", "teardown"]);

interface RdsEvent {
  ts: string;
  build_id?: string;
  event: string;
  payload?: Record<string, unknown>;
  pid?: number;
}

interface StagePoint {
  stage: string;
  startedAt?: string;
  endedAt?: string;
  status: "running" | "done" | "failed" | "skipped" | "pending-review" | "unknown";
  durationMs?: number;
  exitCode?: number;
}

interface BuildTiming {
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  running: boolean;
  label: string;
  hint: string;
  source: "state" | "events" | "pidfile" | "unknown";
}

interface StageSummary {
  id: string;
  label: string;
  status: StagePoint["status"] | "pending";
  duration: string;
  startedAt?: string;
  endedAt?: string;
  logName: string;
  logExists: boolean;
  logLines: string[];
}

interface ScaffoldTask {
  title?: string;
  position?: number;
  status?: string;
  priority?: number;
  labels?: string[];
}

interface ScaffoldProgress {
  available: boolean;
  complete?: boolean;
  total: number;
  done: number;
  running: number;
  failed: number;
  pending: number;
  percent: number;
  tasks?: ScaffoldTask[];
  current?: ScaffoldTask;
  next?: ScaffoldTask[];
  lastCompleted?: {
    position?: number;
    title?: string;
    recordedAt?: string;
    elapsedMs?: number;
    failedAttempts?: number;
  };
  updatedAtMs?: number;
  tasksPath?: string;
}

interface SkillResolution {
  stack?: string;
  requested: string[];
  resolved: Array<{ slug: string; name?: string; status?: string; path?: string; installMode?: string; installCommand?: string }>;
  skipped: Array<{ slug: string; reason?: string }>;
  installed: string[];
  promptMentions: number;
  scorecard?: SkillScorecard | null;
}

interface SkillScorecardEntry {
  slug: string;
  verdict: string;
  installMode?: string | null;
  note?: string | null;
}

interface SkillScorecard {
  totals?: Record<string, number>;
  skills: SkillScorecardEntry[];
}

interface QualityLedger {
  skills?: {
    requested?: string[];
    resolved?: string[];
    installed?: string[];
    skipped?: Array<{ slug?: string; reason?: string }>;
  };
  skillImpact?: {
    available?: boolean;
    status?: string | null;
    totals?: Record<string, number>;
    path?: string | null;
    blockingSkills?: Array<{
      slug?: string;
      verdict?: string;
      installMode?: string | null;
      note?: string | null;
      shape?: {
        verdict?: string;
        note?: string;
        evidence?: Record<string, unknown>;
      } | null;
      verify?: {
        command?: string | null;
        exitCode?: number;
        output?: string;
      } | null;
    }>;
  };
  prdCoverage?: {
    available?: boolean;
    status?: string | null;
    score?: number | null;
    summary?: {
      total?: number;
      verified?: number;
      missing?: number;
      missingByKind?: Record<string, number>;
    };
    missingRouteFamilies?: string[];
    missingActions?: string[];
    unmappedPersonas?: string[];
    blockingRows?: Array<{
      id?: string;
      kind?: string;
      promise?: string;
      routeFamily?: string;
      action?: string;
      persona?: string;
      status?: string;
      repairHint?: string;
      evidence?: string;
    }>;
    verdictPath?: string | null;
  };
	  scenarios?: {
	    available?: boolean;
	    count?: number;
	    path?: string | null;
	    executed?: boolean;
	    status?: string | null;
	    blockingFailures?: number | null;
	    verdictPath?: string | null;
	    checks?: Array<{
	      id?: string;
	      title?: string;
	      status?: string;
	      blocking?: boolean;
	      evidence?: string;
	      actionTaken?: string;
	      transcript?: Array<{ step?: string; status?: string; detail?: string }>;
	    }>;
	  };
  latestPlaywrightIteration?: string | null;
  verdicts?: Record<string, string | boolean | number | null>;
  blocking?: string[];
}

type PrdRepairAttempt = {
  artifact: string;
  iteration: string;
  jobId: string;
  jobType?: string;
  status?: string;
  targetStatus?: string;
  filesTouched?: number;
  checksRun?: Array<{ name?: string; status?: string; artifact?: string }>;
};

interface EvidenceLedger {
  verdict?: string;
  confidence?: string;
  summary?: {
    currentTruth?: string;
    blockerClass?: string;
    nextAction?: string;
    operatorReviewStatus?: string | null;
    running?: boolean;
    recovering?: boolean;
  };
  state?: {
    status?: string | null;
    stage?: string | null;
    stack?: string | null;
    appType?: string | null;
  };
  blockers?: Array<{
    code?: string;
    severity?: string;
    message?: string;
    source?: string | null;
    recovery?: string | null;
  }>;
  gates?: Record<string, unknown>;
  recoveryAttempts?: Record<string, number>;
  sources?: Record<string, string | null>;
  updatedAt?: string;
}

interface RdsGoalState {
  schema?: string;
  buildId?: string;
  objective?: string;
  status?: string;
  phase?: string;
  verdict?: string;
  blockerClass?: string;
  currentAction?: string | null;
  nextAction?: string;
  cycle?: number;
  maxCycles?: number;
  agentReviewCount?: number;
  maxAgentReviews?: number;
  resumeCount?: number;
  repeatCount?: number;
  lastBlockerSignature?: string;
  startedAt?: string;
  updatedAt?: string;
  endedAt?: string;
  goalDir?: string;
  blockers?: Array<{ code?: string; stage?: string; severity?: string; detail?: string; recovery?: string; path?: string }>;
  nodes?: Array<{ id?: string; label?: string; status?: string }>;
  edges?: Array<{ from?: string; to?: string }>;
  actions?: Array<{ cycle?: number; type?: string; status?: string; exitCode?: number; provider?: string; from?: string; to?: string; reason?: string; log?: string; repairJobs?: string; convergence?: string; sessionId?: string | null }>;
  turns?: string[];
  engine?: { provider?: string; model?: string; switchedFrom?: string; reason?: string; switchedAt?: string; pinned?: boolean; pinnedAt?: string };
  exhaustedProviders?: string[];
}

// ---------- io helpers ------------------------------------------------------

function isContainedPath(root: string, target: string): boolean {
  const rootPath = resolve(root);
  const targetPath = resolve(target);
  const rel = relative(rootPath, targetPath);
  return rel === "" || (!!rel && !rel.startsWith("..") && !rel.startsWith("/") && rel !== "..");
}

function isContainedExistingPath(root: string, target: string): boolean {
  if (!existsSync(root) || !existsSync(target)) return false;
  try {
    return isContainedPath(realpathSync(root), realpathSync(target));
  } catch {
    return false;
  }
}

function isSafeBuildId(id: string): boolean {
  return /^[a-z0-9_][a-z0-9._-]{0,180}$/i.test(id);
}

function buildDirForId(id: string): string | null {
  if (!isSafeBuildId(id)) return null;
  const dir = join(BUILDS_DIR, id);
  if (!isContainedPath(BUILDS_DIR, dir)) return null;
  return dir;
}

function existingBuildDirForId(id: string): string | null {
  const dir = buildDirForId(id);
  if (!dir || !existsSync(dir) || !isContainedExistingPath(BUILDS_DIR, dir)) return null;
  return dir;
}

function existingFileIn(root: string, ...segments: string[]): string | null {
  const path = join(root, ...segments);
  if (!existsSync(path)) return null;
  if (!isContainedExistingPath(root, path)) return null;
  return path;
}

function safeReadJson<T = unknown>(path: string): T | null {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return null; }
}

function readGoalState(id: string): RdsGoalState | null {
  return safeReadJson<RdsGoalState>(join(BUILDS_DIR, id, "goal.json"));
}

function goalUpdatedMs(goal: RdsGoalState | null): number {
  if (!goal?.updatedAt) return 0;
  const value = Date.parse(goal.updatedAt);
  return Number.isFinite(value) ? value : 0;
}

function goalLooksFreshRunning(goal: RdsGoalState | null): boolean {
  if (goal?.status !== "running") return false;
  const updated = goalUpdatedMs(goal);
  return !!updated && Date.now() - updated < 10 * 60 * 1000;
}

function goalIsStaleRunning(goal: RdsGoalState | null): boolean {
  return goal?.status === "running" && !goalLooksFreshRunning(goal);
}

function latestGoalActionStart(events: RdsEvent[]): { ts?: string; pid?: number } {
  let latestMs = 0;
  let latest: { ts?: string; pid?: number } = {};
  for (const event of events) {
    if (event.event !== "goal_action_started") continue;
    const ms = parseTimeMs(event.ts);
    if (ms >= latestMs) {
      latestMs = ms;
      latest = { ts: event.ts, pid: typeof event.pid === "number" ? event.pid : undefined };
    }
  }
  return latest;
}

function reconcileStaleGoalState(id: string, goal: RdsGoalState | null, events: RdsEvent[]): RdsGoalState | null {
  if (!goalIsStaleRunning(goal)) return goal;
  const lastStart = latestGoalActionStart(events);
  if (lastStart.pid && pidIsAlive(lastStart.pid)) return goal;
  const next: RdsGoalState = {
    ...goal,
    status: "interrupted",
    phase: "interrupted",
    currentAction: null,
    nextAction: "Goal stopped after the last apply/build step without completing checks, deploy, QA, or taste-review. Continue Goal to resume from current evidence.",
  };
  const path = join(BUILDS_DIR, id, "goal.json");
  try {
    writeFileSync(path, JSON.stringify(next, null, 2) + "\n");
  } catch {
    return goal;
  }
  return next;
}

function readSkillResolution(id: string): SkillResolution {
  const data = safeReadJson<Record<string, unknown>>(join(BUILDS_DIR, id, "skills", "resolved.json"));
  if (!data) return { requested: [], resolved: [], skipped: [], installed: [], promptMentions: 0, scorecard: null };
  const requested = Array.isArray(data.requested) ? data.requested.filter((s): s is string => typeof s === "string") : [];
  const resolved: SkillResolution["resolved"] = Array.isArray(data.resolved)
    ? data.resolved.map((row) => {
        if (!row || typeof row !== "object") return null;
        const obj = row as Record<string, unknown>;
        const slug = typeof obj.slug === "string" ? obj.slug : "";
        if (!slug) return null;
        const install = (obj.install && typeof obj.install === "object") ? obj.install as Record<string, unknown> : {};
        return {
          slug,
          name: typeof obj.name === "string" ? obj.name : undefined,
          status: typeof obj.status === "string" ? obj.status : undefined,
          path: typeof obj.path === "string" ? obj.path : undefined,
          installMode: typeof install.mode === "string" ? install.mode : (typeof install.command === "string" ? "imperative" : undefined),
          installCommand: typeof install.command === "string" ? install.command : undefined,
        };
      }).filter((row): row is NonNullable<typeof row> => !!row)
    : [];
  const skipped: SkillResolution["skipped"] = Array.isArray(data.skipped)
    ? data.skipped.map((row) => {
        if (typeof row === "string") return { slug: row };
        if (!row || typeof row !== "object") return null;
        const obj = row as Record<string, unknown>;
        const slug = typeof obj.slug === "string" ? obj.slug : "";
        if (!slug) return null;
        return { slug, reason: typeof obj.reason === "string" ? obj.reason : undefined };
      }).filter((row): row is NonNullable<typeof row> => !!row)
    : [];
  return {
    stack: typeof data.stack === "string" ? data.stack : undefined,
    requested,
    resolved,
    skipped,
    installed: readInstalledSkills(id),
    promptMentions: countSkillPromptMentions(id),
    scorecard: readSkillScorecard(id),
  };
}

function readInstalledSkills(id: string): string[] {
  const data = safeReadJson<Record<string, unknown>>(join(BUILDS_DIR, id, "skills", "installed.json"));
  return Array.isArray(data?.installed) ? data.installed.filter((s): s is string => typeof s === "string") : [];
}

function countSkillPromptMentions(id: string): number {
  const logPath = SHM_LOG(id);
  if (!existsSync(logPath)) return 0;
  try {
    const text = readFileSync(logPath, "utf8");
    return (text.match(/## Available Skills/g) || []).length;
  } catch {
    return 0;
  }
}

function readSkillScorecard(id: string): SkillScorecard | null {
  const data = safeReadJson<Record<string, unknown>>(join(BUILDS_DIR, id, "skills", "scorecard.json"));
  if (!data || !Array.isArray(data.skills)) return null;
  const skills: SkillScorecardEntry[] = (data.skills as unknown[])
    .map((row): SkillScorecardEntry | null => {
      if (!row || typeof row !== "object") return null;
      const obj = row as Record<string, unknown>;
      const slug = typeof obj.slug === "string" ? obj.slug : "";
      const verdict = typeof obj.verdict === "string" ? obj.verdict : "";
      if (!slug || !verdict) return null;
      return {
        slug,
        verdict,
        installMode: typeof obj.installMode === "string" ? obj.installMode : null,
        note: typeof obj.note === "string" ? obj.note : null,
      };
    })
    .filter((row): row is SkillScorecardEntry => row !== null);
  const totals = (data.totals && typeof data.totals === "object")
    ? Object.fromEntries(Object.entries(data.totals as Record<string, unknown>)
        .filter(([, v]) => typeof v === "number")
        .map(([k, v]) => [k, v as number]))
    : undefined;
  return { totals, skills };
}

function readQualityLedger(id: string): QualityLedger | null {
  return safeReadJson<QualityLedger>(join(BUILDS_DIR, id, "quality-ledger.json"));
}

function readEvidenceLedger(id: string): EvidenceLedger | null {
  return safeReadJson<EvidenceLedger>(join(BUILDS_DIR, id, "evidence-ledger.json"));
}

function refreshEvidenceLedger(id: string): EvidenceLedger | null {
  const cmd = join(RDS_ROOT, "bin", "rds-evidence-ledger");
  if (existsSync(cmd)) {
    spawnSync(cmd, [id], { cwd: RDS_ROOT, stdio: "ignore", env: process.env });
  }
  return readEvidenceLedger(id);
}

interface TasteReviewSummary {
  status?: string;
  score?: number;
  threshold?: number;
  runtime?: {
    iteration?: string;
    converged?: boolean;
    gapsFound?: number;
    specVerdict?: string;
    visualStatus?: string;
    designStatus?: string;
    designScore?: number;
    designBlockers?: number;
    designIssues?: Array<{ severity?: string; evidence?: string; fixHint?: string }>;
  };
}

function readTasteReview(id: string): TasteReviewSummary | null {
  return safeReadJson<TasteReviewSummary>(join(BUILDS_DIR, id, "taste-review.json"));
}

function isBlockingVerdict(name: string, value: unknown): boolean {
  const normalized = typeof value === "string" ? value.toLowerCase() : value;
  if (normalized === false || normalized === "fail" || normalized === "failed" || normalized === "needs_iteration" || normalized === "partial") {
    return true;
  }
  return name === "design" && (normalized === "missing" || normalized === "unknown" || normalized === "skipped");
}

function summarizeFailureReason(id: string, fallback?: string): string {
  const taste = readTasteReview(id);
  if (!taste) return fallback || "no error message recorded";
  const parts: string[] = [];
  if (typeof taste.score === "number" && typeof taste.threshold === "number") {
    parts.push(`Taste score ${taste.score} below threshold ${taste.threshold}`);
  }
  const rt = taste.runtime || {};
  if (typeof rt.gapsFound === "number" && rt.gapsFound > 0) {
    parts.push(`${rt.gapsFound} spec gap${rt.gapsFound === 1 ? "" : "s"}${rt.converged ? "" : " (not converged)"}`);
  }
  if (rt.designStatus === "missing") {
    parts.push("Design review missing from the latest QA iteration");
  } else if (rt.designStatus === "skipped") {
    parts.push("Design review was skipped; screenshot-backed design evidence is missing");
  } else if (rt.designStatus === "unknown") {
    parts.push("Design review is unknown; screenshot-backed design evidence is missing");
  } else if (rt.designStatus === "fail") {
    const issue = rt.designIssues?.[0];
    if (issue?.evidence?.includes("usage limit")) {
      parts.push(`Design review hit provider quota: "${issue.evidence}"`);
    } else if (issue?.evidence) {
      parts.push(`Design review failed: ${issue.evidence}`);
    } else {
      parts.push(`Design review failed (score ${rt.designScore ?? "?"})`);
    }
  }
  if (rt.visualStatus && rt.visualStatus !== "pass") parts.push(`Visual audit ${rt.visualStatus}`);
  if (!parts.length) return fallback || "Taste review did not converge.";
  return parts.join(" · ");
}

function isPendingPreview(url?: string): boolean {
  return !!url && url.startsWith("pending-zo-registration://");
}

function parseEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function readSettings(): RdsSettings {
  const env = parseEnvFile(SETTINGS_PATH);
  const provider = env.RDS_INFERENCE_PROVIDER === "codex" ? "codex" : "claude";
  const theme = env.RDS_DASHBOARD_THEME === "light" || env.RDS_DASHBOARD_THEME === "system" ? env.RDS_DASHBOARD_THEME : "dark";
  return {
    inferenceProvider: provider,
    claudeModel: env.RDS_CLAUDE_MODEL || "claude-opus-4-6",
    codexModel: env.RDS_CODEX_MODEL || "",
    theme,
  };
}

function pipelineComponents(): PipelineComponent[] {
  return [
    {
      name: "Wiki",
      icon: "article",
      path: "vendor/wiki/",
      remoteKey: "wiki_remote",
      commitKey: "wiki_commit",
      copiedAtKey: "wiki_copied_at",
      stage: "Spec generation, green-field builds only",
      usedFor: "Turns research, notes, and product artifacts into the canonical spec Scaffold receives. Brown-field builds usually skip Wiki because the supplied PRD is treated as authoritative.",
      upgradeEffect: "Future green-field builds get the new wiki plugin behavior, better requirement extraction, and updated open-question handling.",
      limitations: [
        "Does not update specs already written under builds/<id>/spec.md.",
        "Can over-promote taste or aspirational language into hard requirements if the prompt/plugin is weak.",
        "Requires Claude Code plugin support; provider setting does not switch Wiki to Codex.",
      ],
      updateSteps: [
        "Refresh vendor/wiki from upstream.",
        "Re-run bootstrap/install.sh so local patches and checks re-apply.",
        "Update config/versions.lock with the new source commit or copy date.",
        "Run a green-field smoke build and inspect spec.md before trusting production builds.",
      ],
    },
    {
      name: "Scaffold",
      icon: "construction",
      path: "vendor/scaffold/",
      remoteKey: "scaffold_remote",
      commitKey: "scaffold_commit",
      copiedAtKey: "scaffold_copied_at",
      stage: "Implementation planning and execution",
      usedFor: "Converts the spec into a task plan, writes CLAUDE.md, launch-build.sh, .scaffold state, task dossiers, recipes, gates, and then executes the build tasks inside the generated app.",
      upgradeEffect: "Future builds get the new planner, recipes, task harness, verification gates, prompt language, and runtime behavior.",
      limitations: [
        "Many files are copied into the app at scaffold time, so in-flight builds may keep the old harness.",
        "Recipe changes only affect stacks that use that recipe, such as web_app or react_web.",
        "If Scaffold creates phantom requirements or too many tasks, RDS must guard or patch it at this layer.",
      ],
      updateSteps: [
        "Refresh vendor/scaffold from upstream.",
        "Re-run bootstrap/install.sh to re-apply RDS patches.",
        "Update config/versions.lock and any stack recipe references.",
        "Run rds-selftest plus one small build to verify task count, gates, logs, and iteration behavior.",
      ],
    },
    {
      name: "Rails starter",
      icon: "view_quilt",
      path: "vendor/rails-starter/",
      remoteKey: "rails_starter_remote",
      commitKey: "rails_starter_commit",
      copiedAtKey: "rails_starter_copied_at",
      stage: "Rails green-field app starter",
      usedFor: "Seeds Rails apps before Scaffold runs: base app structure, setup script, and Rails-specific defaults.",
      upgradeEffect: "Future Rails green-field apps inherit the new starter, setup behavior, and starter conventions.",
      limitations: [
        "Does not affect React/Vite builds.",
        "Existing generated apps do not update automatically.",
        "Scaffold can still drift from template conventions unless recipes and QA enforce them.",
      ],
      updateSteps: [
        "Refresh vendor/rails-starter from the approved source.",
        "Re-run bootstrap/install.sh.",
        "Update config/versions.lock.",
        "Run a Rails green-field smoke build and inspect the generated app.",
      ],
    },
  ];
}

function renderPipelineComponents(): string {
  const versions = parseEnvFile(VERSION_LOCK_PATH);
  const components = pipelineComponents();
  return `
    <section class="bg-surface-container border border-outline-variant rounded-DEFAULT p-container-padding flex flex-col gap-gutter">
      <div class="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 class="font-h2 text-h2 text-on-surface flex items-center gap-2">${icon("account_tree", 18, "text-primary-container")}<span>Pipeline components</span></h2>
          <p class="font-body text-body text-on-surface-variant max-w-[760px]">RDS vendors its upstream build components. Updating Wiki, Scaffold, or the Rails starter outside RDS does not affect RDS until the matching vendored copy and version lock are refreshed here.</p>
        </div>
        <div class="font-code text-[11px] text-on-surface-variant border border-outline-variant bg-surface rounded-DEFAULT px-2 py-1">config/versions.lock</div>
      </div>
      <div class="grid grid-cols-1 gap-gutter">
        ${components.map((component) => {
          const commit = versions[component.commitKey] || "unknown";
          const remote = versions[component.remoteKey] || "unknown";
          const copiedAt = component.copiedAtKey ? versions[component.copiedAtKey] : "";
          const present = existsSync(join(RDS_ROOT, component.path));
          return `
            <article class="bg-surface border border-outline-variant rounded-DEFAULT p-gutter flex flex-col gap-stack-gap">
              <div class="flex items-start justify-between gap-3 flex-wrap">
                <div class="flex items-start gap-2 min-w-0">
                  ${icon(component.icon, 18, present ? "text-primary-container shrink-0 mt-0.5" : "text-error shrink-0 mt-0.5")}
                  <div class="min-w-0">
                    <div class="font-h2 text-h2 text-on-surface">${escapeHtml(component.name)}</div>
                    <div class="font-table text-table text-on-surface-variant">${escapeHtml(component.stage)}</div>
                  </div>
                </div>
                <div class="font-ribbon text-ribbon ${present ? "text-primary-container" : "text-error"} border border-outline-variant bg-surface-container-lowest rounded-DEFAULT px-2 py-1">${present ? "present" : "missing"}</div>
              </div>
              <div class="grid grid-cols-1 md:grid-cols-[160px_1fr] gap-x-gutter gap-y-2 font-table text-table">
                <div class="text-on-surface-variant">Vendored path</div>
                <code class="text-on-surface break-all">${escapeHtml(component.path)}</code>
                <div class="text-on-surface-variant">Source</div>
                <code class="text-on-surface break-all">${escapeHtml(remote)}</code>
                <div class="text-on-surface-variant">Pinned version</div>
                <code class="text-on-surface break-all">${escapeHtml(commit)}${copiedAt ? ` · copied ${escapeHtml(copiedAt)}` : ""}</code>
                <div class="text-on-surface-variant">RDS usage</div>
                <div class="text-on-surface">${escapeHtml(component.usedFor)}</div>
                <div class="text-on-surface-variant">Upgrade effect</div>
                <div class="text-on-surface">${escapeHtml(component.upgradeEffect)}</div>
              </div>
              <div class="grid grid-cols-1 md:grid-cols-2 gap-gutter">
                <div class="bg-surface-container-lowest border border-outline-variant rounded-DEFAULT p-2">
                  <div class="font-ribbon text-ribbon text-on-surface-variant mb-1">Limitations</div>
                  <ul class="font-table text-table text-on-surface flex flex-col gap-1 list-disc pl-4">
                    ${component.limitations.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
                  </ul>
                </div>
                <div class="bg-surface-container-lowest border border-outline-variant rounded-DEFAULT p-2">
                  <div class="font-ribbon text-ribbon text-on-surface-variant mb-1">Update RDS after upstream changes</div>
                  <ol class="font-table text-table text-on-surface flex flex-col gap-1 list-decimal pl-4">
                    ${component.updateSteps.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
                  </ol>
                </div>
              </div>
            </article>
          `;
        }).join("")}
      </div>
      <div class="bg-surface border border-outline-variant rounded-DEFAULT p-2 font-table text-table text-on-surface-variant">
        Operational rule: vendored component upgrades apply cleanly to future builds. For an active build, either restart before the affected stage or patch the generated files already copied into the app.
      </div>
    </section>
  `;
}

function writeSettings(settings: RdsSettings) {
  mkdirSync(join(RDS_ROOT, "config"), { recursive: true });
  writeFileSync(SETTINGS_PATH, [
    "# RDS operator-console settings. Sourced by bin/rds-build.",
    `RDS_INFERENCE_PROVIDER=${shellQuote(settings.inferenceProvider)}`,
    `RDS_CLAUDE_MODEL=${shellQuote(settings.claudeModel)}`,
    `RDS_CODEX_MODEL=${shellQuote(settings.codexModel)}`,
    `RDS_DASHBOARD_THEME=${shellQuote(settings.theme)}`,
    "",
  ].join("\n"));
}

function stackOptions(): StackOption[] {
  const stacksDir = join(RDS_ROOT, "stacks");
  if (!existsSync(stacksDir)) return [];
  const stacks: StackOption[] = [];
  for (const entry of readdirSync(stacksDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const id = entry.name;
    const manifest = safeReadJson<Record<string, unknown>>(join(stacksDir, id, "manifest.json"));
    if (!manifest) continue;
    const status: StackOption["status"] = manifest.status === "stub" || manifest.status === "disabled" || manifest.status === "defer" ? manifest.status : "ready";
    const modes = Array.isArray(manifest.supports_modes) ? manifest.supports_modes.filter((m) => typeof m === "string") as string[] : ["green", "brown"];
    const canonicalId = STACK_RUNTIME_TO_CANONICAL[id] || id;
    const stackYaml = existsSync(join(stacksDir, id, "stack.yaml")) ? readFileSync(join(stacksDir, id, "stack.yaml"), "utf8") : "";
    const yamlField = (field: string) => {
      const match = stackYaml.match(new RegExp(`^${field}:\\s*"?([^"\\n]+)"?\\s*$`, "m"));
      return match?.[1]?.trim();
    };
    const mockupMatch = stackYaml.match(/^mockup_analog:\s*\n\s+primary:\s*"?([^"\n]+)"?/m);
    const presentation = STACK_PRESENTATION[canonicalId] || {
      label: typeof manifest.name === "string" ? manifest.name : canonicalId,
      shortLabel: typeof manifest.name === "string" ? manifest.name : canonicalId,
      subtitle: yamlField("category") || canonicalId,
      bestFor: yamlField("description") || (typeof manifest.notes === "string" ? manifest.notes : ""),
    };
    stacks.push({
      id: canonicalId,
      name: typeof manifest.name === "string" ? manifest.name : id,
      label: presentation.label,
      shortLabel: presentation.shortLabel,
      subtitle: presentation.subtitle,
      bestFor: presentation.bestFor,
      status,
      notes: typeof manifest.notes === "string" ? manifest.notes : undefined,
      supportsModes: modes,
      description: yamlField("description") || (typeof manifest.notes === "string" ? manifest.notes : undefined),
      category: yamlField("category"),
      mockup: mockupMatch?.[1]?.trim(),
      sourceLinks: STACK_SOURCE_LINKS[canonicalId] || [],
    });
  }
  return stacks.sort((a, b) => {
    const statusRank = (s: StackOption) => s.status === "ready" ? 0 : 1;
    const byStatus = statusRank(a) - statusRank(b);
    if (byStatus !== 0) return byStatus;
    const ai = NEW_BUILD_STACK_ORDER.indexOf(a.id);
    const bi = NEW_BUILD_STACK_ORDER.indexOf(b.id);
    if (ai !== -1 || bi !== -1) return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    return a.label.localeCompare(b.label);
  });
}

function skillOptions(): SkillOption[] {
  const registry = safeReadJson<{ skills?: Array<Record<string, unknown>> }>(join(RDS_ROOT, "skills", "registry.json"));
  const normalizeLinks = (links: unknown): ReferenceLink[] => Array.isArray(links)
    ? links.map((link) => {
        if (typeof link === "string") return { label: link.replace(/^https?:\/\//, "").replace(/\/$/, ""), url: link };
        if (!link || typeof link !== "object") return null;
        const row = link as Record<string, unknown>;
        const url = typeof row.url === "string" ? row.url : "";
        if (!url) return null;
        return { label: typeof row.label === "string" ? row.label : url.replace(/^https?:\/\//, "").replace(/\/$/, ""), url };
      }).filter((link): link is ReferenceLink => !!link)
    : [];
  return (registry?.skills || []).map((skill) => ({
    slug: String(skill.slug || ""),
    name: String(skill.name || skill.slug || ""),
    status: String(skill.status || "unknown"),
    appliesTo: Array.isArray(skill.applies_to) ? skill.applies_to.filter((v): v is string => typeof v === "string") : [],
    default: skill.default === true,
    description: typeof skill.description === "string" ? skill.description : undefined,
    category: typeof skill.category === "string" ? skill.category : undefined,
    maturity: typeof skill.maturity === "string" ? skill.maturity : undefined,
    rationale: typeof skill.rationale === "string" ? skill.rationale : undefined,
    installMode: typeof (skill.install as Record<string, unknown> | undefined)?.mode === "string"
      ? String((skill.install as Record<string, unknown>).mode)
      : typeof (skill.install as Record<string, unknown> | undefined)?.command === "string"
        ? "guide"
        : "metadata",
    verifyCommand: typeof (skill.verify as Record<string, unknown> | undefined)?.command === "string"
      ? String((skill.verify as Record<string, unknown>).command)
      : undefined,
    sourceLinks: normalizeLinks(skill.source_links),
  })).filter((skill) => skill.slug).sort((a, b) => {
    if (a.default !== b.default) return a.default ? -1 : 1;
    if (a.status !== b.status) return a.status === "ready" ? -1 : b.status === "ready" ? 1 : 0;
    return a.name.localeCompare(b.name);
  });
}

function skillSourceLabel(skill: SkillOption): string {
  if (skill.category) return skill.category.replace(/-/g, " ");
  if (skill.slug.startsWith("rds-")) return "Built-in RDS";
  if (skill.slug.includes("mcp")) return "MCP/context mount";
  if (skill.slug.startsWith("deploy-") || skill.slug.includes("deploy")) return "Deployment";
  if (skill.slug.startsWith("auth-")) return "Auth";
  if (skill.slug.startsWith("storage-")) return "Storage";
  if (skill.slug.startsWith("vector-") || skill.slug.startsWith("search-")) return "Data/search";
  if (skill.slug.startsWith("jobs-") || skill.slug.includes("queue")) return "Jobs";
  if (skill.slug.includes("playwright") || skill.slug.includes("test") || skill.slug.includes("eval")) return "Verification";
  return "Catalog";
}

function statusTone(status: string): string {
  if (status === "ready") return "border-primary-container text-primary-container";
  if (status === "curated") return "border-[#6f7bd9] text-[#aeb6ff]";
  return "border-outline-variant text-on-surface-variant";
}

function statusLabel(status: string): string {
  if (status === "ready") return "ready";
  if (status === "curated") return "curated";
  if (status === "planned") return "roadmap";
  return status || "unknown";
}

function skillReadinessLabel(skill: SkillOption): string {
  if (skill.status !== "ready") return statusLabel(skill.status);
  if (skill.installMode === "guide") return "guide + verify";
  if (skill.verifyCommand) return "metadata + verify";
  return "metadata";
}

function renderReferenceLinks(links: ReferenceLink[], compact = false): string {
  if (!links.length) return "";
  return `
    <div class="flex flex-wrap gap-1">
      ${links.map((link) => `<a href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1 border border-outline-variant rounded px-1.5 py-0.5 font-code text-[10px] text-primary-container hover:border-primary-container">${compact ? "" : icon("open_in_new", 12)}<span>${escapeHtml(link.label)}</span></a>`).join("")}
    </div>
  `;
}

function stackDecisionNote(stack: StackOption): { choose: string; avoid: string; example: string } {
  return STACK_DECISION_NOTES[stack.id] || {
    choose: stack.bestFor || stack.description || "Choose when the PRD clearly matches this runtime profile.",
    avoid: "Avoid when another stack has a more direct preview/runtime contract.",
    example: stack.subtitle || stack.id,
  };
}

function renderStackReferenceCard(stack: StackOption, compact = false): string {
  const note = stackDecisionNote(stack);
  const family = STACK_FAMILIES[stack.id] || stack.category || "Stack";
  return `
    <article id="stack-${escapeHtml(stack.id)}" class="bg-surface-container border border-outline-variant rounded-DEFAULT p-container-padding flex flex-col gap-stack-gap">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <div class="font-ribbon text-ribbon text-on-surface-variant uppercase tracking-wide">${escapeHtml(family)}</div>
          <h3 class="font-h2 text-h2 text-on-surface mt-1">${escapeHtml(stack.label)}</h3>
          <p class="font-table text-table text-on-surface-variant">${escapeHtml(stack.subtitle)}</p>
        </div>
        <span class="font-code text-[10px] border ${statusTone(stack.status)} rounded px-1.5 py-0.5 shrink-0">${escapeHtml(statusLabel(stack.status))}</span>
      </div>
      <p class="font-body text-body text-on-surface-variant">${escapeHtml(stack.bestFor || stack.description || "")}</p>
      ${compact ? "" : `
        <div class="grid grid-cols-1 md:grid-cols-3 gap-2">
          <div class="bg-surface border border-outline-variant rounded-DEFAULT p-2">
            <div class="font-ribbon text-ribbon text-on-surface-variant">Use when</div>
            <p class="font-table text-table text-on-surface-variant mt-1">${escapeHtml(note.choose)}</p>
          </div>
          <div class="bg-surface border border-outline-variant rounded-DEFAULT p-2">
            <div class="font-ribbon text-ribbon text-on-surface-variant">Do not use for</div>
            <p class="font-table text-table text-on-surface-variant mt-1">${escapeHtml(note.avoid)}</p>
          </div>
          <div class="bg-surface border border-outline-variant rounded-DEFAULT p-2">
            <div class="font-ribbon text-ribbon text-on-surface-variant">Example</div>
            <p class="font-table text-table text-on-surface-variant mt-1">${escapeHtml(note.example)}</p>
          </div>
        </div>
      `}
      <div class="flex flex-wrap gap-1">
        <code class="font-code text-[10px] border border-outline-variant rounded px-1.5 py-0.5 text-on-surface-variant">${escapeHtml(stack.id)}</code>
        ${stack.category ? `<code class="font-code text-[10px] border border-outline-variant rounded px-1.5 py-0.5 text-on-surface-variant">${escapeHtml(stack.category)}</code>` : ""}
        ${stack.mockup ? `<code class="font-code text-[10px] border border-outline-variant rounded px-1.5 py-0.5 text-on-surface-variant">mockup: ${escapeHtml(stack.mockup)}</code>` : ""}
        ${stack.supportsModes.map((mode) => `<code class="font-code text-[10px] border border-outline-variant rounded px-1.5 py-0.5 text-on-surface-variant">${escapeHtml(mode)}</code>`).join("")}
      </div>
      ${compact ? "" : `
        <div>
          <div class="font-ribbon text-ribbon text-on-surface-variant mb-1">Why RDS trusts this stack</div>
          <p class="font-table text-table text-on-surface-variant mb-2">The stack has a declared RDS contract, a doctor/smoke path, a Zo preview model, and curated framework references.</p>
          ${renderReferenceLinks(stack.sourceLinks)}
        </div>
      `}
    </article>
  `;
}

function renderSkillReferenceRow(skill: SkillOption): string {
  const source = skillSourceLabel(skill);
  const applies = skill.appliesTo.length ? skill.appliesTo.join(", ") : "stack-selected";
  const searchable = `${skill.name} ${skill.slug} ${skill.description || ""} ${skill.category || ""} ${skill.status} ${applies}`.toLowerCase();
  return `
    <details id="skill-${escapeHtml(skill.slug)}" data-skill-card data-status="${escapeHtml(skill.status)}" data-category="${escapeHtml(skill.category || source)}" data-applies="${escapeHtml(skill.appliesTo.join(","))}" data-search="${escapeHtml(searchable)}" class="bg-surface-container border border-outline-variant rounded-DEFAULT p-3 flex flex-col gap-2">
      <summary class="cursor-pointer font-ribbon text-ribbon text-primary-container mb-2">Details</summary>
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <h3 class="font-ribbon text-ribbon text-on-surface">${escapeHtml(skill.name)}</h3>
          <code class="font-code text-[10px] text-on-surface-variant break-all">${escapeHtml(skill.slug)}</code>
        </div>
        <span class="font-code text-[10px] border ${statusTone(skill.status)} rounded px-1.5 py-0.5 shrink-0">${escapeHtml(statusLabel(skill.status))}</span>
      </div>
      <p class="font-table text-table text-on-surface-variant">${escapeHtml(skill.description || "Catalog capability metadata used by skill resolution.")}</p>
      ${skill.rationale ? `<p class="font-table text-table text-on-surface-variant border-l-2 border-outline-variant pl-2">${escapeHtml(skill.rationale)}</p>` : ""}
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <div class="bg-surface border border-outline-variant rounded p-2">
          <div class="font-ribbon text-ribbon text-on-surface-variant">Category</div>
          <div class="font-table text-table text-on-surface-variant">${escapeHtml(source)}</div>
        </div>
        <div class="bg-surface border border-outline-variant rounded p-2">
          <div class="font-ribbon text-ribbon text-on-surface-variant">Applies to</div>
          <div class="font-table text-table text-on-surface-variant">${escapeHtml(applies)}</div>
        </div>
        <div class="bg-surface border border-outline-variant rounded p-2">
          <div class="font-ribbon text-ribbon text-on-surface-variant">RDS readiness</div>
          <div class="font-table text-table text-on-surface-variant">${escapeHtml(skillReadinessLabel(skill))}</div>
        </div>
        <div class="bg-surface border border-outline-variant rounded p-2">
          <div class="font-ribbon text-ribbon text-on-surface-variant">Maturity</div>
          <div class="font-table text-table text-on-surface-variant">${escapeHtml(skill.maturity || "unknown")}</div>
        </div>
      </div>
      ${renderReferenceLinks(skill.sourceLinks, true)}
    </details>
  `;
}

function inlineJson(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&]/g, (ch) => ({
    "<": "\\u003c",
    ">": "\\u003e",
    "&": "\\u0026",
  }[ch] || ch));
}

function readyStackIds(): Set<string> {
  const ids = new Set<string>();
  for (const stack of stackOptions().filter((stack) => stack.status === "ready")) {
    ids.add(stack.id);
    const runtime = STACK_ALIAS_TO_RUNTIME[stack.id];
    if (runtime) ids.add(runtime);
  }
  return ids;
}

// Single source of truth for stack→skills mapping: stacks/<runtime>/stack.yaml
// Replaces the previously hard-coded NEW_BUILD_STACK_SKILLS / rds-analyze-source STACK_SKILLS
// constants that disagreed about which skills applied to a stack.
function stackCompatibleSkills(stackId: string): { primary: string[]; universal: string[] } {
  const runtime = STACK_ALIAS_TO_RUNTIME[stackId] || stackId;
  const path = join(RDS_ROOT, "stacks", runtime, "stack.yaml");
  if (!existsSync(path)) return { primary: [], universal: [] };
  const text = readFileSync(path, "utf8");
  const block = text.match(/^compatible_skills:\s*\n([\s\S]*?)(?=^\S|\Z)/m);
  if (!block) return { primary: [], universal: [] };
  const inner = block[1];
  const sectionSlugs = (label: "primary" | "universal"): string[] => {
    const re = new RegExp(`^\\s{2}${label}:\\s*\\n((?:\\s{2,}-\\s+[^\\n]+\\n?)+)`, "m");
    const m = inner.match(re);
    if (!m) return [];
    return m[1]
      .split("\n")
      .map((line) => line.match(/^\s{2,}-\s+(.+)$/))
      .filter((m): m is RegExpMatchArray => !!m)
      .map((m) => m[1].trim());
  };
  return { primary: sectionSlugs("primary"), universal: sectionSlugs("universal") };
}

function stackPrimarySkillMap(stackIds: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const id of stackIds) {
    const { primary, universal } = stackCompatibleSkills(id);
    out[id] = Array.from(new Set([...primary, ...universal]));
  }
  return out;
}

function dismissedAlerts(): Set<string> {
  const data = safeReadJson<{ ids?: string[] }>(DISMISSED_ALERTS_PATH);
  return new Set((data?.ids || []).filter((id) => typeof id === "string"));
}

function writeDismissedAlerts(ids: Set<string>) {
  mkdirSync(join(RDS_ROOT, "dashboard"), { recursive: true });
  writeFileSync(DISMISSED_ALERTS_PATH, JSON.stringify({ ids: [...ids].sort(), updated_at: new Date().toISOString() }, null, 2) + "\n");
}

function dismissedReviews(): Set<string> {
  const data = safeReadJson<{ ids?: string[] }>(DISMISSED_REVIEWS_PATH);
  return new Set((data?.ids || []).filter((id) => typeof id === "string"));
}

function writeDismissedReviews(ids: Set<string>) {
  mkdirSync(join(RDS_ROOT, "dashboard"), { recursive: true });
  writeFileSync(DISMISSED_REVIEWS_PATH, JSON.stringify({ ids: [...ids].sort(), updated_at: new Date().toISOString() }, null, 2) + "\n");
}

function updateBuildPreview(id: string, preview: string) {
  const statePath = join(BUILDS_DIR, id, "state.json");
  const state = safeReadJson<Record<string, unknown>>(statePath);
  if (!state) return;
  state.preview_url = preview || null;
  state.updated_at = new Date().toISOString();
  writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
}

const MODEL_ID_RE = /^[a-zA-Z0-9._:-]{1,80}$/;

function normalizeProviderChoice(value: unknown): "claude" | "codex" | "" {
  return value === "claude" || value === "codex" ? value : "";
}

// Persist an operator's provider/model pick into state.inference so the next
// rds-iterate (which has no goal loop of its own) reads it as the source of truth.
function applyInferenceChoice(id: string, provider: "claude" | "codex" | "", model: string): void {
  if (!provider && !model) return;
  const statePath = join(BUILDS_DIR, id, "state.json");
  const state = safeReadJson<StateJson>(statePath) || {};
  const inference = { ...(state.inference || {}) };
  if (provider) inference.provider = provider;
  const effective = provider || inference.provider || "claude";
  if (model) {
    if (effective === "codex") inference.codex_model = model;
    else inference.claude_model = model;
  }
  state.inference = inference;
  state.updated_at = new Date().toISOString();
  writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
}

function serviceInfoPath(id: string): string {
  return join(BUILDS_DIR, id, "service.json");
}

function readServiceInfo(id: string): BuildServiceInfo | null {
  return safeReadJson<BuildServiceInfo>(serviceInfoPath(id));
}

function writeServiceInfo(id: string, info: BuildServiceInfo) {
  writeFileSync(serviceInfoPath(id), JSON.stringify({ ...info, updated_at: new Date().toISOString() }, null, 2) + "\n");
}

function readPidfile(path: string): Record<string, string> | null {
  if (!existsSync(path)) return null;
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const idx = line.indexOf("=");
    if (idx < 0) continue;
    out[line.slice(0, idx)] = line.slice(idx + 1).trim();
  }
  return out;
}

function pidIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function pidCommandLine(pid: number): string {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim();
  } catch {
    // No /proc outside Linux (macOS dev hosts) — fall back to ps so running
    // builds are still detected instead of silently reading as stopped.
    try {
      const out = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8", timeout: 2000 });
      return out.status === 0 ? (out.stdout || "").trim() : "";
    } catch {
      return "";
    }
  }
}

function pidIsBuildRunner(pid: number, buildId: string): boolean {
  if (!pidIsAlive(pid)) return false;
  const cmdline = pidCommandLine(pid);
  if (!cmdline) return false;
  if (!/(^|[\s/])(rds-build|launch-build\.sh)(\s|$)/.test(cmdline)) return false;
  return cmdline.includes(buildId) || cmdline.includes(`/builds/${buildId}/`);
}

function localPreviewPid(appDest?: string): number | undefined {
  if (!appDest) return undefined;
  const pidPath = join(appDest, "tmp", "pids", "server.pid");
  if (!existsSync(pidPath)) return undefined;
  const raw = readFileSync(pidPath, "utf8").trim();
  if (!/^\d+$/.test(raw)) return undefined;
  const pid = Number(raw);
  return pidIsAlive(pid) ? pid : undefined;
}

function fileMtimeMs(path: string): number {
  try { return statSync(path).mtimeMs; } catch { return 0; }
}

function newestFileMtimeMs(dir: string, suffix = ""): number {
  if (!existsSync(dir)) return 0;
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (suffix && !entry.name.endsWith(suffix)) continue;
    newest = Math.max(newest, fileMtimeMs(join(dir, entry.name)));
  }
  return newest;
}

// state.current_stage can be stale or overwritten by inner sub-stage emissions
// (e.g. taste-review's `iterate` runs its own QA pass which clobbers
// current_stage="qa" and stages.qa.status="failed" even though the outer
// pipeline is still in taste-review). Trust the structured stages map: walk
// pipeline order and return the last stage marked "running". Falls back to
// the top-level field only if no stage is running.
function deriveCurrentStage(state: StateJson): string {
  const stages = (state.stages || {}) as Record<string, { status?: string }>;
  let running = "";
  let pendingReview = "";
  for (const def of STAGE_ORDER) {
    const s = stages[def.id]?.status;
    if (s === "running") running = def.id;
    if (s === "pending-review") pendingReview = def.id;
  }
  return running || pendingReview || state.current_stage || state.stage || "";
}

function scaffoldActivityMtimeMs(id: string, state?: StateJson): number {
  const dir = join(BUILDS_DIR, id);
  const currentState = state || safeReadJson<StateJson>(join(dir, "state.json")) || {};
  const currentStage = currentState.current_stage || currentState.stage || "";
  if (currentStage !== "scaffold" && currentState.status !== "running") return 0;
  const appDest = currentState.app_dest || resolveAppDest(dir);
  if (!appDest || !existsSync(appDest)) return 0;
  return Math.max(
    fileMtimeMs(join(appDest, "tasks.json")),
    fileMtimeMs(join(appDest, ".scaffold", "events.jsonl")),
    fileMtimeMs(join(appDest, ".scaffold", "state.json")),
    newestFileMtimeMs(join(appDest, ".scaffold", "telemetry"), ".json")
  );
}

async function listBuilds(limit = 30, opts: { includeDemo?: boolean } = {}): Promise<BuildRow[]> {
  if (!existsSync(BUILDS_DIR)) return [];
  const entries = await readdir(BUILDS_DIR, { withFileTypes: true });
  let dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  if (!opts.includeDemo) {
    // Hide internal selftest + smoke-test dirs from the operator's main view.
    dirs = dirs.filter((n) => !n.startsWith("_") && !n.startsWith("rds-smoke-"));
  }
  const stamped = await Promise.all(dirs.map(async (name) => {
    const s = await stat(join(BUILDS_DIR, name)).catch(() => null);
    return { name, mtime: s ? s.mtimeMs : 0 };
  }));
  stamped.sort((a, b) => b.mtime - a.mtime);
  return stamped.slice(0, limit).map(({ name }) => readBuildRow(name));
}

function readBuildRow(id: string): BuildRow {
  const dir = join(BUILDS_DIR, id);
  const state = safeReadJson<StateJson>(join(dir, "state.json")) || {};
  const pidf = readPidfile(join(dir, "run.pid"));
  let running = false;
  let pid: number | undefined;
  if (pidf?.pid && /^\d+$/.test(pidf.pid)) {
    pid = Number(pidf.pid);
    running = pidIsBuildRunner(pid, id);
  }
  // Last activity = newest durable or task-level signal. Scaffold can be
  // actively moving tasks while the terminal stream is quiet, especially after
  // pause/resume, so tasks.json and Scaffold telemetry count as live activity.
  const lastActivityMs = Math.max(
    fileMtimeMs(join(dir, "events.jsonl")),
    fileMtimeMs(SHM_LOG(id)),
    newestFileMtimeMs(join(dir, "logs"), ".log"),
    scaffoldActivityMtimeMs(id, state)
  );
  const stuck = running && lastActivityMs > 0 && (Date.now() - lastActivityMs) > STUCK_AFTER_MS;
  const stageValues = state.stages && typeof state.stages === "object"
    ? Object.values(state.stages as Record<string, { status?: string }>)
    : [];
  const hasRunningStage = stageValues.some((v) => v && v.status === "running");
  const runnerMissing = !running && hasRunningStage && state.status !== "paused";
  // Derive a top-level status when state.status is missing: failed > running > done > unknown.
  let derivedStatus: BuildRow["status"] = state.status;
  if (!derivedStatus && state.stages && typeof state.stages === "object") {
    const vals = stageValues;
    // If the build process is alive, an earlier stage marked "failed" is
    // almost always a sub-stage rerun being iterated by taste-review (e.g.
    // iterate clobbers stages.qa.status="failed" while taste-review.status
    // is still "running"). Prefer "running" so the UI doesn't shout "Failed"
    // at a build that's actively healing itself.
    if (running) derivedStatus = "running";
    else if (runnerMissing) derivedStatus = "stalled";
    else if (vals.some((v) => v && v.status === "failed")) derivedStatus = "failed";
    else if (vals.length && vals.every((v) => v && (v.status === "done" || v.status === "skipped"))) derivedStatus = "done";
  }
  if (!derivedStatus && state.current_stage && state.stages && typeof state.stages === "object") {
    const stageStatus = (state.stages as Record<string, { status?: string }>)[state.current_stage]?.status;
    if (stageStatus === "failed") derivedStatus = "failed";
  }
  // Operator review is the terminal state — it wins over earlier "failed"
  // sub-stages so the row shows "Approve/Reject" instead of "Spawn fixer".
  if (!running && state.review?.status === "pending") {
    derivedStatus = "pending_review";
  }
  const serviceInfo = readServiceInfo(id);
  const preview = state.preview_url || undefined;
  const appDest = state.app_dest || resolveAppDest(dir);
  const appType = normalizeAppType(state.app_type || inferAppTypeForBuild(id, state));
  const hasZoService = !!serviceInfo?.service_id && serviceInfo.status !== "deregistered";
  const paused = state.status === "paused";
  const derivedStage = deriveCurrentStage(state);
  return {
    id,
    slug:           state.slug,
    displayName:    computeBuildDisplayName(id, state),
    mode:           state.mode,
    appType,
    stack:          state.stack,
    stage:          paused ? (state.paused_from_stage || derivedStage) : derivedStage,
    status:         derivedStatus,
    paused,
    preview,
    previewPending: isPendingPreview(preview),
    liveOnZo: hasZoService && serviceInfo?.status === "live" && !!(serviceInfo.url || preview),
    hasZoService,
    serviceStatus: serviceInfo?.status,
    localPreviewRunning: !!localPreviewPid(appDest),
    appDest,
    provider:       state.inference?.provider,
    startedAt:      state.started_at || pidf?.started_at,
    running,
    pid,
    stuck,
    runnerMissing,
    lastActivityMs,
    reviewStatus:   state.review?.status,
    costUsd:        state.cost?.total_usd,
    costTokens:     state.cost?.total_tokens,
    buildPlan:      state.build_plan
  };
}

function normalizeAppType(value: unknown): string | undefined {
  const raw = String(value || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!raw || raw === "auto") return undefined;
  const allowed = new Set(["website", "web-app", "game", "dashboard", "internal-tool", "prototype", "hack", "content-site"]);
  return allowed.has(raw) ? raw : undefined;
}

function analyzeSourceText(source: string, appType = "auto"): SourceAnalysis | null {
  if (!source.trim()) return null;
  const analyzer = spawnSync(join(RDS_ROOT, "bin", "rds-analyze-source"), ["-", "--app-type", appType || "auto"], {
    cwd: RDS_ROOT,
    input: source,
    encoding: "utf8",
    timeout: 5000,
  });
  if (analyzer.status !== 0 || !analyzer.stdout) return null;
  try {
    return JSON.parse(analyzer.stdout) as SourceAnalysis;
  } catch {
    return null;
  }
}

function hasAttachmentEvidence(text: string): boolean {
  return /(^|\n)## Extracted (?:text|PDF|ZIP) attachment:/i.test(text)
    || /(^|\n)--- attached (?:text )?source ---/i.test(text);
}

function appTypeLabel(value?: string): string {
  switch (value) {
    case "web-app": return "Web app";
    case "internal-tool": return "Internal tool";
    case "content-site": return "Content site";
    default: return displayTokenLabel(value || "auto");
  }
}

const ACRONYM_PRESERVE = new Set([
  "qa", "uat", "ai", "ui", "ux", "api", "url", "prd", "rds", "qaa",
  "css", "html", "js", "ts", "io", "id", "db", "seo", "ci", "cd",
]);

function displayTokenLabel(value?: string): string {
  const raw = String(value || "").trim();
  if (!raw) return "-";
  return raw
    .replace(/[-_]+/g, " ")
    .split(" ")
    .map((word) => {
      if (!word) return word;
      const low = word.toLowerCase();
      if (ACRONYM_PRESERVE.has(low)) return low.toUpperCase();
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");
}

function stackDisplayLabel(value?: string): string {
  const raw = String(value || "").trim();
  if (!raw) return "-";
  const canonical = STACK_RUNTIME_TO_CANONICAL[raw] || raw;
  return STACK_PRESENTATION[canonical]?.shortLabel || displayTokenLabel(canonical);
}

function modeDisplayLabel(value?: string): string {
  switch (String(value || "").trim().toLowerCase()) {
    case "green": return "Greenfield";
    case "brown": return "Brownfield";
    default: return displayTokenLabel(value);
  }
}

function builderDisplayLabel(value?: string): string {
  switch (String(value || "").trim().toLowerCase()) {
    case "codex": return "Codex";
    case "claude": return "Claude";
    default: return displayTokenLabel(value);
  }
}

function inferAppTypeForBuild(id: string, state: StateJson): string | undefined {
  const buildDir = join(BUILDS_DIR, id);
  const spec = existsSync(join(buildDir, "spec.md")) ? readFileSync(join(buildDir, "spec.md"), "utf8").slice(0, 12000) : "";
  const research = existsSync(join(buildDir, "research.md")) ? readFileSync(join(buildDir, "research.md"), "utf8").slice(0, 12000) : "";
  const text = `${state.trigger || ""}\n${spec}\n${research}`.toLowerCase();
  if (/\b(game|arcade|dig dug|snake|tetris|pong|breakout|asteroids|missile command|space invaders)\b/.test(text)) return "game";
  if (/\b(landing page|homepage|portfolio|marketing site|website)\b/.test(text)) return "website";
  if (/\b(dashboard|analytics|admin|ops|operator console)\b/.test(text)) return "dashboard";
  if (/\b(tool|workflow|crm|kanban|todo|calendar)\b/.test(text)) return "internal-tool";
  if (state.stack === "react") return "web-app";
  return undefined;
}

function usesDirectPreview(stack?: string): boolean {
  return new Set([
    "react",
    "nextjs",
    "python-ai-service",
    "astro-thin-web",
    "web-3d",
    "game-engine",
    "browser-extension",
    "react-native",
    "game-asset-pipeline",
  ]).has(stack || "");
}

function readEvents(id: string, after = 0): { lines: string[]; size: number } {
  const dir = buildDirForId(id);
  if (!dir) return { lines: [], size: 0 };
  const path = join(dir, "events.jsonl");
  if (!isContainedPath(dir, path)) return { lines: [], size: 0 };
  if (!existsSync(path)) return { lines: [], size: 0 };
  const s = statSync(path);
  if (s.size <= after) return { lines: [], size: s.size };
  const text = readFileSync(path, "utf8");
  const slice = after > 0 ? text.slice(after) : text;
  return {
    lines: slice.split("\n").map((l) => l.trim()).filter(Boolean),
    size:  s.size
  };
}

function buildBriefPath(id: string): string {
  return join(BUILDS_DIR, id, "build-summary.json");
}

function isReadableFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

function allowedBuildDocPath(path: string, buildDir: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  const roots = [
    buildDir,
    RDS_ROOT,
    INBOX_DIR,
    DEFAULT_PROJECTS_DIR,
  ].map((root) => root.replace(/\\/g, "/").replace(/\/+$/, ""));
  return roots.some((root) => normalized === root || normalized.startsWith(`${root}/`));
}

function docPathLabel(path: string, buildDir: string): string {
  const normalized = path.replace(/\\/g, "/");
  const buildRoot = buildDir.replace(/\\/g, "/").replace(/\/+$/, "");
  const rdsRoot = RDS_ROOT.replace(/\\/g, "/").replace(/\/+$/, "");
  if (normalized.startsWith(`${buildRoot}/`)) return normalized.slice(buildRoot.length + 1);
  if (normalized.startsWith(`${rdsRoot}/`)) return normalized.slice(rdsRoot.length + 1);
  return path;
}

function latestQaIterationDir(id: string): string | null {
  try {
    const latest = listQaIterations(id)[0];
    return latest ? join(BUILDS_DIR, id, "playwright", latest.name) : null;
  } catch {
    return null;
  }
}

function collectBuildInputDocs(id: string, state: StateJson): BuildInputDoc[] {
  const buildDir = join(BUILDS_DIR, id);
  const latestQa = latestQaIterationDir(id);
  const candidates: Array<Omit<BuildInputDoc, "pathLabel" | "size" | "mtimeMs">> = [];
  const add = (doc: Omit<BuildInputDoc, "pathLabel" | "size" | "mtimeMs"> | null | undefined) => {
    if (!doc) return;
    if (!doc.path || !isReadableFile(doc.path)) return;
    if (!allowedBuildDocPath(doc.path, buildDir)) return;
    candidates.push(doc);
  };
  const trigger = String(state.prd_source || state.trigger || "").trim();
  if (trigger && !/^https?:\/\//i.test(trigger)) {
    add({
      key: "original-prd",
      label: "Original PRD / submitted input",
      kind: "input",
      path: trigger,
      note: "The source file RDS received at intake.",
    });
  }
  add({ key: "generated-spec", label: "Generated implementation spec", kind: "spec", path: join(buildDir, "spec.md"), note: "Canonical RDS spec used by Scaffold." });
  add({ key: "research", label: "Research brief", kind: "input", path: join(buildDir, "research.md"), note: "Research/context produced before spec generation." });
  add({ key: "wiki-research", label: "Wiki research", kind: "input", path: join(buildDir, "wiki", "research.md"), note: "Wiki research output, when present." });
  add({ key: "po-questions", label: "Product owner questions", kind: "input", path: state.po_questions_file || join(buildDir, "wiki", "review", "product-owner-questions.md"), note: "Questions or ambiguities raised during spec generation." });
  add({ key: "build-plan", label: "Execution plan", kind: "plan", path: join(buildDir, "build-plan.json"), note: "Task budget/profile selected for the build." });
  add({ key: "scaffold-tasks", label: "Scaffold task list", kind: "plan", path: join(buildDir, "scaffold-out", "tasks.json"), note: "Task queue handed to the builder." });
  add({ key: "app-tasks", label: "App task list", kind: "plan", path: join(buildDir, "deploy-snapshot", "tasks.json"), note: "Task queue copied into the generated app snapshot." });
  add({ key: "taste-brief", label: "Taste brief", kind: "spec", path: join(buildDir, "taste-brief.md"), note: "Product-quality brief appended before implementation." });
  add({ key: "qa-scenarios", label: "QA scenarios", kind: "qa", path: join(buildDir, "qa-scenarios.json"), note: "Scenario contract RDS expects the app to satisfy." });
  if (latestQa) {
    add({ key: "prd-coverage", label: "Latest PRD coverage verdict", kind: "qa", path: join(latestQa, "prd-coverage-verdict.json"), note: "Row-level PRD promise coverage from the latest QA pass." });
    add({ key: "scenario-verdict", label: "Latest scenario verdict", kind: "qa", path: join(latestQa, "scenario-verdict.json"), note: "Scenario execution evidence from the latest QA pass." });
  }
  const seen = new Set<string>();
  return candidates
    .filter((doc) => {
      const key = `${doc.key}:${doc.path}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((doc) => {
      const stat = statSync(doc.path);
      return {
        ...doc,
        pathLabel: docPathLabel(doc.path, buildDir),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      };
    });
}

function findBuildInputDoc(id: string, key: string): BuildInputDoc | null {
  const state = safeReadJson<StateJson>(join(BUILDS_DIR, id, "state.json")) || {};
  return collectBuildInputDocs(id, state).find((doc) => doc.key === key) || null;
}

function firstMarkdownSection(md: string, heading: string): string {
  const re = new RegExp(`^##\\s+${heading}\\s*$([\\s\\S]*?)(?=^##\\s+|$)`, "im");
  const match = md.match(re);
  return (match?.[1] || "").trim();
}

function compactText(value: string, max = 420): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return text.slice(0, max - 1).trimEnd() + "…";
}

function escapeJsString(value: string): string {
  return JSON.stringify(value).slice(1, -1).replace(/'/g, "\\'");
}

function cleanBuildDisplayName(value: unknown): string {
  let text = String(value || "").replace(/\r/g, " ").replace(/\s+/g, " ").trim();
  text = text.replace(/^#+\s*/, "");
  text = text.replace(/^spec:\s*/i, "");
  text = text.replace(/([a-z0-9)])([A-Z][a-z]+:)/g, "$1 $2");
  const prdMatch = text.match(/^(.{2,80}?)(?:\s+[—-]\s+)?Product Requirements Document(?:\s+\(PRD\))?\s*(v\d+(?:\.\d+)?)?/i);
  if (prdMatch) {
    const name = cleanBuildDisplayName([prdMatch[1], prdMatch[2]].filter(Boolean).join(" "));
    if (name) return name;
  }
  const hardStop = text.search(/\b(?:Version|Owner|Status|Last Updated|Predecessors|Executive Summary):|\b0\)\s+/i);
  if (hardStop > 8) text = text.slice(0, hardStop).trim();
  text = text.replace(/\s+[—-]\s+(scaffold spec|implementation specification|build specification|product specification)$/i, "");
  text = text.replace(/\s+(scaffold spec|implementation spec|implementation specification|build specification|product specification|prd)$/i, "");
  text = text.replace(/^the-web-agnostic-master-prompt$/i, "");
  if (!text) return "";
  if (/^[a-z0-9][a-z0-9-]+$/.test(text)) {
    text = text.split("-").filter(Boolean).map((word) => word.length <= 3 ? word.toUpperCase() : word[0].toUpperCase() + word.slice(1)).join(" ");
  }
  return text.slice(0, 96);
}

function headingFromMarkdown(md: string): string {
  const h1 = md.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return cleanBuildDisplayName(h1);
}

function overviewNameFromMarkdown(md: string): string {
  const overview = firstMarkdownSection(md, "Overview");
  const first = (overview || md)
    .split(/[.\n]/)
    .map((l) => l.trim())
    .find((l) => /\b(build|create|implement|browser|app|game|dashboard|copilot|tool|website)\b/i.test(l));
  if (!first) return "";
  const match = first.match(/\b(?:build|create|implement)\s+(?:a|an|the)?\s*([^.;\n]+?)(?:\s+for\b|$)/i);
  return cleanBuildDisplayName(String(match?.[1] || first).replace(/^browser-based,\s*playable\s+/i, ""));
}

function buildNameFromId(id: string): string {
  return cleanBuildDisplayName(id.replace(/-\d{10,}.*$/, "").replace(/-\d{8}-\d{6}$/, "").replace(/-/g, " ")) || compactBuildId(id);
}

function computeBuildDisplayName(id: string, state: StateJson): string {
  const explicit = cleanBuildDisplayName(state.display_name);
  if (explicit) return explicit;
  const cached = safeReadJson<BuildBriefState>(buildBriefPath(id));
  const cachedTitle = cleanBuildDisplayName(cached?.title);
  if (cachedTitle && !/^implementation spec$/i.test(cachedTitle)) return cachedTitle;
  const buildDir = join(BUILDS_DIR, id);
  const spec = existsSync(join(buildDir, "spec.md")) ? readFileSync(join(buildDir, "spec.md"), "utf8") : "";
  const research = existsSync(join(buildDir, "research.md")) ? readFileSync(join(buildDir, "research.md"), "utf8") : "";
  const specTitle = headingFromMarkdown(spec);
  if (specTitle && !/^implementation spec$/i.test(specTitle)) return specTitle;
  const overviewTitle = overviewNameFromMarkdown(spec);
  if (overviewTitle) return overviewTitle;
  const researchTitle = headingFromMarkdown(research) || overviewNameFromMarkdown(research);
  if (researchTitle) return researchTitle;
  const repoTitle = state.repo_url ? cleanBuildDisplayName(basename(String(state.repo_url).replace(/\.git$/, ""))) : "";
  if (repoTitle) return repoTitle;
  return buildNameFromId(id);
}

function titleFromSpec(spec: string, id: string): string {
  const h1 = headingFromMarkdown(spec);
  if (h1 && !/^implementation spec$/i.test(h1)) return h1;
  const overview = overviewNameFromMarkdown(spec);
  if (overview) return overview;
  return buildNameFromId(id);
}

function fallbackBuildBrief(id: string, state: StateJson, row: BuildRow): BuildBriefState {
  const buildDir = join(BUILDS_DIR, id);
  const spec = existsSync(join(buildDir, "spec.md")) ? readFileSync(join(buildDir, "spec.md"), "utf8") : "";
  const research = !spec && existsSync(join(buildDir, "research.md")) ? readFileSync(join(buildDir, "research.md"), "utf8") : "";
  const sourceText = spec || research;
  const title = titleFromSpec(sourceText, id);
  const overview = firstMarkdownSection(sourceText, "Overview")
    || sourceText.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#")).slice(0, 3).join(" ");
  const stateLine = [
    row.status ? `status ${row.status}` : "",
    state.review?.status ? `review ${state.review.status}` : "",
    row.stage ? `stage ${row.stage}` : "",
    row.stack ? `stack ${row.stack}` : "",
    row.mode ? `mode ${row.mode}` : "",
  ].filter(Boolean).join(" · ");
  const trigger = state.repo_url || state.prd_source || state.trigger || "";
  const hostingPoint = row.liveOnZo
    ? `Hosted on Zo: ${readServiceInfo(id)?.url || row.preview || "service URL recorded"}`
    : row.hasZoService
      ? `Zo service recorded: ${readServiceInfo(id)?.service_id || "unknown service id"} (${row.serviceStatus || "unknown"})`
      : row.serviceStatus === "deregistered"
        ? "Zo service deleted; not consuming a hosted-service slot."
        : row.localPreviewRunning
          ? `Local preview running: ${row.preview || "URL not recorded"}`
          : row.preview
            ? `Preview stopped: ${row.preview}`
            : "Preview: none recorded";
  const points = [
    stateLine || "No lifecycle state recorded yet.",
    trigger ? `Input: ${trigger}` : "",
    row.appDest ? `App: ${row.appDest}` : "",
    hostingPoint,
  ].filter(Boolean);
  return {
    status: "fallback",
    source: "deterministic",
    title,
    summary: compactText(overview || "No spec summary is available yet. Generate an AI brief after the spec or intake stage has produced context."),
    key_points: points,
  };
}

function readBuildBrief(id: string, state: StateJson, row: BuildRow): BuildBriefState {
  const cached = safeReadJson<BuildBriefState>(buildBriefPath(id));
  if (cached?.status) return cached;
  return fallbackBuildBrief(id, state, row);
}

function buildAttentionRank(row: BuildRow): number {
  if (row.running) return 0;
  if (row.stuck) return 1;
  if (row.liveOnZo) return 2;
  if (row.hasZoService) return 3;
  if (row.reviewStatus === "pending") return 4;
  if (row.status === "failed") return 5;
  if (row.localPreviewRunning) return 6;
  return 9;
}

function buildAttentionSort(a: BuildRow, b: BuildRow): number {
  const rank = buildAttentionRank(a) - buildAttentionRank(b);
  if (rank !== 0) return rank;
  return compareNumber(b.lastActivityMs, a.lastActivityMs) || compareText(a.displayName || a.id, b.displayName || b.id);
}

function parseAiBuildBrief(text: string, fallback: BuildBriefState): BuildBriefState {
  const clean = text.replace(/\r/g, "").trim();
  const lines = clean.split("\n").map((l) => l.trim()).filter(Boolean);
  const bullets = lines
    .filter((l) => /^[-*•]\s+/.test(l))
    .map((l) => l.replace(/^[-*•]\s+/, "").trim())
    .slice(0, 5);
  const prose = lines
    .filter((l) => !/^[-*•]\s+/.test(l) && !/^#+\s+/.test(l))
    .join(" ")
    .trim();
  return {
    status: "ready",
    source: "ai",
    title: fallback.title,
    summary: compactText(prose || fallback.summary, 520),
    key_points: bullets.length ? bullets : fallback.key_points,
    generated_at: new Date().toISOString(),
  };
}

function startBuildBriefGeneration(id: string): { ok: boolean; error?: string; status?: number } {
  const dir = join(BUILDS_DIR, id);
  if (!existsSync(dir)) return { ok: false, status: 404, error: "build not found" };
  const path = buildBriefPath(id);
  const current = safeReadJson<BuildBriefState>(path);
  if (current?.status === "running") return { ok: true };
  const state = safeReadJson<StateJson>(join(dir, "state.json")) || {};
  const fallback = fallbackBuildBrief(id, state, readBuildRow(id));
  writeFileSync(path, JSON.stringify({
    ...fallback,
    status: "running",
    source: "ai",
    summary: fallback.summary,
    generated_at: new Date().toISOString(),
  } satisfies BuildBriefState, null, 2) + "\n");
  const cmd = join(RDS_ROOT, "bin", "rds-chat");
  if (!existsSync(cmd)) {
    writeFileSync(path, JSON.stringify({ ...fallback, status: "failed", source: "ai", error: "bin/rds-chat missing" } satisfies BuildBriefState, null, 2) + "\n");
    return { ok: false, status: 500, error: "bin/rds-chat missing" };
  }
  const child = spawn(cmd, [`--build-id=${id}`, "--max-budget-usd=0.40"], {
    cwd: RDS_ROOT,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, RDS_NOTIFY_DISABLED: "1" }
  });
  const prompt = [
    "Generate a concise build brief for the operator dashboard.",
    "Say what the app/project is supposed to be, not just pipeline status.",
    "Use one short paragraph, then 3-5 bullet points.",
    "Include current review/deploy state only if it affects what the operator should know.",
  ].join("\n");
  child.stdin.end(prompt);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d.toString()));
  child.stderr.on("data", (d) => (stderr += d.toString()));
  child.on("close", (code) => {
    const freshState = safeReadJson<StateJson>(join(dir, "state.json")) || {};
    const freshFallback = fallbackBuildBrief(id, freshState, readBuildRow(id));
    if (code === 0 && stdout.trim()) {
      writeFileSync(path, JSON.stringify(parseAiBuildBrief(stdout, freshFallback), null, 2) + "\n");
    } else {
      writeFileSync(path, JSON.stringify({
        ...freshFallback,
        status: "failed",
        source: "ai",
        generated_at: new Date().toISOString(),
        error: (stderr.trim() || stdout.trim() || `rds-chat exited ${code ?? "?"}`).slice(0, 1000),
      } satisfies BuildBriefState, null, 2) + "\n");
    }
  });
  child.on("error", (err) => {
    writeFileSync(path, JSON.stringify({
      ...fallback,
      status: "failed",
      source: "ai",
      generated_at: new Date().toISOString(),
      error: `spawn failed: ${err.message}`,
    } satisfies BuildBriefState, null, 2) + "\n");
  });
  return { ok: true };
}

function renderBuildBriefBox(id: string, brief: BuildBriefState): string {
  const cleanSummary = brief.summary
    .replace(/^>\s*Generated by (?:Legacy )?Wiki.*$/im, "")
    .replace(/\s+/g, " ")
    .trim();
  const usefulPoints = brief.key_points
    .filter((p) => !/\b(status|review|stage|stack|mode|input|preview|app:|generated by)\b/i.test(p))
    .slice(0, 4);
  const points = usefulPoints.map((p) => `
    <li class="flex gap-2 min-w-0">
      <span class="mt-[7px] h-1.5 w-1.5 rounded-full bg-primary-container/80 shrink-0"></span>
      <span class="break-words">${escapeHtml(p)}</span>
    </li>`).join("");
  const badge = brief.status === "ready"
    ? "AI brief"
    : brief.status === "running"
      ? "generating"
      : brief.status === "failed"
        ? "AI failed"
        : "spec fallback";
  const tone = brief.status === "failed" ? "text-error" : brief.status === "running" ? "text-tertiary-container" : "text-primary-container";
  return `
    <section id="build-brief-card" class="rds-decision-card bg-surface border border-primary-container/25 rounded-DEFAULT p-3 flex flex-col gap-3">
      <div class="flex items-start justify-between gap-3 flex-wrap">
        <div class="min-w-0">
          <div class="font-ribbon text-ribbon text-primary-container uppercase">Source brief</div>
          <h2 id="build-brief-title" class="font-h2 text-h2 text-on-surface mt-0.5 break-words">${escapeHtml(brief.title)}</h2>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          <span id="build-brief-badge" class="px-2 py-1 rounded bg-[#101412] border border-outline-variant font-code text-[11px] ${tone}">${escapeHtml(badge)}</span>
          <button type="button" onclick="refreshBuildBrief()" class="px-2 py-1 border border-outline-variant bg-surface hover:bg-surface-bright text-on-surface rounded-DEFAULT font-ribbon text-ribbon transition-colors flex items-center gap-1">${icon("auto_awesome", 14)}<span>AI refresh</span></button>
        </div>
      </div>
      <p id="build-brief-summary" class="font-table text-table text-on-surface-variant break-words">${escapeHtml(cleanSummary || "RDS has enough context to continue this build.")}</p>
      ${points ? `<ul id="build-brief-points" class="grid md:grid-cols-2 gap-x-4 gap-y-1 font-ribbon text-ribbon text-on-surface-variant">${points}</ul>` : `<ul id="build-brief-points" class="hidden"></ul>`}
      <details class="font-code text-[11px] text-outline">
        <summary class="cursor-pointer hover:text-on-surface inline-flex items-center gap-1">${icon("data_object", 13)}<span>source details</span></summary>
        <pre class="mt-2 bg-[#070908] border border-outline-variant rounded p-2 whitespace-pre-wrap break-words max-h-40 overflow-auto custom-scrollbar">${escapeHtml(brief.summary)}</pre>
      </details>
      ${brief.error ? `<div id="build-brief-error" class="font-ribbon text-ribbon text-error">${escapeHtml(brief.error)}</div>` : `<div id="build-brief-error" class="hidden"></div>`}
    </section>`;
}

function renderBuildInputDocsPanel(id: string, state: StateJson): string {
  const docs = collectBuildInputDocs(id, state);
  if (!docs.length) return "";
  const primaryOrder = ["original-prd", "generated-spec", "scaffold-tasks", "build-plan"];
  const primaryDocs = [
    ...primaryOrder.map((key) => docs.find((doc) => doc.key === key)).filter((doc): doc is BuildInputDoc => !!doc),
    ...docs.filter((doc) => !primaryOrder.includes(doc.key)).slice(0, 4),
  ].slice(0, 8);
  const kindIcon = (kind: BuildInputDoc["kind"]) => ({
    input: "source_notes",
    spec: "description",
    plan: "account_tree",
    qa: "fact_check",
    app: "inventory_2",
  }[kind] || "description");
  const cards = primaryDocs.map((doc) => {
    const raw = `/b/${encodeURIComponent(id)}/docs/raw?key=${encodeURIComponent(doc.key)}`;
    const download = `${raw}&download=1`;
    const size = typeof doc.size === "number" ? `${Math.max(1, Math.round(doc.size / 1024))} KiB` : "";
    return `
      <article class="rds-input-doc-card">
        <div class="flex items-start gap-2 min-w-0">
          ${icon(kindIcon(doc.kind), 17, "text-primary-container shrink-0 mt-0.5")}
          <div class="min-w-0 flex-1">
            <div class="font-h2 text-[14px] leading-5 text-on-surface truncate">${escapeHtml(doc.label)}</div>
            <div class="font-code text-[11px] leading-4 text-on-surface-variant break-all">${escapeHtml(doc.pathLabel)}</div>
          </div>
          <span class="rds-input-doc-kind">${escapeHtml(displayTokenLabel(doc.kind))}</span>
        </div>
        <p class="font-ribbon text-ribbon text-on-surface-variant mt-2">${escapeHtml(doc.note)}</p>
        <div class="rds-input-doc-actions">
          <a href="${escapeHtml(raw)}" target="_blank" class="rds-input-doc-btn">${icon("open_in_new", 13)}<span>Open</span></a>
          <a href="${escapeHtml(download)}" class="rds-input-doc-btn">${icon("download", 13)}<span>Download</span></a>
          <button type="button" class="rds-input-doc-btn" onclick="copyBuildDocPath('${escapeJsString(doc.pathLabel)}')">${icon("content_copy", 13)}<span>Copy path</span></button>
          ${size ? `<span class="font-code text-[10.5px] text-outline ml-auto">${escapeHtml(size)}</span>` : ""}
        </div>
      </article>`;
  }).join("");
  const allCount = docs.length > primaryDocs.length
    ? `<span class="font-ribbon text-ribbon text-on-surface-variant">${docs.length - primaryDocs.length} more in Files / raw data</span>`
    : "";
  return `
    <section id="build-input-docs" class="rds-input-docs bg-surface border border-primary-container/25 rounded-DEFAULT p-3 flex flex-col gap-3">
      <div class="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div class="font-h2 text-h2 text-on-surface flex items-center gap-2">${icon("folder_open", 18, "text-primary-container")}<span>Source files</span></div>
          <div class="font-body text-[14px] leading-5 text-on-surface-variant mt-0.5">The PRD, generated spec, plan, and QA contracts RDS is using for this build.</div>
        </div>
        <button type="button" onclick="showTab('files')" class="px-3 py-1.5 border border-outline-variant bg-surface hover:bg-surface-bright text-on-surface rounded-DEFAULT font-ribbon text-ribbon transition-colors flex items-center gap-1">${icon("folder", 14)}<span>Files tab</span></button>
      </div>
      <div class="rds-input-doc-grid">${cards}</div>
      ${allCount ? `<div>${allCount}</div>` : ""}
    </section>`;
}

function parseEvents(id: string): RdsEvent[] {
  return readEvents(id).lines
    .map((l) => { try { return JSON.parse(l) as RdsEvent; } catch { return null; } })
    .filter((e): e is RdsEvent => e !== null);
}

// Returns whether a fixer is currently in flight for this build, plus the ts
// of the most recent fixer_*_completed (if any). The fixer has two phases —
// diagnose (fixer_started/fixer_completed) and apply (fixer_apply_started/
// fixer_apply_completed) — and the button stays disabled across both.
function fixerStateFromEvents(events: RdsEvent[]): { running: boolean; lastCompletedAt?: string } {
  let lastStart = 0;
  let lastEnd   = 0;
  let lastStartPid: number | undefined;
  let lastEndTs: string | undefined;
  for (const e of events) {
    const t = +new Date(e.ts || 0) || 0;
    if ((e.event === "fixer_started" || e.event === "fixer_apply_started") && t > lastStart) {
      lastStart = t;
      lastStartPid = typeof e.pid === "number" ? e.pid : undefined;
    }
    if ((e.event === "fixer_completed" || e.event === "fixer_apply_completed") && t > lastEnd) {
      lastEnd = t;
      lastEndTs = e.ts;
    }
  }
  let running = lastStart > lastEnd;
  if (running && lastStartPid && !pidIsAlive(lastStartPid) && Date.now() - lastStart > 10 * 60 * 1000) {
    running = false;
  }
  return { running, lastCompletedAt: lastEndTs };
}

function iterationStateFromEvents(events: RdsEvent[]): IterationState {
  let lastStart = 0;
  let lastEnd = 0;
  const state: IterationState = { running: false };
  for (const e of events) {
    const t = +new Date(e.ts || 0) || 0;
    if (e.event === "iterate_started" && t >= lastStart) {
      lastStart = t;
      state.startedAt = e.ts;
      state.updatedAt = e.ts;
      state.phase = "apply";
      state.summary = typeof e.payload?.request === "string" ? e.payload.request : undefined;
    } else if (e.event === "iterate_apply_completed" && t >= lastStart) {
      state.updatedAt = e.ts;
      state.phase = "checks";
      state.exitCode = typeof e.payload?.exit_code === "number" ? e.payload.exit_code : Number(e.payload?.exit_code ?? 0);
    } else if (e.event === "iterate_checks_completed" && t >= lastStart) {
      state.updatedAt = e.ts;
      state.phase = "qa";
      state.exitCode = typeof e.payload?.exit_code === "number" ? e.payload.exit_code : Number(e.payload?.exit_code ?? 0);
    } else if (e.event === "iterate_qa_completed" && t >= lastStart) {
      state.updatedAt = e.ts;
      state.phase = "deploy";
      state.exitCode = typeof e.payload?.exit_code === "number" ? e.payload.exit_code : Number(e.payload?.exit_code ?? 0);
    } else if (e.event === "iterate_deploy_completed" && t >= lastStart) {
      state.updatedAt = e.ts;
      state.phase = "finalizing";
      state.exitCode = typeof e.payload?.exit_code === "number" ? e.payload.exit_code : Number(e.payload?.exit_code ?? 0);
      if (state.exitCode && state.exitCode !== 0 && t >= lastEnd) {
        lastEnd = t;
        state.phase = "failed";
      }
    } else if (e.event === "iterate_failed" && t >= lastEnd) {
      lastEnd = t;
      state.updatedAt = e.ts;
      state.phase = "failed";
      state.summary = typeof e.payload?.summary === "string" ? e.payload.summary : state.summary;
      state.exitCode = typeof e.payload?.exit_code === "number" ? e.payload.exit_code : Number(e.payload?.exit_code ?? 1);
    } else if (e.event === "iterate_completed" && t >= lastEnd) {
      lastEnd = t;
      state.updatedAt = e.ts;
      state.phase = "complete";
      state.summary = typeof e.payload?.summary === "string" ? e.payload.summary : state.summary;
    } else if (e.event === "iterate_needs_review" && t >= lastEnd) {
      lastEnd = t;
      state.updatedAt = e.ts;
      state.phase = "pending_review";
      state.summary = typeof e.payload?.reason === "string" ? e.payload.reason : state.summary;
    } else if (e.event === "build_pending_review" && t >= lastEnd) {
      lastEnd = t;
      state.updatedAt = e.ts;
      state.phase = "pending_review";
      state.summary = typeof e.payload?.reason === "string" ? e.payload.reason : state.summary;
    } else if (e.event === "build_completed" && t >= lastEnd) {
      lastEnd = t;
      state.updatedAt = e.ts;
      state.phase = "complete";
    } else if (e.event === "build_failed" && t >= lastEnd) {
      lastEnd = t;
      state.updatedAt = e.ts;
      state.phase = "failed";
    }
  }
  state.running = lastStart > lastEnd;
  if (state.running) {
    const updatedMs = parseTimeMs(state.updatedAt || state.startedAt);
    if (updatedMs && Date.now() - updatedMs > 10 * 60 * 1000) {
      state.running = false;
    }
  }
  return state;
}

// Best-effort recovery of app_dest for legacy builds that pre-date the
// state.app_dest field. Scans events.jsonl for a build_started event and
// returns its app_dest payload if present.
function resolveAppDest(buildDir: string): string | undefined {
  const id = buildDir.split("/").pop()!;
  for (const ev of parseEvents(id)) {
    const dest = (ev as unknown as Record<string, unknown>)["app_dest"];
    if (typeof dest === "string" && dest.startsWith("/")) return dest;
  }
  return undefined;
}

function computeTimeline(events: RdsEvent[]): StagePoint[] {
  const byStage = new Map<string, StagePoint>();
  for (const e of events) {
    const stage = String(e.payload?.stage ?? "");
    if (!stage && e.event !== "build_started" && e.event !== "build_completed" && e.event !== "build_failed") continue;
    if (e.event === "stage_started") {
      byStage.set(stage, { stage, startedAt: e.ts, status: "running" });
    } else if (e.event === "stage_completed") {
      const cur = byStage.get(stage) ?? { stage, status: "unknown" };
      cur.endedAt = e.ts;
      cur.status = "done";
      if (cur.startedAt) cur.durationMs = +new Date(cur.endedAt) - +new Date(cur.startedAt);
      byStage.set(stage, cur);
    } else if (e.event === "stage_failed") {
      const cur = byStage.get(stage) ?? { stage, status: "unknown" };
      cur.endedAt = e.ts;
      cur.status = "failed";
      cur.exitCode = Number(e.payload?.exit_code ?? 0) || undefined;
      if (cur.startedAt) cur.durationMs = +new Date(cur.endedAt) - +new Date(cur.startedAt);
      byStage.set(stage, cur);
    }
  }
  return Array.from(byStage.values());
}

function timelineFromState(state: StateJson, events: RdsEvent[]): StagePoint[] {
  const byStage = new Map(computeTimeline(events).map((s) => [s.stage, s]));
  if (state.stages && typeof state.stages === "object") {
    for (const [stage, raw] of Object.entries(state.stages)) {
      const status = raw?.status;
      if (!status) continue;
      const cur = byStage.get(stage) ?? { stage, status: "unknown" as const };
      if (status === "done" || status === "failed" || status === "skipped" || status === "running" || status === "pending-review") {
        cur.status = status;
      }
      const startedAt = (raw as Record<string, unknown>).started_at;
      const endedAt = (raw as Record<string, unknown>).ended_at;
      if (typeof startedAt === "string") cur.startedAt = startedAt;
      if (typeof endedAt === "string") cur.endedAt = endedAt;
      if (cur.startedAt && cur.endedAt) cur.durationMs = +new Date(cur.endedAt) - +new Date(cur.startedAt);
      byStage.set(stage, cur);
    }
  }
  return STAGE_ORDER.map((def) => byStage.get(def.id)).filter(Boolean) as StagePoint[];
}

async function listStageLogs(id: string): Promise<string[]> {
  const dir = join(BUILDS_DIR, id, "logs");
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir).catch(() => []);
  return entries.filter((n) => n.endsWith(".log")).sort();
}

function stageLogName(stageId: string): string {
  return `${stageId}.log`;
}

function stageSummaries(id: string, timeline: StagePoint[]): StageSummary[] {
  const byId = new Map(timeline.map((s) => [s.stage, s]));
  const logsDir = join(BUILDS_DIR, id, "logs");
  return STAGE_ORDER.map((def) => {
    const point = byId.get(def.id);
    const logName = stageLogName(def.id);
    const logPath = join(logsDir, logName);
    const log = tailFile(logPath, 20 * 1024);
    const logLines = log
      .split("\n")
      .map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trim())
      .filter((line) => line && !/^\[rds\]\s*(stage_started|stage_completed)/i.test(line))
      .slice(-12);
    return {
      id: def.id,
      label: def.label,
      status: point?.status ?? "pending",
      duration: point?.durationMs ? formatDuration(point.durationMs) : point?.status === "done" ? "done" : "-",
      startedAt: point?.startedAt,
      endedAt: point?.endedAt,
      logName,
      logExists: existsSync(logPath),
      logLines,
    };
  });
}

type LogEntry = { label: string; path: string; bytes: number; mtimeMs: number; durable: boolean; href?: string };

function logManifest(id: string): LogEntry[] {
  const out: LogEntry[] = [];
  const add = (label: string, path: string, durable: boolean, href?: string) => {
    if (!existsSync(path)) return;
    const s = statSync(path);
    out.push({ label, path, bytes: s.size, mtimeMs: s.mtimeMs, durable, href });
  };
  const buildDir = join(BUILDS_DIR, id);
  add("state.json", join(buildDir, "state.json"), true, `/b/${encodeURIComponent(id)}/state.json`);
  add("events.jsonl", join(buildDir, "events.jsonl"), true, `/b/${encodeURIComponent(id)}/events.json`);
  add("live launch log", SHM_LOG(id), false);
  const logsDir = join(buildDir, "logs");
  if (existsSync(logsDir)) {
    for (const name of readdirSync(logsDir).filter((n) => n.endsWith(".log")).sort()) {
      add(`stage/${name}`, join(logsDir, name), true, `/b/${encodeURIComponent(id)}/log/${encodeURIComponent(name)}`);
    }
  }
  const qaDir = join(buildDir, "playwright");
  if (existsSync(qaDir)) {
    for (const iter of readdirSync(qaDir, { withFileTypes: true }).filter((e) => e.isDirectory() && /^iter-\d+$/.test(e.name)).sort((a, b) => a.name.localeCompare(b.name))) {
      const iterDir = join(qaDir, iter.name);
      for (const name of readdirSync(iterDir).filter((n) => /\.(log|json|png|jpg|jpeg|webp|html|txt)$/i.test(n)).sort()) {
        add(
          `qa/${iter.name}/${name}`,
          join(iterDir, name),
          true,
          `/b/${encodeURIComponent(id)}/playwright/file/${encodeURIComponent(iter.name)}/${encodeURIComponent(name)}`
        );
      }
    }
    for (const name of readdirSync(qaDir).filter((n) => /\.(log|json|png|jpg|jpeg|webp|html|txt)$/i.test(n)).sort()) {
      add(
        `qa/${name}`,
        join(qaDir, name),
        true,
        `/b/${encodeURIComponent(id)}/playwright/file/${encodeURIComponent(name)}`
      );
    }
  }
  if (existsSync(buildDir)) {
    for (const name of readdirSync(buildDir).filter((n) => /\.(log)$/.test(n)).sort()) {
      add(name, join(buildDir, name), true);
    }
  }
  const appDest = appDestForBuild(id);
  if (appDest && !appDest.gone) {
    add("rails-server.log", join(appDest.path, "log", "rails-server.log"), true);
    add("scaffold events", join(appDest.path, ".scaffold", "events.jsonl"), true);
    add("scaffold state", join(appDest.path, ".scaffold", "state.json"), true);
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function scaffoldProgressRoot(id: string): string | null {
  const buildDir = join(BUILDS_DIR, id);
  const state = safeReadJson<StateJson>(join(buildDir, "state.json")) || {};
  const currentStage = state.current_stage || state.stage || "";
  const row = readBuildRow(id);
  if (row.running && currentStage === "scaffold") {
    const live = appDestForBuild(id);
    if (live && !live.gone) return live.path;
  }
  const snapshot = join(buildDir, "scaffold-out");
  if (existsSync(join(snapshot, "tasks.json"))) return snapshot;
  const live = appDestForBuild(id);
  if (live && !live.gone && currentStage === "scaffold") return live.path;
  return null;
}

function liveLogSource(id: string): LogEntry | null {
  const logs = logManifest(id).filter((entry) =>
    entry.bytes > 0 && (
      entry.path === SHM_LOG(id) ||
      /\/iterate-\d{8}-\d{6}\.(apply|checks|deploy|qa)\.log$/.test(entry.path) ||
      /\/fixer-(apply|retry)-\d{8}-\d{6}\.log$/.test(entry.path) ||
      /\/logs\/(scaffold|deploy|qa|taste-review|local-run|launch)\.log$/.test(entry.path)
    )
  );
  return logs[0] ?? null;
}

function readScaffoldProgress(id: string): ScaffoldProgress {
  const root = scaffoldProgressRoot(id);
  if (!root) return { available: false, total: 0, done: 0, running: 0, failed: 0, pending: 0, percent: 0 };
  const tasksPath = join(root, "tasks.json");
  const raw = safeReadJson<unknown>(tasksPath);
  const tasksRaw = Array.isArray(raw)
    ? raw
    : (raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).tasks))
      ? (raw as Record<string, unknown>).tasks as unknown[]
      : [];
  const tasks = tasksRaw
    .map((item) => item && typeof item === "object" ? item as ScaffoldTask : null)
    .filter((item): item is ScaffoldTask => !!item)
    .sort((a, b) => Number(a.position ?? a.priority ?? 0) - Number(b.position ?? b.priority ?? 0));
  if (!tasks.length) return { available: false, total: 0, done: 0, running: 0, failed: 0, pending: 0, percent: 0, tasksPath };

  const statusOf = (task: ScaffoldTask) => String(task.status || "pending").toLowerCase();
  const done = tasks.filter((t) => statusOf(t) === "done").length;
  const explicitRunning = tasks.filter((t) => ["in_progress", "running"].includes(statusOf(t))).length;
  const failed = tasks.filter((t) => ["failed", "errored", "blocked"].includes(statusOf(t))).length;
  const pending = Math.max(0, tasks.length - done - explicitRunning - failed);
  const current = tasks.find((t) => ["in_progress", "running", "blocked", "errored", "failed"].includes(statusOf(t)))
    || tasks.find((t) => statusOf(t) !== "done");
  const running = explicitRunning || (current && statusOf(current) !== "done" ? 1 : 0);
  const next = current
    ? tasks.filter((t) => Number(t.position ?? t.priority ?? 0) > Number(current.position ?? current.priority ?? 0) && statusOf(t) !== "done").slice(0, 3)
    : [];

  const telemetryDir = join(root, ".scaffold", "telemetry");
  let lastCompleted: ScaffoldProgress["lastCompleted"];
  let updatedAtMs = Math.max(fileMtimeMs(tasksPath), newestFileMtimeMs(telemetryDir, ".json"));
  if (existsSync(telemetryDir)) {
    const donePositions = new Set(tasks.filter((t) => statusOf(t) === "done").map((t) => Number(t.position ?? t.priority ?? -1)));
    const telemetry = readdirSync(telemetryDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => {
        const data = safeReadJson<Record<string, unknown>>(join(telemetryDir, name));
        if (!data) return null;
        const position = Number(data.position ?? name.replace(/\.json$/, ""));
        const recordedAt = typeof data.recorded_at === "string" ? data.recorded_at : undefined;
        return {
          position: Number.isFinite(position) ? position : undefined,
          title: typeof data.title === "string" ? data.title : undefined,
          recordedAt,
          elapsedMs: typeof data.elapsed_ms === "number" ? data.elapsed_ms : undefined,
          failedAttempts: typeof data.failed_attempts === "number" ? data.failed_attempts : undefined,
          ts: recordedAt ? +new Date(recordedAt) : fileMtimeMs(join(telemetryDir, name)),
        };
      })
      .filter((item): item is NonNullable<typeof item> => !!item)
      .filter((item) => typeof item.position === "number" && donePositions.has(item.position))
      .sort((a, b) => b.ts - a.ts);
    lastCompleted = telemetry[0] ? {
      position: telemetry[0].position,
      title: telemetry[0].title,
      recordedAt: telemetry[0].recordedAt,
      elapsedMs: telemetry[0].elapsedMs,
      failedAttempts: telemetry[0].failedAttempts,
    } : undefined;
  }

  return {
    available: true,
    complete: tasks.length > 0 && done === tasks.length && failed === 0 && running === 0,
    total: tasks.length,
    done,
    running,
    failed,
    pending,
    percent: tasks.length ? Math.round((done / tasks.length) * 100) : 0,
    tasks,
    current,
    next,
    lastCompleted,
    updatedAtMs,
    tasksPath,
  };
}

function shouldShowScaffoldProgress(state: StateJson, progress: ScaffoldProgress): boolean {
  if (!progress.available || !progress.total) return false;
  const currentStage = state.current_stage || state.stage || "";
  if (currentStage === "scaffold") return true;
  return state.status === "paused" && (state.paused_from_stage || currentStage) === "scaffold";
}

function tailFile(path: string, maxBytes = 64 * 1024): string {
  if (!existsSync(path)) return "";
  const s = statSync(path);
  if (s.size <= maxBytes) return readFileSync(path, "utf8");
  // Read last maxBytes by opening the file and seeking; fallback to readFileSync.slice.
  const text = readFileSync(path, "utf8");
  return "...[truncated]...\n" + text.slice(-maxBytes);
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function listAgentSessionFiles(buildId?: string): string[] {
  const roots = buildId
    ? [join(BUILDS_DIR, buildId, "agent-sessions")]
    : [AGENT_SESSIONS_DIR, BUILDS_DIR];
  const out: string[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        if (entry.name === "agent-sessions" || !buildId) walk(path);
      } else if (entry.isFile() && path.includes("/agent-sessions/") && entry.name.endsWith(".json")) {
        out.push(path);
      }
    }
  };
  roots.forEach(walk);
  return out.sort((a, b) => fileMtimeMs(b) - fileMtimeMs(a));
}

function readAgentSession(path: string): AgentSession | null {
  const session = safeReadJson<AgentSession>(path);
  if (!session?.id) return null;
  const logPath = session.log_path ? join(RDS_ROOT, session.log_path) : path.replace(/\.json$/, ".log");
  const tmuxExists = !!session.tmux_session && spawnSync("tmux", ["has-session", "-t", session.tmux_session], { stdio: "ignore" }).status === 0;
  if (tmuxExists && session.status !== "running") session.status = "running";
  if (!tmuxExists && (session.status === "running" || session.status === "starting")) session.status = "exited";
  if (session.worktree_path && existsSync(session.worktree_path)) {
    const status = spawnSync("git", ["-C", session.worktree_path, "status", "--short"], { encoding: "utf8", timeout: 5000 });
    if (status.status === 0) {
      session.changed_files = status.stdout.trim().split("\n").filter(Boolean).map((line) => line.replace(/^.../, ""));
    }
  }
  if (existsSync(logPath)) session.log_path = logPath.replace(RDS_ROOT + "/", "");
  return session;
}

function listAgentSessions(buildId?: string): AgentSession[] {
  return listAgentSessionFiles(buildId).map(readAgentSession).filter((s): s is AgentSession => !!s);
}

function agentHealthRows(): Array<{ name: string; ok: boolean; value: string; note: string }> {
  const check = (bin: string, args: string[] = ["--version"]) => {
    const found = spawnSync("which", [bin], { encoding: "utf8" });
    if (found.status !== 0) return { ok: false, value: "missing" };
    const version = spawnSync(bin, args, { encoding: "utf8", timeout: 4000 });
    return { ok: true, value: (version.stdout || version.stderr || found.stdout || "installed").trim().split("\n")[0] || "installed" };
  };
  const claude = check("claude");
  const codex = check("codex");
  const tmux = check("tmux", ["-V"]);
  const git = spawnSync("git", ["worktree", "list"], { encoding: "utf8", timeout: 4000 });
  return [
    { name: "Claude Code", ok: claude.ok, value: claude.value, note: "interactive and print provider" },
    { name: "Codex", ok: codex.ok, value: codex.value, note: "interactive and review provider" },
    { name: "tmux", ok: tmux.ok, value: tmux.value, note: "persistent terminal sessions" },
    { name: "git worktree", ok: git.status === 0, value: git.status === 0 ? "available" : "unavailable", note: "one isolated checkout per task" },
  ];
}

function agentStatusTone(status?: string): string {
  if (status === "running") return "text-primary-container border-primary-container/40 bg-primary-container/10";
  if (status === "failed") return "text-error border-error/35 bg-error/10";
  if (status === "discarded") return "text-outline border-outline-variant bg-surface";
  if (status === "merged") return "text-secondary border-secondary/30 bg-secondary-container/20";
  return "text-tertiary-container border-tertiary-container/35 bg-tertiary-container/10";
}

function renderAgentSessionsPanel(buildId: string, state: StateJson): string {
  const sessions = listAgentSessions(buildId);
  const appDest = state.app_dest || resolveAppDest(join(BUILDS_DIR, buildId)) || "";
  const cards = sessions.map((s) => {
    const changed = (s.changed_files || []).slice(0, 6);
    const logTail = s.log_path ? tailFile(join(RDS_ROOT, s.log_path), 8 * 1024).split("\n").slice(-12).join("\n") : "";
    const providerLabel = s.provider === "claude-code" ? "Claude Code" : s.provider === "codex" ? "Codex" : s.provider || "agent";
    return `<article class="bg-surface border border-outline-variant rounded-DEFAULT p-3 flex flex-col gap-2">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <div class="flex items-center gap-2 flex-wrap">
            <span class="font-h2 text-h2 text-on-surface">${escapeHtml(providerLabel)}</span>
            <span class="px-2 py-0.5 rounded-DEFAULT border font-ribbon text-ribbon ${agentStatusTone(s.status)}">${escapeHtml(s.status || "unknown")}</span>
            <span class="font-code text-[11px] text-outline">${escapeHtml(s.mode || "interactive")}</span>
          </div>
          <p class="font-body text-body text-on-surface-variant mt-1 break-words">${escapeHtml(s.task || "")}</p>
        </div>
        <code class="font-code text-[10px] text-outline shrink-0">${escapeHtml(s.id)}</code>
      </div>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-2 font-code text-[11px] text-on-surface-variant">
        <div class="truncate" title="${escapeHtml(s.branch || "")}">branch: <span class="text-on-surface">${escapeHtml(s.branch || "—")}</span></div>
        <div class="truncate" title="${escapeHtml(s.worktree_path || "")}">worktree: <span class="text-on-surface">${escapeHtml(s.worktree_path || "—")}</span></div>
        <div class="truncate" title="${escapeHtml(s.tmux_session || "")}">attach: <span class="text-primary-container">tmux attach -t ${escapeHtml(s.tmux_session || "—")}</span></div>
        <div class="truncate" title="${escapeHtml(s.log_path || "")}">log: <span class="text-on-surface">${escapeHtml(s.log_path || "—")}</span></div>
      </div>
      ${changed.length ? `<div class="flex flex-wrap gap-1">${changed.map((f) => `<span class="font-code text-[10px] border border-outline-variant rounded px-1.5 py-0.5 text-on-surface-variant">${escapeHtml(f)}</span>`).join("")}</div>` : `<div class="font-table text-table text-on-surface-variant italic">No working-tree changes reported yet.</div>`}
      ${logTail ? `<pre class="bg-[#070908] border border-outline-variant rounded p-2 font-code text-[11px] text-on-surface-variant max-h-40 overflow-auto custom-scrollbar whitespace-pre-wrap">${escapeHtml(logTail)}</pre>` : ""}
      <div class="flex flex-wrap gap-2 font-ribbon text-ribbon">
        <button type="button" onclick="agentSessionAction('${escapeHtml(s.id)}','status')" class="px-2 py-1 border border-outline-variant rounded text-on-surface hover:border-primary-container">Refresh</button>
        <button type="button" onclick="agentSessionAction('${escapeHtml(s.id)}','diff')" class="px-2 py-1 border border-outline-variant rounded text-on-surface hover:border-primary-container">View diff</button>
        <button type="button" onclick="agentSessionAction('${escapeHtml(s.id)}','stop')" class="px-2 py-1 border border-outline-variant rounded text-on-surface hover:border-primary-container">Stop</button>
        <button type="button" onclick="agentSessionReview('${escapeHtml(s.id)}','${s.provider === "codex" ? "claude-code" : "codex"}')" class="px-2 py-1 border border-outline-variant rounded text-on-surface hover:border-primary-container">Review with ${s.provider === "codex" ? "Claude" : "Codex"}</button>
        <button type="button" onclick="agentSessionHandoff('${escapeHtml(s.id)}','${s.provider === "codex" ? "claude-code" : "codex"}')" class="px-2 py-1 border border-outline-variant rounded text-on-surface hover:border-primary-container">Handoff</button>
        <button type="button" onclick="agentSessionAction('${escapeHtml(s.id)}','merge')" class="px-2 py-1 border border-secondary/40 rounded text-secondary hover:bg-secondary-container/10">Merge local</button>
        <button type="button" onclick="agentSessionAction('${escapeHtml(s.id)}','discard')" class="px-2 py-1 border border-error/40 rounded text-error hover:bg-error/10">Discard</button>
      </div>
    </article>`;
  }).join("");
  if (!sessions.length) {
    return `<section class="rds-agent-sessions-empty bg-surface-container border border-outline-variant rounded-DEFAULT p-3 flex items-center justify-between gap-3 flex-wrap">
      <div class="min-w-0">
        <h2 class="font-h2 text-h2 text-on-surface flex items-center gap-2">${icon("smart_toy", 17, "text-primary-container")}<span>Agent Sessions</span></h2>
        <p class="rds-agent-empty-copy font-table text-table text-on-surface-variant mt-1">No workers yet. Start Claude/Codex from chat when you need a tmux-backed worker in an isolated git worktree; nothing merges or pushes automatically.</p>
        <div class="rds-agent-empty-path font-code text-[10px] text-outline truncate mt-1" title="${escapeHtml(appDest || "")}">${escapeHtml(appDest || "No app_dest recorded.")}</div>
      </div>
      <button type="button" onclick="showTab('chat')" class="px-3 py-1.5 bg-primary-container text-on-primary-container rounded-DEFAULT font-ribbon text-ribbon font-bold shrink-0">Open chat</button>
    </section>`;
  }
  return `<section class="bg-surface-container border border-outline-variant rounded-DEFAULT p-container-padding flex flex-col gap-component-gap">
    <div class="flex items-start justify-between gap-3 flex-wrap">
      <div>
        <h2 class="font-h2 text-h2 text-on-surface flex items-center gap-2">${icon("smart_toy", 18, "text-primary-container")}<span>Agent Sessions</span></h2>
        <p class="font-table text-table text-on-surface-variant mt-1">Worker sessions run in isolated git worktrees with tmux/log/diff state. Manage them from build chat so the conversation, screenshots, task notes, diffs, and handoffs stay in one operating surface.</p>
      </div>
      <div class="flex flex-wrap gap-2">
        <button type="button" onclick="showTab('chat')" class="px-3 py-1.5 bg-primary-container text-on-primary-container rounded-DEFAULT font-ribbon text-ribbon font-bold">Open chat console</button>
      </div>
    </div>
    <div class="bg-surface border border-outline-variant rounded-DEFAULT p-2 font-code text-[11px] text-on-surface-variant">
      Default repo: <span class="text-on-surface">${escapeHtml(appDest || "No app_dest recorded; provide repo in task later.")}</span>
    </div>
    <div id="agent-session-result" class="hidden bg-[#070908] border border-outline-variant rounded p-2 font-code text-[11px] text-on-surface-variant whitespace-pre-wrap"></div>
    <div class="grid grid-cols-1 xl:grid-cols-2 gap-3">${cards || `<div class="bg-surface border border-outline-variant rounded-DEFAULT p-4 text-on-surface-variant font-body text-body italic">No agent sessions for this build yet.</div>`}</div>
  </section>`;
}

function compactBuildId(id: string): string {
  const parts = id.split("-");
  const dateIdx = parts.findIndex((p) => /^\d{8}$/.test(p));
  if (dateIdx > 0 && parts[dateIdx + 1]) {
    const slug = parts.slice(0, Math.min(dateIdx, 3)).join("-");
    return `${slug}-${parts[dateIdx]}-${parts[dateIdx + 1]}`;
  }
  return id.length > 38 ? `${id.slice(0, 28)}…${id.slice(-8)}` : id;
}

function formatDuration(ms: number | undefined): string {
  if (!ms || ms < 0) return "-";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), rs = s % 60;
  if (m < 60) return `${m}m ${rs}s`;
  const h = Math.floor(m / 60), rm = m % 60;
  return `${h}h ${rm}m`;
}

function parseTimeMs(value: unknown): number {
  if (typeof value !== "string" || !value.trim()) return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

function latestLifecycleEvent(events: RdsEvent[], names: Set<string>): RdsEvent | undefined {
  let latest: RdsEvent | undefined;
  let latestMs = 0;
  for (const event of events) {
    if (!names.has(event.event)) continue;
    const ms = parseTimeMs(event.ts);
    if (ms >= latestMs) {
      latest = event;
      latestMs = ms;
    }
  }
  return latest;
}

function computeBuildTiming(state: StateJson, row: BuildRow, events: RdsEvent[]): BuildTiming {
  const startEvent = latestLifecycleEvent(events, new Set(["build_started"]));
  const startSource: BuildTiming["source"] = state.started_at ? "state" : startEvent?.ts ? "events" : row.startedAt ? "pidfile" : "unknown";
  const startedAt = state.started_at || startEvent?.ts || row.startedAt;
  const terminalEvent = latestLifecycleEvent(events, new Set(["build_completed", "build_failed", "build_pending_review"]));
  const endedAt = row.running ? undefined : terminalEvent?.ts;
  const startedMs = parseTimeMs(startedAt);
  const endedMs = parseTimeMs(endedAt);
  const durationMs = startedMs ? Math.max(0, (endedMs || (row.running ? Date.now() : 0)) - startedMs) : undefined;
  const label = durationMs != null ? formatDuration(durationMs) : "not started";
  const statusText = row.running ? "Running" : terminalEvent?.event === "build_failed" ? "Failed" : terminalEvent?.event === "build_pending_review" ? "Awaiting review" : terminalEvent?.event === "build_completed" ? "Completed" : "Last known";
  const hintParts = [
    `${statusText} elapsed time from pipeline start${endedAt ? ` to ${terminalEvent?.event.replace(/^build_/, "")}` : ""}.`,
    startedAt ? `Started ${startedAt}.` : "No build start timestamp found.",
    endedAt ? `Ended ${endedAt}.` : row.running ? "Updates live while the runner is active." : "No terminal lifecycle event found yet.",
    `Source: ${startSource}.`,
  ];
  return { startedAt, endedAt, durationMs, running: row.running, label, hint: hintParts.join(" "), source: startSource };
}

function computeActiveRunTiming(row: BuildRow, goal: RdsGoalState | null, iteration: IterationState, fixer: { running: boolean; lastCompletedAt?: string }): ActiveRunTiming {
  if (row.running) {
    const startedAt = row.startedAt;
    const startedMs = parseTimeMs(startedAt);
    const durationMs = startedMs ? Math.max(0, Date.now() - startedMs) : undefined;
    return {
      kind: "build",
      label: durationMs != null ? formatDuration(durationMs) : "-",
      startedAt,
      updatedAt: row.lastActivityMs ? new Date(row.lastActivityMs).toISOString() : undefined,
      durationMs,
      running: true,
      hint: `Current attached build runner${row.pid ? ` pid ${row.pid}` : ""}.`,
    };
  }
  if (goalLooksFreshRunning(goal)) {
    const startedAt = goal?.startedAt;
    const updatedAt = goal?.updatedAt;
    const startedMs = parseTimeMs(startedAt);
    const durationMs = startedMs ? Math.max(0, Date.now() - startedMs) : undefined;
    return {
      kind: "goal",
      label: durationMs != null ? formatDuration(durationMs) : "-",
      startedAt,
      updatedAt,
      durationMs,
      running: true,
      hint: `Current goal run. Updated ${updatedAt || "unknown"}.`,
    };
  }
  if (iteration.running) {
    const startedAt = iteration.startedAt;
    const startedMs = parseTimeMs(startedAt);
    const durationMs = startedMs ? Math.max(0, Date.now() - startedMs) : undefined;
    return {
      kind: "iteration",
      label: durationMs != null ? formatDuration(durationMs) : "-",
      startedAt,
      updatedAt: iteration.updatedAt,
      durationMs,
      running: true,
      hint: `Current iteration phase ${iteration.phase || "working"}.`,
    };
  }
  if (fixer.running) {
    return {
      kind: "fixer",
      label: "running",
      updatedAt: fixer.lastCompletedAt,
      running: true,
      hint: "Current fixer process is running.",
    };
  }
  if (goalIsStaleRunning(goal)) {
    const updatedAt = goal?.updatedAt;
    const updatedMs = parseTimeMs(updatedAt);
    const durationMs = updatedMs ? Math.max(0, Date.now() - updatedMs) : undefined;
    return {
      kind: "stale_goal",
      label: durationMs != null ? `${formatDuration(durationMs)} ago` : "stale",
      startedAt: goal?.startedAt,
      updatedAt,
      durationMs,
      running: false,
      stale: true,
      hint: `goal.json is still marked running, but it has not updated since ${updatedAt || "unknown"} and no live runner is attached.`,
    };
  }
  if (goal?.status === "interrupted" && goal.updatedAt) {
    const updatedMs = parseTimeMs(goal.updatedAt);
    const durationMs = updatedMs ? Math.max(0, Date.now() - updatedMs) : undefined;
    return {
      kind: "stale_goal",
      label: durationMs != null ? `${formatDuration(durationMs)} ago` : "interrupted",
      startedAt: goal.startedAt,
      updatedAt: goal.updatedAt,
      durationMs,
      running: false,
      stale: true,
      hint: goal.nextAction || "Last goal attempt stopped before the full RDS loop completed.",
    };
  }
  return {
    kind: "idle",
    label: "none",
    running: false,
    hint: "No current build, goal, iteration, or fixer runner is attached.",
  };
}

function relativeTime(ms: number): string {
  if (!ms) return "never";
  const ago = Date.now() - ms;
  if (ago < 60_000) return `${Math.round(ago / 1000)}s ago`;
  if (ago < 3_600_000) return `${Math.round(ago / 60_000)}m ago`;
  return `${Math.round(ago / 3_600_000)}h ago`;
}

function compareText(a: unknown, b: unknown): number {
  const av = String(a ?? "").toLowerCase();
  const bv = String(b ?? "").toLowerCase();
  if (!av && bv) return 1;
  if (av && !bv) return -1;
  return av.localeCompare(bv);
}

function compareNumber(a: unknown, b: unknown): number {
  const av = typeof a === "number" && Number.isFinite(a) ? a : null;
  const bv = typeof b === "number" && Number.isFinite(b) ? b : null;
  if (av == null && bv == null) return 0;
  if (av == null) return 1;
  if (bv == null) return -1;
  return av - bv;
}

function sortDir(raw: string | undefined, fallback: "asc" | "desc" = "asc"): "asc" | "desc" {
  return raw === "desc" || raw === "asc" ? raw : fallback;
}

function sortableHeader(reqUrl: string, key: string, label: string, currentSort: string, currentDir: "asc" | "desc", cls = ""): string {
  const url = new URL(reqUrl);
  const active = currentSort === key;
  url.searchParams.set("sort", key);
  url.searchParams.set("dir", active && currentDir === "asc" ? "desc" : "asc");
  const href = `${url.pathname}${url.search}`;
  const arrow = active ? (currentDir === "asc" ? "↑" : "↓") : "↕";
  const color = active ? "text-primary-container" : "text-on-surface-variant hover:text-on-surface";
  return `<a href="${escapeHtml(href)}" class="inline-flex items-center gap-1 ${color} ${cls}"><span>${escapeHtml(label)}</span><span class="text-[10px]">${arrow}</span></a>`;
}

function withoutQueryParam(reqUrl: string, key: string): string {
  const url = new URL(reqUrl);
  url.searchParams.delete(key);
  const query = url.searchParams.toString();
  return `${url.pathname}${query ? `?${query}` : ""}`;
}

// Constant-time string compare for secrets; plain === leaks length/prefix
// timing. Hand-rolled XOR walk (always over the expected secret's full
// length) instead of crypto.timingSafeEqual so the public bundle check,
// which builds with browser polyfills, keeps passing.
function secretsEqual(supplied: string, expected: string): boolean {
  const enc = new TextEncoder();
  const a = enc.encode(supplied);
  const b = enc.encode(expected);
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < b.length; i++) diff |= (a[i % (a.length || 1)] ?? 0) ^ b[i];
  return diff === 0;
}

// True when the request arrived on the loopback interface AND was addressed
// to a localhost host header. Both checks matter: a reverse proxy can make
// the remote address loopback (host header exposes it), and DNS rebinding
// can make a hostile page resolve to 127.0.0.1 (remote address alone would
// pass). Used only to enable first-run "setup mode" when no credentials are
// configured yet.
function isLocalDirectRequest(c: { req: { raw: Request; header: (k: string) => string | undefined } }): boolean {
  let ip = "";
  try {
    ip = (getConnInfo(c as never).remote.address || "").replace(/^::ffff:/i, "");
  } catch {
    return false;
  }
  if (ip !== "127.0.0.1" && ip !== "::1") return false;
  const host = (c.req.header("host") || "").toLowerCase().replace(/\]?:\d+$/, "").replace(/^\[/, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

// First-run setup mode: no password AND no token configured. The dashboard
// serves to direct localhost requests only, so a fresh clone works out of
// the box without ever exposing an unprotected control surface remotely.
function setupModeActive(): boolean {
  return !DASHBOARD_PASS && !DASHBOARD_TOKEN;
}

function tokenGate(c: { req: { raw: Request; header: (k: string) => string | undefined }; text: (b: string, s?: number) => Response }): Response | null {
  if (!DASHBOARD_TOKEN) {
    if (setupModeActive() && isLocalDirectRequest(c)) return null;
    return c.text("RDS_DASHBOARD_TOKEN not configured on the dashboard service.", 503);
  }
  const supplied = c.req.header("x-rds-token") || "";
  if (!secretsEqual(supplied, DASHBOARD_TOKEN)) return c.text("forbidden", 403);
  return null;
}

interface BuildAttachment {
  originalName: string;
  path: string;
  mime: string;
  size: number;
  extractedPath?: string;
}

function safeUploadName(name: string): string {
  const cleaned = (name || "attachment")
    .replace(/[\\/]+/g, "-")
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  return cleaned || "attachment";
}

function safeUploadPath(name: string): string {
  const parts = String(name || "attachment")
    .split(/[\\/]+/g)
    .map((part) => safeUploadName(part))
    .filter((part) => part && part !== "." && part !== "..");
  return parts.length ? parts.join("/") : "attachment";
}

function isIgnoredAttachmentName(name: string): boolean {
  const parts = String(name || "").toLowerCase().replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.some((part) => IGNORED_ATTACHMENT_NAMES.has(part));
}

function browserRelativeName(file: File): string {
  const rel = (file as unknown as { webkitRelativePath?: string }).webkitRelativePath;
  return rel && rel.trim() ? rel : (file.name || "attachment");
}

function extFromName(name: string): string {
  const m = name.toLowerCase().match(/\.[a-z0-9]+$/);
  return m ? m[0] : "";
}

function isUploadFile(value: unknown): value is File {
  return typeof File !== "undefined" && value instanceof File && value.size > 0;
}

function isTextAttachment(name: string, mime?: string): boolean {
  return /\.(md|markdown|txt)$/i.test(name) || /^text\//i.test(mime || "");
}

function isPdfAttachment(name: string, mime?: string): boolean {
  return /\.pdf$/i.test(name) || /application\/pdf/i.test(mime || "");
}

function isZipAttachment(name: string, mime?: string): boolean {
  return /\.zip$/i.test(name) || /application\/(zip|x-zip-compressed)/i.test(mime || "");
}

function isBundleTextPath(name: string): boolean {
  return /\.(md|markdown|txt|html|htm|css|js|jsx|ts|tsx|json|svg|csv|xml|yml|yaml)$/i.test(name);
}

function truncateAnalysisText(text: string, max = 60_000): string {
  const clean = text.replace(/\0/g, "").trim();
  return clean.length > max ? `${clean.slice(0, max)}\n\n[truncated for stack analysis]` : clean;
}

async function extractUploadTextForAnalysis(files: File[]): Promise<string> {
  const blocks: string[] = [];
  for (const file of files) {
    const submittedName = browserRelativeName(file);
    if (isIgnoredAttachmentName(submittedName)) continue;
    const originalName = safeUploadPath(submittedName);
    if (isTextAttachment(originalName, file.type)) {
      const text = await file.text().catch(() => "");
      if (text.trim()) {
        blocks.push(`## Extracted text attachment: ${originalName}\n\n${truncateAnalysisText(text)}`);
      }
      continue;
    }
    if (isZipAttachment(originalName, file.type)) {
      const tmp = join("/tmp", `rds-analyze-${randomUUID()}-${safeUploadName(originalName)}`);
      const extractDir = join("/tmp", `rds-analyze-${randomUUID()}-zip`);
      try {
        writeFileSync(tmp, Buffer.from(await file.arrayBuffer()));
        mkdirSync(extractDir, { recursive: true });
        const unzipped = spawnSync("python3", ["-c", [
          "import pathlib, sys, zipfile",
          "src=pathlib.Path(sys.argv[1]); out=pathlib.Path(sys.argv[2])",
          "with zipfile.ZipFile(src) as z:",
          "    out_real=out.resolve()",
          "    for member in z.infolist():",
          "        name=member.filename",
          "        target=(out / name).resolve()",
          "        if pathlib.PurePosixPath(name).is_absolute() or '..' in pathlib.PurePosixPath(name).parts:",
          "            raise SystemExit(f'unsafe zip member: {name}')",
          "        if out_real not in target.parents and target != out_real:",
          "            raise SystemExit(f'unsafe zip member: {name}')",
          "    z.extractall(out)",
        ].join("\n"), tmp, extractDir], { encoding: "utf8", timeout: 15_000, maxBuffer: 2 * 1024 * 1024 });
        if (unzipped.status !== 0) {
          blocks.push(`## ZIP attachment: ${originalName}\n\nRDS could not extract this bundle for stack analysis. Preserve it as a first-party source during spec generation.`);
          continue;
        }
        const listed = spawnSync("find", [extractDir, "-type", "f"], { encoding: "utf8", timeout: 10_000, maxBuffer: 4 * 1024 * 1024 });
        const filesInZip = (listed.stdout || "").split("\n").filter(Boolean).slice(0, MAX_ANALYSIS_BUNDLE_FILES);
        const zipBlocks: string[] = [];
        for (const path of filesInZip) {
          const rel = path.replace(extractDir + "/", "");
          if (isIgnoredAttachmentName(rel) || !isBundleTextPath(rel)) continue;
          const text = readFileSync(path, "utf8");
          if (text.trim()) zipBlocks.push(`### ${rel}\n\n${truncateAnalysisText(text, 12_000)}`);
        }
        blocks.push(zipBlocks.length
          ? `## Extracted ZIP attachment: ${originalName}\n\n${zipBlocks.join("\n\n")}`
          : `## ZIP attachment: ${originalName}\n\nBundle extracted, but no text-like files were available for stack analysis.`);
      } catch {
        blocks.push(`## ZIP attachment: ${originalName}\n\nRDS could not extract this bundle for stack analysis. Preserve it as a first-party source during spec generation.`);
      } finally {
        try { unlinkSync(tmp); } catch {}
        try { rmSync(extractDir, { recursive: true, force: true }); } catch {}
      }
      continue;
    }
    if (!isPdfAttachment(originalName, file.type)) continue;
    const tmp = join("/tmp", `rds-analyze-${randomUUID()}-${originalName}`);
    try {
      writeFileSync(tmp, Buffer.from(await file.arrayBuffer()));
      const converted = spawnSync("mutool", ["draw", "-F", "txt", "-o", "-", tmp], {
        encoding: "utf8",
        timeout: 12_000,
        maxBuffer: 2 * 1024 * 1024,
      });
      const text = (converted.stdout || "").trim();
      if (converted.status === 0 && text) {
        blocks.push(`## Extracted PDF attachment: ${originalName}\n\n${truncateAnalysisText(text)}`);
      } else {
        blocks.push(`## PDF attachment: ${originalName}\n\nRDS could not extract text for stack analysis. Preserve this PDF as a first-party source during spec generation.`);
      }
    } catch {
      blocks.push(`## PDF attachment: ${originalName}\n\nRDS could not extract text for stack analysis. Preserve this PDF as a first-party source during spec generation.`);
    } finally {
      try { unlinkSync(tmp); } catch {}
    }
  }
  return blocks.join("\n\n");
}

async function saveBuildAttachments(files: File[], slugHint: string): Promise<BuildAttachment[]> {
  if (!files.length) return [];
  if (files.length > MAX_ATTACHMENTS) throw new Error(`maximum ${MAX_ATTACHMENTS} attachments`);
  let total = 0;
  const batch = `${Date.now()}-${safeUploadName(slugHint || "build-input").replace(/\.[a-z0-9]+$/i, "")}`;
  const dir = join(ATTACHMENTS_DIR, batch);
  mkdirSync(dir, { recursive: true });
  const saved: BuildAttachment[] = [];

  for (const file of files) {
    const submittedName = browserRelativeName(file);
    if (isIgnoredAttachmentName(submittedName)) continue;
    const originalName = safeUploadPath(submittedName);
    const ext = extFromName(originalName);
    if (!ALLOWED_ATTACHMENT_EXTS.has(ext)) {
      throw new Error(`unsupported attachment type: ${originalName}`);
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      throw new Error(`${originalName} exceeds ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MiB`);
    }
    total += file.size;
    if (total > MAX_ATTACHMENT_TOTAL_BYTES) {
      throw new Error(`attachments exceed ${Math.round(MAX_ATTACHMENT_TOTAL_BYTES / 1024 / 1024)} MiB total`);
    }
    const target = join(dir, `${String(saved.length + 1).padStart(2, "0")}-${originalName}`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, Buffer.from(await file.arrayBuffer()));
    saved.push({ originalName, path: target, mime: file.type || "application/octet-stream", size: file.size });
  }
  return saved;
}

function attachmentMarkdown(attachments: BuildAttachment[]): string {
  if (!attachments.length) return "";
  const rows = attachments.map((a) =>
    `- ${a.originalName} (${a.mime}, ${Math.max(1, Math.round(a.size / 1024))} KiB): \`${a.path}\``
  ).join("\n");
  return `## Attached Source Files

The following files are first-party product inputs. Inspect them directly before producing the implementation spec. For images, extract layout, copy, visual requirements, states, and interactions. For PDFs, read the document and preserve its requirements.

${rows}`;
}

function readLocalTextInput(ref: string): string | null {
  const trimmed = (ref || "").trim();
  if (!trimmed || !/\.(md|markdown|txt)$/i.test(trimmed)) return null;
  const path = trimmed.startsWith("/") ? trimmed : join(RDS_ROOT, trimmed);
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8");
}

// Append-only audit trail for every write endpoint hit. Keeps the file small
// by recording the verb + build id + caller IP, not request bodies (which can
// contain PRD text or chat content). Best-effort — failure to write must not
// break the request.
function appendAudit(entry: { route: string; build_id?: string; verb?: string; outcome: "ok" | "denied" | "error"; status?: number; ip?: string; ua?: string; note?: string }): void {
  try {
    mkdirSync(join(RDS_ROOT, "dashboard"), { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
    appendFileSync(AUDIT_LOG, line);
  } catch { /* best-effort */ }
}

function callerIp(c: { req: { header: (k: string) => string | undefined } }): string {
  return c.req.header("x-forwarded-for")?.split(",")[0]?.trim()
      || c.req.header("x-real-ip")
      || "-";
}

function callerUa(c: { req: { header: (k: string) => string | undefined } }): string {
  return c.req.header("user-agent") || "-";
}

// ---------- chat sessions (server-persistent) -------------------------------
//
// Chat lives on the server, not in localStorage. Sessions are JSON files in
// dashboard/chat/. Submitting a message spawns rds-chat in the background and
// finalizes the pending turn when the subprocess exits. Clients poll the
// session JSON for updates, so navigating away does not orphan the response.
//
// Session shape:
//   { id, title, build_id?, created_at, updated_at, last_read_at, turns: ChatTurn[] }
// Turn shape:
//   { id, role: "you"|"rds", text, ts, status?: "pending"|"complete"|"error" }

interface ChatTurn {
  id: string;
  role: "you" | "rds";
  text: string;
  ts: number;
  // Monotonic creation-order key. Assigned once at creation and never mutated,
  // so completion-time ts rewrites and late-appended action summaries can't
  // reorder the thread. Legacy turns are backfilled from array index on read.
  seq?: number;
  status?: "pending" | "complete" | "error";
  action?: ChatAction;
  attachments?: BuildAttachment[];
}

interface ChatSession {
  id: string;
  title: string;
  build_id?: string;
  created_at: number;
  updated_at: number;
  last_read_at: number;
  turns: ChatTurn[];
}

type ChatActionKind = "goal" | "iterate" | "qa" | "redeploy" | "approve" | "delete-service" | "agent-start";

interface ChatAction {
  kind: ChatActionKind;
  build_id: string;
  prompt?: string;
  provider?: string;
  mode?: string;
  action_run?: string;
  action_status?: ActionRunState | null;
  label: string;
  confirm_label: string;
  description: string;
}

interface ActionRunState {
  ok?: boolean | null;
  status?: string;
  phase?: string;
  pid?: number | null;
  exit_code?: number;
  failed_phase?: string;
  error?: string;
  summary_file?: string;
  repair_plan?: string;
  repair_jobs?: string;
  repair_convergence?: string;
  agent_session_id?: string;
  preview_url?: string;
  final_chat_turn_id?: string;
  updated_at?: string;
}

const CHAT_DIR = process.env.RDS_DASHBOARD_CHAT_DIR || join(RDS_ROOT, "dashboard", "chat");

function ensureChatDir(): void {
  if (!existsSync(CHAT_DIR)) mkdirSync(CHAT_DIR, { recursive: true });
}

function chatSessionPath(id: string): string {
  return join(CHAT_DIR, `${id}.json`);
}

function isChatId(id: string): boolean {
  return /^[a-z0-9_-]{4,180}$/i.test(id);
}

function readChatSession(id: string): ChatSession | null {
  if (!isChatId(id)) return null;
  const p = chatSessionPath(id);
  if (!existsSync(p)) return null;
  try { return hydrateChatActions(JSON.parse(readFileSync(p, "utf8")) as ChatSession); }
  catch { return null; }
}

function writeChatSession(s: ChatSession): void {
  ensureChatDir();
  writeFileSync(chatSessionPath(s.id), JSON.stringify(s, null, 2));
}

async function saveChatAttachments(session: ChatSession, files: File[]): Promise<BuildAttachment[]> {
  const realFiles = files.filter(isUploadFile);
  if (!realFiles.length) return [];
  const root = session.build_id && existsSync(join(BUILDS_DIR, session.build_id))
    ? join(BUILDS_DIR, session.build_id, "chat-attachments")
    : join(CHAT_DIR, "attachments");
  if (realFiles.length > MAX_ATTACHMENTS) throw new Error(`maximum ${MAX_ATTACHMENTS} attachments`);
  let total = 0;
  const batch = `${Date.now()}-${safeUploadName(session.id)}`;
  const dir = join(root, batch);
  mkdirSync(dir, { recursive: true });
  const saved: BuildAttachment[] = [];
  for (const file of realFiles) {
    const submittedName = browserRelativeName(file);
    if (isIgnoredAttachmentName(submittedName)) continue;
    const originalName = safeUploadPath(submittedName);
    const ext = extFromName(originalName);
    if (!ALLOWED_ATTACHMENT_EXTS.has(ext)) throw new Error(`unsupported attachment type: ${originalName}`);
    if (file.size > MAX_ATTACHMENT_BYTES) throw new Error(`${originalName} exceeds ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MiB`);
    total += file.size;
    if (total > MAX_ATTACHMENT_TOTAL_BYTES) throw new Error(`attachments exceed ${Math.round(MAX_ATTACHMENT_TOTAL_BYTES / 1024 / 1024)} MiB total`);
    const target = join(dir, `${String(saved.length + 1).padStart(2, "0")}-${originalName}`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, Buffer.from(await file.arrayBuffer()));
    saved.push({ originalName, path: target, mime: file.type || "application/octet-stream", size: file.size });
  }
  return saved;
}

function chatAttachmentContext(attachments: BuildAttachment[]): string {
  if (!attachments.length) return "";
  const rows = attachments.map((a) =>
    `- ${a.originalName} (${a.mime}, ${Math.max(1, Math.round(a.size / 1024))} KiB): \`${a.path}\``
  ).join("\n");
  return `\n\nAttached files from this chat turn. Treat these as first-party operator context. For screenshots/images, inspect the referenced file and use it as visual evidence when answering, proposing an iteration, or running rds-iterate.\n\n${rows}`;
}

// Next monotonic seq for a session. Assumes existing turns carry seq (true
// after normalizeChatSeq / read), but tolerates gaps by taking max + 1.
function nextChatSeq(session: ChatSession): number {
  let max = -1;
  for (const t of session.turns) {
    if (typeof t.seq === "number" && Number.isFinite(t.seq) && t.seq > max) max = t.seq;
  }
  return max + 1;
}

// Backfill seq for legacy turns from their stored array position (creation
// order). Keeps any existing seq values. Returns true if anything changed so
// the caller can persist.
function normalizeChatSeq(session: ChatSession): boolean {
  let changed = false;
  let next = 0;
  for (const t of session.turns) {
    if (typeof t.seq === "number" && Number.isFinite(t.seq)) {
      if (t.seq >= next) next = t.seq + 1;
    } else {
      t.seq = next;
      next += 1;
      changed = true;
    }
  }
  return changed;
}

function hydrateChatActions(s: ChatSession): ChatSession {
  let dirty = normalizeChatSeq(s);
  for (const t of s.turns) {
    const action = t.action;
    if (!action) continue;
    if (!action.action_run) {
      const actionsDir = join(BUILDS_DIR, action.build_id, "actions");
      if (existsSync(actionsDir)) {
        const found = readdirSync(actionsDir)
          .filter((f) => f.endsWith(".json"))
          .map((f) => ({ f, p: join(actionsDir, f), mtime: statSync(join(actionsDir, f)).mtimeMs }))
          .sort((a, b) => b.mtime - a.mtime)
          .find((entry) => {
            const run = safeReadJson<Record<string, unknown>>(entry.p);
            return run?.chat_session_id === s.id && run?.chat_turn_id === t.id;
          });
        if (found) action.action_run = `builds/${action.build_id}/actions/${found.f}`;
      }
    }
    if (action.action_run && action.action_run.startsWith(`builds/${action.build_id}/actions/`) && action.action_run.endsWith(".json")) {
      const runPath = join(BUILDS_DIR, action.build_id, "actions", basename(action.action_run));
      action.action_status = safeReadJson<ActionRunState>(runPath);
      const run = action.action_status;
      if (run && (run.status === "passed" || run.status === "failed" || run.status === "needs_review") && !run.final_chat_turn_id) {
        const finalTurn: ChatTurn = {
          id: randomUUID().slice(0, 12),
          role: "rds",
          text: finalChatActionSummary(action, run),
          ts: Date.now(),
          seq: nextChatSeq(s),
          status: run.status === "failed" ? "error" : "complete",
        };
        s.turns.push(finalTurn);
        s.updated_at = finalTurn.ts;
        writeActionRun(runPath, { final_chat_turn_id: finalTurn.id });
        run.final_chat_turn_id = finalTurn.id;
        dirty = true;
      }
    }
  }
  if (dirty) writeChatSession(s);
  return s;
}

function listChatSessions(): ChatSession[] {
  if (!existsSync(CHAT_DIR)) return [];
  const files = readdirSync(CHAT_DIR).filter((f) => f.endsWith(".json"));
  const sessions: ChatSession[] = [];
  for (const f of files) {
    try {
      const s = hydrateChatActions(JSON.parse(readFileSync(join(CHAT_DIR, f), "utf8")) as ChatSession);
      if (s && s.id) sessions.push(s);
    } catch { /* skip corrupt file */ }
  }
  sessions.sort((a, b) => b.updated_at - a.updated_at);
  return sessions;
}

function hasRunningChatAction(s: ChatSession): boolean {
  return s.turns.some((t) => {
    const status = t.action?.action_status?.status;
    return status === "queued" || status === "running";
  });
}

function unreadCount(s: ChatSession): number {
  let n = 0;
  for (const t of s.turns) {
    if (t.role === "rds" && t.status === "complete" && t.ts > (s.last_read_at || 0)) n++;
  }
  return n;
}

function totalUnread(): number {
  return listChatSessions().reduce((acc, s) => acc + unreadCount(s), 0);
}

function defaultTitleForBuild(buildId: string): string {
  // Prefer the human display name; a thread titled "Build lumen-finance-
  // 20260710-093012" truncates uselessly in the sidebar.
  const state = safeReadJson<StateJson>(join(BUILDS_DIR, buildId, "state.json"));
  const name = (state as { display_name?: string } | null)?.display_name;
  return name ? String(name) : `Build ${buildId}`;
}

function findOrCreateBuildSession(buildId: string): ChatSession {
  const all = listChatSessions();
  const existing = all.find((s) => s.build_id === buildId);
  if (existing) return existing;
  const now = Date.now();
  const s: ChatSession = {
    id: `b-${buildId}-${randomUUID().slice(0, 6)}`.replace(/[^a-z0-9_-]/gi, "-"),
    title: defaultTitleForBuild(buildId),
    build_id: buildId,
    created_at: now,
    updated_at: now,
    last_read_at: now,
    turns: [],
  };
  writeChatSession(s);
  return s;
}

function createChatSession(opts: { title?: string; build_id?: string }): ChatSession {
  const now = Date.now();
  const s: ChatSession = {
    id: `c-${randomUUID().slice(0, 8)}`,
    title: (opts.title?.trim() || (opts.build_id ? defaultTitleForBuild(opts.build_id) : "New chat")).slice(0, 120),
    build_id: opts.build_id,
    created_at: now,
    updated_at: now,
    last_read_at: now,
    turns: [],
  };
  writeChatSession(s);
  return s;
}

function classifyBuildChatAction(session: ChatSession, message: string): ChatAction | null {
  const buildId = session.build_id;
  if (!buildId) return null;
  const raw = message.trim();
  const m = raw.toLowerCase().replace(/\s+/g, " ");
  if (!m) return null;

  const asksOnly = /^(what|why|how|where|when|is|are|can|could|should|explain|show|status)\b/.test(m)
    && !/\b(please|pls|go ahead|run|rerun|re-run|redeploy|deploy|change|make|add|remove|fix|update|tweak|adjust|replace|polish|iterate|approve|delete|deactivate|deregister)\b/.test(m);
  if (asksOnly) return null;

  if (/\b(keep going|continue building|continue improving|make (?:it|this|the build) review[- ]ready|make (?:it|this|the build) ready|unblock(?: it| this| the build)?|get (?:it|this|the build) (?:to|through) review|run goal|start goal|continue goal)\b/.test(m)
      || (/\b(continue|run|start|keep)\b/.test(m) && /\b(goal|review[- ]ready|unblocked|until (?:it )?(?:passes|is good|is ready))\b/.test(m))) {
    return {
      kind: "goal",
      build_id: buildId,
      prompt: raw,
      label: "Run RDS Goal",
      confirm_label: "Start goal",
      description: "Runs the build-level supervisor: re-read PRD/spec/evidence, choose fix or iteration actions, rerun QA/readiness, and continue until review-ready or a precise handoff remains."
    };
  }

  if (/\b(approve|approve this|mark approved|ship it|looks good|lgtm)\b/.test(m)) {
    return {
      kind: "approve",
      build_id: buildId,
      label: "Approve build",
      confirm_label: "Approve",
      description: "Marks this build as operator-approved after you have reviewed the running app and QA artefacts."
    };
  }

  if (/\b(delete|remove|deactivate|deregister)\b.*\b(zo service|service|hosting|preview url|hosted)\b/.test(m)
      || /\b(stop hosting|take it offline|remove from zo|delete from zo)\b/.test(m)) {
    return {
      kind: "delete-service",
      build_id: buildId,
      label: "Delete Zo service",
      confirm_label: "Delete Zo service",
      description: "Deletes only the recorded hosted Zo service for this build, then clears the preview URL after deletion is verified. Project files remain."
    };
  }

  if (/\b(run|rerun|re-run|start|kick off|do)\b.*\b(qa|playwright|browser qa|uat|verification|verify)\b/.test(m)
      || /\b(qa|playwright|browser qa|uat)\b.*\b(run|rerun|re-run|again)\b/.test(m)) {
    return {
      kind: "qa",
      build_id: buildId,
      label: "Run Playwright QA",
      confirm_label: "Run QA",
      description: "Starts a new Playwright QA pass for this deployed build."
    };
  }

  if (/\b(redeploy|re-deploy|deploy again|push to zo|update zo|publish again)\b/.test(m)) {
    return {
      kind: "redeploy",
      build_id: buildId,
      label: "Redeploy to Zo",
      confirm_label: "Redeploy",
      description: "Re-runs deploy from the generated app directory and updates the preview if it succeeds."
    };
  }

  const agentMatch = m.match(/\b(start|launch|run|spin up|create)\b.*\b(claude|claude code|codex)\b.*\b(worker|agent|session)\b/)
    || m.match(/\b(claude|claude code|codex)\b.*\b(worker|agent|session)\b/);
  if (agentMatch) {
    const provider = /\bcodex\b/.test(m) ? "codex" : "claude-code";
    return {
      kind: "agent-start",
      build_id: buildId,
      provider,
      mode: "interactive",
      prompt: raw,
      label: `Start ${provider === "codex" ? "Codex" : "Claude Code"} worker in chat`,
      confirm_label: "Start worker",
      description: "Creates an isolated git worktree, starts a persistent tmux-backed coding agent session, and records logs/diff/session metadata under this build."
    };
  }

  if (/\b(iterate|change|make|add|remove|delete|fix|update|tweak|adjust|replace|redesign|polish|improve|speed up|slow down|rename|restyle|modify)\b/.test(m)) {
    return {
      kind: "iterate",
      build_id: buildId,
      prompt: raw,
      label: "Run controlled iteration",
      confirm_label: "Patch and verify",
      description: "Patches the generated app, redeploys, runs QA, then keeps making targeted follow-up passes when QA still finds fixable gaps."
    };
  }

  return null;
}

function appendChatActionProposal(session: ChatSession, message: string, action: ChatAction, attachments: BuildAttachment[] = []): { userTurn: ChatTurn; rdsTurn: ChatTurn } {
  const now = Date.now();
  normalizeChatSeq(session);
  const seq = nextChatSeq(session);
  const userTurn: ChatTurn = { id: randomUUID().slice(0, 12), role: "you", text: message, ts: now, seq, status: "complete", attachments };
  const text = action.kind === "goal"
    ? `I can run this as an RDS Goal. It will re-read the PRD/spec/evidence, choose fix or iteration actions, rerun QA/readiness, and keep going until the build is review-ready or a precise handoff remains.`
    : action.kind === "iterate"
    ? `I can run this as an autonomous post-build iteration. It will patch the generated app, run checks, redeploy, run QA, and keep making targeted follow-up passes if QA still finds fixable gaps.`
    : action.kind === "qa"
      ? `I can start a fresh Playwright QA pass for this build.`
      : action.kind === "redeploy"
        ? `I can redeploy this build to Zo from the generated app directory.`
        : action.kind === "approve"
          ? `I can mark this build approved after your review.`
          : action.kind === "agent-start"
            ? `I can start a persistent ${action.provider === "codex" ? "Codex" : "Claude Code"} worker in an isolated git worktree from this chat. RDS will record the tmux session, logs, branch, and diff; nothing merges or pushes automatically.`
            : `I can delete this build's recorded Zo service and clear the preview URL after deletion is verified.`;
  const rdsTurn: ChatTurn = { id: randomUUID().slice(0, 12), role: "rds", text, ts: now + 1, seq: seq + 1, status: "complete", action };
  session.turns.push(userTurn, rdsTurn);
  session.updated_at = now + 1;
  session.last_read_at = now + 1;
  writeChatSession(session);
  return { userTurn, rdsTurn };
}

// Track running rds-chat subprocesses so we can know which sessions have
// in-flight turns (and so a future stop button can target them). We don't kill
// them on dashboard restart — we just mark their pending turns as errored.
const pendingChats = new Map<string, { turnId: string; pid?: number }>();

function repairPendingTurns(): void {
  for (const s of listChatSessions()) {
    let dirty = false;
    for (const t of s.turns) {
      if (t.role === "rds" && t.status === "pending") {
        t.status = "error";
        t.text = (t.text || "") + "\n[dashboard restarted before reply arrived]";
        dirty = true;
      }
    }
    if (dirty) {
      s.updated_at = Date.now();
      writeChatSession(s);
    }
  }
}

function spawnChatForSession(session: ChatSession, message: string, attachments: BuildAttachment[] = []): { userTurn: ChatTurn; rdsTurn: ChatTurn } {
  const cmd = join(RDS_ROOT, "bin", "rds-chat");
  const now = Date.now();
  normalizeChatSeq(session);
  const seq = nextChatSeq(session);
  const userTurn: ChatTurn = { id: randomUUID().slice(0, 12), role: "you", text: message, ts: now, seq, status: "complete", attachments };
  const rdsTurn: ChatTurn = { id: randomUUID().slice(0, 12), role: "rds", text: "", ts: now + 1, seq: seq + 1, status: "pending" };
  session.turns.push(userTurn, rdsTurn);
  session.updated_at = now;
  // Reading your own message implicitly clears the badge for this session up to now.
  session.last_read_at = now + 1;
  writeChatSession(session);

  if (!existsSync(cmd)) {
    finalizeChatTurn(session.id, rdsTurn.id, "error", "bin/rds-chat missing on this RDS checkout. Pull latest and re-run bootstrap.");
    return { userTurn, rdsTurn };
  }

  const args = session.build_id ? [`--build-id=${session.build_id}`] : [];
  const child = spawn(cmd, args, {
    cwd: RDS_ROOT, stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, RDS_NOTIFY_DISABLED: "1" }
  });
  pendingChats.set(session.id, { turnId: rdsTurn.id, pid: child.pid });
  child.stdin.write(`${message}${chatAttachmentContext(attachments)}`);
  child.stdin.end();
  let stdout = "", stderr = "";
  child.stdout.on("data", (d) => (stdout += d.toString()));
  child.stderr.on("data", (d) => (stderr += d.toString()));
  child.on("close", (code) => {
    pendingChats.delete(session.id);
    const ok = code === 0;
    const text = (stdout.trim() || stderr.trim() || `(rds-chat exited ${code ?? "?"})`).slice(0, 64 * 1024);
    finalizeChatTurn(session.id, rdsTurn.id, ok ? "complete" : "error", text);
  });
  child.on("error", (err) => {
    pendingChats.delete(session.id);
    finalizeChatTurn(session.id, rdsTurn.id, "error", `spawn failed: ${err?.message || err}`);
  });
  return { userTurn, rdsTurn };
}

function finalizeChatTurn(sessionId: string, turnId: string, status: "complete" | "error", text: string): void {
  const s = readChatSession(sessionId);
  if (!s) return;
  const t = s.turns.find((x) => x.id === turnId);
  if (!t) return;
  t.text = text;
  t.status = status;
  // Keep the creation ts (and seq) so the reply stays in its original slot;
  // only bump the session's updated_at to reflect activity.
  s.updated_at = Date.now();
  writeChatSession(s);
}

function appendChatSystemTurn(sessionId: string, text: string, status: "complete" | "error" = "complete"): void {
  const s = readChatSession(sessionId);
  if (!s) return;
  s.turns.push({ id: randomUUID().slice(0, 12), role: "rds", text, ts: Date.now(), seq: nextChatSeq(s), status });
  s.updated_at = Date.now();
  writeChatSession(s);
}

function actionRunPath(buildId: string): string {
  const dir = join(BUILDS_DIR, buildId, "actions");
  mkdirSync(dir, { recursive: true });
  return join(dir, `action-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 6)}.json`);
}

function writeActionRun(path: string, patch: Record<string, unknown>): void {
  const current = safeReadJson<Record<string, unknown>>(path) || {};
  writeFileSync(path, JSON.stringify({ ...current, ...patch, updated_at: new Date().toISOString() }, null, 2) + "\n");
}

function latestQaSignal(buildId: string): string {
  try {
    const latest = listQaIterations(buildId)[0];
    if (!latest) return "QA: no Playwright iteration found.";
    const iterDir = join(BUILDS_DIR, buildId, "playwright", latest.name);
    const summary = safeReadJson<Record<string, unknown>>(join(iterDir, "summary.json"));
    const verdict = safeReadJson<Record<string, unknown>>(join(iterDir, "spec-verdict.json"));
    const parts = [`QA: ${latest.name}`];
    if (typeof summary?.gapsFound === "number") parts.push(`${summary.gapsFound} gaps`);
    if (typeof summary?.converged === "boolean") parts.push(summary.converged ? "converged" : "not converged");
    if (typeof verdict?.overall === "string") parts.push(`spec ${verdict.overall}`);
    return parts.join(" · ");
  } catch {
    return "QA: unavailable.";
  }
}

function diffSignal(buildId: string): string {
  const state = safeReadJson<StateJson>(join(BUILDS_DIR, buildId, "state.json")) || {};
  const appDir = state.app_dest || resolveAppDest(join(BUILDS_DIR, buildId));
  if (!appDir || !existsSync(appDir)) return "Diff: app directory unavailable.";
  const status = spawnSync("git", ["-C", appDir, "status", "--short"], { encoding: "utf8", timeout: 5000 });
  if (status.status !== 0) return "Diff: not a git checkout or unavailable.";
  const changed = status.stdout.trim().split("\n").filter(Boolean).slice(0, 12);
  if (!changed.length) return "Diff: no tracked working-tree changes reported.";
  return `Diff: ${changed.length}${changed.length === 12 ? "+" : ""} changed file(s). Open Logs/Diff for file details.`;
}

function reviewSignal(buildId: string): string {
  const state = safeReadJson<StateJson>(join(BUILDS_DIR, buildId, "state.json")) || {};
  const review = state.review?.status || "not set";
  return `Review: ${review}`;
}

function finalChatActionSummary(action: ChatAction, run: ActionRunState): string {
  const ok = run.status === "passed";
  const needsReview = run.status === "needs_review";
  const lines = [
    `${ok ? "Action passed" : needsReview ? "Action needs review" : "Action failed"}: ${action.label}`,
    `Phase: ${run.phase || "complete"}${run.exit_code != null ? ` · exit ${run.exit_code}` : ""}`,
  ];
  if (run.failed_phase) lines.push(`Failed phase: ${run.failed_phase}`);
  if (run.error) lines.push(`${needsReview ? "Reason" : "Error"}: ${run.error}`);
  if (run.summary_file) lines.push(`Summary: ${run.summary_file}`);
  if (run.repair_jobs) lines.push(`Repair jobs: ${run.repair_jobs}`);
  if (run.repair_convergence) lines.push(`Repair convergence: ${run.repair_convergence}`);
  const preview = run.preview_url || safeReadPreview(action.build_id);
  if (preview) lines.push(`Preview: ${preview}`);
  lines.push(latestQaSignal(action.build_id));
  if (action.kind === "iterate") lines.push(diffSignal(action.build_id));
  if (action.kind === "goal") {
    const goal = readGoalState(action.build_id);
    if (goal?.status) lines.push(`Goal: ${displayTokenLabel(goal.status)} · ${displayTokenLabel(goal.phase || "unknown")}`);
    if (goal?.nextAction) lines.push(`Next: ${goal.nextAction}`);
  }
  if (action.kind === "agent-start" && run.agent_session_id) lines.push(`Agent session: ${run.agent_session_id}`);
  lines.push(reviewSignal(action.build_id));
  return lines.filter(Boolean).join("\n");
}

function safeReadPreview(buildId: string): string {
  try { return readFileSync(join(BUILDS_DIR, buildId, "preview-url.txt"), "utf8").trim(); }
  catch { return ""; }
}

function createActionRun(action: ChatAction, opts: { sessionId?: string; turnId?: string }): string {
  const p = actionRunPath(action.build_id);
  writeActionRun(p, {
    ok: null,
    status: "queued",
    phase: "queued",
    build_id: action.build_id,
    action_kind: action.kind,
    prompt: action.prompt || "",
    chat_session_id: opts.sessionId || "",
    chat_turn_id: opts.turnId || "",
    created_at: new Date().toISOString(),
  });
  return p;
}

function startChatAction(action: ChatAction, opts: { sessionId?: string; turnId?: string } = {}): { ok: boolean; status?: number; error?: string; pid?: number; hint?: string; action_run?: string } {
  const id = action.build_id;
  const dir = join(BUILDS_DIR, id);
  if (!existsSync(dir)) return { ok: false, status: 404, error: "build not found" };

  if (action.kind === "goal") {
    const cmd = join(RDS_ROOT, "bin", "rds-goal");
    if (!existsSync(cmd)) return { ok: false, status: 500, error: "bin/rds-goal missing" };
    const existing = readGoalState(id);
    if (goalLooksFreshRunning(existing)) return { ok: false, status: 409, error: "A goal loop is already marked running for this build." };
    const objective = (action.prompt || "").trim().length >= 8 ? (action.prompt || "").trim() : "Make this build review-ready.";
    const runPath = createActionRun(action, opts);
    const runRel = `builds/${id}/actions/${basename(runPath)}`;
    const child = spawn(cmd, [id, `--objective=${objective}`, "--max-cycles=12"], {
      cwd: RDS_ROOT, stdio: "ignore", detached: true,
      env: { ...process.env, RDS_NOTIFY_DISABLED: "1", RDS_ZO_REUSE_EXISTING: "1" }
    });
    child.on("close", (code) => {
      const goal = readGoalState(id);
      const passed = code === 0 && goal?.status === "passed";
      writeActionRun(runPath, {
        ok: passed,
        status: passed ? "passed" : "needs_review",
        phase: goal?.phase || "complete",
        exit_code: code ?? 1,
        summary_file: goal?.goalDir ? `${goal.goalDir}/goal.json` : `builds/${id}/goal.json`,
        error: passed ? undefined : goal?.nextAction || "Goal stopped before the build reached review-ready.",
      });
    });
    child.unref();
    writeActionRun(runPath, { status: "running", phase: "goal", pid: child.pid || null });
    return { ok: true, pid: child.pid, hint: `watch ${runRel}, builds/${id}/goal.json, and the Goal panel`, action_run: runRel };
  }

  if (action.kind === "iterate") {
    const prompt = (action.prompt || "").trim();
    if (prompt.length < 8) return { ok: false, status: 400, error: "iteration prompt is too short" };
    const cmd = join(RDS_ROOT, "bin", "rds-iterate");
    if (!existsSync(cmd)) return { ok: false, status: 500, error: "bin/rds-iterate missing" };
    const runPath = createActionRun(action, opts);
    const runRel = `builds/${id}/actions/${basename(runPath)}`;
    const child = spawn(cmd, [id, "--yes"], {
      cwd: RDS_ROOT, stdio: ["pipe", "ignore", "ignore"], detached: true,
      env: { ...process.env, RDS_NOTIFY_DISABLED: "1", RDS_ACTION_RUN_FILE: runPath, RDS_ZO_REUSE_EXISTING: "1" }
    });
    child.stdin.end(prompt);
    child.unref();
    writeActionRun(runPath, { status: "running", phase: "apply", pid: child.pid || null });
    return { ok: true, pid: child.pid, hint: `watch ${runRel}, builds/${id}/iterate-*.summary.json, and the Live Log tab for autonomous follow-up passes`, action_run: runRel };
  }

  if (action.kind === "qa") {
    const previewPath = join(dir, "preview-url.txt");
    if (!existsSync(previewPath)) return { ok: false, status: 409, error: "build has not deployed yet" };
    const cmd = join(RDS_ROOT, "bin", "rds-qa");
    if (!existsSync(cmd)) return { ok: false, status: 500, error: "bin/rds-qa missing" };
    const runPath = createActionRun(action, opts);
    const runRel = `builds/${id}/actions/${basename(runPath)}`;
    const child = spawn(cmd, [id], {
      cwd: RDS_ROOT, stdio: "ignore", detached: true,
      env: { ...process.env, RDS_NOTIFY_DISABLED: "1", RDS_ACTION_RUN_FILE: runPath }
    });
    child.on("close", (code) => {
      writeActionRun(runPath, {
        ok: code === 0,
        status: code === 0 ? "passed" : "failed",
        phase: "complete",
        exit_code: code ?? 1,
      });
    });
    child.unref();
    writeActionRun(runPath, { status: "running", phase: "qa", pid: child.pid || null });
    return { ok: true, pid: child.pid, hint: `watch ${runRel} and builds/${id}/playwright/`, action_run: runRel };
  }

  if (action.kind === "redeploy") {
    const state = safeReadJson<StateJson>(join(dir, "state.json")) || {};
    const appDir = state.app_dest || resolveAppDest(dir);
    if (!appDir) return { ok: false, status: 400, error: "no app_dest available for redeploy" };
    const cmd = join(RDS_ROOT, "bin", "rds-deploy");
    if (!existsSync(cmd)) return { ok: false, status: 500, error: "bin/rds-deploy missing" };
    const runPath = createActionRun(action, opts);
    const runRel = `builds/${id}/actions/${basename(runPath)}`;
    const child = spawn(cmd, [`--build-id=${id}`, `--app-dir=${appDir}`, "--target=zo"], {
      cwd: RDS_ROOT, stdio: "ignore", detached: true,
      env: { ...process.env, RDS_NOTIFY_DISABLED: "1", RDS_ACTION_RUN_FILE: runPath, RDS_ZO_REUSE_EXISTING: "1" }
    });
    child.on("close", (code) => {
      const preview = existsSync(join(dir, "preview-url.txt")) ? readFileSync(join(dir, "preview-url.txt"), "utf8").trim() : "";
      writeActionRun(runPath, {
        ok: code === 0,
        status: code === 0 ? "passed" : "failed",
        phase: "complete",
        exit_code: code ?? 1,
        preview_url: preview,
      });
    });
    child.unref();
    writeActionRun(runPath, { status: "running", phase: "deploy", pid: child.pid || null });
    return { ok: true, pid: child.pid, hint: `watch ${runRel}, deploy log, and preview-url.txt`, action_run: runRel };
  }

  if (action.kind === "agent-start") {
    const provider = action.provider === "codex" ? "codex" : "claude-code";
    const task = (action.prompt || action.description || "").trim();
    if (task.length < 8) return { ok: false, status: 400, error: "agent task is too short" };
    const state = safeReadJson<StateJson>(join(dir, "state.json")) || {};
    const repo = state.app_dest || resolveAppDest(dir);
    if (!repo) return { ok: false, status: 400, error: "no app_dest available for agent session" };
    const cmd = join(RDS_ROOT, "bin", "rds-agent-start");
    if (!existsSync(cmd)) return { ok: false, status: 500, error: "bin/rds-agent-start missing" };
    const runPath = createActionRun(action, opts);
    const runRel = `builds/${id}/actions/${basename(runPath)}`;
    const child = spawn(cmd, [`--build-id=${id}`, `--provider=${provider}`, "--mode=interactive", `--repo=${repo}`, `--task=${task}`, "--started-by=chat"], {
      cwd: RDS_ROOT, stdio: ["ignore", "pipe", "pipe"], detached: true,
      env: { ...process.env, RDS_NOTIFY_DISABLED: "1", RDS_ACTION_RUN_FILE: runPath }
    });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => {
      const sessionId = stdout.match(/session_id=([^\s]+)/)?.[1] || "";
      writeActionRun(runPath, {
        ok: code === 0,
        status: code === 0 ? "passed" : "failed",
        phase: "complete",
        exit_code: code ?? 1,
        agent_session_id: sessionId,
        stdout: stdout.slice(-4000),
        error: code === 0 ? "" : stderr.slice(-2000),
      });
    });
    child.unref();
    writeActionRun(runPath, { status: "running", phase: "agent_start", pid: child.pid || null });
    return { ok: true, pid: child.pid, hint: `watch ${runRel} and builds/${id}/agent-sessions/`, action_run: runRel };
  }

  if (action.kind === "approve") {
    const cmd = join(RDS_ROOT, "bin", "rds-approve");
    if (!existsSync(cmd)) return { ok: false, status: 500, error: "bin/rds-approve missing" };
    const runPath = createActionRun(action, opts);
    const runRel = `builds/${id}/actions/${basename(runPath)}`;
    const child = spawn(cmd, [id, "--by=dashboard-chat", "--reason=Confirmed from build chat."], {
      cwd: RDS_ROOT, stdio: "ignore", detached: true,
      env: { ...process.env, RDS_NOTIFY_DISABLED: "1", RDS_ACTION_RUN_FILE: runPath }
    });
    child.on("close", (code) => {
      writeActionRun(runPath, {
        ok: code === 0,
        status: code === 0 ? "passed" : "failed",
        phase: "complete",
        exit_code: code ?? 1,
      });
    });
    child.unref();
    writeActionRun(runPath, { status: "running", phase: "approve", pid: child.pid || null });
    return { ok: true, pid: child.pid, hint: `watch ${runRel} and state.json review status`, action_run: runRel };
  }

  if (action.kind === "delete-service") {
    const info = readServiceInfo(id);
    if (!info?.service_id) return { ok: false, status: 409, error: "No recorded Zo service for this build." };
    const runPath = createActionRun(action, opts);
    const runRel = `builds/${id}/actions/${basename(runPath)}`;
    if (info.status === "deregistered") {
      writeActionRun(runPath, {
        ok: true,
        status: "passed",
        phase: "complete",
        exit_code: 0,
        preview_url: "",
        summary_file: runRel,
      });
      return { ok: true, hint: "service was already marked deregistered", action_run: runRel };
    }
    const cmd = join(RDS_ROOT, "bin", "rds-zo-deregister");
    if (!existsSync(cmd)) return { ok: false, status: 500, error: "bin/rds-zo-deregister missing" };
    const child = spawn(cmd, [`--service-id=${info.service_id}`, `--build-id=${id}`], {
      cwd: RDS_ROOT, stdio: ["ignore", "pipe", "pipe"], detached: true,
      env: { ...process.env, RDS_NOTIFY_DISABLED: "1", RDS_ACTION_RUN_FILE: runPath }
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => {
      const ok = code === 0;
      if (ok) {
        writeServiceInfo(id, { ...info, status: "deregistered" });
        writeFileSync(join(dir, "preview-url.txt"), "\n");
        updateBuildPreview(id, "");
      } else {
        writeServiceInfo(id, { ...info, status: "unknown" });
      }
      writeActionRun(runPath, {
        ok,
        status: ok ? "passed" : "failed",
        phase: "complete",
        exit_code: code ?? 1,
        preview_url: "",
        error: ok ? undefined : (stderr.trim() || stdout.trim() || "Zo service deletion failed").slice(0, 1000),
      });
    });
    child.unref();
    writeActionRun(runPath, { status: "running", phase: "delete-service", pid: child.pid || null });
    return { ok: true, pid: child.pid, hint: `watch ${runRel} and service.json`, action_run: runRel };
  }

  return { ok: false, status: 400, error: "unsupported chat action" };
}

// ---------- routes ----------------------------------------------------------

const app = new Hono();

app.get("/healthz", (c) => c.text("ok"));

// Password gate. Browser-native HTTP Basic Auth: any path other than /healthz
// requires the configured password. Username is fixed (default "rds") and
// effectively ignored — the password is the secret. If RDS_DASHBOARD_PASSWORD
// is unset the dashboard refuses to serve, since it's exposed publicly.
app.use("*", async (c, next) => {
  if (
    c.req.path === "/healthz" ||
    c.req.path === "/favicon.ico" ||
    c.req.path === "/site.webmanifest" ||
    c.req.path.startsWith("/static/")
  ) return next();
  if (!DASHBOARD_PASS) {
    // Fresh clone, nothing configured yet: serve direct localhost requests in
    // setup mode with a visible banner. Anything else is refused — an
    // unprotected control surface is never exposed beyond the loopback.
    if (setupModeActive() && isLocalDirectRequest(c)) {
      await next();
      const type = c.res.headers.get("content-type") || "";
      if (type.includes("text/html")) {
        const html = await c.res.text();
        const headers = new Headers(c.res.headers);
        headers.delete("content-length");
        c.res = new Response(html.replace("</body>", `${SETUP_MODE_BANNER}</body>`), { status: c.res.status, headers });
      }
      return;
    }
    return c.html(refusalPage(
      "Dashboard locked until setup completes",
      setupModeActive()
        ? "No dashboard credentials are configured, so RDS only serves this console to direct localhost requests. To use it remotely, set <code>RDS_DASHBOARD_PASSWORD</code> and <code>RDS_DASHBOARD_TOKEN</code> in <code>.env</code> and restart."
        : "A write token is set but <code>RDS_DASHBOARD_PASSWORD</code> is missing. Set it in <code>.env</code> and restart to finish securing the dashboard.",
    ), 503);
  }
  if (DASHBOARD_TOKEN && secretsEqual(c.req.header("x-rds-token") || "", DASHBOARD_TOKEN)) {
    return next();
  }
  const mw = basicAuth({
    verifyUser: (_user, pass) => secretsEqual(pass, DASHBOARD_PASS),
    realm: "RDS",
  });
  // basicAuth throws an HTTPException(401) whose default body is bare text
  // served as octet-stream — a blank page if the browser's credential dialog
  // is dismissed. Serve a quiet, on-brand hint instead (WWW-Authenticate
  // preserved so the prompt returns on reload).
  try {
    await mw(c, next);
  } catch (err) {
    const res: Response | undefined = typeof (err as { getResponse?: () => Response })?.getResponse === "function"
      ? (err as { getResponse: () => Response }).getResponse()
      : undefined;
    if (res?.status !== 401) throw err;
    const authHeader = res.headers.get("www-authenticate") ?? 'Basic realm="RDS"';
    return new Response(refusalPage(
      "Sign-in required",
      "This dashboard is protected by HTTP Basic Auth. Use the operator credentials (<code>RDS_DASHBOARD_USER</code> / <code>RDS_DASHBOARD_PASSWORD</code>) configured on this host.",
      `<a class="cta" href="/">Sign in</a>`,
    ), {
      status: 401,
      headers: { "WWW-Authenticate": authHeader, "Content-Type": "text/html; charset=utf-8" },
    });
  }
});

// Minimal self-contained page for auth/setup refusals — quiet, on-brand,
// never a blank screen.
function refusalPage(title: string, bodyHtml: string, extraHtml = ""): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>RDS — ${escapeHtml(title)}</title>
<style>
  body { margin: 0; min-height: 100dvh; display: grid; place-items: center;
         background: #0b0d0c; color: #e9eeea;
         font: 14px/1.6 Inter, system-ui, -apple-system, sans-serif; }
  main { text-align: center; padding: 24px; }
  .mark { font-weight: 700; letter-spacing: .02em; color: #8beebb; font-size: 18px; }
  .mark span { color: #a5b0a9; font-weight: 400; margin-left: 8px; font-size: 13px; }
  h1 { font-size: 15px; font-weight: 650; margin: 20px 0 6px; }
  p { color: #a5b0a9; margin: 0 auto; max-width: 46ch; }
  code { font-family: "JetBrains Mono", ui-monospace, monospace; font-size: 12.5px; color: #b9c2bc; }
  .cta { display: inline-block; margin-top: 20px; padding: 8px 16px; border-radius: 8px;
      background: #6ad7a3; color: #072012; font-weight: 600; text-decoration: none; }
</style></head><body><main>
  <div class="mark">RDS<span>Remote Deployment System</span></div>
  <h1>${escapeHtml(title)}</h1>
  <p>${bodyHtml}</p>
  ${extraHtml}
</main></body></html>`;
}

// Injected above the closing body tag on every HTML response while running
// without credentials. Amber = attention, per the design language.
const SETUP_MODE_BANNER = `<div id="rds-setup-banner" style="position:fixed;left:0;right:0;bottom:0;z-index:9999;pointer-events:none;background:#241c10;border-top:1px solid rgba(240,184,105,.4);color:#ffd9a0;font:12.5px/1.5 Inter,system-ui,sans-serif;padding:7px 16px;text-align:center;">
  <strong style="font-weight:650;">Setup mode</strong> — no dashboard credentials configured; serving to localhost only.
  Set <code style="font-family:'JetBrains Mono',ui-monospace,monospace;color:#f0b869;">RDS_DASHBOARD_PASSWORD</code> and
  <code style="font-family:'JetBrains Mono',ui-monospace,monospace;color:#f0b869;">RDS_DASHBOARD_TOKEN</code> in <code style="font-family:'JetBrains Mono',ui-monospace,monospace;color:#f0b869;">.env</code> to secure and enable remote access.
</div>
<script>(function(){
  var b = document.getElementById('rds-setup-banner');
  if (!b) return;
  function pad() {
    var h = b.offsetHeight;
    // Reserve space so the fixed banner never covers page footers or the
    // sidebar's bottom links.
    document.body.style.paddingBottom = h + 'px';
    var nav = document.getElementById('rds-sidenav');
    if (nav) nav.style.paddingBottom = (h + 8) + 'px';
  }
  pad();
  window.addEventListener('resize', pad);
})();</script>`;

// Vendored static assets (e.g. ansi_up.min.js for terminal rendering).
app.get("/static/:name", (c) => {
  const name = c.req.param("name");
  if (!/^[a-z0-9._-]+$/i.test(name)) return c.text("invalid", 400);
  const path = join(RDS_ROOT, "dashboard", "public", name);
  if (!existsSync(path)) return c.text("not found", 404);
  const ext = name.toLowerCase().split(".").pop();
  const mime: Record<string, string> = {
    js: "application/javascript", css: "text/css", svg: "image/svg+xml",
    png: "image/png", json: "application/json", ico: "image/x-icon"
  };
  // existsSync alone is racy — the file can vanish between check and read.
  let body: Buffer;
  try { body = readFileSync(path); } catch { return c.text("not found", 404); }
  c.header("Content-Type", mime[ext ?? ""] ?? "text/plain");
  c.header("Cache-Control", "public, max-age=86400");
  return c.body(body);
});

app.get("/favicon.ico", (c) => {
  const path = join(RDS_ROOT, "dashboard", "public", "favicon.ico");
  let body: Buffer;
  try { body = readFileSync(path); } catch { return c.text("not found", 404); }
  c.header("Content-Type", "image/x-icon");
  c.header("Cache-Control", "public, max-age=604800");
  return c.body(body);
});

app.get("/site.webmanifest", (c) => c.json({
  name: "RDS",
  short_name: "RDS",
  description: "Remote Deployment System",
  start_url: "/",
  display: "standalone",
  background_color: "#070908",
  theme_color: "#070908",
  icons: [
    { src: "/static/icon-192.png", sizes: "192x192", type: "image/png" },
    { src: "/static/icon-512.png", sizes: "512x512", type: "image/png" }
  ]
}));

app.get("/health", (c) => c.json({
  ok: true,
  service: "rds-dashboard",
  rds_root: RDS_ROOT,
  token_configured: !!DASHBOARD_TOKEN,
  uptime_seconds: Math.round(process.uptime()),
}));

app.post("/alerts/dismiss", async (c) => {
  const denied = tokenGate(c);
  if (denied) {
    appendAudit({ route: "POST /alerts/dismiss", outcome: "denied", status: denied.status, ip: callerIp(c), ua: callerUa(c) });
    return denied;
  }
  const body = (await c.req.json().catch(() => ({}))) as { build_id?: string };
  const id = (body.build_id || "").trim();
  if (!id || !existingBuildDirForId(id)) return c.json({ ok: false, error: "valid build_id required" }, 400);
  const ids = dismissedAlerts();
  ids.add(id);
  writeDismissedAlerts(ids);
  appendAudit({ route: "POST /alerts/dismiss", build_id: id, outcome: "ok", ip: callerIp(c), ua: callerUa(c) });
  return c.json({ ok: true, build_id: id });
});

app.post("/reviews/dismiss", async (c) => {
  const denied = tokenGate(c);
  if (denied) {
    appendAudit({ route: "POST /reviews/dismiss", outcome: "denied", status: denied.status, ip: callerIp(c), ua: callerUa(c) });
    return denied;
  }
  const body = (await c.req.json().catch(() => ({}))) as { build_id?: string };
  const id = (body.build_id || "").trim();
  if (!id || !existingBuildDirForId(id)) return c.json({ ok: false, error: "valid build_id required" }, 400);
  const ids = dismissedReviews();
  ids.add(id);
  writeDismissedReviews(ids);
  appendAudit({ route: "POST /reviews/dismiss", build_id: id, outcome: "ok", ip: callerIp(c), ua: callerUa(c) });
  return c.json({ ok: true, build_id: id });
});

app.get("/", async (c) => {
  const builds = await listBuilds(500);
  const running = builds.filter((b) => b.running).length;
  const stuck   = builds.filter((b) => b.stuck).length;
  const dismissed = dismissedAlerts();
  const dismissedReviewIds = dismissedReviews();
  const failedBuilds = builds.filter((b) => b.status === "failed" && !dismissed.has(b.id));
  const failed  = failedBuilds.length;
  const pendingAll = builds.filter((b) => b.reviewStatus === "pending");
  const pending = pendingAll.filter((b) => !dismissedReviewIds.has(b.id));
  const wd      = watchdogStatus();
  const recent  = builds.slice().sort((a, b) => {
    const aLive = a.liveOnZo || a.serviceStatus === "live" ? 1 : 0;
    const bLive = b.liveOnZo || b.serviceStatus === "live" ? 1 : 0;
    return bLive - aLive || buildAttentionSort(a, b);
  }).slice(0, 6);
  const runningBuilds = builds.filter((b) => b.running);
  const activeBuildHref = runningBuilds.length === 1 ? `/b/${encodeURIComponent(runningBuilds[0].id)}` : "/builds?status=running";
  const hostedBuilds = builds.filter((b) => b.hasZoService);
  const lastFailed = failedBuilds[0];

  // pull last 12 audit entries to seed the live activity card
  const auditEntries: { ts?: string; route?: string; build_id?: string; outcome?: string; note?: string }[] = existsSync(AUDIT_LOG)
    ? readFileSync(AUDIT_LOG, "utf8").split("\n").filter(Boolean).slice(-12)
        .map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } })
        .sort((a, b) => Date.parse(b.ts || "") - Date.parse(a.ts || ""))
    : [];

  const recentRows = recent.map((b) => {
    const title = b.displayName || compactBuildId(b.id);
    const age = b.lastActivityMs ? relativeTime(b.lastActivityMs) : "—";
    const stage = b.stage ? displayTokenLabel(b.stage) : "No stage";
    const review = b.reviewStatus ? displayTokenLabel(b.reviewStatus) : displayTokenLabel(b.status || "unknown");
    const modeParts = [b.stack ? stackDisplayLabel(b.stack) : "", b.mode ? modeDisplayLabel(b.mode) : ""].filter(Boolean).join(" · ");
    return `
    <a href="/b/${escapeHtml(b.id)}" class="rds-recent-build-row group">
      <span class="rds-recent-build-top">
        <span class="rds-recent-build-title-wrap">
          <span class="rds-recent-build-dot">${statusDot(b)}</span>
          <span class="rds-recent-build-title" title="${escapeHtml(b.id)}">${escapeHtml(title)}</span>
        </span>
        <span class="rds-recent-build-age">${escapeHtml(age)}</span>
      </span>
      <span class="rds-recent-build-id">${escapeHtml(compactBuildId(b.id))}</span>
      <span class="rds-recent-build-bottom">
        <span class="rds-recent-build-stage">${escapeHtml(stage)}</span>
        <span class="rds-recent-build-review">${escapeHtml(review)}</span>
        ${modeParts ? `<span class="rds-recent-build-mode">${escapeHtml(modeParts)}</span>` : ""}
        <span class="rds-recent-build-host">${hostingPill(b)}</span>
      </span>
    </a>`;
  }).join("");

  const recentMobileItems = recent.map((b) => `
    <a href="/b/${escapeHtml(b.id)}" class="flex items-center gap-2 py-2 border-b border-[#242b28]/50 last:border-b-0">
      ${statusDot(b)}
      <span class="font-body text-[12px] text-on-surface truncate min-w-0 flex-1" title="${escapeHtml(b.id)}">${escapeHtml(b.displayName || compactBuildId(b.id))}</span>
      <span class="shrink-0">${hostingPill(b)}</span>
      <span class="shrink-0 font-table text-[11px] text-on-surface-variant">${b.lastActivityMs ? escapeHtml(relativeTime(b.lastActivityMs)) : "-"}</span>
    </a>`).join("");

  const pendingItems = pending.length
    ? pending.map((b) => `
      <div data-review-card="${escapeHtml(b.id)}" class="bg-[#101412] panel-border p-2 rounded flex justify-between items-center gap-2 group hover:bg-[#1b211e] transition-colors">
        <a href="/b/${escapeHtml(b.id)}" class="min-w-0 flex-1">
          <div class="font-body text-body text-on-surface truncate" title="${escapeHtml(b.id)}">${escapeHtml(b.displayName || compactBuildId(b.id))}</div>
          <div class="font-table text-table text-on-surface-variant truncate">${escapeHtml([b.stack, b.mode, b.provider].filter(Boolean).join(" · ") || "—")}</div>
        </a>
        <button type="button" onclick="dismissReview('${escapeHtml(b.id)}')" class="shrink-0 font-ribbon text-ribbon text-on-surface bg-[#1b211e] px-2 py-1 rounded hover:bg-[#242b28] transition-colors border border-[#242b28]" title="Hide this build from the Needs Review queue">Dismiss</button>
      </div>`).join("")
    : `<div class="text-on-surface-variant font-table text-table italic">Nothing waiting on review.</div>`;

  const activityRows = auditEntries.length ? auditEntries.map((e) => {
    const time = e.ts ? new Date(e.ts).toISOString().slice(11, 19) : "";
    const tag =
      e.outcome === "denied" ? ["DENY", "text-error"]
      : (e.route || "").startsWith("POST /b") ? ["BLD", "text-primary-container"]
      : (e.route || "").startsWith("POST /watchdog") ? ["WDG", "text-tertiary-container"]
      : (e.route || "").startsWith("POST /upload-prd") ? ["PRD", "text-tertiary"]
      : ["SYS", "text-[#b9c2bc]"];
    const target = e.build_id ? ` ${e.build_id}` : "";
    return `<div class="flex gap-3 hover:bg-[#1b211e] px-1 py-0.5 rounded transition-colors text-on-surface-variant">
      <span class="text-[#8b968f] shrink-0 font-code text-[12px]">${escapeHtml(time)}</span>
      <span class="${tag[1]} shrink-0 font-code text-[12px]">[${tag[0]}]</span>
      <span class="truncate font-code text-[12px]">${escapeHtml((e.route ?? "") + target + (e.note ? " · " + e.note : ""))}</span>
    </div>`;
  }).join("") : `<div class="text-on-surface-variant font-code text-[12px] italic">No audit entries yet.</div>`;

  const wdToggle = `
    <button id="watchdog-toggle" onclick="toggleWatchdog()" data-running="${wd.running ? "1" : "0"}" data-running-builds="${running}" class="relative inline-flex items-center cursor-pointer">
      <span class="sr-only">Toggle watchdog</span>
      <span class="w-9 h-5 ${wd.running ? "bg-primary-container" : "bg-[#242b28]"} rounded-full inline-block relative transition-colors">
        <span class="absolute top-[2px] ${wd.running ? "left-[18px]" : "left-[2px]"} bg-white rounded-full h-4 w-4 transition-all border border-gray-300"></span>
      </span>
    </button>`;

  const criticalCard = lastFailed
    ? `<div class="bg-[#101412] border border-[#ffb4ab]/30 p-2 rounded flex flex-col gap-1">
        <div class="flex justify-between items-start gap-2 min-w-0">
          <div class="min-w-0">
            <div class="font-body text-body text-on-surface truncate">${escapeHtml(lastFailed.displayName || lastFailed.slug || lastFailed.id)}</div>
            <div class="font-code text-[10px] leading-4 text-on-surface-variant truncate">${escapeHtml(lastFailed.id)}</div>
          </div>
          <span class="font-ribbon text-ribbon text-error shrink-0">Failed${lastFailed.lastActivityMs ? ` · ${escapeHtml(relativeTime(lastFailed.lastActivityMs))}` : ""}</span>
        </div>
        <div class="font-table text-table text-on-surface-variant truncate">failed at ${escapeHtml(lastFailed.stage ?? "unknown")} stage</div>
        <div class="mt-1 flex justify-end gap-2">
          <button type="button" onclick="dismissAlert('${escapeHtml(lastFailed.id)}')" class="font-ribbon text-ribbon text-on-surface bg-[#1b211e] px-2 py-1 rounded hover:bg-[#242b28] transition-colors border border-[#242b28]">Dismiss</button>
          <a href="/b/${escapeHtml(lastFailed.id)}" class="font-ribbon text-ribbon text-on-surface bg-[#1b211e] px-2 py-1 rounded hover:bg-[#242b28] transition-colors border border-[#242b28]">View build</a>
        </div>
      </div>`
    : `<div class="text-on-surface-variant font-table text-table italic">No critical alerts.</div>`;

  return c.html(layout("Hub", `
    <div class="max-w-[1400px] mx-auto">
      <div class="rds-page-header">
        <div>
          <div class="rds-page-eyebrow">Operator console</div>
          <h1 class="rds-page-title">Hub Overview</h1>
          <p class="rds-page-copy">System health, build movement, review queues, hosted services, and live activity in one scan.</p>
        </div>
        <div class="flex items-center gap-2 font-ribbon text-ribbon text-on-surface-variant">
          <a href="/audit" class="rds-action-secondary">${icon("analytics", 14)}<span>Audit log</span></a>
        </div>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-gutter">

        <!-- Build Engine -->
        <div class="rds-hub-card rds-hub-card-compact bg-surface-container panel-border rounded-DEFAULT flex flex-col p-unit">
          <div class="flex justify-between items-center mb-unit border-b border-[#242b28] pb-unit">
            <h2 class="font-h2 text-h2 text-on-surface flex items-center gap-2">
              ${icon("speed", 16, "text-primary-container")}<span>Build Engine</span>
            </h2>
            <span class="flex items-center gap-1 font-ribbon text-ribbon text-primary-container bg-primary-container/10 px-2 py-0.5 rounded">
              <span class="w-1.5 h-1.5 rounded-full bg-primary-container"></span>${running > 0 ? "Running" : "Idle"}
            </span>
          </div>
          <div class="md:hidden flex items-center justify-between gap-3 py-1">
            <div class="font-table text-table text-on-surface-variant">
              <a href="${escapeHtml(activeBuildHref)}" class="font-code text-code text-primary-container hover:underline">${running}</a> active build${running === 1 ? "" : "s"}
            </div>
            <a href="/new" class="rds-action-primary shrink-0">
              ${icon("play_arrow", 14)}<span>Start</span>
            </a>
          </div>
          <div class="hidden md:flex flex-1 flex-col justify-center items-center py-4 text-center">
            <a href="${escapeHtml(activeBuildHref)}" class="text-[30px] leading-9 font-body font-bold tabular-nums text-primary-container hover:underline" title="${runningBuilds.length === 1 ? `Open ${runningBuilds[0].id}` : "View running builds"}">${running}</a>
            <a href="${escapeHtml(activeBuildHref)}" class="font-ribbon text-ribbon text-on-surface-variant hover:text-primary-container mb-4 uppercase tracking-wider">Active Builds</a>
            <a href="/new" class="rds-action-primary w-full">
              ${icon("play_arrow", 18)}<span>New Build</span>
            </a>
          </div>
        </div>

        <!-- PRD Inbox -->
        <div class="rds-hub-card rds-hub-card-compact bg-surface-container panel-border rounded-DEFAULT flex flex-col p-unit">
          <div class="flex justify-between items-center mb-unit border-b border-[#242b28] pb-unit">
            <h2 class="font-h2 text-h2 text-on-surface flex items-center gap-2">
              ${icon("inbox", 16, "text-tertiary")}<span>PRD Inbox</span>
            </h2>
            <span class="font-ribbon text-ribbon text-on-surface-variant">drop a file</span>
          </div>
          <a href="/new" class="md:hidden border border-dashed border-[#242b28] rounded flex items-center justify-between gap-3 p-3 bg-[#101412]/50 hover:bg-[#101412] hover:border-primary-container transition-colors cursor-pointer group">
            <div class="min-w-0">
              <div class="font-body text-body text-on-surface truncate">Drop a PRD markdown file</div>
              <div class="font-table text-table text-on-surface-variant truncate">opens the build composer</div>
            </div>
            ${icon("cloud_upload", 22, "text-on-surface-variant group-hover:text-primary-container transition-colors shrink-0")}
          </a>
          <a href="/new" class="hidden md:flex flex-1 border border-dashed border-[#242b28] rounded flex-col items-center justify-center p-4 bg-[#101412]/50 text-center hover:bg-[#101412] hover:border-primary-container transition-colors cursor-pointer group min-h-[180px]">
            ${icon("cloud_upload", 28, "text-on-surface-variant mb-2 group-hover:text-primary-container transition-colors")}
            <div class="font-body text-body text-on-surface mb-1">Drop a PRD markdown file</div>
            <div class="font-table text-table text-on-surface-variant">opens the build composer</div>
          </a>
        </div>

        <!-- Watchdog -->
        <div class="rds-hub-card rds-hub-card-compact bg-surface-container panel-border rounded-DEFAULT flex flex-col p-unit">
          <div class="flex justify-between items-center mb-unit border-b border-[#242b28] pb-unit">
            <h2 class="font-h2 text-h2 text-on-surface flex items-center gap-2">
              ${icon("monitor_heart", 16, "text-on-surface-variant")}<span>Watchdog</span>
              <span class="relative group inline-flex items-center" tabindex="0">
                ${icon("help", 14, "text-on-surface-variant cursor-help")}
                <span class="hidden group-hover:block group-focus:block absolute left-5 top-1/2 -translate-y-1/2 z-50 w-72 p-2 rounded bg-[#070908] border border-[#242b28] font-body text-body text-on-surface-variant shadow-lg">
                  Background process that watches running builds. If a build hasn't written anything for a while it's flagged as stuck and you get a Telegram alert. Toggle it on for long-running builds; leave it off if you don't need pages.
                </span>
              </span>
            </h2>
            <span id="watchdog-stat" class="${wd.running ? "" : "hidden"}"></span>
            ${wdToggle}
          </div>
          <div class="rds-watchdog-strip">
            <span class="font-ribbon text-ribbon ${wd.running ? "text-primary-container" : "text-on-surface-variant"} flex items-center gap-1">
              ${icon(wd.running ? "shield" : "shield_lock", 14)}<span>${wd.running ? "Protected" : "Idle"}</span>
            </span>
            <span class="font-code text-code text-on-surface-variant">PID ${wd.running && wd.pid ? wd.pid : "—"}</span>
            <span class="font-code text-code ${stuck ? "text-tertiary-container" : "text-on-surface-variant"}">${stuck} stuck</span>
          </div>
        </div>

        <!-- Hosted Services -->
        <div class="rds-hub-card bg-surface-container panel-border rounded-DEFAULT flex flex-col p-unit lg:min-h-[200px]">
          <div class="flex justify-between items-center mb-unit border-b border-[#242b28] pb-unit">
            <h2 class="font-h2 text-h2 text-on-surface flex items-center gap-2">
              ${icon("cloud_done", 16, "text-primary-container")}<span>Zo Hosting</span>
            </h2>
            <a class="font-ribbon text-ribbon text-primary-container hover:underline" href="/builds?hosting=hosted">${hostedBuilds.length} services</a>
          </div>
          <div class="flex-1 overflow-y-auto custom-scrollbar pr-1 space-y-2">
            ${hostedBuilds.length ? hostedBuilds.slice(0, 5).map((b) => `
              <a href="/b/${escapeHtml(b.id)}" class="bg-[#101412] panel-border p-2 rounded flex justify-between items-center gap-2 group hover:bg-[#1b211e] transition-colors">
                <div class="min-w-0">
                  <div class="font-body text-body text-on-surface truncate" title="${escapeHtml(b.id)}">${escapeHtml(b.displayName || compactBuildId(b.id))}</div>
                  <div class="font-table text-table text-on-surface-variant truncate">${escapeHtml(hostingLabel(b))}</div>
                </div>
                <span class="shrink-0">${hostingPill(b)}</span>
              </a>`).join("") : `<div class="text-on-surface-variant font-table text-table italic">No RDS builds are consuming Zo service slots.</div>`}
          </div>
        </div>

        <!-- Needs Review -->
        <div class="rds-hub-card bg-surface-container panel-border rounded-DEFAULT flex flex-col p-unit ${pending.length ? "lg:min-h-[200px]" : "rds-compact-empty"}">
          <div class="flex justify-between items-center mb-unit border-b border-[#242b28] pb-unit">
            <h2 class="font-h2 text-h2 text-on-surface flex items-center gap-2">
              ${icon("pending_actions", 16, "text-error")}<span>Needs Review</span>
            </h2>
            <a class="font-ribbon text-ribbon bg-[#1b211e] text-on-surface-variant px-2 py-0.5 rounded hover:text-on-surface transition-colors" href="/builds?status=pending_review" title="${pendingAll.length === pending.length ? "" : `${pendingAll.length - pending.length} dismissed on this hub`}">${pending.length} Pending</a>
          </div>
          <div class="flex-1 overflow-y-auto custom-scrollbar pr-1 space-y-2 ${pending.length ? "" : "md:min-h-[120px]"}">${pendingItems}</div>
        </div>

        <!-- Recent Builds -->
        <div class="rds-hub-card bg-surface-container panel-border rounded-DEFAULT flex flex-col p-unit lg:min-h-[200px]">
          <div class="flex justify-between items-center mb-unit border-b border-[#242b28] pb-unit">
            <h2 class="font-h2 text-h2 text-on-surface flex items-center gap-2">
              ${icon("history", 16)}<span>Recent Builds</span>
            </h2>
            <a class="font-ribbon text-ribbon text-primary-container hover:underline" href="/builds">View All</a>
          </div>
          <div class="md:hidden flex-1 overflow-y-auto custom-scrollbar pr-1">
            ${recentMobileItems || `<div class="py-2 font-table text-table text-on-surface-variant italic">No builds yet — <a href="/new" class="text-primary-container hover:underline not-italic">start your first build</a>.</div>`}
          </div>
          <div class="hidden md:flex flex-1 flex-col gap-1 overflow-y-auto custom-scrollbar pr-1">
            ${recentRows || `<div class="py-2 px-2 font-table text-table text-on-surface-variant italic">No builds yet — <a href="/new" class="text-primary-container hover:underline not-italic">start your first build</a>.</div>`}
          </div>
        </div>

        <!-- Critical Alerts -->
        <div class="rds-hub-card bg-surface-container panel-border rounded-DEFAULT flex flex-col p-unit ${lastFailed ? "lg:min-h-[200px]" : "rds-compact-empty md:hidden"}">
          <div class="flex justify-between items-center mb-unit border-b border-[#242b28] pb-unit">
            <h2 class="font-h2 text-h2 text-on-surface flex items-center gap-2">
              ${icon("warning", 16, "text-error")}<span>Critical Alerts</span>
            </h2>
            <span class="font-ribbon text-ribbon ${failed ? "bg-error/10 text-error" : "bg-[#1b211e] text-on-surface-variant"} px-2 py-0.5 rounded">${failed} ${failed === 1 ? "Active" : "Active"}</span>
          </div>
          <div class="flex-1 flex flex-col gap-2 ${lastFailed ? "" : "md:min-h-[120px]"}">${criticalCard}</div>
        </div>

        <!-- Live Activity (full width) -->
        <div class="rds-hub-card rds-hub-activity bg-surface-container panel-border rounded-DEFAULT flex flex-col p-unit md:col-span-2 lg:col-span-3 lg:min-h-[280px]">
          <div class="flex justify-between items-center mb-unit border-b border-[#242b28] pb-unit">
            <h2 class="font-h2 text-h2 text-on-surface flex items-center gap-2">
              ${icon("list_alt", 16)}<span>Live Activity</span>
            </h2>
            <div class="flex items-center gap-3">
              <a href="/chat" class="font-ribbon text-ribbon text-on-surface-variant hover:text-on-surface flex items-center gap-1">${icon("chat", 14)}<span>open chat</span></a>
              <a href="/audit" class="font-ribbon text-ribbon text-primary-container hover:underline">audit log ↗</a>
            </div>
          </div>
          <div class="flex-1 max-h-[220px] md:max-h-none overflow-y-auto custom-scrollbar pr-1 leading-tight space-y-1 overscroll-contain">${activityRows}</div>
        </div>
      </div>
    </div>

    <script>
      ${clientScript()}
      async function dismissAlert(id) {
        var res = await fetch('/alerts/dismiss', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-RDS-Token': token() },
          body: JSON.stringify({ build_id: id })
        });
        if (res.ok) { rdsToast('Alert dismissed.', 'info'); setTimeout(function(){ location.reload(); }, 250); }
        else rdsToast('Dismiss failed: ' + res.status, 'error');
      }
      async function dismissReview(id) {
        var res = await fetch('/reviews/dismiss', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-RDS-Token': token() },
          body: JSON.stringify({ build_id: id })
        });
        if (res.ok) { rdsToast('Review dismissed from hub.', 'info'); setTimeout(function(){ location.reload(); }, 250); }
        else rdsToast('Dismiss failed: ' + res.status, 'error');
      }
    </script>
  `, { nav: "hub", topbarTab: "overview" }));
});

app.get("/builds", async (c) => {
  const builds = await listBuilds(200);
  const stacks = stackOptions();
  const wantStatus = c.req.queries("status") || [];
  const wantStack  = c.req.queries("stack")  || [];
  const wantMode   = c.req.query("mode") || "";
  const wantHosting = c.req.query("hosting") || "";
  const q          = (c.req.query("q") || "").toLowerCase();
  const explicitSort = !!c.req.query("sort");
  const sort       = c.req.query("sort") || "last";
  const dir        = sortDir(c.req.query("dir"), sort === "last" || sort === "cost" ? "desc" : "asc");

  const matches = (b: BuildRow) => {
    if (q && !(b.id.toLowerCase().includes(q) || (b.slug ?? "").toLowerCase().includes(q) || (b.displayName ?? "").toLowerCase().includes(q))) return false;
    if (wantStatus.length) {
      const k = statusKind(b);
      if (!wantStatus.includes(k)) return false;
    }
    if (wantStack.length && b.stack && !wantStack.includes(b.stack)) return false;
    if (wantMode && b.mode && b.mode !== wantMode) return false;
    if (wantHosting === "hosted" && !b.hasZoService) return false;
    if (wantHosting === "unhosted" && b.hasZoService) return false;
    if (wantHosting === "local" && !b.localPreviewRunning) return false;
    return true;
  };
  const filtered = builds.filter(matches);
  const sorted = filtered.slice().sort((a, b) => {
    if (!explicitSort) {
      const priority = buildAttentionRank(a) - buildAttentionRank(b);
      if (priority !== 0) return priority;
    }
    const direction = dir === "asc" ? 1 : -1;
    const tagsFor = (row: BuildRow) => [hostingLabel(row), row.stack, row.mode, row.provider].filter(Boolean).join(" ");
    const cmp =
      sort === "slug"   ? compareText(a.displayName ?? a.slug ?? a.id, b.displayName ?? b.slug ?? b.id) :
      sort === "stage"  ? compareText(a.stage, b.stage) :
      sort === "status" ? compareText(statusKind(a), statusKind(b)) :
      sort === "review" ? compareText(a.reviewStatus, b.reviewStatus) :
      sort === "cost"   ? compareNumber(a.costUsd, b.costUsd) :
      sort === "last"   ? compareNumber(a.lastActivityMs, b.lastActivityMs) :
      sort === "tags"   ? compareText(tagsFor(a), tagsFor(b)) :
                           compareNumber(a.lastActivityMs, b.lastActivityMs);
    return cmp === 0 ? compareText(a.id, b.id) : cmp * direction;
  });

  const counts = {
    running: builds.filter((b) => statusKind(b) === "running").length,
    failed:  builds.filter((b) => statusKind(b) === "failed").length,
    stuck:   builds.filter((b) => statusKind(b) === "stuck").length,
    paused:  builds.filter((b) => statusKind(b) === "paused").length,
    done:    builds.filter((b) => statusKind(b) === "done").length,
    hosted:  builds.filter((b) => b.hasZoService).length,
    unhosted: builds.filter((b) => !b.hasZoService).length,
    local:   builds.filter((b) => b.localPreviewRunning).length,
  };

  const rows = sorted.map((b) => {
    const k = statusKind(b);
    const rowBg =
      k === "failed" ? "bg-error/5" :
      k === "stuck"  ? "bg-tertiary-container/5" :
      "";
    const cost = b.costUsd != null ? `$${b.costUsd.toFixed(2)}` : "—";
    const tags = [
      b.stack ? tagPill(b.stack) : "",
      b.mode ? tagPill(b.mode) : "",
      b.provider ? tagPill(b.provider) : "",
    ].filter(Boolean).join("");
    return `<tr class="row-clickable hover:bg-[#1b211e] transition-colors group cursor-pointer ${rowBg}" tabindex="0" aria-label="Open build ${escapeHtml(b.displayName || b.slug || b.id)}" data-href="/b/${escapeHtml(b.id)}" data-search="${escapeHtml((b.id + " " + (b.slug ?? "") + " " + (b.displayName ?? "") + " " + (b.stage ?? "")).toLowerCase())}">
      <td class="py-2.5 px-4">${statusDot(b)}</td>
      <td class="py-2.5 px-4 text-on-surface">
        <div class="flex flex-col gap-0.5 min-w-[200px]">
          <span class="font-body text-body truncate" title="${escapeHtml(b.id)}">${escapeHtml(b.displayName || b.slug || compactBuildId(b.id))}</span>
          <span class="font-code text-[10px] leading-4 text-on-surface-variant truncate">${escapeHtml(b.id)}</span>
        </div>
        <div class="mt-1 flex items-center gap-2 font-ribbon text-ribbon">
          ${hostingPill(b)}
          <span class="text-on-surface-variant">${escapeHtml(hostingLabel(b))}</span>
          ${b.running ? `<button type="button" data-stop="1" onclick="pauseBuild('${escapeHtml(b.id)}')" class="ml-1 inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-tertiary-container/40 bg-tertiary-container/10 text-tertiary-container hover:bg-tertiary-container/20" title="Pause this build and resume later">${icon("pause", 13)}<span>Pause</span></button>` : ""}
          ${b.paused ? `<button type="button" data-stop="1" onclick="resumeBuild('${escapeHtml(b.id)}')" class="ml-1 inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-primary-container/40 bg-primary-container/10 text-primary-container hover:bg-primary-container/20" title="Resume this paused build">${icon("play_arrow", 13)}<span>Resume</span></button>` : ""}
          ${b.hasZoService ? `<button type="button" data-stop="1" onclick="deleteHostedBuild('${escapeHtml(b.id)}')" class="ml-1 inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-error/30 bg-error/10 text-error hover:bg-error/20" title="Delete Zo service and free the slot">${icon("delete", 13)}<span>Delete service</span></button>` : ""}
        </div>
      </td>
      <td class="py-2.5 px-4 text-on-surface whitespace-nowrap">${escapeHtml(b.stage ?? "—")}</td>
      <td class="py-2.5 px-4 whitespace-nowrap">${statusBadge(b)}</td>
      <td class="py-2.5 px-4 whitespace-nowrap hidden xl:table-cell">${reviewBadge(b) || `<span class="text-on-surface-variant">—</span>`}</td>
      <td class="py-2.5 px-4 text-right font-code text-code text-on-surface whitespace-nowrap hidden lg:table-cell">${escapeHtml(cost)}</td>
      <td class="py-2.5 px-4 text-on-surface-variant text-[11px] whitespace-nowrap hidden lg:table-cell">${b.lastActivityMs ? escapeHtml(relativeTime(b.lastActivityMs)) : "—"}</td>
      <td class="py-2.5 px-4 hidden 2xl:table-cell"><div class="flex flex-wrap gap-1">${tags}</div></td>
      <td class="py-2.5 px-4 text-right opacity-0 group-hover:opacity-100 transition-opacity">
        ${b.running ? `<button type="button" data-stop="1" onclick="pauseBuild('${escapeHtml(b.id)}')" class="mr-2 text-tertiary-container hover:text-[#ffd8c2]" title="Pause build" aria-label="Pause build">${icon("pause", 16)}</button>` : ""}
        ${b.paused ? `<button type="button" data-stop="1" onclick="resumeBuild('${escapeHtml(b.id)}')" class="mr-2 text-primary-container hover:text-[#8beebb]" title="Resume build" aria-label="Resume build">${icon("play_arrow", 16)}</button>` : ""}
        ${b.hasZoService ? `<button type="button" data-stop="1" onclick="deleteHostedBuild('${escapeHtml(b.id)}')" class="mr-2 text-error hover:text-[#ffd3cf]" title="Delete Zo service" aria-label="Delete Zo service">${icon("delete", 16)}</button>` : ""}
        <a href="/b/${escapeHtml(b.id)}" data-stop="1" class="text-on-surface-variant hover:text-on-surface" title="Open build" aria-label="Open build">${icon("arrow_forward", 16)}</a>
      </td>
    </tr>`;
  }).join("");

  const mobileCards = sorted.map((b) => {
    const k = statusKind(b);
    const cardBg =
      k === "failed" ? "bg-error/5 border-error/30" :
      k === "stuck"  ? "bg-tertiary-container/5 border-tertiary-container/30" :
      "bg-surface border-outline-variant";
    const cost = b.costUsd != null ? `$${b.costUsd.toFixed(2)}` : "—";
    const title = b.displayName || b.slug || compactBuildId(b.id);
    const meta = [
      b.stack || "rails",
      b.mode || "green",
      b.provider || "claude",
    ].filter(Boolean).join(" · ");
    return `<div onclick="if (!event.target.closest('[data-stop]')) location.href='/b/${escapeHtml(b.id)}'" data-search="${escapeHtml((b.id + " " + (b.slug ?? "") + " " + (b.displayName ?? "") + " " + (b.stage ?? "")).toLowerCase())}" class="rds-build-mobile-card block border ${cardBg} rounded-DEFAULT p-3 cursor-pointer">
      <div class="flex items-start gap-3">
        <div class="pt-1">${statusDot(b)}</div>
        <div class="min-w-0 flex-1">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <div class="rds-mobile-card-title font-body text-[14px] leading-5 text-on-surface" title="${escapeHtml(b.id)}">${escapeHtml(title)}</div>
              <div class="font-code text-[10px] leading-4 text-on-surface-variant truncate">${escapeHtml(compactBuildId(b.id))}</div>
            </div>
            <div class="shrink-0">${statusBadge(b)}</div>
          </div>
          <div class="rds-mobile-build-card-stats mt-2 grid grid-cols-[0.9fr_1.35fr_0.85fr] gap-2 font-table text-table">
            <div>
              <div class="text-outline uppercase text-[10px]">Stage</div>
              <div class="text-on-surface truncate">${escapeHtml(b.stage ?? "—")}</div>
            </div>
            <div>
              <div class="text-outline uppercase text-[10px]">Review</div>
              <div class="rds-mobile-review-cell truncate">${reviewBadge(b) || `<span class="text-on-surface-variant">—</span>`}</div>
            </div>
            <div>
              <div class="text-outline uppercase text-[10px]">Cost</div>
              <div class="font-code text-code text-on-surface truncate">${escapeHtml(cost)}</div>
            </div>
          </div>
          <div class="mt-2 flex items-center gap-2 font-ribbon text-ribbon text-on-surface-variant">
            <span class="rds-mobile-card-meta truncate">${escapeHtml(meta)}</span>
            <span class="shrink-0">${b.lastActivityMs ? escapeHtml(relativeTime(b.lastActivityMs)) : "—"}</span>
          </div>
          <div class="mt-2 flex items-center gap-2">
            ${b.hasZoService ? `<span class="inline-flex">${hostingPill(b)}</span>` : ""}
            <a data-stop="1" href="/b/${escapeHtml(b.id)}" class="ml-auto px-2 py-1 border border-outline-variant bg-surface-container text-on-surface rounded font-ribbon text-ribbon">Open</a>
            ${b.running ? `<button data-stop="1" type="button" onclick="pauseBuild('${escapeHtml(b.id)}')" class="px-2 py-1 border border-tertiary-container/40 bg-tertiary-container/10 text-tertiary-container rounded font-ribbon text-ribbon">${icon("pause", 13)} Pause</button>` : ""}
            ${b.paused ? `<button data-stop="1" type="button" onclick="resumeBuild('${escapeHtml(b.id)}')" class="px-2 py-1 border border-primary-container/40 bg-primary-container/10 text-primary-container rounded font-ribbon text-ribbon">${icon("play_arrow", 13)} Resume</button>` : ""}
            ${b.hasZoService ? `<details data-stop="1" class="relative"><summary class="list-none px-2 py-1 border border-outline-variant bg-surface-container text-on-surface rounded font-ribbon text-ribbon cursor-pointer">More</summary><div class="absolute right-0 mt-1 z-20 bg-surface border border-outline-variant rounded shadow-lg p-1 w-40"><button type="button" onclick="deleteHostedBuild('${escapeHtml(b.id)}')" class="w-full px-2 py-1.5 text-left text-error hover:bg-error/10 rounded font-ribbon text-ribbon">${icon("delete", 13)}<span> Delete service</span></button></div></details>` : ""}
          </div>
        </div>
      </div>
    </div>`;
  }).join("");

  const activeFilterCount = wantStatus.length + wantStack.length + (wantMode ? 1 : 0) + (wantHosting ? 1 : 0) + (q ? 1 : 0);
  // Toggle URL for a status chip: preserves every other query param.
  const toggleStatusUrl = (k: string) => {
    const url = new URL(c.req.url);
    const cur = url.searchParams.getAll("status");
    url.searchParams.delete("status");
    for (const v of cur.filter((sv) => sv !== k)) url.searchParams.append("status", v);
    if (!cur.includes(k)) url.searchParams.append("status", k);
    const qs = url.searchParams.toString();
    return url.pathname + (qs ? "?" + qs : "");
  };
  const chip = (k: string, label: string, n: number) => {
    const active = wantStatus.includes(k);
    const tone = active
      ? "bg-primary-container/15 border-primary-container/50 text-primary-container"
      : "bg-surface-container-low border-outline-variant text-on-surface-variant hover:text-on-surface hover:border-outline";
    return `<a href="${escapeHtml(toggleStatusUrl(k))}" role="checkbox" aria-checked="${active ? "true" : "false"}" class="inline-flex items-center gap-1.5 px-2.5 h-8 rounded-full border font-ribbon text-ribbon whitespace-nowrap transition-colors ${tone}">${escapeHtml(label)}<span class="${active ? "text-primary-container/80" : "text-outline"} font-code text-[10px]">${n}</span></a>`;
  };
  const selectCls = "h-8 bg-surface-container-low border border-outline-variant rounded px-2 text-[12.5px] text-on-surface focus:border-primary-container focus:ring-0 focus:outline-none";
  const emptyLine = builds.length
    ? `No builds match these filters — <a href="/builds" class="text-primary-container hover:underline not-italic">clear them</a>.`
    : `No builds yet — <a href="/new" class="text-primary-container hover:underline not-italic">start your first build</a>.`;

  return c.html(layout("Builds", `
    <div class="max-w-[1560px] mx-auto flex flex-col gap-gutter">
      <div class="rds-page-header">
        <div>
          <div class="rds-page-eyebrow">Build inventory</div>
          <h1 class="rds-page-title">Builds <span class="rds-build-count font-ribbon text-ribbon text-on-surface-variant ml-1">${filtered.length} of ${builds.length}</span></h1>
          <p class="rds-page-copy">Evidence-backed app runs, previews, review state, and operator actions.</p>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          <button type="button" onclick="refreshBuilds()" class="rds-action-secondary !min-h-[34px] !py-1 !px-3">${icon("refresh", 14)}<span class="hidden sm:inline">Refresh</span></button>
          <a href="/new" class="rds-new-build-button rds-action-primary !min-h-[34px] !py-1 !px-3">${icon("add", 16)}<span>New Build</span></a>
        </div>
      </div>

      <form method="get" action="/builds" class="rds-builds-filterbar flex flex-wrap items-center gap-2">
        ${wantStatus.map((v) => `<input type="hidden" name="status" value="${escapeHtml(v)}">`).join("")}
        ${explicitSort ? `<input type="hidden" name="sort" value="${escapeHtml(sort)}"><input type="hidden" name="dir" value="${escapeHtml(dir)}">` : ""}
        <div class="relative flex-1 min-w-[200px] max-w-[340px]">
          ${icon("search", 15, "absolute left-2.5 top-1/2 -translate-y-1/2 text-outline pointer-events-none")}
          <input name="q" value="${escapeHtml(q)}" oninput="rdsSearch(event)" class="w-full h-8 bg-surface-container-low border border-outline-variant rounded pl-8 pr-3 text-[12.5px] text-on-surface placeholder-outline focus:border-primary-container focus:ring-0 focus:outline-none" placeholder="Filter by name, slug, or id" type="text" aria-label="Filter builds">
        </div>
        <div class="flex items-center gap-1.5 flex-wrap">
          ${chip("running", "Running", counts.running)}
          ${chip("failed", "Failed", counts.failed)}
          ${chip("stuck", "Stuck", counts.stuck)}
          ${chip("paused", "Paused", counts.paused)}
          ${chip("done", "Done", counts.done)}
        </div>
        <span class="hidden xl:inline-block w-px h-5 bg-outline-variant" aria-hidden="true"></span>
        <select name="stack" onchange="this.form.submit()" class="${selectCls}" aria-label="Filter by stack">
          <option value="">All stacks</option>
          ${stacks.map((st) => `<option value="${escapeHtml(st.id)}" ${wantStack.includes(st.id) ? "selected" : ""}>${escapeHtml(st.name)}</option>`).join("")}
        </select>
        <select name="mode" onchange="this.form.submit()" class="${selectCls}" aria-label="Filter by mode">
          <option value="">Green + brown</option>
          <option value="green" ${wantMode === "green" ? "selected" : ""}>Greenfield</option>
          <option value="brown" ${wantMode === "brown" ? "selected" : ""}>Brownfield</option>
        </select>
        <select name="hosting" onchange="this.form.submit()" class="${selectCls}" aria-label="Filter by hosting">
          <option value="">Any hosting</option>
          <option value="hosted" ${wantHosting === "hosted" ? "selected" : ""}>Hosted on Zo (${counts.hosted})</option>
          <option value="unhosted" ${wantHosting === "unhosted" ? "selected" : ""}>Not hosted (${counts.unhosted})</option>
          <option value="local" ${wantHosting === "local" ? "selected" : ""}>Local preview (${counts.local})</option>
        </select>
        <button type="submit" class="sr-only">Apply filters</button>
        ${activeFilterCount ? `<a href="/builds" class="font-ribbon text-ribbon text-on-surface-variant hover:text-on-surface whitespace-nowrap">Clear filters (${activeFilterCount})</a>` : ""}
      </form>

      <div class="lg:hidden space-y-3">
        ${mobileCards || `<div class="py-6 px-1 text-on-surface-variant italic font-table text-table">${emptyLine}</div>`}
      </div>
      <section class="hidden lg:block bg-surface border border-outline-variant rounded-DEFAULT overflow-hidden">
        <div class="rds-scroll-table">
        <table class="rds-desktop-table w-full text-left border-collapse">
          <thead class="sticky top-0 bg-[#101412] z-20 border-b border-[#242b28]">
            <tr class="font-ribbon text-ribbon text-on-surface-variant whitespace-nowrap">
              <th class="py-2 px-4 font-medium w-8"></th>
              <th class="py-2 px-4 font-medium">${sortableHeader(c.req.url, "slug", "Build", sort, dir)}</th>
              <th class="py-2 px-4 font-medium">${sortableHeader(c.req.url, "stage", "Stage", sort, dir)}</th>
              <th class="py-2 px-4 font-medium">${sortableHeader(c.req.url, "status", "Status", sort, dir)}</th>
              <th class="py-2 px-4 font-medium hidden xl:table-cell">${sortableHeader(c.req.url, "review", "Review", sort, dir)}</th>
              <th class="py-2 px-4 font-medium text-right hidden lg:table-cell">${sortableHeader(c.req.url, "cost", "Cost", sort, dir, "justify-end")}</th>
              <th class="py-2 px-4 font-medium hidden lg:table-cell">${sortableHeader(c.req.url, "last", "Last activity", sort, dir)}</th>
              <th class="py-2 px-4 font-medium hidden 2xl:table-cell">${sortableHeader(c.req.url, "tags", "Tags", sort, dir)}</th>
              <th class="py-2 px-4 font-medium w-8"></th>
            </tr>
          </thead>
          <tbody class="font-table text-table divide-y divide-outline-variant/30">
            ${rows || `<tr><td colspan="9" class="py-6 px-4 text-on-surface-variant italic font-table text-table">${emptyLine}</td></tr>`}
          </tbody>
        </table>
        </div>
      </section>
    </div>
    <script>
      ${clientScript()}
      async function refreshBuilds() {
        var ok = await rdsConfirm('Refresh the build index from RDS builds/ and Projects/? This reconciles metadata and reloads the Builds page.', {
          title: 'Refresh builds?', okLabel: 'Refresh'
        });
        if (!ok) return;
        var res = await fetch('/builds/refresh', { method: 'POST', headers: { 'X-RDS-Token': token() } });
        var data = await res.json().catch(function(){ return {}; });
        if (res.ok) {
          rdsToast('Refreshed ' + (data.builds || 0) + ' builds.', 'info');
          setTimeout(function(){ location.reload(); }, 500);
        } else {
          rdsToast('Refresh failed: ' + (data.error || res.status), 'error');
        }
      }
      async function deleteHostedBuild(id) {
        var ok = await rdsConfirm('Delete the hosted Zo service for build "' + id + '"? This frees the Zo service slot. Project files remain, and the build can be redeployed later.', {
          title: 'Delete Zo service?', danger: true, okLabel: 'Delete service'
        });
        if (!ok) return;
        var res = await fetch('/b/' + encodeURIComponent(id) + '/service/deregister', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-RDS-Token': token() }
        });
        var text = await res.text();
        if (res.ok) {
          rdsToast('Zo service deleted for ' + id + '.', 'info');
          setTimeout(function(){ location.reload(); }, 700);
        } else {
          rdsToast('Delete failed: ' + res.status + ' ' + text.slice(0, 160), 'error');
        }
      }
      async function pauseBuild(id) {
        var ok = await rdsConfirm('Pause build "' + id + '"? The active runner will stop and RDS will keep the current stage ready to resume later.', {
          title: 'Pause build?', warn: true, okLabel: 'Pause build'
        });
        if (!ok) return;
        var res = await fetch('/b/' + encodeURIComponent(id) + '/cmd', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-RDS-Token': token() },
          body: JSON.stringify({ verb: 'pause' })
        });
        var text = await res.text();
        if (res.ok) {
          rdsToast('Paused ' + id + '.', 'info');
          setTimeout(function(){ location.reload(); }, 700);
        } else {
          rdsToast('Pause failed: ' + res.status + ' ' + text.slice(0, 160), 'error');
        }
      }
      async function resumeBuild(id) {
        var ok = await rdsConfirm('Resume paused build "' + id + '"? RDS will continue from the paused stage in the background.', {
          title: 'Resume build?', okLabel: 'Resume build'
        });
        if (!ok) return;
        var res = await fetch('/b/' + encodeURIComponent(id) + '/cmd', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-RDS-Token': token() },
          body: JSON.stringify({ verb: 'resume' })
        });
        var text = await res.text();
        if (res.ok) {
          rdsToast('Resumed ' + id + '.', 'info');
          setTimeout(function(){ location.reload(); }, 700);
        } else {
          rdsToast('Resume failed: ' + res.status + ' ' + text.slice(0, 160), 'error');
        }
      }
      window.deleteHostedBuild = deleteHostedBuild;
      window.pauseBuild = pauseBuild;
      window.resumeBuild = resumeBuild;
    </script>
  `, { nav: "builds", topbarTab: "builds" }));
});

app.post("/builds/refresh", async (c) => {
  const denied = tokenGate(c);
  if (denied) {
    appendAudit({ route: "POST /builds/refresh", outcome: "denied", status: denied.status, ip: callerIp(c), ua: callerUa(c) });
    return denied;
  }
  appendAudit({ route: "POST /builds/refresh", outcome: "ok", ip: callerIp(c), ua: callerUa(c) });

  const buildIds = existsSync(BUILDS_DIR)
    ? readdirSync(BUILDS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
    : [];
  const projectDirs = existsSync(DEFAULT_PROJECTS_DIR)
    ? readdirSync(DEFAULT_PROJECTS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(DEFAULT_PROJECTS_DIR, e.name))
    : [];

  let updated = 0;
  for (const id of buildIds) {
    const dir = join(BUILDS_DIR, id);
    const statePath = join(dir, "state.json");
    const state = safeReadJson<Record<string, unknown>>(statePath);
    if (!state) continue;
    let changed = false;
    const previewPath = join(dir, "preview-url.txt");
    if (existsSync(previewPath)) {
      const preview = readFileSync(previewPath, "utf8").trim();
      if (preview && state.preview_url !== preview) {
        state.preview_url = preview;
        changed = true;
      }
    }
    if (!state.app_dest) {
      const slug = String(state.slug || id).replace(/-\d{8}-\d{6}$/, "");
      const match = projectDirs.find((p) => basename(p) === slug || id.startsWith(basename(p)));
      if (match) {
        state.app_dest = match;
        changed = true;
      }
    }
    const name = computeBuildDisplayName(id, state as StateJson);
    if (name && state.display_name !== name) {
      state.display_name = name;
      changed = true;
    }
    if (changed) {
      state.updated_at = new Date().toISOString();
      writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
      updated++;
    }
  }

  writeFileSync(join(DASHBOARD_STATE_DIR, "last-refresh.json"), JSON.stringify({
    refreshed_at: new Date().toISOString(),
    builds: buildIds.length,
    projects: projectDirs.length,
    updated,
  }, null, 2) + "\n");
  return c.json({ ok: true, builds: buildIds.length, projects: projectDirs.length, updated });
});

app.get("/new", (c) => {
  const settings = readSettings();
  const stacks = stackOptions().filter((stack) => stack.status === "ready" && NEW_BUILD_STACK_ORDER.includes(stack.id));
  const skills = skillOptions();
  const defaultSkills = NEW_BUILD_CORE_SKILLS
    .map((slug) => skills.find((skill) => skill.slug === slug))
    .filter((skill): skill is SkillOption => !!skill);
  const extraSkills = skills.filter((skill) => !NEW_BUILD_CORE_SKILLS.includes(skill.slug));
  const stackData = stacks.map((stack) => ({
    id: stack.id,
    label: stack.label,
    shortLabel: stack.shortLabel,
    subtitle: stack.subtitle,
    bestFor: stack.bestFor,
    category: stack.category || "",
    mockup: stack.mockup || "",
  }));
  const skillData = skills.map((skill) => ({
    slug: skill.slug,
    name: skill.name,
    status: skill.status,
    appliesTo: skill.appliesTo,
    default: skill.default,
    description: skill.description || "",
    category: skill.category || "",
    readiness: skillReadinessLabel(skill),
  }));
  return c.html(layout("New Build", `
    <div class="max-w-[1100px] mx-auto">
      <div class="rds-page-header">
        <div>
          <div class="rds-page-eyebrow">Intake</div>
          <h1 class="rds-page-title">New Build</h1>
          <p class="rds-page-copy">Start with source. RDS analyzes the PRD, explains the stack and skills it wants, then you approve or override before the build begins.</p>
        </div>
        <div class="flex items-center gap-3 flex-wrap">
          <a href="/settings/stacks" class="font-ribbon text-ribbon text-on-surface-variant hover:text-on-surface whitespace-nowrap">Stack guide</a>
          <a href="/settings/skills" class="font-ribbon text-ribbon text-on-surface-variant hover:text-on-surface whitespace-nowrap">Skills guide</a>
          <a href="/builds" class="font-ribbon text-ribbon text-on-surface-variant hover:text-on-surface whitespace-nowrap">← back to builds</a>
        </div>
      </div>

      <div class="rds-shell-panel rounded-DEFAULT p-unit">
        <form id="new-build" onsubmit="return submitNewBuild(event)" class="space-y-4 font-body text-body">

          <section class="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_340px] gap-3 items-stretch">
            <div id="prompt-drop" class="relative border-2 border-dashed border-[#2f3a34] rounded transition-colors bg-[#101412]/50 hover:border-primary-container hover:bg-[#101412]/80">
              <input id="prompt-file" name="attachments" type="file" accept=".md,.markdown,.txt,.pdf,.png,.jpg,.jpeg,.webp,.gif,.zip,.html,.htm,.css,.js,.jsx,.ts,.tsx,.json,.svg,.csv,.xml,.yml,.yaml,.fig,.sketch,.webm,.mp4,.mov,text/markdown,text/plain,application/pdf,image/png,image/jpeg,image/webp,image/gif,application/zip" multiple hidden>
              <input id="prompt-folder" name="attachments" type="file" webkitdirectory directory multiple hidden>
              <div class="flex items-center justify-between px-3 pt-3 pb-1 gap-2">
                <span class="font-ribbon text-ribbon text-on-surface-variant uppercase tracking-wide">Source brief</span>
                <button type="button" onclick="document.getElementById('prompt-file').click()" class="rds-action-secondary !min-h-[30px] !py-1 !px-2">
                  ${icon("upload_file", 14)}<span id="prompt-drop-meta">Attach</span>
                </button>
              </div>
              <textarea name="trigger" id="trigger-textarea" rows="10"
                placeholder="Paste the PRD, a short build brief, a Notion URL, or an inbox/foo.md path. Attach .md/.txt to import text into this box; PDFs/images are sent with the build."
                oninput="rdsMarkPlanStale(this.form)"
                class="w-full bg-transparent border-0 rounded-b p-3 text-on-surface font-code text-[13px] focus:ring-0 focus:outline-none placeholder-[#7d8781] resize-none"></textarea>
              <div id="prompt-attachments" class="hidden border-t border-[#242b28] px-3 py-2 flex flex-wrap gap-2"></div>
              <div id="prompt-ingest-note" class="hidden border-t border-[#242b28] px-3 py-2 font-table text-table text-on-surface-variant"></div>
            </div>

            <aside class="bg-[#101412] panel-border rounded p-3 flex flex-col gap-3">
              <div>
                <div class="font-ribbon text-ribbon text-on-surface-variant uppercase tracking-wide">RDS plan</div>
                <div id="rds-rec-stack" class="font-h2 text-h2 text-on-surface mt-1">Waiting for PRD</div>
                <p id="rds-rec-reason" class="font-table text-table text-on-surface-variant mt-1">Paste a PRD, brief, URL, or local path. RDS will classify the build before you commit.</p>
              </div>
              <div id="rds-rec-confidence" class="font-code text-[11px] text-on-surface-variant border border-outline-variant rounded px-2 py-1">No recommendation yet</div>
              <div class="grid grid-cols-2 gap-2">
                <label class="block">
                  <span class="block font-ribbon text-ribbon text-on-surface-variant uppercase tracking-wide mb-1">App type</span>
                  <select name="app_type" onchange="rdsMarkPlanStale(this.form)" class="w-full bg-[#070908] border border-outline-variant rounded h-9 px-2 text-on-surface font-code text-[12.5px] focus:border-primary-container focus:ring-0 focus:outline-none">
                    <option value="auto">auto</option>
                    <option value="game">game</option>
                    <option value="web-app">web app</option>
                    <option value="website">website</option>
                    <option value="dashboard">dashboard</option>
                    <option value="internal-tool">internal tool</option>
                    <option value="prototype">prototype</option>
                    <option value="hack">hack</option>
                  </select>
                  <span class="block font-table text-table text-on-surface-variant mt-1">Taste/QA lens, not runtime. <a href="/settings/stacks#build-types" class="text-primary-container hover:underline">See types</a></span>
                </label>
                <label class="block">
                  <span class="block font-ribbon text-ribbon text-on-surface-variant uppercase tracking-wide mb-1">Mode</span>
                  <select name="mode" class="w-full bg-[#070908] border border-outline-variant rounded h-9 px-2 text-on-surface font-code text-[12.5px] focus:border-primary-container focus:ring-0 focus:outline-none">
                    <option value="green">green</option>
                    <option value="brown">brown</option>
                  </select>
                </label>
              </div>
              <div>
                <div class="font-ribbon text-ribbon text-on-surface-variant uppercase tracking-wide mb-1">Questions before build</div>
                <ul id="rds-rec-questions" class="font-table text-table text-on-surface-variant list-disc pl-4 space-y-1">
                  <li>Paste the PRD first so RDS can ask useful questions.</li>
                </ul>
              </div>
              <div>
                <div class="font-ribbon text-ribbon text-on-surface-variant uppercase tracking-wide mb-1">Recommended skills</div>
                <div id="rds-rec-skill-list" class="flex flex-wrap gap-1"></div>
              </div>
              <div id="rds-analysis-status" class="rounded border border-outline-variant bg-[#070908] px-2 py-2 font-table text-[12px] leading-5 text-on-surface-variant">
                Analysis has not run for this source.
              </div>
              <div class="grid grid-cols-2 gap-2 rds-new-actions">
                <button id="rds-analyze-button" type="button" onclick="rdsAnalyzeBuildInputRemote(document.getElementById('new-build'), false, true)" class="rds-action-secondary">
                  <span id="rds-analyze-label">Analyze source</span>
                </button>
                <button id="rds-use-plan-button" type="button" onclick="rdsApplyRecommendation(document.getElementById('new-build'))" disabled title="Run Analyze source first — RDS applies the recommended stack and skills." class="rds-action-primary disabled:opacity-40 disabled:cursor-not-allowed">
                  Apply plan
                </button>
              </div>
            </aside>
          </section>

          <section class="space-y-2">
            <div class="flex items-end justify-between gap-3 flex-wrap">
              <div>
                <h2 class="font-h2 text-h2 text-on-surface">Build type</h2>
                <p class="font-table text-table text-on-surface-variant">This is the runtime stack. Apply the recommendation, or choose manually when you already know the right tool.</p>
              </div>
              <a href="/settings/stacks" class="font-ribbon text-ribbon text-primary-container hover:underline">Compare stacks</a>
            </div>
            <label class="rds-stack-mobile-select block md:hidden">
              <span class="block font-ribbon text-ribbon text-on-surface-variant uppercase tracking-wide mb-1">Build type</span>
              <select name="stack_mobile" onchange="rdsSyncStackChoice(this.form, this.value)" class="w-full bg-[#101412] border border-outline-variant rounded h-11 px-3 text-on-surface font-body text-body focus:border-primary-container focus:ring-0 focus:outline-none">
                <option value="" selected>Analyze source first, or choose manually</option>
                ${stacks.map((s) => `<option value="${escapeHtml(s.id)}" ${s.status !== "ready" ? "disabled" : ""}>${escapeHtml(s.shortLabel)} — ${escapeHtml(s.subtitle)}</option>`).join("")}
              </select>
              <p id="stack-mobile-help" class="font-table text-table text-on-surface-variant mt-2">No build type selected yet.</p>
            </label>
            <div class="rds-stack-grid hidden md:grid grid-cols-1 md:grid-cols-3 gap-2">
              ${stacks.map((s) => `
                <label class="rds-stack-card block bg-[#101412] border ${s.status === "ready" ? "border-outline-variant hover:border-primary-container" : "border-[#242b28] opacity-60"} rounded p-3 cursor-pointer">
                  <div class="flex items-start gap-3">
                    <input type="radio" name="stack" value="${escapeHtml(s.id)}" data-stack-help="${escapeHtml(s.bestFor)}" ${s.status !== "ready" ? "disabled" : ""} onchange="rdsSyncStackChoice(this.form, this.value)" class="rds-stack-radio mt-1 accent-[#6ad7a3]">
                    <div class="min-w-0">
                      <div class="font-h2 text-h2 text-on-surface">${escapeHtml(s.label)}</div>
                      <div class="font-table text-table text-on-surface-variant">${escapeHtml(s.subtitle)}</div>
                      <div class="flex flex-wrap gap-1 my-1">
                        <span class="font-code text-[10px] border border-outline-variant rounded px-1.5 py-0.5 text-on-surface-variant">${escapeHtml(s.id)}</span>
                        ${s.category ? `<span class="font-code text-[10px] border border-outline-variant rounded px-1.5 py-0.5 text-on-surface-variant">${escapeHtml(s.category)}</span>` : ""}
                      </div>
                      <p class="font-table text-table text-on-surface-variant line-clamp-3">${escapeHtml(s.bestFor || s.description || s.notes || "")}</p>
                      <a href="/settings?tab=reference" onclick="event.stopPropagation()" class="inline-flex mt-2 font-ribbon text-ribbon text-primary-container hover:underline">Stack guide</a>
                      ${s.status !== "ready" ? `<div class="mt-2 font-ribbon text-ribbon text-error">not enabled: ${escapeHtml(s.status)}</div>` : ""}
                    </div>
                  </div>
                </label>
              `).join("")}
            </div>
          </section>

          <section class="space-y-2">
            <div class="flex items-end justify-between gap-3 flex-wrap">
              <div>
                <h2 class="font-h2 text-h2 text-on-surface">Skills</h2>
                <p class="font-table text-table text-on-surface-variant">Skills are optional capability packs from the RDS catalog: context mounts, verifiers, deploy helpers, auth/storage recipes, and stack-specific setup notes.</p>
              </div>
              <div class="flex items-center gap-3">
                <a href="/settings/skills" class="font-ribbon text-ribbon text-primary-container hover:underline">What are skills?</a>
                <button type="button" onclick="rdsResetSkills(document.getElementById('new-build'))" class="font-ribbon text-ribbon text-on-surface-variant hover:text-on-surface">reset to recommended</button>
              </div>
            </div>
            <div class="bg-[#101412] panel-border rounded p-3">
              <div class="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_220px] gap-2 mb-3">
                <div class="bg-[#070908] border border-outline-variant rounded p-2">
                  <div class="font-ribbon text-ribbon text-on-surface-variant uppercase tracking-wide">How to read this</div>
                  <p class="font-table text-table text-on-surface-variant mt-1">RDS shows core safety skills first, then stack-compatible skills after analysis or manual stack selection.</p>
                </div>
                <input id="skill-picker-search" type="search" placeholder="Filter visible skills..." oninput="rdsFilterSkillPicker(document.getElementById('new-build'))" class="bg-[#070908] border border-outline-variant rounded px-3 py-2 font-body text-body text-on-surface focus:border-primary-container focus:outline-none">
              </div>
              <div id="rds-recommended-skills" class="rds-skill-picker flex flex-wrap gap-2">
                ${defaultSkills.map((skill) => `
                  <label title="${escapeHtml(skill.description || "")}" data-skill-label data-skill-slug="${escapeHtml(skill.slug)}" data-skill-status="${escapeHtml(skill.status)}" data-skill-applies="${escapeHtml(skill.appliesTo.join(","))}" class="inline-flex items-center gap-2 border border-primary-container/70 bg-primary-container/10 rounded px-2 py-1 font-ribbon text-ribbon text-on-surface hover:border-primary-container">
                    <input type="checkbox" name="skill" value="${escapeHtml(skill.slug)}" checked class="accent-[#6ad7a3]">
                    <span>${escapeHtml(skill.name)}</span>
                    <span class="font-code text-[10px] text-outline">${escapeHtml(skillReadinessLabel(skill))}</span>
                    <a href="/settings/skills#skill-${escapeHtml(skill.slug)}" onclick="event.stopPropagation()" class="text-primary-container hover:underline">info</a>
                    <a href="/settings?tab=catalog" onclick="event.stopPropagation()" class="ml-2 text-primary-container hover:underline">guide</a>
                  </label>
                `).join("")}
              </div>
              <details class="mt-3">
                <summary class="cursor-pointer font-ribbon text-ribbon text-on-surface-variant">Add stack-compatible skills</summary>
                <div class="rds-skill-picker flex flex-wrap gap-2 max-h-[210px] overflow-y-auto pr-1 mt-2">
                  ${extraSkills.map((skill) => `
                    <label title="${escapeHtml(skill.description || "")}" data-skill-label data-skill-slug="${escapeHtml(skill.slug)}" data-skill-status="${escapeHtml(skill.status)}" data-skill-applies="${escapeHtml(skill.appliesTo.join(","))}" class="inline-flex items-center gap-2 border border-outline-variant rounded px-2 py-1 font-ribbon text-ribbon text-on-surface-variant hover:border-primary-container">
                      <input type="checkbox" name="skill" value="${escapeHtml(skill.slug)}" class="accent-[#6ad7a3]">
                      <span>${escapeHtml(skill.name)}</span>
                      <span class="font-code text-[10px] text-outline">${escapeHtml(skillReadinessLabel(skill))}</span>
                      <a href="/settings/skills#skill-${escapeHtml(skill.slug)}" onclick="event.stopPropagation()" class="text-primary-container hover:underline">info</a>
                      <a href="/settings?tab=catalog" onclick="event.stopPropagation()" class="ml-2 text-primary-container hover:underline">guide</a>
                    </label>
                  `).join("")}
                </div>
              </details>
              <input type="hidden" name="skills" value="default">
              <p id="rds-skill-help" class="font-table text-table text-on-surface-variant mt-2">Ready defaults can run through RDS today. Curated skills are researched capability guidance with source links in the catalog.</p>
            </div>
          </section>

          <section class="space-y-2">
            <h2 class="font-h2 text-h2 text-on-surface">Launch target</h2>
            <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
            <label class="block">
              <span class="block font-ribbon text-ribbon text-on-surface-variant uppercase tracking-wide mb-1">Deploy</span>
              <select name="deploy_target" class="w-full bg-[#101412] border border-outline-variant rounded h-9 px-2 text-on-surface font-code text-[12.5px] focus:border-primary-container focus:ring-0 focus:outline-none">
                <option value="zo">zo</option>
                <option value="none">none</option>
              </select>
            </label>
          </div>
          </section>

          <div class="grid grid-cols-1 md:grid-cols-3 gap-3 bg-[#101412] panel-border rounded p-2">
            <label class="block">
              <span class="block font-ribbon text-ribbon text-on-surface-variant uppercase tracking-wide mb-1">Builder</span>
              <select name="provider" onchange="rdsSyncProviderFields(this.form)" class="w-full bg-[#070908] border border-outline-variant rounded h-9 px-2 text-on-surface font-code text-[12.5px] focus:border-primary-container focus:ring-0 focus:outline-none">
                <option value="claude" ${settings.inferenceProvider === "claude" ? "selected" : ""}>Claude Code</option>
                <option value="codex" ${settings.inferenceProvider === "codex" ? "selected" : ""}>Codex</option>
              </select>
              <span id="provider-help" class="block font-table text-table text-on-surface-variant mt-1">Claude is the V1 default. Codex is available for compatibility tests and focused code edits.</span>
            </label>
            <label class="block" data-provider-field="claude">
              <span class="block font-ribbon text-ribbon text-on-surface-variant uppercase tracking-wide mb-1">Claude model</span>
              <select name="claude_model" class="w-full bg-[#070908] border border-outline-variant rounded h-9 px-2 text-on-surface font-code text-[12.5px] focus:border-primary-container focus:ring-0 focus:outline-none">
                ${CLAUDE_MODELS.map((m) => `<option value="${escapeHtml(m)}" ${settings.claudeModel === m ? "selected" : ""}>${escapeHtml(m)}</option>`).join("")}
              </select>
            </label>
            <label class="block" data-provider-field="codex">
              <span class="block font-ribbon text-ribbon text-on-surface-variant uppercase tracking-wide mb-1">Codex model</span>
              <input name="codex_model" list="codex-model-suggestions-new" value="${escapeHtml(settings.codexModel)}" placeholder="blank = Codex config default" class="w-full bg-[#070908] border border-outline-variant rounded h-9 px-2 text-on-surface font-code text-[12.5px] focus:border-primary-container focus:ring-0 focus:outline-none" />
              <datalist id="codex-model-suggestions-new">
                ${CODEX_MODEL_SUGGESTIONS.map((m) => `<option value="${escapeHtml(m)}"></option>`).join("")}
              </datalist>
            </label>
          </div>

          <details class="bg-[#101412] panel-border rounded p-2">
            <summary class="cursor-pointer font-ribbon text-ribbon text-on-surface-variant">Advanced</summary>
            <div class="space-y-3 mt-3">
              <label class="block">
                <span class="block font-ribbon text-ribbon text-on-surface-variant uppercase tracking-wide mb-1">App destination</span>
                <input name="app_dest" id="app-dest" placeholder="auto: ${escapeHtml(DEFAULT_PROJECTS_DIR)}/&lt;slug&gt;"
                  class="w-full bg-[#070908] border border-outline-variant rounded h-9 px-2 text-on-surface font-code text-[12.5px] focus:border-primary-container focus:ring-0 focus:outline-none placeholder-[#7d8781]">
                <span class="block font-table text-table text-on-surface-variant mt-1">Leave blank to default into <code class="text-primary-container">${escapeHtml(DEFAULT_PROJECTS_DIR)}/&lt;slug&gt;</code>.</span>
              </label>
              <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
                <label class="block md:col-span-2"><span class="block font-ribbon text-ribbon text-on-surface-variant uppercase tracking-wide mb-1">Brown-field repo URL</span><input name="repo" placeholder="git@github.com:acme/foo.git" class="w-full bg-[#070908] border border-outline-variant rounded h-9 px-2 text-on-surface font-code text-[12.5px] focus:border-primary-container focus:ring-0 focus:outline-none placeholder-[#7d8781]"></label>
                <label class="block"><span class="block font-ribbon text-ribbon text-on-surface-variant uppercase tracking-wide mb-1">Branch</span><input name="branch" placeholder="main" class="w-full bg-[#070908] border border-outline-variant rounded h-9 px-2 text-on-surface font-code text-[12.5px] focus:border-primary-container focus:ring-0 focus:outline-none placeholder-[#7d8781]"></label>
              </div>
              <label class="block">
                <span class="block font-ribbon text-ribbon text-on-surface-variant uppercase tracking-wide mb-1">Brown-field PRD source</span>
                <input name="prd" placeholder="https://notion.so/... or inbox/prd.md" class="w-full bg-[#070908] border border-outline-variant rounded h-9 px-2 text-on-surface font-code text-[12.5px] focus:border-primary-container focus:ring-0 focus:outline-none placeholder-[#7d8781]">
              </label>
            </div>
          </details>

          <input id="rds-token" type="hidden" autocomplete="off">

          <div class="flex items-center gap-3 pt-2">
            <button id="rds-start-build-button" type="submit" disabled class="rds-action-primary !px-6 disabled:opacity-40 disabled:cursor-not-allowed">${icon("play_arrow", 16)}<span>Start build</span></button>
            <a href="/builds" class="font-ribbon text-ribbon text-on-surface-variant hover:text-on-surface">cancel</a>
          </div>
          <pre id="new-build-result" class="bg-[#101412] panel-border rounded p-2 font-code text-[11.5px] text-on-surface-variant max-h-32 overflow-auto"></pre>
        </form>
      </div>
    </div>

    <script>
      window.RDS_NEW_BUILD = {
        stacks: ${JSON.stringify(stackData)},
        skills: ${JSON.stringify(skillData)}
      };
      ${clientScript()}
      rdsSyncProviderFields(document.getElementById('new-build'));
      rdsFilterSkillPicker(document.getElementById('new-build'));
      rdsUpdateNewBuildReadiness(document.getElementById('new-build'));
    </script>
  `, { nav: "new", topbarTab: "builds" }));
});

app.post("/new/analyze", async (c) => {
  const contentType = c.req.header("content-type") || "";
  let body: Record<string, string>;
  let uploadFiles: File[] = [];
  if (contentType.includes("multipart/form-data")) {
    const parsed = await c.req.parseBody({ all: true }).catch(() => ({})) as Record<string, unknown>;
    const firstString = (key: string) => {
      const value = parsed[key];
      const first = Array.isArray(value) ? value.find((v) => typeof v === "string") : value;
      return typeof first === "string" ? first : "";
    };
    body = {
      mode: firstString("mode"),
      trigger: firstString("trigger"),
      prd: firstString("prd"),
      attachment_text: firstString("attachment_text"),
      app_type: firstString("app_type"),
    };
    const rawAttachments = parsed.attachments;
    const values = Array.isArray(rawAttachments) ? rawAttachments : [rawAttachments];
    uploadFiles = values.filter(isUploadFile);
  } else {
    body = (await c.req.json().catch(() => ({}))) as Record<string, string>;
  }
  const mode = body.mode === "brown" ? "brown" : "green";
  const trigger = (body.trigger || "").trim();
  const prd = (body.prd || "").trim();
  const attachmentText = (body.attachment_text || "").trim();
  const appType = normalizeAppType(body.app_type || "auto") || "auto";
  const extractedAttachmentText = await extractUploadTextForAnalysis(uploadFiles);
  const source = [mode === "brown" ? (prd || trigger) : trigger, attachmentText, extractedAttachmentText]
    .filter(Boolean)
    .join("\n\n--- attached text source ---\n\n");
  const analysis = analyzeSourceText(source, hasAttachmentEvidence(source) ? "auto" : appType);
  if (!analysis?.stack) {
    return c.json({ ok: false, error: "source analysis did not produce a launchable stack" }, 400);
  }
  return c.json({ ok: true, analysis });
});

app.post("/new", async (c) => {
  const denied = tokenGate(c);
  if (denied) {
    appendAudit({ route: "POST /new", outcome: "denied", status: denied.status, ip: callerIp(c), ua: callerUa(c) });
    return denied;
  }
  appendAudit({ route: "POST /new", outcome: "ok", ip: callerIp(c), ua: callerUa(c) });
  const contentType = c.req.header("content-type") || "";
  let body: Record<string, string>;
  let uploadFiles: File[] = [];
  if (contentType.includes("multipart/form-data")) {
    const parsed = await c.req.parseBody({ all: true }).catch(() => ({})) as Record<string, unknown>;
    const firstString = (key: string) => {
      const value = parsed[key];
      const first = Array.isArray(value) ? value.find((v) => typeof v === "string") : value;
      return typeof first === "string" ? first : "";
    };
    body = {
      mode: firstString("mode"),
      stack: firstString("stack"),
      trigger: firstString("trigger"),
      app_dest: firstString("app_dest"),
      deploy_target: firstString("deploy_target"),
      repo: firstString("repo"),
      prd: firstString("prd"),
      branch: firstString("branch"),
      app_type: firstString("app_type"),
      provider: firstString("provider"),
      claude_model: firstString("claude_model"),
      codex_model: firstString("codex_model"),
      skills: firstString("skills"),
    };
    const rawAttachments = parsed.attachments;
    const values = Array.isArray(rawAttachments) ? rawAttachments : [rawAttachments];
    uploadFiles = values.filter(isUploadFile);
  } else {
    body = (await c.req.json().catch(() => ({}))) as Record<string, string>;
  }
  const mode    = body.mode === "brown" ? "brown" : "green";
  const trigger = (body.trigger || "").trim();
  let appDest   = (body.app_dest || "").trim();
  const deploy  = body.deploy_target === "none" ? "none" : "zo";
  const repo    = (body.repo || "").trim();
  const prd     = (body.prd || "").trim();
  const branch  = (body.branch || "").trim();
  let stack   = (body.stack || "").replace(/[^a-z0-9_-]/gi, "");
  let appType = normalizeAppType(body.app_type || "auto");
  const provider = body.provider === "codex" ? "codex" : "claude";
  const claudeModel = (body.claude_model || "claude-opus-4-6").trim() || "claude-opus-4-6";
  const codexModel = (body.codex_model || "").trim();
  let skills = (body.skills || "default").trim() || "default";
  const submittedStack = stack;

  if (!CLAUDE_MODELS.includes(claudeModel)) return c.json({ ok: false, error: "unsupported Claude model" }, 400);
  if (codexModel && !/^[a-zA-Z0-9._:-]{1,80}$/.test(codexModel)) return c.json({ ok: false, error: "invalid Codex model id" }, 400);
  const extractedAttachmentText = uploadFiles.length ? await extractUploadTextForAnalysis(uploadFiles) : "";
  const fullAnalysisSource = [
    mode === "brown" ? (prd || trigger) : trigger,
    extractedAttachmentText,
  ].filter(Boolean).join("\n\n--- attached source ---\n\n");
  const serverAnalysis = fullAnalysisSource.trim()
    ? analyzeSourceText(fullAnalysisSource, uploadFiles.length ? "auto" : (appType || "auto"))
    : null;
  if (serverAnalysis?.stack && uploadFiles.length && serverAnalysis.stack !== submittedStack) {
    stack = (serverAnalysis.stack || "").replace(/[^a-z0-9_-]/gi, "");
    appType = normalizeAppType(serverAnalysis.appType || appType || "auto");
    if (Array.isArray(serverAnalysis.skills) && serverAnalysis.skills.length) {
      skills = serverAnalysis.skills.join(",");
    }
  } else if (!stack) {
    const analysisSource = fullAnalysisSource || (mode === "brown" ? (prd || trigger) : trigger);
    const analysis = analyzeSourceText(analysisSource, appType || "auto");
    if (analysis) {
      stack = (analysis.stack || "").replace(/[^a-z0-9_-]/gi, "");
      appType = normalizeAppType(analysis.appType || appType || "auto");
      if ((!skills || skills === "default") && Array.isArray(analysis.skills) && analysis.skills.length) {
        skills = analysis.skills.join(",");
      }
    }
  }
  if (!stack) return c.json({ ok: false, error: "stack is required; source analysis did not produce a launchable stack" }, 400);
  const stacks = readyStackIds();
  if (!stacks.has(stack)) return c.json({ ok: false, error: `stack '${stack}' is not end-to-end enabled` }, 400);

  if (mode === "brown" && (!repo || (!prd && !trigger && uploadFiles.length === 0))) {
    return c.json({ ok: false, error: "brown-field requires repo and prd, prompt, or attachment" }, 400);
  }
  if (mode === "green" && !trigger && uploadFiles.length === 0) {
    return c.json({ ok: false, error: "green-field requires a prompt, PRD, or attachment" }, 400);
  }

  const slugFromText = (s: string) =>
    (s.split(/\s+/).slice(0, 4).join("-").replace(/[^a-z0-9-]/gi, "-").toLowerCase() || "adhoc")
      .replace(/-+/g, "-").replace(/(^-|-$)/g, "").slice(0, 32) || "adhoc";

  if (!appDest) {
    const slugSource = mode === "green"
      ? (!trigger && uploadFiles[0]
          ? uploadFiles[0].name
          : /\.(md|markdown|txt)$/i.test(trigger) || trigger.startsWith("/") || trigger.startsWith("http")
          ? trigger.split(/[\\/]/).pop() || trigger
          : trigger)
      : (repo.split(/[\\/]/).pop()?.replace(/\.git$/, "") || prd);
    appDest = `${DEFAULT_PROJECTS_DIR}/${slugFromText(slugSource)}`;
  }
  if (!appDest.startsWith("/")) {
    return c.json({ ok: false, error: "app_dest must be an absolute path" }, 400);
  }

  let attachments: BuildAttachment[] = [];
  try {
    attachments = await saveBuildAttachments(uploadFiles, trigger || prd || repo || "build-input");
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : "invalid attachment" }, 400);
  }
  const attachmentBlock = attachmentMarkdown(attachments);

  const args: string[] = [];
  if (mode === "green") {
    // If trigger is multi-line text (not a path/URL), spool to inbox/.
    let arg = trigger;
    if (attachments.length || trigger.includes("\n") || (!trigger.startsWith("http") && !trigger.startsWith("/") && !/\.(md|markdown|txt)$/i.test(trigger))) {
      mkdirSync(INBOX_DIR, { recursive: true });
      const path = join(INBOX_DIR, `${slugFromText(trigger || attachments[0]?.originalName || "attached-build-input")}-${Date.now()}.md`);
      const triggerIsReference = trigger && !trigger.includes("\n") && (trigger.startsWith("http") || trigger.startsWith("/") || /\.(md|markdown|txt)$/i.test(trigger));
      const triggerBody = triggerIsReference && attachments.length
        ? `# Build Input\n\nPrimary PRD/research source: \`${trigger}\``
        : (trigger || "# Build Input");
      const typedTrigger = appType && !attachments.length
        ? `RDS Product Type: ${appTypeLabel(appType)}\n\n${triggerBody}`
        : triggerBody;
      const content = [typedTrigger, attachmentBlock].filter(Boolean).join("\n\n");
      writeFileSync(path, content + "\n");
      arg = path;
    }
    args.push(arg, `--app-dest=${appDest}`, `--deploy-target=${deploy}`, `--stack=${stack}`, `--skills=${skills}`, `--provider=${provider}`, `--claude-model=${claudeModel}`, `--app-type=${appType || "auto"}`);
    if (codexModel) args.push(`--codex-model=${codexModel}`);
  } else {
    let prdArg = prd;
    if (attachments.length || (!prdArg && trigger)) {
      mkdirSync(INBOX_DIR, { recursive: true });
      const path = join(INBOX_DIR, `${slugFromText(trigger || attachments[0]?.originalName || "attached-prd")}-${Date.now()}.md`);
      const localPrd = readLocalTextInput(prd);
      if (attachments.length && prd && !localPrd && !trigger) {
        return c.json({ ok: false, error: "brown-field attachments require pasted PRD text or a local .md/.txt PRD source so the generated spec stays self-contained" }, 400);
      }
      const prdSourceBlock = localPrd
        ? localPrd
        : (trigger || "# Brown-field PRD");
      const content = [prdSourceBlock, attachmentBlock].filter(Boolean).join("\n\n");
      writeFileSync(path, content + "\n");
      prdArg = path;
    }
    args.push(`--repo=${repo}`, `--prd=${prdArg}`, `--app-dest=${appDest}`, `--deploy-target=${deploy}`, `--stack=${stack}`, `--skills=${skills}`, `--provider=${provider}`, `--claude-model=${claudeModel}`, `--app-type=${appType || "auto"}`);
    if (codexModel) args.push(`--codex-model=${codexModel}`);
    if (branch) args.push(`--branch=${branch}`);
  }

  const cmd = join(RDS_ROOT, "bin", "rds-start");
  if (!existsSync(cmd)) return c.json({ ok: false, error: "bin/rds-start missing" }, 500);

  const child = spawn(cmd, args, {
    cwd: RDS_ROOT, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, RDS_NOTIFY_DISABLED: "1", ...(attachments.length ? { RDS_SPEC_PROVIDER: "claude" } : {}) }
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", (d) => (stdout += d.toString()));
  child.stderr.on("data", (d) => (stderr += d.toString()));
  const exitCode = await new Promise<number>((resolve) => child.on("close", (c) => resolve(c ?? 1)));
  // bin/rds-start prints the build id; pull it from stdout if present.
  const m = stdout.match(/build[_-]?id[=: ]+([a-z0-9_-]+)/i);
  const buildId = m?.[1];
  const blockedByRunningBuild = /another build is already running/i.test(stderr) || /another build is already running/i.test(stdout);
  return c.json({
    ok: exitCode === 0 && !!buildId && !blockedByRunningBuild,
    exitCode,
    stdout,
    stderr,
    build_id: buildId,
    args,
    error: blockedByRunningBuild ? "another build is already running" : (!buildId ? "rds-start did not return a build_id" : undefined),
  }, exitCode === 0 && !!buildId && !blockedByRunningBuild ? 200 : 409);
});

app.get("/b/:id", async (c) => {
  const id = c.req.param("id");
  const dir = join(BUILDS_DIR, id);
  if (!existsSync(dir)) return c.text("not found", 404);
  const row = readBuildRow(id);
  const serviceInfo = readServiceInfo(id);
  const state = safeReadJson<StateJson>(join(dir, "state.json")) || {};
  const events = parseEvents(id);
  const timeline = timelineFromState(state, events);
  const buildTiming = computeBuildTiming(state, row, events);
  const summaries = stageSummaries(id, timeline);
  const stageLogs = await listStageLogs(id);
  const logSort = c.req.query("sort") || "updated";
  const logDir = sortDir(c.req.query("dir"), logSort === "size" || logSort === "updated" ? "desc" : "asc");
  const scaffoldProgress = readScaffoldProgress(id);
  const showScaffoldProgress = shouldShowScaffoldProgress(state, scaffoldProgress);
  const manifestRows = logManifest(id).sort((a, b) => {
    const direction = logDir === "asc" ? 1 : -1;
    const cmp =
      logSort === "source"  ? compareText(a.label, b.label) :
      logSort === "storage" ? compareText(a.durable ? "durable" : "volatile", b.durable ? "durable" : "volatile") :
      logSort === "size"    ? compareNumber(a.bytes, b.bytes) :
      logSort === "path"    ? compareText(a.path, b.path) :
                               compareNumber(a.mtimeMs, b.mtimeMs);
    return cmp === 0 ? compareText(a.label, b.label) : cmp * direction;
  });
  const fixerState = fixerStateFromEvents(events);
  const iterationState = iterationStateFromEvents(events);
  const pendingPreview = isPendingPreview(row.preview);
  const canOpenPreview = !!row.preview && !pendingPreview && !!(row.liveOnZo || row.localPreviewRunning);
  const previewUrl = row.hasZoService ? (serviceInfo?.url || row.preview || "") : (row.preview || "");
  const previewIsLocalOnly = !!row.preview && !pendingPreview && !row.hasZoService;
  const buildBrief = readBuildBrief(id, state, row);
  const displayName = row.displayName || buildBrief.title || compactBuildId(id);
  const terminalState = row.status === "done" || row.status === "passed" || row.reviewStatus === "approved" || row.reviewStatus === "rejected";
  // While a build awaits operator review, the next action is Approve/Reject —
  // not Spawn fixer. The pipeline already gave up on autonomous recovery and
  // handed off to a human, so a fresh fixer just relitigates the same gate.
  // Shared "Spawn fixer" button. Marked .js-spawn-fixer so SSE can flip
  // every instance on the page when fixer_started/fixer_completed fires.
  const spawnFixerBtn = (variant: "warn" | "error") => {
    const palette = variant === "error"
      ? "bg-error/20 hover:bg-error/30 border-error/40 text-error"
      : "bg-tertiary-container/20 hover:bg-tertiary-container/30 border-tertiary-container/40 text-tertiary-container";
    const running = fixerState.running;
    return `<button onclick="spawnFixer()" data-variant="${variant}"
      class="js-spawn-fixer px-3 py-1.5 ${palette} border rounded-DEFAULT font-ribbon text-ribbon transition-colors shrink-0 disabled:opacity-60 disabled:cursor-not-allowed"
      ${running ? "disabled" : ""}>${running ? "Fixer running…" : "Spawn fixer"}</button>`;
  };

  // Watchdog auto-fix hint shown inside the Stuck banner so the operator
  // knows they don't *have* to click — the watchdog will spawn a fixer
  // automatically once inactivity passes WATCHDOG_AUTOFIX_AFTER_MS.
  const lastActivityMs = row.lastActivityMs ?? 0;
  const autofixDueMs = lastActivityMs ? lastActivityMs + WATCHDOG_AUTOFIX_AFTER_MS : 0;
  const lastFixerCompletedMs = fixerState.lastCompletedAt ? Date.parse(fixerState.lastCompletedAt) : 0;
  const fixerAlreadyTried = row.stuck && !!lastFixerCompletedMs && lastFixerCompletedMs >= lastActivityMs;
  const autofixHint = fixerAlreadyTried
    ? `<div class="text-on-surface-variant text-ribbon mt-1">Fixer diagnosis already ran ${escapeHtml(relativeTime(lastFixerCompletedMs))}; this stage is still stalled and needs a resume/retry action.</div>`
    : lastActivityMs
      ? `<div class="text-on-surface-variant text-ribbon mt-1" data-autofix-due="${autofixDueMs}">Watchdog will auto-spawn a fixer once inactivity exceeds ${formatDuration(WATCHDOG_AUTOFIX_AFTER_MS)} (${Date.now() >= autofixDueMs ? "due now" : `in <span class="js-autofix-countdown font-code">…</span>`}).</div>`
      : "";

  const stuckBanner = row.stuck
    ? `<div class="rds-status-banner bg-tertiary-container/10 border border-tertiary-container/30 rounded-DEFAULT p-3 flex items-start gap-3">
         ${icon("warning", 18, "text-tertiary-container shrink-0 mt-0.5")}
         <div class="flex-1 font-body text-body">
           <div class="font-bold text-tertiary-container mb-0.5">Stalled at ${escapeHtml(displayTokenLabel(row.stage ?? "?"))}</div>
           <div class="text-on-surface-variant">No activity for ${formatDuration(Date.now() - lastActivityMs)}. Build is still running (pid ${row.pid}) but nothing has been written.</div>
           ${autofixHint}
         </div>
         ${spawnFixerBtn("warn")}
       </div>` : "";

  const runnerMissingBanner = row.runnerMissing
    ? `<div class="rds-status-banner bg-tertiary-container/10 border border-tertiary-container/30 rounded-DEFAULT p-3 flex items-start gap-3">
         ${icon("warning", 18, "text-tertiary-container shrink-0 mt-0.5")}
         <div class="flex-1 font-body text-body">
           <div class="font-bold text-tertiary-container mb-0.5">Runner stopped at ${escapeHtml(displayTokenLabel(row.stage ?? "?"))}</div>
           <div class="text-on-surface-variant">RDS still has this stage marked running, but no build process is attached. The correct next step is to resume the build from this stage.</div>
           <div class="text-on-surface-variant text-ribbon mt-1">The previous fixer only diagnosed the stall; it did not continue the pipeline.</div>
         </div>
         <div class="flex gap-2 flex-wrap justify-end">
           <button onclick="cmd('resume')" class="px-3 py-1.5 bg-primary-container hover:bg-surface-tint text-on-primary-container rounded-DEFAULT font-ribbon text-ribbon font-bold transition-colors shrink-0">Resume build</button>
           ${spawnFixerBtn("warn")}
         </div>
       </div>` : "";

  const failedBanner = row.status === "failed"
    ? `<div class="rds-status-banner bg-error/10 border border-error/30 rounded-DEFAULT p-3 flex items-start gap-3">
         ${icon("error", 18, "text-error shrink-0 mt-0.5")}
         <div class="flex-1 font-body text-body">
           <div class="font-bold text-error mb-0.5">Failed at ${escapeHtml(displayTokenLabel(row.stage ?? "?"))}</div>
           <div class="text-on-surface-variant break-words">${escapeHtml(summarizeFailureReason(id, state.error ?? undefined))}</div>
           <div class="text-on-surface-variant text-ribbon mt-1">Next step: Spawn fixer to launch the selected builder to diagnose and patch this build, or open the per-stage logs (Logs tab).</div>
         </div>
         ${spawnFixerBtn("error")}
       </div>` : "";

  const idleBanner = (!row.running && !row.runnerMissing && !terminalState && row.status !== "failed" && row.reviewStatus !== "pending" && !row.preview)
    ? `<div class="rds-status-banner bg-surface-container-high/40 border border-outline-variant rounded-DEFAULT p-3 flex items-start gap-3">
         ${icon("info", 18, "text-outline shrink-0 mt-0.5")}
         <div class="flex-1 font-body text-body">
           <div class="font-bold text-on-surface mb-0.5">Build is idle</div>
           <div class="text-on-surface-variant break-words">This build isn't currently running. Stage <code class="font-code text-code text-primary-container">${escapeHtml(row.stage ?? "?")}</code> · status <code class="font-code text-code">${escapeHtml(row.status ?? "?")}</code>.</div>
           <div class="text-on-surface-variant text-ribbon mt-1">If you expected output, check the per-stage logs in the Terminal tab. To retry from here, use Spawn fixer.</div>
         </div>
       </div>` : "";

  const deployBanner = canOpenPreview && row.liveOnZo
    ? `<div id="deploy-banner" class="rds-deploy-banner bg-primary-container/10 border border-primary-container/40 rounded-DEFAULT p-3 flex items-center gap-3 flex-wrap">
         ${icon("cloud_done", 18, "text-primary-container shrink-0")}
         <div class="flex-1 min-w-0 font-body text-body">
           <div class="font-bold text-primary-container mb-0.5">Live on Zo</div>
           <div class="text-on-surface-variant break-words">Hosted service URL: <a id="deploy-url-link" href="${escapeHtml(serviceInfo?.url || row.preview || "")}" target="_blank" class="font-code text-code text-primary-container hover:underline break-all">${escapeHtml(serviceInfo?.url || row.preview || "")}</a></div>
         </div>
         <div class="rds-deploy-actions flex gap-2 shrink-0">
           <a href="${escapeHtml(serviceInfo?.url || row.preview || "")}" target="_blank" class="px-3 py-1.5 bg-primary-container hover:bg-surface-tint text-on-primary-container rounded-DEFAULT font-ribbon text-ribbon font-bold transition-colors flex items-center gap-1">${icon("open_in_new", 14)}<span>Open</span></a>
           <button type="button" onclick="navigator.clipboard.writeText('${escapeHtml(serviceInfo?.url || row.preview || "")}').then(function(){rdsToast('URL copied.','info');})" class="px-3 py-1.5 border border-outline-variant bg-surface hover:bg-surface-bright text-on-surface rounded-DEFAULT font-ribbon text-ribbon transition-colors flex items-center gap-1">${icon("content_copy", 14)}<span>Copy</span></button>
           ${serviceInfo?.service_id ? `<button type="button" onclick="deregisterService()" class="js-delete-service-action px-3 py-1.5 border border-error/40 bg-error/10 hover:bg-error/20 text-error rounded-DEFAULT font-ribbon text-ribbon transition-colors flex items-center gap-1">${icon("delete", 14)}<span>Delete Zo service</span></button>` : ""}
         </div>
       </div>`
    : row.hasZoService
      ? `<div id="deploy-banner" class="rds-deploy-banner bg-tertiary-container/10 border border-tertiary-container/40 rounded-DEFAULT p-3 flex items-center gap-3 flex-wrap">
           ${icon("cloud_sync", 18, "text-tertiary-container shrink-0")}
           <div class="flex-1 min-w-0 font-body text-body">
             <div class="font-bold text-tertiary-container mb-0.5">Zo service recorded; verify status</div>
             <div class="text-on-surface-variant break-words">RDS has service <code class="font-code text-code break-all">${escapeHtml(serviceInfo?.service_id || "unknown")}</code>, but it is not marked live. URL: <a id="deploy-url-link" href="${escapeHtml(serviceInfo?.url || row.preview || "")}" target="_blank" class="font-code text-code text-tertiary-container hover:underline break-all">${escapeHtml(serviceInfo?.url || row.preview || "")}</a></div>
           </div>
           <div class="rds-deploy-actions flex gap-2 shrink-0">
             <button type="button" onclick="deploy('zo')" class="px-3 py-1.5 bg-tertiary-container hover:bg-tertiary-container/80 text-on-tertiary-container rounded-DEFAULT font-ribbon text-ribbon font-bold transition-colors flex items-center gap-1">${icon("sync", 14)}<span>Redeploy</span></button>
             ${serviceInfo?.service_id ? `<button type="button" onclick="deregisterService()" class="js-delete-service-action px-3 py-1.5 border border-error/40 bg-error/10 hover:bg-error/20 text-error rounded-DEFAULT font-ribbon text-ribbon transition-colors flex items-center gap-1">${icon("delete", 14)}<span>Delete Zo service</span></button>` : ""}
           </div>
         </div>`
    : previewIsLocalOnly
      ? `<div id="deploy-banner" class="rds-deploy-banner ${row.localPreviewRunning ? "bg-surface-container-high/40 border-outline-variant" : "bg-error/10 border-error/30"} border rounded-DEFAULT p-3 flex items-center gap-3 flex-wrap">
           ${icon(row.localPreviewRunning ? "computer" : "power_settings_new", 18, `${row.localPreviewRunning ? "text-on-surface-variant" : "text-error"} shrink-0`)}
           <div class="flex-1 min-w-0 font-body text-body">
             <div class="font-bold ${row.localPreviewRunning ? "text-on-surface" : "text-error"} mb-0.5">${row.localPreviewRunning ? "Local preview only" : "Local preview stopped"}</div>
             <div class="text-on-surface-variant break-words">${row.localPreviewRunning ? `Running locally at <code class="font-code text-code break-all">${escapeHtml(row.preview || "")}</code>. This is not hosted on Zo and should not consume a service slot.` : `The old local preview URL is no longer active. RDS will not offer an Open button until the local process is running again or the build is redeployed to Zo.`}</div>
           </div>
           <div class="rds-deploy-actions flex gap-2 shrink-0">
             ${row.localPreviewRunning ? `<a href="${escapeHtml(row.preview || "")}" target="_blank" class="px-3 py-1.5 border border-outline-variant bg-surface hover:bg-surface-bright text-on-surface rounded-DEFAULT font-ribbon text-ribbon transition-colors flex items-center gap-1">${icon("open_in_new", 14)}<span>Open local</span></a><button type="button" onclick="deploy('teardown')" class="px-3 py-1.5 border border-outline-variant bg-surface hover:bg-surface-bright text-on-surface rounded-DEFAULT font-ribbon text-ribbon transition-colors flex items-center gap-1">${icon("power_settings_new", 14)}<span>Stop local preview</span></button>` : `<button type="button" disabled class="px-3 py-1.5 border border-outline-variant bg-surface text-on-surface-variant rounded-DEFAULT font-ribbon text-ribbon opacity-50 cursor-not-allowed flex items-center gap-1">${icon("open_in_new_off", 14)}<span>Preview stopped</span></button>`}
             <button type="button" onclick="deploy('zo')" class="px-3 py-1.5 bg-primary-container hover:bg-surface-tint text-on-primary-container rounded-DEFAULT font-ribbon text-ribbon font-bold transition-colors flex items-center gap-1">${icon("rocket_launch", 14)}<span>Host on Zo</span></button>
           </div>
         </div>`
    : pendingPreview
      ? `<div id="deploy-banner" class="rds-deploy-banner bg-tertiary-container/10 border border-tertiary-container/40 rounded-DEFAULT p-3 flex items-center gap-3 flex-wrap">
           ${icon("pending", 18, "text-tertiary-container shrink-0")}
           <div class="flex-1 min-w-0 font-body text-body">
             <div class="font-bold text-tertiary-container mb-0.5">Pending Zo registration</div>
             <div class="text-on-surface-variant break-words">RDS finished local deploy, but the public service registration has not completed yet. Sentinel: <code class="font-code text-code break-all">${escapeHtml(row.preview || "")}</code></div>
           </div>
           <div class="rds-deploy-actions flex gap-2 shrink-0">
             <button type="button" onclick="deploy('zo')" class="px-3 py-1.5 bg-tertiary-container hover:bg-tertiary-container/80 text-on-tertiary-container rounded-DEFAULT font-ribbon text-ribbon font-bold transition-colors flex items-center gap-1">${icon("sync", 14)}<span>Retry deploy</span></button>
           </div>
         </div>`
    : (row.status !== "failed" && row.reviewStatus !== "rejected")
      ? `<div id="deploy-banner" class="rds-deploy-banner bg-surface-container-high/40 border border-outline-variant border-dashed rounded-DEFAULT px-3 py-2 flex items-center gap-3">
           ${icon("rocket_launch", 18, "text-outline shrink-0")}
           <div class="flex-1 font-table text-table">
             <span class="font-bold text-on-surface">Awaiting deploy.</span>
             <span class="text-on-surface-variant"> Preview link appears here when the deploy stage finishes.</span>
           </div>
         </div>`
      : "";

  const skillResolution = readSkillResolution(id);
  const qualityLedger = readQualityLedger(id);
  const evidenceLedger = readEvidenceLedger(id);
  const goalState = reconcileStaleGoalState(id, readGoalState(id), events);
  const activeRunTiming = computeActiveRunTiming(row, goalState, iterationState, fixerState);
  const evidenceBlocksApproval = evidenceLedger?.verdict === "blocked" || evidenceLedger?.verdict === "failed";
  const timelineHtml = renderTimelineList(timeline, skillResolution);

  const recentEvents = readEvents(id).lines.slice(-50);

  const reviewBanner = row.reviewStatus === "pending"
    ? `<div data-dismissible-alert="review-${escapeHtml(id)}-pending" class="rds-review-banner ${evidenceBlocksApproval ? "bg-error/10 border-error/30" : "bg-secondary-container/30 border-secondary/30"} border rounded-DEFAULT p-3 flex items-center gap-3 flex-wrap">
         ${icon(evidenceBlocksApproval ? "block" : "rate_review", 18, `${evidenceBlocksApproval ? "text-error" : "text-secondary"} shrink-0`)}
         <div class="flex-1 min-w-0 font-body text-body">
           <div class="font-bold ${evidenceBlocksApproval ? "text-error" : "text-secondary"} mb-0.5">${evidenceBlocksApproval ? "Pending review, but approval is blocked" : "Pending operator review"}</div>
           <div class="text-on-surface-variant">${evidenceBlocksApproval ? "Evidence says this build still has blocking issues. Continue the RDS Goal loop to re-read the PRD, repair blockers, and rerun QA/readiness before approval." : "Pipeline finished. Review the live app and Playwright artefacts, then use the Approve or Reject action in the header."}</div>
         </div>
         <button type="button" onclick="dismissBuildAlert('review-${escapeHtml(id)}-pending')" class="px-2 py-1 border border-outline-variant bg-surface hover:bg-surface-bright text-on-surface-variant rounded-DEFAULT font-ribbon text-ribbon">Dismiss</button>
       </div>`
    : row.reviewStatus === "approved"
      ? ""
    : row.reviewStatus === "rejected"
      ? `<div data-dismissible-alert="review-${escapeHtml(id)}-rejected" class="rds-review-banner bg-error/10 border border-error/30 rounded-DEFAULT p-3 flex items-center gap-3">
           ${icon("cancel", 18, "text-error shrink-0")}
           <div class="flex-1 font-body text-body"><span class="font-bold text-error">Rejected.</span> <span class="text-on-surface-variant">${escapeHtml(state.review?.reason ?? "no reason recorded")}</span></div>
           <button type="button" onclick="dismissBuildAlert('review-${escapeHtml(id)}-rejected')" class="px-2 py-1 border border-outline-variant bg-surface hover:bg-surface-bright text-on-surface-variant rounded-DEFAULT font-ribbon text-ribbon">Dismiss</button>
         </div>`
    : "";

  const costPill = row.costUsd != null
    ? `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-DEFAULT font-code text-[11px] bg-surface-container border border-outline-variant text-on-surface" title="$${row.costUsd.toFixed(4)}${row.costTokens ? ` · ${row.costTokens.toLocaleString()} tokens` : ""}">${icon("attach_money", 12, "text-primary-container")}<span>${row.costUsd.toFixed(2)}${row.costTokens ? ` · ${row.costTokens.toLocaleString()} tok` : ""}</span></span>`
    : `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-DEFAULT font-code text-[11px] bg-surface-container border border-outline-variant text-outline" title="POST /b/:id/refresh-cost to compute">${icon("attach_money", 12, "text-outline")}<span>no cost yet</span></span>`;
  const elapsedPill = `<span id="build-elapsed-pill" data-build-elapsed-pill data-start-ms="${buildTiming.startedAt ? parseTimeMs(buildTiming.startedAt) : ""}" data-end-ms="${buildTiming.endedAt ? parseTimeMs(buildTiming.endedAt) : ""}" data-running="${buildTiming.running ? "1" : "0"}" class="rds-elapsed-pill inline-flex items-center gap-1.5 px-2.5 py-1 rounded-DEFAULT font-code text-[11px] bg-primary-container/10 border border-primary-container/35 text-primary-container" title="${escapeHtml(buildTiming.hint)}">${icon(buildTiming.running ? "timer" : "timer_off", 13, buildTiming.running ? "animate-pulse" : "")}<span class="text-primary-container/75">Elapsed</span><strong data-build-elapsed-label>${escapeHtml(buildTiming.label)}</strong></span>`;
  const activeRunLabel = activeRunTiming.running
    ? "Active run"
    : activeRunTiming.kind === "stale_goal"
      ? "Last goal attempt"
      : "Active run";
  const activeRunPill = `<span id="current-run-pill" data-current-run-pill data-start-ms="${activeRunTiming.startedAt ? parseTimeMs(activeRunTiming.startedAt) : ""}" data-updated-ms="${activeRunTiming.updatedAt ? parseTimeMs(activeRunTiming.updatedAt) : ""}" data-running="${activeRunTiming.running ? "1" : "0"}" data-stale="${activeRunTiming.stale ? "1" : "0"}" class="rds-elapsed-pill inline-flex items-center gap-1.5 px-2.5 py-1 rounded-DEFAULT font-code text-[11px] ${activeRunTiming.stale ? "bg-tertiary-container/10 border border-tertiary-container/35 text-tertiary-container" : activeRunTiming.running ? "bg-secondary-container/15 border border-secondary/40 text-secondary" : "bg-surface-container border border-outline-variant text-on-surface-variant"}" title="${escapeHtml(activeRunTiming.hint)}">${icon(activeRunTiming.running ? "progress_activity" : activeRunTiming.stale ? "schedule" : "pause_circle", 13, activeRunTiming.running ? "animate-spin" : "")}<span class="${activeRunTiming.stale ? "text-tertiary-container/75" : activeRunTiming.running ? "text-secondary/75" : "text-outline"}">${escapeHtml(activeRunLabel)}</span><strong data-current-run-label>${escapeHtml(activeRunTiming.label)}</strong></span>`;

  const connPill = (id_: string, label: string, hint: string) => `
    <span id="${id_}" data-conn="off" class="inline-flex items-center gap-1 px-2 py-0.5 rounded-DEFAULT font-code text-[11px] bg-surface-container border border-outline-variant text-outline" title="${escapeHtml(hint)}">
      <span class="w-1.5 h-1.5 rounded-full bg-outline"></span>${escapeHtml(label)}
    </span>`;

  const activeStage = row.running || row.paused
    ? (row.stage || "starting")
    : row.reviewStatus === "pending"
      ? "taste-review"
      : row.reviewStatus === "approved"
        ? "approved"
        : row.reviewStatus === "rejected"
          ? "rejected"
          : (row.status || "done");
  const stageLabel = displayTokenLabel(activeStage);
  const identityChips = [
    { icon: "layers", label: "Stack", value: stackDisplayLabel(row.stack ?? "rails") },
    { icon: "category", label: "Type", value: appTypeLabel(row.appType) },
    { icon: "call_split", label: "Mode", value: modeDisplayLabel(row.mode) },
    { icon: "smart_toy", label: "Builder", value: builderDisplayLabel(row.provider ?? "claude") },
  ];
  const activeStageStatus = activeStage && state.stages && typeof state.stages === "object"
    ? state.stages[activeStage]?.status
    : row.status;
  const defaultStageSummaryId = timeline.find((s) => s.status === "failed")?.stage
    || activeStage
    || timeline[timeline.length - 1]?.stage
    || "";
  const showHeaderStatus = row.running || row.paused || row.status === "failed";
  const showHeaderStage = row.running || row.paused;
  const lastOutput = row.lastActivityMs ? relativeTime(row.lastActivityMs) : "no output yet";
  const iterationBanner = iterationState.running
    ? `<div class="rds-status-banner bg-primary-container/10 border border-primary-container/35 rounded-DEFAULT p-3 flex items-center gap-3 flex-wrap">
         <span class="material-symbols-outlined text-primary-container animate-spin" style="font-size:18px;animation-duration:1.2s">progress_activity</span>
         <div class="flex-1 min-w-0 font-body text-body">
           <div class="font-bold text-primary-container">Iteration running: ${escapeHtml(iterationState.phase || "working")}</div>
           <div class="text-on-surface-variant">RDS is applying the requested change, then checks, QA, and redeploy. Last iteration event ${escapeHtml(iterationState.updatedAt ? relativeTime(new Date(iterationState.updatedAt).getTime()) : "just now")}.</div>
         </div>
         <button type="button" onclick="showTab('live-log')" class="px-3 py-1.5 border border-primary-container/50 bg-surface hover:bg-surface-bright text-primary-container rounded-DEFAULT font-ribbon text-ribbon transition-colors flex items-center gap-1">${icon("receipt_long", 14)}<span>Watch log</span></button>
       </div>`
    : "";

  const plan = row.buildPlan || state.build_plan;
  const planReasons = Array.isArray(plan?.reasons) ? plan.reasons.slice(0, 4) : [];
  const planRisks = Array.isArray(plan?.risks) ? plan.risks.slice(0, 2) : [];
  const planQuestions = Array.isArray(plan?.operator_questions) ? plan.operator_questions.slice(0, 2) : [];
  const buildPlanBox = plan
    ? `<div class="rds-build-plan-card rds-decision-card bg-surface border border-outline-variant rounded-DEFAULT p-3 flex flex-col gap-3">
         <div class="flex items-start justify-between gap-3 flex-wrap">
           <div class="min-w-0">
             <div class="font-ribbon text-ribbon text-primary-container uppercase">Execution plan</div>
             <div class="font-h2 text-h2 text-on-surface mt-0.5">
               <span class="text-primary-container">${escapeHtml(plan.profile_name || plan.profile || "Unknown")}</span>
               <span class="font-table text-table text-on-surface-variant"> · ${escapeHtml(plan.target_minutes || "-")} min target · ${escapeHtml(String(plan.max_tasks ?? "-"))} tasks max</span>
             </div>
           </div>
           <div class="flex gap-2 flex-wrap font-code text-[11px] text-on-surface-variant">
             <span class="rds-plan-chip">timeout ${escapeHtml(String(plan.task_timeout_sec ?? "-"))}s</span>
             <span class="rds-plan-chip">QA ${escapeHtml(String(plan.qa_max_pages ?? "-"))}p / depth ${escapeHtml(String(plan.qa_depth ?? "-"))}</span>
           </div>
         </div>
         ${planReasons.length ? `<div class="flex flex-wrap gap-1.5">${planReasons.map((reason) => `<span class="rds-plan-chip">${escapeHtml(reason)}</span>`).join("")}</div>` : ""}
         ${planQuestions.length || planRisks.length ? `<div class="grid md:grid-cols-2 gap-2">
           ${planQuestions.length ? `<div class="rds-callout rds-callout-question">${icon("help", 15)}<div><strong>Question</strong><span>${escapeHtml(planQuestions[0])}</span></div></div>` : ""}
           ${planRisks.length ? `<div class="rds-callout rds-callout-risk">${icon("warning", 15)}<div><strong>Risk</strong><span>${escapeHtml(planRisks[0])}</span></div></div>` : ""}
         </div>` : ""}
       </div>`
    : "";

  const tabs = [
    { id: "overview",  label: "Overview",       icon: "dashboard" },
    { id: "chat",      label: "Chat",           icon: "chat" },
    { id: "live-log",  label: "Live Log",       icon: "receipt_long" },
    { id: "terminal",  label: "Logs",           icon: "receipt_long" },
    { id: "browser",   label: "Browser",        icon: "language",     badge: row.preview && !pendingPreview ? "↗" : undefined },
    { id: "files",     label: "Files",          icon: "folder" },
    { id: "diff",      label: "Diff",           icon: "difference" },
  ];

  const actionBtn = (label: string, attrs: string, kind: "primary" | "secondary" | "ghost" = "secondary") => {
    const cls = kind === "primary"
      ? "px-3 py-1.5 bg-primary-container hover:bg-surface-tint text-on-primary-container rounded-DEFAULT font-ribbon text-ribbon font-bold transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      : kind === "ghost"
        ? "px-3 py-1.5 text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface rounded-DEFAULT font-ribbon text-ribbon transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        : "px-3 py-1.5 border border-outline-variant bg-surface hover:bg-surface-bright text-on-surface rounded-DEFAULT font-ribbon text-ribbon transition-colors disabled:opacity-40 disabled:cursor-not-allowed";
    return `<button class="${cls}" ${attrs}>${label}</button>`;
  };
  const settings = readSettings();
  const engineProvider: "claude" | "codex" = state.inference?.provider === "codex" ? "codex" : "claude";
  const commandCenter = renderBuildCommandCenter({
    id,
    row,
    evidenceLedger,
    qualityLedger,
    previewUrl,
    canOpenPreview,
    evidenceBlocksApproval,
    fixerRunning: fixerState.running,
    iterationRunning: iterationState.running,
    engine: {
      provider: engineProvider,
      claudeModel: (state.inference?.claude_model || settings.claudeModel || "").trim(),
      codexModel: (state.inference?.codex_model || settings.codexModel || "").trim(),
    },
  });
  const overviewDeployBanner = canOpenPreview ? "" : deployBanner;
  // Prominent, interactive live terminal — rendered above the command center
  // while a build is actively running so the operator can watch code stream in.
  const termFilterChip = (kind: string, label: string, dot: string, active = false) =>
    `<button type="button" class="rds-term-chip${active ? " is-active" : ""}" data-ovfilter="${kind}" onclick="ovSetFilter('${kind}', this)">${dot ? `<i class="rds-term-dot ${dot}"></i>` : ""}<span>${label}</span></button>`;
  const termToolBtn = (icn: string, label: string, onclick: string, title: string, active = false, tool = "") =>
    `<button type="button" class="rds-term-tool${active ? " is-active" : ""}"${tool ? ` data-tool="${tool}"` : ""} onclick="${onclick}" title="${escapeHtml(title)}">${icon(icn, 14)}<span>${label}</span></button>`;
  // Show the prominent terminal whenever an agent process is actively producing
  // output — the main build runner OR a post-build iteration/fixer. A build can
  // sit at "Blocked before approval" while rds-iterate finalizes a change, and
  // gating only on row.running would hide the very output the operator wants.
  const agentRunning = row.running || iterationState.running || fixerState.running;
  const liveTermSubtitle = row.running
    ? stageLabel
    : iterationState.running
      ? `Iterating · ${iterationState.phase || "working"}`
      : fixerState.running
        ? "Fixer running"
        : stageLabel;
  const liveTerminalTop = agentRunning
    ? `<section class="rds-live-term rds-live-term-primary">
          <div class="rds-live-term-head">
            <div class="rds-live-term-id min-w-0">
              <span class="rds-term-dots" aria-hidden="true"><i></i><i></i><i></i></span>
              <span class="rds-live-term-title">${icon("terminal", 16)}<span>Live build terminal</span></span>
              <span class="rds-live-term-path font-code truncate" title="${escapeHtml(displayName)}">${escapeHtml(displayName)} · ${escapeHtml(liveTermSubtitle)}</span>
            </div>
        <div class="rds-live-term-meta">
          <span id="ovlog-count" class="rds-live-term-count font-code">0 lines</span>
          <span id="ovlog-state" class="rds-live-term-state flex items-center gap-1"><span class="w-1.5 h-1.5 rounded-full bg-outline"></span>connecting…</span>
          <button type="button" onclick="showTab('live-log')" class="rds-live-term-watch">${icon("receipt_long", 13)}<span>Watch log</span></button>
        </div>
      </div>
          <div class="rds-live-term-toolbar">
            <div class="rds-live-term-filters" id="ovlog-filters">
              ${termFilterChip("all", "All", "", true)}
              ${termFilterChip("error", "Errors", "rds-term-dot-error")}
              ${termFilterChip("warn", "Warnings", "rds-term-dot-warn")}
              ${termFilterChip("agent", "Agent", "rds-term-dot-agent")}
              ${termFilterChip("stage", "Stages", "rds-term-dot-stage")}
            </div>
            <div class="rds-live-term-tools">
              ${termToolBtn("vertical_align_bottom", "Follow", "ovToggleFollow(this)", "Auto-scroll to newest output", true, "follow")}
              ${termToolBtn("wrap_text", "Wrap", "ovToggleWrap(this)", "Toggle line wrapping", false, "wrap")}
              ${termToolBtn("content_copy", "Copy", "ovCopyLog(this)", "Copy visible output to clipboard")}
              ${termToolBtn("backspace", "Clear", "ovClearLog()", "Clear this view (durable log is untouched)")}
              ${termToolBtn("open_in_full", "Expand", "showTab('live-log')", "Open the full live log")}
            </div>
          </div>
          <div id="overview-log-panel" class="rds-terminal-frame rds-live-term-body relative overflow-hidden" data-filter="all">
            <div id="overview-log-empty" class="rds-live-term-empty absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
              <span class="rds-live-term-pulse" aria-hidden="true"></span>
              <div class="rds-live-term-empty-title">Waiting for the agent…</div>
              <div class="rds-live-term-empty-sub">Build output streams here line-by-line as code is written.</div>
            </div>
            <div id="overview-log" class="rds-log-body absolute inset-0 overflow-y-auto custom-scrollbar"></div>
          </div>
        </section>`
    : "";
  const overviewTerminal = agentRunning
    ? ""
    : `<details class="rds-live-term rds-live-term-idle rds-header-details overflow-hidden">
          <summary class="rds-live-term-idle-summary cursor-pointer">
            <span class="flex items-center gap-2 min-w-0">${icon("terminal", 15)}<span class="truncate">Last terminal output</span></span>
            <span class="flex items-center gap-2 shrink-0">
              <span id="ovlog-state" class="rds-live-term-state flex items-center gap-1"><span class="w-1.5 h-1.5 rounded-full bg-outline"></span>idle</span>
              <span class="rds-live-term-idle-caret">${icon("expand_more", 16)}</span>
            </span>
          </summary>
          <div class="rds-live-term-idle-inner">
            <div id="overview-log-panel" class="rds-terminal-frame rds-live-term-body rds-live-term-body-sm relative overflow-hidden" data-filter="all">
              <div id="overview-log-empty" class="rds-live-term-empty absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center">
                <div class="rds-live-term-empty-title">No active terminal stream</div>
                <div class="rds-live-term-empty-sub">Open the full live log for durable per-stage output.</div>
              </div>
              <div id="overview-log" class="rds-log-body absolute inset-0 overflow-y-auto custom-scrollbar"></div>
            </div>
            <div class="text-right pt-2"><a href="#" onclick="showTab('live-log');return false;" class="rds-live-term-expand-link font-code">Open full live log →</a></div>
          </div>
        </details>`;

  return c.html(layout(`${displayName}`, `
    <div class="flex flex-col gap-component-gap">
      <!-- Sticky header -->
      <div class="rds-build-header bg-surface-container border border-outline-variant rounded-DEFAULT px-container-padding py-gutter flex flex-col gap-gutter shadow-sm">
        <div class="flex justify-between items-start gap-4 flex-wrap">
          <div class="flex flex-col gap-stack-gap min-w-0">
            <div class="rds-build-title-row flex items-center gap-3 flex-wrap">
              <a href="/builds" class="text-on-surface-variant hover:text-on-surface font-ribbon text-ribbon flex items-center gap-1">${icon("arrow_back", 14)}<span>Builds</span></a>
              <span class="text-outline-variant">/</span>
              <span class="rds-build-title font-body text-h1 text-primary-container" title="${escapeHtml(id)}">${escapeHtml(displayName)}</span>
              ${showHeaderStatus ? statusBadge(row) : ""}
              ${showHeaderStage ? `<span class="rds-current-stage inline-flex items-center gap-2 rounded-DEFAULT border border-primary-container/35 bg-primary-container/10 px-3 py-1 text-primary-container" title="Current pipeline stage">
                ${icon(row.running ? "sync" : "flag", 15, row.running ? "animate-spin" : "")}
                <span class="font-ribbon text-[11px] uppercase text-primary-container/80">Stage</span>
                <strong id="header-stage-label" data-live-stage-label class="font-ribbon text-ribbon">${escapeHtml(stageLabel)}</strong>
              </span>` : ""}
            </div>
            <div class="font-code text-[11px] leading-4 text-on-surface-variant truncate" title="${escapeHtml(id)}">${escapeHtml(id)}</div>
            <div class="rds-build-meta flex flex-col gap-2">
              <div class="rds-build-identity flex gap-2 flex-wrap items-stretch">
                ${identityChips.map((chip) => `
                  <span class="rds-meta-chip inline-flex items-center gap-2 rounded-DEFAULT border border-outline-variant bg-surface/70 px-3 py-2 text-on-surface">
                    ${icon(chip.icon, 15, "text-primary-container")}
                    <span class="flex flex-col leading-none">
                      <span class="font-ribbon text-[10px] uppercase text-on-surface-variant">${escapeHtml(chip.label)}</span>
                      <strong class="font-ribbon text-ribbon text-on-surface">${escapeHtml(chip.value)}</strong>
                    </span>
                  </span>
                `).join("")}
              </div>
              <div class="rds-header-ops flex gap-2 flex-wrap items-center">
                <span class="rds-ops-label font-ribbon text-[10px] uppercase text-on-surface-variant">Live connections</span>
                ${connPill("conn-sse", "Events", "Connection to structured build events from events.jsonl. Green means the page is receiving events; red means reconnecting.")}
                ${connPill("conn-log", "Terminal", "Connection to the live terminal log at /dev/shm/" + escapeHtml(id) + "-launch-build.log. Green means streaming; red means disconnected or idle.")}
                <span class="rds-ops-divider h-5 w-px bg-outline-variant"></span>
                <span class="rds-hosting-pill inline-flex items-center gap-1 px-2 py-0.5 rounded-DEFAULT font-code text-[11px] bg-surface-container border border-outline-variant text-on-surface" title="${escapeHtml(hostingLabel(row))}">${hostingPill(row)}</span>
                ${elapsedPill}
                ${activeRunPill}
                ${costPill}
                <button data-refresh-cost="1" class="min-w-[92px] justify-center border border-outline-variant bg-surface hover:bg-surface-bright text-on-surface transition-colors flex items-center gap-1 font-code text-[11px] rounded-DEFAULT px-2 py-0.5 disabled:opacity-50 disabled:cursor-wait" onclick="refreshCost(event)" title="Recompute cost from available session logs">${icon("refresh", 14)}<span>Refresh cost</span></button>
              </div>
            </div>
            <div class="rds-mobile-build-summary ${showHeaderStage ? "" : "rds-mobile-summary-3"} hidden">
              ${showHeaderStage ? `<div>
                <span class="text-outline">Stage</span>
                <strong id="mobile-stage-label" data-live-stage-label>${escapeHtml(stageLabel)}</strong>
              </div>` : ""}
              <div>
                <span class="text-outline">Elapsed</span>
                <strong data-build-elapsed-label>${escapeHtml(buildTiming.label)}</strong>
              </div>
              <div>
                <span class="text-outline">${escapeHtml(activeRunLabel)}</span>
                <strong data-current-run-label>${escapeHtml(activeRunTiming.label)}</strong>
              </div>
              <div>
                <span class="text-outline">Cost</span>
                <strong>${escapeHtml(row.costUsd != null ? `$${row.costUsd.toFixed(2)}` : "—")}</strong>
              </div>
              <div>
                <span class="text-outline">Log</span>
                <strong id="mobile-log-status">connecting</strong>
              </div>
            </div>
          </div>
          <div class="rds-mobile-actions rds-build-actions rds-header-actions flex items-center gap-component-gap flex-wrap">
            ${(() => {
              const buttons: string[] = [];
              if (row.running) {
                if (canOpenPreview) {
                  const previewLabel = row.hasZoService ? "Open live preview" : "Open local preview";
                  buttons.push(`<a class="js-open-preview-action px-3 py-1.5 bg-primary-container hover:bg-surface-tint text-on-primary-container rounded-DEFAULT font-ribbon text-ribbon font-bold transition-colors flex items-center gap-1" href="${escapeHtml(previewUrl)}" target="_blank" title="${escapeHtml(previewUrl)}">${icon("open_in_new", 14)}<span>${previewLabel}</span></a>`);
                }
                buttons.push(actionBtn(`<span class="flex items-center gap-1">${icon("pause", 14)}Pause build</span>`, `onclick="cmd('pause')" title="Pause this build and resume it later from the active stage."`));
                buttons.push(actionBtn(`<span class="flex items-center gap-1">${icon("stop", 14)}Stop build</span>`, `onclick="cmd('stop')"`, "primary"));
              } else if (row.paused || row.runnerMissing) {
                buttons.push(actionBtn(`<span class="flex items-center gap-1">${icon("play_arrow", 14)}Resume build</span>`, `onclick="cmd('resume')" title="Resume this build from the current stage."`, "primary"));
              }
              return buttons.join("\n");
            })()}
          </div>
        </div>

        ${liveTerminalTop}
        ${commandCenter}

        <details class="rds-header-details border border-outline-variant rounded-DEFAULT bg-surface/55 overflow-hidden">
          <summary class="cursor-pointer px-3 py-2 flex items-center gap-2 font-ribbon text-ribbon text-on-surface-variant hover:text-on-surface">
            ${icon("route", 15)}<span>Build context</span>
          </summary>
          <div class="border-t border-outline-variant p-3 flex flex-col gap-3">
            <div id="stage-bar-host" class="rds-scroll-table">${stageProgressBar(timeline, row.running ? row.stage : undefined, row.paused ? row.stage : undefined)}</div>
            ${renderStageSummaryPanel(id, summaries, skillResolution, defaultStageSummaryId)}
            ${renderBuildBriefBox(id, buildBrief)}
            ${buildPlanBox || ""}
          </div>
        </details>
        ${overviewTerminal}
        <div id="scaffold-progress-host" class="rds-mobile-secondary">${showScaffoldProgress ? renderScaffoldProgress(scaffoldProgress, "full", row.paused) : ""}</div>

        <details class="rds-raw-links text-on-surface-variant font-ribbon text-ribbon">
          <summary class="cursor-pointer hover:text-on-surface flex items-center gap-1">${icon("data_object", 14)}<span>raw data</span></summary>
          <div class="flex gap-3 mt-1 font-code text-[11px]">
            <a href="/b/${escapeHtml(id)}/events.json" class="text-primary-container hover:underline">events.json</a>
            <a href="/b/${escapeHtml(id)}/truth.json" class="text-primary-container hover:underline">truth.json</a>
            <a href="/b/${escapeHtml(id)}/evidence-ledger.json" class="text-primary-container hover:underline">evidence-ledger.json</a>
            <a href="/b/${escapeHtml(id)}/cost.json" class="text-primary-container hover:underline">cost.json</a>
            <a href="/b/${escapeHtml(id)}/timeline.json" class="text-primary-container hover:underline">timeline.json</a>
            <a href="/b/${escapeHtml(id)}/timing.json" class="text-primary-container hover:underline">timing.json</a>
          </div>
        </details>
      </div>

      ${row.reviewStatus === "pending" ? "" : reviewBanner}
      ${stuckBanner}
      ${runnerMissingBanner}
      ${failedBanner}
      ${idleBanner}
      ${iterationBanner}

      <!-- Split layout: tabs sidebar + main canvas + activity rail -->
      <div class="rds-build-detail flex flex-col lg:flex-row gap-component-gap min-h-[600px]">
        <aside class="rds-build-tabs w-[180px] bg-surface border border-outline-variant rounded-DEFAULT flex flex-col p-unit gap-stack-gap shrink-0">
          ${tabStrip(tabs, "overview")}
        </aside>

        <div class="rds-build-canvas flex-1 flex flex-col bg-surface-container-lowest border border-outline-variant rounded-DEFAULT overflow-visible min-w-0">
          <section data-pane="overview" id="tab-overview" class="p-container-padding flex flex-col gap-component-gap overflow-visible">
            <div class="rds-overview-top-grid grid xl:grid-cols-[minmax(0,1.25fr)_minmax(320px,.75fr)] gap-component-gap">
              ${renderBuildGoalPanel(id, goalState, row, evidenceLedger)}
              <div class="flex flex-col gap-component-gap">
                ${overviewDeployBanner}
                ${renderAgentSessionsPanel(id, state)}
              </div>
            </div>
            <details class="rds-detail-disclosure bg-surface border border-outline-variant rounded-DEFAULT overflow-hidden">
              <summary class="cursor-pointer px-3 py-2 flex items-center justify-between gap-3 font-h2 text-h2 text-on-surface">
                <span class="flex items-center gap-2">${icon("description", 18, "text-outline")}<span>Source files</span></span>
                <span class="font-ribbon text-ribbon text-on-surface-variant">PRD, spec, plan</span>
              </summary>
              <div class="border-t border-outline-variant p-3">${renderBuildInputDocsPanel(id, state)}</div>
            </details>
            <details id="quality-ledger-details" class="rds-detail-disclosure bg-surface border border-outline-variant rounded-DEFAULT overflow-hidden">
              <summary class="cursor-pointer px-3 py-2 flex items-center justify-between gap-3 font-h2 text-h2 text-on-surface">
                <span class="flex items-center gap-2">${icon("fact_check", 18, "text-outline")}<span>Full QA evidence</span></span>
                <span class="font-ribbon text-ribbon text-on-surface-variant">${escapeHtml(qualityLedger?.blocking?.length ? `${qualityLedger.blocking.length} blockers` : "checks")}</span>
              </summary>
              <div class="border-t border-outline-variant p-3">${renderQualityLedgerCard(id, qualityLedger) || renderEvidenceTruthCard(evidenceLedger)}</div>
            </details>
            <details class="bg-surface border border-outline-variant rounded-DEFAULT overflow-hidden">
              <summary class="cursor-pointer px-3 py-2 flex items-center gap-2 font-h2 text-h2 text-on-surface">
                ${icon("history", 18, "text-outline")}<span>Timeline</span>
              </summary>
              <div id="stage-timeline-host" class="border-t border-outline-variant max-h-[360px] overflow-y-auto custom-scrollbar">${timelineHtml}</div>
            </details>
            <details class="bg-surface border border-outline-variant rounded-DEFAULT overflow-hidden">
              <summary class="cursor-pointer px-3 py-2 flex items-center gap-2 font-h2 text-h2 text-on-surface">
                ${icon("data_object", 18, "text-outline")}<span>Raw state</span>
              </summary>
              <pre class="bg-surface-dim border-t border-outline-variant p-3 font-code text-[12px] text-secondary leading-tight overflow-x-auto custom-scrollbar max-h-[420px]">${escapeHtml(JSON.stringify(state, null, 2))}</pre>
            </details>
          </section>

          <section data-pane="chat" id="tab-chat" class="hidden flex flex-col flex-1 min-h-0">
            ${chatPanel({ initialBuildId: id })}
          </section>

          <section data-pane="live-log" id="tab-live-log" class="hidden flex flex-col flex-1 min-h-0">
            <div class="flex justify-between items-center px-3 py-2 border-b border-outline-variant bg-surface-container-high shrink-0 gap-3 flex-wrap">
              <div class="flex flex-col gap-0.5 min-w-0">
                <div class="flex items-center gap-2 font-h2 text-h2 text-on-surface min-w-0">
                  ${icon("terminal", 16, "text-primary-container")}<span class="truncate">Live terminal</span>
                </div>
                <div class="flex items-center gap-2 font-code text-[11px] text-on-surface-variant min-w-0">
                  <span id="live-log-source" class="truncate">Source: newest RDS output</span>
                  <span class="hidden sm:inline text-outline">· timestamps are inferred unless present in output</span>
                </div>
              </div>
              <div class="flex items-center gap-2 font-ribbon text-ribbon text-on-surface-variant flex-wrap">
                <span class="rds-log-chip log-stage">stage</span>
                <span class="rds-log-chip log-agent">agent</span>
                <span class="rds-log-chip log-warn">warn</span>
                <span class="rds-log-chip log-error">error</span>
                <span id="log-state" class="flex items-center gap-1"><span class="w-1.5 h-1.5 rounded-full bg-outline"></span>connecting…</span>
              </div>
            </div>
            <div class="rds-terminal-frame relative flex-1 bg-[#050807]">
              <div id="log-empty" class="absolute inset-0 flex flex-col items-center justify-center text-on-surface-variant font-code text-[12px] gap-2 px-6 text-center">
                ${icon("hourglass_empty", 28, "text-outline")}
                <div>No live output yet.</div>
                <div class="text-outline text-[11px] max-w-[420px]">${row.running ? "Build is running but nothing has streamed yet — output appears as soon as the agent writes." : "This build isn't running. Live output appears only while bin/rds-build is active for this id. Check the Logs tab for per-stage logs."}</div>
              </div>
              <div id="log" class="rds-log-body absolute inset-0 p-0 overflow-y-auto custom-scrollbar font-code text-[12px] text-on-surface-variant leading-relaxed whitespace-pre-wrap break-words"></div>
            </div>
          </section>

          <section data-pane="terminal" id="tab-terminal" class="hidden flex flex-col p-container-padding gap-component-gap overflow-y-auto custom-scrollbar">
            <div class="flex flex-col gap-stack-gap">
              <h2 class="font-h2 text-h2 text-on-surface flex items-center gap-2">${icon("source_notes", 18, "text-outline")}<span>Diagnostic log index</span></h2>
              <div class="bg-surface border border-outline-variant rounded-DEFAULT overflow-hidden">
                <div class="rds-scroll-table overflow-x-auto">
                <table class="rds-desktop-table w-full font-code text-[11px] text-on-surface">
                  <thead class="bg-surface-container-high text-on-surface-variant">
                    <tr class="text-left">
                      <th class="px-3 py-2">${sortableHeader(c.req.url, "source", "source", logSort, logDir)}</th>
                      <th class="px-3 py-2">${sortableHeader(c.req.url, "storage", "storage", logSort, logDir)}</th>
                      <th class="px-3 py-2">${sortableHeader(c.req.url, "size", "size", logSort, logDir)}</th>
                      <th class="px-3 py-2">${sortableHeader(c.req.url, "updated", "updated", logSort, logDir)}</th>
                      <th class="px-3 py-2">${sortableHeader(c.req.url, "path", "path", logSort, logDir)}</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${manifestRows.map((r) => `
                      <tr class="border-t border-outline-variant/40 align-top">
                        <td class="px-3 py-2 text-on-surface">${escapeHtml(r.label)}</td>
                        <td class="px-3 py-2 ${r.durable ? "text-primary-container" : "text-tertiary-container"}">${r.durable ? "durable" : "volatile"}</td>
                        <td class="px-3 py-2 text-on-surface-variant">${(r.bytes / 1024).toFixed(r.bytes > 1024 ? 1 : 2)} KiB</td>
                        <td class="px-3 py-2 text-on-surface-variant">${escapeHtml(new Date(r.mtimeMs).toISOString().slice(11, 19))}</td>
                        <td class="px-3 py-2 text-outline break-all">${r.href ? `<a href="${escapeHtml(r.href)}" target="_blank" class="text-primary-container hover:underline">${escapeHtml(r.path)}</a>` : escapeHtml(r.path)}</td>
                      </tr>`).join("") || `<tr><td colspan="5" class="px-3 py-6 text-center text-on-surface-variant italic">No diagnostic logs found.</td></tr>`}
                  </tbody>
                </table>
                </div>
              </div>
            </div>
            <div class="flex flex-col gap-stack-gap">
              <h2 class="font-h2 text-h2 text-on-surface flex items-center gap-2">${icon("description", 18, "text-outline")}<span>Per-stage logs</span></h2>
              ${stageLogs.length ? `
                <select id="stage-picker" onchange="loadStageLog(this.value)" class="bg-surface-container-lowest border border-outline-variant rounded-DEFAULT px-2 py-1 font-code text-code text-on-surface focus:border-primary-container focus:outline-none w-full max-w-md">
                  <option value="">— pick a stage log —</option>
                  ${stageLogs.map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join("")}
                </select>
                <pre id="stage-log" class="bg-[#070908] border border-outline-variant rounded-DEFAULT p-3 font-code text-[12px] text-on-surface-variant leading-relaxed min-h-[200px] max-h-[400px] overflow-y-auto custom-scrollbar"></pre>
              ` : `<p class="text-on-surface-variant font-body text-body italic">No stage logs yet (builds/${escapeHtml(id)}/logs/).</p>`}
            </div>
            <div class="flex flex-col gap-stack-gap">
              <h2 class="font-h2 text-h2 text-on-surface flex items-center gap-2">${icon("rss_feed", 18, "text-outline")}<span>Recent events <span class="font-ribbon text-ribbon text-on-surface-variant">(live event stream)</span></span></h2>
              <pre id="events" class="bg-[#070908] border border-outline-variant rounded-DEFAULT p-3 font-code text-[12px] text-on-surface-variant leading-relaxed min-h-[200px] max-h-[500px] overflow-y-auto custom-scrollbar">${recentEvents.map(escapeHtml).join("\n")}</pre>
            </div>
          </section>

          <section data-pane="browser" id="tab-browser" class="hidden flex flex-col p-container-padding gap-component-gap overflow-y-auto custom-scrollbar">
            <h2 class="font-h2 text-h2 text-on-surface flex items-center gap-2">${icon("language", 18, "text-outline")}<span>Browser preview</span></h2>
            ${canOpenPreview
              ? `<p class="text-on-surface-variant font-body text-body">Embedded preview of <code class="font-code text-code text-primary-container">${escapeHtml(row.hasZoService ? (serviceInfo?.url || row.preview || "") : (row.preview || ""))}</code>.</p>
                 <iframe class="w-full h-[70dvh] md:h-[600px] bg-white border border-outline-variant rounded-DEFAULT" src="${escapeHtml(usesDirectPreview(row.stack) ? (row.hasZoService ? (serviceInfo?.url || row.preview || "") : (row.preview || "")) : `/b/${id}/preview-proxy/`)}" sandbox="allow-same-origin allow-scripts allow-forms allow-popups"></iframe>
                 <p><a class="inline-flex items-center gap-1 px-3 py-1.5 bg-primary-container hover:bg-surface-tint text-on-primary-container rounded-DEFAULT font-ribbon text-ribbon font-bold transition-colors" href="${escapeHtml(row.hasZoService ? (serviceInfo?.url || row.preview || "") : (row.preview || ""))}" target="_blank">${icon("open_in_new", 14)}<span>Open in new tab</span></a></p>`
              : pendingPreview
                ? `<div class="bg-tertiary-container/10 border border-tertiary-container/40 rounded-DEFAULT p-3 text-on-surface-variant font-body text-body">
                     <div class="font-bold text-tertiary-container mb-1">No public preview URL yet.</div>
                     <div class="break-words">Zo registration is pending: <code class="font-code text-code break-all">${escapeHtml(row.preview || "")}</code></div>
                   </div>`
                : row.preview
                  ? `<div class="bg-error/10 border border-error/30 rounded-DEFAULT p-3 text-on-surface-variant font-body text-body">
                       <div class="font-bold text-error mb-1">Preview is stopped.</div>
                       <div class="break-words">Recorded URL <code class="font-code text-code break-all">${escapeHtml(row.preview || "")}</code> is not clickable because RDS cannot find a running local process or active Zo service for this build.</div>
                     </div>`
              : `<p class="text-on-surface-variant font-body text-body italic">No preview URL on this build yet. The deploy stage publishes one to <code class="font-code text-code">state.json.preview_url</code>.</p>`}
          </section>

          <section data-pane="files" id="tab-files" class="hidden flex flex-col p-container-padding gap-component-gap min-h-0 overflow-y-auto custom-scrollbar">
            <h2 class="font-h2 text-h2 text-on-surface flex items-center gap-2">${icon("folder", 18, "text-outline")}<span>Files <span class="font-ribbon text-ribbon text-on-surface-variant">(read-only view of <code class="font-code text-code">app_dest</code>)</span></span></h2>
            <div class="rds-mobile-stack grid grid-cols-[260px_1fr] gap-component-gap min-h-[500px]">
              <div class="bg-surface border border-outline-variant rounded-DEFAULT flex flex-col overflow-hidden">
                <p class="px-3 py-2 border-b border-outline-variant font-ribbon text-ribbon text-on-surface-variant" id="files-status">Loading file list…</p>
                <ul id="files-tree" class="flex-1 overflow-y-auto custom-scrollbar font-code text-[12px] p-1"></ul>
              </div>
              <div class="bg-surface-dim border border-outline-variant rounded-DEFAULT flex flex-col overflow-hidden">
                <p id="file-viewer-title" class="px-3 py-2 border-b border-outline-variant font-ribbon text-ribbon text-on-surface-variant">Select a file to view it here (read-only, 256 KiB cap).</p>
                <pre id="file-viewer-body" class="flex-1 p-3 overflow-auto custom-scrollbar font-code text-[12px] text-on-surface-variant leading-relaxed"></pre>
              </div>
            </div>
          </section>

          <section data-pane="diff" id="tab-diff" class="hidden flex flex-col p-container-padding gap-component-gap overflow-y-auto custom-scrollbar">
            <div class="flex items-center justify-between gap-3 flex-wrap">
              <h2 class="font-h2 text-h2 text-on-surface flex items-center gap-2">${icon("difference", 18, "text-outline")}<span>Diff <span class="font-ribbon text-ribbon text-on-surface-variant">(<code class="font-code text-code">git diff</code> over <code class="font-code text-code">app_dest</code>)</span></span></h2>
              <div class="flex items-center gap-2 font-ribbon text-ribbon">
                <span class="text-on-surface-variant">Mode:</span>
                <select id="diff-mode" onchange="loadDiff()" class="bg-surface-container-lowest border border-outline-variant rounded-DEFAULT px-2 py-1 font-code text-code text-on-surface focus:border-primary-container focus:outline-none">
                  <option value="summary" selected>summary</option>
                  <option value="working">working patch</option>
                  <option value="staged">staged patch</option>
                  <option value="all">all patch</option>
                </select>
              </div>
            </div>
            <pre id="diff-body" class="bg-[#070908] border border-outline-variant rounded-DEFAULT p-3 font-code text-[12px] text-on-surface-variant leading-relaxed min-h-[400px] overflow-auto custom-scrollbar">Loading…</pre>
          </section>
        </div>

        <aside class="hidden" aria-hidden="true">
          ${activityRail(events)}
        </aside>
      </div>

      <pre id="cmd-result" class="bg-surface-container-lowest border border-outline-variant rounded-DEFAULT p-3 font-code text-[11px] text-on-surface-variant leading-tight whitespace-pre-wrap empty:hidden"></pre>
    </div>

    <script>
      window.RDS_BUILD_ID = ${JSON.stringify(id)};
      ${clientScript()}
      ${detailScript(row.running)}
      ${chatScript()}
    </script>
  `, { nav: "builds", topbarTab: "builds" }));
});

app.get("/b/:id/events.json", (c) => {
  const id = c.req.param("id");
  if (!existingBuildDirForId(id)) return c.text("not found", 404);
  return c.json(readEvents(id).lines.map((l) => {
    try { return JSON.parse(l); } catch { return { raw: l }; }
  }));
});

app.get("/b/:id/state.json", (c) => {
  const id = c.req.param("id");
  const dir = existingBuildDirForId(id);
  if (!dir) return c.text("not found", 404);
  const path = existingFileIn(dir, "state.json");
  if (!path) return c.text("not found", 404);
  c.header("Content-Type", "application/json; charset=utf-8");
  try { return c.body(readFileSync(path, "utf8")); } catch { return c.text("not found", 404); }
});

app.get("/b/:id/evidence-ledger.json", (c) => {
  const id = c.req.param("id");
  const dir = existingBuildDirForId(id);
  if (!dir) return c.text("not found", 404);
  const path = existingFileIn(dir, "evidence-ledger.json");
  if (!path) return c.text("not found", 404);
  c.header("Content-Type", "application/json; charset=utf-8");
  try { return c.body(readFileSync(path, "utf8")); } catch { return c.text("not found", 404); }
});

app.get("/b/:id/truth.json", (c) => {
  const id = c.req.param("id");
  const dir = existingBuildDirForId(id);
  if (!dir) return c.text("not found", 404);
  const path = existingFileIn(dir, "truth.json");
  if (!path) return c.text("not found", 404);
  c.header("Content-Type", "application/json; charset=utf-8");
  try { return c.body(readFileSync(path, "utf8")); } catch { return c.text("not found", 404); }
});

const LIVE_HEALTH_CACHE = new Map<string, { ts: number; ok: boolean; status: number; checkedAt: string }>();
const LIVE_HEALTH_TTL_MS = 25_000;

app.get("/b/:id/live-health.json", async (c) => {
  const id = c.req.param("id");
  const info = readServiceInfo(id);
  const url = info?.url || "";
  if (!url || !url.startsWith("http")) return c.json({ ok: false, status: 0, url, reason: "no-url" });
  const cached = LIVE_HEALTH_CACHE.get(url);
  if (cached && Date.now() - cached.ts < LIVE_HEALTH_TTL_MS) {
    return c.json({ ok: cached.ok, status: cached.status, url, checkedAt: cached.checkedAt, cached: true });
  }
  let status = 0; let ok = false;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6_000);
    const resp = await fetch(url, { method: "GET", signal: ctrl.signal, redirect: "follow" });
    clearTimeout(t);
    status = resp.status;
    ok = resp.status >= 200 && resp.status < 400;
  } catch {
    status = 0; ok = false;
  }
  const entry = { ts: Date.now(), ok, status, checkedAt: new Date().toISOString() };
  LIVE_HEALTH_CACHE.set(url, entry);
  return c.json({ ok, status, url, checkedAt: entry.checkedAt, cached: false });
});

app.get("/b/:id/build-summary.json", (c) => {
  const id = c.req.param("id");
  const dir = join(BUILDS_DIR, id);
  if (!existsSync(dir)) return c.json({ ok: false, error: "not found" }, 404);
  const state = safeReadJson<StateJson>(join(dir, "state.json")) || {};
  return c.json({ ok: true, brief: readBuildBrief(id, state, readBuildRow(id)) });
});

app.get("/b/:id/docs/raw", (c) => {
  const id = c.req.param("id");
  const key = c.req.query("key") || "";
  if (!key || !/^[a-z0-9_-]{2,80}$/i.test(key)) return c.text("invalid document key", 400);
  const doc = findBuildInputDoc(id, key);
  if (!doc) return c.text("document not found", 404);
  const download = c.req.query("download") === "1";
  const filename = basename(doc.pathLabel || doc.path).replace(/[^a-z0-9._-]+/gi, "-") || `${key}.txt`;
  c.header("Content-Type", "text/plain; charset=utf-8");
  if (download) c.header("Content-Disposition", `attachment; filename="${filename}"`);
  return c.body(tailFile(doc.path, 1024 * 1024));
});

app.get("/b/:id/agent-sessions.json", (c) => {
  const id = c.req.param("id");
  if (!existsSync(join(BUILDS_DIR, id))) return c.json({ ok: false, error: "not found" }, 404);
  return c.json({ ok: true, sessions: listAgentSessions(id) });
});

app.post("/b/:id/agent-sessions", async (c) => {
  const id = c.req.param("id");
  const denied = tokenGate(c);
  if (denied) {
    appendAudit({ route: "POST /b/:id/agent-sessions", build_id: id, outcome: "denied", status: denied.status, ip: callerIp(c), ua: callerUa(c) });
    return denied;
  }
  const dir = join(BUILDS_DIR, id);
  if (!existsSync(dir)) return c.json({ ok: false, error: "not found" }, 404);
  const body = (await c.req.json().catch(() => ({}))) as { provider?: string; mode?: string; task?: string; confirm?: string; repo?: string; base_branch?: string };
  if (body.confirm !== "LAUNCH_AGENT") return c.json({ ok: false, error: "confirmation required" }, 409);
  const provider = body.provider === "codex" ? "codex" : "claude-code";
  const mode = body.mode === "print" ? "print" : "interactive";
  const task = (body.task || "").trim();
  if (task.length < 8) return c.json({ ok: false, error: "task is required" }, 400);
  const state = safeReadJson<StateJson>(join(dir, "state.json")) || {};
  const repo = (body.repo || state.app_dest || resolveAppDest(dir) || "").trim();
  if (!repo) return c.json({ ok: false, error: "no repo/app_dest recorded for this build" }, 400);
  const args = [`--build-id=${id}`, `--provider=${provider}`, `--mode=${mode}`, `--repo=${repo}`, `--task=${task}`, "--started-by=dashboard"];
  if (body.base_branch) args.push(`--base-branch=${body.base_branch}`);
  const child = spawn(join(RDS_ROOT, "bin", "rds-agent-start"), args, { cwd: RDS_ROOT, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, RDS_NOTIFY_DISABLED: "1" } });
  let stdout = "", stderr = "";
  child.stdout.on("data", (d) => (stdout += d.toString()));
  child.stderr.on("data", (d) => (stderr += d.toString()));
  const exitCode = await new Promise<number>((resolve) => child.on("close", (code) => resolve(code ?? 1)));
  appendAudit({ route: "POST /b/:id/agent-sessions", build_id: id, outcome: exitCode === 0 ? "ok" : "error", status: exitCode === 0 ? 200 : 500, ip: callerIp(c), ua: callerUa(c), note: `provider=${provider}` });
  return c.json({ ok: exitCode === 0, exitCode, stdout, stderr }, exitCode === 0 ? 200 : 500);
});

app.post("/agent-sessions", async (c) => {
  const denied = tokenGate(c);
  if (denied) {
    appendAudit({ route: "POST /agent-sessions", outcome: "denied", status: denied.status, ip: callerIp(c), ua: callerUa(c) });
    return denied;
  }
  const body = (await c.req.json().catch(() => ({}))) as { provider?: string; mode?: string; task?: string; confirm?: string; repo?: string; base_branch?: string };
  if (body.confirm !== "LAUNCH_AGENT") return c.json({ ok: false, error: "confirmation required" }, 409);
  const provider = body.provider === "codex" ? "codex" : "claude-code";
  const mode = body.mode === "print" ? "print" : "interactive";
  const task = (body.task || "").trim();
  const repo = (body.repo || "").trim();
  if (task.length < 8) return c.json({ ok: false, error: "task is required" }, 400);
  if (!repo.startsWith("/")) return c.json({ ok: false, error: "repo must be an absolute path" }, 400);
  const args = [`--provider=${provider}`, `--mode=${mode}`, `--repo=${repo}`, `--task=${task}`, "--started-by=dashboard"];
  if (body.base_branch) args.push(`--base-branch=${body.base_branch}`);
  const child = spawn(join(RDS_ROOT, "bin", "rds-agent-start"), args, { cwd: RDS_ROOT, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, RDS_NOTIFY_DISABLED: "1" } });
  let stdout = "", stderr = "";
  child.stdout.on("data", (d) => (stdout += d.toString()));
  child.stderr.on("data", (d) => (stderr += d.toString()));
  const exitCode = await new Promise<number>((resolve) => child.on("close", (code) => resolve(code ?? 1)));
  appendAudit({ route: "POST /agent-sessions", outcome: exitCode === 0 ? "ok" : "error", status: exitCode === 0 ? 200 : 500, ip: callerIp(c), ua: callerUa(c), note: `provider=${provider}` });
  return c.json({ ok: exitCode === 0, exitCode, stdout, stderr }, exitCode === 0 ? 200 : 500);
});

app.post("/agent-sessions/:sid/action", async (c) => {
  const sid = c.req.param("sid");
  const denied = tokenGate(c);
  if (denied) {
    appendAudit({ route: "POST /agent-sessions/:sid/action", outcome: "denied", status: denied.status, ip: callerIp(c), ua: callerUa(c) });
    return denied;
  }
  const body = (await c.req.json().catch(() => ({}))) as { action?: string; provider?: string; task?: string; confirm?: string };
  const action = body.action || "status";
  let cmd = "";
  let args: string[] = [sid];
  if (action === "status") cmd = "rds-agent-status";
  else if (action === "diff") cmd = "rds-agent-diff";
  else if (action === "stop") {
    if (body.confirm !== "STOP_AGENT") return c.json({ ok: false, error: "confirmation required" }, 409);
    cmd = "rds-agent-stop";
  } else if (action === "discard") {
    if (body.confirm !== "DISCARD") return c.json({ ok: false, error: "confirmation required" }, 409);
    cmd = "rds-agent-discard"; args = [sid, "--confirm=DISCARD"];
  } else if (action === "merge") {
    if (body.confirm !== "MERGE") return c.json({ ok: false, error: "confirmation required" }, 409);
    cmd = "rds-agent-merge"; args = [sid, "--confirm=MERGE"];
  } else if (action === "review") {
    if (body.confirm !== "REVIEW_AGENT") return c.json({ ok: false, error: "confirmation required" }, 409);
    cmd = "rds-agent-review"; args = [sid, `--provider=${body.provider === "claude-code" ? "claude-code" : "codex"}`];
  } else if (action === "handoff") {
    if (body.confirm !== "HANDOFF_AGENT") return c.json({ ok: false, error: "confirmation required" }, 409);
    const task = (body.task || "").trim();
    if (task.length < 8) return c.json({ ok: false, error: "handoff task is required" }, 400);
    cmd = "rds-agent-handoff"; args = [sid, `--to=${body.provider === "claude-code" ? "claude-code" : "codex"}`, `--task=${task}`];
  } else {
    return c.json({ ok: false, error: "unknown action" }, 400);
  }
  const run = spawnSync(join(RDS_ROOT, "bin", cmd), args, { cwd: RDS_ROOT, encoding: "utf8", timeout: action === "review" ? 180000 : 30000, env: { ...process.env, RDS_NOTIFY_DISABLED: "1" } });
  appendAudit({ route: "POST /agent-sessions/:sid/action", outcome: run.status === 0 ? "ok" : "error", status: run.status === 0 ? 200 : 500, ip: callerIp(c), ua: callerUa(c), note: `${action} ${sid}` });
  return c.json({ ok: run.status === 0, exitCode: run.status, stdout: run.stdout, stderr: run.stderr }, run.status === 0 ? 200 : 500);
});

app.post("/b/:id/build-summary", (c) => {
  const id = c.req.param("id");
  const denied = tokenGate(c);
  if (denied) {
    appendAudit({ route: "POST /b/:id/build-summary", build_id: id, outcome: "denied", status: denied.status, ip: callerIp(c), ua: callerUa(c) });
    return denied;
  }
  const result = startBuildBriefGeneration(id);
  appendAudit({
    route: "POST /b/:id/build-summary",
    build_id: id,
    outcome: result.ok ? "ok" : "error",
    status: result.status,
    ip: callerIp(c),
    ua: callerUa(c),
    note: result.error,
  });
  return c.json(result, { status: (result.status || 200) as 200 | 404 | 500 });
});

app.get("/b/:id/timing.json", (c) => {
  const id = c.req.param("id");
  const dir = existingBuildDirForId(id);
  if (!dir) return c.json({ ok: false, error: "not found" }, 404);
  const path = existingFileIn(dir, "timing.json");
  if (!path) return c.json({ ok: false, error: "no timing.json yet" }, 404);
  c.header("Content-Type", "application/json; charset=utf-8");
  try { return c.body(readFileSync(path, "utf8")); } catch { return c.text("not found", 404); }
});

app.get("/b/:id/logs.json", (c) => {
  const id = c.req.param("id");
  if (!existingBuildDirForId(id)) return c.text("not found", 404);
  return c.json({ build_id: id, logs: logManifest(id) });
});

app.all("/b/:id/preview-proxy/*", async (c) => {
  const id = c.req.param("id");
  const row = readBuildRow(id);
  if (!row.preview || isPendingPreview(row.preview)) return c.text("preview not available", 404);
  let upstream: URL;
  try {
    upstream = new URL(row.preview);
  } catch {
    return c.text("invalid preview url", 400);
  }

  const prefix = `/b/${encodeURIComponent(id)}/preview-proxy`;
  const suffix = c.req.path.startsWith(prefix) ? c.req.path.slice(prefix.length) || "/" : "/";
  upstream.pathname = suffix;
  upstream.search = new URL(c.req.url).search;

  const method = c.req.method;
  const headers = new Headers(c.req.raw.headers);
  headers.set("host", upstream.host);
  headers.set("accept-encoding", "identity");
  headers.delete("authorization");
  headers.delete("cookie");

  const body = method === "GET" || method === "HEAD" ? undefined : await c.req.arrayBuffer();
  const resp = await fetch(upstream, { method, headers, body, redirect: "manual", signal: AbortSignal.timeout(8000) }).catch((err) => err instanceof Error ? err : new Error(String(err)));
  if (resp instanceof Error) return c.text(`preview proxy failed: ${resp.message}`, 502);

  const outHeaders = new Headers(resp.headers);
  outHeaders.delete("x-frame-options");
  outHeaders.delete("content-security-policy");
  outHeaders.delete("set-cookie");
  outHeaders.delete("content-encoding");
  outHeaders.delete("content-length");

  const loc = resp.headers.get("location");
  if (loc) {
    try {
      const next = new URL(loc, upstream);
      if (next.origin === new URL(row.preview).origin) {
        outHeaders.set("location", `${prefix}${next.pathname}${next.search}`);
      }
    } catch { /* keep upstream location */ }
  }

  const contentType = resp.headers.get("content-type") || "";
  if (contentType.includes("text/html")) {
    const html = await resp.text();
    const rewritten = html
      .replace(/\b(href|src|action)=["']\/(?!\/)/g, `$1="${prefix}/`)
      .replace(/\b(srcset)=["']\/(?!\/)/g, `$1="${prefix}/`)
      .replace(/url\((['"]?)\/(?!\/)/g, `url($1${prefix}/`)
      .replace(/(<head[^>]*>)/i, `$1<base href="${prefix}/">`);
    outHeaders.set("content-type", contentType);
    return new Response(rewritten, { status: resp.status, headers: outHeaders });
  }

  if (contentType.includes("javascript") || contentType.includes("typescript")) {
    const js = await resp.text();
    const rewritten = js
      .replace(/(["'])\/(@vite\/|src\/|node_modules\/)/g, `$1${prefix}/$2`)
      .replace(/from\s+["']\/(@vite\/|src\/|node_modules\/)/g, `from "${prefix}/$1`)
      .replace(/import\(["']\/(@vite\/|src\/|node_modules\/)/g, `import("${prefix}/$1`);
    outHeaders.set("content-type", contentType);
    return new Response(rewritten, { status: resp.status, headers: outHeaders });
  }

  return new Response(resp.body, { status: resp.status, headers: outHeaders });
});

app.get("/b/:id/timeline.json", (c) => {
  const id = c.req.param("id");
  const dir = existingBuildDirForId(id);
  if (!dir) return c.text("not found", 404);
  const state = safeReadJson<StateJson>(join(dir, "state.json")) || {};
  return c.json(timelineFromState(state, parseEvents(id)));
});

// Returns the rendered stage bar + timeline list as HTML fragments so
// the detail page can refresh them live on stage_* SSE events without
// a full page reload.
app.get("/b/:id/timeline.html", (c) => {
  const id = c.req.param("id");
  const dir = existingBuildDirForId(id);
  if (!dir) return c.text("not found", 404);
  const state = safeReadJson<StateJson>(join(dir, "state.json")) || {};
  const timeline = timelineFromState(state, parseEvents(id));
  const currentStage = deriveCurrentStage(state);
  const row = readBuildRow(id);
  const skillResolution = readSkillResolution(id);
  return c.json({
    stageBar: stageProgressBar(timeline, row.running ? currentStage : undefined, row.paused ? currentStage : undefined),
    stageSummaries: renderStageSummaryPanel(id, stageSummaries(id, timeline), skillResolution),
    list: renderTimelineList(timeline, skillResolution),
    currentStage: currentStage ?? null,
    previewUrl: row.preview ?? null,
    running: row.running,
    status: row.status ?? null,
    reviewStatus: row.reviewStatus ?? null,
  });
});

app.get("/b/:id/scaffold-progress.json", (c) => {
  const id = c.req.param("id");
  const dir = join(BUILDS_DIR, id);
  if (!existsSync(dir)) return c.text("not found", 404);
  const state = safeReadJson<StateJson>(join(dir, "state.json")) || {};
  const row = readBuildRow(id);
  const progress = readScaffoldProgress(id);
  const visible = shouldShowScaffoldProgress(state, progress);
  return c.json({
    ...progress,
    visible,
    html: visible ? renderScaffoldProgress(progress, "full", row.paused) : "",
    compactHtml: visible ? renderScaffoldProgress(progress, "compact", row.paused) : "",
  });
});

app.get("/b/:id/log/:stage", (c) => {
  const id = c.req.param("id");
  const stage = c.req.param("stage");
  const dir = existingBuildDirForId(id);
  if (!dir) return c.text("not found", 404);
  if (!/^[a-z0-9_-]+\.log$/i.test(stage)) return c.text("invalid stage filename", 400);
  const path = existingFileIn(dir, "logs", stage);
  if (!path) return c.text("not found", 404);
  c.header("Content-Type", "text/plain; charset=utf-8");
  return c.body(tailFile(path, 256 * 1024));
});

app.get("/b/:id/stream", (c) => {
  const id = c.req.param("id");
  const dir = existingBuildDirForId(id);
  if (!dir) return c.text("not found", 404);
  const path = join(dir, "events.jsonl");

  c.header("Content-Type", "text/event-stream");
  c.header("Cache-Control", "no-cache");
  c.header("X-Accel-Buffering", "no");

  return stream(c, async (s) => {
    // No backlog: the page is already rendered server-side with the activity
    // rail and current state. Replaying old events on every reconnect causes
    // duplicate toasts (e.g. "Fixer completed" looping) and churn.
    let lastSize = existsSync(path) ? statSync(path).size : 0;
    let lastBeat = Date.now();
    while (!s.aborted) {
      await s.sleep(1500);
      if (existsSync(path)) {
        const next = readEvents(id, lastSize);
        lastSize = next.size;
        for (const line of next.lines) await s.write(`data: ${line}\n\n`);
      }
      // Heartbeat every ~15s so proxies don't drop the SSE on idle builds.
      if (Date.now() - lastBeat > 15000) {
        await s.write(`: keepalive\n\n`);
        lastBeat = Date.now();
      }
    }
  });
});

app.get("/b/:id/log", (c) => {
  const id = c.req.param("id");
  if (!existingBuildDirForId(id)) return c.text("not found", 404);

  c.header("Content-Type", "text/event-stream");
  c.header("Cache-Control", "no-cache");
  c.header("X-Accel-Buffering", "no");

  return stream(c, async (s) => {
    const TAIL_LINES = 200;
    let currentPath = "";
    let lastSize = 0;
    let lastBeat = Date.now();
    const switchSource = async (source: LogEntry) => {
      currentPath = source.path;
      const buf = readFileSync(source.path, "utf8");
      lastSize = Buffer.byteLength(buf, "utf8");
      const lines = buf.split("\n");
      const tail = lines.slice(Math.max(0, lines.length - TAIL_LINES - 1));
      await s.write(`event: source\ndata: ${JSON.stringify({ label: source.label, path: source.path, durable: source.durable })}\n\n`);
      await s.write(`data: ━━ tailing ${source.label} ━━\n\n`);
      for (const line of tail) {
        const clean = line.includes("\r") ? line.split("\r").pop()! : line;
        if (clean.length === 0) continue;
        if (s.aborted) return;
        await s.write(`data: ${clean}\n\n`);
      }
      lastBeat = Date.now();
    };
    const initial = liveLogSource(id);
    if (initial) await switchSource(initial);
    while (!s.aborted) {
      const source = liveLogSource(id);
      if (!source) {
        if (Date.now() - lastBeat > 15000) {
          await s.write(`: keepalive\n\n`);
          lastBeat = Date.now();
        }
        await s.sleep(1000);
        continue;
      }
      if (source.path !== currentPath) {
        await switchSource(source);
        await s.sleep(800);
        continue;
      }
      const stats = statSync(source.path);
      if (stats.size > lastSize) {
        const text = readFileSync(source.path, "utf8").slice(lastSize);
        lastSize = stats.size;
        for (const line of text.split("\n")) {
          const clean = line.includes("\r") ? line.split("\r").pop()! : line;
          if (clean.length === 0) continue;
          await s.write(`data: ${clean}\n\n`);
        }
        lastBeat = Date.now();
      } else if (stats.size < lastSize) { lastSize = 0; }
      // Heartbeat every ~15s so proxies don't drop the SSE on idle builds.
      if (Date.now() - lastBeat > 15000) {
        await s.write(`: keepalive\n\n`);
        lastBeat = Date.now();
      }
      await s.sleep(800);
    }
  });
});

app.post("/b/:id/cmd", async (c) => {
  const id = c.req.param("id");
  const denied = tokenGate(c);
  if (denied) {
    appendAudit({ route: "POST /b/:id/cmd", build_id: id, outcome: "denied", status: denied.status, ip: callerIp(c), ua: callerUa(c) });
    return denied;
  }
  const dir = join(BUILDS_DIR, id);
  if (!existsSync(dir)) return c.text("not found", 404);

  const body = (await c.req.json().catch(() => ({}))) as { verb?: string; args?: string[] };
  const verb = body.verb;
  if (!verb || !ALLOWED_VERBS.has(verb)) {
    appendAudit({ route: "POST /b/:id/cmd", build_id: id, verb, outcome: "error", status: 400, ip: callerIp(c), ua: callerUa(c), note: "bad verb" });
    return c.text(`verb must be one of ${[...ALLOWED_VERBS].join(", ")}`, 400);
  }
  appendAudit({ route: "POST /b/:id/cmd", build_id: id, verb, outcome: "ok", ip: callerIp(c), ua: callerUa(c) });
  const extra = Array.isArray(body.args)
    ? body.args.filter((a) => typeof a === "string" && !a.startsWith("-")).slice(0, 8)
    : [];
  const cmd = join(RDS_ROOT, "bin", `rds-${verb}`);
  if (!existsSync(cmd)) return c.text(`bin/rds-${verb} missing`, 500);
  const cmdArgs = verb === "resume" ? [id, "--detach", ...extra] : [id, ...extra];

  const child = spawn(cmd, cmdArgs, {
    cwd: RDS_ROOT, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, RDS_NOTIFY_DISABLED: "1" }
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", (d) => (stdout += d.toString()));
  child.stderr.on("data", (d) => (stderr += d.toString()));
  const exitCode = await new Promise<number>((resolve) => child.on("close", (c) => resolve(c ?? 1)));
  return c.json({ verb, exitCode, stdout, stderr });
});

app.post("/b/:id/fix", async (c) => {
  const id = c.req.param("id");
  const denied = tokenGate(c);
  if (denied) {
    appendAudit({ route: "POST /b/:id/fix", build_id: id, outcome: "denied", status: denied.status, ip: callerIp(c), ua: callerUa(c) });
    return denied;
  }
  if (!existsSync(join(BUILDS_DIR, id))) return c.text("not found", 404);
  appendAudit({ route: "POST /b/:id/fix", build_id: id, outcome: "ok", ip: callerIp(c), ua: callerUa(c) });

  const cmd = join(RDS_ROOT, "bin", "rds-fix");
  if (!existsSync(cmd)) {
    return c.json({
      ok: false, error: "bin/rds-fix missing on this RDS checkout. Pull latest and re-run bootstrap."
    }, 500);
  }
  // Long-running; spawn detached and return immediately.
  const child = spawn(cmd, [id], {
    cwd: RDS_ROOT, stdio: "ignore", detached: true,
    env: { ...process.env, RDS_NOTIFY_DISABLED: "1" }
  });
  child.unref();
  return c.json({ ok: true, pid: child.pid, hint: "watch builds/" + id + "/fixer-*.md" });
});

app.post("/b/:id/iterate", async (c) => {
  const id = c.req.param("id");
  const denied = tokenGate(c);
  if (denied) {
    appendAudit({ route: "POST /b/:id/iterate", build_id: id, outcome: "denied", status: denied.status, ip: callerIp(c), ua: callerUa(c) });
    return denied;
  }
  const dir = join(BUILDS_DIR, id);
  if (!existsSync(dir)) return c.text("not found", 404);

  const body = (await c.req.json().catch(() => ({}))) as { prompt?: string; confirm?: string; provider?: string; model?: string };
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (prompt.length < 8) {
    appendAudit({ route: "POST /b/:id/iterate", build_id: id, outcome: "error", status: 400, ip: callerIp(c), ua: callerUa(c), note: "prompt too short" });
    return c.json({ ok: false, error: "Iteration prompt is required." }, 400);
  }
  if (body.confirm !== "ITERATE") {
    appendAudit({ route: "POST /b/:id/iterate", build_id: id, outcome: "denied", status: 409, ip: callerIp(c), ua: callerUa(c), note: "missing confirmation" });
    return c.json({ ok: false, error: "Confirmation required." }, 409);
  }
  const provider = normalizeProviderChoice(body.provider);
  const model = typeof body.model === "string" ? body.model.trim() : "";
  if (model && !MODEL_ID_RE.test(model)) {
    return c.json({ ok: false, error: "Invalid model id." }, 400);
  }

  const cmd = join(RDS_ROOT, "bin", "rds-iterate");
  if (!existsSync(cmd)) {
    return c.json({ ok: false, error: "bin/rds-iterate missing on this RDS checkout. Pull latest and re-run bootstrap." }, 500);
  }

  applyInferenceChoice(id, provider, model);
  appendAudit({ route: "POST /b/:id/iterate", build_id: id, outcome: "ok", ip: callerIp(c), ua: callerUa(c), note: `prompt_chars=${prompt.length} provider=${provider || "default"} model=${model || "default"}` });

  const child = spawn(cmd, [id, "--yes"], {
    cwd: RDS_ROOT, stdio: ["pipe", "ignore", "ignore"], detached: true,
    env: { ...process.env, RDS_NOTIFY_DISABLED: "1" }
  });
  child.stdin.end(prompt);
  child.unref();
  return c.json({ ok: true, pid: child.pid, hint: "watch builds/" + id + "/iterate-*.summary.json" });
});

app.post("/b/:id/goal", async (c) => {
  const id = c.req.param("id");
  const denied = tokenGate(c);
  if (denied) {
    appendAudit({ route: "POST /b/:id/goal", build_id: id, outcome: "denied", status: denied.status, ip: callerIp(c), ua: callerUa(c) });
    return denied;
  }
  const dir = join(BUILDS_DIR, id);
  if (!existsSync(dir)) return c.text("not found", 404);
  const body = (await c.req.json().catch(() => ({}))) as { objective?: string; confirm?: string; max_cycles?: number; provider?: string; model?: string };
  const objective = typeof body.objective === "string" && body.objective.trim().length >= 8
    ? body.objective.trim()
    : "Make this build review-ready.";
  if (body.confirm !== "GOAL") {
    appendAudit({ route: "POST /b/:id/goal", build_id: id, outcome: "denied", status: 409, ip: callerIp(c), ua: callerUa(c), note: "missing confirmation" });
    return c.json({ ok: false, error: "Confirmation required." }, 409);
  }
  const provider = normalizeProviderChoice(body.provider);
  const model = typeof body.model === "string" ? body.model.trim() : "";
  if (model && !MODEL_ID_RE.test(model)) {
    return c.json({ ok: false, error: "Invalid model id." }, 400);
  }
  const existing = readGoalState(id);
  if (goalLooksFreshRunning(existing)) {
    return c.json({ ok: false, error: "A goal loop is already marked running for this build." }, 409);
  }
  const cmd = join(RDS_ROOT, "bin", "rds-goal");
  if (!existsSync(cmd)) {
    return c.json({ ok: false, error: "bin/rds-goal missing on this RDS checkout. Pull latest and re-run bootstrap." }, 500);
  }
  const maxCycles = Number.isFinite(body.max_cycles) ? Math.max(1, Math.min(24, Number(body.max_cycles))) : 12;
  const goalArgs = [id, `--objective=${objective}`, `--max-cycles=${maxCycles}`];
  if (provider) goalArgs.push(`--provider=${provider}`);
  if (model) goalArgs.push(`--model=${model}`);
  appendAudit({ route: "POST /b/:id/goal", build_id: id, outcome: "ok", ip: callerIp(c), ua: callerUa(c), note: `objective_chars=${objective.length} max_cycles=${maxCycles} provider=${provider || "default"} model=${model || "default"}` });
  const child = spawn(cmd, goalArgs, {
    cwd: RDS_ROOT, stdio: "ignore", detached: true,
    env: { ...process.env, RDS_NOTIFY_DISABLED: "1", RDS_ZO_REUSE_EXISTING: "1" }
  });
  child.unref();
  return c.json({ ok: true, pid: child.pid, hint: "watch builds/" + id + "/goal.json and builds/" + id + "/goals/" });
});

// ---------- Playwright QA (TD-025 v0) --------------------------------------
// builds/<id>/playwright/iter-NNN/{summary.json,gaps.json,screen-*.png,run.log}
// Each iteration is one crawler pass. The dashboard surfaces the latest
// iteration by default and lets the operator scrub through prior runs.

interface QaIterationSummary {
  baseUrl: string;
  startedAt: string;
  finishedAt: string;
  pagesVisited: number;
  totalElements: number;
  gapsFound: number;
  durationMs: number;
  converged: boolean;
  pages: Array<{ url: string; title: string; status: number; screenshot?: string; consoleErrors?: string[] }>;
  gaps: Array<{ kind: string; url: string; selector: string; observed: string; fixHint: string }>;
}

interface QaSpecVerdict {
  overall: "pass" | "partial" | "fail" | "unknown";
  requirements: Array<{
    id: string;
    text: string;
    status: "verified" | "partially_verified" | "not_verified" | "not_applicable";
    critical?: boolean;
    evidence?: string[];
    notes?: string;
  }>;
  limitations?: string[];
}

interface QaGameVerdict {
  status: "pass" | "needs_iteration" | "fail" | "unknown";
  score: number;
  threshold: number;
  subScores?: Record<string, number>;
  playtest?: {
    durationMs?: number;
    changedPhases?: number;
    phases?: Array<{
      phase: string;
      actions?: string[];
      changed?: boolean;
      elapsedMs?: number;
      screenshot?: string;
    }>;
  };
  criteria: Array<{
    name: string;
    ok: boolean;
    points: number;
    evidence: string;
  }>;
  screenshots?: string[];
}

function qaIterationOrigin(id: string, iteration: number): string {
  const events = parseEvents(id);
  const event = events.find((e) =>
    e.event === "qa_iteration_completed" &&
    String(e.payload?.iteration ?? "") === String(iteration)
  );
  if (!event) return "manual";
  const ts = event.ts || "";
  const hadFixerRetry = events.some((e) =>
    e.event === "fixer_retry_started" &&
    (!e.ts || !ts || e.ts <= ts)
  );
  const hadPendingReview = events.some((e) =>
    e.event === "build_pending_review" &&
    (!e.ts || !ts || e.ts < ts)
  );
  if (hadPendingReview) return "manual verification";
  if (hadFixerRetry) return "watchdog retry";
  return "pipeline";
}

function qaIterationsSummary(id: string, iters: { name: string; index: number; mtime: number }[]): string {
  if (!iters.length) return "No Playwright QA iterations have run yet.";
  const ordered = [...iters].sort((a, b) => a.index - b.index);
  const parts = ordered.map((it) => {
    const summary = safeReadJson<QaIterationSummary>(join(BUILDS_DIR, id, "playwright", it.name, "summary.json"));
    const gameVerdict = safeReadJson<QaGameVerdict>(join(BUILDS_DIR, id, "playwright", it.name, "game-verdict.json"));
    const gapCount = typeof summary?.gapsFound === "number" ? summary.gapsFound : null;
    const status = summary?.converged ? "passed"
      : gapCount !== null ? `${gapCount} gap${gapCount === 1 ? "" : "s"}`
      : summary ? "completed" : "failed";
    const game = gameVerdict ? `, game ${gameVerdict.status} ${gameVerdict.score}` : "";
    return `${it.name}: ${qaIterationOrigin(id, it.index)}, ${status}${game}`;
  });
  return `Playwright runs one crawl per iteration. ${parts.join(" · ")}.`;
}

function listQaIterations(id: string): { name: string; index: number; mtime: number }[] {
  const dir = join(BUILDS_DIR, id, "playwright");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^iter-\d+$/.test(e.name))
    .map((e) => {
      const mt = fileMtimeMs(join(dir, e.name));
      const idx = Number(e.name.replace(/^iter-0*/, "")) || 0;
      return { name: e.name, index: idx, mtime: mt };
    })
    .sort((a, b) => b.index - a.index);
}

app.get("/b/:id/playwright", async (c) => {
  const id = c.req.param("id");
  if (!existsSync(join(BUILDS_DIR, id))) return c.text("not found", 404);

  const iters = listQaIterations(id);
  const wantIter = c.req.query("iter");
  const selected = wantIter
    ? iters.find((it) => it.name === wantIter || String(it.index) === wantIter)
    : iters[0];

  const buildState = safeReadJson<StateJson>(join(BUILDS_DIR, id, "state.json")) || {};
  const previewRaw = (() => {
    try { return readFileSync(join(BUILDS_DIR, id, "preview-url.txt"), "utf8").trim(); }
    catch { return ""; }
  })();
  const canRunQa = !!previewRaw && previewRaw !== "<none>";

  let bodyHtml = "";

  if (!iters.length) {
    bodyHtml = `<div class="bg-surface-container border border-outline-variant rounded-DEFAULT p-4 flex items-start gap-3">
      ${icon("info", 18, "text-on-surface-variant shrink-0 mt-0.5")}
      <div class="flex-1 font-body text-body text-on-surface-variant">
        <div class="font-bold text-on-surface mb-0.5">No QA runs yet</div>
        <div>The Playwright crawler runs automatically as the last stage of <code class="font-code text-code">bin/rds-build</code>. You can also kick off a one-shot pass below — it crawls the deployed URL, BFS to depth 2, captures dead anchors, console errors, and 4xx/5xx responses.</div>
      </div>
    </div>`;
  } else if (!selected) {
    bodyHtml = `<p class="text-on-surface-variant font-body text-body italic">Iteration not found.</p>`;
  } else {
    const iterDir = join(BUILDS_DIR, id, "playwright", selected.name);
    const summary = safeReadJson<QaIterationSummary>(join(iterDir, "summary.json"));
    const gaps    = safeReadJson<QaIterationSummary["gaps"]>(join(iterDir, "gaps.json")) || [];
    const verdict = safeReadJson<QaSpecVerdict>(join(iterDir, "spec-verdict.json"));
    const gameVerdict = safeReadJson<QaGameVerdict>(join(iterDir, "game-verdict.json"));
    const runLog  = (() => {
      try { return readFileSync(join(iterDir, "run.log"), "utf8").slice(-4000); }
      catch { return ""; }
    })();

    const fileBase = `/b/${encodeURIComponent(id)}/playwright/file/${encodeURIComponent(selected.name)}`;

    if (summary) {
      const gapCount = typeof summary.gapsFound === "number" ? summary.gapsFound : gaps.length;
      const statusBadge = summary.converged
        ? `<span class="inline-flex items-center gap-1 bg-success/15 text-success px-2 py-0.5 rounded-DEFAULT font-ribbon text-ribbon">${icon("check_circle", 14)}<span>converged</span></span>`
        : `<span class="inline-flex items-center gap-1 bg-warn-container/30 text-warn px-2 py-0.5 rounded-DEFAULT font-ribbon text-ribbon">${icon("warning", 14)}<span>${gapCount} gap${gapCount === 1 ? "" : "s"}</span></span>`;

      const gapsByKind: Record<string, number> = {};
      for (const g of gaps) gapsByKind[g.kind] = (gapsByKind[g.kind] || 0) + 1;
      const kindChips = Object.entries(gapsByKind).map(([k, n]) =>
        `<span class="inline-flex items-center gap-1 bg-surface border border-outline-variant px-2 py-0.5 rounded-DEFAULT font-code text-[11px] text-on-surface-variant"><span>${escapeHtml(k)}</span><span class="text-on-surface">${n}</span></span>`
      ).join("");

      const pagesHtml = (summary.pages || []).map((p) => {
        const shotUrl = p.screenshot ? `${fileBase}/${encodeURIComponent(p.screenshot)}` : "";
        const statusCls =
          p.status >= 500 ? "text-error"
          : p.status >= 400 ? "text-warn"
          : "text-on-surface-variant";
        return `<figure class="bg-surface border border-outline-variant rounded-DEFAULT overflow-hidden flex flex-col">
          ${shotUrl ? `<a href="${shotUrl}" target="_blank" class="block bg-[#070908]"><img src="${shotUrl}" alt="${escapeHtml(p.url)}" loading="lazy" class="w-full h-auto block max-h-[200px] object-contain object-top"></a>` : ""}
          <figcaption class="px-3 py-2 border-t border-outline-variant flex flex-col gap-0.5 min-w-0">
            <div class="flex items-center gap-2 text-[11px]"><span class="font-code ${statusCls}">${p.status || "—"}</span><span class="font-body text-on-surface truncate">${escapeHtml(p.title || p.url)}</span></div>
            <div class="font-code text-[10px] text-outline truncate">${escapeHtml(p.url)}</div>
          </figcaption>
        </figure>`;
      }).join("");

      const gapsHtml = gaps.length
        ? `<table class="w-full font-code text-[12px] text-on-surface">
            <thead>
              <tr class="text-left text-on-surface-variant border-b border-outline-variant">
                <th class="px-3 py-2">kind</th>
                <th class="px-3 py-2">url</th>
                <th class="px-3 py-2">selector</th>
                <th class="px-3 py-2">observed</th>
              </tr>
            </thead>
            <tbody>${gaps.slice(0, 50).map((g) => `
              <tr class="border-b border-outline-variant/40 align-top">
                <td class="px-3 py-2 text-warn">${escapeHtml(g.kind)}</td>
                <td class="px-3 py-2 text-on-surface-variant truncate max-w-[200px]" title="${escapeHtml(g.url)}">${escapeHtml(g.url)}</td>
                <td class="px-3 py-2 text-outline truncate max-w-[200px]" title="${escapeHtml(g.selector)}">${escapeHtml(g.selector)}</td>
                <td class="px-3 py-2 text-on-surface-variant">${escapeHtml(g.observed.slice(0, 200))}</td>
              </tr>`).join("")}</tbody>
          </table>${gaps.length > 50 ? `<p class="px-3 py-2 text-on-surface-variant font-body text-body italic">… ${gaps.length - 50} more in <code class="font-code text-code">gaps.json</code>.</p>` : ""}`
        : `<p class="px-3 py-3 text-success font-body text-body flex items-center gap-2">${icon("check_circle", 16)}<span>No gaps found.</span></p>`;

      const origin = qaIterationOrigin(id, selected.index);
      const gameVerdictHtml = gameVerdict ? (() => {
        const palette = gameVerdict.status === "pass"
          ? "bg-success/15 text-success border-success/30"
          : gameVerdict.status === "fail"
            ? "bg-error/15 text-error border-error/30"
            : "bg-warn-container/20 text-warn border-warn/30";
        const criteriaRows = (gameVerdict.criteria || []).map((r) => `
          <tr class="border-b border-outline-variant/40 align-top">
            <td class="px-3 py-2 font-code text-[11px] ${r.ok ? "text-success" : "text-error"} whitespace-nowrap">${r.ok ? "pass" : "miss"}</td>
            <td class="px-3 py-2 font-body text-body text-on-surface">${escapeHtml(r.name.replace(/_/g, " "))}</td>
            <td class="px-3 py-2 font-code text-[11px] text-on-surface-variant">${escapeHtml(String(r.points))}</td>
            <td class="px-3 py-2 font-body text-body text-on-surface-variant">${escapeHtml(r.evidence || "")}</td>
          </tr>`).join("");
        const subScoreHtml = Object.entries(gameVerdict.subScores || {}).map(([name, value]) => {
          const tone = value >= 75 ? "text-success" : value >= 50 ? "text-warn" : "text-error";
          return `<div class="bg-surface border border-outline-variant rounded-DEFAULT p-3">
            <div class="font-code text-[11px] text-on-surface-variant uppercase">${escapeHtml(name.replace(/([A-Z])/g, " $1"))}</div>
            <div class="mt-1 flex items-center gap-2">
              <div class="h-2 bg-outline-variant rounded-full overflow-hidden flex-1"><div class="h-full bg-current ${tone}" style="width:${Math.max(0, Math.min(100, Number(value) || 0))}%"></div></div>
              <span class="font-code text-[12px] ${tone}">${escapeHtml(String(value))}</span>
            </div>
          </div>`;
        }).join("");
        const phaseRows = (gameVerdict.playtest?.phases || []).map((phase) => {
          const shotUrl = phase.screenshot ? `${fileBase}/${encodeURIComponent(phase.screenshot)}` : "";
          return `<tr class="border-b border-outline-variant/40 align-top">
            <td class="px-3 py-2 font-code text-[11px] ${phase.changed ? "text-success" : "text-error"} whitespace-nowrap">${phase.changed ? "changed" : "static"}</td>
            <td class="px-3 py-2 font-body text-body text-on-surface">${escapeHtml(phase.phase || "")}</td>
            <td class="px-3 py-2 font-code text-[11px] text-on-surface-variant">${escapeHtml((phase.actions || []).slice(0, 8).join(" → "))}</td>
            <td class="px-3 py-2 font-code text-[11px] text-outline whitespace-nowrap">${escapeHtml(String(phase.elapsedMs || 0))}ms</td>
            <td class="px-3 py-2 font-code text-[11px]">${shotUrl ? `<a class="text-primary-container hover:underline" target="_blank" href="${shotUrl}">${escapeHtml(phase.screenshot || "screenshot")}</a>` : `<span class="text-outline">—</span>`}</td>
          </tr>`;
        }).join("");
        const shots = (gameVerdict.screenshots || []).map((name) => {
          const url = `${fileBase}/${encodeURIComponent(name)}`;
          return `<a href="${url}" target="_blank" class="block bg-[#070908] border border-outline-variant rounded-DEFAULT overflow-hidden"><img src="${url}" alt="${escapeHtml(name)}" loading="lazy" class="w-full h-auto max-h-[160px] object-contain object-top"><div class="px-2 py-1 border-t border-outline-variant font-code text-[10px] text-outline truncate">${escapeHtml(name)}</div></a>`;
        }).join("");
        return `<section class="bg-surface-container border border-outline-variant rounded-DEFAULT overflow-hidden">
          <header class="px-container-padding py-gutter border-b border-outline-variant flex items-center justify-between gap-3 flex-wrap">
            <div class="flex items-center gap-2">
              <h3 class="font-h3 text-h3 text-on-surface">Game UAT</h3>
              <span class="inline-flex items-center gap-1 border px-2 py-0.5 rounded-DEFAULT font-ribbon text-ribbon ${palette}">${escapeHtml(gameVerdict.status)} · ${escapeHtml(String(gameVerdict.score))}/${escapeHtml(String(gameVerdict.threshold))}</span>
            </div>
            <span class="font-ribbon text-ribbon text-on-surface-variant">Scripted playtest · ${escapeHtml(String(gameVerdict.playtest?.durationMs || 0))}ms · ${escapeHtml(String(gameVerdict.playtest?.changedPhases || 0))} changed phases</span>
          </header>
          ${subScoreHtml ? `<div class="p-container-padding grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-component-gap border-b border-outline-variant">${subScoreHtml}</div>` : ""}
          ${shots ? `<div class="p-container-padding grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-component-gap border-b border-outline-variant">${shots}</div>` : ""}
          ${phaseRows ? `<div class="overflow-x-auto border-b border-outline-variant">
            <table class="w-full text-left">
              <thead><tr class="border-b border-outline-variant text-on-surface-variant font-table text-table"><th class="px-3 py-2">state</th><th class="px-3 py-2">phase</th><th class="px-3 py-2">actions</th><th class="px-3 py-2">elapsed</th><th class="px-3 py-2">shot</th></tr></thead>
              <tbody>${phaseRows}</tbody>
            </table>
          </div>` : ""}
          <div class="overflow-x-auto">
            <table class="w-full text-left">
              <thead><tr class="border-b border-outline-variant text-on-surface-variant font-table text-table"><th class="px-3 py-2">status</th><th class="px-3 py-2">criterion</th><th class="px-3 py-2">pts</th><th class="px-3 py-2">evidence</th></tr></thead>
              <tbody>${criteriaRows || `<tr><td colspan="4" class="px-3 py-3 text-on-surface-variant font-body text-body italic">No criteria recorded.</td></tr>`}</tbody>
            </table>
          </div>
        </section>`;
      })() : "";
      const verdictHtml = verdict ? (() => {
        const palette = verdict.overall === "pass"
          ? "bg-success/15 text-success border-success/30"
          : verdict.overall === "fail"
            ? "bg-error/15 text-error border-error/30"
            : "bg-tertiary-container/15 text-tertiary-container border-tertiary-container/30";
        const rows = (verdict.requirements || []).slice(0, 80).map((r) => {
          const cls = r.status === "verified"
            ? "text-success"
            : r.status === "not_verified"
              ? "text-error"
              : "text-tertiary-container";
          return `<tr class="border-b border-outline-variant/40 align-top">
            <td class="px-3 py-2 font-code text-[11px] text-outline whitespace-nowrap">${escapeHtml(r.id)}</td>
            <td class="px-3 py-2 font-body text-body text-on-surface">${escapeHtml(r.text)}</td>
            <td class="px-3 py-2 font-code text-[11px] ${cls} whitespace-nowrap">${escapeHtml(r.status)}</td>
            <td class="px-3 py-2 font-code text-[11px] ${r.critical ? "text-warn" : "text-outline"} whitespace-nowrap">${r.critical ? "critical" : "standard"}</td>
          </tr>`;
        }).join("");
        return `<section class="bg-surface-container border border-outline-variant rounded-DEFAULT overflow-hidden">
          <header class="px-container-padding py-gutter border-b border-outline-variant flex items-center justify-between gap-3 flex-wrap">
            <div class="flex items-center gap-2">
              <h3 class="font-h3 text-h3 text-on-surface">Spec verdict</h3>
              <span class="inline-flex items-center gap-1 border px-2 py-0.5 rounded-DEFAULT font-ribbon text-ribbon ${palette}">${escapeHtml(verdict.overall)}</span>
            </div>
            <span class="font-ribbon text-ribbon text-on-surface-variant">Deterministic v0: crawler convergence + source evidence.</span>
          </header>
          <div class="overflow-x-auto">
            <table class="w-full text-left">
              <thead><tr class="border-b border-outline-variant text-on-surface-variant font-table text-table"><th class="px-3 py-2">id</th><th class="px-3 py-2">requirement</th><th class="px-3 py-2">status</th><th class="px-3 py-2">priority</th></tr></thead>
              <tbody>${rows || `<tr><td colspan="4" class="px-3 py-3 text-on-surface-variant font-body text-body italic">No requirements extracted.</td></tr>`}</tbody>
            </table>
          </div>
        </section>`;
      })() : `<section class="bg-surface border border-outline-variant rounded-DEFAULT p-3 font-body text-body text-on-surface-variant">No spec verdict found for this iteration yet. New QA runs create <code class="font-code text-code">spec-verdict.json</code>.</section>`;

      bodyHtml = `<div class="flex flex-col gap-component-gap">
        <div class="bg-surface-container border border-outline-variant rounded-DEFAULT p-4 flex flex-col gap-3">
          <div class="flex items-center justify-between gap-3 flex-wrap">
            <div class="flex items-center gap-3 flex-wrap">
              <h2 class="font-h2 text-h2 text-on-surface">${escapeHtml(selected.name)}</h2>
              ${statusBadge}
              <span class="inline-flex items-center gap-1 bg-surface border border-outline-variant px-2 py-0.5 rounded-DEFAULT font-ribbon text-ribbon text-on-surface-variant">${escapeHtml(origin)}</span>
              ${summary.startedAt ? `<span class="font-code text-[11px] text-outline">${escapeHtml(summary.startedAt)}</span>` : ""}
            </div>
            <div class="flex items-center gap-2 text-on-surface-variant font-body text-body">
              <span><span class="text-on-surface">${summary.pagesVisited ?? (summary.pages || []).length}</span> pages</span>
              <span class="text-outline-variant">·</span>
              <span><span class="text-on-surface">${summary.totalElements ?? "—"}</span> elements</span>
              <span class="text-outline-variant">·</span>
              <span><span class="text-on-surface">${Math.round((summary.durationMs || 0) / 100) / 10}s</span></span>
            </div>
          </div>
          ${summary.baseUrl ? `<div class="font-code text-[11px] text-on-surface-variant break-all">base: ${escapeHtml(summary.baseUrl)}</div>` : ""}
          ${kindChips ? `<div class="flex flex-wrap gap-2 pt-1">${kindChips}</div>` : ""}
        </div>

        ${gameVerdictHtml}
        ${verdictHtml}

        <section class="bg-surface-container border border-outline-variant rounded-DEFAULT overflow-hidden">
          <header class="px-container-padding py-gutter border-b border-outline-variant flex items-center gap-2"><h3 class="font-h3 text-h3 text-on-surface">Pages crawled</h3></header>
          <div class="p-container-padding grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-component-gap">${pagesHtml || `<p class="text-on-surface-variant font-body text-body italic col-span-full">No pages visited.</p>`}</div>
        </section>

        <section class="bg-surface-container border border-outline-variant rounded-DEFAULT overflow-hidden">
          <header class="px-container-padding py-gutter border-b border-outline-variant flex items-center justify-between gap-2">
            <h3 class="font-h3 text-h3 text-on-surface">Gaps</h3>
            <a href="${fileBase}/gaps.json" target="_blank" class="text-primary-container hover:underline font-ribbon text-ribbon flex items-center gap-1">${icon("download", 14)}<span>gaps.json</span></a>
          </header>
          <div class="overflow-x-auto">${gapsHtml}</div>
        </section>

        ${runLog ? `<details class="bg-surface-container border border-outline-variant rounded-DEFAULT">
          <summary class="px-container-padding py-gutter cursor-pointer font-h3 text-h3 text-on-surface">run.log (tail)</summary>
          <pre class="px-container-padding pb-container-padding font-code text-[11px] text-on-surface-variant whitespace-pre-wrap">${escapeHtml(runLog)}</pre>
        </details>` : ""}
      </div>`;
    } else {
      bodyHtml = `<div class="bg-error-container/20 border border-error/30 rounded-DEFAULT p-3 flex items-start gap-3">
        ${icon("error", 18, "text-error shrink-0 mt-0.5")}
        <div class="flex-1 font-body text-body">
          <div class="font-bold text-error mb-0.5">${escapeHtml(selected.name)} — harness failed</div>
          <div class="text-on-surface-variant">No <code class="font-code text-code">summary.json</code>. The crawler likely exited before finishing. See the run log below.</div>
        </div>
      </div>
      <pre class="bg-surface-container border border-outline-variant rounded-DEFAULT p-container-padding font-code text-[11px] text-on-surface-variant whitespace-pre-wrap">${escapeHtml(runLog || "(no log)")}</pre>`;
    }
  }

  // Iteration switcher.
  const switcherHtml = iters.length > 1
    ? `<div class="flex items-center gap-2 flex-wrap">
        <span class="font-ribbon text-ribbon text-on-surface-variant">Iterations:</span>
        ${iters.map((it) => `<a href="/b/${encodeURIComponent(id)}/playwright?iter=${encodeURIComponent(it.name)}" class="px-2 py-0.5 rounded-DEFAULT font-code text-[11px] border ${it === selected ? "border-primary bg-primary/10 text-primary" : "border-outline-variant text-on-surface-variant hover:border-outline"}">${escapeHtml(it.name)}</a>`).join("")}
      </div>`
    : "";

  // Run-QA action button
  const btnCls = "px-3 py-1.5 border border-outline-variant bg-surface hover:bg-surface-bright text-on-surface rounded-DEFAULT font-ribbon text-ribbon transition-colors flex items-center gap-1";
  const runBtn = canRunQa
    ? `<button id="rds-run-qa" type="button" data-build-id="${escapeHtml(id)}" class="${btnCls}">${icon("play_arrow", 14, "text-primary")}<span>Run QA now</span></button>`
    : `<button type="button" disabled class="${btnCls} opacity-50 cursor-not-allowed" title="Build hasn't deployed yet — preview-url.txt is empty.">${icon("play_arrow", 14)}<span>Run QA now</span></button>`;

  return c.html(layout(`Playwright — ${id}`, `
    <div class="flex flex-col gap-component-gap">
      <div class="bg-surface-container border border-outline-variant rounded-DEFAULT px-container-padding py-gutter flex items-center justify-between gap-3 flex-wrap">
        <div class="flex items-center gap-3 flex-wrap min-w-0">
          <a href="/b/${escapeHtml(id)}" class="text-on-surface-variant hover:text-on-surface font-ribbon text-ribbon flex items-center gap-1">${icon("arrow_back", 14)}<span>Build</span></a>
          <span class="text-outline-variant">/</span>
          <h1 class="font-h1 text-h1 text-on-surface flex items-center gap-2">${icon("smart_toy", 20, "text-primary-container")}<span>Playwright UAT · <code class="font-code text-primary-container break-all">${escapeHtml(id)}</code></span></h1>
        </div>
        <div class="flex items-center gap-2 flex-wrap">${runBtn}</div>
      </div>
      ${previewRaw ? `<div class="bg-surface border border-outline-variant rounded-DEFAULT px-container-padding py-2 font-code text-[11px] text-on-surface-variant break-all"><span class="text-outline">preview:</span> ${escapeHtml(previewRaw)}</div>` : ""}
      <div class="bg-surface border border-outline-variant rounded-DEFAULT px-container-padding py-2 font-body text-body text-on-surface-variant">
        ${escapeHtml(qaIterationsSummary(id, iters))} The crawler checks runtime behavior, console/network errors, clickable controls, DOM/canvas changes, and screenshots — it is not yet a full semantic audit of every original spec line.
      </div>
      ${switcherHtml}
      ${bodyHtml}
    </div>
    <script>
      (function () {
        var btn = document.getElementById("rds-run-qa");
        if (!btn) return;
        btn.addEventListener("click", async function () {
          var id = btn.getAttribute("data-build-id");
          var ok = (typeof window.rdsConfirm === "function")
            ? await window.rdsConfirm('Run a Playwright QA pass for build "' + id + '"? It crawls the deployed URL, BFS to depth 2, ~10–30s.', { title: "Run QA now?", okLabel: "Run QA" })
            : confirm("Run a Playwright QA pass for " + id + "?");
          if (!ok) return;
          btn.disabled = true;
          var orig = btn.innerHTML;
          btn.innerHTML = '<span class="material-symbols-outlined !text-[14px] text-primary">hourglass_top</span><span>Crawling…</span>';
          try {
            var resp = await fetch("/b/" + encodeURIComponent(id) + "/playwright/run", {
              method: "POST",
              headers: { "X-RDS-Token": localStorage.getItem("rds_token") || "" }
            });
            var data = await resp.json().catch(function () { return {}; });
            if (resp.ok) {
              if (typeof window.rdsToast === "function") rdsToast("QA started — iter " + (data.iteration || "?") + ". Reloading…", "info");
              setTimeout(function () { window.location.href = "/b/" + encodeURIComponent(id) + "/playwright?iter=iter-" + String(data.iteration || 1).padStart(3, "0"); }, 2500);
            } else {
              if (typeof window.rdsToast === "function") rdsToast("QA failed: " + (data.error || resp.status), "error");
              btn.disabled = false;
              btn.innerHTML = orig;
            }
          } catch (err) {
            if (typeof window.rdsToast === "function") rdsToast("QA failed: " + err, "error");
            btn.disabled = false;
            btn.innerHTML = orig;
          }
        });
      })();
    </script>
  `, { nav: "builds", topbarTab: "builds" }));
});

// File served from any iter-NNN/ subdirectory: /b/:id/playwright/file/:iter/:name
app.get("/b/:id/playwright/file/:iter/:name", (c) => {
  const id   = c.req.param("id");
  const iter = c.req.param("iter");
  const name = c.req.param("name");
  const dir = existingBuildDirForId(id);
  if (!dir) return c.text("not found", 404);
  if (!/^iter-\d+$/.test(iter)) return c.text("invalid iter", 400);
  if (!/^[a-z0-9._-]+$/i.test(name)) return c.text("invalid filename", 400);
  const path = existingFileIn(dir, "playwright", iter, name);
  if (!path) return c.text("not found", 404);
  const ext = name.toLowerCase().split(".").pop();
  const mime: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
    webp: "image/webp", webm: "video/webm", mp4: "video/mp4",
    json: "application/json", txt: "text/plain", log: "text/plain", html: "text/html"
  };
  c.header("Content-Type", mime[ext ?? ""] ?? "application/octet-stream");
  try { return c.body(readFileSync(path)); } catch { return c.text("not found", 404); }
});

// Legacy route for files dropped directly into builds/<id>/playwright/ (not in iter-NNN/).
app.get("/b/:id/playwright/file/:name", (c) => {
  const id   = c.req.param("id");
  const name = c.req.param("name");
  const dir = existingBuildDirForId(id);
  if (!dir) return c.text("not found", 404);
  if (!/^[a-z0-9._-]+$/i.test(name)) return c.text("invalid filename", 400);
  const path = existingFileIn(dir, "playwright", name);
  if (!path) return c.text("not found", 404);
  const ext = name.toLowerCase().split(".").pop();
  const mime: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
    webp: "image/webp", webm: "video/webm", mp4: "video/mp4",
    json: "application/json", txt: "text/plain", log: "text/plain", html: "text/html"
  };
  c.header("Content-Type", mime[ext ?? ""] ?? "application/octet-stream");
  try { return c.body(readFileSync(path)); } catch { return c.text("not found", 404); }
});

// POST /b/:id/playwright/run — kick off bin/rds-qa as a detached background task.
// Token-gated. Returns the iteration number it will write to.
app.post("/b/:id/playwright/run", async (c) => {
  const id = c.req.param("id");
  const denied = tokenGate(c);
  if (denied) {
    appendAudit({ route: "POST /b/:id/playwright/run", build_id: id, outcome: "denied", status: denied.status, ip: callerIp(c), ua: callerUa(c) });
    return denied;
  }
  if (!existsSync(join(BUILDS_DIR, id))) return c.text("not found", 404);
  const cmd = join(RDS_ROOT, "bin", "rds-qa");
  if (!existsSync(cmd)) {
    return c.json({ ok: false, error: "bin/rds-qa missing on this RDS checkout. Pull latest." }, 500);
  }
  const previewPath = join(BUILDS_DIR, id, "preview-url.txt");
  if (!existsSync(previewPath)) {
    return c.json({ ok: false, error: "Build hasn't deployed yet (no preview-url.txt)." }, 409);
  }

  appendAudit({ route: "POST /b/:id/playwright/run", build_id: id, outcome: "ok", ip: callerIp(c), ua: callerUa(c) });

  // Predict the iteration number we'll write to (so the UI can deep-link).
  const next = (listQaIterations(id)[0]?.index ?? 0) + 1;

  const child = spawn(cmd, [id], {
    cwd: RDS_ROOT, stdio: "ignore", detached: true,
    env: { ...process.env, RDS_NOTIFY_DISABLED: "1" }
  });
  child.unref();
  return c.json({ ok: true, pid: child.pid, iteration: next, hint: `watch builds/${id}/playwright/iter-${String(next).padStart(3, "0")}/` });
});

// JSON status endpoint for UI polling.
app.get("/b/:id/playwright/status", (c) => {
  const id = c.req.param("id");
  if (!existsSync(join(BUILDS_DIR, id))) return c.text("not found", 404);
  const iters = listQaIterations(id);
  const latest = iters[0];
  let summary: QaIterationSummary | null = null;
  if (latest) {
    summary = safeReadJson<QaIterationSummary>(join(BUILDS_DIR, id, "playwright", latest.name, "summary.json"));
  }
  return c.json({
    iterations: iters.map((it) => ({ name: it.name, index: it.index, mtime: it.mtime })),
    latest: latest?.name,
    summary: summary ? {
      pagesVisited: summary.pagesVisited,
      gapsFound: summary.gapsFound,
      converged: summary.converged,
      durationMs: summary.durationMs,
      baseUrl: summary.baseUrl,
      finishedAt: summary.finishedAt,
    } : null,
  });
});

app.post("/b/:id/deploy", async (c) => {
  const id  = c.req.param("id");
  const denied = tokenGate(c);
  if (denied) {
    appendAudit({ route: "POST /b/:id/deploy", build_id: id, outcome: "denied", status: denied.status, ip: callerIp(c), ua: callerUa(c) });
    return denied;
  }
  const dir = join(BUILDS_DIR, id);
  if (!existsSync(dir)) return c.text("not found", 404);
  appendAudit({ route: "POST /b/:id/deploy", build_id: id, outcome: "ok", ip: callerIp(c), ua: callerUa(c) });

  const body = (await c.req.json().catch(() => ({}))) as { target?: string; app_dir?: string };
  const target = body.target ?? "zo";
  if (!ALLOWED_DEPLOY_TARGETS.has(target)) {
    return c.text(`target must be one of ${[...ALLOWED_DEPLOY_TARGETS].join(", ")}`, 400);
  }

  const state = safeReadJson<StateJson>(join(dir, "state.json")) || {};
  let appDir = state.app_dest || resolveAppDest(dir);
  if (!appDir && body.app_dir && body.app_dir.startsWith("/")) appDir = body.app_dir;
  if (!appDir) {
    return c.json({
      ok: false,
      error: "no app_dest in state.json or events.jsonl; resend with body { app_dir: '/abs/path' }"
    }, 400);
  }

  const cmd = join(RDS_ROOT, "bin", "rds-deploy");
  if (!existsSync(cmd)) return c.text("bin/rds-deploy missing", 500);

  const child = spawn(cmd, [`--build-id=${id}`, `--app-dir=${appDir}`, `--target=${target}`], {
    cwd: RDS_ROOT, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, RDS_NOTIFY_DISABLED: "1", RDS_ZO_REUSE_EXISTING: "1" }
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", (d) => (stdout += d.toString()));
  child.stderr.on("data", (d) => (stderr += d.toString()));
  const exitCode = await new Promise<number>((resolve) => child.on("close", (c) => resolve(c ?? 1)));
  const preview = existsSync(join(dir, "preview-url.txt")) ? readFileSync(join(dir, "preview-url.txt"), "utf8").trim() : "";
  if (exitCode === 0) updateBuildPreview(id, preview);
  return c.json({ ok: exitCode === 0, target, exitCode, stdout, stderr, preview, pendingRegistration: isPendingPreview(preview) });
});

app.post("/b/:id/service/deregister", async (c) => {
  const id = c.req.param("id");
  const denied = tokenGate(c);
  if (denied) {
    appendAudit({ route: "POST /b/:id/service/deregister", build_id: id, outcome: "denied", status: denied.status, ip: callerIp(c), ua: callerUa(c) });
    return denied;
  }
  const dir = join(BUILDS_DIR, id);
  if (!existsSync(dir)) return c.text("not found", 404);
  const info = readServiceInfo(id);
  if (!info?.service_id) return c.json({ ok: false, error: "No recorded Zo service for this build." }, 409);
  if (info.status === "deregistered") {
    appendAudit({ route: "POST /b/:id/service/deregister", build_id: id, outcome: "ok", ip: callerIp(c), ua: callerUa(c), note: `service_id=${info.service_id} already_deregistered` });
    return c.json({ ok: true, service_id: info.service_id, status: "already_deregistered" });
  }

  const cmd = join(RDS_ROOT, "bin", "rds-zo-deregister");
  if (!existsSync(cmd)) return c.text("bin/rds-zo-deregister missing", 500);
  const child = spawn(cmd, [`--service-id=${info.service_id}`, `--build-id=${id}`], { cwd: RDS_ROOT, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (d) => (stdout += d.toString()));
  child.stderr.on("data", (d) => (stderr += d.toString()));
  const exitCode = await new Promise<number>((resolve) => child.on("close", (code) => resolve(code ?? 1)));

  if (exitCode === 0) {
    writeServiceInfo(id, { ...info, status: "deregistered" });
    writeFileSync(join(dir, "preview-url.txt"), "\n");
    updateBuildPreview(id, "");
    appendAudit({ route: "POST /b/:id/service/deregister", build_id: id, outcome: "ok", ip: callerIp(c), ua: callerUa(c), note: `service_id=${info.service_id}` });
  } else {
    writeServiceInfo(id, { ...info, status: "unknown" });
    appendAudit({ route: "POST /b/:id/service/deregister", build_id: id, outcome: "error", status: 502, ip: callerIp(c), ua: callerUa(c), note: `service_id=${info.service_id}` });
  }

  return c.json({ ok: exitCode === 0, exitCode, stdout: stdout.trim(), stderr: stderr.trim(), service_id: info.service_id });
});

// ---------- chat session API ------------------------------------------------

function annotateSession(s: ChatSession): {
  id: string; title: string; build_id?: string;
  created_at: number; updated_at: number; last_read_at: number;
  unread: number; pending: boolean; last_message?: string;
} {
  const lastTurn = s.turns[s.turns.length - 1];
  return {
    id: s.id, title: s.title, build_id: s.build_id,
    created_at: s.created_at, updated_at: s.updated_at, last_read_at: s.last_read_at,
    unread: unreadCount(s),
    pending: pendingChats.has(s.id) || s.turns.some((t) => t.status === "pending") || hasRunningChatAction(s),
    last_message: lastTurn ? lastTurn.text.slice(0, 160) : undefined,
  };
}

app.get("/chat/sessions", (c) => {
  // Same visibility rule as the Builds list: threads for fixture/smoke builds
  // (_-prefixed) stay out of the operator's sidebar.
  const sessions = listChatSessions()
    .filter((s) => !s.build_id || (!s.build_id.startsWith("_") && !s.build_id.startsWith("rds-smoke-")))
    .map(annotateSession);
  return c.json({ sessions });
});

app.post("/chat/sessions", async (c) => {
  const denied = tokenGate(c);
  if (denied) {
    appendAudit({ route: "POST /chat/sessions", outcome: "denied", status: denied.status, ip: callerIp(c), ua: callerUa(c) });
    return denied;
  }
  const body = (await c.req.json().catch(() => ({}))) as { title?: string; build_id?: string };
  if (body.build_id && !existsSync(join(BUILDS_DIR, body.build_id))) {
    return c.json({ ok: false, error: `unknown build_id: ${body.build_id}` }, 400);
  }
  const session = createChatSession({ title: body.title, build_id: body.build_id });
  appendAudit({ route: "POST /chat/sessions", build_id: body.build_id, outcome: "ok", ip: callerIp(c), ua: callerUa(c), note: `session=${session.id}` });
  return c.json({ ok: true, session });
});

app.get("/chat/sessions/:id", (c) => {
  const id = c.req.param("id");
  const s = readChatSession(id);
  if (!s) return c.json({ ok: false, error: "not found" }, 404);
  return c.json({ ok: true, session: s, pending: pendingChats.has(s.id) });
});

app.get("/chat/sessions/:id/stream", (c) => {
  const id = c.req.param("id");
  const sessionPath = chatSessionPath(id);
  if (!isChatId(id) || !existsSync(sessionPath)) return c.text("not found", 404);
  c.header("Content-Type", "text/event-stream");
  c.header("Cache-Control", "no-cache");
  c.header("X-Accel-Buffering", "no");
  return stream(c, async (s) => {
    let lastMtime = 0;
    const sendSession = async () => {
      const session = readChatSession(id);
      if (!session) return false;
      await s.write(`event: session\ndata: ${JSON.stringify({ session, pending: pendingChats.has(id) })}\n\n`);
      lastMtime = statSync(sessionPath).mtimeMs;
      return true;
    };
    if (!(await sendSession())) return;
    let lastBeat = Date.now();
    while (!s.aborted) {
      await s.sleep(1000);
      if (!existsSync(sessionPath)) break;
      const nextMtime = statSync(sessionPath).mtimeMs;
      if (nextMtime !== lastMtime) await sendSession();
      if (Date.now() - lastBeat > 15000) {
        await s.write(`: keepalive\n\n`);
        lastBeat = Date.now();
      }
    }
  });
});

app.delete("/chat/sessions/:id", (c) => {
  const denied = tokenGate(c);
  if (denied) {
    appendAudit({ route: "DELETE /chat/sessions/:id", outcome: "denied", status: denied.status, ip: callerIp(c), ua: callerUa(c) });
    return denied;
  }
  const id = c.req.param("id");
  if (!isChatId(id)) return c.json({ ok: false, error: "bad id" }, 400);
  const p = chatSessionPath(id);
  if (!existsSync(p)) return c.json({ ok: false, error: "not found" }, 404);
  if (pendingChats.has(id)) return c.json({ ok: false, error: "session has an in-flight reply, wait for it to complete" }, 409);
  unlinkSync(p);
  appendAudit({ route: "DELETE /chat/sessions/:id", outcome: "ok", ip: callerIp(c), ua: callerUa(c), note: `session=${id}` });
  return c.json({ ok: true });
});

app.post("/chat/sessions/:id/messages", async (c) => {
  const denied = tokenGate(c);
  if (denied) {
    appendAudit({ route: "POST /chat/sessions/:id/messages", outcome: "denied", status: denied.status, ip: callerIp(c), ua: callerUa(c) });
    return denied;
  }
  const id = c.req.param("id");
  const s = readChatSession(id);
  if (!s) return c.json({ ok: false, error: "not found" }, 404);
  if (pendingChats.has(s.id)) return c.json({ ok: false, error: "still waiting on previous reply" }, 409);
  const contentType = c.req.header("content-type") || "";
  let message = "";
  let attachments: BuildAttachment[] = [];
  if (contentType.includes("multipart/form-data")) {
    const form = await c.req.formData().catch(() => null);
    if (!form) return c.json({ ok: false, error: "invalid form data" }, 400);
    message = String(form.get("message") || "").trim();
    const files = form.getAll("attachments").filter(isUploadFile);
    try {
      attachments = await saveChatAttachments(s, files);
    } catch (err) {
      return c.json({ ok: false, error: err instanceof Error ? err.message : "invalid attachment" }, 400);
    }
  } else {
    const body = (await c.req.json().catch(() => ({}))) as { message?: string };
    message = (body.message ?? "").trim();
  }
  if (!message && !attachments.length) return c.json({ ok: false, error: "message or attachment required" }, 400);
  if (!message) message = "Review the attached file(s).";
  const messageForAction = `${message}${chatAttachmentContext(attachments)}`;
  const action = classifyBuildChatAction(s, messageForAction);
  const { userTurn, rdsTurn } = action
    ? appendChatActionProposal(s, message, action, attachments)
    : spawnChatForSession(s, message, attachments);
  appendAudit({
    route: "POST /chat/sessions/:id/messages",
    build_id: s.build_id,
    outcome: "ok",
    ip: callerIp(c),
    ua: callerUa(c),
    note: `session=${s.id}${action ? ` action=${action.kind}` : ""}${attachments.length ? ` attachments=${attachments.length}` : ""}`
  });
  return c.json({ ok: true, user_turn_id: userTurn.id, rds_turn_id: rdsTurn.id });
});

app.post("/chat/sessions/:id/actions", async (c) => {
  const denied = tokenGate(c);
  if (denied) {
    appendAudit({ route: "POST /chat/sessions/:id/actions", outcome: "denied", status: denied.status, ip: callerIp(c), ua: callerUa(c) });
    return denied;
  }
  const id = c.req.param("id");
  const s = readChatSession(id);
  if (!s) return c.json({ ok: false, error: "not found" }, 404);
  const body = (await c.req.json().catch(() => ({}))) as { turn_id?: string; confirm?: string };
  if (body.confirm !== "RUN_ACTION") return c.json({ ok: false, error: "confirmation required" }, 409);
  const turn = s.turns.find((t) => t.id === body.turn_id && t.role === "rds" && t.action);
  if (!turn?.action) return c.json({ ok: false, error: "action turn not found" }, 404);
  if (pendingChats.has(s.id)) return c.json({ ok: false, error: "still waiting on previous reply" }, 409);

  const result = startChatAction(turn.action, { sessionId: s.id, turnId: turn.id });
  if (!result.ok) {
    appendAudit({ route: "POST /chat/sessions/:id/actions", build_id: s.build_id, outcome: "error", status: result.status || 500, ip: callerIp(c), ua: callerUa(c), note: `${turn.action.kind}: ${result.error}` });
    appendChatSystemTurn(s.id, `Could not start ${turn.action.label}: ${result.error || "unknown error"}`, "error");
    return c.json(result, { status: (result.status || 500) as 400 | 404 | 409 | 500 });
  }

  appendAudit({ route: "POST /chat/sessions/:id/actions", build_id: s.build_id, outcome: "ok", ip: callerIp(c), ua: callerUa(c), note: `${turn.action.kind} pid=${result.pid || ""}` });
  turn.action.action_run = result.action_run;
  turn.action.action_status = result.action_run ? safeReadJson<ActionRunState>(join(RDS_ROOT, result.action_run)) : null;
  writeChatSession(s);
  const followup = turn.action.kind === "goal"
    ? "Started RDS Goal. Watch the Goal panel, evidence ledger, and event stream for progress."
    : turn.action.kind === "iterate"
    ? "Started controlled iteration. Watch the event stream and iterate summary for progress."
    : turn.action.kind === "qa"
      ? "Started Playwright QA. Watch the Playwright tab and event stream for the result."
      : turn.action.kind === "redeploy"
        ? "Started Zo redeploy. Watch the event stream and preview URL for the result."
        : turn.action.kind === "approve"
          ? "Started approval. Watch review status for the result."
          : "Started Zo service deletion. The preview URL will clear only after deletion is verified.";
  appendChatSystemTurn(s.id, `${followup}${result.action_run ? `\nAction run: ${result.action_run}` : ""}${result.hint ? `\n${result.hint}` : ""}`);
  return c.json(result);
});

app.post("/chat/sessions/:id/read", (c) => {
  const id = c.req.param("id");
  const s = readChatSession(id);
  if (!s) return c.json({ ok: false, error: "not found" }, 404);
  s.last_read_at = Date.now();
  writeChatSession(s);
  return c.json({ ok: true, last_read_at: s.last_read_at });
});

app.post("/chat/sessions/:id/title", async (c) => {
  const denied = tokenGate(c);
  if (denied) {
    appendAudit({ route: "POST /chat/sessions/:id/title", outcome: "denied", status: denied.status, ip: callerIp(c), ua: callerUa(c) });
    return denied;
  }
  const id = c.req.param("id");
  const s = readChatSession(id);
  if (!s) return c.json({ ok: false, error: "not found" }, 404);
  const body = (await c.req.json().catch(() => ({}))) as { title?: string };
  const title = (body.title ?? "").trim().slice(0, 120);
  if (!title) return c.json({ ok: false, error: "title required" }, 400);
  s.title = title;
  s.updated_at = Date.now();
  writeChatSession(s);
  return c.json({ ok: true, session: s });
});

app.post("/chat/sessions/by-build/:bid", (c) => {
  const denied = tokenGate(c);
  if (denied) {
    appendAudit({ route: "POST /chat/sessions/by-build/:bid", outcome: "denied", status: denied.status, ip: callerIp(c), ua: callerUa(c) });
    return denied;
  }
  const bid = c.req.param("bid");
  if (!existsSync(join(BUILDS_DIR, bid))) return c.json({ ok: false, error: "unknown build" }, 404);
  const session = findOrCreateBuildSession(bid);
  return c.json({ ok: true, session });
});

app.get("/chat/unread", (c) => c.json({ unread: totalUnread() }));

// ---------- cost (TD-032) ---------------------------------------------------

app.get("/b/:id/cost.json", (c) => {
  const id = c.req.param("id");
  const path = join(BUILDS_DIR, id, "cost.json");
  if (!existsSync(path)) {
    return c.json({ ok: false, error: "no cost.json yet — POST /b/:id/refresh-cost to compute" }, 404);
  }
  c.header("Content-Type", "application/json");
  try { return c.body(readFileSync(path)); } catch { return c.text("not found", 404); }
});

// Human-readable cost view (HTML wrapper around cost.json).
app.get("/b/:id/cost", (c) => {
  const id = c.req.param("id");
  const dir = join(BUILDS_DIR, id);
  if (!existsSync(dir)) return c.text("not found", 404);
  const path = join(dir, "cost.json");
  if (!existsSync(path)) {
    return c.html(layout(`Cost · ${id}`, `
      <div class="flex flex-col gap-component-gap">
        <div class="bg-surface-container border border-outline-variant rounded-DEFAULT px-container-padding py-gutter flex items-center justify-between gap-3 flex-wrap">
          <div class="flex items-center gap-3 flex-wrap min-w-0">
            <a href="/b/${escapeHtml(id)}" class="text-on-surface-variant hover:text-on-surface font-ribbon text-ribbon flex items-center gap-1">${icon("arrow_back", 14)}<span>Build</span></a>
            <span class="text-outline-variant">/</span>
            <h1 class="font-h1 text-h1 text-on-surface flex items-center gap-2">${icon("attach_money", 20, "text-primary-container")}<span>Cost · <code class="font-code text-primary-container">${escapeHtml(id)}</code></span></h1>
          </div>
        </div>
        ${(() => {
          // No computed breakdown yet, but state.json may already carry a
          // recorded total — show what is known instead of claiming nothing.
          const state = safeReadJson<StateJson>(join(dir, "state.json")) as { cost?: { total_usd?: number; input_tokens?: number; output_tokens?: number } } | null;
          const sc = state?.cost;
          return typeof sc?.total_usd === "number" ? `
        <div class="bg-surface-container border border-outline-variant rounded-DEFAULT p-container-padding flex items-center gap-4 flex-wrap">
          <span class="inline-flex items-center gap-1 px-2 py-1 rounded-DEFAULT bg-primary-container/10 border border-primary-container/30 text-primary-container"><b class="font-h2 text-h2">$${sc.total_usd.toFixed(2)}</b><span>recorded total</span></span>
          ${sc.input_tokens || sc.output_tokens ? `<span class="font-code text-[12px] text-on-surface-variant">${(sc.input_tokens ?? 0).toLocaleString()} in · ${(sc.output_tokens ?? 0).toLocaleString()} out tokens</span>` : ""}
          <span class="font-body text-body text-on-surface-variant">From <code class="font-code text-code">state.json</code> — no per-session breakdown yet.</span>
        </div>` : "";
        })()}
        <div class="bg-surface-container border border-outline-variant rounded-DEFAULT p-container-padding text-on-surface-variant font-body text-body flex items-center gap-3 flex-wrap">
          <span>No per-session breakdown yet.</span>
          <button class="px-3 py-1.5 border border-outline-variant bg-surface hover:bg-surface-bright text-on-surface rounded-DEFAULT font-ribbon text-ribbon transition-colors flex items-center gap-1" onclick="fetch('/b/${escapeHtml(id)}/refresh-cost',{method:'POST',headers:{'X-RDS-Token':localStorage.getItem('rds_token')||''}}).then(()=>location.reload())">${icon("refresh", 14)}<span>Refresh cost</span></button>
          <span>computes it from model session logs.</span>
        </div>
      </div>
    `, { nav: "builds", topbarTab: "builds" }));
  }
  let cost: any = {};
  try { cost = JSON.parse(readFileSync(path, "utf8")); } catch { cost = { error: "cost.json could not be parsed" }; }
  const total = typeof cost.total_usd === "number" ? cost.total_usd : (cost.total ?? null);
  const tokens = cost.total_tokens ?? cost.tokens ?? null;
  const sessions: any[] = Array.isArray(cost.sessions) ? cost.sessions : [];
  const sessionRows = sessions.map((s) => `
    <tr class="border-b border-outline-variant/40 hover:bg-surface-container-high/50 transition-colors">
      <td class="px-3 py-2"><code class="font-code text-[12px] text-primary-container">${escapeHtml(String(s.session_id ?? "-"))}</code></td>
      <td class="px-3 py-2 font-table text-table">${escapeHtml(String(s.stage ?? "-"))}</td>
      <td class="px-3 py-2 font-code text-[11px] text-on-surface-variant">${s.started_at ? escapeHtml(new Date(s.started_at).toLocaleString()) : "-"}</td>
      <td class="px-3 py-2 font-code text-[12px] text-right">${s.input_tokens ?? "-"}</td>
      <td class="px-3 py-2 font-code text-[12px] text-right">${s.output_tokens ?? "-"}</td>
      <td class="px-3 py-2 font-code text-[12px] text-right text-primary-container">${typeof s.cost_usd === "number" ? `$${s.cost_usd.toFixed(2)}` : "-"}</td>
    </tr>`).join("");
  return c.html(layout(`Cost · ${id}`, `
    <div class="flex flex-col gap-component-gap">
      <div class="bg-surface-container border border-outline-variant rounded-DEFAULT px-container-padding py-gutter flex items-center justify-between gap-3 flex-wrap">
        <div class="flex items-center gap-3 flex-wrap min-w-0">
          <a href="/b/${escapeHtml(id)}" class="text-on-surface-variant hover:text-on-surface font-ribbon text-ribbon flex items-center gap-1">${icon("arrow_back", 14)}<span>Build</span></a>
          <span class="text-outline-variant">/</span>
          <h1 class="font-h1 text-h1 text-on-surface flex items-center gap-2">${icon("attach_money", 20, "text-primary-container")}<span>Cost · <code class="font-code text-primary-container break-all">${escapeHtml(id)}</code></span></h1>
        </div>
        <div class="flex items-center gap-3 font-ribbon text-ribbon flex-wrap">
          ${total != null ? `<span class="inline-flex items-center gap-1 px-2 py-1 rounded-DEFAULT bg-primary-container/10 border border-primary-container/30 text-primary-container"><b class="font-h2 text-h2">$${Number(total).toFixed(2)}</b><span>total</span></span>` : ""}
          ${tokens != null ? `<span class="inline-flex items-center gap-1 px-2 py-1 rounded-DEFAULT bg-surface-container-high border border-outline-variant text-on-surface"><b>${Number(tokens).toLocaleString()}</b><span>tokens</span></span>` : ""}
          <a class="text-outline hover:text-on-surface font-ribbon text-ribbon flex items-center gap-1" href="/b/${escapeHtml(id)}/cost.json">${icon("data_object", 14)}<span>JSON</span></a>
        </div>
      </div>
      ${sessions.length ? `
        <div class="bg-surface border border-outline-variant rounded-DEFAULT overflow-hidden">
          <table class="w-full font-table text-table">
            <thead class="bg-surface-container-high border-b border-outline-variant">
              <tr class="text-on-surface-variant font-ribbon text-ribbon uppercase tracking-wider">
                <th class="px-3 py-2 text-left">session</th>
                <th class="px-3 py-2 text-left">stage</th>
                <th class="px-3 py-2 text-left">started</th>
                <th class="px-3 py-2 text-right">in tokens</th>
                <th class="px-3 py-2 text-right">out tokens</th>
                <th class="px-3 py-2 text-right">cost</th>
              </tr>
            </thead>
            <tbody>${sessionRows}</tbody>
          </table>
        </div>` : `
        <p class="text-on-surface-variant font-body text-body italic">No per-session breakdown in <code class="font-code text-code">cost.json</code>. Raw payload below.</p>
        <pre class="bg-[#070908] border border-outline-variant rounded-DEFAULT p-3 font-code text-[12px] text-on-surface-variant leading-relaxed overflow-auto custom-scrollbar whitespace-pre-wrap">${escapeHtml(JSON.stringify(cost, null, 2))}</pre>`}
    </div>
  `, { nav: "builds", topbarTab: "builds" }));
});

app.post("/b/:id/refresh-cost", async (c) => {
  const id = c.req.param("id");
  const denied = tokenGate(c);
  if (denied) {
    appendAudit({ route: "POST /b/:id/refresh-cost", build_id: id, outcome: "denied", status: denied.status, ip: callerIp(c), ua: callerUa(c) });
    return denied;
  }
  if (!existsSync(join(BUILDS_DIR, id))) return c.text("not found", 404);
  appendAudit({ route: "POST /b/:id/refresh-cost", build_id: id, outcome: "ok", ip: callerIp(c), ua: callerUa(c) });
  const cmd = join(RDS_ROOT, "bin", "rds-cost");
  if (!existsSync(cmd)) return c.json({ ok: false, error: "bin/rds-cost missing" }, 500);
  const child = spawn(cmd, [id], { cwd: RDS_ROOT, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (d) => (stdout += d.toString()));
  child.stderr.on("data", (d) => (stderr += d.toString()));
  const exitCode = await new Promise<number>((resolve) => child.on("close", (code) => resolve(code ?? 1)));
  const cost = safeReadJson(join(BUILDS_DIR, id, "cost.json"));
  return c.json({ ok: exitCode === 0, exitCode, stdout: stdout.trim(), stderr: stderr.trim(), cost });
});

// ---------- approval gate (TD-033) -----------------------------------------

app.post("/b/:id/approve", async (c) => {
  const id = c.req.param("id");
  const denied = tokenGate(c);
  if (denied) {
    appendAudit({ route: "POST /b/:id/approve", build_id: id, outcome: "denied", status: denied.status, ip: callerIp(c), ua: callerUa(c) });
    return denied;
  }
  if (!existsSync(join(BUILDS_DIR, id))) return c.text("not found", 404);
  const body = (await c.req.json().catch(() => ({}))) as { by?: string; reason?: string };
  const by = (body.by || "operator").trim();
  const reason = (body.reason || "").trim();
  const evidence = refreshEvidenceLedger(id);
  if (["blocked", "failed", "recovering", "building"].includes(evidence?.verdict || "")) {
    appendAudit({ route: "POST /b/:id/approve", build_id: id, outcome: "denied", status: 409, ip: callerIp(c), ua: callerUa(c), note: `verdict=${evidence?.verdict}` });
    return c.json({
      ok: false,
      error: "canonical evidence blocks approval",
      verdict: evidence?.verdict,
      blockerClass: evidence?.summary?.blockerClass,
      blockers: (evidence?.blockers || []).slice(0, 5),
    }, 409);
  }
  appendAudit({ route: "POST /b/:id/approve", build_id: id, outcome: "ok", ip: callerIp(c), ua: callerUa(c), note: `by=${by}` });
  const cmd = join(RDS_ROOT, "bin", "rds-approve");
  if (!existsSync(cmd)) return c.json({ ok: false, error: "bin/rds-approve missing" }, 500);
  const args = [id, `--by=${by}`];
  if (reason) args.push(`--reason=${reason}`);
  const child = spawn(cmd, args, { cwd: RDS_ROOT, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, RDS_NOTIFY_DISABLED: "1" } });
  let stdout = "", stderr = "";
  child.stdout.on("data", (d) => (stdout += d.toString()));
  child.stderr.on("data", (d) => (stderr += d.toString()));
  const exitCode = await new Promise<number>((resolve) => child.on("close", (code) => resolve(code ?? 1)));
  return c.json({ ok: exitCode === 0, exitCode, stdout: stdout.trim(), stderr: stderr.trim(), by });
});

app.post("/b/:id/reject", async (c) => {
  const id = c.req.param("id");
  const denied = tokenGate(c);
  if (denied) {
    appendAudit({ route: "POST /b/:id/reject", build_id: id, outcome: "denied", status: denied.status, ip: callerIp(c), ua: callerUa(c) });
    return denied;
  }
  if (!existsSync(join(BUILDS_DIR, id))) return c.text("not found", 404);
  const body = (await c.req.json().catch(() => ({}))) as { by?: string; reason?: string };
  const by = (body.by || "operator").trim();
  const reason = (body.reason || "").trim();
  if (!reason) return c.json({ ok: false, error: "reason required" }, 400);
  appendAudit({ route: "POST /b/:id/reject", build_id: id, outcome: "ok", ip: callerIp(c), ua: callerUa(c), note: `by=${by}` });
  const cmd = join(RDS_ROOT, "bin", "rds-reject");
  if (!existsSync(cmd)) return c.json({ ok: false, error: "bin/rds-reject missing" }, 500);
  const child = spawn(cmd, [id, `--by=${by}`, `--reason=${reason}`], { cwd: RDS_ROOT, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, RDS_NOTIFY_DISABLED: "1" } });
  let stdout = "", stderr = "";
  child.stdout.on("data", (d) => (stdout += d.toString()));
  child.stderr.on("data", (d) => (stderr += d.toString()));
  const exitCode = await new Promise<number>((resolve) => child.on("close", (code) => resolve(code ?? 1)));
  return c.json({ ok: exitCode === 0, exitCode, stdout: stdout.trim(), stderr: stderr.trim(), by, reason });
});

// ---------- PRD upload ------------------------------------------------------

// Accepts JSON { filename, content, autostart?, app_dest?, deploy_target? }.
// Drops a markdown file into inbox/ and (if autostart) kicks off rds-start.
app.post("/upload-prd", async (c) => {
  const denied = tokenGate(c);
  if (denied) {
    appendAudit({ route: "POST /upload-prd", outcome: "denied", status: denied.status, ip: callerIp(c), ua: callerUa(c) });
    return denied;
  }
  const body = (await c.req.json().catch(() => ({}))) as { filename?: string; content?: string; autostart?: boolean; app_dest?: string; deploy_target?: string; stack?: string };
  const content = (body.content || "").trim();
  if (!content) return c.json({ ok: false, error: "content required" }, 400);
  const slugSafe = (body.filename || "prd").replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "prd";
  const fname = slugSafe.endsWith(".md") ? slugSafe : `${slugSafe}.md`;
  mkdirSync(INBOX_DIR, { recursive: true });
  const path = join(INBOX_DIR, `${Date.now()}-${fname}`);
  writeFileSync(path, content + "\n");
  appendAudit({ route: "POST /upload-prd", outcome: "ok", ip: callerIp(c), ua: callerUa(c), note: `path=${path}` });

  if (!body.autostart) {
    return c.json({ ok: true, path, autostart: false });
  }

  let appDest = (body.app_dest || "").trim();
  if (!appDest) {
    const baseSlug = (slugSafe.replace(/\.md$/, "") || "adhoc")
      .replace(/[^a-z0-9-]+/gi, "-").replace(/(^-|-$)/g, "").toLowerCase().slice(0, 40) || "adhoc";
    appDest = `${DEFAULT_PROJECTS_DIR}/${baseSlug}`;
  }
  if (!appDest.startsWith("/")) {
    return c.json({ ok: false, error: "app_dest must be an absolute path", path }, 400);
  }
  const deploy = body.deploy_target === "none" ? "none" : "zo";
  const stack = (body.stack || "rails").replace(/[^a-z0-9_-]/gi, "") || "rails";
  if (!readyStackIds().has(stack)) return c.json({ ok: false, error: `stack '${stack}' is not end-to-end enabled`, path }, 400);
  const settings = readSettings();
  const cmd = join(RDS_ROOT, "bin", "rds-start");
  if (!existsSync(cmd)) return c.json({ ok: false, error: "bin/rds-start missing", path }, 500);
  const args = [
    path,
    `--app-dest=${appDest}`,
    `--deploy-target=${deploy}`,
    `--stack=${stack}`,
    `--provider=${settings.inferenceProvider}`,
    `--claude-model=${settings.claudeModel}`,
  ];
  if (settings.codexModel) args.push(`--codex-model=${settings.codexModel}`);
  const child = spawn(cmd, args, { cwd: RDS_ROOT, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, RDS_NOTIFY_DISABLED: "1" } });
  let stdout = "", stderr = "";
  child.stdout.on("data", (d) => (stdout += d.toString()));
  child.stderr.on("data", (d) => (stderr += d.toString()));
  const exitCode = await new Promise<number>((resolve) => child.on("close", (code) => resolve(code ?? 1)));
  const m = stdout.match(/build[_-]?id[=: ]+([a-z0-9_-]+)/i);
  const buildId = m?.[1];
  const blockedByRunningBuild = /another build is already running/i.test(stderr) || /another build is already running/i.test(stdout);
  return c.json({
    ok: exitCode === 0 && !!buildId && !blockedByRunningBuild,
    exitCode,
    path,
    build_id: buildId,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
    error: blockedByRunningBuild ? "another build is already running" : (!buildId ? "rds-start did not return a build_id" : undefined),
  }, exitCode === 0 && !!buildId && !blockedByRunningBuild ? 200 : 409);
});

// ---------- docs ------------------------------------------------------------

app.get("/docs", (c) => {
  const statusItems = [
    ["Source of truth", "The installed checkout is the operating copy; runtime data lives in the configured data root, not in Git."],
    ["Canonical remote", "Push RDS changes to your checkout's Git remote; the dashboard itself never writes to Git."],
    ["Service naming", "Do not rename service labels, paths, or runtime files during ordinary feature work."],
  ];
  const docSections = [
    ["Docs index", "docs/README.md", "Map of all RDS documentation."],
    ["Running on Zo", "docs/RUNNING_ON_ZO.md", "Host model plus full setup checklist: environment, Postgres, smoke build, dashboard service, updating."],
    ["Architecture", "docs/ARCHITECTURE.md", "Pipeline shape, dashboard/service model, runtime data layout, state model, and ownership boundaries."],
    ["Autonomy", "docs/AUTONOMY.md", "Goal Mode evidence-driven repair loop and operator-controlled Agent Sessions."],
    ["Pipeline", "docs/PIPELINE.md", "Stage-by-stage behavior, gates, evidence, QA, deploy, and recovery contracts."],
    ["Components", "docs/COMPONENTS.md", "Vendored component inventory, refresh playbook, and third-party notices."],
    ["Stacks and skills", "docs/STACKS_AND_SKILLS.md", "Supported stack manifests, skill selection, and readiness notes."],
    ["Troubleshooting", "docs/TROUBLESHOOTING.md", "Common failure modes, diagnosis commands, and recovery paths."],
    ["Project", "docs/PROJECT.md", "Maturity, roadmap, and change-history policy."],
  ];
  const statusRows = [
    ["running", "A controller process is alive and recent evidence is moving forward."],
    ["recovering", "A fixer/action run is active and mapped to a known blocker."],
    ["blocked", "Required evidence is missing or failing with a known next action."],
    ["failed", "A stage failed and no safe autonomous recovery remains."],
    ["pending_review", "All required evidence passes and the preview reflects the latest deploy."],
    ["approved", "Operator accepted the build after review."],
  ];
  return c.html(layout("Documentation", `
    <div class="max-w-[1180px] mx-auto flex flex-col gap-component-gap">
      <div class="rds-page-header">
        <div>
          <div class="rds-page-eyebrow">Reference</div>
          <h1 class="rds-page-title flex items-center gap-2">${icon("menu_book", 24, "text-primary-container")}<span>RDS Documentation</span></h1>
          <p class="rds-page-copy">Operator-facing map of the documentation for this RDS install.</p>
        </div>
        <a class="rds-action-secondary" href="https://github.com/chrissotraidis/RDS" target="_blank" rel="noopener noreferrer">${icon("open_in_new", 14)}<span>GitHub</span></a>
      </div>

      <section class="rds-doc-hero-grid grid grid-cols-1 lg:grid-cols-[1.1fr_0.9fr] gap-gutter">
        <div class="rds-doc-panel rds-doc-panel-compact rds-shell-panel rounded-DEFAULT p-container-padding">
          <div class="rds-doc-section-head">
            <div>
              <div class="font-ribbon text-ribbon text-tertiary-container uppercase tracking-wide">Repo status</div>
              <h2 class="font-h2 text-h2 text-on-surface mt-1">The checkout is the working copy</h2>
            </div>
            <span class="rds-doc-count">3 rules</span>
          </div>
          <div class="rds-doc-status-list mt-3">
            ${statusItems.map(([title, body]) => `
              <div class="rds-doc-mini-row">
                <div class="font-h2 text-h2 text-on-surface">${escapeHtml(title)}</div>
                <p class="font-table text-table text-on-surface-variant">${escapeHtml(body)}</p>
              </div>
            `).join("")}
          </div>
        </div>

        <div class="rds-doc-panel rds-doc-panel-compact rds-shell-panel rounded-DEFAULT p-container-padding">
          <div class="font-ribbon text-ribbon text-primary-container uppercase tracking-wide">Truth states</div>
          <h2 class="font-h2 text-h2 text-on-surface mt-1">What the dashboard should show</h2>
          <div class="rds-doc-state-list mt-3 divide-y divide-outline-variant/60">
            ${statusRows.map(([status, meaning]) => `
              <div class="py-2">
                <div class="font-code text-code text-on-surface">${escapeHtml(status)}</div>
                <div class="font-table text-table text-on-surface-variant">${escapeHtml(meaning)}</div>
              </div>
            `).join("")}
          </div>
        </div>
      </section>

      <section class="rds-doc-callout rds-doc-autonomy-row rds-shell-panel rounded-DEFAULT p-container-padding">
        <div class="min-w-0">
          <div class="font-ribbon text-ribbon text-error uppercase tracking-wide">Current autonomy gap</div>
          <h2 class="font-h2 text-h2 text-on-surface mt-1">RDS is not done when a preview exists</h2>
        </div>
        <p class="font-body text-body text-on-surface-variant">Closed loop means: read PRD, build, walk as real personas, classify blockers, repair, redeploy, rerun QA, and stop only when evidence passes or a precise human blocker remains. See <code class="font-code text-code text-primary-container">docs/AUTONOMY.md</code>.</p>
      </section>

      <section class="rds-doc-panel rds-shell-panel rounded-DEFAULT p-container-padding">
          <div class="font-ribbon text-ribbon text-primary-container uppercase tracking-wide">Canonical docs</div>
          <h2 class="font-h2 text-h2 text-on-surface mt-1">Read these files first</h2>
          <p class="font-body text-body text-on-surface-variant mt-2">This page is an index, not a second source of truth. The files below are the maintained docs; use the component inventory as the authority for vendored dependency names and refresh steps.</p>
          <div class="rds-doc-card-grid rds-doc-directory mt-4">
            ${docSections.map(([title, path, body]) => `
              <div class="rds-doc-card rds-doc-directory-row">
                <div class="font-h2 text-h2 text-on-surface">${escapeHtml(title)}</div>
                <div class="font-code text-code text-primary-container">${escapeHtml(path)}</div>
                <p class="font-table text-table text-on-surface-variant">${escapeHtml(body)}</p>
              </div>
            `).join("")}
          </div>
      </section>

      <section class="rds-doc-panel rds-shell-panel rounded-DEFAULT p-container-padding">
        <div class="font-ribbon text-ribbon text-primary-container uppercase tracking-wide">Fast paths</div>
        <h2 class="font-h2 text-h2 text-on-surface mt-1">Common operator views</h2>
        <p class="font-body text-body text-on-surface-variant mt-2">Use these routes for live operations. Use the workspace docs for implementation details before changing pipeline behavior.</p>
        <div class="mt-3 flex flex-wrap gap-2">
          <a href="/settings/stacks" class="inline-flex items-center gap-1 bg-surface-container-high border border-outline-variant rounded px-2 py-1 font-ribbon text-ribbon text-on-surface hover:border-primary-container">${icon("account_tree", 14)}<span>Stacks</span></a>
          <a href="/settings/skills" class="inline-flex items-center gap-1 bg-surface-container-high border border-outline-variant rounded px-2 py-1 font-ribbon text-ribbon text-on-surface hover:border-primary-container">${icon("extension", 14)}<span>Skills</span></a>
          <a href="/audit" class="inline-flex items-center gap-1 bg-surface-container-high border border-outline-variant rounded px-2 py-1 font-ribbon text-ribbon text-on-surface hover:border-primary-container">${icon("analytics", 14)}<span>Activity</span></a>
        </div>
      </section>
    </div>
    <script>${clientScript()}</script>
  `, { nav: "docs", topbarTab: "overview" }));
});

// ---------- chat page (top-level) -------------------------------------------

app.get("/agents", (c) => {
  const sessions = listAgentSessions();
  const health = agentHealthRows();
  const sessionRows = sessions.map((s) => {
    const providerLabel = s.provider === "claude-code" ? "Claude Code" : s.provider === "codex" ? "Codex" : s.provider || "agent";
    const changed = (s.changed_files || []).slice(0, 5);
    return `<tr class="border-t border-outline-variant/50 align-top">
      <td class="px-3 py-2">
        <div class="font-code text-[11px] text-primary-container">${escapeHtml(s.id)}</div>
        <div class="font-table text-table text-on-surface-variant mt-1">${escapeHtml(providerLabel)} · ${escapeHtml(s.mode || "interactive")}</div>
      </td>
      <td class="px-3 py-2 max-w-[360px]">
        <div class="font-body text-body text-on-surface break-words">${escapeHtml(s.task || "")}</div>
        ${s.build_id ? `<a href="/b/${encodeURIComponent(s.build_id)}" class="font-code text-[10px] text-primary-container hover:underline">${escapeHtml(s.build_id)}</a>` : `<span class="font-code text-[10px] text-outline">repo-level</span>`}
      </td>
      <td class="px-3 py-2">
        <span class="px-2 py-0.5 rounded-DEFAULT border font-ribbon text-ribbon ${agentStatusTone(s.status)}">${escapeHtml(s.status || "unknown")}</span>
        <div class="font-code text-[10px] text-outline mt-1">${escapeHtml(s.updated_at || "")}</div>
      </td>
      <td class="px-3 py-2">
        <div class="font-code text-[11px] text-on-surface-variant break-all">${escapeHtml(s.branch || "—")}</div>
        <div class="font-code text-[10px] text-outline break-all">${escapeHtml(s.worktree_path || "—")}</div>
      </td>
      <td class="px-3 py-2">
        <div class="font-code text-[11px] text-primary-container break-all">tmux attach -t ${escapeHtml(s.tmux_session || "—")}</div>
        ${changed.length ? `<div class="mt-1 flex flex-wrap gap-1">${changed.map((f) => `<span class="font-code text-[10px] border border-outline-variant rounded px-1 py-0.5 text-on-surface-variant">${escapeHtml(f)}</span>`).join("")}</div>` : ""}
      </td>
      <td class="px-3 py-2">
        <div class="flex flex-wrap gap-1 font-ribbon text-ribbon">
          <button type="button" onclick="agentSessionAction('${escapeHtml(s.id)}','status')" class="px-2 py-1 border border-outline-variant rounded text-on-surface hover:border-primary-container">Status</button>
          <button type="button" onclick="agentSessionAction('${escapeHtml(s.id)}','diff')" class="px-2 py-1 border border-outline-variant rounded text-on-surface hover:border-primary-container">Diff</button>
          <button type="button" onclick="agentSessionAction('${escapeHtml(s.id)}','review')" class="px-2 py-1 border border-outline-variant rounded text-on-surface hover:border-primary-container">Review</button>
          <button type="button" onclick="agentSessionAction('${escapeHtml(s.id)}','handoff')" class="px-2 py-1 border border-outline-variant rounded text-on-surface hover:border-primary-container">Handoff</button>
          <button type="button" onclick="agentSessionAction('${escapeHtml(s.id)}','stop')" class="px-2 py-1 border border-outline-variant rounded text-on-surface hover:border-primary-container">Stop</button>
          <button type="button" onclick="agentSessionAction('${escapeHtml(s.id)}','merge')" class="px-2 py-1 border border-secondary/40 rounded text-secondary hover:bg-secondary-container/10">Merge</button>
          <button type="button" onclick="agentSessionAction('${escapeHtml(s.id)}','discard')" class="px-2 py-1 border border-error/40 rounded text-error hover:bg-error/10">Discard</button>
        </div>
      </td>
    </tr>`;
  }).join("");
  return c.html(layout("Agent Sessions", `
    <div class="max-w-[1280px] mx-auto flex flex-col gap-component-gap">
      <div class="rds-page-header">
        <div>
          <div class="rds-page-eyebrow">Workers</div>
          <h1 class="rds-page-title flex items-center gap-2">${icon("smart_toy", 24, "text-primary-container")}<span>Agent Sessions</span></h1>
          <p class="rds-page-copy">Persistent Claude Code or Codex workers in isolated git worktrees, managed from one operator control plane.</p>
        </div>
        <a class="rds-action-secondary" href="/docs">${icon("menu_book", 14)}<span>Docs</span></a>
      </div>

      <div class="flex items-center gap-2 flex-wrap" aria-label="Runtime health">
        ${health.map((row) => {
          const okChip = row.ok;
          const value = row.value === "missing" ? "not installed" : row.value;
          const tone = okChip
            ? "border-primary-container/40 bg-primary-container/10 text-primary-container"
            : "border-outline-variant bg-surface-container-low text-on-surface-variant";
          return `<span class="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-full border font-ribbon text-ribbon whitespace-nowrap ${tone}" title="${escapeHtml(row.note)}">${icon(okChip ? "check_circle" : "do_not_disturb_on", 14)}<span>${escapeHtml(row.name)}</span><span class="font-code text-[10.5px] ${okChip ? "text-primary-container/80" : "text-outline"}">${escapeHtml(value)}</span></span>`;
        }).join("")}
      </div>

      <section class="rds-agent-sessions rds-shell-panel rounded-DEFAULT overflow-hidden">
        <header class="px-container-padding py-gutter border-b border-outline-variant flex items-center justify-between gap-3">
          <h2 class="font-h2 text-h2 text-on-surface">Sessions</h2>
          <span class="font-ribbon text-ribbon text-on-surface-variant">${sessions.length} total</span>
        </header>
        <div class="overflow-x-auto">
          <table class="w-full text-left">
            <thead class="bg-surface text-on-surface-variant font-ribbon text-ribbon">
              <tr><th class="px-3 py-2">session</th><th class="px-3 py-2">task</th><th class="px-3 py-2">status</th><th class="px-3 py-2">branch/worktree</th><th class="px-3 py-2">attach/changes</th><th class="px-3 py-2">actions</th></tr>
            </thead>
            <tbody>${sessionRows || `<tr><td colspan="6" class="px-3 py-6 text-on-surface-variant font-body text-body italic">No worker sessions yet — start one from a build\'s chat ("Start a Codex worker to review the current diff").</td></tr>`}</tbody>
          </table>
        </div>
      </section>

      <p class="font-table text-table text-on-surface-variant px-1">
        Workers are chat-driven: ask in the build\'s chat, confirm the scoped action card RDS proposes,
        then monitor, review, handoff, merge, stop, or discard the session here. Nothing merges or
        pushes without you. <a href="/docs" class="text-primary-container hover:underline">Details in docs</a>.
      </p>
    </div>
    <script>
      ${clientScript()}
      async function agentSessionAction(sessionId, action) {
        var confirm = '';
        var provider = '';
        var task = '';
        if (action === 'stop') {
          if (!await rdsConfirm('Stop agent session "' + sessionId + '"?', { title: 'Stop agent?', warn: true, okLabel: 'Stop' })) return;
          confirm = 'STOP_AGENT';
        } else if (action === 'discard') {
          if (!await rdsConfirm('Discard agent session "' + sessionId + '" and remove its worktree? Logs and session JSON are preserved.', { title: 'Discard agent?', danger: true, okLabel: 'Discard' })) return;
          confirm = 'DISCARD';
        } else if (action === 'merge') {
          if (!await rdsConfirm('Merge agent session "' + sessionId + '" into its recorded base branch locally? This does not push to GitHub.', { title: 'Merge local branch?', warn: true, okLabel: 'Merge locally' })) return;
          confirm = 'MERGE';
        } else if (action === 'review') {
          provider = await rdsPrompt('Review with which provider?', 'codex', { title: 'Cross-agent review', placeholder: 'codex or claude-code' });
          if (!provider) return;
          provider = provider.trim() === 'claude-code' ? 'claude-code' : 'codex';
          if (!await rdsConfirm('Run a bounded ' + provider + ' review of "' + sessionId + '"? This writes a review markdown file and does not modify the worktree.', { title: 'Run cross-agent review?', okLabel: 'Run review' })) return;
          confirm = 'REVIEW_AGENT';
        } else if (action === 'handoff') {
          provider = await rdsPrompt('Hand off to which provider?', 'codex', { title: 'Agent handoff', placeholder: 'codex or claude-code' });
          if (!provider) return;
          provider = provider.trim() === 'claude-code' ? 'claude-code' : 'codex';
          task = await rdsPrompt('What should ' + provider + ' do next?', 'Review the current diff, diagnose risks, and continue only if the next fix is clear.', { title: 'Handoff task' });
          if (!task || task.trim().length < 8) { rdsToast('Handoff task is required.', 'warn'); return; }
          if (!await rdsConfirm('Start a new ' + provider + ' handoff session from "' + sessionId + '"?', { title: 'Start handoff?', warn: true, okLabel: 'Start handoff' })) return;
          confirm = 'HANDOFF_AGENT';
        }
        setAgentSessionResult('Running ' + action + ' for ' + sessionId + '…');
        var res = await fetch('/agent-sessions/' + encodeURIComponent(sessionId) + '/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-RDS-Token': token() },
          body: JSON.stringify({ action: action, confirm: confirm, provider: provider, task: task })
        });
        var text = await res.text();
        setAgentSessionResult(res.status + ' ' + text, !res.ok);
        if ((action === 'stop' || action === 'discard' || action === 'merge' || action === 'handoff') && res.ok) setTimeout(function(){ location.reload(); }, 900);
      }
      window.agentSessionAction = agentSessionAction;
    </script>
  `, { nav: "agents", topbarTab: "overview" }));
});

app.get("/chat", (c) => {
  const initial = c.req.query("s") || "";
  const buildId = c.req.query("build") || c.req.query("b") || "";
  return c.html(layout("Chat", `
    <div class="rds-chat-page h-auto md:h-full flex flex-col" style="min-height:calc(100dvh - 80px)">
      <div class="rds-chat-header rds-page-header shrink-0">
        <div class="min-w-0">
          <a href="/" class="md:hidden inline-flex mb-1 font-ribbon text-ribbon text-on-surface-variant hover:text-on-surface">← hub</a>
          <div class="rds-page-eyebrow hidden md:block">Command thread</div>
          <h1 class="rds-page-title">Chat with RDS</h1>
          <p class="rds-page-copy hidden md:block">Persistent server-side threads. Send a message and navigate freely; RDS keeps thinking and the reply lands in the thread when ready.</p>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          <button type="button" onclick="toggleChatThreads()" class="md:hidden rds-action-secondary">${icon("forum", 14)}<span>Threads</span></button>
          <a href="/" class="hidden md:inline-flex font-ribbon text-ribbon text-on-surface-variant hover:text-on-surface">← back to hub</a>
        </div>
      </div>
      <div class="rds-chat-grid flex-1 min-h-0 rds-mobile-stack grid grid-cols-[260px_minmax(0,1fr)] gap-3">
        <aside id="chat-sessions-rail" class="rds-chat-rail rds-chat-rail-collapsed bg-surface-container panel-border rounded-DEFAULT flex flex-col min-h-0">
          <div class="p-unit border-b border-[#242b28] flex items-center justify-between gap-2">
            <span class="font-h2 text-h2 text-on-surface">Threads</span>
            <button type="button" onclick="newChatThread()" title="New thread" class="text-on-surface-variant hover:text-on-surface flex items-center gap-1 font-ribbon text-ribbon">${icon("add", 14)}<span>new</span></button>
          </div>
          <ul id="chat-session-list" class="flex-1 min-h-0 overflow-auto divide-y divide-[#242b28]/60"></ul>
        </aside>
        <section class="rds-chat-panel-wrap bg-surface-container panel-border rounded-DEFAULT flex flex-col min-h-0 min-w-0">
          ${chatPanel({ initialSessionId: initial, initialBuildId: buildId })}
        </section>
        <div id="chat-threads-backdrop" class="hidden" onclick="toggleChatThreads(false)" aria-hidden="true"></div>
      </div>
    </div>
    <script>
      window.RDS_CHAT_INITIAL_SESSION = ${JSON.stringify(initial)};
      window.RDS_CHAT_INITIAL_BUILD = ${JSON.stringify(buildId)};
      window.RDS_CHAT_FULLPAGE = true;
      ${clientScript()}
      ${chatScript()}
    </script>
  `, { nav: "chat", topbarTab: "overview" }));
});

// ---------- settings --------------------------------------------------------

function settingsTabNav(active: "start" | "reference" | "catalog" | "inventory" | "runtime"): string {
  const tabs = [
    ["start", "/settings", "Start"],
    ["reference", "/settings/stacks", "Reference"],
    ["catalog", "/settings/skills", "Catalog"],
    ["inventory", "/settings/components", "Inventory"],
    ["runtime", "/settings#runtime", "Runtime"],
  ];
  return `<nav class="flex flex-wrap gap-2">${tabs.map(([key, href, label]) => `
    <a data-settings-tab="${key}" href="${href}" class="px-3 py-1.5 rounded-DEFAULT border ${active === key ? "border-primary-container text-primary-container bg-primary-container/10" : "border-outline-variant text-on-surface-variant hover:text-on-surface hover:border-primary-container"} font-ribbon text-ribbon">${label}</a>
  `).join("")}</nav>`;
}

app.get("/settings", (c) => {
  const settings = readSettings();
  const claudeOk = spawnSync("which", ["claude"], { stdio: "ignore" }).status === 0;
  const codexOk = spawnSync("which", ["codex"], { stdio: "ignore" }).status === 0;
  const stacks = stackOptions();
  const readyStacks = stacks.filter((stack) => stack.status === "ready" && NEW_BUILD_STACK_ORDER.includes(stack.id));
  const deferredStacks = stacks.filter((stack) => stack.status !== "ready");
  const skills = skillOptions();
  const readySkills = skills.filter((skill) => skill.status === "ready");
  const curatedSkills = skills.filter((skill) => skill.status === "curated");
  const coreSkills = NEW_BUILD_CORE_SKILLS.map((slug) => skills.find((skill) => skill.slug === slug)).filter((skill): skill is SkillOption => !!skill);
  const tokenConfigured = !!process.env.RDS_DASHBOARD_TOKEN;
  const agentHealth = agentHealthRows();
  const runtimeCards = [
    { label: "Dashboard port", value: process.env.PORT || "4000", note: "Managed service listens here" },
    { label: "Model settings", value: SETTINGS_PATH.replace(RDS_ROOT + "/", ""), note: "Defaults for future/resumed builds" },
    { label: "Version lock", value: VERSION_LOCK_PATH.replace(RDS_ROOT + "/", ""), note: "Vendored component provenance" },
    { label: "Build state", value: BUILDS_DIR.replace(RDS_ROOT + "/", ""), note: "Per-build state, logs, artifacts" },
  ];

  return c.html(layout("Settings", `
    <div class="max-w-[1180px] mx-auto flex flex-col gap-component-gap">
      <div class="rds-page-header">
        <div>
          <div class="rds-page-eyebrow">Control surface</div>
          <h1 class="rds-page-title flex items-center gap-2">${icon("settings", 24, "text-primary-container")}<span>Settings</span></h1>
          <p class="rds-page-copy">Operational defaults and registry health. These settings affect future builds; active builds keep the provider/model recorded at build start.</p>
        </div>
        <a class="rds-action-secondary" href="/">${icon("arrow_back", 14)}<span>Hub</span></a>
      </div>

      <div class="flex items-center gap-2 flex-wrap">
        <span class="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-full border border-outline-variant bg-surface-container-low font-ribbon text-ribbon text-on-surface-variant whitespace-nowrap"><span class="font-code text-[11px] text-on-surface">${readyStacks.length}</span><span>ready stacks</span></span>
        <span class="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-full border border-outline-variant bg-surface-container-low font-ribbon text-ribbon text-on-surface-variant whitespace-nowrap"><span class="font-code text-[11px] text-on-surface">${readySkills.length}/${skills.length}</span><span>ready skills</span></span>
        <span class="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-full border font-ribbon text-ribbon whitespace-nowrap ${tokenConfigured ? "border-primary-container/40 bg-primary-container/10 text-primary-container" : "border-tertiary-container/40 bg-tertiary-container/10 text-tertiary-container"}" title="${tokenConfigured ? "X-RDS-Token write gate is active" : "Set RDS_DASHBOARD_TOKEN to enable the write gate"}">${icon(tokenConfigured ? "check_circle" : "schedule", 14)}<span>write token ${tokenConfigured ? "set" : "not set"}</span></span>
        <span class="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-full border border-outline-variant bg-surface-container-low font-ribbon text-ribbon text-on-surface-variant whitespace-nowrap"><span>default builder</span><span class="font-code text-[11px] text-on-surface">${escapeHtml(settings.inferenceProvider)}</span></span>
      </div>

      ${settingsTabNav("start")}

      <section class="rds-shell-panel rounded-DEFAULT p-container-padding flex flex-col gap-stack-gap">
        <h2 class="font-h2 text-h2 text-on-surface">Start a build</h2>
        <p class="font-table text-table text-on-surface-variant">Use templates, skills, and writes only after RDS has analyzed the source.</p>
        <div class="flex flex-wrap gap-2 font-ribbon text-ribbon text-on-surface-variant">
          <span>templates</span><span>skills</span><span>writes</span>
        </div>
      </section>

      <form id="settings-form" onsubmit="return saveSettings(event)" class="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_360px] gap-component-gap">
        <section class="rds-shell-panel rounded-DEFAULT p-container-padding flex flex-col gap-gutter">
          <div>
            <h2 class="font-h2 text-h2 text-on-surface flex items-center gap-2">${icon("smart_toy", 18, "text-primary-container")}<span>Builder defaults</span></h2>
            <p class="font-table text-table text-on-surface-variant mt-1">Used by new builds, build chat, fixer, and resume before scaffold. In-flight builds keep their saved provider/model.</p>
          </div>

          <div class="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_220px] gap-gutter items-start">
            <label class="flex flex-col gap-1">
              <span class="font-ribbon text-ribbon text-on-surface-variant">Default builder</span>
              <select name="inferenceProvider" class="bg-surface-container-lowest border border-outline-variant rounded-DEFAULT px-2 py-2 font-code text-code text-on-surface focus:border-primary-container focus:outline-none">
                <option value="claude" ${settings.inferenceProvider === "claude" ? "selected" : ""}>Claude Code</option>
                <option value="codex" ${settings.inferenceProvider === "codex" ? "selected" : ""}>Codex</option>
              </select>
              <span id="provider-help" class="font-table text-table text-on-surface-variant">Claude is the V1 default. Codex is available for compatibility tests and focused code edits.</span>
            </label>
            <div class="grid grid-cols-2 gap-2">
              <div class="bg-surface border border-outline-variant rounded-DEFAULT p-2 font-ribbon text-ribbon ${claudeOk ? "text-primary-container" : "text-error"}">${icon(claudeOk ? "check_circle" : "error", 14)}<span>Claude CLI</span></div>
              <div class="bg-surface border border-outline-variant rounded-DEFAULT p-2 font-ribbon text-ribbon ${codexOk ? "text-primary-container" : "text-on-surface-variant"}">${icon(codexOk ? "check_circle" : "do_not_disturb_on", 14)}<span>Codex CLI${codexOk ? "" : " · not installed"}</span></div>
            </div>
          </div>

          <div class="border border-outline-variant rounded-DEFAULT overflow-hidden">
            <div class="px-3 py-2 border-b border-outline-variant bg-surface font-h2 text-h2 text-on-surface flex items-center gap-2">${icon("terminal", 16, "text-primary-container")}<span>Agent Sessions health</span></div>
            <div class="divide-y divide-outline-variant/60">
              ${agentHealth.map((row) => `
                <div class="px-3 py-2 grid grid-cols-[140px_1fr] gap-2 items-start">
                  <div class="font-ribbon text-ribbon ${row.ok ? "text-primary-container" : "text-on-surface-variant"}">${icon(row.ok ? "check_circle" : "do_not_disturb_on", 14)}<span>${escapeHtml(row.name)}</span></div>
                  <div class="min-w-0">
                    <div class="font-code text-[11px] text-on-surface break-all">${escapeHtml(row.value === "missing" ? "not installed" : row.value)}</div>
                    <div class="font-table text-table text-on-surface-variant">${escapeHtml(row.note)}</div>
                  </div>
                </div>`).join("")}
            </div>
          </div>

          <div class="grid grid-cols-1 md:grid-cols-2 gap-gutter">
            <label class="flex flex-col gap-1" data-provider-field="claude">
              <span class="font-ribbon text-ribbon text-on-surface-variant">Claude model</span>
              <select name="claudeModel" class="bg-surface-container-lowest border border-outline-variant rounded-DEFAULT px-2 py-2 font-code text-code text-on-surface focus:border-primary-container focus:outline-none">
                ${CLAUDE_MODELS.map((m) => `<option value="${escapeHtml(m)}" ${settings.claudeModel === m ? "selected" : ""}>${escapeHtml(m)}</option>`).join("")}
              </select>
              <span class="font-table text-table text-on-surface-variant">Only submitted when Claude is selected.</span>
            </label>
            <label class="flex flex-col gap-1" data-provider-field="codex">
              <span class="font-ribbon text-ribbon text-on-surface-variant">Codex model</span>
              <input name="codexModel" list="codex-model-suggestions-settings" value="${escapeHtml(settings.codexModel)}" placeholder="blank = Codex config default" class="bg-surface-container-lowest border border-outline-variant rounded-DEFAULT px-2 py-2 font-code text-code text-on-surface focus:border-primary-container focus:outline-none" />
              <datalist id="codex-model-suggestions-settings">
                ${CODEX_MODEL_SUGGESTIONS.map((m) => `<option value="${escapeHtml(m)}"></option>`).join("")}
              </datalist>
              <span class="font-table text-table text-on-surface-variant">Only submitted when Codex is selected.</span>
            </label>
          </div>

          <div class="pt-gutter border-t border-outline-variant flex flex-col md:flex-row md:items-end gap-gutter md:justify-between">
            <label class="flex flex-col gap-1 w-full md:max-w-[260px]">
              <span class="font-ribbon text-ribbon text-on-surface-variant">Theme</span>
              <select name="theme" class="bg-surface-container-lowest border border-outline-variant rounded-DEFAULT px-2 py-2 font-code text-code text-on-surface focus:border-primary-container focus:outline-none">
                <option value="dark" ${settings.theme === "dark" ? "selected" : ""}>Dark</option>
                <option value="light" ${settings.theme === "light" ? "selected" : ""}>Light</option>
                <option value="system" ${settings.theme === "system" ? "selected" : ""}>System</option>
              </select>
            </label>
            <button type="submit" class="rds-action-primary w-full md:w-auto">${icon("save", 14)}<span>Save settings</span></button>
          </div>
        </section>

        <aside class="flex flex-col gap-component-gap">
          <section id="runtime" class="rds-shell-panel rounded-DEFAULT p-container-padding flex flex-col gap-stack-gap">
            <div class="flex items-start justify-between gap-3">
              <div>
                <h2 class="font-h2 text-h2 text-on-surface flex items-center gap-2">${icon("fact_check", 18, "text-primary-container")}<span>V1 registry</span></h2>
                <p class="font-table text-table text-on-surface-variant mt-1">Stacks are runtime templates. Skills are capability packs resolved from the PRD before build.</p>
              </div>
            </div>
            <div class="grid grid-cols-2 gap-2">
              <div class="bg-surface border border-outline-variant rounded-DEFAULT p-2">
                <div class="font-code text-[18px] text-on-surface">${readyStacks.length}</div>
                <div class="font-ribbon text-ribbon text-on-surface-variant">launchable</div>
              </div>
              <div class="bg-surface border border-outline-variant rounded-DEFAULT p-2">
                <div class="font-code text-[18px] text-on-surface">${readySkills.length}</div>
                <div class="font-ribbon text-ribbon text-on-surface-variant">skill guides</div>
              </div>
            </div>
            <div class="grid grid-cols-1 gap-2">
              <a href="/settings/stacks" class="bg-surface border border-outline-variant rounded-DEFAULT p-2 hover:border-primary-container transition-colors">
                <div class="font-ribbon text-ribbon text-on-surface flex items-center gap-1">${icon("layers", 14, "text-primary-container")}<span>Build types and stacks</span></div>
                <p class="font-table text-table text-on-surface-variant mt-1">Decision guide for Rails, Next.js, Python AI, Astro, 3D, games, mobile, extensions, and asset pipelines.</p>
              </a>
              <a href="/settings/skills" class="bg-surface border border-outline-variant rounded-DEFAULT p-2 hover:border-primary-container transition-colors">
                <div class="font-ribbon text-ribbon text-on-surface flex items-center gap-1">${icon("extension", 14, "text-primary-container")}<span>Skills catalog</span></div>
                <p class="font-table text-table text-on-surface-variant mt-1">Searchable capability catalog with rationale, source links, verified RDS guides, and stack applicability.</p>
              </a>
            </div>
            <div>
              <div class="font-ribbon text-ribbon text-on-surface-variant mb-1">New Build core skills</div>
              <div class="flex flex-wrap gap-1">
                ${coreSkills.map((skill) => `<span class="font-code text-[10px] border border-outline-variant rounded px-1.5 py-0.5 text-on-surface-variant">${escapeHtml(skill.slug)}</span>`).join("")}
              </div>
              <p class="font-table text-table text-on-surface-variant mt-1">Core skills are ready RDS-owned skills. Curated skills are researched recommendations RDS can reason about before full installer support lands.</p>
            </div>
            <details>
              <summary class="cursor-pointer font-ribbon text-ribbon text-on-surface-variant">Ready stacks</summary>
              <div class="mt-2 flex flex-col gap-1">
                ${readyStacks.map((stack) => `<div class="flex items-center justify-between gap-2 bg-surface border border-outline-variant rounded-DEFAULT px-2 py-1"><span class="font-ribbon text-ribbon text-on-surface truncate">${escapeHtml(stack.label)}</span><code class="font-code text-[10px] text-on-surface-variant">${escapeHtml(stack.id)}</code></div>`).join("")}
              </div>
            </details>
            ${deferredStacks.length ? `<details><summary class="cursor-pointer font-ribbon text-ribbon text-on-surface-variant">Deferred/stub stacks</summary><div class="mt-2 flex flex-wrap gap-1">${deferredStacks.map((stack) => `<span class="font-code text-[10px] border border-outline-variant rounded px-1.5 py-0.5 text-on-surface-variant">${escapeHtml(stack.id)}:${escapeHtml(stack.status)}</span>`).join("")}</div></details>` : ""}
          </section>

          <section class="rds-shell-panel rounded-DEFAULT p-container-padding flex flex-col gap-stack-gap">
            <h2 class="font-h2 text-h2 text-on-surface flex items-center gap-2">${icon("dns", 18, "text-primary-container")}<span>Runtime</span></h2>
            <div class="flex flex-col gap-2">
              ${runtimeCards.map((item) => `<div class="bg-surface border border-outline-variant rounded-DEFAULT p-2"><div class="font-ribbon text-ribbon text-on-surface-variant">${escapeHtml(item.label)}</div><code class="font-code text-[11px] text-on-surface break-all">${escapeHtml(item.value)}</code><div class="font-table text-table text-on-surface-variant">${escapeHtml(item.note)}</div></div>`).join("")}
            </div>
            <div class="bg-surface border border-outline-variant rounded-DEFAULT p-2 font-table text-table ${tokenConfigured ? "text-on-surface-variant" : "text-error"}">
              Write token: ${tokenConfigured ? "configured" : "missing; POST actions return 503"}
            </div>
          </section>
        </aside>
      </form>

      <details class="rds-inventory-disclosure bg-surface-container border border-outline-variant rounded-DEFAULT">
        <summary class="cursor-pointer font-h2 text-h2 text-on-surface">
          <span>Vendored component inventory</span>
          <span class="font-ribbon text-ribbon text-on-surface-variant">${pipelineComponents().length} components</span>
        </summary>
        <div class="rds-inventory-body">${renderPipelineComponents()}</div>
      </details>

      <div class="font-code text-[11px] text-on-surface-variant">Settings persist at <code>${escapeHtml(SETTINGS_PATH)}</code>. Changes apply to new builds and resumed builds before the scaffold stage.</div>
    </div>
    <script>
      ${clientScript()}
      var settingsForm = document.getElementById('settings-form');
      rdsSyncProviderFields(settingsForm);
      if (settingsForm && settingsForm.inferenceProvider) {
        settingsForm.inferenceProvider.addEventListener('change', function(){ rdsSyncProviderFields(settingsForm); });
      }
      async function saveSettings(event) {
        event.preventDefault();
        var form = event.currentTarget;
        var body = {
          inferenceProvider: form.inferenceProvider ? form.inferenceProvider.value : 'claude',
          claudeModel: form.claudeModel ? form.claudeModel.value : 'claude-opus-4-6',
          codexModel: form.codexModel ? form.codexModel.value : '',
          theme: form.theme ? form.theme.value : 'dark'
        };
        var res = await fetch('/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-RDS-Token': token() },
          body: JSON.stringify(body)
        });
        var text = await res.text();
        if (res.ok) rdsToast('Settings saved.', 'info');
        else rdsToast('Save failed: ' + res.status + ' ' + text, 'error');
        return false;
      }
    </script>
  `, { nav: "settings", topbarTab: "overview" }));
});

app.get("/settings/stacks", (c) => {
  const stacks = stackOptions();
  const readyStacks = stacks.filter((stack) => stack.status === "ready" && NEW_BUILD_STACK_ORDER.includes(stack.id));
  const deferredStacks = stacks.filter((stack) => stack.status !== "ready");
  const buildTypes = [
    { id: "auto", label: "Auto", note: "Let RDS infer the taste/QA lens from the PRD." },
    { id: "web-app", label: "Web app", note: "Interactive product UI; pushes scoring toward Rails or Next.js depending on content." },
    { id: "dashboard", label: "Dashboard", note: "Operational screen with tables, filters, charts, and actions; commonly Rails." },
    { id: "internal-tool", label: "Internal tool", note: "Workflow-heavy tool for operators; commonly Rails." },
    { id: "website", label: "Website", note: "Content/SEO/marketing lens; commonly Astro unless the PRD needs app state." },
    { id: "game", label: "Game", note: "Playable loop and interaction quality matter more than app chrome." },
    { id: "prototype", label: "Prototype", note: "Speed and idea validation matter more than full production shape." },
    { id: "hack", label: "Hack", note: "Small, intentionally rough utility or experiment." },
  ];

  return c.html(layout("Build Types", `
    <div class="max-w-[1180px] mx-auto flex flex-col gap-component-gap">
      <div class="rds-page-header">
        <div>
          <div class="rds-page-eyebrow">Runtime reference</div>
          <h1 class="rds-page-title flex items-center gap-2">${icon("layers", 24, "text-primary-container")}<span>Build Types</span></h1>
          <p class="rds-page-copy">A build type combines the runtime stack with the app-type lens QA and taste review should use.</p>
        </div>
        <div class="flex items-center gap-3 shrink-0">
          <a class="text-primary-container hover:underline font-ribbon text-ribbon whitespace-nowrap" href="/new">New Build</a>
          <a class="rds-action-secondary" href="/settings">${icon("arrow_back", 14)}<span>Settings</span></a>
        </div>
      </div>

      ${settingsTabNav("reference")}

      <section class="rds-shell-panel rounded-DEFAULT p-container-padding">
        <h2 class="font-h2 text-h2 text-on-surface">Stacks and app types</h2>
        <p class="font-table text-table text-on-surface-variant mt-1">Reference for runtime choices and the QA lens RDS applies to each build.</p>
      </section>

      <section class="rds-shell-panel rounded-DEFAULT p-container-padding">
        <div class="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h2 class="font-h2 text-h2 text-on-surface">Stack map</h2>
            <p class="font-table text-table text-on-surface-variant mt-1">Jump to the runtime family that matches the PRD. These are the same choices New Build can launch.</p>
          </div>
          <a href="/new" class="font-ribbon text-ribbon text-primary-container hover:underline">Analyze source instead</a>
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 mt-gutter">
          ${readyStacks.map((stack) => `
            <a href="#stack-${escapeHtml(stack.id)}" class="bg-surface border border-outline-variant rounded-DEFAULT p-3 hover:border-primary-container transition-colors">
              <div class="font-ribbon text-ribbon text-on-surface">${escapeHtml(stack.label)}</div>
              <div class="font-table text-table text-on-surface-variant">${escapeHtml(stack.subtitle)}</div>
              <div class="mt-2 flex flex-wrap gap-1">
                <code class="font-code text-[10px] text-on-surface-variant">${escapeHtml(stack.id)}</code>
                ${stack.category ? `<code class="font-code text-[10px] text-on-surface-variant">${escapeHtml(stack.category)}</code>` : ""}
              </div>
            </a>
          `).join("")}
        </div>
      </section>

      <section id="build-types" class="rds-shell-panel rounded-DEFAULT p-container-padding">
        <div class="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h2 class="font-h2 text-h2 text-on-surface">App type lens</h2>
            <p class="font-table text-table text-on-surface-variant mt-1">This does not choose the framework by itself. It shapes recommendation scoring, QA expectations, and taste-review language.</p>
          </div>
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 mt-gutter">
          ${buildTypes.map((type) => `
            <article id="build-type-${escapeHtml(type.id)}" class="bg-surface border border-outline-variant rounded-DEFAULT p-3">
              <h3 class="font-ribbon text-ribbon text-on-surface">${escapeHtml(type.label)}</h3>
              <code class="font-code text-[10px] text-on-surface-variant">${escapeHtml(type.id)}</code>
              <p class="font-table text-table text-on-surface-variant mt-2">${escapeHtml(type.note)}</p>
            </article>
          `).join("")}
        </div>
      </section>

      <section class="flex flex-col gap-component-gap">
        <div>
          <h2 class="font-h2 text-h2 text-on-surface">Launchable stacks</h2>
          <p class="font-table text-table text-on-surface-variant mt-1">These are end-to-end enabled in New Build. RDS recommends one after source analysis; the operator can override.</p>
        </div>
        <div class="grid grid-cols-1 gap-component-gap">
          ${readyStacks.map((stack) => renderStackReferenceCard(stack)).join("")}
        </div>
      </section>

      ${deferredStacks.length ? `
        <section class="bg-surface-container border border-outline-variant rounded-DEFAULT p-container-padding">
          <h2 class="font-h2 text-h2 text-on-surface">Deferred stacks</h2>
          <p class="font-table text-table text-on-surface-variant mt-1">Registered but not launchable from New Build until their doctors, starters, and smoke checks are complete.</p>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-2 mt-gutter">
            ${deferredStacks.map((stack) => renderStackReferenceCard(stack, true)).join("")}
          </div>
        </section>
      ` : ""}
    </div>
  `, { nav: "settings", topbarTab: "overview" }));
});

app.get("/settings/skills", (c) => {
  const skills = skillOptions();
  const readySkills = skills.filter((skill) => skill.status === "ready");
  const curatedSkills = skills.filter((skill) => skill.status === "curated");
  const roadmapSkills = skills.filter((skill) => skill.status !== "ready" && skill.status !== "curated");
  const coreSkills = NEW_BUILD_CORE_SKILLS.map((slug) => skills.find((skill) => skill.slug === slug)).filter((skill): skill is SkillOption => !!skill);
  const bySource = new Map<string, SkillOption[]>();
  for (const skill of skills) {
    const key = skillSourceLabel(skill);
    bySource.set(key, [...(bySource.get(key) || []), skill]);
  }
  const categories = Array.from(bySource.keys()).sort((a, b) => a.localeCompare(b));
  const stacks = stackOptions().filter((stack) => stack.status === "ready" && NEW_BUILD_STACK_ORDER.includes(stack.id));

  return c.html(layout("Skills Catalog", `
    <div class="max-w-[1180px] mx-auto flex flex-col gap-component-gap">
      <div class="rds-page-header">
        <div>
          <div class="rds-page-eyebrow">Capability catalog</div>
          <h1 class="rds-page-title flex items-center gap-2">${icon("extension", 24, "text-primary-container")}<span>Skills Catalog</span></h1>
          <p class="rds-page-copy">Skills are RDS capability packs. They add context, verification, integrations, deploy instructions, or stack-specific recipes when the PRD calls for them.</p>
        </div>
        <div class="flex items-center gap-3 shrink-0">
          <a class="text-primary-container hover:underline font-ribbon text-ribbon whitespace-nowrap" href="/new">New Build</a>
          <a class="rds-action-secondary" href="/settings">${icon("arrow_back", 14)}<span>Settings</span></a>
        </div>
      </div>

      ${settingsTabNav("catalog")}

      <section class="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px] gap-component-gap">
        <div class="rds-shell-panel rounded-DEFAULT p-container-padding">
          <h2 class="font-h2 text-h2 text-on-surface">How RDS uses skills</h2>
          <div class="grid grid-cols-1 md:grid-cols-3 gap-2 mt-gutter">
            <div class="bg-surface border border-outline-variant rounded-DEFAULT p-3">
              <h3 class="font-ribbon text-ribbon text-on-surface">Resolve</h3>
              <p class="font-table text-table text-on-surface-variant mt-1">The PRD, chosen stack, and app type produce a skill list in <code>build.yaml</code>.</p>
            </div>
            <div class="bg-surface border border-outline-variant rounded-DEFAULT p-3">
              <h3 class="font-ribbon text-ribbon text-on-surface">Guide</h3>
              <p class="font-table text-table text-on-surface-variant mt-1">Each skill mounts a source-linked RDS guide into the generated app so the builder knows what to implement and verify.</p>
            </div>
            <div class="bg-surface border border-outline-variant rounded-DEFAULT p-3">
              <h3 class="font-ribbon text-ribbon text-on-surface">Verify</h3>
              <p class="font-table text-table text-on-surface-variant mt-1">Ready skills have RDS-owned metadata, guide materialization, verify hooks, and explicit credential caveats when needed.</p>
            </div>
          </div>
        </div>
        <aside class="rds-shell-panel rounded-DEFAULT p-container-padding flex flex-col gap-stack-gap">
          <div class="grid grid-cols-3 gap-2">
            <div class="bg-surface border border-outline-variant rounded-DEFAULT p-2">
              <div class="font-code text-[20px] text-on-surface">${readySkills.length}</div>
              <div class="font-ribbon text-ribbon text-on-surface-variant">verified guides</div>
            </div>
            <div class="bg-surface border border-outline-variant rounded-DEFAULT p-2">
              <div class="font-code text-[20px] text-on-surface">${curatedSkills.length}</div>
              <div class="font-ribbon text-ribbon text-on-surface-variant">curated</div>
            </div>
            <div class="bg-surface border border-outline-variant rounded-DEFAULT p-2">
              <div class="font-code text-[20px] text-on-surface">${roadmapSkills.length}</div>
              <div class="font-ribbon text-ribbon text-on-surface-variant">roadmap</div>
            </div>
          </div>
          <div>
            <h2 class="font-ribbon text-ribbon text-on-surface-variant">Core New Build skills</h2>
            <div class="flex flex-col gap-2 mt-2">
              ${coreSkills.map((skill) => `
                <a href="#skill-${escapeHtml(skill.slug)}" class="bg-surface border border-outline-variant rounded-DEFAULT p-2 hover:border-primary-container transition-colors">
                  <div class="font-ribbon text-ribbon text-on-surface">${escapeHtml(skill.name)}</div>
                  <code class="font-code text-[10px] text-on-surface-variant">${escapeHtml(skill.slug)}</code>
                </a>
              `).join("")}
            </div>
          </div>
        </aside>
      </section>

      <section class="rds-shell-panel rounded-DEFAULT p-container-padding">
        <div class="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h2 class="font-h2 text-h2 text-on-surface">Find a skill</h2>
            <p class="font-ribbon text-ribbon text-primary-container mt-1">Quick category filters</p>
            <p class="font-table text-table text-on-surface-variant mt-1">Search, filter, then jump directly to the matching card. Every ready skill now has a source-linked implementation contract and verification section; external credentials and store submissions remain human-gated where the skill says so.</p>
          </div>
          <button type="button" onclick="rdsResetSkillFilters()" class="font-ribbon text-ribbon text-primary-container hover:underline">Reset filters</button>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-4 gap-2 mt-gutter">
          <input id="skill-search" type="search" placeholder="Search skills, rationale, stack..." oninput="rdsFilterSkillCatalog()" class="md:col-span-2 bg-surface border border-outline-variant rounded-DEFAULT px-3 py-2 font-body text-body text-on-surface focus:border-primary-container focus:outline-none">
          <select id="skill-status-filter" onchange="rdsFilterSkillCatalog()" class="bg-surface border border-outline-variant rounded-DEFAULT px-3 py-2 font-body text-body text-on-surface focus:border-primary-container focus:outline-none">
            <option value="">All statuses</option>
            <option value="ready">Ready</option>
            <option value="curated">Curated</option>
            <option value="roadmap">Roadmap</option>
          </select>
          <select id="skill-category-filter" onchange="rdsFilterSkillCatalog()" class="bg-surface border border-outline-variant rounded-DEFAULT px-3 py-2 font-body text-body text-on-surface focus:border-primary-container focus:outline-none">
            <option value="">All categories</option>
            ${categories.map((category) => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join("")}
          </select>
          <select id="skill-stack-filter" onchange="rdsFilterSkillCatalog()" class="md:col-span-2 bg-surface border border-outline-variant rounded-DEFAULT px-3 py-2 font-body text-body text-on-surface focus:border-primary-container focus:outline-none">
            <option value="">All stacks</option>
            <option value="universal">Universal</option>
            ${stacks.map((stack) => `<option value="${escapeHtml(stack.id)}">${escapeHtml(stack.label)}</option>`).join("")}
          </select>
          <select id="skill-sort" onchange="rdsFilterSkillCatalog()" class="bg-surface border border-outline-variant rounded-DEFAULT px-3 py-2 font-body text-body text-on-surface focus:border-primary-container focus:outline-none">
            <option value="status">Sort by readiness</option>
            <option value="name">Sort by name</option>
            <option value="category">Sort by category</option>
          </select>
          <div id="skill-filter-count" class="bg-surface border border-outline-variant rounded-DEFAULT px-3 py-2 font-ribbon text-ribbon text-on-surface-variant">${skills.length} skills shown</div>
        </div>
      </section>

      <section id="skill-results" class="flex flex-col gap-stack-gap">
        <h2 class="font-h2 text-h2 text-on-surface">Skill results</h2>
        <div id="skill-result-grid" class="grid grid-cols-1 md:grid-cols-2 gap-2">
          ${skills.map(renderSkillReferenceRow).join("")}
        </div>
      </section>

      <details class="rds-shell-panel rounded-DEFAULT p-container-padding">
        <summary class="cursor-pointer font-ribbon text-ribbon text-on-surface flex items-center justify-between gap-3">
          <span>Catalog audit</span>
          <span class="text-on-surface-variant">${categories.length} groups</span>
        </summary>
        <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2 mt-gutter">
          ${Array.from(bySource.entries()).map(([source, group]) => `
            <button type="button" onclick="document.getElementById('skill-category-filter').value='${escapeHtml(source)}'; rdsFilterSkillCatalog(); document.getElementById('skill-results').scrollIntoView({behavior:'smooth', block:'start'});" class="text-left bg-surface border border-outline-variant rounded-DEFAULT p-3 hover:border-primary-container transition-colors">
              <div class="font-ribbon text-ribbon text-on-surface">${escapeHtml(source)}</div>
              <div class="font-table text-table text-on-surface-variant">${group.filter((skill) => skill.status === "ready").length} ready</div>
            </button>
          `).join("")}
        </div>
      </details>
    </div>
    <script>
      function rdsFilterSkillCatalog() {
        var q = (document.getElementById('skill-search')?.value || '').toLowerCase().trim();
        var status = document.getElementById('skill-status-filter')?.value || '';
        var category = document.getElementById('skill-category-filter')?.value || '';
        var stack = document.getElementById('skill-stack-filter')?.value || '';
        var sort = document.getElementById('skill-sort')?.value || 'status';
        var visible = 0;
        var cards = Array.prototype.slice.call(document.querySelectorAll('[data-skill-card]'));
        var statusRank = { ready: 0, curated: 1, planned: 2, roadmap: 2 };
        cards.sort(function(a, b) {
          if (sort === 'name') return (a.querySelector('h3')?.textContent || '').localeCompare(b.querySelector('h3')?.textContent || '');
          if (sort === 'category') {
            var byCategory = (a.getAttribute('data-category') || '').localeCompare(b.getAttribute('data-category') || '');
            if (byCategory) return byCategory;
          }
          var as = a.getAttribute('data-status') || '';
          var bs = b.getAttribute('data-status') || '';
          var rank = (statusRank[as] ?? 9) - (statusRank[bs] ?? 9);
          if (rank) return rank;
          return (a.querySelector('h3')?.textContent || '').localeCompare(b.querySelector('h3')?.textContent || '');
        });
        var grid = document.getElementById('skill-result-grid');
        if (grid) cards.forEach(function(card) { grid.appendChild(card); });
        cards.forEach(function(card) {
          var cardStatus = card.getAttribute('data-status') || '';
          var cardCategory = card.getAttribute('data-category') || '';
          var applies = (card.getAttribute('data-applies') || '').split(',');
          var search = card.getAttribute('data-search') || '';
          var effectiveStatus = cardStatus === 'planned' ? 'roadmap' : cardStatus;
          var ok = true;
          if (q && search.indexOf(q) === -1) ok = false;
          if (status && effectiveStatus !== status) ok = false;
          if (category && cardCategory !== category) ok = false;
          if (stack && applies.indexOf(stack) === -1 && applies.indexOf('universal') === -1) ok = false;
          card.classList.toggle('hidden', !ok);
          if (ok) visible += 1;
        });
        var count = document.getElementById('skill-filter-count');
        if (count) count.textContent = visible + ' skills shown';
      }
      function rdsResetSkillFilters() {
        ['skill-search', 'skill-status-filter', 'skill-category-filter', 'skill-stack-filter'].forEach(function(id) {
          var el = document.getElementById(id);
          if (el) el.value = '';
        });
        rdsFilterSkillCatalog();
      }
    </script>
  `, { nav: "settings", topbarTab: "overview" }));
});

app.get("/settings/components", (c) => {
  return c.html(layout("Components", `
    <div class="max-w-[1180px] mx-auto flex flex-col gap-component-gap">
      <div class="rds-page-header">
        <div>
          <div class="rds-page-eyebrow">Inventory</div>
          <h1 class="rds-page-title flex items-center gap-2">${icon("inventory_2", 24, "text-primary-container")}<span>Components</span></h1>
          <p class="rds-page-copy">Vendored components, source paths, and upgrade implications for RDS.</p>
        </div>
        <a class="rds-action-secondary" href="/settings">${icon("arrow_back", 14)}<span>Settings</span></a>
      </div>
      ${settingsTabNav("inventory")}
      <section class="bg-surface-container border border-outline-variant rounded-DEFAULT p-container-padding">
        <h2 class="font-h2 text-h2 text-on-surface mb-2">Components: what RDS is built from</h2>
        <div class="mt-gutter">${renderPipelineComponents()}</div>
      </section>
    </div>
    <script>${clientScript()}</script>
  `, { nav: "settings", topbarTab: "overview" }));
});

app.post("/settings", async (c) => {
  const denied = tokenGate(c);
  if (denied) {
    appendAudit({ route: "POST /settings", outcome: "denied", status: denied.status, ip: callerIp(c), ua: callerUa(c) });
    return denied;
  }
  const body = (await c.req.json().catch(() => ({}))) as Partial<Record<keyof RdsSettings, string>>;
  const inferenceProvider = body.inferenceProvider === "codex" ? "codex" : "claude";
  const theme = body.theme === "light" || body.theme === "system" ? body.theme : "dark";
  const claudeModel = (body.claudeModel || "claude-opus-4-6").trim() || "claude-opus-4-6";
  const codexModel = (body.codexModel || "").trim();
  if (!CLAUDE_MODELS.includes(claudeModel)) return c.json({ ok: false, error: "unsupported Claude model" }, 400);
  if (codexModel && !/^[a-zA-Z0-9._:-]{1,80}$/.test(codexModel)) return c.json({ ok: false, error: "invalid Codex model id" }, 400);
  const settings: RdsSettings = { inferenceProvider, claudeModel, codexModel, theme };
  writeSettings(settings);
  appendAudit({ route: "POST /settings", outcome: "ok", ip: callerIp(c), ua: callerUa(c), note: `provider=${inferenceProvider}` });
  return c.json({ ok: true, settings });
});

// ---------- audit log -------------------------------------------------------

app.get("/audit", (c) => {
  const format = c.req.query("format") || "";
  const wantsJson = format === "json" || (c.req.header("accept") || "").includes("application/json");
  const wantsCsv  = format === "csv";
  const limit = Math.min(Number(c.req.query("limit") || 1000), 10000);
  type Entry = { ts?: string; route?: string; build_id?: string; outcome?: string; status?: number; ip?: string; note?: string; raw?: string };
  const entriesRaw: Entry[] = existsSync(AUDIT_LOG)
    ? readFileSync(AUDIT_LOG, "utf8")
        .split("\n").filter(Boolean).slice(-limit)
        .map((l) => { try { return JSON.parse(l) as Entry; } catch { return { raw: l }; } })
    : [];
  const sort = c.req.query("sort") || "when";
  const dir = sortDir(c.req.query("dir"), "desc");
  const entries = entriesRaw.slice().sort((a, b) => {
    const direction = dir === "asc" ? 1 : -1;
    const cmp =
      sort === "when"    ? compareNumber(a.ts ? Date.parse(a.ts) : null, b.ts ? Date.parse(b.ts) : null) :
      sort === "route"   ? compareText(a.route, b.route) :
      sort === "build"   ? compareText(a.build_id, b.build_id) :
      sort === "outcome" ? compareText(a.outcome, b.outcome) :
      sort === "ip"      ? compareText(a.ip, b.ip) :
      sort === "note"    ? compareText(a.note, b.note) :
                            compareNumber(a.ts ? Date.parse(a.ts) : null, b.ts ? Date.parse(b.ts) : null);
    return cmp * direction;
  });

  if (wantsCsv) {
    const fname = `rds-audit-${new Date().toISOString().slice(0, 10)}.csv`;
    const esc = (v: unknown) => {
      const s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = "ts,route,build_id,outcome,status,ip,note\n";
    const rows = entries.map((e) =>
      [e.ts, e.route, e.build_id, e.outcome, e.status, e.ip, e.note].map(esc).join(",")
    ).join("\n") + "\n";
    c.header("Content-Type", "text/csv; charset=utf-8");
    c.header("Content-Disposition", `attachment; filename="${fname}"`);
    return c.body(header + rows);
  }
  if (wantsJson) {
    const fname = `rds-audit-${new Date().toISOString().slice(0, 10)}.json`;
    if (format === "json") c.header("Content-Disposition", `attachment; filename="${fname}"`);
    return c.json({ entries, total: entries.length });
  }

  // Humanized action names for common write routes; the raw route stays in a tooltip.
  const auditAction = (route?: string | null): string => {
    const r = String(route || "");
    const map: Array<[RegExp, string]> = [
      [/^POST \/new\/analyze/, "Analyzed a PRD"],
      [/^POST \/new/, "Started a build"],
      [/^POST \/b\/:id\/cmd/, "Build command"],
      [/^POST \/b\/:id\/fix/, "Spawned fixer"],
      [/^POST \/b\/:id\/iterate/, "Ran iteration"],
      [/^POST \/b\/:id\/goal/, "Ran goal loop"],
      [/^POST \/b\/:id\/approve/, "Approved build"],
      [/^POST \/b\/:id\/reject/, "Rejected build"],
      [/^POST \/b\/:id\/deploy/, "Deployed preview"],
      [/^POST \/b\/:id\/playwright\/run/, "Ran QA crawl"],
      [/^POST \/b\/:id\/refresh-cost/, "Refreshed cost"],
      [/^POST \/b\/:id\/upload-prd/, "Uploaded PRD"],
      [/^POST \/b\/:id\/service\/deregister/, "Deleted Zo service"],
      [/^POST \/builds\/refresh/, "Refreshed build index"],
      [/^POST \/watchdog/, "Toggled watchdog"],
      [/^POST \/settings/, "Saved settings"],
      [/^POST \/chat\/sessions\/:id\/messages/, "Sent chat message"],
      [/^POST \/chat\/sessions\/:id\/actions/, "Ran chat action"],
      [/^POST \/chat\/sessions\/by-build/, "Opened build chat"],
      [/^POST \/chat\/sessions/, "Created chat thread"],
      [/^DELETE \/chat\/sessions/, "Deleted chat thread"],
      [/^POST \/agent-sessions\/:sid\/action/, "Agent session action"],
      [/^POST .*agent-sessions/, "Started agent session"],
      [/^POST \/alerts\/dismiss/, "Dismissed alert"],
      [/^POST \/reviews\/dismiss/, "Dismissed review"],
    ];
    for (const [re, label] of map) if (re.test(r)) return label;
    return r || "-";
  };
  const rows = entries.map((e) => {
    const ts = e.ts ? new Date(e.ts).toLocaleString() : "-";
    const outcome = e.outcome === "denied"
      ? `<span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium bg-error/10 text-error border border-error/30">denied</span>`
      : e.outcome === "ok"
        ? `<span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium bg-primary-container/10 text-primary-container border border-primary-container/30">ok</span>`
        : `<span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium bg-surface-container text-on-surface-variant border border-outline-variant">${escapeHtml(String(e.outcome ?? "-"))}</span>`;
    const status = e.status ? ` <span class="font-code text-[11px] text-outline">${escapeHtml(String(e.status))}</span>` : "";
    return `<tr class="border-b border-outline-variant/40 hover:bg-surface-container-high/50 transition-colors">
      <td class="px-3 py-2 font-code text-[11px] text-on-surface-variant whitespace-nowrap">${escapeHtml(ts)}</td>
      <td class="px-3 py-2"><span class="font-body text-[13px] text-on-surface" title="${escapeHtml(String(e.route ?? "-"))}">${escapeHtml(auditAction(e.route))}</span></td>
      <td class="px-3 py-2">${e.build_id ? `<a href="/b/${escapeHtml(e.build_id)}" class="text-primary-container hover:underline font-code text-[12px]">${escapeHtml(e.build_id)}</a>` : `<span class="text-outline">-</span>`}</td>
      <td class="px-3 py-2">${outcome}${status}</td>
      <td class="px-3 py-2 font-code text-[11px] text-on-surface-variant">${escapeHtml(String(e.ip ?? "-"))}</td>
      <td class="px-3 py-2 font-code text-[11px] text-on-surface-variant truncate max-w-md">${escapeHtml(String(e.note ?? ""))}</td>
    </tr>`;
  }).join("");

  const mobileRows = entries.map((e) => {
    const ts = e.ts ? new Date(e.ts).toLocaleString() : "-";
    const outcome = e.outcome === "denied"
      ? `<span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium bg-error/10 text-error border border-error/30">denied</span>`
      : e.outcome === "ok"
        ? `<span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium bg-primary-container/10 text-primary-container border border-primary-container/30">ok</span>`
        : `<span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium bg-surface-container text-on-surface-variant border border-outline-variant">${escapeHtml(String(e.outcome ?? "-"))}</span>`;
    return `<article class="bg-surface border border-outline-variant rounded-DEFAULT p-3 font-table text-table">
      <div class="flex items-start justify-between gap-3">
        <div class="font-code text-[11px] text-on-surface-variant">${escapeHtml(ts)}</div>
        <div class="shrink-0">${outcome}${e.status ? ` <span class="font-code text-[11px] text-outline">${escapeHtml(String(e.status))}</span>` : ""}</div>
      </div>
      <div class="mt-2 font-body text-[13px] text-on-surface" title="${escapeHtml(String(e.route ?? "-"))}">${escapeHtml(auditAction(e.route))}</div>
      <div class="mt-2 grid grid-cols-2 gap-2">
        <div><div class="text-outline uppercase text-[10px]">Build</div><div>${e.build_id ? `<a href="/b/${escapeHtml(e.build_id)}" class="text-primary-container hover:underline font-code text-[11px] break-all">${escapeHtml(e.build_id)}</a>` : `<span class="text-outline">-</span>`}</div></div>
        <div><div class="text-outline uppercase text-[10px]">IP</div><div class="font-code text-[11px] text-on-surface-variant break-all">${escapeHtml(String(e.ip ?? "-"))}</div></div>
      </div>
      ${e.note ? `<div class="mt-2 font-code text-[11px] text-on-surface-variant break-words">${escapeHtml(String(e.note))}</div>` : ""}
    </article>`;
  }).join("");

  return c.html(layout("Audit log", `
    <div class="flex flex-col gap-component-gap">
      <div class="bg-surface-container border border-outline-variant rounded-DEFAULT px-container-padding py-gutter flex items-center justify-between gap-3 flex-wrap">
        <div class="flex items-center gap-3 flex-wrap">
          <h1 class="font-h1 text-h1 text-on-surface flex items-center gap-2">${icon("analytics", 20, "text-primary-container")}<span>Audit log</span></h1>
        </div>
        <div class="flex items-center gap-3 font-ribbon text-ribbon flex-wrap">
          <span class="inline-flex items-center gap-1 px-2 py-1 rounded-DEFAULT bg-surface-container-high border border-outline-variant text-on-surface"><b>${entries.length}</b><span class="text-on-surface-variant">entries</span></span>
          <a class="inline-flex items-center gap-1 px-2 py-1 rounded-DEFAULT bg-surface-container-high border border-outline-variant text-on-surface hover:bg-surface-bright transition-colors" href="/audit?format=csv" download>${icon("download", 14)}<span>Export CSV</span></a>
          <a class="inline-flex items-center gap-1 px-2 py-1 rounded-DEFAULT bg-surface-container-high border border-outline-variant text-on-surface hover:bg-surface-bright transition-colors" href="/audit?format=json" download>${icon("data_object", 14)}<span>Export JSON</span></a>
          <a class="text-outline hover:text-on-surface flex items-center gap-1" href="/">${icon("arrow_back", 14)}<span>Hub</span></a>
        </div>
      </div>
      <p class="text-on-surface-variant font-body text-body">Append-only log of all write actions (build start/stop, deploy, approve/reject, watchdog toggle, PRD upload). Source: <code class="font-code text-code" title="${escapeHtml(AUDIT_LOG)}">${escapeHtml(basename(AUDIT_LOG))}</code> <span class="text-outline">in the dashboard state dir</span></p>
      <div class="md:hidden space-y-3">
        ${mobileRows || `<div class="px-3 py-6 text-center text-on-surface-variant italic">No audit entries yet.</div>`}
      </div>
      <div class="hidden md:block bg-surface border border-outline-variant rounded-DEFAULT overflow-hidden">
        <div class="rds-scroll-table overflow-x-auto">
        <table class="rds-desktop-table w-full font-table text-table">
          <thead class="bg-surface-container-high border-b border-outline-variant">
            <tr class="text-on-surface-variant font-ribbon text-ribbon uppercase tracking-wider">
              <th class="px-3 py-2 text-left">${sortableHeader(c.req.url, "when", "when", sort, dir)}</th>
              <th class="px-3 py-2 text-left">${sortableHeader(c.req.url, "route", "action", sort, dir)}</th>
              <th class="px-3 py-2 text-left">${sortableHeader(c.req.url, "build", "build", sort, dir)}</th>
              <th class="px-3 py-2 text-left">${sortableHeader(c.req.url, "outcome", "outcome", sort, dir)}</th>
              <th class="px-3 py-2 text-left">${sortableHeader(c.req.url, "ip", "ip", sort, dir)}</th>
              <th class="px-3 py-2 text-left">${sortableHeader(c.req.url, "note", "note", sort, dir)}</th>
            </tr>
          </thead>
          <tbody>${rows || `<tr><td colspan="6" class="px-3 py-6 text-center text-on-surface-variant italic">No audit entries yet.</td></tr>`}</tbody>
        </table>
        </div>
      </div>
    </div>
  `, { nav: "activity", topbarTab: "overview" }));
});

// ---------- files + diff (read-only views into app_dest) -------------------

// Resolves the build's app_dest *and* asserts it's a real directory.
// Returns null if we should respond 404 (no app_dest known) or 410 (gone).
function appDestForBuild(id: string): { path: string; gone?: boolean } | null {
  const dir = existingBuildDirForId(id);
  if (!dir) return null;
  const state = safeReadJson<StateJson>(join(dir, "state.json")) || {};
  const path = state.app_dest || resolveAppDest(dir);
  if (!path) {
    const snapshot = join(dir, "deploy-snapshot");
    return existsSync(snapshot) ? { path: snapshot } : null;
  }
  if (!existsSync(path)) {
    const snapshot = join(dir, "deploy-snapshot");
    if (existsSync(snapshot)) return { path: snapshot };
    return { path, gone: true };
  }
  try {
    return { path: realpathSync(path) };
  } catch {
    return { path };
  }
}

// Lists files under app_dest with size + mtime. Skips node_modules, .git,
// tmp/, log/, and anything starting with a dot at the top level. Caps at
// 500 entries so massive Rails apps don't blow up the response.
app.get("/b/:id/files", async (c) => {
  const id = c.req.param("id");
  const found = appDestForBuild(id);
  if (!found) return c.json({ ok: false, error: "no app_dest known", entries: [] });
  if (found.gone) return c.json({ ok: false, error: "app_dest gone", path: found.path, entries: [] });

  const child = spawn("bash", [
    "-lc",
    [
      `cd ${JSON.stringify(found.path)} &&`,
      `find . -maxdepth 4 \\( -path '*/node_modules' -o -path '*/.git' -o -path '*/tmp' -o -path '*/log' -o -path '*/.bundle' -o -path '*/.next' \\) -prune -o -type f -print0`,
      `| head -z -n 500`,
      `| xargs -0 stat -c '%Y %s %n' 2>/dev/null`,
      `| sort -nr`,
    ].join(" "),
  ], { cwd: found.path, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (d) => (stdout += d.toString()));
  child.stderr.on("data", (d) => (stderr += d.toString()));
  const exitCode = await new Promise<number>((r) => child.on("close", (code) => r(code ?? 1)));

  const entries = stdout.split("\n").filter(Boolean).map((l) => {
    const m = l.match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!m) return null;
    return { mtime: Number(m[1]) * 1000, size: Number(m[2]), path: m[3] };
  }).filter(Boolean);

  return c.json({ ok: exitCode === 0, root: found.path, entries, stderr: stderr.trim() || undefined });
});

// Returns a single file's text content from app_dest, capped at 256 KiB.
app.get("/b/:id/files/raw", (c) => {
  const id = c.req.param("id");
  const rel = c.req.query("path") || "";
  if (!rel || rel.includes("\0") || rel.startsWith("/")) return c.text("invalid path", 400);
  const found = appDestForBuild(id);
  if (!found) return c.text("no app_dest", 404);
  if (found.gone) return c.text("app_dest gone", 410);
  const path = join(found.path, rel);
  if (!existsSync(path)) return c.text("not found", 404);
  if (!isContainedExistingPath(found.path, path)) return c.text("outside app_dest", 400);
  c.header("Content-Type", "text/plain; charset=utf-8");
  return c.body(tailFile(path, 256 * 1024));
});

// `git diff` over app_dest. mode=staged|working|all (default working).
app.get("/b/:id/diff", async (c) => {
  const id = c.req.param("id");
  const found = appDestForBuild(id);
  if (!found) {
    c.header("Content-Type", "text/plain; charset=utf-8");
    return c.text("(no app_dest yet — diff will appear once the build produces one)");
  }
  if (found.gone) {
    c.header("Content-Type", "text/plain; charset=utf-8");
    return c.text(`(app_dest gone: ${found.path})`);
  }

  const mode = (c.req.query("mode") || "working").toLowerCase();
  const args =
    mode === "summary" ? ["-c", "color.status=false", "status", "--short"] :
    mode === "staged" ? ["diff", "--staged", "--stat", "-p"] :
    mode === "all"    ? ["diff", "HEAD", "--stat", "-p"] :
                        ["diff", "--stat", "-p"];

  const child = spawn("git", args, { cwd: found.path, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (d) => (stdout += d.toString()));
  child.stderr.on("data", (d) => (stderr += d.toString()));
  const exitCode = await new Promise<number>((r) => child.on("close", (code) => r(code ?? 1)));

  c.header("Content-Type", "text/plain; charset=utf-8");
  if (!stdout && stderr) return c.text(stderr || `git diff exit ${exitCode}`);
  if (mode === "summary") {
    const statChild = spawnSync("git", ["diff", "--stat"], { cwd: found.path, encoding: "utf8" });
    const stagedChild = spawnSync("git", ["diff", "--staged", "--stat"], { cwd: found.path, encoding: "utf8" });
    const parts = [
      `# Diff summary for ${found.path}`,
      "",
      "## Changed files",
      stdout.trim() || "(clean working tree)",
      "",
      "## Working tree stat",
      (statChild.stdout || "").trim() || "(no unstaged patch)",
      "",
      "## Staged stat",
      (stagedChild.stdout || "").trim() || "(no staged patch)",
      "",
      "Use the dropdown for raw patch output only when you need exact line changes."
    ];
    return c.text(parts.join("\n"));
  }
  if (!stdout) return c.text(`(no ${mode} patch)`);
  return c.body(stdout.length > 256 * 1024 ? stdout.slice(0, 256 * 1024) + "\n…[truncated]" : stdout);
});

// ---------- watchdog control ------------------------------------------------

const WATCHDOG_PIDFILE = "/dev/shm/rds-watchdog.pid";

function watchdogStatus(): { running: boolean; pid?: number } {
  if (!existsSync(WATCHDOG_PIDFILE)) return { running: false };
  const pid = Number((readFileSync(WATCHDOG_PIDFILE, "utf8").trim() || "0"));
  if (!pid || !pidIsAlive(pid)) return { running: false };
  return { running: true, pid };
}

app.get("/watchdog", (c) => c.json(watchdogStatus()));

app.post("/watchdog", async (c) => {
  const denied = tokenGate(c);
  if (denied) {
    appendAudit({ route: "POST /watchdog", outcome: "denied", status: denied.status, ip: callerIp(c), ua: callerUa(c) });
    return denied;
  }
  const body = (await c.req.json().catch(() => ({}))) as { action?: string };
  appendAudit({ route: "POST /watchdog", outcome: "ok", ip: callerIp(c), ua: callerUa(c), note: `action=${body.action || "start"}` });
  const action = body.action === "stop" ? "stop" : "start";
  const cmd = join(RDS_ROOT, "bin", "rds-watchdog");
  if (!existsSync(cmd)) return c.text("bin/rds-watchdog missing", 500);
  const args = action === "stop" ? ["--stop"] : ["--detach"];
  const child = spawn(cmd, args, { cwd: RDS_ROOT, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (d) => (stdout += d.toString()));
  child.stderr.on("data", (d) => (stderr += d.toString()));
  const exitCode = await new Promise<number>((resolve) => child.on("close", (c) => resolve(c ?? 1)));
  return c.json({ ok: exitCode === 0, action, exitCode, stdout, stderr, ...watchdogStatus() });
});

// ---------- chrome (v2 — Operator Console) ----------------------------------

type NavKey = "hub" | "builds" | "new" | "chat" | "agents" | "activity" | "settings" | "audit" | "docs";

function statusKind(b: BuildRow): "running" | "stuck" | "failed" | "paused" | "done" | "other" {
  if (b.paused || b.status === "paused") return "paused";
  if (b.stuck || b.runnerMissing || b.status === "stalled") return "stuck";
  if (b.running) return "running";
  if (b.status === "failed") return "failed";
  if (b.status === "complete" || b.status === "done") return "done";
  return "other";
}

function statusDot(b: BuildRow): string {
  const k = statusKind(b);
  const cls =
    b.serviceStatus === "deregistered" ? "bg-error shadow-[0_0_8px_rgba(255,180,171,0.35)]" :
    k === "running" ? "bg-primary-container shadow-[0_0_8px_rgba(106,215,163,0.4)]" :
    k === "stuck"   ? "bg-tertiary-container shadow-[0_0_8px_rgba(255,177,136,0.4)]" :
    k === "paused"  ? "bg-tertiary-container/80" :
    k === "failed"  ? "bg-error shadow-[0_0_8px_rgba(255,180,171,0.4)]" :
    k === "done"    ? "bg-primary-container/60" :
                      "bg-outline-variant";
  return `<span class="inline-block w-2 h-2 rounded-full ${cls}"></span>`;
}

// Raw pipeline statuses are snake_case tokens (e.g. "pending_review");
// operator-facing chips always show the humanized form.
function humanStatus(status?: string | null): string {
  if (!status) return "—";
  const label = status.replace(/[_-]+/g, " ").trim();
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function statusBadge(b: BuildRow): string {
  const k = statusKind(b);
  const map: Record<string, { label: string; cls: string }> = {
    running: { label: b.pid ? `Running · pid ${b.pid}` : "Running", cls: "bg-primary-container/10 text-primary-container border border-primary-container/30" },
    stuck:   { label: b.pid ? `Stuck · pid ${b.pid}` : b.runnerMissing || b.status === "stalled" ? "Runner stopped" : "Stuck", cls: "bg-tertiary-container/10 text-tertiary-container border border-tertiary-container/30" },
    failed:  { label: "Failed", cls: "bg-error/10 text-error border border-error/30" },
    paused:  { label: "Paused", cls: "bg-tertiary-container/10 text-tertiary-container border border-tertiary-container/30" },
    done:    { label: "Done",   cls: "bg-surface-container text-on-surface-variant border border-outline-variant" },
    other:   { label: humanStatus(b.status), cls: "bg-surface-container text-on-surface-variant border border-outline-variant" },
  };
  const entry = map[k];
  return `<span class="rds-status-badge inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium ${entry.cls}">${escapeHtml(entry.label)}</span>`;
}

function reviewBadge(b: BuildRow): string {
  switch (b.reviewStatus) {
    case "pending":
      return `<span class="rds-review-badge inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium bg-secondary-container/40 text-secondary border border-secondary/30">Pending review</span>`;
    case "approved":
      return `<span class="rds-review-badge inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium bg-primary-container/10 text-primary-container border border-primary-container/30">Approved</span>`;
    case "rejected":
      return `<span class="rds-review-badge inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium bg-error/10 text-error border border-error/30">Rejected</span>`;
    default:
      return "";
  }
}

function tagPill(text: string, variant: "default" | "live" | "offline" = "default"): string {
  const cls = variant === "live"
    ? "bg-primary-container/10 text-primary-container border-primary-container/30"
    : variant === "offline"
      ? "bg-error/10 text-error border-error/30"
      : "bg-surface-container text-on-surface-variant border-outline-variant";
  return `<span class="inline-block px-1.5 py-0.5 rounded text-[10px] border ${cls}">${escapeHtml(text)}</span>`;
}

function hostingPill(b: BuildRow): string {
  if (b.liveOnZo) return tagPill("Zo live", "live");
  if (b.hasZoService) return tagPill("Zo check");
  if (b.serviceStatus === "deregistered") return tagPill("Zo offline", "offline");
  if (b.localPreviewRunning) return tagPill("local running");
  return tagPill("not hosted");
}

function hostingLabel(b: BuildRow): string {
  if (b.liveOnZo) return "Live on Zo";
  if (b.hasZoService) return "Zo service recorded; verify status";
  if (b.serviceStatus === "deregistered") return "Zo service deleted";
  if (b.localPreviewRunning) return "Local preview running only";
  return "Not hosted";
}

function activeZoServiceCountSync(): number {
  if (!existsSync(BUILDS_DIR)) return 0;
  let count = 0;
  for (const entry of readdirSync(BUILDS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith("_") || entry.name.startsWith("rds-smoke-")) continue;
    const info = readServiceInfo(entry.name);
    if (info?.service_id && info.status !== "deregistered") count += 1;
  }
  return count;
}

function icon(name: string, size = 16, extra = ""): string {
  return `<span class="material-symbols-outlined ${extra}" data-icon="${escapeHtml(name)}" aria-hidden="true" style="font-size:${size}px"></span>`;
}

// Real-time canvas globe for the sidebar: rotating dot-cloud continents on a
// tilted 3D graticule. Deterministic (seeded PRNG), renders at ~30fps, honors
// prefers-reduced-motion (single static frame) and pauses in hidden tabs.
// This is the app's one ambient animation (docs/DESIGN.md).
function globeScript(): string {
  return `(function () {
    var canvas = document.getElementById('rds-globe-canvas');
    if (!canvas || !canvas.getContext) return;
    var ctx = canvas.getContext('2d');
    var DPR = Math.min(2, window.devicePixelRatio || 1);
    var TILT = 23.4 * Math.PI / 180;
    var cosT = Math.cos(TILT), sinT = Math.sin(TILT);

    // Seeded PRNG so the planet is identical on every load.
    var seed = 1337;
    function rand() { seed |= 0; seed = seed + 0x6D2B79F5 | 0; var t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }
    function gauss() { var u = 0, v = 0; while (!u) u = rand(); while (!v) v = rand(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

    // Continent dot clusters: [latDeg, lonDeg, spreadDeg, weight]
    var CL = [
      [55, -105, 11, 10], [40, -98, 9, 8], [63, -95, 10, 6], [20, -102, 5, 3],
      [72, -40, 5, 2],
      [-8, -58, 9, 7], [-28, -63, 6, 3], [3, -74, 4, 2],
      [50, 12, 7, 6], [60, 28, 6, 3],
      [12, 8, 8, 5], [25, 18, 8, 4], [-8, 22, 8, 5], [-24, 26, 6, 3],
      [26, 45, 6, 3], [38, 68, 8, 4],
      [58, 95, 13, 9], [34, 105, 8, 7], [22, 79, 6, 5], [48, 128, 6, 3],
      [36, 138, 3, 2], [12, 102, 4, 2], [-3, 117, 6, 3],
      [-25, 135, 7, 4], [-40, 175, 3, 1]
    ];
    var totalW = 0, cum = [];
    for (var i = 0; i < CL.length; i++) { totalW += CL[i][3]; cum.push(totalW); }
    var DOTS = [];
    for (var d = 0; d < 1500; d++) {
      var pick = rand() * totalW, ci = 0;
      while (cum[ci] < pick) ci++;
      var c = CL[ci];
      var lat = c[0] + gauss() * c[2];
      var lon = c[1] + gauss() * c[2] / Math.max(0.35, Math.cos(lat * Math.PI / 180));
      if (lat > 84 || lat < -80) continue;
      var phi = lat * Math.PI / 180, lam = lon * Math.PI / 180;
      DOTS.push([Math.cos(phi) * Math.sin(lam), Math.sin(phi), Math.cos(phi) * Math.cos(lam), 0.6 + rand() * 0.4]);
    }

    // Graticule polylines (unit sphere): latitude rings + meridians.
    var LINES = [];
    var latDeg, lonDeg, a, pts;
    for (latDeg = -60; latDeg <= 60; latDeg += 30) {
      pts = [];
      for (a = 0; a <= 96; a++) { var la = latDeg * Math.PI / 180, lo = a / 96 * 2 * Math.PI; pts.push([Math.cos(la) * Math.sin(lo), Math.sin(la), Math.cos(la) * Math.cos(lo)]); }
      LINES.push({ pts: pts, eq: latDeg === 0 });
    }
    for (lonDeg = 0; lonDeg < 180; lonDeg += 30) {
      pts = [];
      for (a = 0; a <= 96; a++) { var lp = (a / 96 * 2 - 1) * Math.PI / 2 * 1.999, ll = lonDeg * Math.PI / 180; pts.push([Math.cos(lp) * Math.sin(ll), Math.sin(lp), Math.cos(lp) * Math.cos(ll)]); }
      LINES.push({ pts: pts, eq: false });
    }

    var W = 0, H = 0, R = 0, CX = 0, CY = 0;
    function resize() {
      var box = canvas.parentElement.getBoundingClientRect();
      var size = Math.max(96, Math.min(box.width, box.height || box.width));
      W = Math.round(size * DPR); H = W;
      canvas.width = W; canvas.height = H;
      canvas.style.width = size + 'px'; canvas.style.height = size + 'px';
      CX = W / 2; CY = H / 2; R = W / 2 - 3 * DPR;
    }

    function rot(p, cosA, sinA) {
      var x = p[0] * cosA + p[2] * sinA;
      var z = -p[0] * sinA + p[2] * cosA;
      var y = p[1] * cosT - z * sinT;
      var zz = p[1] * sinT + z * cosT;
      return [x, y, zz];
    }

    function render(theta) {
      var cosA = Math.cos(theta), sinA = Math.sin(theta);
      ctx.clearRect(0, 0, W, H);

      // Sphere body: dark green-graphite with a top-left key light.
      var body = ctx.createRadialGradient(CX - R * 0.42, CY - R * 0.48, R * 0.1, CX, CY, R);
      body.addColorStop(0, 'rgba(30,48,39,0.95)');
      body.addColorStop(0.55, 'rgba(13,21,17,0.97)');
      body.addColorStop(1, 'rgba(4,8,6,1)');
      ctx.beginPath(); ctx.arc(CX, CY, R, 0, 2 * Math.PI);
      ctx.fillStyle = body; ctx.fill();

      ctx.save();
      ctx.beginPath(); ctx.arc(CX, CY, R, 0, 2 * Math.PI); ctx.clip();

      // Graticule: faint far side first, brighter near side.
      var pass, li, pi, p, q, vis;
      for (pass = 0; pass < 2; pass++) {
        ctx.lineWidth = (pass ? 0.8 : 0.6) * DPR;
        for (li = 0; li < LINES.length; li++) {
          var line = LINES[li];
          ctx.strokeStyle = pass
            ? (line.eq ? 'rgba(106,215,163,0.30)' : 'rgba(106,215,163,0.16)')
            : 'rgba(106,215,163,0.05)';
          ctx.beginPath(); vis = false;
          for (pi = 0; pi < line.pts.length; pi++) {
            p = rot(line.pts[pi], cosA, sinA);
            var front = pass ? p[2] > 0 : p[2] <= 0;
            if (front) {
              q = [CX + p[0] * R, CY - p[1] * R];
              if (vis) ctx.lineTo(q[0], q[1]); else ctx.moveTo(q[0], q[1]);
              vis = true;
            } else vis = false;
          }
          ctx.stroke();
        }
      }

      // Continent dots — city-light cloud. Far side barely visible haze.
      for (pi = 0; pi < DOTS.length; pi++) {
        p = rot(DOTS[pi], cosA, sinA);
        var sx = CX + p[0] * R, sy = CY - p[1] * R;
        if (p[2] > 0) {
          var depth = p[2];
          var alpha = (0.32 + 0.6 * depth) * DOTS[pi][3];
          var size = (0.42 + 0.62 * depth) * DPR;
          ctx.fillStyle = 'rgba(139,238,187,' + alpha.toFixed(3) + ')';
          ctx.beginPath(); ctx.arc(sx, sy, size, 0, 2 * Math.PI); ctx.fill();
        } else if (p[2] > -0.35) {
          ctx.fillStyle = 'rgba(106,215,163,0.05)';
          ctx.beginPath(); ctx.arc(sx, sy, 0.7 * DPR, 0, 2 * Math.PI); ctx.fill();
        }
      }

      // Terminator: night falls toward the lower-right.
      var night = ctx.createLinearGradient(CX - R, CY - R, CX + R, CY + R);
      night.addColorStop(0, 'rgba(0,0,0,0)');
      night.addColorStop(0.62, 'rgba(0,0,0,0)');
      night.addColorStop(1, 'rgba(2,5,4,0.55)');
      ctx.fillStyle = night; ctx.fillRect(0, 0, W, H);

      // Atmosphere: inner rim light.
      var atm = ctx.createRadialGradient(CX, CY, R * 0.86, CX, CY, R);
      atm.addColorStop(0, 'rgba(106,215,163,0)');
      atm.addColorStop(1, 'rgba(139,238,187,0.20)');
      ctx.fillStyle = atm; ctx.fillRect(0, 0, W, H);
      ctx.restore();

      // Crisp limb + specular arc top-left.
      ctx.beginPath(); ctx.arc(CX, CY, R, 0, 2 * Math.PI);
      ctx.strokeStyle = 'rgba(106,215,163,0.42)'; ctx.lineWidth = 1 * DPR; ctx.stroke();
      ctx.beginPath(); ctx.arc(CX, CY, R - 1.2 * DPR, Math.PI * 1.08, Math.PI * 1.62);
      ctx.strokeStyle = 'rgba(185,255,224,0.30)'; ctx.lineWidth = 1.6 * DPR; ctx.lineCap = 'round'; ctx.stroke();
    }

    var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)');
    // Start facing the Europe/Africa/Asia hemisphere — the densest view.
    var theta = -0.35, speed = 0.000048, targetSpeed = speed, lastT = 0, raf = 0;
    function frame(t) {
      raf = requestAnimationFrame(frame);
      if (t - lastT < 33) return; // ~30fps is plenty for ambient motion
      var dt = lastT ? Math.min(100, t - lastT) : 16;
      lastT = t;
      speed += (targetSpeed - speed) * 0.05;
      theta += speed * dt;
      render(theta);
    }
    function start() {
      cancelAnimationFrame(raf);
      resize();
      if (reduced && reduced.matches) { render(theta); return; }
      lastT = 0;
      raf = requestAnimationFrame(frame);
    }
    var link = canvas.closest('.rds-wire-globe-link') || canvas;
    link.addEventListener('mouseenter', function () { targetSpeed = 0.00016; });
    link.addEventListener('mouseleave', function () { targetSpeed = 0.000048; });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) cancelAnimationFrame(raf); else start();
    });
    if (reduced && reduced.addEventListener) reduced.addEventListener('change', start);
    if (window.ResizeObserver) new ResizeObserver(function () { start(); }).observe(canvas.parentElement);
    start();
  })();`;
}

function sidenav(active: NavKey): string {
  const hostedCount = activeZoServiceCountSync();
  const items: { key: NavKey; href: string; label: string; icon: string }[] = [
    { key: "hub",      href: "/",         label: "Hub",       icon: "grid_view" },
    { key: "builds",   href: "/builds",   label: "Builds",    icon: "layers" },
    { key: "chat",     href: "/chat",     label: "Chat",      icon: "chat" },
    { key: "agents",   href: "/agents",   label: "Agents",    icon: "smart_toy" },
    { key: "activity", href: "/audit",    label: "Activity",  icon: "analytics" },
    { key: "settings", href: "/settings", label: "Settings",  icon: "settings" },
    { key: "docs",     href: "/docs",     label: "Documentation", icon: "menu_book" },
  ];
  const renderItem = (it: { key: NavKey; href: string; label: string; icon: string }) => {
    const isActive = it.key === active;
    const cls = isActive
      ? "rds-nav-item-active border border-[#6ad7a3]/30 bg-[#1b211e] text-[#6ad7a3]"
      : "border border-transparent text-[#8b968f] hover:bg-[#1b211e] hover:text-[#e9eeea] hover:border-[#242b28]";
    const badge = it.key === "chat"
      ? `<span id="rds-chat-nav-badge" class="hidden ml-auto inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1.5 rounded-full bg-error text-on-error font-ribbon text-[10px] font-bold"></span>`
      : it.key === "builds" && hostedCount > 0
        ? `<span class="ml-auto inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1.5 rounded-full bg-primary-container/15 text-primary-container border border-primary-container/30 font-ribbon text-[10px] font-bold" title="${hostedCount} recorded Zo service${hostedCount === 1 ? "" : "s"}">${hostedCount}</span>`
      : "";
    return `<a href="${it.href}" class="rds-nav-item ${cls} px-3 py-2 flex items-center gap-3 font-ribbon text-ribbon transition-colors">
      ${icon(it.icon, 18)}<span>${it.label}</span>${badge}
    </a>`;
  };
  return `
    <nav id="rds-sidenav" class="rds-sidenav fixed md:static inset-y-0 left-0 h-[100dvh] w-[220px] border-r border-[#242b28] flex flex-col py-4 shrink-0 z-40 md:z-20 -translate-x-full md:translate-x-0 transition-transform duration-150 ease-out">
      <div class="rds-wire-globe-wrap px-4 mb-4">
        <a href="/" class="rds-wire-globe-link" aria-label="Operator Console">
        <div class="rds-wire-globe" aria-hidden="true">
          <canvas id="rds-globe-canvas" class="rds-globe-canvas"></canvas>
        </div>
        </a>
      </div>
      <script>${globeScript()}</script>
      <div class="px-4 mb-4">
        <a href="/new" class="rds-action-primary w-full">
          ${icon("add", 16)}<span>New Build</span>
        </a>
      </div>
      <div class="flex-1 space-y-1">
        ${items.map(renderItem).join("")}
      </div>
      <div class="space-y-1 pt-2 border-t border-[#242b28]">
        <a class="rds-nav-item border border-transparent text-[#8b968f] hover:bg-[#1b211e] hover:text-[#e9eeea] hover:border-[#242b28] px-3 py-2 flex items-center gap-3 font-ribbon text-ribbon transition-colors" href="https://github.com/chrissotraidis/RDS" target="_blank" rel="noopener noreferrer">
          ${icon("open_in_new", 16)}<span>GitHub</span>${icon("open_in_new", 12, "ml-auto opacity-50")}
        </a>
      </div>
    </nav>
  `;
}

function topbar(_opts: { activeTab?: "builds" | "overview" } = {}): string {
  return `
    <header class="h-12 bg-[#070908]/95 backdrop-blur border-b border-[#242b28] flex justify-between items-center px-4 w-full shrink-0 z-10">
      <div class="flex items-center gap-3">
        <button type="button" class="md:hidden text-[#8b968f] hover:text-[#e9eeea] transition-colors -ml-1" onclick="rdsToggleNav(true)" aria-label="Open navigation">${icon("menu", 20)}</button>
        <a href="/" class="font-h1 text-[18px] leading-6 font-black tracking-tight text-[#6ad7a3]">RDS</a>
        <a href="/" class="hidden sm:inline text-on-surface-variant hover:text-on-surface font-ribbon text-ribbon transition-colors">Remote Deployment System</a>
      </div>
      <div class="flex items-center gap-3">
        <div class="relative hidden md:block">
          ${icon("search", 16, "absolute left-2 top-1/2 -translate-y-1/2 text-[#8b968f]")}
          <input id="rds-search" class="bg-[#101412] border border-[#242b28] rounded h-8 pl-8 pr-3 text-[12.5px] font-mono text-[#e9eeea] focus:border-[#6ad7a3] focus:ring-0 focus:outline-none placeholder-[#8b968f] w-56 transition-colors" placeholder="Search builds…" type="text" oninput="rdsSearch(event)">
        </div>
        <a href="/settings" title="Settings" class="text-[#8b968f] hover:text-[#e9eeea] transition-colors">${icon("settings", 18)}</a>
      </div>
    </header>
  `;
}

function ribbonFooter(): string {
  const wd = watchdogStatus();
  const tokenOk = !!DASHBOARD_TOKEN;
  const dot = (color: string) => `<span class="w-1.5 h-1.5 rounded-full ${color}"></span>`;
  return `
    <footer class="rds-footer h-8 bg-[#070908] border-t border-[#242b28] flex items-center justify-between gap-3 px-3 shrink-0 z-30 overflow-hidden">
      <div class="hidden lg:block font-mono text-[10px] uppercase tracking-widest text-[#8b968f] truncate">RDS_ROOT · ${escapeHtml(RDS_ROOT)}</div>
      <div class="flex gap-4 font-mono text-[10px] uppercase tracking-widest overflow-x-auto custom-scrollbar whitespace-nowrap">
        <span class="flex items-center gap-1 text-[#8b968f]">${dot("bg-[#6ad7a3]")} build-engine: ok</span>
        <span class="flex items-center gap-1 ${wd.running ? "text-[#6ad7a3]" : "text-[#8b968f]"}">${dot(wd.running ? "bg-[#6ad7a3]" : "bg-[#39413c]")} watchdog: ${wd.running ? `on (pid ${wd.pid})` : "off"}</span>
        <span class="flex items-center gap-1 ${tokenOk ? "text-[#6ad7a3]" : "text-[#ffb4ab]"}">${dot(tokenOk ? "bg-[#6ad7a3]" : "bg-[#ffb4ab]")} token: ${tokenOk ? "configured" : "unset"}</span>
        <span class="text-[#8b968f]">v0.1.0</span>
      </div>
    </footer>
  `;
}

// Canonical pipeline order. Must match the stage names emitted by
// bin/rds-build (see events.jsonl `stage_started` payloads). The bar
// renders these segments even before any events arrive so the operator
// sees the full pipeline shape from the start.
const STAGE_ORDER: { id: string; label: string }[] = [
  { id: "intake",     label: "intake"     },
  { id: "spec",       label: "spec"       },
  { id: "taste",      label: "taste"      },
  { id: "skill-resolve", label: "skills"  },
  { id: "rails-init", label: "init"       },
  { id: "skill-install", label: "install" },
  { id: "scaffold",   label: "scaffold"   },
  { id: "local-run",  label: "local run"  },
  { id: "deploy",     label: "deploy"     },
  { id: "qa",         label: "QA"         },
  { id: "taste-review", label: "review"   },
];

const STAGE_ICONS: Record<string, string> = {
  intake: "input",
  spec: "description",
  taste: "auto_awesome",
  "skill-resolve": "extension",
  "rails-init": "build",
  scaffold: "construction",
  "skill-install": "library_add_check",
  "local-run": "play_circle",
  deploy: "rocket_launch",
  qa: "smart_toy",
  "taste-review": "rate_review",
};

function renderSkillResolutionInline(resolution: SkillResolution): string {
  const resolvedSlugs = new Set(resolution.resolved.map((s) => s.slug));
  const skippedSlugs = new Set(resolution.skipped.map((s) => s.slug));
  const droppedCount = resolution.requested.filter((slug) => !resolvedSlugs.has(slug) && !skippedSlugs.has(slug)).length;
  const requestedCount = resolution.requested.length;
  const resolvedCount = resolution.resolved.length;
  const skippedCount = resolution.skipped.length;
  if (!requestedCount && !resolvedCount && !skippedCount) return "";
  const totals = resolution.scorecard?.totals || {};
  const scTotalsBadge = (Object.keys(totals).length)
    ? `<span class="rounded border border-outline-variant px-1.5 py-0.5 text-on-surface-variant" title="skill scorecard: pass / partial / fail shape evidence">shape ${(totals.pass || 0)}p·${(totals.partial || 0)}~·${(totals.fail || 0)}f</span>`
    : "";
  return `
    <div class="mt-1 flex flex-wrap gap-1 font-code text-[10px]">
      <span class="rounded border border-primary-container/40 bg-primary-container/10 text-primary-container px-1.5 py-0.5">${resolvedCount}/${requestedCount || resolvedCount} resolved</span>
      <span class="rounded border border-primary-container/40 bg-primary-container/10 text-primary-container px-1.5 py-0.5">${resolution.installed.length} installed</span>
      ${resolution.promptMentions ? `<span class="rounded border border-primary-container/40 bg-primary-container/10 text-primary-container px-1.5 py-0.5">${resolution.promptMentions} prompts</span>` : ""}
      ${skippedCount ? `<span class="rounded border border-tertiary-container/40 bg-tertiary-container/10 text-tertiary-container px-1.5 py-0.5">${skippedCount} skipped</span>` : ""}
      ${droppedCount ? `<span class="rounded border border-error/40 bg-error/10 text-error px-1.5 py-0.5">${droppedCount} dropped</span>` : ""}
      ${scTotalsBadge}
    </div>`;
}

function renderSkillResolutionCard(resolution: SkillResolution): string {
  if (!resolution.requested.length && !resolution.resolved.length && !resolution.skipped.length) {
    return `<div class="bg-[#070908] border border-outline-variant rounded-DEFAULT p-3 font-table text-table text-on-surface-variant italic">No skill resolution manifest has been written yet.</div>`;
  }
  const resolvedSlugs = new Set(resolution.resolved.map((s) => s.slug));
  const skippedSlugs = new Set(resolution.skipped.map((s) => s.slug));
  // Requested-but-dropped: in `requested` but neither in `resolved` nor in
  // `skipped`. This is the crafty-publisher class bug — a stack primary that
  // silently fell off the floor without an explicit reason.
  const dropped = resolution.requested.filter((slug) => !resolvedSlugs.has(slug) && !skippedSlugs.has(slug));
  const scorecardBySlug = new Map<string, SkillScorecardEntry>();
  for (const entry of resolution.scorecard?.skills || []) scorecardBySlug.set(entry.slug, entry);
  const verdictBadge = (entry: SkillScorecardEntry | undefined): string => {
    if (!entry) return "";
    const v = entry.verdict;
    const cls =
      v === "pass" ? "border-primary-container/40 bg-primary-container/10 text-primary-container" :
      v === "partial" ? "border-tertiary-container/40 bg-tertiary-container/10 text-tertiary-container" :
      v === "fail" ? "border-error/40 bg-error/10 text-error" :
      v === "not-installable" ? "border-outline-variant text-on-surface-variant" :
      "border-outline-variant text-outline";
    const title = entry.note ? entry.note.slice(0, 200) : v;
    return `<span class="rounded border ${cls} px-1 text-[9px]" title="${escapeHtml(title)}">${escapeHtml(v)}</span>`;
  };
  const resolved = resolution.resolved.map((skill) => {
    const mode = skill.installMode;
    let modeBadge = "";
    if (mode === "imperative") {
      modeBadge = `<span class="rounded border border-primary-container/40 bg-primary-container/10 text-primary-container px-1 text-[9px]" title="${escapeHtml(skill.installCommand || "imperative install")}">installs</span>`;
    } else if (mode === "metadata") {
      modeBadge = `<span class="rounded border border-outline-variant text-on-surface-variant px-1 text-[9px]" title="metadata-only (prompt hint, no install step)">metadata</span>`;
    } else if (mode) {
      modeBadge = `<span class="rounded border border-outline-variant text-on-surface-variant px-1 text-[9px]">${escapeHtml(mode)}</span>`;
    }
    const scBadge = verdictBadge(scorecardBySlug.get(skill.slug));
    return `
    <li class="flex items-start gap-2">
      <span class="material-symbols-outlined text-[14px] text-primary-container mt-0.5">check_circle</span>
      <span class="min-w-0 flex-1">
        <span class="text-on-surface">${escapeHtml(skill.slug)}</span>
        ${skill.name ? `<span class="text-outline"> · ${escapeHtml(skill.name)}</span>` : ""}
      </span>
      ${modeBadge}
      ${scBadge}
    </li>`;
  }).join("");
  const skipped = resolution.skipped.map((skill) => `
    <li class="flex items-start gap-2">
      <span class="material-symbols-outlined text-[14px] text-tertiary-container mt-0.5">warning</span>
      <span class="min-w-0">
        <span class="text-tertiary-container">${escapeHtml(skill.slug)}</span>
        ${skill.reason ? `<span class="text-outline"> · ${escapeHtml(skill.reason)}</span>` : ""}
      </span>
    </li>`).join("");
  const droppedHtml = dropped.length
    ? `<div class="font-code text-[11px] leading-relaxed">
        <div class="font-ribbon text-ribbon text-error uppercase tracking-wide mb-1">Requested but dropped</div>
        <ul class="space-y-1">${dropped.map((slug) => `
          <li class="flex items-start gap-2">
            <span class="material-symbols-outlined text-[14px] text-error mt-0.5">error</span>
            <span class="text-error">${escapeHtml(slug)}</span>
            <span class="text-outline">· not in resolved or skipped (silently dropped)</span>
          </li>`).join("")}
        </ul>
      </div>`
    : "";
  return `
    <div class="bg-[#070908] border border-outline-variant rounded-DEFAULT p-3 flex flex-col gap-3">
      <div class="flex items-center justify-between gap-3 flex-wrap">
        <div class="min-w-0">
          <div class="font-code text-[11px] text-on-surface-variant">stack=<span class="text-on-surface">${escapeHtml(resolution.stack || "-")}</span></div>
          <div class="font-table text-table text-on-surface-variant mt-1">Resolved means selected by RDS. Installed means artifacts/guides were written. Prompted means task prompts exposed SKILLS.md. Shape scorecard is the evidence that a skill affected app output.</div>
        </div>
        <div class="flex gap-1 font-code text-[10px]">
          <span class="rounded border border-outline-variant px-1.5 py-0.5 text-on-surface-variant">requested ${resolution.requested.length}</span>
          <span class="rounded border border-primary-container/40 bg-primary-container/10 px-1.5 py-0.5 text-primary-container">resolved ${resolution.resolved.length}</span>
          <span class="rounded border border-primary-container/40 bg-primary-container/10 px-1.5 py-0.5 text-primary-container">installed ${resolution.installed.length}</span>
          ${resolution.promptMentions ? `<span class="rounded border border-primary-container/40 bg-primary-container/10 px-1.5 py-0.5 text-primary-container">prompted ${resolution.promptMentions}x</span>` : `<span class="rounded border border-error/40 bg-error/10 px-1.5 py-0.5 text-error">not prompted yet</span>`}
          ${resolution.skipped.length ? `<span class="rounded border border-tertiary-container/40 bg-tertiary-container/10 px-1.5 py-0.5 text-tertiary-container">skipped ${resolution.skipped.length}</span>` : ""}
          ${dropped.length ? `<span class="rounded border border-error/40 bg-error/10 px-1.5 py-0.5 text-error">dropped ${dropped.length}</span>` : ""}
          ${resolution.scorecard?.totals && Object.keys(resolution.scorecard.totals).length ? `<span class="rounded border border-outline-variant px-1.5 py-0.5 text-on-surface-variant" title="shape scorecard: pass / partial / fail / metadata-only">shape ${(resolution.scorecard.totals.pass || 0)}p · ${(resolution.scorecard.totals.partial || 0)}~ · ${(resolution.scorecard.totals.fail || 0)}f${resolution.scorecard.totals["not-installable"] ? ` · ${resolution.scorecard.totals["not-installable"]} meta` : ""}</span>` : `<span class="rounded border border-tertiary-container/40 bg-tertiary-container/10 px-1.5 py-0.5 text-tertiary-container">shape pending</span>`}
        </div>
      </div>
      <div class="grid md:grid-cols-2 gap-3">
        <div>
          <div class="font-ribbon text-ribbon text-on-surface-variant uppercase tracking-wide mb-1">Used by build</div>
          <ul class="font-code text-[11px] leading-relaxed space-y-1">${resolved || `<li class="italic text-outline">None resolved.</li>`}</ul>
        </div>
        <div>
          <div class="font-ribbon text-ribbon text-on-surface-variant uppercase tracking-wide mb-1">Skipped / unavailable</div>
          <ul class="font-code text-[11px] leading-relaxed space-y-1">${skipped || `<li class="italic text-outline">None skipped.</li>`}</ul>
        </div>
      </div>
      ${droppedHtml}
    </div>`;
}

function renderEvidenceTruthCard(ledger: EvidenceLedger | null): string {
  if (!ledger) {
    return `
      <div class="rds-truth-card rds-truth-unknown bg-surface border border-outline-variant rounded-DEFAULT p-container-padding flex items-start gap-3">
        ${icon("fact_check_off", 20, "text-outline shrink-0 mt-0.5")}
        <div class="min-w-0">
          <div class="font-h2 text-h2 text-on-surface">Current truth unavailable</div>
          <div class="font-body text-[14px] leading-5 text-on-surface-variant mt-1">No evidence-ledger.json has been generated yet. The dashboard is falling back to stage state and the older quality ledger.</div>
        </div>
      </div>`;
  }
  const verdict = ledger.verdict || ledger.summary?.currentTruth || "unknown";
  const blockers = ledger.blockers || [];
  const attempts = ledger.recoveryAttempts || {};
  const bad = verdict === "blocked" || verdict === "failed";
  const warn = verdict === "recovering" || verdict === "building" || verdict === "pending_review";
  const cls = bad ? "rds-truth-bad" : warn ? "rds-truth-warn" : "rds-truth-good";
  const iconName =
    verdict === "approved" ? "verified" :
    verdict === "pending_review" ? "rate_review" :
    verdict === "recovering" ? "auto_fix_high" :
    verdict === "building" ? "sync" :
    verdict === "blocked" ? "block" :
    verdict === "failed" ? "error" :
    "fact_check";
  const topBlockers = blockers.slice(0, 5);
  const blockerHtml = topBlockers.length
    ? `<div class="rds-truth-blockers">${topBlockers.map((b) => `
        <div class="rds-truth-blocker">
          <div class="flex items-start justify-between gap-3">
            <strong>${escapeHtml(displayTokenLabel(b.code || "blocker"))}</strong>
            ${b.source ? `<code title="${escapeHtml(b.source)}">${escapeHtml(b.source)}</code>` : ""}
          </div>
          <p>${escapeHtml(b.message || "No detail recorded.")}</p>
          ${b.recovery ? `<span>${escapeHtml(b.recovery)}</span>` : ""}
        </div>`).join("")}</div>`
    : `<div class="rds-truth-empty">No blocking evidence recorded.</div>`;
  const attemptText = [
    `${attempts.fixerStarted ?? 0} fixer`,
    `${attempts.iterateStarted ?? 0} iterate`,
    `${attempts.needsReview ?? 0} review handoff`,
  ].join(" · ");
  return `
    <div class="rds-truth-card ${cls} bg-surface border rounded-DEFAULT p-container-padding flex flex-col gap-4">
      <div class="flex items-start justify-between gap-4 flex-wrap">
        <div class="flex items-start gap-3 min-w-0">
          ${icon(iconName, 22, "rds-truth-icon shrink-0 mt-0.5")}
          <div class="min-w-0">
            <div class="font-ribbon text-ribbon uppercase rds-truth-kicker">Current truth</div>
            <div class="font-h2 text-[22px] leading-7 text-on-surface">${escapeHtml(displayTokenLabel(verdict))}</div>
            <div class="font-body text-[14px] leading-5 text-on-surface-variant mt-1">${escapeHtml(ledger.summary?.nextAction || "No next action recorded.")}</div>
          </div>
        </div>
        <div class="rds-truth-meta">
          <span>confidence ${escapeHtml(displayTokenLabel(ledger.confidence || "unknown"))}</span>
          <span>${escapeHtml(displayTokenLabel(ledger.summary?.blockerClass || "none"))}</span>
          <span>${escapeHtml(attemptText)}</span>
        </div>
      </div>
      ${blockerHtml}
    </div>`;
}

function prdRepairKeys(row: {
  id?: string;
  kind?: string;
  routeFamily?: string;
  action?: string;
  persona?: string;
}): string[] {
  const keys = new Set<string>();
  const add = (value?: string | null) => {
    const clean = String(value || "").trim();
    if (!clean) return;
    keys.add(clean);
    keys.add(clean.replace(/^prd-promise:/, ""));
  };
  add(row.id);
  add(row.id ? `prd-promise:${row.id}` : "");
  add(row.routeFamily ? `route:${row.routeFamily}` : "");
  add(row.routeFamily ? `prd-promise:route:${row.routeFamily}` : "");
  add(row.action ? `action:${row.action}` : "");
  add(row.action ? `prd-promise:action:${row.action}` : "");
  add(row.persona ? `persona:${row.persona}` : "");
  add(row.persona ? `prd-promise:persona:${row.persona}` : "");
  add(row.kind);
  return Array.from(keys);
}

function latestPrdRepairAttempts(id: string): Map<string, PrdRepairAttempt> {
  const buildDir = join(BUILDS_DIR, id);
  const attempts = new Map<string, PrdRepairAttempt>();
  if (!existsSync(buildDir)) return attempts;
  let files: string[] = [];
  try {
    files = readdirSync(buildDir)
      .filter((name) => /^iterate-.*\.repair-jobs\.json$/.test(name))
      .sort();
  } catch {
    return attempts;
  }
  for (const file of files) {
    const artifact = `builds/${id}/${file}`;
    const payload = safeReadJson<{
      jobs?: Array<{
        id?: string;
        type?: string;
        status?: string;
        filesTouched?: unknown[];
        checksRun?: Array<{ name?: string; status?: string; artifact?: string }>;
        targets?: Array<Record<string, unknown>>;
        closedTargets?: Array<Record<string, unknown>>;
        remainingBlockers?: Array<Record<string, unknown>>;
      }>;
    }>(join(buildDir, file));
    if (!payload || !Array.isArray(payload.jobs)) continue;
    for (const job of payload.jobs) {
      const targets = Array.isArray(job.targets) ? job.targets : [];
      const closed = new Set((Array.isArray(job.closedTargets) ? job.closedTargets : [])
        .map((row) => `${String(row.id || "")}|${String(row.gate || "")}`));
      const remaining = new Set((Array.isArray(job.remainingBlockers) ? job.remainingBlockers : [])
        .map((row) => `${String(row.id || "")}|${String(row.gate || "")}`));
      for (const target of targets) {
        if (String(target.gate || "") !== "prd-coverage") continue;
        const keys = prdRepairKeys({
          id: typeof target.id === "string" ? target.id : undefined,
          kind: typeof target.promiseKind === "string" ? target.promiseKind : undefined,
          routeFamily: typeof target.routeFamily === "string" ? target.routeFamily : undefined,
          action: typeof target.action === "string" ? target.action : undefined,
          persona: typeof target.persona === "string" ? target.persona : undefined,
        });
        const targetKey = `${String(target.id || "")}|${String(target.gate || "")}`;
        const targetStatus = closed.has(targetKey) ? "closed" : remaining.has(targetKey) ? "still blocking" : undefined;
        const attempt: PrdRepairAttempt = {
          artifact,
          iteration: file.replace(/\.repair-jobs\.json$/, ""),
          jobId: job.id || "repair-job",
          jobType: job.type,
          status: job.status,
          targetStatus,
          filesTouched: Array.isArray(job.filesTouched) ? job.filesTouched.length : undefined,
          checksRun: Array.isArray(job.checksRun) ? job.checksRun.slice(0, 4) : undefined,
        };
        for (const key of keys) attempts.set(key, attempt);
      }
    }
  }
  return attempts;
}

function renderQualityLedgerCard(id: string, ledger: QualityLedger | null): string {
  if (!ledger) {
    return "";
  }
  const skills = ledger.skills || {};
  const skillImpact = ledger.skillImpact || {};
  const prdCoverage = ledger.prdCoverage || {};
  const scenarios = ledger.scenarios || {};
  const verdictEntries = Object.entries(ledger.verdicts || {});
  const blocking = ledger.blocking || [];
  const verdictHtml = verdictEntries.length
    ? verdictEntries.map(([name, value]) => {
        const bad = isBlockingVerdict(name, value);
        return `<span class="rds-ledger-pill ${bad ? "rds-ledger-pill-bad" : "rds-ledger-pill-good"}">${escapeHtml(displayTokenLabel(name))}: ${escapeHtml(displayTokenLabel(String(value)))}</span>`;
      }).join("")
    : `<span class="text-outline italic font-table text-table">No verdicts yet.</span>`;
  const scenarioChecks = (scenarios.checks || [])
    .slice()
    .sort((a, b) => (a.status === "pass" ? 1 : 0) - (b.status === "pass" ? 1 : 0))
    .slice(0, 6);
  const scenarioChecksHtml = scenarioChecks.length
    ? `<div class="rds-ledger-check-grid">${scenarioChecks.map((check) => {
        const status = check.status || "unknown";
        const bad = status !== "pass";
        const transcript = (check.transcript || []).slice(0, 4).map((step) => {
          const stepBad = step.status !== "pass";
          return `<li class="rds-ledger-step">
            <span class="${stepBad ? "text-error" : "text-primary-container"}">${escapeHtml(displayTokenLabel(step.status || "?"))}</span>
            <span>${escapeHtml(step.step || "step")}</span>
            ${step.detail ? `<span class="text-on-surface-variant">${escapeHtml(step.detail)}</span>` : ""}
          </li>`;
        }).join("");
        return `<article class="rds-ledger-check ${bad ? "rds-ledger-check-bad" : "rds-ledger-check-good"}">
          <div class="flex items-start justify-between gap-3">
            <h3 class="font-h2 text-[15px] leading-5 text-on-surface">${escapeHtml(check.title || check.id || "Scenario")}</h3>
            <span class="rds-ledger-status ${bad ? "rds-ledger-status-bad" : "rds-ledger-status-good"}">${escapeHtml(displayTokenLabel(status))}</span>
          </div>
          ${check.evidence ? `<p class="rds-ledger-evidence">${escapeHtml(check.evidence)}</p>` : `<p class="rds-ledger-evidence text-outline">No evidence recorded.</p>`}
          ${transcript ? `<ul class="mt-3 space-y-1">${transcript}</ul>` : ""}
        </article>`;
      }).join("")}</div>`
    : "";
  const skillImpactRows = (skillImpact.blockingSkills || []).slice(0, 8);
  const prdRows = (prdCoverage.blockingRows || []).slice(0, 8);
  const prdSummary = prdCoverage.summary || {};
  const prdRepairAttempts = latestPrdRepairAttempts(id);
  const prdRowsHtml = prdRows.length
    ? `<div class="rds-ledger-check-grid">${prdRows.map((row) => {
        const status = row.status || "missing";
        const label = row.routeFamily || row.action || row.persona || row.kind || row.id || "PRD promise";
        const repairAttempt = prdRepairKeys(row).map((key) => prdRepairAttempts.get(key)).find(Boolean);
        const meta = [
          row.kind ? `kind=${row.kind}` : "",
          row.routeFamily ? `route=${row.routeFamily}` : "",
          row.action ? `action=${row.action}` : "",
          row.persona ? `persona=${row.persona}` : "",
        ].filter(Boolean).join(" · ");
        const checks = repairAttempt?.checksRun?.length
          ? repairAttempt.checksRun.map((check) => `${check.name || "check"}=${check.status || "unknown"}`).join(" · ")
          : "";
        const attemptHtml = repairAttempt
          ? `<div class="rds-ledger-attempt">
              <span>${icon("engineering", 13)}<strong>${escapeHtml(displayTokenLabel(repairAttempt.status || "attempted"))}</strong></span>
              <span>${escapeHtml(repairAttempt.iteration)}</span>
              <span>${escapeHtml(repairAttempt.jobId)}</span>
              ${repairAttempt.targetStatus ? `<span>${escapeHtml(repairAttempt.targetStatus)}</span>` : ""}
              ${typeof repairAttempt.filesTouched === "number" ? `<span>${repairAttempt.filesTouched} files</span>` : ""}
              ${checks ? `<span>${escapeHtml(checks)}</span>` : ""}
              <code>${escapeHtml(repairAttempt.artifact)}</code>
            </div>`
          : `<div class="rds-ledger-attempt rds-ledger-attempt-missing">
              <span>${icon("pending_actions", 13)}<strong>no repair attempt linked yet</strong></span>
            </div>`;
        return `<article class="rds-ledger-check rds-ledger-check-bad">
          <div class="flex items-start justify-between gap-3">
            <h3 class="font-h2 text-[15px] leading-5 text-on-surface">${escapeHtml(label)}</h3>
            <span class="rds-ledger-status rds-ledger-status-bad">${escapeHtml(displayTokenLabel(status))}</span>
          </div>
          ${row.promise ? `<p class="rds-ledger-evidence">${escapeHtml(row.promise)}</p>` : `<p class="rds-ledger-evidence text-outline">No PRD promise text recorded.</p>`}
          ${row.repairHint ? `<p class="rds-ledger-path">${escapeHtml(row.repairHint)}</p>` : ""}
          ${meta ? `<p class="rds-ledger-path">${escapeHtml(meta)}</p>` : ""}
          ${attemptHtml}
        </article>`;
      }).join("")}</div>`
    : "";
  const skillImpactHtml = skillImpactRows.length
    ? `<div class="rds-ledger-check-grid">${skillImpactRows.map((skill) => {
        const status = skill.verdict || "unknown";
        const bad = status === "fail" || status === "partial" || status === "unknown";
        const shapeEvidence = skill.shape?.evidence
          ? Object.entries(skill.shape.evidence).slice(0, 6).map(([key, value]) => `${displayTokenLabel(key)}=${Array.isArray(value) ? value.length : String(value)}`).join(" · ")
          : "";
        const verify = skill.verify
          ? `verify rc=${skill.verify.exitCode ?? "?"}${skill.verify.output ? ` · ${skill.verify.output.slice(0, 140)}` : ""}`
          : "";
        return `<article class="rds-ledger-check ${bad ? "rds-ledger-check-bad" : "rds-ledger-check-good"}">
          <div class="flex items-start justify-between gap-3">
            <h3 class="font-h2 text-[15px] leading-5 text-on-surface">${escapeHtml(skill.slug || "skill")}</h3>
            <span class="rds-ledger-status ${bad ? "rds-ledger-status-bad" : "rds-ledger-status-good"}">${escapeHtml(displayTokenLabel(status))}</span>
          </div>
          <p class="rds-ledger-evidence">${escapeHtml(skill.note || skill.shape?.note || "No skill impact note recorded.")}</p>
          ${shapeEvidence ? `<p class="rds-ledger-path">${escapeHtml(shapeEvidence)}</p>` : ""}
          ${verify ? `<p class="rds-ledger-path">${escapeHtml(verify)}</p>` : ""}
        </article>`;
      }).join("")}</div>`
    : "";
  return `
    <div class="rds-quality-ledger bg-surface border border-outline-variant rounded-DEFAULT p-container-padding flex flex-col gap-4">
      <div class="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div class="font-h2 text-h2 text-on-surface flex items-center gap-2">${icon("fact_check", 19, "text-primary-container")}<span>QA evidence</span></div>
          <div class="font-body text-[14px] leading-5 text-on-surface-variant mt-0.5">What RDS checked before allowing approval.</div>
        </div>
        <div class="rds-ledger-blocker-count ${blocking.length ? "rds-ledger-blocker-count-bad" : "rds-ledger-blocker-count-good"}">${blocking.length ? `${blocking.length} blocking` : "No blockers"}</div>
      </div>

      ${blocking.length ? `<div class="rds-ledger-blockers">
        <div class="font-ribbon text-ribbon text-error uppercase tracking-wide">Approval blockers</div>
        <div class="flex flex-wrap gap-2 mt-2">${blocking.map((item) => `<span>${escapeHtml(displayTokenLabel(item))}</span>`).join("")}</div>
      </div>` : ""}

      <div class="grid md:grid-cols-3 gap-3">
        <div class="rds-ledger-metric">
          <div class="rds-ledger-metric-label">Skills</div>
          <div class="rds-ledger-metric-value">${skills.resolved?.length ?? 0} / ${skills.requested?.length ?? 0}</div>
          <div class="rds-ledger-metric-note">impact ${escapeHtml(displayTokenLabel(String(skillImpact.status || "not recorded")))} · installed ${skills.installed?.length ?? 0} · skipped ${skills.skipped?.length ?? 0}</div>
          ${skillImpact.path ? `<details class="rds-ledger-artifact"><summary>artifact</summary><code>${escapeHtml(skillImpact.path)}</code></details>` : ""}
        </div>
        <div class="rds-ledger-metric">
          <div class="rds-ledger-metric-label">QA scenarios</div>
          <div class="rds-ledger-metric-value ${scenarios.executed && scenarios.status === "pass" ? "text-primary-container" : "text-error"}">${scenarios.available ? `${scenarios.count ?? 0} generated` : "Missing"}</div>
          <div class="rds-ledger-metric-note">${scenarios.executed ? `executed: ${escapeHtml(displayTokenLabel(String(scenarios.status || "unknown")))}` : "not executed"}</div>
          ${scenarios.verdictPath || scenarios.path ? `<details class="rds-ledger-artifact"><summary>artifact</summary><code>${escapeHtml(scenarios.verdictPath || scenarios.path || "")}</code></details>` : ""}
        </div>
        <div class="rds-ledger-metric">
          <div class="rds-ledger-metric-label">PRD promises</div>
          <div class="rds-ledger-metric-value ${prdCoverage.status === "pass" ? "text-primary-container" : "text-error"}">${prdCoverage.available ? `${prdSummary.verified ?? 0} / ${prdSummary.total ?? 0}` : "Missing"}</div>
          <div class="rds-ledger-metric-note">${prdSummary.missing ?? 0} missing · ${escapeHtml(displayTokenLabel(String(prdCoverage.status || "not recorded")))}</div>
          ${prdCoverage.verdictPath ? `<details class="rds-ledger-artifact"><summary>artifact</summary><code>${escapeHtml(prdCoverage.verdictPath)}</code></details>` : ""}
        </div>
        <div class="rds-ledger-metric">
          <div class="rds-ledger-metric-label">Latest QA</div>
          <div class="rds-ledger-metric-value">${escapeHtml(ledger.latestPlaywrightIteration || "None")}</div>
          <div class="rds-ledger-metric-note">${blocking.length ? "blocked by product/QA gates" : "waiting for QA artifacts"}</div>
        </div>
      </div>
      <div class="flex flex-wrap gap-2">${verdictHtml}</div>
      ${prdRowsHtml ? `<section class="flex flex-col gap-2">
        <div class="font-ribbon text-ribbon text-on-surface-variant uppercase tracking-wide">Unmet PRD requirements</div>
        ${prdRowsHtml}
      </section>` : ""}
      ${skillImpactHtml ? `<section class="flex flex-col gap-2">
        <div class="font-ribbon text-ribbon text-on-surface-variant uppercase tracking-wide">Tooling gaps</div>
        ${skillImpactHtml}
      </section>` : ""}
      ${scenarioChecksHtml}
    </div>`;
}

function renderBuildGoalPanel(id: string, goal: RdsGoalState | null, row: BuildRow, evidenceLedger: EvidenceLedger | null): string {
  const active = goalLooksFreshRunning(goal);
  const staleRunning = goalIsStaleRunning(goal);
  const status = staleRunning ? "stale_running" : (goal?.status || "not_started");
  const phase = goal?.phase || "idle";
  const objective = goal?.objective || "Make this build review-ready.";
  const cycle = `${goal?.cycle ?? 0}/${goal?.maxCycles ?? 3}`;
  const agentReviews = `${goal?.agentReviewCount ?? 0}/${goal?.maxAgentReviews ?? 1}`;
  const turnCount = Array.isArray(goal?.turns) ? goal.turns.length : 0;
  const resumeCount = goal?.resumeCount ?? 0;
  const repeatCount = goal?.repeatCount ?? 0;
  const blockerClass = goal?.blockerClass || evidenceLedger?.summary?.blockerClass || "none";
  const nextAction = goal?.currentAction || goal?.nextAction || evidenceLedger?.summary?.nextAction || "Run the goal loop to choose the next evidence-driven action.";
  const nodes = goal?.nodes?.length
    ? goal.nodes.map((node) => staleRunning && node.status === "running" ? { ...node, status: "stale_running" } : node)
    : [
        { id: "goal", label: "Goal", status: status === "not_started" ? "pending" : status },
        { id: "evidence", label: "Evidence", status: evidenceLedger?.verdict ? evidenceLedger.verdict : "pending" },
        { id: "repair", label: "Repair loop", status: "pending" },
        { id: "agent-review", label: "Claude/Codex worker review", status: "pending" },
        { id: "operator", label: "Operator review", status: row.reviewStatus || "pending" },
      ];
  const nodeTone = (value?: string) => {
    const v = String(value || "pending");
    if (["passed", "approved", "ready", "pending_review"].includes(v)) return "border-primary-container/50 bg-primary-container/10 text-primary-container";
    if (["running", "building", "recovering"].includes(v)) return "border-secondary/50 bg-secondary-container/20 text-secondary";
    if (["stale_running"].includes(v)) return "border-tertiary-container/50 bg-tertiary-container/10 text-tertiary-container";
    if (["blocked", "failed", "needs_review"].includes(v)) return "border-error/50 bg-error/10 text-error";
    return "border-outline-variant bg-surface text-on-surface-variant";
  };
  const actions = (goal?.actions || []).slice(-4).reverse();
  const blockers = (goal?.blockers || []).slice(0, 3);
  const rawGoalLink = `/b/${escapeHtml(id)}/goal.json`;
  if (!goal) {
    return `
    <section class="bg-surface border border-outline-variant rounded-DEFAULT p-3 flex items-center justify-between gap-3 flex-wrap">
      <div class="min-w-0">
        <div class="font-ribbon text-ribbon text-primary-container uppercase flex items-center gap-2">${icon("conversion_path", 16)}<span>RDS Goal</span></div>
        <h2 class="font-h2 text-h2 text-on-surface mt-0.5">No goal run yet</h2>
        <p class="font-table text-table text-on-surface-variant mt-1">Continue Goal to repair blockers and rerun QA/readiness.</p>
      </div>
      <div class="flex gap-2 flex-wrap items-center">
        <span class="font-code text-[11px] border border-outline-variant rounded px-2 py-1 text-on-surface-variant">not started</span>
        <button type="button" onclick="runGoal()" class="px-3 py-1.5 bg-primary-container hover:bg-surface-tint text-on-primary-container rounded-DEFAULT font-ribbon text-ribbon font-bold transition-colors flex items-center gap-1">${icon("target", 14)}<span>Start goal</span></button>
      </div>
    </section>`;
  }
  return `
    <section class="rds-goal-panel bg-surface border border-outline-variant rounded-DEFAULT p-3 flex flex-col gap-3">
      <div class="rds-goal-head flex items-start justify-between gap-3 flex-wrap">
        <div class="rds-goal-headtext min-w-0">
          <div class="font-ribbon text-ribbon text-primary-container uppercase flex items-center gap-2">${icon("conversion_path", 16)}<span>RDS Goal</span></div>
          <h2 class="font-h2 text-h2 text-on-surface mt-0.5 break-words">${escapeHtml(objective)}</h2>
          <p class="font-table text-table text-on-surface-variant mt-1 break-words">${escapeHtml(nextAction)}</p>
        </div>
        <div class="flex gap-2 flex-wrap items-center">
          <span class="font-code text-[11px] border ${staleRunning ? "border-tertiary-container/50 text-tertiary-container" : "border-outline-variant text-on-surface-variant"} rounded px-2 py-1">${escapeHtml(displayTokenLabel(status))}</span>
          <span class="font-code text-[11px] border border-outline-variant rounded px-2 py-1 text-on-surface-variant">phase ${escapeHtml(displayTokenLabel(phase))}</span>
          ${goal?.updatedAt ? `<span class="font-code text-[11px] border border-outline-variant rounded px-2 py-1 text-on-surface-variant">updated ${escapeHtml(relativeTime(goalUpdatedMs(goal)))}</span>` : ""}
          ${goal?.engine?.provider ? `<span class="font-code text-[11px] border rounded px-2 py-1 ${goal.engine.reason === "usage_limit" ? "border-secondary/50 text-secondary" : "border-outline-variant text-on-surface-variant"}" title="${goal.engine.switchedFrom ? `switched from ${escapeHtml(goal.engine.switchedFrom)} after usage limit` : "active engine"}">${icon("bolt", 12)} ${escapeHtml(displayTokenLabel(goal.engine.provider))}${goal.engine.model ? ` ${escapeHtml(goal.engine.model)}` : ""}${goal.engine.switchedFrom ? ` (was ${escapeHtml(displayTokenLabel(goal.engine.switchedFrom))})` : ""}</span>` : ""}
          <button type="button" onclick="runGoal()" class="px-3 py-1.5 ${active ? "border border-outline-variant bg-surface text-on-surface-variant" : "bg-primary-container hover:bg-surface-tint text-on-primary-container"} rounded-DEFAULT font-ribbon text-ribbon font-bold transition-colors flex items-center gap-1" ${active ? "disabled" : ""}>${icon(active ? "progress_activity" : staleRunning ? "play_arrow" : "target", 14, active ? "animate-spin" : "")}<span>${active ? "Goal running" : goal ? "Continue goal" : "Start goal"}</span></button>
        </div>
      </div>
      <div class="rds-goal-mobile-summary">
        <span>Cycle ${escapeHtml(cycle)}</span>
        <span>${escapeHtml(displayTokenLabel(status))}</span>
        <span>${escapeHtml(displayTokenLabel(blockerClass))}</span>
        <span>${escapeHtml(agentReviews)} reviews</span>
      </div>
      <div class="rds-goal-nodes grid md:grid-cols-5 gap-2">
        ${nodes.map((node) => `<div class="border ${nodeTone(node.status)} rounded-DEFAULT p-2 min-w-0">
          <div class="font-ribbon text-[10px] uppercase opacity-80 truncate">${escapeHtml(node.id || "")}</div>
          <div class="font-table text-table text-on-surface truncate">${escapeHtml(node.label || "")}</div>
          <div class="font-code text-[10px] opacity-80 truncate">${escapeHtml(displayTokenLabel(String(node.status || "pending")))}</div>
        </div>`).join("")}
      </div>
      <div class="rds-goal-stats grid md:grid-cols-3 gap-2">
        <div class="bg-[#070908] border border-outline-variant rounded-DEFAULT p-2">
          <div class="font-ribbon text-ribbon text-on-surface-variant">Loop budget</div>
          <div class="font-h2 text-h2 text-on-surface">Cycle ${escapeHtml(cycle)}</div>
          <div class="font-table text-table text-on-surface-variant">Agent reviews ${escapeHtml(agentReviews)} · turns ${escapeHtml(String(turnCount))} · resumes ${escapeHtml(String(resumeCount))}</div>
        </div>
        <div class="bg-[#070908] border border-outline-variant rounded-DEFAULT p-2">
          <div class="font-ribbon text-ribbon text-on-surface-variant">Blocker class</div>
          <div class="font-h2 text-h2 text-on-surface">${escapeHtml(displayTokenLabel(blockerClass))}</div>
          <div class="font-table text-table text-on-surface-variant">${escapeHtml(evidenceLedger?.verdict ? `Evidence ${displayTokenLabel(evidenceLedger.verdict)}` : "Evidence not refreshed yet")} · repeat ${escapeHtml(String(repeatCount))}</div>
        </div>
        <div class="bg-[#070908] border border-outline-variant rounded-DEFAULT p-2">
          <div class="font-ribbon text-ribbon text-on-surface-variant">Artifacts</div>
          ${goal ? `<a href="${rawGoalLink}" class="font-code text-[11px] text-primary-container hover:underline">goal.json</a>` : `<div class="font-code text-[11px] text-outline">goal.json not written yet</div>`}
          ${goal?.goalDir ? `<div class="font-code text-[10px] text-outline truncate" title="${escapeHtml(goal.goalDir)}">${escapeHtml(goal.goalDir)}</div>` : `<div class="font-table text-table text-on-surface-variant">No goal run yet.</div>`}
        </div>
      </div>
      ${blockers.length ? `<div class="rds-goal-detail-block flex flex-col gap-1">
        <div class="font-ribbon text-ribbon text-on-surface-variant uppercase">Current blockers</div>
        ${blockers.map((b) => `<div class="border border-outline-variant rounded-DEFAULT px-2 py-1.5 font-table text-table">
          <strong class="text-on-surface">${escapeHtml(displayTokenLabel(b.code || "blocker"))}</strong>
          <span class="text-on-surface-variant"> · ${escapeHtml(b.recovery || b.detail || "Needs repair.")}</span>
        </div>`).join("")}
      </div>` : ""}
      ${actions.length ? `<div class="rds-goal-detail-block flex flex-col gap-1">
        <div class="font-ribbon text-ribbon text-on-surface-variant uppercase">Recent goal actions</div>
        ${actions.map((a) => `<div class="flex items-center gap-2 flex-wrap border border-outline-variant rounded-DEFAULT px-2 py-1.5 font-table text-table">
          <span class="font-code text-[10px] text-outline">cycle ${escapeHtml(String(a.cycle ?? "-"))}</span>
          <strong class="text-on-surface">${escapeHtml(displayTokenLabel(String(a.type || "action")))}</strong>
          <span class="${a.status === "passed" ? "text-primary-container" : a.status === "failed" ? "text-error" : "text-on-surface-variant"}">${escapeHtml(displayTokenLabel(String(a.status || "unknown")))}</span>
          ${a.type === "provider_switch" && a.from && a.to ? `<span class="font-code text-[10px] text-secondary">${escapeHtml(displayTokenLabel(a.from))} → ${escapeHtml(displayTokenLabel(a.to))}${a.reason ? ` · ${escapeHtml(displayTokenLabel(a.reason))}` : ""}</span>` : ""}
          ${a.repairJobs ? `<span class="font-code text-[10px] text-primary-container truncate">${escapeHtml(a.repairJobs)}</span>` : ""}
          ${a.sessionId ? `<span class="font-code text-[10px] text-secondary truncate">session ${escapeHtml(a.sessionId)}</span>` : ""}
        </div>`).join("")}
      </div>` : ""}
    </section>`;
}

function renderBuildCommandCenter(opts: {
  id: string;
  row: BuildRow;
  evidenceLedger: EvidenceLedger | null;
  qualityLedger: QualityLedger | null;
  previewUrl: string;
  canOpenPreview: boolean;
  evidenceBlocksApproval: boolean;
  fixerRunning: boolean;
  iterationRunning: boolean;
  engine: { provider: "claude" | "codex"; claudeModel: string; codexModel: string };
}): string {
  const { id, row, evidenceLedger, qualityLedger, previewUrl, canOpenPreview, evidenceBlocksApproval, fixerRunning, iterationRunning, engine } = opts;
  const evidenceVerdict = evidenceLedger?.verdict || "";
  const staleLiveEvidence = !row.running && !fixerRunning && !iterationRunning && ["building", "recovering"].includes(evidenceVerdict);
  const activeRecovery = iterationRunning || fixerRunning;
  const runnerMissing = !activeRecovery && (!!row.runnerMissing || row.status === "stalled");
  const staleTasteOnly = !activeRecovery
    && Array.isArray(qualityLedger?.blocking)
    && qualityLedger.blocking.length === 1
    && qualityLedger.blocking[0] === "taste"
    && (evidenceLedger?.blockers || []).some((b) => b.code === "taste_review_stale");
  const verdict = runnerMissing ? "runner_stopped" : row.stuck ? "stalled" : evidenceBlocksApproval
    ? "blocked"
    : staleLiveEvidence
    ? (row.reviewStatus === "pending" ? "pending_review" : row.status || "not_running")
    : (evidenceVerdict || (row.reviewStatus === "pending" ? "pending_review" : row.status || "unknown"));
  const headline = iterationRunning
    ? "Iteration running"
    : fixerRunning
    ? "Fixer running"
    : row.running
    ? `Running ${displayTokenLabel(row.stage || "build")}`
    : row.paused
      ? `Paused at ${displayTokenLabel(row.stage || "build")}`
      : staleTasteOnly
        ? "Blocked by stale review evidence"
      : evidenceBlocksApproval && row.reviewStatus === "pending"
        ? "Blocked before approval"
      : displayTokenLabel(verdict);
  const bad = verdict === "blocked" || verdict === "failed" || row.status === "failed" || runnerMissing || row.stuck;
  const running = row.running || iterationRunning || fixerRunning;
  const tone = bad ? "bad" : running ? "warn" : "good";
  const iconName =
    runnerMissing || row.stuck ? "warning" :
    running ? "sync" :
    verdict === "pending_review" ? "rate_review" :
    bad ? "block" :
    verdict === "approved" ? "verified" :
    "fact_check";
  const nextAction = runnerMissing
    ? `No RDS runner is attached. Resume from ${displayTokenLabel(row.stage || "current stage")}.`
    : iterationRunning
    ? "RDS is applying changes, then checks, QA, and redeploy."
    : fixerRunning
    ? "RDS is diagnosing blockers and preparing a repair path."
    : row.stuck
    ? `No output for ${row.lastActivityMs ? formatDuration(Date.now() - row.lastActivityMs) : "too long"}. Open the live log or spawn a fixer/resume action.`
    : staleTasteOnly
    ? "Taste review is stale. Rerun taste-review against the latest QA evidence before another product iteration."
    : evidenceBlocksApproval && row.appDest
    ? "Evidence is blocking approval. Continue Goal to repair blockers and rerun QA."
    : staleLiveEvidence
    ? "No live RDS runner is attached to this build. Inspect logs or continue the RDS Goal loop."
    : evidenceLedger?.summary?.nextAction
    || (row.running ? "Watch the live log until the current stage finishes." : row.reviewStatus === "pending" ? "Review the live app and approve or reject." : "Open the app or inspect logs.");
  const blockerSource = staleTasteOnly
    ? (evidenceLedger?.blockers || []).filter((b) => b.code === "taste_review_stale" || b.code === "taste_review_blocking")
    : (evidenceLedger?.blockers || []);
  const blockers = blockerSource
    .slice()
    .sort((a, b) => {
      const rank = (code?: string) => {
        if (staleTasteOnly && code === "taste_review_stale") return 0;
        if (staleTasteOnly && code === "taste_review_blocking") return 1;
        if (staleTasteOnly && code === "quality_ledger_blocking") return 2;
        if (staleTasteOnly && code === "stage_not_complete") return 3;
        return code === "stage_not_complete" ? 2 : code?.includes("taste") ? 0 : code?.includes("scenario") || code?.includes("uat") ? 0 : 1;
      };
      return rank(a.code) - rank(b.code);
    });
  const showBlockers = !row.running || row.stuck || runnerMissing;
  const topBlockers = showBlockers ? blockers.slice(0, 3) : [];
  const hiddenBlockers = Math.max(0, blockers.length - topBlockers.length);
  const attempts = evidenceLedger?.recoveryAttempts || {};
  const blockerClass = evidenceLedger?.summary?.blockerClass || qualityLedger?.blocking?.join(", ") || "none";
  const scenarioStatus = qualityLedger?.scenarios?.executed
    ? `${qualityLedger?.scenarios?.count ?? 0} scenarios · ${displayTokenLabel(String(qualityLedger?.scenarios?.status || "unknown"))}`
    : qualityLedger?.scenarios?.available
      ? `${qualityLedger?.scenarios?.count ?? 0} scenarios · not run`
      : "scenarios missing";
  const skillCount = `${qualityLedger?.skills?.resolved?.length ?? 0}/${qualityLedger?.skills?.requested?.length ?? 0} skills`;
  const attemptText = [
    attempts.fixerStarted ? `${attempts.fixerStarted} fixer` : "",
    attempts.iterateStarted ? `${attempts.iterateStarted} iteration attempts` : "",
    attempts.needsReview ? `${attempts.needsReview} handoff` : "",
  ].filter(Boolean).join(" · ") || "no recovery attempts";
  // Idle-build chips only state what is known: absent evidence stays quiet
  // ("scenarios missing · 0/0 skills · no recovery attempts" on a clean build
  // reads like a problem when nothing is wrong).
  const idleChips: string[] = [blockerClass === "none" ? "no blockers" : displayTokenLabel(blockerClass)];
  if (qualityLedger?.scenarios?.executed || qualityLedger?.scenarios?.available) idleChips.push(scenarioStatus);
  if ((qualityLedger?.skills?.requested?.length ?? 0) > 0) idleChips.push(skillCount);
  if (attempts.fixerStarted || attempts.iterateStarted || attempts.needsReview) idleChips.push(attemptText);
  const activeRunChips = row.running
    ? [
        `stage ${displayTokenLabel(row.stage || "build")}`,
        row.lastActivityMs ? `output ${relativeTime(row.lastActivityMs)}` : "output pending",
        attemptText,
      ]
    : staleTasteOnly
      ? ["No active runner", `${escapeHtml(qualityLedger?.latestPlaywrightIteration || "latest QA")} passed`, "Taste review predates latest QA", attemptText]
      : idleChips;
  const blockerSourceLabel = (source?: string | null): string => {
    const parts = String(source || "").split("/").filter(Boolean);
    if (!parts.length) return "";
    return parts.slice(-3).join("/");
  };
  const blockerHtml = topBlockers.length
    ? `<div class="rds-blocker-list">${topBlockers.map((b, index) => {
        const title = displayTokenLabel(b.code || "blocker");
        const severity = displayTokenLabel(b.severity || "blocker");
        const reason = b.message || "Needs attention.";
        const recovery = b.recovery || nextAction;
        const source = b.source || "";
        const sourceLabel = blockerSourceLabel(source);
        return `<article class="rds-blocker-item">
          <div class="rds-blocker-head">
            <span class="rds-blocker-index">${index + 1}</span>
            <strong>${escapeHtml(title)}</strong>
            <span class="rds-blocker-severity">${escapeHtml(severity)}</span>
          </div>
          <p>${escapeHtml(reason)}</p>
          ${recovery ? `<div class="rds-blocker-next"><span>Next</span><b>${escapeHtml(recovery)}</b></div>` : ""}
          ${source ? `<details class="rds-blocker-source">
            <summary>${escapeHtml(sourceLabel || "Evidence file")}</summary>
            <code>${escapeHtml(source)}</code>
          </details>` : ""}
        </article>`;
      }).join("")}</div>
      ${hiddenBlockers ? `<button type="button" onclick="document.getElementById('quality-ledger-details')?.setAttribute('open','open');document.getElementById('quality-ledger-details')?.scrollIntoView({behavior:'smooth',block:'start'});" class="rds-command-link">Show ${hiddenBlockers} more in evidence</button>` : ""}`
    : row.running && !row.stuck && !runnerMissing
      ? `<p class="rds-command-muted">Scaffold is actively working. Use the detailed task progress below; intervene only if output goes stale.</p>`
      : `<p class="rds-command-muted">No blocking evidence recorded.</p>`;
  const action = (label: string, onclick: string, kind: "primary" | "secondary" | "danger" = "secondary", disabled = false) => {
    const cls = kind === "primary"
      ? "rds-command-action rds-command-action-primary"
      : kind === "danger"
        ? "rds-command-action rds-command-action-danger"
        : "rds-command-action";
    return `<button type="button" class="${cls}" onclick="${onclick}" ${disabled ? "disabled" : ""}>${label}</button>`;
  };
  const actions: string[] = [];
  let showEnginePicker = false;
  if (canOpenPreview) actions.push(`<a class="rds-command-action rds-command-action-primary" href="${escapeHtml(previewUrl)}" target="_blank">${icon("open_in_new", 14)}<span>Open app</span></a>`);
  if (row.running) {
    actions.push(action(`${icon("receipt_long", 14)}<span>Watch log</span>`, "showTab('live-log')", "primary"));
    actions.push(action(`${icon("pause", 14)}<span>Pause</span>`, "cmd('pause')"));
  } else if (row.paused || runnerMissing) {
    actions.push(action(`${icon("play_arrow", 14)}<span>Resume build</span>`, "cmd('resume')", "primary"));
  } else if (row.reviewStatus === "pending" && evidenceBlocksApproval && row.appDest) {
    showEnginePicker = true;
    actions.push(action(`${icon("target", 14)}<span>${staleTasteOnly ? "Rerun review via Goal" : "Continue RDS Goal"}</span>`, "runGoal()", "primary"));
    actions.push(action(iterationRunning ? `${icon("progress_activity", 14, "animate-spin")}<span>Iterating</span>` : `${icon("edit", 14)}<span>One-off iteration</span>`, "iterateBuild()", "secondary", iterationRunning));
    actions.push(action(`${icon("chat", 14)}<span>Ask why</span>`, "showTab('chat')"));
    actions.push(action(`${icon("close", 14)}<span>Reject</span>`, "reject()", "danger"));
  } else if (row.reviewStatus === "pending" && !evidenceBlocksApproval) {
    actions.push(action(`${icon("check", 14)}<span>Approve</span>`, "approve()", "primary"));
    actions.push(action(`${icon("close", 14)}<span>Reject</span>`, "reject()"));
    if (row.appDest) {
      showEnginePicker = true;
      actions.push(action(iterationRunning ? `${icon("progress_activity", 14, "animate-spin")}<span>Iterating</span>` : `${icon("edit", 14)}<span>Run targeted iteration</span>`, "iterateBuild()", "secondary", iterationRunning));
      actions.push(action(`${icon("chat", 14)}<span>Ask RDS</span>`, "showTab('chat')"));
    }
  } else if (row.appDest) {
    showEnginePicker = true;
    actions.push(action(`${icon("target", 14)}<span>Make review-ready</span>`, "runGoal()", "primary"));
    actions.push(action(iterationRunning ? `${icon("progress_activity", 14, "animate-spin")}<span>Iterating</span>` : `${icon("edit", 14)}<span>One-off iteration</span>`, "iterateBuild()", "secondary", iterationRunning));
    actions.push(action(`${icon("chat", 14)}<span>Ask RDS</span>`, "showTab('chat')"));
    if (row.reviewStatus === "pending") actions.push(action(`${icon("close", 14)}<span>Reject</span>`, "reject()", "danger"));
  }
  if (row.stuck || runnerMissing || (!row.running && row.status === "failed")) {
    actions.push(action(fixerRunning ? `${icon("hourglass_empty", 14)}<span>Fixer running</span>` : `${icon("auto_fix_high", 14)}<span>Spawn fixer</span>`, "spawnFixer()", runnerMissing ? "secondary" : "primary", fixerRunning));
  }
  if (!actions.length) actions.push(action(`${icon("receipt_long", 14)}<span>Open logs</span>`, "showTab('terminal')"));
  const currentEngineModel = engine.provider === "codex" ? engine.codexModel : engine.claudeModel;
  const enginePicker = showEnginePicker
    ? `<div class="rds-command-engine" data-claude-model="${escapeHtml(engine.claudeModel)}" data-codex-model="${escapeHtml(engine.codexModel)}">
        <span class="rds-command-engine-label">${icon("memory", 13)}<span>Engine</span></span>
        <select id="engine-provider" class="rds-command-engine-select" onchange="rdsEngineSwap(this)" aria-label="Inference provider">
          <option value="claude" ${engine.provider === "claude" ? "selected" : ""}>Claude Code</option>
          <option value="codex" ${engine.provider === "codex" ? "selected" : ""}>Codex</option>
        </select>
        <input id="engine-model" class="rds-command-engine-input" list="${engine.provider === "codex" ? "rds-engine-codex" : "rds-engine-claude"}" value="${escapeHtml(currentEngineModel)}" placeholder="provider default" spellcheck="false" autocomplete="off" aria-label="Model id" />
        <datalist id="rds-engine-claude">${CLAUDE_MODELS.map((m) => `<option value="${escapeHtml(m)}"></option>`).join("")}</datalist>
        <datalist id="rds-engine-codex">${CODEX_MODEL_SUGGESTIONS.map((m) => `<option value="${escapeHtml(m)}"></option>`).join("")}</datalist>
        <span class="rds-command-engine-hint">Switch provider or pin a model (e.g. claude-opus-4-8) before continuing.</span>
      </div>`
    : "";
  const livePanel = canOpenPreview
    ? `<div class="rds-command-live">
        <div class="rds-command-label">${row.hasZoService ? "Live on Zo" : "Preview"}</div>
        <div class="rds-command-live-row">
          ${icon(row.hasZoService ? "cloud_done" : "computer", 16)}
          <a href="${escapeHtml(previewUrl)}" target="_blank" title="${escapeHtml(previewUrl)}">${escapeHtml(previewUrl)}</a>
          <button type="button" onclick="navigator.clipboard.writeText('${escapeHtml(previewUrl)}').then(function(){rdsToast('URL copied.','info');})">${icon("content_copy", 13)}<span>Copy</span></button>
        </div>
      </div>`
    : "";

  return `
    <section class="rds-command-center rds-command-${tone}">
      <div class="rds-command-main">
        <div class="rds-command-verdict">
          ${icon(iconName, 22, running ? "animate-spin" : "")}
          <div>
            <div class="rds-command-kicker">Build status</div>
            <h2>${escapeHtml(headline)}</h2>
            <p>${escapeHtml(nextAction)}</p>
          </div>
        </div>
        <div class="rds-command-actions">${actions.join("")}</div>
      </div>
      <div class="rds-command-ask">
        <div class="rds-command-ask-head">
          <span class="rds-command-label">${icon("chat", 14)}<span>Ask RDS about this build</span></span>
          <button type="button" onclick="showTab('chat')" class="rds-command-ask-link">open full chat →</button>
        </div>
        <form id="overview-chat-form" onsubmit="return submitOverviewChat(event)" class="rds-command-ask-form">
          <input id="overview-chat-input" class="rds-command-ask-input" placeholder="Ask, or say what to change…" />
          <button type="submit" class="rds-command-ask-submit">${icon("send", 14)}<span>Ask</span></button>
        </form>
        <div id="overview-chat-status" class="rds-command-ask-status"></div>
      </div>
      ${enginePicker}
      ${livePanel}
      <div class="rds-command-grid">
        <div class="rds-command-panel">
          <div class="rds-command-label">${row.running && !row.stuck && !runnerMissing ? "Current focus" : "Top blockers"}</div>
          ${blockerHtml}
        </div>
        <div class="rds-command-panel">
          <div class="rds-command-label">${row.running ? "Run summary" : "Evidence summary"}</div>
          <div class="rds-command-chips">
            ${activeRunChips.map((chip) => `<span>${escapeHtml(chip)}</span>`).join("")}
          </div>
        </div>
      </div>
    </section>`;
}

function renderTimelineList(timeline: StagePoint[], skillResolution: SkillResolution = { requested: [], resolved: [], skipped: [], installed: [], promptMentions: 0 }): string {
  if (!timeline.length) {
    return `<div class="p-3 text-on-surface-variant font-body text-body italic">No stage events yet.</div>`;
  }
  return `<div class="flex flex-col gap-3 p-3">${timeline.map((s, i) => {
    const isLast = i === timeline.length - 1;
    const dotCls =
      s.status === "done"    ? "bg-primary-container" :
      s.status === "failed"  ? "bg-error shadow-[0_0_8px_rgba(255,180,171,0.5)]" :
      s.status === "running" ? "bg-primary-container shadow-[0_0_8px_rgba(110,219,167,0.5)]" :
                               "bg-outline-variant";
    const labelCls =
      s.status === "running" ? "text-primary" :
      s.status === "failed"  ? "text-error" :
                               "text-on-surface";
    return `
      <div class="flex gap-3">
        <div class="flex flex-col items-center">
          <div class="w-2 h-2 rounded-full ${dotCls}"></div>
          ${isLast ? "" : `<div class="w-[1px] flex-1 bg-outline-variant my-1"></div>`}
        </div>
        <div class="flex-1 flex justify-between items-start pb-2 gap-3">
          <div class="min-w-0">
            <div class="font-table text-table ${labelCls}">${escapeHtml(s.stage)} <span class="font-ribbon text-ribbon text-on-surface-variant">· ${escapeHtml(s.status)}</span></div>
            <div class="font-code text-[10px] text-outline">${formatDuration(s.durationMs)}${s.exitCode != null ? ` · exit ${s.exitCode}` : ""}</div>
            ${s.stage === "skill-resolve" ? renderSkillResolutionInline(skillResolution) : ""}
          </div>
          <div class="font-code text-[11px] text-on-surface-variant shrink-0">${escapeHtml(s.startedAt ?? "-")}</div>
        </div>
      </div>`;
  }).join("")}</div>`;
}

function renderStageSummaryPanel(
  id: string,
  summaries: StageSummary[],
  skillResolution: SkillResolution = { requested: [], resolved: [], skipped: [], installed: [], promptMentions: 0 },
  defaultStageId = ""
): string {
  const cards = summaries.map((s) => {
    const statusCls =
      s.status === "done"    ? "text-primary-container" :
      s.status === "failed"  ? "text-error" :
      s.status === "running" ? "text-primary-container" :
                               "text-on-surface-variant";
    const visible = defaultStageId && s.id === defaultStageId;
    const lines = s.logLines.length
      ? s.logLines.map((line) => `<li class="break-words">${escapeHtml(compactText(line, 220))}</li>`).join("")
      : `<li class="italic text-outline">${s.logExists ? "Log exists but has no useful summary lines yet." : "No durable stage log has been written yet."}</li>`;
    return `
      <section data-stage-summary="${escapeHtml(s.id)}" class="${visible ? "" : "hidden"} bg-surface border border-primary-container/25 rounded-DEFAULT p-3 flex flex-col gap-2">
        <div class="flex items-start justify-between gap-3 flex-wrap">
          <div class="min-w-0">
            <div class="font-h2 text-h2 text-on-surface flex items-center gap-2">${icon(STAGE_ICONS[s.id] ?? "pending", 18, "text-primary-container")}<span>${escapeHtml(s.label)}</span></div>
            <div class="font-ribbon text-ribbon text-on-surface-variant">Selected pipeline step</div>
          </div>
          <div class="flex items-center gap-2 flex-wrap font-code text-[11px]">
            <span class="${statusCls} bg-[#101412] border border-outline-variant rounded px-2 py-1">${escapeHtml(s.status)}</span>
            <span class="text-on-surface-variant bg-[#101412] border border-outline-variant rounded px-2 py-1">${escapeHtml(s.duration)}</span>
            <a href="/b/${escapeHtml(id)}/log/${escapeHtml(s.logName)}" target="_blank" class="text-primary-container hover:underline bg-[#101412] border border-outline-variant rounded px-2 py-1">${escapeHtml(s.logName)}</a>
          </div>
        </div>
        <div class="grid md:grid-cols-2 gap-2 font-code text-[11px] text-on-surface-variant">
          <div>Started: <span class="text-on-surface">${escapeHtml(s.startedAt ?? "-")}</span></div>
          <div>Ended: <span class="text-on-surface">${escapeHtml(s.endedAt ?? "-")}</span></div>
        </div>
        ${s.id === "skill-resolve" ? renderSkillResolutionCard(skillResolution) : ""}
        <details class="rds-stage-log-snippet">
          <summary>${icon("terminal", 13)}<span>Stage log excerpt</span></summary>
          <ul>${lines}</ul>
        </details>
      </section>`;
  }).join("");
  return `<div id="stage-summary-host" data-default-stage="${escapeHtml(defaultStageId)}" class="flex flex-col gap-2">${cards}</div>`;
}

function stageProgressBar(timeline: StagePoint[], currentStage: string | undefined, pausedStage?: string): string {
  const byId = new Map(timeline.map((s) => [s.stage, s]));
  const segs = STAGE_ORDER.map((def, i) => {
    const point = byId.get(def.id);
    const isLast = i === STAGE_ORDER.length - 1;
    const status = pausedStage === def.id ? "paused" : (point?.status ?? (currentStage === def.id ? "running" : "pending"));
    const isActive = status === "running" || (currentStage === def.id && !["done", "failed", "paused"].includes(status));

    let segCls = "opacity-50";
    let iconName = STAGE_ICONS[def.id] ?? "pending";
    let iconCls = "text-outline";
    let labelCls = "text-on-surface-variant";
    let durTextCls = "text-outline";
    let dur = "—";

    if (status === "done") {
      segCls = "bg-surface-variant/20";
      iconName = "check_circle";
      iconCls = "text-primary";
      labelCls = "text-on-surface";
      durTextCls = "text-on-surface-variant";
      dur = point?.durationMs ? formatDuration(point.durationMs) : "done";
    } else if (status === "failed") {
      segCls = "bg-error/10";
      iconName = "error";
      iconCls = "text-error";
      labelCls = "text-error";
      durTextCls = "text-error/80";
      dur = point?.durationMs ? formatDuration(point.durationMs) : "failed";
    } else if (status === "skipped") {
      segCls = "opacity-40";
      iconName = "skip_next";
      iconCls = "text-outline";
      labelCls = "text-on-surface-variant";
      dur = "skipped";
    } else if (status === "paused") {
      segCls = "bg-tertiary-container/10 relative border-b-2 border-b-tertiary-container";
      iconName = "pause_circle";
      iconCls = "text-tertiary-container";
      labelCls = "text-tertiary-container font-bold";
      durTextCls = "text-tertiary-container/80";
      dur = "Paused";
    } else if (status === "pending-review") {
      segCls = "bg-secondary-container/10 relative border-b-2 border-b-secondary";
      iconName = "inbox";
      iconCls = "text-secondary";
      labelCls = "text-secondary font-bold";
      durTextCls = "text-secondary/80";
      dur = "Awaiting you";
    } else if (isActive) {
      segCls = "bg-surface-bright relative border-b-2 border-b-primary";
      iconName = "sync";
      iconCls = "text-primary animate-spin";
      labelCls = "text-primary font-bold";
      durTextCls = "text-primary-fixed-dim";
      dur = point?.startedAt ? `Running · ${relativeTime(new Date(point.startedAt).getTime())}` : "Running";
    }

    return `
      <button type="button" onclick="toggleStageSummary('${escapeHtml(def.id)}')" data-stage-chip="${escapeHtml(def.id)}" class="flex-[1_0_142px] min-w-[142px] flex items-center gap-2 px-3 text-left hover:bg-surface-bright focus:outline-none focus:ring-1 focus:ring-primary-container ${isLast ? "" : "border-r border-outline-variant"} ${segCls}" title="${escapeHtml(def.id)} · ${escapeHtml(status)}">
        <span class="material-symbols-outlined text-[16px] ${iconCls}" ${iconName === "sync" ? `style="animation-duration:3s"` : ""}>${iconName}</span>
        <div class="flex flex-col justify-center min-w-0">
          <span class="font-ribbon text-ribbon ${labelCls} whitespace-nowrap truncate">${escapeHtml(def.label)}</span>
          <span class="font-code text-[10px] ${durTextCls} truncate">${escapeHtml(dur)}</span>
        </div>
      </button>
    `;
  }).join("");

  return `
    <div class="flex w-full min-w-max h-[48px] border border-outline-variant rounded-DEFAULT overflow-hidden bg-surface bg-opacity-50">
      ${segs}
    </div>
  `;
}

function renderScaffoldProgress(progress: ScaffoldProgress, variant: "full" | "compact" = "full", paused = false): string {
  if (!progress.available || !progress.total) {
    return variant === "compact" ? "" : `<div class="hidden"></div>`;
  }
  const statusOf = (task: ScaffoldTask) => String(task.status || "pending").toLowerCase();
  const taskPosition = (task: ScaffoldTask) => Number(task.position ?? task.priority ?? 0);
  const taskLabel = (task: ScaffoldTask) => `Task ${taskPosition(task) + 1}`;
  const taskStatusChip = (status: string) => {
    const normalized = status.toLowerCase();
    const cls =
      normalized === "done" ? "border-primary-container/40 bg-primary-container/10 text-primary-container" :
      normalized === "in_progress" || normalized === "running" ? "border-secondary/40 bg-secondary-container/20 text-secondary" :
      normalized === "failed" || normalized === "errored" || normalized === "blocked" ? "border-error/40 bg-error/10 text-error" :
      "border-outline-variant bg-surface-container text-on-surface-variant";
    const label = normalized === "in_progress" ? "running" : normalized || "pending";
    return `<span class="rounded border ${cls} px-1.5 py-0.5">${escapeHtml(label)}</span>`;
  };
  const currentPos = progress.current?.position ?? progress.current?.priority;
  const currentLabel = progress.current
    ? `${paused ? "Paused at " : ""}Task ${Number(currentPos) + 1} of ${progress.total}: ${progress.current.title || "Untitled task"}`
    : `All ${progress.total} tasks complete`;
  const lastCompleted = progress.lastCompleted
    ? `Last done: ${typeof progress.lastCompleted.position === "number" ? `task ${progress.lastCompleted.position + 1}` : "task"}${progress.lastCompleted.elapsedMs ? ` · ${formatDuration(progress.lastCompleted.elapsedMs)}` : ""}${progress.lastCompleted.failedAttempts ? ` · ${progress.lastCompleted.failedAttempts} failed attempts` : ""}`
    : "No completed task telemetry yet";
  const nextText = progress.next?.length
    ? progress.next.map((t) => `${Number(t.position ?? t.priority ?? 0) + 1}. ${t.title || "Untitled"}`).join(" · ")
    : "";
  const updated = progress.updatedAtMs ? `updated ${relativeTime(progress.updatedAtMs)}` : "updated unknown";
  const runningLabel = paused ? "paused" : "running";
  const currentTextCls = paused ? "text-tertiary-container" : "text-primary-container";
  const taskRows = (progress.tasks || []).map((task) => {
    const status = statusOf(task);
    const active = progress.current && taskPosition(progress.current) === taskPosition(task);
    const rowCls = active ? "border-primary-container/40 bg-primary-container/10" : "border-outline-variant bg-[#070908]";
    const titleCls =
      status === "done" ? "text-primary-container" :
      status === "in_progress" || status === "running" ? "text-secondary" :
      status === "failed" || status === "errored" || status === "blocked" ? "text-error" :
      "text-on-surface-variant";
    return `
      <li class="grid grid-cols-[4rem_5.5rem_minmax(0,1fr)] gap-2 items-start border ${rowCls} rounded px-2 py-1.5">
        <span class="font-code text-[11px] text-outline">${escapeHtml(taskLabel(task))}</span>
        <span class="font-code text-[10px]">${taskStatusChip(status)}</span>
        <span class="font-table text-table ${titleCls} break-words">${escapeHtml(task.title || "Untitled task")}</span>
      </li>`;
  }).join("");
  const bar = `
    <div class="h-2 rounded-full bg-[#242b28] overflow-hidden">
      <div class="h-full bg-primary-container transition-all" style="width:${Math.max(0, Math.min(100, progress.percent))}%"></div>
    </div>`;
  if (variant === "compact") {
    return `
      <div class="bg-surface border border-outline-variant rounded-DEFAULT p-3 flex flex-col gap-2">
        <div class="flex items-center justify-between gap-3">
          <div class="min-w-0">
            <div class="font-h2 text-h2 text-on-surface flex items-center gap-2">${icon("checklist", 18, "text-outline")}<span>Scaffold progress</span></div>
            <div class="font-code text-[11px] ${currentTextCls} truncate">${escapeHtml(currentLabel)}</div>
          </div>
          <div class="font-code text-[18px] ${currentTextCls} shrink-0">${progress.done}/${progress.total}</div>
        </div>
        ${bar}
        <div class="font-ribbon text-ribbon text-on-surface-variant">${progress.percent}% · ${escapeHtml(updated)}</div>
      </div>`;
  }
  return `
    <div class="bg-surface border border-outline-variant rounded-DEFAULT p-3 flex flex-col gap-2">
      <div class="flex items-start justify-between gap-3 flex-wrap">
        <div class="min-w-0 flex-1">
          <div class="font-h2 text-h2 text-on-surface flex items-center gap-2">${icon("checklist", 18, "text-outline")}<span>Scaffold task progress</span></div>
        <div class="font-code text-[12px] ${currentTextCls} break-words">${escapeHtml(currentLabel)}</div>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          <span class="font-code text-[20px] text-primary-container">${progress.done}/${progress.total}</span>
          <span class="font-ribbon text-ribbon text-on-surface-variant">${progress.percent}%</span>
        </div>
      </div>
      ${bar}
      <div class="grid grid-cols-2 md:grid-cols-4 gap-2 font-table text-table">
        <div class="bg-[#101412] rounded px-2 py-1 text-primary-container">done ${progress.done}</div>
        <div class="bg-[#101412] rounded px-2 py-1 text-tertiary-container">${runningLabel} ${progress.running}</div>
        <div class="bg-[#101412] rounded px-2 py-1 text-error">failed ${progress.failed}</div>
        <div class="bg-[#101412] rounded px-2 py-1 text-on-surface-variant">pending ${progress.pending}</div>
      </div>
      <div class="font-ribbon text-ribbon text-on-surface-variant flex flex-col gap-1">
        <div>${escapeHtml(lastCompleted)} · ${escapeHtml(updated)}</div>
        ${nextText ? `<div class="truncate">Next: ${escapeHtml(nextText)}</div>` : ""}
      </div>
      ${taskRows ? `
        <details class="mt-1 border border-outline-variant rounded-DEFAULT bg-surface-container-lowest">
          <summary class="cursor-pointer px-2 py-1.5 font-ribbon text-ribbon text-on-surface-variant hover:text-on-surface flex items-center gap-1">${icon("format_list_bulleted", 14)}<span>Task queue</span><span class="text-outline">· ${progress.done}/${progress.total} done</span></summary>
          <ol class="max-h-[280px] overflow-y-auto custom-scrollbar p-2 flex flex-col gap-1">${taskRows}</ol>
        </details>` : ""}
    </div>`;
}

function tabStrip(tabs: { id: string; label: string; icon?: string; badge?: string }[], active: string): string {
  const items = tabs.map((t) => {
    const isActive = t.id === active;
    const baseCls = "w-full text-left flex items-center gap-2 px-3 py-2 font-ribbon text-ribbon transition-colors";
    const cls = isActive
      ? `${baseCls} bg-surface-bright text-on-surface border-l-2 border-primary-container`
      : `${baseCls} text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface`;
    const ico = t.icon ? icon(t.icon, 16) : "";
    const badge = t.badge ? ` <span class="bg-surface-variant text-on-surface-variant px-1.5 py-0.5 rounded text-[10px] ml-auto">${escapeHtml(t.badge)}</span>` : "";
    return `<button type="button" class="${cls}" data-tab="${escapeHtml(t.id)}" onclick="showTab('${t.id}')">${ico}<span>${escapeHtml(t.label)}</span>${badge}</button>`;
  }).join("");
  return `<nav class="flex flex-col">${items}</nav>`;
}

function activityRail(events: RdsEvent[]): string {
  const slice = events.slice(-30).reverse();
  const items = slice.map((e) => {
    const cls = activityClass(e.event);
    const time = e.ts ? new Date(e.ts) : null;
    const timeText = time ? time.toISOString().slice(11, 19) : "";
    const summary = activitySummary(e);
    const tag = activityTag(e.event);
    return `
      <div class="flex gap-3 hover:bg-[#1b211e] px-1 py-0.5 rounded transition-colors text-on-surface-variant ${cls}">
        <span class="text-[#8b968f] shrink-0 font-code text-[12px]">${escapeHtml(timeText)}</span>
        <span class="${tagColor(tag)} shrink-0 font-code text-[12px]">[${escapeHtml(tag)}]</span>
        <span class="truncate font-code text-[12px]"><span class="text-on-surface">${escapeHtml(e.event)}</span>${summary ? ` · ${escapeHtml(summary)}` : ""}</span>
      </div>`;
  }).join("");
  return `<div id="activity-feed" class="flex-1 max-h-[350px] overflow-y-auto custom-scrollbar pr-1 leading-tight space-y-1">${items || `<div class="text-on-surface-variant text-[12px] italic">No events yet.</div>`}</div>`;
}

function activityTag(event: string): string {
  if (event.startsWith("build_") || event === "watchdog_fired") return "BLD";
  if (event.startsWith("stage_")) return "STG";
  if (event.startsWith("iterate_")) return "ITR";
  if (event.startsWith("stuck") || event === "stuck_detected") return "WDG";
  if (event === "build_approved" || event === "build_rejected" || event === "build_pending_review") return "REV";
  return "SYS";
}

function tagColor(tag: string): string {
  switch (tag) {
    case "BLD": return "text-primary-container";
    case "STG": return "text-secondary";
    case "ITR": return "text-primary-container";
    case "WDG": return "text-tertiary-container";
    case "REV": return "text-tertiary";
    default:    return "text-[#b9c2bc]";
  }
}

function activityClass(event: string): string {
  if (event === "build_started" || event === "stage_started")     return "activity-start";
  if (event === "build_completed" || event === "stage_completed") return "activity-ok";
  if (event === "build_failed" || event === "stage_failed")       return "activity-err";
  if (event === "build_pending_review")                            return "activity-warn";
  if (event.startsWith("iterate_"))                                 return "activity-warn";
  if (event === "build_approved")                                  return "activity-ok";
  if (event === "build_rejected")                                  return "activity-err";
  if (event === "stuck_detected")                                  return "activity-warn";
  return "activity-info";
}

function activitySummary(e: RdsEvent): string {
  const p = e.payload || {};
  const parts: string[] = [];
  if (typeof p["stage"] === "string") parts.push(`stage=${p["stage"]}`);
  if (typeof p["preview_url"] === "string") parts.push(p["preview_url"] as string);
  if (typeof p["mode"] === "string") parts.push(`mode=${p["mode"]}`);
  if (typeof p["stack"] === "string") parts.push(`stack=${p["stack"]}`);
  if (typeof p["provider"] === "string") parts.push(`builder=${p["provider"]}`);
  if (typeof p["exit_code"] !== "undefined") parts.push(`exit=${String(p["exit_code"])}`);
  return parts.join(" · ");
}

function clientScript(): string {
  return `
    function token() {
      var t = localStorage.getItem('rds_token') || '';
      var input = document.getElementById('rds-token');
      if (input && input.value) { t = input.value; localStorage.setItem('rds_token', t); }
      else if (input && t) { input.value = t; }
      return t;
    }
    function rdsSyncProviderFields(form) {
      if (!form) return;
      var provider = (form.provider && form.provider.value) || (form.inferenceProvider && form.inferenceProvider.value) || 'claude';
      Array.prototype.forEach.call(form.querySelectorAll('[data-provider-field]'), function(el) {
        var show = el.getAttribute('data-provider-field') === provider;
        el.hidden = !show;
        el.classList.toggle('hidden', !show);
        Array.prototype.forEach.call(el.querySelectorAll('input, select, textarea'), function(input) {
          input.disabled = !show;
        });
      });
      var help = document.getElementById('provider-help');
      if (help) {
        help.textContent = provider === 'codex'
          ? 'Codex controls implementation, build chat, and fixer. Claude-only spec generation still uses Claude.'
          : 'Claude controls implementation, build chat, and fixer. Codex fields are disabled for this build.';
      }
    }
    function rdsSyncStackChoice(form, value) {
      if (!form || !value) return;
      Array.prototype.forEach.call(form.querySelectorAll('input[name="stack"]'), function(el) {
        el.checked = el.value === value;
      });
      if (form.stack_mobile && form.stack_mobile.value !== value) form.stack_mobile.value = value;
      var checked = form.querySelector('input[name="stack"]:checked');
      var help = document.getElementById('stack-mobile-help');
      if (help && checked && checked.getAttribute('data-stack-help')) {
        help.textContent = checked.getAttribute('data-stack-help');
      }
      rdsFilterSkillPicker(form);
      rdsUpdateNewBuildReadiness(form);
    }
    function rdsSkillMeta(slug) {
      var all = (window.RDS_NEW_BUILD && window.RDS_NEW_BUILD.skills) || [];
      for (var i = 0; i < all.length; i++) if (all[i].slug === slug) return all[i];
      return { slug: slug, name: slug, status: '' };
    }
    function rdsStackMeta(id) {
      var all = (window.RDS_NEW_BUILD && window.RDS_NEW_BUILD.stacks) || [];
      for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
      return null;
    }
    function rdsReadySkillSlugs() {
      return new Set(((window.RDS_NEW_BUILD && window.RDS_NEW_BUILD.skills) || []).filter(function(skill) {
        return skill.status === 'ready';
      }).map(function(skill) { return skill.slug; }));
    }
    function rdsSkillAppliesTo(skill, stack) {
      var applies = (skill && skill.appliesTo) || [];
      return !stack || applies.indexOf('universal') !== -1 || applies.indexOf(stack) !== -1;
    }
    function rdsSkillAppliesToAnyReadyStack(skill) {
      var stacks = (window.RDS_NEW_BUILD && window.RDS_NEW_BUILD.stacks) || [];
      if (!skill) return false;
      for (var i = 0; i < stacks.length; i++) {
        if (rdsSkillAppliesTo(skill, stacks[i].id)) return true;
      }
      return false;
    }
    function rdsSelectedStack(form) {
      if (!form) return '';
      var mobileStack = form.stack_mobile && form.stack_mobile.value;
      var checked = form.querySelector('input[name="stack"]:checked');
      return mobileStack || (checked ? checked.value : '');
    }
    function rdsFilterSkillPicker(form) {
      var stack = rdsSelectedStack(form);
      var q = ((document.getElementById('skill-picker-search') || {}).value || '').toLowerCase().trim();
      var shown = 0;
      Array.prototype.forEach.call(document.querySelectorAll('[data-skill-label]'), function(label) {
        var slug = label.getAttribute('data-skill-slug') || '';
        var skill = rdsSkillMeta(slug);
        var text = (slug + ' ' + (skill.name || '') + ' ' + (skill.description || '') + ' ' + (skill.category || '')).toLowerCase();
        var isCore = ${JSON.stringify(NEW_BUILD_CORE_SKILLS)}.indexOf(slug) !== -1;
        var ok = (isCore || rdsSkillAppliesTo(skill, stack)) && (!q || text.indexOf(q) !== -1);
        label.classList.toggle('hidden', !ok);
        if (!ok) {
          var input = label.querySelector('input[name="skill"]');
          if (input && !isCore) input.checked = false;
        } else {
          shown += 1;
        }
      });
      var help = document.getElementById('rds-skill-help');
      if (help) {
        help.textContent = stack
          ? shown + ' visible skills fit ' + stack + '. Core safety skills remain visible for every build.'
          : 'Choose or analyze a build type to narrow the specialized skills list.';
      }
    }
    function rdsSetRecommendedSkills(form, slugs) {
      if (!form) return;
      var wanted = new Set(slugs || []);
      Array.prototype.forEach.call(form.querySelectorAll('input[name="skill"]'), function(el) {
        el.checked = wanted.has(el.value);
      });
      var list = document.getElementById('rds-rec-skill-list');
      if (list) {
        list.innerHTML = (slugs || []).map(function(slug) {
          var skill = rdsSkillMeta(slug);
          return '<span class="font-code text-[10px] border border-outline-variant rounded px-1.5 py-0.5 text-on-surface-variant" title="' + rdsEscapeHtml(skill.description || '') + '">' + rdsEscapeHtml(skill.name || slug) + '</span>';
        }).join('');
      }
    }
    function rdsPositiveIntentText(value) {
      var lines = String(value || '').split(/\\n/);
      var kept = [];
      var skipping = false;
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (/^(?:#{1,6}\\s*)?(?:\\d+(?:\\.\\d+)?\\s*)?(non[- ]goals?|out of scope|not in scope)\\b/i.test(line.trim())) {
          skipping = true;
          continue;
        }
        if (skipping && /^(?:#{1,6}\\s*)?(?:\\d+(?:\\.\\d+)?\\s*)?[a-z0-9]/i.test(line.trim()) && !/^[-*]/.test(line.trim())) {
          skipping = false;
        }
        if (skipping) continue;
        var marker = line.search(/\\b(non[- ]goals?|out of scope|not in scope)\\b/i);
        if (marker !== -1) {
          var prefix = line.slice(0, marker).trim();
          if (/[a-z]/i.test(prefix)) kept.push(prefix);
          continue;
        }
        if (/\\b(deferred|do not build|do not include|not required|no native)\\b/i.test(line)) continue;
        if (/^\\s*(?:[-*]\\s*)?(?:no|without)\\s+(?:login|auth|authentication|database|backend|payments?|native|wp rest|direct publishing)\\b/i.test(line)) continue;
        line = line.replace(/\\b(?:no|without)\\s+(?:login|auth|authentication|database|backend|payments?|native|wp rest|direct publishing)(?:\\s+or\\s+(?:login|auth|authentication|database|backend|payments?|native|wp rest|direct publishing))*[.;]?/gi, '');
        kept.push(line);
      }
      return kept.join('\\n').toLowerCase();
    }
    function rdsRecommendFromText(form) {
      var text = rdsPositiveIntentText((form && form.trigger && form.trigger.value) || '');
      var appType = (form && form.app_type && form.app_type.value) || 'auto';
      if (!text.trim()) {
        var defaultSkills = ['rds-context7-mount', 'rds-mockup-fidelity', 'rds-secrets-broker'].filter(function(slug) {
          var skill = rdsSkillMeta(slug);
          return rdsSkillAppliesToAnyReadyStack(skill);
        });
        return {
          stack: '',
          confidence: 0,
          skills: defaultSkills,
          questions: ['Paste a PRD, attach a text brief, or add a source path before RDS recommends a stack.']
        };
      }
      var score = {
        'rails-web': 0,
        'nextjs-fullstack': 0,
        'python-ai-service': 0,
        'astro-thin-web': 0,
        'web-3d': 0,
        'game-engine': 0,
        'game-asset-pipeline': 0,
        'mobile-native': 0,
        'browser-extension': 0
      };
      function bump(stack, points) { score[stack] = (score[stack] || 0) + points; }
      function has(re) { return re.test(text); }
      var nonGameProduct = /\\b(dashboard|portfolio|financial|fintech|copilot|trading|brokerage|holdings|alerts?|journal|executor|agent chat|integrations?|read-only|pre-market|briefing|web3|crypto|equities)\\b/;
      var fintechProduct = /\\b(portfolio|financial|fintech|copilot|trading|brokerage|holdings|pre-market|briefing|web3|crypto|equities|read-only)\\b/;
      var gameTerms = /\\b(game|arcade|enemy|sprite|collision|platformer|puzzle game|board game|strategy game|two-player|turn-based|tetris|pong|missile command|missile defense|dig dug|breakout|snake|pac[- ]?man|space invaders|asteroids|chess|checkers)\\b/;
      var weakGameTerms = /\\b(playable|player|score|levels?)\\b/;
      var gameContext = /\\b(game|arcade|sprite|enemy|collision|physics|win condition|lose condition|gameplay)\\b/;
      var gameSignalText = text.replace(/^.*\\b(paper[- ]?trading|gamified|sandbox|calibration|process score|no confetti)\\b.*$/gmi, function(line) {
        return line.replace(/\\b(game|gamified|sandbox|score|scoring|rounds?|predictions?)\\b/gi, ' ');
      });
      var hasGameIntent = gameTerms.test(gameSignalText) || (weakGameTerms.test(gameSignalText) && gameContext.test(gameSignalText));
      if (nonGameProduct.test(text) && !/\\b(playable arcade|browser[- ]playable|player controls?|enemy|sprite|collision|levels?|game over|win condition|lose condition|gameplay loop)\\b/.test(gameSignalText)) {
        hasGameIntent = false;
      }
      if (appType === 'auto' && hasGameIntent) appType = 'game';
      if (appType === 'website') bump('astro-thin-web', 6);
      if (appType === 'web-app' || appType === 'dashboard' || appType === 'internal-tool') { bump('rails-web', 4); bump('nextjs-fullstack', 5); }
      if (appType === 'game') bump('game-engine', 7);
      if (has(/\\b(rails|ruby on rails|hotwire|turbo|stimulus)\\b/)) bump('rails-web', 14);
      if (has(/\\b(next\\.js|nextjs|react server components|app router|vercel)\\b/)) bump('nextjs-fullstack', 14);
      if (has(/\\b(crud|admin|dashboard|workflow|portal|back office|internal tool|database|forms?|approvals?|records?)\\b/)) bump('rails-web', 5);
      if (has(/\\b(saas|react|landing app|auth|payments?|checkout|subscription|customer-facing|frontend|polished ui|component library|file upload|upload|download|copy-to-clipboard|dynamic form|image processing|metadata|vision model)\\b/)) bump('nextjs-fullstack', 8);
      if (fintechProduct.test(text)) bump('nextjs-fullstack', 12);
      if (has(/\\b(api|fastapi|llm|rag|agent|embedding|vector|inference|python|webhook|tool endpoint)\\b/)) bump('python-ai-service', 7);
      if (has(/\\b(marketing site|landing page|docs site|documentation site|static site|portfolio|brochure site)\\b/)) bump('astro-thin-web', 7);
      if (has(/\\b(three\\.js|webgl|3d|r3f|canvas scene|configurator|model viewer|gltf|usd)\\b/)) bump('web-3d', 8);
      if (hasGameIntent || has(/\\b(godot|phaser)\\b/)) bump('game-engine', 8);
      if (has(/\\b(asset pipeline|assets?|fbx|gltf|usd|blender|model validation|texture|mesh)\\b/)) bump('game-asset-pipeline', 8);
      if (has(/\\b(ios app|android app|native mobile|mobile app|react native|expo|eas)\\b/)) bump('mobile-native', 8);
      if (has(/\\b(chrome extension|browser extension|manifest v3|mv3|content script|popup|extension)\\b/)) bump('browser-extension', 9);
      var ranked = Object.keys(score).sort(function(a, b) {
        if (score[b] !== score[a]) return score[b] - score[a];
        return ((window.RDS_NEW_BUILD.stacks || []).findIndex(function(s) { return s.id === a; })) - ((window.RDS_NEW_BUILD.stacks || []).findIndex(function(s) { return s.id === b; }));
      });
      var stack = ranked[0] || 'nextjs-fullstack';
      if ((score[stack] || 0) === 0) stack = 'nextjs-fullstack';
      var confidence = Math.min(95, Math.max(38, 36 + score[stack] * 6));
      var skills = ['rds-context7-mount', 'rds-mockup-fidelity', 'rds-secrets-broker'];
      var stackSkillMap = ${JSON.stringify(stackPrimarySkillMap(NEW_BUILD_STACK_ORDER))};
      skills = skills.concat(stackSkillMap[stack] || []);
      if (has(/\\b(eval|benchmark|test harness|rubric|scorecard|quality gate)\\b/)) skills.push('rds-eval-harness');
      if (has(/\\b(secret|api key|oauth|stripe|token|credential|webhook signing)\\b/)) skills.push('rds-secrets-broker');
      if (has(/\\b(auth|login|account|session|oauth|protected route|sign in|signup|user account)\\b/)) {
        if (stack === 'nextjs-fullstack' || stack === 'astro-thin-web' || stack === 'mobile-native' || stack === 'browser-extension') skills.push('auth-better-auth');
        if (stack === 'rails-web') skills.push('auth-rails-generator');
      }
      if (has(/\\b(stripe|payment|checkout|subscription|billing|invoice|paid plan|customer portal)\\b/)) skills.push('payments-stripe-mcp');
      if (has(/\\b(email|invite|notification|receipt|magic link|resend|transactional)\\b/)) skills.push('email-resend');
      if (has(/\\b(background job|queue|async|scheduled|retry|worker|import|export)\\b/)) skills.push('solid-queue');
      if (has(/\\b(upload|file storage|s3|r2|bucket|media|downloadable|artifact storage)\\b/)) skills.push('storage-s3-r2');
      if (has(/\\b(chat|streaming|tool call|ai sdk|completion|generate|generated|vision[- ]model|llm app)\\b/)) skills.push('llm-vercel-ai-sdk');
      if (has(/\\b(pydantic ai|python agent|structured output|typed extraction)\\b/)) skills.push('llm-pydantic-ai');
      if (has(/\\b(rag|semantic search|embedding|embeddings|vector search|pgvector)\\b/)) skills.push('vector-pgvector');
      if (has(/\\b(database|postgres|schema|migration|crud|records?|admin|dashboard)\\b/)) skills.push('postgres-mcp');
      if (has(/\\b(analytics|events?|funnel|posthog|metrics|activation|retention)\\b/)) skills.push('analytics-posthog');
      if (has(/\\b(sentry|observability|telemetry|tracing|monitoring|errors?|alerts?)\\b/)) skills.push('observability-sentry-otel');
      if (has(/\\b(eas|expo application services|native build|app store|testflight|apk|aab)\\b/)) skills.push('eas-build-skill');
      if (stack === 'web-3d' || stack === 'game-asset-pipeline' || has(/\\b(gltf|usd|3d model|mesh)\\b/)) skills.push('rds-usd-validator');
      var readySlugs = rdsReadySkillSlugs();
      skills = Array.from(new Set(skills)).filter(function(slug) {
        if (!readySlugs.has(slug)) return false;
        if (${JSON.stringify(NEW_BUILD_CORE_SKILLS)}.indexOf(slug) !== -1) return true;
        return rdsSkillAppliesTo(rdsSkillMeta(slug), stack);
      });
      var questions = [];
      if (!text.trim()) {
        questions.push('Paste the PRD first so RDS can ask useful questions.');
      } else {
        if (!has(/\\b(success|acceptance|done|must|requirements?|criteria)\\b/)) questions.push('What are the acceptance criteria for the first working preview?');
        if (!has(/\\b(mockup|figma|screenshot|reference|inspiration|styleguide)\\b/)) questions.push('Is there a mockup, screenshot, or reference product RDS should match?');
        if (has(/\\b(auth|login|account|payment|stripe|email|sms|notion|gmail|calendar|github)\\b/)) questions.push('Which integrations need real credentials now versus placeholders?');
        if (stack === 'mobile-native') questions.push('Should the first pass prioritize mobile UI fidelity or backend functionality?');
        if (stack === 'browser-extension') questions.push('Which pages should the extension run on, and what permissions are acceptable?');
      }
      return { stack: stack, confidence: confidence, skills: skills, questions: questions };
    }
    function rdsHasBuildInput(form) {
      return !!(form && form.trigger && form.trigger.value.trim()) || !!((window.rdsPromptAttachments || []).length);
    }
    function rdsUpdateNewBuildReadiness(form) {
      if (!form) return;
      var hasInput = rdsHasBuildInput(form);
      var hasStack = !!form.querySelector('input[name="stack"]:checked') || !!(form.stack_mobile && form.stack_mobile.value);
      var hasPlan = !!(window.rdsCurrentRecommendation && window.rdsCurrentRecommendation.stack);
      var analyze = document.getElementById('rds-analyze-button');
      var usePlan = document.getElementById('rds-use-plan-button');
      var start = document.getElementById('rds-start-build-button');
      if (analyze) analyze.disabled = !hasInput;
      if (usePlan) usePlan.disabled = !hasPlan;
      if (start) start.disabled = !(hasInput && hasStack);
    }
    function rdsRenderBuildAnalysis(form, rec, apply, force) {
      window.rdsCurrentRecommendation = rec;
      var stack = rdsStackMeta(rec.stack);
      var title = document.getElementById('rds-rec-stack');
      var reason = document.getElementById('rds-rec-reason');
      var conf = document.getElementById('rds-rec-confidence');
      var questions = document.getElementById('rds-rec-questions');
      var result = document.getElementById('new-build-result');
      var analyze = document.getElementById('rds-analyze-button');
      if (title) title.textContent = stack ? stack.label : 'Waiting for PRD';
      if (reason) reason.textContent = stack ? stack.bestFor : 'Paste a PRD, attach a text brief, or add a source path. RDS will not pick a stack until it has input.';
      if (conf) conf.textContent = rec.confidence ? rec.confidence + '% confidence' : 'No recommendation yet';
      if (questions) {
        questions.innerHTML = rec.questions.map(function(q) { return '<li>' + rdsEscapeHtml(q) + '</li>'; }).join('');
      }
      var list = document.getElementById('rds-rec-skill-list');
      if (list) {
        list.innerHTML = rec.skills.map(function(slug) {
          var skill = rdsSkillMeta(slug);
          return '<span class="font-code text-[10px] border border-outline-variant rounded px-1.5 py-0.5 text-on-surface-variant">' + rdsEscapeHtml(skill.name || slug) + '</span>';
        }).join('');
      }
      if (force) {
        if (result) {
          result.textContent = rec.stack
            ? 'Analyzed source. Recommended ' + (stack ? stack.label : rec.stack) + ' with ' + rec.skills.length + ' compatible skill' + (rec.skills.length === 1 ? '' : 's') + '. Click Apply plan or override manually.'
            : 'Add a PRD, text brief, URL, or local path before analysis.';
        }
        if (analyze) {
          analyze.textContent = rec.stack ? 'Analyzed' : 'Analyze source';
          window.setTimeout(function(){ analyze.textContent = 'Analyze source'; }, 1400);
        }
      }
      rdsUpdateNewBuildReadiness(form);
      if (apply) rdsApplyRecommendation(form);
    }
    function rdsAnalyzeBuildInput(form, apply, force) {
      if (!form) return;
      rdsRenderBuildAnalysis(form, rdsRecommendFromText(form), apply, force);
    }
    function rdsMarkPlanStale(form) {
      window.rdsCurrentRecommendation = null;
      var title = document.getElementById('rds-rec-stack');
      var reason = document.getElementById('rds-rec-reason');
      var conf = document.getElementById('rds-rec-confidence');
      var questions = document.getElementById('rds-rec-questions');
      var list = document.getElementById('rds-rec-skill-list');
      if (title) title.textContent = rdsHasBuildInput(form) ? 'Needs analysis' : 'Waiting for PRD';
      if (reason) reason.textContent = rdsHasBuildInput(form)
        ? 'Source changed. Press Analyze source to classify this PRD before applying a plan.'
        : 'Paste a PRD, brief, URL, or local path. RDS will classify the build before you commit.';
      if (conf) conf.textContent = rdsHasBuildInput(form) ? 'Not analyzed yet' : 'No recommendation yet';
      if (questions) {
        questions.innerHTML = '<li>' + (rdsHasBuildInput(form) ? 'Run Analyze source to generate questions from this PRD.' : 'Paste the PRD first so RDS can ask useful questions.') + '</li>';
      }
      if (list) list.innerHTML = '';
      rdsUpdateNewBuildReadiness(form);
    }
    function rdsAttachmentText() {
      var map = window.rdsPromptAttachmentText || {};
      return Object.keys(map).sort().map(function(key) { return map[key]; }).filter(Boolean).join('\\n\\n');
    }
    async function rdsAnalyzeBuildInputRemote(form, apply, force) {
      if (!form) return;
      var result = document.getElementById('new-build-result');
      var analyze = document.getElementById('rds-analyze-button');
      var analyzeLabel = document.getElementById('rds-analyze-label');
      var status = document.getElementById('rds-analysis-status');
      rdsRenderBuildAnalysis(form, rdsRecommendFromText(form), apply, false);
      if (analyze) {
        analyze.disabled = true;
        if (analyzeLabel) analyzeLabel.textContent = 'Analyzing...';
        else analyze.textContent = 'Analyzing...';
      }
      if (status) status.textContent = 'Analyzing source with the shared RDS stack/skill analyzer...';
      if (result) result.textContent = 'Analyzing source with the shared RDS stack/skill analyzer...';
      try {
        var body = new FormData();
        body.set('mode', form.mode ? form.mode.value : 'green');
        body.set('trigger', form.trigger ? form.trigger.value : '');
        body.set('prd', form.prd ? form.prd.value : '');
        body.set('attachment_text', rdsAttachmentText());
        body.set('app_type', form.app_type ? form.app_type.value : 'auto');
        (window.rdsPromptAttachments || []).forEach(function(file) {
          body.append('attachments', file, file.name);
        });
        var res = await fetch('/new/analyze', {
          method: 'POST',
          headers: { 'Accept': 'application/json' },
          body: body
        });
        var data = await res.json().catch(function(){ return {}; });
        if (!res.ok || !data.ok || !data.analysis) throw new Error(data.error || 'analysis failed');
        var analysis = data.analysis;
        rdsRenderBuildAnalysis(form, {
          stack: analysis.stack,
          confidence: analysis.confidence,
          skills: Array.isArray(analysis.skills) ? analysis.skills : [],
          questions: Array.isArray(analysis.questions) ? analysis.questions : []
        }, apply, force);
        if (status) status.textContent = 'Remote analyzer completed';
      } catch (err) {
        rdsRenderBuildAnalysis(form, rdsRecommendFromText(form), apply, force);
        if (status) status.textContent = 'Shared analysis failed; showing local preview recommendation.';
        if (result) result.textContent = 'Shared analysis failed; showing local preview recommendation. Launch still re-analyzes on the server.';
      } finally {
        if (analyze) {
          analyze.disabled = !rdsHasBuildInput(form);
          if (analyzeLabel) analyzeLabel.textContent = 'Analyze source';
          else analyze.textContent = 'Analyze source';
        }
      }
    }
    function rdsApplyRecommendation(form) {
      if (!form) return;
      var rec = window.rdsCurrentRecommendation || rdsRecommendFromText(form);
      if (!rec.stack) {
        rdsAnalyzeBuildInput(form, false, true);
        return;
      }
      rdsSyncStackChoice(form, rec.stack);
      rdsSetRecommendedSkills(form, rec.skills);
      rdsUpdateNewBuildReadiness(form);
    }
    function rdsResetSkills(form) {
      rdsApplyRecommendation(form);
    }
    async function submitNewBuild(ev) {
      ev.preventDefault();
      var f = ev.target;
      rdsSyncProviderFields(f);
      var body = new FormData();
      body.set('mode', f.mode.value);
      var checkedStack = f.querySelector('input[name="stack"]:checked');
      var mobileStack = f.stack_mobile && f.stack_mobile.value;
      var selectedStack = mobileStack || (checkedStack ? checkedStack.value : '');
      if (!rdsHasBuildInput(f)) {
        document.getElementById('new-build-result').textContent = 'Add a PRD, text brief, URL, or local path before starting.';
        return false;
      }
      if (!selectedStack) {
        document.getElementById('new-build-result').textContent = 'Analyze the source or choose a build type before starting.';
        return false;
      }
      body.set('stack', selectedStack);
      var checkedSkills = Array.prototype.slice.call(f.querySelectorAll('input[name="skill"]:checked')).map(function(el) { return el.value; });
      body.set('skills', checkedSkills.length ? checkedSkills.join(',') : 'none');
      body.set('trigger', f.trigger.value);
      body.set('app_dest', f.app_dest.value);
      body.set('deploy_target', f.deploy_target.value);
      body.set('repo', f.repo.value);
      body.set('prd', f.prd.value);
      body.set('branch', f.branch.value);
      body.set('app_type', f.app_type ? f.app_type.value : 'auto');
      var provider = f.provider ? f.provider.value : 'claude';
      body.set('provider', provider);
      if (provider === 'codex') {
        body.set('codex_model', f.codex_model ? f.codex_model.value : '');
      } else {
        body.set('claude_model', f.claude_model ? f.claude_model.value : 'claude-opus-4-6');
      }
      (window.rdsPromptAttachments || []).forEach(function(file) {
        body.append('attachments', file, file.name);
      });
      var res = await fetch('/new', {
        method: 'POST',
        headers: { 'X-RDS-Token': token() },
        body: body
      });
      var text = await res.text();
      document.getElementById('new-build-result').textContent = res.status + ' ' + text;
      try {
        var j = JSON.parse(text);
        if (j.build_id) setTimeout(function(){ location.href = '/b/' + j.build_id; }, 800);
      } catch(_) {}
      return false;
    }
    window.rdsPromptAttachments = window.rdsPromptAttachments || [];
    window.rdsPromptAttachmentText = window.rdsPromptAttachmentText || {};
    window.rdsPromptIgnoredFiles = window.rdsPromptIgnoredFiles || [];
    function rdsFileName(file) {
      return file.webkitRelativePath || file.name || 'attachment';
    }
    function rdsFileKey(file) {
      return [rdsFileName(file), file.size, file.lastModified || 0].join(':');
    }
    function rdsIgnoredFileName(name) {
      return String(name || '').toLowerCase().split(/[\\/]+/).some(function(part) {
        return part === '.ds_store' || part === 'thumbs.db' || part === 'desktop.ini' || part === '__macosx';
      });
    }
    function rdsFileWithRelativeName(file) {
      var name = rdsFileName(file);
      if (!name || name === file.name) return file;
      try {
        return new File([file], name, { type: file.type || 'application/octet-stream', lastModified: file.lastModified || Date.now() });
      } catch (e) {
        return file;
      }
    }
    function rdsFormatBytes(bytes) {
      return bytes >= 1024 * 1024
        ? (bytes / 1024 / 1024).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1) + ' MiB'
        : Math.max(1, Math.round(bytes / 1024)) + ' KiB';
    }
    function rdsEscapeHtml(value) {
      return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function rdsRenderPromptAttachments() {
      var files = window.rdsPromptAttachments || [];
      var meta = document.getElementById('prompt-drop-meta');
      var list = document.getElementById('prompt-attachments');
      var total = files.reduce(function(sum, f) { return sum + f.size; }, 0);
      if (meta) {
        meta.textContent = files.length
          ? 'attach more · ' + files.length + ' file' + (files.length === 1 ? '' : 's') + ' · ' + rdsFormatBytes(total)
          : 'attach files';
      }
      if (!list) return;
      list.classList.toggle('hidden', files.length === 0);
      list.innerHTML = files.map(function(file, idx) {
        return '<span class="inline-flex items-center gap-1 max-w-full bg-[#070908] border border-outline-variant rounded px-2 py-1 font-ribbon text-ribbon text-on-surface-variant">' +
          '<span class="truncate max-w-[220px]" title="' + rdsEscapeHtml(rdsFileName(file)) + '">' + rdsEscapeHtml(rdsFileName(file)) + '</span>' +
          '<span class="text-[#75817a]">' + rdsFormatBytes(file.size) + '</span>' +
          '<button type="button" class="text-on-surface-variant hover:text-error" title="Remove attachment" onclick="rdsRemovePromptAttachment(' + idx + ')">×</button>' +
        '</span>';
      }).join('');
    }
    function rdsRemovePromptAttachment(index) {
      var file = window.rdsPromptAttachments[index];
      if (file) delete window.rdsPromptAttachmentText[rdsFileKey(file)];
      window.rdsPromptAttachments.splice(index, 1);
      rdsRenderPromptAttachments();
      rdsMarkPlanStale(document.getElementById('new-build'));
    }
    function rdsHandlePromptFiles(files) {
      if (!files || !files.length) return;
      var existing = new Set((window.rdsPromptAttachments || []).map(rdsFileKey));
      var ignoredCount = 0;
      Array.prototype.forEach.call(files, function(rawFile) {
        var name = rawFile.webkitRelativePath || rawFile.name;
        if (rdsIgnoredFileName(name)) { ignoredCount += 1; return; }
        var file = rdsFileWithRelativeName(rawFile);
        var key = rdsFileKey(file);
        if (!existing.has(key)) {
          window.rdsPromptAttachments.push(file);
          existing.add(key);
        }
      });
      window.rdsPromptIgnoredFiles = (window.rdsPromptIgnoredFiles || []).concat(new Array(ignoredCount).fill('system'));
      rdsRenderPromptAttachments();
      var textFiles = (window.rdsPromptAttachments || []).filter(function(file) {
        return /\\.(md|markdown|txt)$/i.test(file.name) || /^text\\//.test(file.type || '');
      });
      var ta = document.getElementById('trigger-textarea');
      textFiles.forEach(function(file) {
        var key = rdsFileKey(file);
        if (window.rdsPromptAttachmentText[key]) return;
        var reader = new FileReader();
        reader.onload = function (e) {
          var text = String(e.target.result || '');
          window.rdsPromptAttachmentText[key] = text;
          if (ta) {
            var textAttachmentCount = Object.keys(window.rdsPromptAttachmentText || {}).length;
            if (!ta.value.trim() && textFiles.length === 1 && textAttachmentCount === 1) {
              ta.value = text;
            }
            rdsAnalyzeBuildInput(ta.form, false, false);
          }
        };
        reader.readAsText(file);
      });
      var note = document.getElementById('prompt-ingest-note');
      if (note) {
        var imported = textFiles.length ? textFiles.length + ' text file' + (textFiles.length === 1 ? '' : 's') + ' imported for analysis' : '';
        var uploadedOnly = (window.rdsPromptAttachments || []).filter(function(file) { return !(/\\.(md|markdown|txt)$/i.test(file.name) || /^text\\//.test(file.type || '')); }).length;
        var pieces = [];
        if (imported) pieces.push(imported);
        if (uploadedOnly) pieces.push(uploadedOnly + ' source asset' + (uploadedOnly === 1 ? '' : 's') + ' will be sent with the build');
        var ignoredTotal = (window.rdsPromptIgnoredFiles || []).length;
        if (ignoredTotal) pieces.push(ignoredTotal + ' system file' + (ignoredTotal === 1 ? '' : 's') + ' ignored');
        note.textContent = pieces.join(' · ');
        note.classList.toggle('hidden', pieces.length === 0);
      }
      rdsUpdateNewBuildReadiness(document.getElementById('new-build'));
      if (textFiles.length === 0) {
        rdsMarkPlanStale(document.getElementById('new-build'));
      }
    }
    window.rdsRemovePromptAttachment = rdsRemovePromptAttachment;
    (function wirePromptDropzone() {
      var dz = document.getElementById('prompt-drop');
      var input = document.getElementById('prompt-file');
      var folderInput = document.getElementById('prompt-folder');
      if (!dz || !input) return;
      input.addEventListener('change', function () {
        if (input.files && input.files[0]) rdsHandlePromptFiles(input.files);
      });
      if (folderInput) {
        folderInput.addEventListener('change', function () {
          if (folderInput.files && folderInput.files[0]) rdsHandlePromptFiles(folderInput.files);
        });
      }
      ['dragenter', 'dragover'].forEach(function (evt) {
        dz.addEventListener(evt, function (e) {
          e.preventDefault(); e.stopPropagation(); dz.classList.add('dropzone-hot');
        });
      });
      ['dragleave', 'drop'].forEach(function (evt) {
        dz.addEventListener(evt, function (e) {
          e.preventDefault(); e.stopPropagation(); dz.classList.remove('dropzone-hot');
        });
      });
      dz.addEventListener('drop', function (e) {
        var dt = e.dataTransfer;
        if (dt && dt.files && dt.files[0]) {
          try { input.files = dt.files; } catch (_) {}
          rdsHandlePromptFiles(dt.files);
        }
      });
    })();
    async function toggleWatchdog() {
      var btn = document.getElementById('watchdog-toggle');
      var on = btn && btn.getAttribute('data-running') === '1';
      var runningBuilds = btn ? parseInt(btn.getAttribute('data-running-builds') || '0', 10) : 0;
      if (on) {
        var msg = runningBuilds > 0
          ? 'Stop the watchdog while ' + runningBuilds + ' build' + (runningBuilds === 1 ? ' is' : 's are') + ' running? You will no longer be paged via Telegram if a build gets stuck.'
          : 'Stop the watchdog? Stuck builds will no longer auto-page Telegram.';
        var ok = await rdsConfirm(msg, { title: 'Stop watchdog?', warn: runningBuilds > 0, okLabel: 'Stop watchdog' });
        if (!ok) return;
      }
      var action = on ? 'stop' : 'start';
      if (btn) { btn.disabled = true; btn.style.opacity = '0.5'; }
      try {
        var res = await fetch('/watchdog', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-RDS-Token': token() },
          body: JSON.stringify({ action: action })
        });
        var text = await res.text();
        if (!res.ok) { rdsToast('watchdog ' + action + ' failed: ' + res.status + ' ' + text, 'error'); return; }
      } finally {
        if (btn) { btn.disabled = false; btn.style.opacity = ''; }
      }
      location.reload();
    }
    window.toggleWatchdog = toggleWatchdog;
  `;
}

function detailScript(initialRunning: boolean): string {
  return `
    var id  = window.RDS_BUILD_ID;
    var pre = document.getElementById('events');

    // ---- connection pill helpers (header) -------------------------------------
    // EventSource fires 'error' transiently while it auto-reconnects (readyState
    // flips to CONNECTING, usually < 3s). Flipping the pill to red on every
    // blip looks like the stream is permanently broken even though it isn't,
    // so we debounce 'off' transitions and cancel them if 'on' arrives first.
    var connTimers = {};
    function setConn(elId, state) {
      var el = document.getElementById(elId);
      if (!el) return;
      if (connTimers[elId]) { clearTimeout(connTimers[elId]); connTimers[elId] = null; }
      if (state === 'on') {
        el.classList.remove('conn-off');
        el.classList.add('conn-on');
        return;
      }
      // Defer the visual "off" by 3.5s so brief reconnect blips don't flash.
      connTimers[elId] = setTimeout(function () {
        el.classList.remove('conn-on');
        el.classList.add('conn-off');
        connTimers[elId] = null;
      }, 3500);
    }

    // ---- tab switching --------------------------------------------------------
    function showTab(name) {
      var panes = document.querySelectorAll('[data-pane]');
      for (var i = 0; i < panes.length; i++) panes[i].classList.add('hidden');
      var pane = document.querySelector('[data-pane="' + name + '"]');
      if (pane) pane.classList.remove('hidden');
      var tabs = document.querySelectorAll('[data-tab]');
      for (var j = 0; j < tabs.length; j++) {
        var t = tabs[j];
        t.classList.remove('bg-surface-bright','text-on-surface','border-l-2','border-primary-container');
        t.classList.add('text-on-surface-variant');
      }
      var btn = document.querySelector('[data-tab="' + name + '"]');
      if (btn) {
        btn.classList.add('bg-surface-bright','text-on-surface','border-l-2','border-primary-container');
        btn.classList.remove('text-on-surface-variant');
      }
      try { history.replaceState(null, '', '#' + name); } catch (e) {}
      if (name === 'files' && !window.__filesLoaded) loadFiles();
      if (name === 'diff'  && !window.__diffLoaded)  loadDiff();
      // When switching to Live Log, jump to the latest output. (The pane was
      // hidden so any in-flight scrollTop writes during streaming were no-ops.)
      if (name === 'live-log') {
        var l = document.getElementById('log');
        if (l) requestAnimationFrame(function () { l.scrollTop = l.scrollHeight; });
      }
      if (name === 'overview') {
        var ov = document.getElementById('overview-log');
        if (ov) requestAnimationFrame(function () { ov.scrollTop = ov.scrollHeight; });
      }
      // Chat tab: jump to the latest message. While the pane was hidden,
      // scrollTop writes inside chat render were no-ops (clientHeight=0).
      if (name === 'chat') {
        var clog = document.getElementById('chat-log');
        if (clog) requestAnimationFrame(function () { clog.scrollTop = clog.scrollHeight; });
      }
    }
    window.showTab = showTab;
    // Restore tab from hash on first paint.
    (function () {
      var h = (location.hash || '').replace(/^#/, '');
      if (h && document.getElementById('tab-' + h)) showTab(h);
    })();

    function buildAlertStorageKey(key) {
      return 'rds_build_alert_dismissed_' + id + '_' + key;
    }
    function applyDismissedBuildAlerts() {
      document.querySelectorAll('[data-dismissible-alert]').forEach(function (el) {
        var key = el.getAttribute('data-dismissible-alert') || '';
        try {
          if (key && localStorage.getItem(buildAlertStorageKey(key)) === '1') el.classList.add('hidden');
        } catch (e) {}
      });
    }
    function dismissBuildAlert(key) {
      try { localStorage.setItem(buildAlertStorageKey(key), '1'); } catch (e) {}
      var el = document.querySelector('[data-dismissible-alert="' + key.replace(/"/g, '\\"') + '"]');
      if (el) el.classList.add('hidden');
    }
    window.dismissBuildAlert = dismissBuildAlert;
    applyDismissedBuildAlerts();

    function renderBuildBrief(data) {
      var brief = data && data.brief ? data.brief : data;
      if (!brief) return;
      var title = document.getElementById('build-brief-title');
      var summary = document.getElementById('build-brief-summary');
      var points = document.getElementById('build-brief-points');
      var badge = document.getElementById('build-brief-badge');
      var error = document.getElementById('build-brief-error');
      if (title) title.textContent = brief.title || 'Build brief';
      if (summary) summary.textContent = brief.summary || '';
      if (points) {
        points.innerHTML = (brief.key_points || []).slice(0, 5).map(function (p) {
          return '<li class="flex gap-2 min-w-0"><span class="text-outline shrink-0">•</span><span class="break-words">' + escapeText(p) + '</span></li>';
        }).join('');
      }
      if (badge) {
        var label = brief.status === 'ready' ? 'AI brief' : brief.status === 'running' ? 'generating' : brief.status === 'failed' ? 'AI failed' : 'spec fallback';
        badge.textContent = label;
        badge.classList.remove('text-error', 'text-tertiary-container', 'text-primary-container');
        badge.classList.add(brief.status === 'failed' ? 'text-error' : brief.status === 'running' ? 'text-tertiary-container' : 'text-primary-container');
      }
      if (error) {
        error.textContent = brief.error || '';
        error.classList.toggle('hidden', !brief.error);
      }
    }
    async function pollBuildBrief(remaining) {
      try {
        var res = await fetch('/b/' + encodeURIComponent(id) + '/build-summary.json');
        if (!res.ok) return;
        var data = await res.json();
        renderBuildBrief(data);
        var status = data && data.brief && data.brief.status;
        if (status === 'running' && remaining > 0) setTimeout(function () { pollBuildBrief(remaining - 1); }, 2000);
      } catch (e) {}
    }
    async function refreshBuildBrief() {
      renderBuildBrief({ status: 'running', title: document.getElementById('build-brief-title')?.textContent || 'Build brief', summary: 'Generating AI brief…', key_points: [] });
      try {
        var res = await fetch('/b/' + encodeURIComponent(id) + '/build-summary', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-RDS-Token': token() }
        });
        if (!res.ok) {
          rdsToast('AI brief failed to start: ' + res.status, 'error');
          pollBuildBrief(1);
          return;
        }
        rdsToast('AI brief generation started.', 'info');
        setTimeout(function () { pollBuildBrief(30); }, 1000);
      } catch (e) {
        rdsToast('AI brief failed to start: ' + e, 'error');
      }
    }
    window.refreshBuildBrief = refreshBuildBrief;

    var stageSummaryHost = document.getElementById('stage-summary-host');
    var openStageSummary = stageSummaryHost ? stageSummaryHost.getAttribute('data-default-stage') : null;
    function applyStageSummaryVisibility(stageId) {
      document.querySelectorAll('[data-stage-summary]').forEach(function (panel) {
        var active = panel.getAttribute('data-stage-summary') === stageId;
        panel.classList.toggle('hidden', !active);
      });
      document.querySelectorAll('[data-stage-chip]').forEach(function (chip) {
        var active = chip.getAttribute('data-stage-chip') === stageId;
        chip.classList.toggle('ring-1', active);
        chip.classList.toggle('ring-primary-container', active);
        chip.classList.toggle('bg-surface-bright', active);
      });
    }
    function toggleStageSummary(stageId) {
      openStageSummary = openStageSummary === stageId ? null : stageId;
      applyStageSummaryVisibility(openStageSummary);
      if (openStageSummary) {
        var host = document.getElementById('stage-summary-host');
        if (host) host.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }
    window.toggleStageSummary = toggleStageSummary;
    if (openStageSummary) applyStageSummaryVisibility(openStageSummary);

    // ---- SSE: events.jsonl ----------------------------------------------------
    var ev  = new EventSource('/b/' + encodeURIComponent(id) + '/stream');
    ev.addEventListener('open',  function () { setConn('conn-sse', 'on');  });
    ev.addEventListener('error', function () { setConn('conn-sse', 'off'); });
    function setFixerButtonsRunning(running) {
      var btns = document.querySelectorAll('.js-spawn-fixer');
      btns.forEach(function (b) {
        b.disabled = !!running;
        // Replace label text without losing icon/structure: any node with
        // text content matching either label gets swapped.
        var labels = b.querySelectorAll('span');
        var changed = false;
        labels.forEach(function (s) {
          if (s.children.length) return; // skip wrappers, only leaf labels
          var t = (s.textContent || '').trim();
          if (running && t === 'Spawn fixer') { s.textContent = 'Fixer running…'; changed = true; }
          else if (!running && t === 'Fixer running…') { s.textContent = 'Spawn fixer'; changed = true; }
        });
        if (!changed) {
          // Buttons rendered without an inner span (banner buttons) — set textContent directly.
          var t2 = (b.textContent || '').trim();
          if (running && t2 === 'Spawn fixer') b.textContent = 'Fixer running…';
          else if (!running && t2 === 'Fixer running…') b.textContent = 'Spawn fixer';
        }
      });
    }
    var seenEventKeys = new Set();
    var pageOpenedAt = Date.now();
    var timelineRefetchPending = false;
    var buildStillRunning = ${JSON.stringify(initialRunning)};
    var lastTimelineRefreshAt = 0;
    var STAGE_ACRONYMS = { qa: 1, uat: 1, ai: 1, ui: 1, ux: 1, api: 1, url: 1, prd: 1, rds: 1, css: 1, html: 1, js: 1, ts: 1, io: 1, id: 1, db: 1, seo: 1, ci: 1, cd: 1 };
    function formatStageLabel(raw) {
      var text = String(raw || '').trim();
      if (!text) return '-';
      return text.replace(/[-_]+/g, ' ').split(' ').map(function (word) {
        if (!word) return word;
        var low = word.toLowerCase();
        if (STAGE_ACRONYMS[low]) return low.toUpperCase();
        return word.charAt(0).toUpperCase() + word.slice(1);
      }).join(' ');
    }
    function refetchTimeline() {
      if (timelineRefetchPending) return;
      timelineRefetchPending = true;
      // Tiny coalescing delay so a stage_started+stage_completed pair
      // emitted in the same tick collapses into one fetch.
      setTimeout(function () {
        timelineRefetchPending = false;
        fetch('/b/' + encodeURIComponent(id) + '/timeline.html')
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (data) {
            if (!data) return;
            lastTimelineRefreshAt = Date.now();
            buildStillRunning = !!data.running;
            var bar = document.getElementById('stage-bar-host');
            if (bar && data.stageBar) bar.innerHTML = data.stageBar;
            var summaryHost = document.getElementById('stage-summary-host');
            if (summaryHost && data.stageSummaries) {
              summaryHost.outerHTML = data.stageSummaries;
              applyStageSummaryVisibility(openStageSummary);
            }
            var list = document.getElementById('stage-timeline-host');
            if (list && data.list) list.innerHTML = data.list;
            var label = document.getElementById('header-stage-label');
            if (label && data.currentStage) label.textContent = formatStageLabel(data.currentStage);
            if (data.currentStage) {
              document.querySelectorAll('[data-live-stage-label]').forEach(function (el) {
                el.textContent = formatStageLabel(data.currentStage);
              });
            }
            if (data.previewUrl) updateDeployBanner(data.previewUrl);
            if (!data.running && (data.status === 'done' || data.status === 'failed' || data.reviewStatus === 'pending')) {
              setTimeout(function () { location.reload(); }, 900);
            }
          })
          .catch(function () {});
      }, 250);
    }
    function refetchScaffoldProgress() {
      fetch('/b/' + encodeURIComponent(id) + '/scaffold-progress.json')
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (data) {
          if (!data || !data.available) return;
          var host = document.getElementById('scaffold-progress-host');
          if (host) host.innerHTML = data.html || '';
        })
        .catch(function () {});
    }
    setInterval(refetchScaffoldProgress, 15000);
    function reconcileRunningBuild() {
      if (!buildStillRunning) return;
      refetchTimeline();
      refetchScaffoldProgress();
    }
    setInterval(reconcileRunningBuild, 5000);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') reconcileRunningBuild();
    });
    window.addEventListener('focus', reconcileRunningBuild);
    function updateDeployBanner(url) {
      if (!url) return;
      var link = document.getElementById('deploy-url-link');
      if (link && link.getAttribute('href') === url) return;
      // Convert the placeholder banner into a live-preview banner.
      var banner = document.getElementById('deploy-banner');
      if (!banner) return;
      var html =
        '<span class="material-symbols-outlined text-[18px] text-primary-container shrink-0">rocket_launch</span>' +
        '<div class="flex-1 min-w-0 font-body text-body">' +
          '<div class="font-bold text-primary-container mb-0.5">Live preview</div>' +
          '<div class="text-on-surface-variant break-all">Deployed at <a id="deploy-url-link" href="' + url + '" target="_blank" class="font-code text-code text-primary-container hover:underline">' + url + '</a></div>' +
        '</div>' +
        '<div class="flex gap-2 shrink-0">' +
          '<a href="' + url + '" target="_blank" class="px-3 py-1.5 bg-primary-container hover:bg-surface-tint text-on-primary-container rounded-DEFAULT font-ribbon text-ribbon font-bold transition-colors flex items-center gap-1"><span class="material-symbols-outlined text-[14px]">open_in_new</span><span>Open</span></a>' +
          '<button type="button" data-deploy-copy="1" class="px-3 py-1.5 border border-outline-variant bg-surface hover:bg-surface-bright text-on-surface rounded-DEFAULT font-ribbon text-ribbon transition-colors flex items-center gap-1"><span class="material-symbols-outlined text-[14px]">content_copy</span><span>Copy</span></button>' +
        '</div>';
      banner.className = 'bg-primary-container/10 border border-primary-container/40 rounded-DEFAULT p-3 flex items-center gap-3 flex-wrap';
      banner.innerHTML = html;
      var copyBtn = banner.querySelector('[data-deploy-copy]');
      if (copyBtn) copyBtn.addEventListener('click', function () {
        navigator.clipboard.writeText(url).then(function(){ rdsToast('URL copied.','info'); });
      });
      rdsToast('Deploy live: ' + url, 'info');
    }

    // Live URL health probe: trust nothing — verify the public URL actually answers.
    function probeLiveHealth() {
      var banner = document.getElementById('deploy-banner');
      if (!banner) return;
      var link = document.getElementById('deploy-url-link');
      if (!link) return;
      fetch('/b/' + encodeURIComponent(id) + '/live-health.json', { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (data) {
          if (!data) return;
          var dot = banner.querySelector('[data-live-health-dot]');
          if (!dot) {
            dot = document.createElement('span');
            dot.setAttribute('data-live-health-dot', '1');
            dot.style.display = 'inline-block';
            dot.style.width = '8px';
            dot.style.height = '8px';
            dot.style.borderRadius = '50%';
            dot.style.marginRight = '6px';
            dot.style.verticalAlign = 'middle';
            var head = banner.querySelector('.font-bold');
            if (head) head.insertBefore(dot, head.firstChild);
          }
          dot.style.background = data.ok ? 'var(--md-sys-color-primary-container, #34d399)' : '#ef4444';
          dot.title = data.ok ? ('Live (HTTP ' + data.status + ')') : ('Unreachable (HTTP ' + data.status + ')');
          var note = banner.querySelector('[data-live-health-note]');
          if (!data.ok) {
            if (!note) {
              note = document.createElement('div');
              note.setAttribute('data-live-health-note', '1');
              note.className = 'text-error text-ribbon mt-1';
              var col = banner.querySelector('.flex-1');
              if (col) col.appendChild(note);
            }
            note.textContent = 'Service unreachable right now (HTTP ' + data.status + '). The recorded URL may be stale or the underlying process crashed.';
          } else if (note) {
            note.remove();
          }
        })
        .catch(function () { /* ignore — banner stays neutral */ });
    }
    probeLiveHealth();
    setInterval(probeLiveHealth, 30000);

    ev.onmessage = function(e) {
      pre.textContent += '\\n' + e.data;
      pre.scrollTop = pre.scrollHeight;
      // Mirror into the activity rail (newest first).
      try {
        var parsed = JSON.parse(e.data);
        var key = (parsed && parsed.ts ? parsed.ts : '') + '|' + (parsed && parsed.event ? parsed.event : '');
        if (seenEventKeys.has(key)) return;
        seenEventKeys.add(key);
        if (seenEventKeys.size > 500) {
          // Trim oldest by rebuilding to last 250.
          var arr = Array.from(seenEventKeys).slice(-250);
          seenEventKeys = new Set(arr);
        }
        prependActivity(parsed);
        if (parsed && (parsed.event === 'fixer_started' || parsed.event === 'fixer_apply_started')) {
          setFixerButtonsRunning(true);
        }
        if (parsed && (parsed.event === 'fixer_completed' || parsed.event === 'fixer_apply_completed')) {
          setFixerButtonsRunning(false);
          // Only toast if event actually happened during this page session;
          // ignore replays of pre-load events (which would otherwise
          // toast-spam on reconnect).
          var evTime = +new Date(parsed.ts || 0);
          if (evTime && evTime >= pageOpenedAt) {
            var msg = parsed.event === 'fixer_apply_completed' ? 'Fix applied.' : 'Fixer diagnosis complete.';
            rdsToast(msg, 'info');
          }
        }
        var name = parsed && parsed.event ? parsed.event : '';
        if (name === 'stage_started' || name === 'stage_completed' || name === 'stage_failed' || name === 'build_completed' || name === 'build_failed' || name === 'build_resumed' || name === 'build_pending_review' || name === 'build_approved' || name === 'build_rejected') {
          refetchTimeline();
        }
        if (name === 'stage_started' || name === 'stage_completed' || name === 'stage_failed' || name === 'build_completed' || name === 'build_failed' || name === 'build_resumed' || name === 'build_pending_review' || name === 'build_approved' || name === 'build_rejected' || name === 'task_started' || name === 'task_completed' || name === 'task_failed') {
          refetchScaffoldProgress();
        }
        if (name === 'build_pending_review' || name === 'build_completed' || name === 'build_failed' || name === 'build_approved' || name === 'build_rejected') {
          setTimeout(function () { location.reload(); }, 900);
        }
      } catch (err) {}
    };

    // Live countdown for "Watchdog will auto-spawn a fixer in …".
    (function () {
      var hint = document.querySelector('[data-autofix-due]');
      if (!hint) return;
      var due = Number(hint.getAttribute('data-autofix-due') || 0);
      var span = hint.querySelector('.js-autofix-countdown');
      if (!due || !span) return;
      function tick() {
        var ms = due - Date.now();
        if (ms <= 0) { span.textContent = 'any moment'; return; }
        var s = Math.floor(ms / 1000);
        var m = Math.floor(s / 60);
        s = s % 60;
        span.textContent = (m > 0 ? m + 'm ' : '') + s + 's';
      }
      tick();
      setInterval(tick, 1000);
    })();

    // ---- SSE: live terminal log ----------------------------------------------
    var logEl = document.getElementById('log');
    var logEmpty = document.getElementById('log-empty');
    var logState = document.getElementById('log-state');
    var logSource = document.getElementById('live-log-source');
    var mobileLogStatus = document.getElementById('mobile-log-status');
    var ovLogEl = document.getElementById('overview-log');
    var ovLogEmpty = document.getElementById('overview-log-empty');
    var ovLogState = document.getElementById('ovlog-state');
    var ovLogCount = document.getElementById('ovlog-count');
    var ovLogPanel = document.getElementById('overview-log-panel');
    // ---- live terminal controls (filters / wrap / follow / copy / clear) -----
    window.__ovFollow = true;
    function ovSetFilter(kind, btn) {
      if (ovLogPanel) ovLogPanel.setAttribute('data-filter', kind || 'all');
      var chips = document.querySelectorAll('[data-ovfilter]');
      for (var i = 0; i < chips.length; i++) {
        chips[i].classList.toggle('is-active', chips[i].getAttribute('data-ovfilter') === (kind || 'all'));
      }
    }
    function ovToggleWrap(btn) {
      if (!ovLogEl) return;
      var nowrap = ovLogEl.classList.toggle('rds-log-nowrap');
      if (btn) btn.classList.toggle('is-active', nowrap);
    }
    function ovToggleFollow(btn) {
      window.__ovFollow = !window.__ovFollow;
      if (btn) btn.classList.toggle('is-active', !!window.__ovFollow);
      if (window.__ovFollow && ovLogEl) ovLogEl.scrollTop = ovLogEl.scrollHeight;
    }
    function ovClearLog() {
      if (ovLogEl) ovLogEl.innerHTML = '';
      if (ovLogCount) ovLogCount.textContent = '0 lines';
      if (ovLogEmpty) ovLogEmpty.classList.remove('hidden');
    }
    function ovCopyLog(btn) {
      if (!ovLogEl) return;
      var txt = ovLogEl.innerText || ovLogEl.textContent || '';
      var done = function () {
        if (!btn) return;
        var label = btn.querySelector('span');
        if (!label) return;
        var prev = label.textContent;
        label.textContent = 'Copied';
        btn.classList.add('is-active');
        setTimeout(function () { label.textContent = prev; btn.classList.remove('is-active'); }, 1200);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt).then(done, function () {});
      } else {
        try {
          var ta = document.createElement('textarea');
          ta.value = txt; document.body.appendChild(ta); ta.select();
          document.execCommand('copy'); document.body.removeChild(ta); done();
        } catch (e) {}
      }
    }
    window.ovSetFilter = ovSetFilter;
    window.ovToggleWrap = ovToggleWrap;
    window.ovToggleFollow = ovToggleFollow;
    window.ovClearLog = ovClearLog;
    window.ovCopyLog = ovCopyLog;
    // Turn Follow on/off automatically as the user scrolls away from / back to
    // the tail, and reflect that on the Follow button.
    if (ovLogEl) {
      ovLogEl.addEventListener('scroll', function () {
        var atBottom = (ovLogEl.scrollHeight - ovLogEl.scrollTop - ovLogEl.clientHeight) < 80;
        if (window.__ovFollow !== atBottom) {
          window.__ovFollow = atBottom;
          var fb = document.querySelector('[data-tool="follow"]');
          if (fb) fb.classList.toggle('is-active', atBottom);
        }
      }, { passive: true });
    }
    var logStateTimer = null;
    function paintLogState(label, color) {
      if (logState) logState.innerHTML = '<span class="w-1.5 h-1.5 rounded-full ' + color + '"></span>' + label;
      if (ovLogState) ovLogState.innerHTML = '<span class="w-1.5 h-1.5 rounded-full ' + color + '"></span>' + label;
      if (mobileLogStatus) mobileLogStatus.textContent = label;
    }
    function setLogState(label, color) {
      if (logStateTimer) { clearTimeout(logStateTimer); logStateTimer = null; }
      // Match conn-pill behaviour: only paint "disconnected" if the
      // disconnect lasts beyond the auto-reconnect window.
      if (label === 'disconnected') {
        logStateTimer = setTimeout(function () {
          paintLogState(label, color);
          logStateTimer = null;
        }, 3500);
        return;
      }
      paintLogState(label, color);
    }
    var ansi  = (window.AnsiUp ? new AnsiUp() : null);
    if (ansi) { ansi.use_classes = true; ansi.escape_html = true; }
    function logLineClass(line) {
      if (/^\\s*━━\\s+tailing\\s+/.test(line)) return 'rds-log-line log-source';
      if (/\\b(FATAL|ERROR|failed|abort|exception|traceback)\\b/i.test(line)) return 'rds-log-line log-error';
      if (/\\b(WARN|warning|retry|skipped|blocked|needs review)\\b/i.test(line)) return 'rds-log-line log-warn';
      if (/\\b(PASS|ok|success|done|complete|passed|healthy|ready|verified)\\b/i.test(line)) return 'rds-log-line log-ok';
      if (/^\\s*(OpenAI Codex|Claude|user|assistant|system|exec|tokens used)\\b/i.test(line)) return 'rds-log-line log-agent';
      if (/\\b(stage \\d+|Task \\d+|Tasks \\(|NEXT:|rds-build|rds-spec|rds-intake|rds-iterate|rds-deploy|Scaffold)\\b/i.test(line)) return 'rds-log-line log-stage';
      if (/^\\s*(?:[\\w.-]+\\/)+[\\w.@+:[\\]-]+\\.[a-z0-9]+\\s*$/i.test(line)) return 'rds-log-line log-file';
      if (/^\\s*[{}\\[\\],]|^\\s*"[^"]+"\\s*:/.test(line)) return 'rds-log-line log-json';
      return 'rds-log-line';
    }
    function highlightPlainLogLine(line) {
      var html = escHtml(line);
      html = html.replace(/(^|\\s)((?:[\\w.-]+\\/)+[\\w.@+:[\\]-]+\\.[a-z0-9]+)/gi, '$1<span class="log-path">$2</span>');
      html = html.replace(/\\b(PASS|FAIL|SKIP|NEXT|RUNNING|DONE|ERROR)\\b/g, '<span class="log-token log-token-$1">$1</span>');
      html = html.replace(/(&quot;[^&]*?&quot;)(\\s*:)/g, '<span class="log-json-key">$1</span>$2');
      html = html.replace(/:\\s*(&quot;[^&]*?&quot;)/g, ': <span class="log-json-string">$1</span>');
      html = html.replace(/\\b(\\d+(?:\\.\\d+)?)(ms|s|m|%| KiB| MiB)?\\b/g, '<span class="log-number">$1$2</span>');
      return html;
    }
    function parseLogLine(line) {
      var m = line.match(/(?:^|\\s)(\\d{4}-\\d{2}-\\d{2})[T\\s](\\d{2}:\\d{2}:\\d{2})(?:\\.\\d+)?Z?/) ||
              line.match(/^\\[?(\\d{2}:\\d{2}:\\d{2})\\]?/);
      var stamp = m ? (m[2] || m[1]) : new Date().toLocaleTimeString('en-US', { hour12: false });
      var content = line
        .replace(/^\\s*\\[?\\d{2}:\\d{2}:\\d{2}\\]?\\s*/, '')
        .replace(/^\\s*\\[?\\d{4}-\\d{2}-\\d{2}[T\\s]\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z?\\]?\\s*/, '');
      return { stamp: stamp, content: content || line };
    }
    function displayLogLine(line) {
      return line.replace(/^\\s{12,}/, '    ');
    }
    function renderLargeMachineLine(line) {
      var normalized = line.replace(/\\\\n/g, ' ').replace(/\\\\\\"/g, '"').replace(/\\s+/g, ' ').trim();
      var preview = normalized.slice(0, 220);
      if (normalized.length > 220) preview += '…';
      var kind = /\\\\\\"|\\{\\\\\\"|\\[\\\\\\"/.test(line) ? 'escaped JSON/blob' : 'long output';
      return '<details class="rds-log-fold">' +
        '<summary><span class="rds-log-fold-kind">' + kind + '</span><span class="rds-log-fold-preview">' + escHtml(preview) + '</span></summary>' +
        '<pre>' + escHtml(line) + '</pre>' +
        '</details>';
    }
    var lastRenderedLogStamp = '';
    function renderLogHtml(raw) {
      return raw.split('\\n').filter(function(line, index, lines) {
        if (index === lines.length - 1 && line.length === 0) return false;
        return line.trim().length > 0;
      }).map(function(line) {
        var parsed = parseLogLine(line);
        var stamp = parsed.stamp;
        var cls = logLineClass(parsed.content);
        var repeatedStamp = stamp === lastRenderedLogStamp && cls.indexOf('log-source') === -1;
        lastRenderedLogStamp = stamp;
        var displayLine = displayLogLine(parsed.content);
        var inner = displayLine.length > 900
          ? renderLargeMachineLine(displayLine)
          : (/\\x1b\\[/.test(displayLine) && ansi ? ansi.ansi_to_html(displayLine) : highlightPlainLogLine(displayLine));
        return '<div class="' + cls + (repeatedStamp ? ' log-same-time' : '') + '" data-time="' + stamp + '"><span class="rds-log-content">' + inner + '</span></div>';
      }).join('');
    }
    var lg = new EventSource('/b/' + encodeURIComponent(id) + '/log');
    lg.addEventListener('open',  function () { setConn('conn-log', 'on');  setLogState('streaming', 'bg-primary-container'); });
    lg.addEventListener('error', function () { setConn('conn-log', 'off'); setLogState('disconnected', 'bg-error'); });
    lg.addEventListener('source', function(e) {
      try {
        var src = JSON.parse(e.data || '{}');
        if (logSource && src.label) {
          logSource.innerHTML = 'Source: <span class="text-on-surface">' + escHtml(src.label) + '</span>';
        }
      } catch (_) {}
    });
    // Batch incoming lines into a single rAF flush so bursts (e.g. SSE reconnect
    // backlog of hundreds of lines) don't lock the page with per-line ANSI
    // parsing + DOM inserts + reflow.
    var pendingLog = [];
    var rafScheduled = false;
    function escHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
    function nearBottom(el) {
      if (!el) return true;
      return (el.scrollHeight - el.scrollTop - el.clientHeight) < 80;
    }
    function flushLogBuffer() {
      rafScheduled = false;
      if (pendingLog.length === 0) return;
      var raw = pendingLog.join('\\n') + '\\n';
      pendingLog.length = 0;
      var html = renderLogHtml(raw);
      if (logEl) {
        // Capture stick-to-bottom intent before mutating, so we don't
        // yank the user away from scrollback they're reading.
        var stick = nearBottom(logEl);
        logEl.insertAdjacentHTML('beforeend', html);
        while (logEl.childNodes.length > 4000) logEl.removeChild(logEl.firstChild);
        if (stick) logEl.scrollTop = logEl.scrollHeight;
      }
      if (ovLogEl) {
        var stickOv = window.__ovFollow !== false && nearBottom(ovLogEl);
        ovLogEl.insertAdjacentHTML('beforeend', html);
        // Smaller cap for the mini view to keep DOM weight low.
        var capped = false;
        while (ovLogEl.childNodes.length > 600) { ovLogEl.removeChild(ovLogEl.firstChild); capped = true; }
        if (stickOv) ovLogEl.scrollTop = ovLogEl.scrollHeight;
        if (ovLogCount) ovLogCount.textContent = ovLogEl.childNodes.length + (capped ? '+ lines' : ' lines');
      }
    }
    lg.onmessage = function(e) {
      if (logEmpty && !logEmpty.classList.contains('hidden')) logEmpty.classList.add('hidden');
      if (ovLogEmpty && !ovLogEmpty.classList.contains('hidden')) ovLogEmpty.classList.add('hidden');
      var lastOut = document.getElementById('live-last-output');
      if (lastOut) lastOut.textContent = 'just now';
      if (/\\btask\\s+\\d+\\b/i.test(e.data) || /\\b(in_progress|done|blocked|errored)\\b/i.test(e.data)) refetchScaffoldProgress();
      pendingLog.push(e.data);
      if (!rafScheduled) {
        rafScheduled = true;
        (window.requestAnimationFrame || function(fn){ return setTimeout(fn, 16); })(flushLogBuffer);
      }
    };

    // ---- activity rail (live prepend) ----------------------------------------
    function activityClassFor(name) {
      if (name === 'build_started' || name === 'stage_started')     return 'activity-start';
      if (name === 'build_completed' || name === 'stage_completed') return 'activity-ok';
      if (name === 'build_failed' || name === 'stage_failed')       return 'activity-err';
      if (name === 'build_pending_review')                          return 'activity-warn';
      if (/^iterate_/.test(name))                                    return 'activity-warn';
      if (name === 'build_approved')                                return 'activity-ok';
      if (name === 'build_rejected')                                return 'activity-err';
      if (name === 'stuck_detected')                                return 'activity-warn';
      if (/^fixer_/.test(name))                                     return 'activity-warn';
      return 'activity-info';
    }
    function summarize(p) {
      p = p || {};
      var parts = [];
      if (typeof p.stage === 'string') parts.push('stage=' + p.stage);
      if (typeof p.preview_url === 'string') parts.push(p.preview_url);
      if (typeof p.mode === 'string') parts.push('mode=' + p.mode);
      if (typeof p.stack === 'string') parts.push('stack=' + p.stack);
      if (typeof p.provider === 'string') parts.push('builder=' + p.provider);
      if (typeof p.exit_code !== 'undefined') parts.push('exit=' + p.exit_code);
      return parts.join(' · ');
    }
    function escapeText(s) {
      return String(s == null ? '' : s)
        .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }
    function tagFor(name) {
      if (/^build_/.test(name) || name === 'watchdog_fired') return ['BLD','text-primary-container'];
      if (/^stage_/.test(name)) return ['STG','text-secondary'];
      if (/^iterate_/.test(name)) return ['ITR','text-primary-container'];
      if (name === 'stuck_detected' || name === 'watchdog_triggered') return ['WDG','text-tertiary-container'];
      if (/^fixer_/.test(name)) return ['FIX','text-tertiary-container'];
      if (name === 'build_approved' || name === 'build_rejected' || name === 'build_pending_review') return ['REV','text-tertiary'];
      return ['SYS','text-[#b9c2bc]'];
    }
    function prependActivity(e) {
      var feed = document.getElementById('activity-feed');
      if (!feed) return;
      var name = e && e.event ? e.event : '';
      var ts   = e && e.ts ? new Date(e.ts) : null;
      var t    = ts ? ts.toISOString().slice(11, 19) : '';
      var tag  = tagFor(name);
      var div  = document.createElement('div');
      div.className = 'flex gap-3 hover:bg-[#1b211e] px-1 py-0.5 rounded transition-colors text-on-surface-variant ' + activityClassFor(name);
      div.innerHTML =
        '<span class="text-[#8b968f] shrink-0 font-code text-[12px]">' + escapeText(t) + '</span>' +
        '<span class="' + tag[1] + ' shrink-0 font-code text-[12px]">[' + tag[0] + ']</span>' +
        '<span class="truncate font-code text-[12px]"><span class="text-on-surface">' + escapeText(name) + '</span>' +
          (summarize(e && e.payload) ? ' · ' + escapeText(summarize(e && e.payload)) : '') + '</span>';
      feed.insertBefore(div, feed.firstChild);
      while (feed.childNodes.length > 60) feed.removeChild(feed.lastChild);
    }
    window.prependActivity = prependActivity;

    // ---- files tab -----------------------------------------------------------
    async function loadFiles() {
      window.__filesLoaded = true;
      var status = document.getElementById('files-status');
      var tree   = document.getElementById('files-tree');
      status.textContent = 'Loading…';
      tree.innerHTML = '';
      try {
        var res = await fetch('/b/' + encodeURIComponent(id) + '/files', { headers: { 'X-RDS-Token': token() } });
        var data = await res.json();
        if (!res.ok || !data.ok) {
          status.textContent = 'no files: ' + (data && data.error ? data.error : ('HTTP ' + res.status));
          return;
        }
        status.textContent = data.entries.length + ' files (newest first, ' + data.root + ')';
        for (var i = 0; i < data.entries.length; i++) {
          var entry = data.entries[i];
          var li = document.createElement('li');
          li.dataset.path = entry.path;
          li.className = 'rounded';
          li.innerHTML = '<button type="button" class="rds-file-row w-full text-left cursor-pointer rounded px-2 py-1.5 text-primary-container hover:bg-surface-container-high hover:text-primary focus:bg-surface-container-high focus:text-primary outline-none flex items-start gap-2"><span class="material-symbols-outlined shrink-0" style="font-size:14px">description</span><span class="min-w-0 flex-1 break-all underline decoration-primary-container/30 underline-offset-2">' + escapeText(entry.path) + '</span><small class="shrink-0 text-outline no-underline">' + entry.size + 'B</small></button>';
          var btn = li.querySelector('button');
          if (btn) {
            btn.setAttribute('aria-label', 'Open file ' + entry.path);
            btn.onclick = (function (path, el) {
              return function () { openFile(path, el); };
            })(entry.path, li);
          }
          tree.appendChild(li);
        }
        if (data.entries.length) openFile(data.entries[0].path, tree.querySelector('li'));
      } catch (e) {
        status.textContent = 'failed: ' + e;
      }
    }
    async function openFile(rel, liEl) {
      var viewer = document.getElementById('file-viewer-body');
      var title = document.getElementById('file-viewer-title');
      viewer.textContent = 'Loading ' + rel + '…';
      var lis = document.querySelectorAll('#files-tree li');
      for (var i = 0; i < lis.length; i++) {
        lis[i].classList.remove('bg-surface-container-high', 'text-on-surface');
        lis[i].classList.add('text-on-surface-variant');
        var btn = lis[i].querySelector('button');
        if (btn) btn.classList.remove('bg-surface-container-high', 'text-primary');
      }
      if (liEl) {
        liEl.classList.add('bg-surface-container-high', 'text-on-surface');
        liEl.classList.remove('text-on-surface-variant');
        var selectedBtn = liEl.querySelector('button');
        if (selectedBtn) selectedBtn.classList.add('bg-surface-container-high', 'text-primary');
      }
      if (title) title.textContent = rel;
      try {
        var clean = rel.replace(/^\\.\\//, '');
        var res = await fetch('/b/' + encodeURIComponent(id) + '/files/raw?path=' + encodeURIComponent(clean), { headers: { 'X-RDS-Token': token() } });
        viewer.textContent = await res.text();
      } catch (e) {
        viewer.textContent = 'failed: ' + e;
      }
    }

    // ---- diff tab ------------------------------------------------------------
    async function loadDiff() {
      window.__diffLoaded = true;
      var body = document.getElementById('diff-body');
      var sel  = document.getElementById('diff-mode');
      var mode = sel ? sel.value : 'working';
      body.textContent = 'Loading…';
      try {
        var res = await fetch('/b/' + encodeURIComponent(id) + '/diff?mode=' + encodeURIComponent(mode), { headers: { 'X-RDS-Token': token() } });
        body.textContent = await res.text();
      } catch (e) {
        body.textContent = 'failed: ' + e;
      }
    }
    window.loadFiles = loadFiles; window.openFile = openFile; window.loadDiff = loadDiff;

    function setAgentSessionResult(text, isError) {
      var out = document.getElementById('agent-session-result');
      if (!out) return;
      out.classList.remove('hidden');
      out.classList.toggle('text-error', !!isError);
      out.textContent = text;
    }
    async function agentSessionAction(sessionId, action) {
      var confirm = '';
      if (action === 'stop') {
        if (!await rdsConfirm('Stop agent session "' + sessionId + '"?', { title: 'Stop agent?', warn: true, okLabel: 'Stop' })) return;
        confirm = 'STOP_AGENT';
      } else if (action === 'discard') {
        if (!await rdsConfirm('Discard agent session "' + sessionId + '" and remove its worktree? Logs and session JSON are preserved.', { title: 'Discard agent?', danger: true, okLabel: 'Discard' })) return;
        confirm = 'DISCARD';
      } else if (action === 'merge') {
        if (!await rdsConfirm('Merge agent session "' + sessionId + '" into its recorded base branch locally? This does not push to GitHub.', { title: 'Merge local branch?', warn: true, okLabel: 'Merge locally' })) return;
        confirm = 'MERGE';
      }
      setAgentSessionResult('Running ' + action + ' for ' + sessionId + '…');
      var res = await fetch('/agent-sessions/' + encodeURIComponent(sessionId) + '/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-RDS-Token': token() },
        body: JSON.stringify({ action: action, confirm: confirm })
      });
      var text = await res.text();
      setAgentSessionResult(res.status + ' ' + text, !res.ok);
      if ((action === 'stop' || action === 'discard') && res.ok) setTimeout(function(){ location.reload(); }, 700);
    }
    async function agentSessionReview(sessionId, provider) {
      var ok = await rdsConfirm('Run a bounded ' + provider + ' review of "' + sessionId + '"? This is read/review mode and writes a review markdown file.', {
        title: 'Run cross-agent review?', okLabel: 'Run review'
      });
      if (!ok) return;
      setAgentSessionResult('Running review…');
      var res = await fetch('/agent-sessions/' + encodeURIComponent(sessionId) + '/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-RDS-Token': token() },
        body: JSON.stringify({ action: 'review', provider: provider, confirm: 'REVIEW_AGENT' })
      });
      var text = await res.text();
      setAgentSessionResult(res.status + ' ' + text, !res.ok);
    }
    async function agentSessionHandoff(sessionId, provider) {
      var task = await rdsPrompt('What should ' + provider + ' do with this handoff?', 'Review the current diff, diagnose risks, and continue only if the next fix is clear.', {
        title: 'Handoff Agent Session', okLabel: 'Continue'
      });
      if (task === null) return;
      task = String(task || '').trim();
      if (task.length < 8) { rdsToast('Handoff task is too short.', 'warn'); return; }
      var ok = await rdsConfirm('Hand off "' + sessionId + '" to ' + provider + '? RDS will preserve links between the session records.', {
        title: 'Handoff agent?', warn: true, okLabel: 'Hand off'
      });
      if (!ok) return;
      setAgentSessionResult('Starting handoff…');
      var res = await fetch('/agent-sessions/' + encodeURIComponent(sessionId) + '/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-RDS-Token': token() },
        body: JSON.stringify({ action: 'handoff', provider: provider, task: task, confirm: 'HANDOFF_AGENT' })
      });
      var text = await res.text();
      setAgentSessionResult(res.status + ' ' + text, !res.ok);
      if (res.ok) setTimeout(function(){ location.reload(); }, 900);
    }
    window.agentSessionAction = agentSessionAction;
    window.agentSessionReview = agentSessionReview;
    window.agentSessionHandoff = agentSessionHandoff;

    async function cmd(verb) {
      if (verb === 'pause') {
        var ok = await rdsConfirm(
          'Pause build "' + id + '"? The active runner will stop and RDS will keep the current stage ready to resume later.',
          { title: 'Pause build?', warn: true, okLabel: 'Pause build' }
        );
        if (!ok) return;
      } else if (verb === 'resume') {
        var resumeOk = await rdsConfirm(
          'Resume paused build "' + id + '"? RDS will continue from the paused stage in the background.',
          { title: 'Resume build?', okLabel: 'Resume build' }
        );
        if (!resumeOk) return;
      }
      var res = await fetch('/b/' + encodeURIComponent(id) + '/cmd', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-RDS-Token': token() },
        body: JSON.stringify({ verb: verb })
      });
      document.getElementById('cmd-result').textContent = res.status + ' ' + await res.text();
      if (res.ok && verb === 'pause') {
        rdsToast('Build paused.', 'info');
        setTimeout(function(){ location.reload(); }, 700);
      } else if (res.ok && verb === 'resume') {
        rdsToast('Build resumed.', 'info');
        setTimeout(function(){ location.reload(); }, 700);
      }
    }
    async function spawnFixer() {
      var ok = await rdsConfirm(
        'Spawn the selected builder fixer for build "' + id + '"? It runs in the background and writes notes to fixer-*.md.',
        { title: 'Spawn fixer?', okLabel: 'Spawn fixer' }
      );
      if (!ok) return;
      // Optimistically disable buttons so accidental double-clicks don't
      // queue duplicate fixers; SSE fixer_completed flips them back.
      setFixerButtonsRunning(true);
      try {
        var res = await fetch('/b/' + encodeURIComponent(id) + '/fix', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-RDS-Token': token() }
        });
        var txt = await res.text();
        document.getElementById('cmd-result').textContent = res.status + ' ' + txt;
        if (res.ok) rdsToast('Fixer spawned. Watch the fixer-*.md notes.', 'info');
        else { setFixerButtonsRunning(false); rdsToast('Spawn fixer failed: ' + res.status, 'error'); }
      } catch (err) {
        setFixerButtonsRunning(false);
        rdsToast('Spawn fixer failed: ' + err, 'error');
      }
    }
    function rdsEngineSwap(sel) {
      var box = sel.closest('.rds-command-engine');
      var input = document.getElementById('engine-model');
      if (!box || !input) return;
      var isCodex = sel.value === 'codex';
      input.setAttribute('list', isCodex ? 'rds-engine-codex' : 'rds-engine-claude');
      input.value = (isCodex ? box.getAttribute('data-codex-model') : box.getAttribute('data-claude-model')) || '';
    }
    function rdsReadEngine() {
      var sel = document.getElementById('engine-provider');
      var input = document.getElementById('engine-model');
      if (!sel) return { provider: '', model: '', label: '' };
      var provider = sel.value || '';
      var model = input ? String(input.value || '').trim() : '';
      var providerLabel = provider === 'codex' ? 'Codex' : 'Claude Code';
      return { provider: provider, model: model, label: providerLabel + (model ? ' · ' + model : ' · provider default') };
    }
    async function iterateBuild() {
      var iterateBtns = document.querySelectorAll('.js-iterate-action');
      function setIterateBusy(busy) {
        iterateBtns.forEach(function (btn) {
          btn.disabled = !!busy;
          btn.setAttribute('aria-busy', busy ? 'true' : 'false');
          btn.innerHTML = busy
            ? '<span class="material-symbols-outlined !text-[14px] animate-spin" style="animation-duration:1.2s">progress_activity</span><span>Iterating…</span>'
            : '<span class="material-symbols-outlined !text-[14px]">edit</span><span>Iterate…</span>';
        });
      }
      var prompt = await rdsPrompt(
        'Describe the change to apply to this generated app. RDS will patch the app, run checks + QA, and redeploy only if everything passes.',
        '',
        { title: 'Iterate on build', okLabel: 'Continue', placeholder: 'Example: make the ball 20% faster and add a pause button' }
      );
      if (prompt === null) return;
      prompt = String(prompt || '').trim();
      if (prompt.length < 8) {
        rdsToast('Iteration request is too short.', 'warn');
        return;
      }
      var engine = rdsReadEngine();
      var ok = await rdsConfirm(
        'Run a post-build iteration for "' + id + '" on ' + engine.label + '? This can edit generated app files and will redeploy only after checks and QA pass.',
        { title: 'Run iteration?', okLabel: 'Run iteration', warn: true }
      );
      if (!ok) return;
      setIterateBusy(true);
      try {
        var res = await fetch('/b/' + encodeURIComponent(id) + '/iterate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-RDS-Token': token() },
          body: JSON.stringify({ prompt: prompt, confirm: 'ITERATE', provider: engine.provider, model: engine.model })
        });
        var text = await res.text();
        document.getElementById('cmd-result').textContent = res.status + ' ' + text;
        if (res.ok) {
          rdsToast('Iteration started. This page will show progress from the event stream.', 'info');
          setTimeout(function(){ location.reload(); }, 900);
        } else {
          setIterateBusy(false);
          rdsToast('Iteration failed to start: ' + res.status, 'error');
        }
      } catch (err) {
        setIterateBusy(false);
        rdsToast('Iteration failed to start: ' + err, 'error');
      }
    }
    async function runGoal() {
      var objective = 'Make this build review-ready.';
      var engine = rdsReadEngine();
      var ok = await rdsConfirm(
        'Continue RDS Goal for "' + id + '" on ' + engine.label + '? RDS will re-read the PRD/spec/evidence, repair blockers, rerun QA/readiness, and may launch a bounded worker review on the same engine. It will not merge, push, approve, or delete anything automatically.',
        { title: 'Continue RDS Goal?', okLabel: 'Continue goal', warn: true }
      );
      if (!ok) return;
      try {
        var res = await fetch('/b/' + encodeURIComponent(id) + '/goal', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-RDS-Token': token() },
          body: JSON.stringify({ objective: objective, confirm: 'GOAL', max_cycles: 12, provider: engine.provider, model: engine.model })
        });
        var text = await res.text();
        document.getElementById('cmd-result').textContent = res.status + ' ' + text;
        if (res.ok) {
          rdsToast('RDS Goal started. The Goal panel will update from goal.json.', 'info');
          setTimeout(function(){ location.reload(); }, 900);
        } else {
          rdsToast('Goal failed to start: ' + res.status, 'error');
        }
      } catch (err) {
        rdsToast('Goal failed to start: ' + err, 'error');
      }
    }
    async function deploy(target) {
      var msg = target === 'teardown'
        ? 'Stop the local preview process for build "' + id + '"? This does not delete any Zo-hosted service. For a hosted build, use Delete Zo service instead.'
        : 'Re-run rds-deploy --target=' + target + ' for build "' + id + '"?';
      var ok = await rdsConfirm(msg, {
        title: target === 'teardown' ? 'Stop local preview?' : 'Redeploy?',
        danger: target === 'teardown',
        okLabel: target === 'teardown' ? 'Stop local preview' : 'Redeploy'
      });
      if (!ok) return;
      var res = await fetch('/b/' + encodeURIComponent(id) + '/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-RDS-Token': token() },
        body: JSON.stringify({ target: target })
      });
      var text = await res.text();
      document.getElementById('cmd-result').textContent = res.status + ' ' + text;
      try {
        var data = JSON.parse(text);
        if (res.ok && data.pendingRegistration) rdsToast('Deploy reran; Zo service registration is still pending.', 'info');
        else if (res.ok) rdsToast('Deploy command completed.', 'info');
      } catch (e) {
        if (res.ok) rdsToast('Deploy command completed.', 'info');
      }
      if (res.ok) setTimeout(function(){ location.reload(); }, 600);
    }
    var deregisterInFlight = false;
    function setDeregisterBusy(busy) {
      deregisterInFlight = busy;
      document.querySelectorAll('.js-delete-service-action').forEach(function (btn) {
        btn.disabled = busy;
        btn.setAttribute('aria-busy', busy ? 'true' : 'false');
        btn.innerHTML = busy
          ? '<span class="flex items-center gap-1"><span class="material-symbols-outlined animate-spin" style="font-size:14px;animation-duration:1.2s">progress_activity</span><span>Deleting Zo service…</span></span>'
          : '<span class="flex items-center gap-1"><span class="material-symbols-outlined" style="font-size:14px">delete</span><span>Delete Zo service</span></span>';
      });
      document.querySelectorAll('[onclick^="deploy("]').forEach(function (btn) {
        if (busy) btn.setAttribute('disabled', 'disabled');
        else btn.removeAttribute('disabled');
      });
      var out = document.getElementById('cmd-result');
      if (out && busy) out.textContent = 'Deleting Zo service and verifying it is absent from the Zo service registry…';
    }
    async function deregisterService() {
      if (deregisterInFlight) return;
      var ok = await rdsConfirm('Delete the hosted Zo service for build "' + id + '"? This removes public hosting and clears the preview URL in RDS. Project files stay in Projects/, and Redeploy can register hosting again.', {
        title: 'Delete Zo service?',
        danger: true,
        okLabel: 'Delete service'
      });
      if (!ok) return;
      setDeregisterBusy(true);
      rdsToast('Deleting Zo service…', 'info');
      try {
        var res = await fetch('/b/' + encodeURIComponent(id) + '/service/deregister', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-RDS-Token': token() }
        });
        var text = await res.text();
        document.getElementById('cmd-result').textContent = res.status + ' ' + text;
        if (res.ok) { rdsToast('Zo service deleted. Refreshing state…', 'info'); setTimeout(function(){ location.reload(); }, 700); }
        else { setDeregisterBusy(false); rdsToast('Delete Zo service failed: ' + res.status, 'error'); }
      } catch (e) {
        setDeregisterBusy(false);
        document.getElementById('cmd-result').textContent = 'Delete Zo service failed: ' + (e && e.message ? e.message : e);
        rdsToast('Delete Zo service failed.', 'error');
      }
    }
    async function loadStageLog(name) {
      var pre = document.getElementById('stage-log');
      if (!name) { pre.textContent = ''; return; }
      var res = await fetch('/b/' + encodeURIComponent(id) + '/log/' + encodeURIComponent(name));
      pre.textContent = await res.text();
    }
    async function approve() {
      var by = await rdsPrompt('Sign-off as (your name)', localStorage.getItem('rds_operator') || 'operator',
        { title: 'Approve build', okLabel: 'Next' });
      if (by === null) return;
      by = (by || '').trim() || 'operator';
      localStorage.setItem('rds_operator', by);
      var reason = await rdsPrompt('Optional note (visible in audit log):', '',
        { title: 'Approve build', okLabel: 'Approve', placeholder: 'leave blank to skip' });
      if (reason === null) return;
      var res = await fetch('/b/' + encodeURIComponent(id) + '/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-RDS-Token': token() },
        body: JSON.stringify({ by: by, reason: reason || '' })
      });
      var text = await res.text();
      document.getElementById('cmd-result').textContent = res.status + ' ' + text;
      if (res.ok) { rdsToast('Approved.', 'info'); setTimeout(function(){ location.reload(); }, 600); }
      else {
        var msg = 'Approve failed: ' + res.status;
        try {
          var payload = JSON.parse(text);
          if (payload && payload.error) {
            msg = payload.error;
            if (payload.verdict) msg += ' (' + payload.verdict + ')';
          }
        } catch (_) {}
        rdsToast(msg, 'error');
      }
    }
    async function reject() {
      var understood = await rdsConfirm(
        'Reject marks this build as not approved and records your reason. It does not delete the generated app, the live Zo service, logs, evidence, or goal state. You can still continue RDS Goal or run an iteration afterward.',
        { title: 'What rejection does', okLabel: 'Continue', warn: true }
      );
      if (!understood) return;
      var by = await rdsPrompt('Sign-off as (your name)', localStorage.getItem('rds_operator') || 'operator',
        { title: 'Reject build', okLabel: 'Next' });
      if (by === null) return;
      by = (by || '').trim() || 'operator';
      localStorage.setItem('rds_operator', by);
      var reason = await rdsPrompt('Why is this build being rejected? (required)', '',
        { title: 'Reject build', okLabel: 'Reject', placeholder: 'e.g. broken auth flow' });
      if (reason === null) return;
      reason = (reason || '').trim();
      if (!reason) { rdsToast('Rejection reason required.', 'error'); return; }
      var res = await fetch('/b/' + encodeURIComponent(id) + '/reject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-RDS-Token': token() },
        body: JSON.stringify({ by: by, reason: reason })
      });
      var text = await res.text();
      document.getElementById('cmd-result').textContent = res.status + ' ' + text;
      if (res.ok) { rdsToast('Build marked rejected. Files and hosting were left intact.', 'info'); setTimeout(function(){ location.reload(); }, 600); }
      else rdsToast('Reject failed: ' + res.status, 'error');
    }
    async function refreshCost() {
      var evt = arguments.length ? arguments[0] : window.event;
      var btn = evt && evt.currentTarget ? evt.currentTarget : document.querySelector('[data-refresh-cost]');
      if (!btn || btn.disabled) return;
      var original = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = '<span class="material-symbols-outlined !text-[14px] animate-spin" style="animation-duration:1.2s">progress_activity</span><span>refreshing</span>';
      try {
        var res = await fetch('/b/' + encodeURIComponent(id) + '/refresh-cost', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-RDS-Token': token() }
        });
        var data = await res.json().catch(function(){ return null; });
        if (res.ok) {
          var out = document.getElementById('cmd-result');
          if (out && data && data.stdout) out.textContent = data.stdout;
          rdsToast('Cost refreshed.', 'info');
          setTimeout(function(){ location.reload(); }, 500);
        }
        else {
          btn.disabled = false;
          btn.innerHTML = original;
          rdsToast('refresh-cost failed: ' + res.status, 'error');
        }
      } catch (e) {
        btn.disabled = false;
        btn.innerHTML = original;
        rdsToast('refresh-cost failed: ' + (e && e.message ? e.message : e), 'error');
      }
    }
    function copyBuildDocPath(path) {
      var text = String(path || '');
      if (!text) return;
      navigator.clipboard.writeText(text).then(function () {
        rdsToast('Document path copied.', 'info');
      }).catch(function () {
        var out = document.getElementById('cmd-result');
        if (out) out.textContent = text;
        rdsToast('Path copied to command output.', 'info');
      });
    }
    window.cmd = cmd; window.spawnFixer = spawnFixer; window.iterateBuild = iterateBuild; window.loadStageLog = loadStageLog;
    window.deploy = deploy; window.deregisterService = deregisterService; window.approve = approve; window.reject = reject; window.refreshCost = refreshCost;
    window.copyBuildDocPath = copyBuildDocPath;
  `;
}

function chatPanel(opts: { initialSessionId?: string; initialBuildId?: string } = {}): string {
  return `
    <div id="chat-panel"
         data-initial-session="${escapeHtml(opts.initialSessionId ?? "")}"
         data-initial-build="${escapeHtml(opts.initialBuildId ?? "")}"
         class="rds-chat-panel flex flex-col h-full min-h-0 min-w-0">
      <div class="rds-chat-panel-head flex items-center justify-between border-b border-[#242b28] p-unit gap-2">
        <div class="flex items-center gap-2 min-w-0">
          ${icon("chat", 16, "text-primary-container")}
          <span id="chat-title" class="font-h2 text-h2 text-on-surface truncate">No thread selected</span>
          <span id="chat-build-link" class="hidden font-ribbon text-ribbon text-on-surface-variant min-w-0"></span>
        </div>
        <div class="flex items-center gap-3 font-ribbon text-ribbon">
          <button type="button" onclick="renameChatThread()" id="chat-rename-btn" class="text-on-surface-variant hover:text-on-surface flex items-center gap-1 hidden">${icon("edit", 14)}<span>rename</span></button>
          <button type="button" onclick="deleteChatThread()" id="chat-delete-btn" class="text-on-surface-variant hover:text-error flex items-center gap-1 hidden">${icon("delete", 14)}<span>delete</span></button>
        </div>
      </div>
      <div id="chat-build-actions" class="hidden border-b border-[#242b28] bg-[#0b0d0c] px-unit py-2">
        <div class="flex items-center justify-between gap-2 flex-wrap">
          <div class="min-w-0">
            <div class="font-ribbon text-[11px] uppercase text-outline">Build context</div>
            <div id="chat-build-actions-id" class="font-code text-[11px] text-on-surface-variant truncate max-w-[520px]"></div>
            <div class="rds-chat-build-hint font-table text-table text-on-surface-variant mt-1">Ask for a fix, attach screenshots, or start a Claude/Codex worker from the message box.</div>
          </div>
          <div class="flex items-center gap-1.5 flex-wrap">
            <a id="chat-action-open-build" href="#" class="inline-flex items-center gap-1 border border-outline-variant text-on-surface rounded px-2.5 py-1.5 font-ribbon text-ribbon hover:border-primary-container hover:text-primary-container">${icon("open_in_new", 14)}<span>Open build</span></a>
            <button type="button" onclick="document.getElementById('chat-file-input').click()" class="inline-flex items-center gap-1 border border-outline-variant text-on-surface rounded px-2.5 py-1.5 font-ribbon text-ribbon hover:border-primary-container hover:text-primary-container">${icon("add_photo_alternate", 14)}<span>Add files</span></button>
          </div>
        </div>
      </div>
      <div id="chat-log" class="rds-chat-log flex-1 min-h-0 overflow-auto p-4 bg-[#101412] panel-border-0 flex flex-col gap-3">
        <div class="text-on-surface-variant italic font-table text-table p-3">Ask about a build, logs, QA, deployment state, or request a controlled iteration.</div>
      </div>
      <form id="chat-form" onsubmit="return submitChat(event)" class="rds-chat-form p-unit space-y-2 border-t border-[#242b28]">
        <div class="rds-chat-helper font-ribbon text-ribbon text-on-surface-variant flex items-center justify-between gap-2 flex-wrap">
          <span>Ask status, request a change, or say “start a Claude/Codex worker…”; RDS will propose the confirmed action in chat.</span>
          <span class="text-outline">Enter sends · Shift+Enter newline</span>
        </div>
        <textarea name="message" id="chat-input" rows="2" placeholder="Ask what failed, what changed, or what to check next…"
          onkeydown="chatKeydown(event)"
          class="w-full bg-[#101412] panel-border rounded p-2 font-code text-[12.5px] text-on-surface focus:border-primary-container focus:ring-0 focus:outline-none placeholder-[#7d8781] disabled:opacity-50"></textarea>
        <input id="chat-file-input" type="file" multiple hidden
          accept=".md,.markdown,.txt,.pdf,.png,.jpg,.jpeg,.webp,.gif,.zip,.html,.htm,.css,.js,.jsx,.ts,.tsx,.json,.svg,.csv,.xml,.yml,.yaml,.fig,.sketch,.webm,.mp4,.mov,text/markdown,text/plain,application/pdf,image/png,image/jpeg,image/webp,image/gif,application/zip"
          onchange="rdsChatAddFiles(this.files); this.value = ''">
        <div id="chat-dropzone" class="rds-chat-dropzone hidden border border-dashed border-[#242b28] bg-[#0b0d0c] rounded px-3 py-2 font-ribbon text-ribbon text-on-surface-variant">
          Drop files here to attach them to this RDS message.
        </div>
        <div id="chat-attachments" class="hidden flex flex-wrap gap-2"></div>
        <div class="rds-chat-actions flex items-center gap-3">
          <button type="button" onclick="document.getElementById('chat-file-input').click()" title="Attach files" aria-label="Attach files" class="rds-chat-attach-btn border border-outline-variant text-on-surface rounded px-3 py-1.5 font-ribbon text-ribbon hover:border-primary-container hover:text-primary-container transition-colors flex items-center gap-1">${icon("attach_file", 14)}<span>Files</span></button>
          <button type="submit" id="chat-send-btn" class="bg-primary-container text-[#070908] rounded px-4 py-1.5 font-h2 text-h2 hover:bg-[#7ee2ae] transition-colors flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed">${icon("send", 14)}<span>Send</span></button>
          <span class="font-ribbon text-ribbon text-on-surface-variant" id="chat-status"></span>
        </div>
      </form>
    </div>
  `;
}

function chatScript(): string {
  return `
    var rdsChatState = { activeId: '', activeBuildId: '', sessions: [], pollTimer: null, listTimer: null, attachments: [] };

    function escapeChatHtml(s) {
      return String(s == null ? '' : s)
        .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
        .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    }

    function relativeTime(ts) {
      if (!ts) return '';
      var s = Math.max(1, Math.round((Date.now() - ts) / 1000));
      if (s < 60) return s + 's ago';
      var m = Math.round(s / 60); if (m < 60) return m + 'm ago';
      var h = Math.round(m / 60); if (h < 48) return h + 'h ago';
      var d = Math.round(h / 24); return d + 'd ago';
    }

    function renderSessionList() {
      var list = document.getElementById('chat-session-list');
      if (!list) return;
      if (!rdsChatState.sessions.length) {
        list.innerHTML = '<li class="px-3 py-3 text-on-surface-variant font-table text-table italic">No threads yet. "+ new" to start one.</li>';
        return;
      }
      list.innerHTML = rdsChatState.sessions.map(function (s) {
        var active = s.id === rdsChatState.activeId;
        var pendingDot = s.pending
          ? '<span class="w-1.5 h-1.5 rounded-full bg-tertiary-container animate-pulse shrink-0" title="reply in progress"></span>'
          : '';
        var unread = (!active && s.unread > 0)
          ? '<span class="ml-auto inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1.5 rounded-full bg-error text-on-error font-ribbon text-[10px] font-bold shrink-0">' + s.unread + '</span>'
          : '';
        var titleColor = (active || (!active && s.unread > 0)) ? 'text-on-surface' : 'text-on-surface-variant';
        var preview = '';
        if (s.last_message) {
          var clean = String(s.last_message).replace(/\\s+/g, ' ').trim();
          if (clean) preview = '<div class="mt-1 font-table text-[11px] leading-4 text-on-surface-variant/70 truncate">' + escapeChatHtml(clean.slice(0, 110)) + '</div>';
        }
        var meta = [];
        if (s.build_id) meta.push('<code class="font-code text-[10px] text-primary-container truncate max-w-[60%]" title="' + escapeChatHtml(s.build_id) + '">' + escapeChatHtml(s.build_id) + '</code>');
        meta.push('<span class="font-ribbon text-[10px] text-outline shrink-0">' + escapeChatHtml(relativeTime(s.updated_at)) + '</span>');
        var metaRow = '<div class="mt-1 flex items-center gap-1.5 min-w-0">' + meta.join('<span class="text-outline text-[10px] shrink-0">·</span>') + '</div>';
        var cls = active
          ? 'bg-[#1b211e] border-l-2 border-[#6ad7a3]'
          : 'hover:bg-[#171d1a] border-l-2 border-transparent';
        return '<li><a href="javascript:void(0)" onclick="selectChatThread(\\''+ s.id +'\\')" class="block px-3 py-2.5 ' + cls + '">' +
          '<div class="flex items-center gap-2 min-w-0">' +
            pendingDot +
            '<span class="font-ribbon text-[12.5px] truncate flex-1 ' + titleColor + '">' + escapeChatHtml(s.title || 'Untitled') + '</span>' +
            unread +
          '</div>' +
          preview +
          metaRow +
        '</a></li>';
      }).join('');
    }

    function toggleChatThreads(force) {
      var rail = document.getElementById('chat-sessions-rail');
      if (!rail) return;
      var open = typeof force === 'boolean' ? force : !rail.classList.contains('rds-chat-rail-open');
      rail.classList.toggle('rds-chat-rail-open', open);
      rail.classList.toggle('rds-chat-rail-collapsed', !open);
    }

    function loadCachedSessions() {
      try {
        var raw = localStorage.getItem('rds_chat_cache_v1');
        if (!raw) return false;
        var data = JSON.parse(raw);
        if (data && Array.isArray(data.sessions)) {
          rdsChatState.sessions = data.sessions;
          renderSessionList();
          return true;
        }
      } catch (e) {}
      return false;
    }
    async function loadSessions() {
      try {
        var res = await fetch('/chat/sessions');
        if (!res.ok) return;
        var data = await res.json();
        rdsChatState.sessions = data.sessions || [];
        renderSessionList();
        try { localStorage.setItem('rds_chat_cache_v1', JSON.stringify({ sessions: rdsChatState.sessions, ts: Date.now() })); } catch (e) {}
      } catch (e) { /* ignore transient */ }
    }
    function loadCachedSession(id) {
      if (!id) return null;
      try {
        var raw = localStorage.getItem('rds_chat_session_' + id);
        if (!raw) return null;
        var data = JSON.parse(raw);
        if (data && data.session && data.session.id === id) return data.session;
      } catch (e) {}
      return null;
    }
    function cacheSession(s) {
      if (!s || !s.id) return;
      try { localStorage.setItem('rds_chat_session_' + s.id, JSON.stringify({ session: s, ts: Date.now() })); } catch (e) {}
    }

    function formatChatTs(ts) {
      var n = Number(ts || 0);
      if (!n) return '';
      var d = new Date(n);
      if (isNaN(+d)) return '';
      var hh = String(d.getHours()).padStart(2, '0');
      var mm = String(d.getMinutes()).padStart(2, '0');
      return hh + ':' + mm;
    }
    function chatDayKey(ts) {
      var n = Number(ts || 0);
      if (!n) return '';
      var d = new Date(n);
      if (isNaN(+d)) return '';
      return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
    }
    function chatDayLabel(ts) {
      var n = Number(ts || 0);
      if (!n) return '';
      var d = new Date(n);
      if (isNaN(+d)) return '';
      var now = new Date();
      var todayKey = now.getFullYear() + '-' + (now.getMonth() + 1) + '-' + now.getDate();
      var yest = new Date(now.getTime() - 86400000);
      var yestKey = yest.getFullYear() + '-' + (yest.getMonth() + 1) + '-' + yest.getDate();
      var key = chatDayKey(ts);
      if (key === todayKey) return 'Today';
      if (key === yestKey) return 'Yesterday';
      var days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      var mons = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      var label = days[d.getDay()] + ', ' + mons[d.getMonth()] + ' ' + d.getDate();
      if (d.getFullYear() !== now.getFullYear()) label += ', ' + d.getFullYear();
      return label;
    }
    // Render turns in stable creation order. seq (assigned once at creation) is
    // authoritative; ts then array index are tiebreakers so completion-time ts
    // rewrites or late-appended summaries can never reorder the thread.
    function sortChatTurns(turns) {
      var indexed = (turns || []).map(function (t, i) { return { t: t, i: i }; });
      indexed.sort(function (a, b) {
        var as = (typeof a.t.seq === 'number' && isFinite(a.t.seq)) ? a.t.seq : null;
        var bs = (typeof b.t.seq === 'number' && isFinite(b.t.seq)) ? b.t.seq : null;
        if (as !== null && bs !== null) { if (as !== bs) return as - bs; }
        else if (as !== null) return -1;
        else if (bs !== null) return 1;
        var at = Number(a.t.ts || 0), bt = Number(b.t.ts || 0);
        if (at !== bt) return at - bt;
        return a.i - b.i;
      });
      return indexed.map(function (o) { return o.t; });
    }
    function isActionRunning(action) {
      var st = action && action.action_status;
      return !!st && (st.status === 'queued' || st.status === 'running');
    }
    function actionStatusHtml(action) {
      var st = action && action.action_status;
      if (!st) return '';
      var status = String(st.status || 'unknown');
      var phase = String(st.phase || '').replace(/_/g, ' ');
      var tone = status === 'passed' ? 'text-primary-container'
        : status === 'failed' ? 'text-error'
        : status === 'needs_review' ? 'text-tertiary-container'
        : 'text-tertiary-container';
      var pulse = status === 'queued' || status === 'running' ? ' animate-pulse' : '';
      var parts = [];
      parts.push('<span class="' + tone + pulse + '">' + escapeChatHtml(status) + '</span>');
      if (phase) parts.push('<span>phase: ' + escapeChatHtml(phase) + '</span>');
      if (st.exit_code != null) parts.push('<span>exit: ' + escapeChatHtml(st.exit_code) + '</span>');
      if (action.action_run) parts.push('<span class="truncate" title="' + escapeChatHtml(action.action_run) + '">run: ' + escapeChatHtml(shortPath(action.action_run)) + '</span>');
      if (st.preview_url) parts.push('<a href="' + escapeChatHtml(st.preview_url) + '" target="_blank" rel="noreferrer" class="text-primary-container hover:underline">preview</a>');
      if (st.summary_file) parts.push('<span class="truncate" title="' + escapeChatHtml(st.summary_file) + '">summary: ' + escapeChatHtml(shortPath(st.summary_file)) + '</span>');
      if (st.repair_jobs) parts.push('<span class="truncate" title="' + escapeChatHtml(st.repair_jobs) + '">repair jobs: ' + escapeChatHtml(shortPath(st.repair_jobs)) + '</span>');
      if (st.repair_convergence) parts.push('<span class="truncate" title="' + escapeChatHtml(st.repair_convergence) + '">convergence: ' + escapeChatHtml(shortPath(st.repair_convergence)) + '</span>');
      if (st.error) parts.push('<span class="text-error">' + escapeChatHtml(st.error) + '</span>');
      return '<div class="mt-2 flex flex-wrap gap-x-3 gap-y-1 font-ribbon text-ribbon text-on-surface-variant">' + parts.join('') + '</div>';
    }
    function shortPath(path) {
      path = String(path || '');
      var parts = path.split('/').filter(Boolean);
      if (parts.length <= 2) return path;
      return parts.slice(-2).join('/');
    }
    function compactRdsText(text, isYou) {
      text = String(text || '');
      if (isYou) return text;
      text = text.replace(/(Action run|Summary|run):\\s*builds\\/[^\\n]*\\/([^\\/\\n]+\\.json)/g, '$1: $2');
      text = text.replace(/Diff:\\s*([^\\n]+)\\n(?:\\s*(?:M|A|D|R|C|\\?\\?)\\s+[^\\n]+\\n?)+/g, 'Diff: $1. Open Logs/Diff for file details.\\n');
      text = text.replace(/builds\\/([a-zA-Z0-9_.-]+)\\/([a-zA-Z0-9_.-]+\\.(?:json|log|md))/g, '$2');
      return text;
    }
    function formatChatFileSize(bytes) {
      var n = Number(bytes || 0);
      if (!n) return '0 B';
      if (n < 1024) return n + ' B';
      if (n < 1024 * 1024) return Math.round(n / 1024) + ' KiB';
      return (n / 1024 / 1024).toFixed(n > 10 * 1024 * 1024 ? 0 : 1) + ' MiB';
    }
    function renderTurnAttachments(turn) {
      var files = (turn && turn.attachments) || [];
      if (!files.length) return '';
      return '<div class="rds-chat-turn-attachments mt-2 flex flex-wrap gap-1.5">' + files.map(function (f) {
        var name = f.originalName || 'attachment';
        var isImage = /image\\//.test(f.mime || '') || /\\.(png|jpe?g|webp|gif|svg)$/i.test(name);
        var label = isImage ? 'image' : 'file';
        return '<span class="inline-flex items-center gap-1 max-w-full border border-[#242b28] bg-[#0b0d0c] rounded px-2 py-1 font-ribbon text-[11px] text-on-surface-variant">' +
          '<span class="material-symbols-outlined text-[14px] text-primary-container">' + (isImage ? 'image' : 'draft') + '</span>' +
          '<span class="truncate max-w-[220px]" title="' + escapeChatHtml(name) + '">' + escapeChatHtml(name) + '</span>' +
          '<span class="text-outline">' + label + ' · ' + escapeChatHtml(formatChatFileSize(f.size)) + '</span>' +
        '</span>';
      }).join('') + '</div>';
    }
    function renderTurn(turn) {
      var isYou = turn.role === 'you';
      var isErr = turn.status === 'error';
      var bubbleCls = isYou ? 'rds-chat-bubble-you'
        : isErr ? 'rds-chat-bubble-err'
        : 'rds-chat-bubble-rds';
      var statusBadge = '';
      if (turn.status === 'pending') statusBadge = '<span class="rds-chat-badge rds-chat-badge-think animate-pulse">${"\u2022\u2022\u2022"} thinking</span>';
      else if (turn.status === 'error') statusBadge = '<span class="rds-chat-badge rds-chat-badge-err">error</span>';
      var body = turn.status === 'pending' && !turn.text
        ? '<span class="text-on-surface-variant italic">RDS is thinking… you can navigate away; the reply will appear when ready.</span>'
        : escapeChatHtml(compactRdsText(turn.text || '', isYou));
      if (!isYou && turn.action) {
        var action = turn.action;
        var desc = action.description ? '<div class="font-table text-table text-on-surface-variant mt-1">' + escapeChatHtml(action.description) + '</div>' : '';
        var prompt = action.prompt ? '<pre class="mt-2 bg-[#070908] border border-[#242b28] rounded p-2 font-code text-[11px] text-on-surface-variant whitespace-pre-wrap">' + escapeChatHtml(action.prompt) + '</pre>' : '';
        var runStarted = !!action.action_run;
        var disabled = runStarted ? ' disabled' : '';
        var btnLabel = runStarted
          ? (isActionRunning(action) ? 'Running…' : 'Action recorded')
          : (action.confirm_label || action.label || 'Run action');
        var btn = '<button type="button" onclick="runChatAction(\\'' + escapeChatHtml(turn.id) + '\\')" ' + disabled + ' class="mt-2 inline-flex items-center gap-1 bg-primary-container text-[#070908] rounded px-3 py-1.5 font-h2 text-h2 hover:bg-[#7ee2ae] transition-colors disabled:opacity-50 disabled:cursor-not-allowed">' +
          escapeChatHtml(btnLabel) + '</button>';
        body += '<div class="mt-2 border border-primary-container/30 bg-primary-container/10 rounded p-2">' +
          '<div class="font-h2 text-h2 text-primary-container">' + escapeChatHtml(action.label || 'Proposed action') + '</div>' +
          desc + prompt + actionStatusHtml(action) + btn +
        '</div>';
      }
      body += renderTurnAttachments(turn);
      var tsLabel = formatChatTs(turn.ts);
      var tsHtml = tsLabel
        ? '<span class="rds-chat-turn-time" title="' + new Date(Number(turn.ts || 0)).toString() + '">' + tsLabel + '</span>'
        : '';
      var name = isYou ? 'You' : 'RDS';
      var glyph = isYou ? 'person' : 'bolt';
      var avatar = '<div class="rds-chat-avatar ' + (isYou ? 'rds-chat-avatar-you' : 'rds-chat-avatar-rds') + '">' +
        '<span class="material-symbols-outlined">' + glyph + '</span></div>';
      return '<div class="rds-chat-turn ' + (isYou ? 'rds-chat-turn-user' : 'rds-chat-turn-rds') + ' flex gap-3 items-start">' +
        avatar +
        '<div class="rds-chat-body-col min-w-0 flex-1">' +
          '<div class="rds-chat-turn-head">' +
            '<span class="rds-chat-turn-name">' + name + '</span>' + tsHtml + statusBadge +
          '</div>' +
          '<div class="rds-chat-bubble ' + bubbleCls + ' p-3 font-body text-[14px] leading-6 text-on-surface m-0 whitespace-pre-wrap break-words">' + body + '</div>' +
        '</div>' +
      '</div>';
    }

    function rdsChatAddFiles(fileList) {
      var files = Array.prototype.slice.call(fileList || []).filter(Boolean);
      if (!files.length) return;
      var existing = rdsChatState.attachments || [];
      files.forEach(function (file) {
        var dup = existing.some(function (f) { return f.name === file.name && f.size === file.size && f.lastModified === file.lastModified; });
        if (!dup) existing.push(file);
      });
      rdsChatState.attachments = existing.slice(0, 20);
      renderChatAttachmentTray();
    }
    function rdsRemoveChatAttachment(idx) {
      rdsChatState.attachments.splice(idx, 1);
      renderChatAttachmentTray();
    }
    function clearChatAttachments() {
      rdsChatState.attachments = [];
      renderChatAttachmentTray();
    }
    function renderChatAttachmentTray() {
      var wrap = document.getElementById('chat-attachments');
      if (!wrap) return;
      var files = rdsChatState.attachments || [];
      if (!files.length) {
        wrap.classList.add('hidden');
        wrap.innerHTML = '';
        return;
      }
      wrap.classList.remove('hidden');
      wrap.innerHTML = files.map(function (file, idx) {
        var isImage = /^image\\//.test(file.type || '') || /\\.(png|jpe?g|webp|gif|svg)$/i.test(file.name || '');
        return '<span class="rds-chat-attachment-chip inline-flex items-center gap-1 max-w-full border border-[#242b28] bg-[#0b0d0c] rounded px-2 py-1 font-ribbon text-ribbon text-on-surface-variant">' +
          '<span class="material-symbols-outlined text-[15px] text-primary-container">' + (isImage ? 'image' : 'attach_file') + '</span>' +
          '<span class="truncate max-w-[240px]" title="' + escapeChatHtml(file.name || 'attachment') + '">' + escapeChatHtml(file.name || 'attachment') + '</span>' +
          '<span class="text-outline">' + escapeChatHtml(formatChatFileSize(file.size)) + '</span>' +
          '<button type="button" onclick="rdsRemoveChatAttachment(' + idx + ')" class="ml-1 text-on-surface-variant hover:text-error" title="Remove attachment">×</button>' +
        '</span>';
      }).join('');
    }

    function renderActiveSession(session, forceBottom) {
      var log = document.getElementById('chat-log');
      var title = document.getElementById('chat-title');
      var buildLink = document.getElementById('chat-build-link');
      var buildActions = document.getElementById('chat-build-actions');
      var buildActionsId = document.getElementById('chat-build-actions-id');
      var openBuild = document.getElementById('chat-action-open-build');
      var renameBtn = document.getElementById('chat-rename-btn');
      var deleteBtn = document.getElementById('chat-delete-btn');
      var input = document.getElementById('chat-input');
      var sendBtn = document.getElementById('chat-send-btn');
      if (!log) return;
      if (!session) {
        rdsChatState.activeBuildId = '';
        title.textContent = 'New chat';
        if (buildLink) { buildLink.classList.add('hidden'); buildLink.innerHTML = ''; }
        if (buildActions) buildActions.classList.add('hidden');
        if (buildActionsId) buildActionsId.textContent = '';
        if (openBuild) openBuild.setAttribute('href', '#');
        if (renameBtn) renameBtn.classList.add('hidden');
        if (deleteBtn) deleteBtn.classList.add('hidden');
        log.innerHTML = '<div class="text-on-surface-variant italic font-table text-table p-3">Ask about a build, logs, QA, deployment state, or request a controlled iteration.</div>';
        if (input) { input.disabled = false; input.placeholder = 'Ask what failed, what changed, or what to check next…'; }
        if (sendBtn) sendBtn.disabled = false;
        return;
      }
      title.textContent = session.title;
      if (session.build_id) {
        rdsChatState.activeBuildId = session.build_id;
        // The build id already appears in the Build-context strip below the
        // header — repeating it next to the title just truncates both.
        if (buildLink) { buildLink.classList.add('hidden'); buildLink.innerHTML = ''; }
        if (buildActions) buildActions.classList.remove('hidden');
        if (buildActionsId) buildActionsId.textContent = session.build_id;
        if (openBuild) openBuild.setAttribute('href', '/b/' + encodeURIComponent(session.build_id));
      } else {
        rdsChatState.activeBuildId = '';
        if (buildLink) { buildLink.classList.add('hidden'); buildLink.innerHTML = ''; }
        if (buildActions) buildActions.classList.add('hidden');
        if (buildActionsId) buildActionsId.textContent = '';
        if (openBuild) openBuild.setAttribute('href', '#');
      }
      if (renameBtn) renameBtn.classList.remove('hidden');
      if (deleteBtn) deleteBtn.classList.remove('hidden');
      if (input) { input.disabled = false; input.placeholder = 'Ask what failed, what changed, or what to check next…'; }
      var turns = sortChatTurns(session.turns || []);
      if (!turns.length) {
        var greet = session.build_id
          ? "Hey — what can I help you with on build " + session.build_id + "?"
          : "Hey, what can I do for you?";
        log.innerHTML = '<div class="text-on-surface-variant italic font-table text-table p-3">' + escapeChatHtml(greet) + '</div>';
      } else {
        var prev = log.scrollHeight - log.scrollTop - log.clientHeight;
        var nearBottom = prev < 80;
        var html = '';
        var lastDay = '';
        for (var i = 0; i < turns.length; i++) {
          var dk = chatDayKey(turns[i].ts);
          if (dk && dk !== lastDay) {
            html += '<div class="rds-chat-day">' + escapeChatHtml(chatDayLabel(turns[i].ts)) + '</div>';
            lastDay = dk;
          }
          html += renderTurn(turns[i]);
        }
        log.innerHTML = html;
        if (nearBottom || forceBottom) requestAnimationFrame(function () { log.scrollTop = log.scrollHeight; });
      }
      var pending = turns.some(function (t) { return t.status === 'pending'; });
      var actionRunning = turns.some(function (t) { return t.action && isActionRunning(t.action); });
      if (sendBtn) sendBtn.disabled = pending;
      var statusEl = document.getElementById('chat-status');
      if (statusEl) statusEl.textContent = pending ? 'RDS is thinking…' : (actionRunning ? 'RDS action running…' : '');
    }

    async function fetchSession(id) {
      var res = await fetch('/chat/sessions/' + encodeURIComponent(id));
      if (!res.ok) return null;
      var data = await res.json();
      var s = data && data.session ? data.session : null;
      if (s) cacheSession(s);
      return s;
    }

    async function pollActive() {
      if (!rdsChatState.activeId) return;
      var s = await fetchSession(rdsChatState.activeId);
      if (!s || s.id !== rdsChatState.activeId) return;
      renderActiveSession(s);
      var pending = (s.turns || []).some(function (t) { return t.status === 'pending'; });
      var actionRunning = (s.turns || []).some(function (t) { return t.action && isActionRunning(t.action); });
      if (pending || actionRunning) {
        if (rdsChatState.pollTimer) clearTimeout(rdsChatState.pollTimer);
        rdsChatState.pollTimer = setTimeout(pollActive, 2000);
      }
    }

    async function markRead(id) {
      try {
        await fetch('/chat/sessions/' + encodeURIComponent(id) + '/read', {
          method: 'POST',
          headers: { 'X-RDS-Token': token() }
        });
      } catch (e) { /* ignore */ }
    }

    async function selectChatThread(id) {
      rdsChatState.activeId = id;
      toggleChatThreads(false);
      try { localStorage.setItem('rds_chat_active', id); } catch (e) {}
      try {
        var url = new URL(location.href);
        if (url.pathname === '/chat') {
          url.searchParams.set('s', id);
          history.replaceState(null, '', url.toString());
        }
      } catch (e) {}
      renderSessionList();
      // Render cached session immediately so the UI feels instant.
      var cached = loadCachedSession(id);
      if (cached) renderActiveSession(cached, true);
      var s = await fetchSession(id);
      renderActiveSession(s, true);
      markRead(id);
      loadSessions();
      rdsBumpUnreadBadge();
      if (rdsChatState.pollTimer) { clearTimeout(rdsChatState.pollTimer); rdsChatState.pollTimer = null; }
      if (s && (s.turns || []).some(function (t) { return t.status === 'pending'; })) {
        rdsChatState.pollTimer = setTimeout(pollActive, 2000);
      }
    }

    async function newChatThread(buildId) {
      var title = '';
      if (!buildId) {
        title = await rdsPrompt('Give the new thread a title (or leave blank to start instantly):', '',
          { title: 'New chat', okLabel: 'Create', placeholder: 'leave blank to start instantly' });
        if (title === null) return;
      }
      var body = { title: title || '' };
      if (buildId) body.build_id = buildId;
      var res = await fetch('/chat/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-RDS-Token': token() },
        body: JSON.stringify(body)
      });
      if (!res.ok) { rdsToast('create thread failed: ' + res.status, 'error'); return; }
      var data = await res.json();
      await loadSessions();
      if (data && data.session) selectChatThread(data.session.id);
    }

    async function renameChatThread() {
      var id = rdsChatState.activeId; if (!id) return;
      var current = (rdsChatState.sessions.find(function (s) { return s.id === id; }) || {}).title || '';
      var t = await rdsPrompt('Rename this thread:', current, { title: 'Rename thread', okLabel: 'Rename' });
      if (t === null) return;
      t = (t || '').trim();
      if (!t) { rdsToast('Title cannot be empty.', 'error'); return; }
      var clipped = t.slice(0, 120);
      var res = await fetch('/chat/sessions/' + encodeURIComponent(id) + '/title', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-RDS-Token': token() },
        body: JSON.stringify({ title: clipped })
      });
      if (!res.ok) { rdsToast('rename failed: ' + res.status, 'error'); return; }
      await loadSessions();
      var fresh = await fetchSession(id);
      renderActiveSession(fresh);
    }

    async function deleteChatThread() {
      var id = rdsChatState.activeId; if (!id) return;
      var current = (rdsChatState.sessions.find(function (s) { return s.id === id; }) || {}).title || 'this thread';
      var ok = await rdsConfirm('Delete "' + current + '"? History cannot be recovered.',
        { title: 'Delete thread?', danger: true, okLabel: 'Delete' });
      if (!ok) return;
      var res = await fetch('/chat/sessions/' + encodeURIComponent(id), {
        method: 'DELETE',
        headers: { 'X-RDS-Token': token() }
      });
      if (!res.ok) { rdsToast('delete failed: ' + res.status + ' ' + await res.text(), 'error'); return; }
      rdsChatState.activeId = '';
      try { localStorage.removeItem('rds_chat_active'); } catch (e) {}
      try { localStorage.removeItem('rds_chat_cache_v1'); } catch (e) {}
      await loadSessions();
      renderActiveSession(null);
      rdsBumpUnreadBadge();
    }

    async function runChatAction(turnId) {
      var id = rdsChatState.activeId;
      if (!id || !turnId) return;
      var s = await fetchSession(id);
      var turn = s && (s.turns || []).find(function (t) { return t.id === turnId; });
      var action = turn && turn.action;
      if (!action) { rdsToast('No action found for that message.', 'error'); return; }
      var ok = await rdsConfirm(
        'Run "' + (action.label || action.kind) + '" for build "' + action.build_id + '"?',
        { title: 'Confirm RDS action', okLabel: action.confirm_label || 'Run action', warn: true }
      );
      if (!ok) return;
      var statusEl = document.getElementById('chat-status');
      if (statusEl) statusEl.textContent = 'starting action…';
      try {
        var res = await fetch('/chat/sessions/' + encodeURIComponent(id) + '/actions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-RDS-Token': token() },
          body: JSON.stringify({ turn_id: turnId, confirm: 'RUN_ACTION' })
        });
        var text = await res.text();
        if (!res.ok) {
          rdsToast('Action failed to start: ' + res.status, 'error');
          if (statusEl) statusEl.textContent = 'action failed: ' + res.status + ' ' + text.slice(0, 120);
          return;
        }
        rdsToast('RDS action started.', 'info');
        if (statusEl) statusEl.textContent = '';
        var fresh = await fetchSession(id);
        renderActiveSession(fresh, true);
        loadSessions();
      } catch (e) {
        if (statusEl) statusEl.textContent = 'action failed: ' + e;
        rdsToast('Action failed to start: ' + e, 'error');
      }
    }

    function chatKeydown(ev) {
      if (ev.key === 'Enter' && !ev.shiftKey && !ev.ctrlKey && !ev.metaKey) {
        ev.preventDefault();
        submitChat(ev);
      }
    }

    function chatQuickAction(kind) {
      var ta = document.getElementById('chat-input');
      if (!ta) return;
      var message = '';
      if (kind === 'claude-worker') {
        message = 'Start a Claude Code worker for this build. Review the current app, identify the highest-impact usability and correctness issues, and propose a focused patch. Do not merge or push anything.';
      } else if (kind === 'codex-review') {
        message = 'Start a Codex worker to review this build. Use the PRD, current app, logs, QA artifacts, and screenshots if attached. Report what is broken and what should be patched next. Do not merge or push anything.';
      } else if (kind === 'iteration') {
        message = 'Run a targeted iteration on this build. Focus on the most visible product/UI failure, preserve existing data, and verify with screenshots and tests.';
      }
      if (!message) return;
      ta.value = message;
      ta.focus();
      ta.selectionStart = ta.selectionEnd = ta.value.length;
      var statusEl = document.getElementById('chat-status');
      if (statusEl) statusEl.textContent = 'Review the prefilled request, then Send.';
    }

    async function submitChat(ev) {
      if (ev && ev.preventDefault) ev.preventDefault();
      var ta = document.getElementById('chat-input');
      var msg = (ta.value || '').trim();
      var files = rdsChatState.attachments || [];
      if (!msg && !files.length) return false;
      var id = rdsChatState.activeId;
      if (!id) {
        // No thread selected — auto-create one with first words as title.
        var title = (msg || (files[0] && files[0].name) || 'Attached files').split(/\\s+/).slice(0, 6).join(' ').slice(0, 60) || 'New chat';
        var res = await fetch('/chat/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-RDS-Token': token() },
          body: JSON.stringify({ title: title })
        });
        if (!res.ok) { rdsToast('create thread failed: ' + res.status, 'error'); return false; }
        var data = await res.json();
        id = data.session.id;
        rdsChatState.activeId = id;
        await loadSessions();
      }
      ta.value = '';
      var sendBtn = document.getElementById('chat-send-btn');
      if (sendBtn) sendBtn.disabled = true;
      var statusEl = document.getElementById('chat-status');
      if (statusEl) statusEl.textContent = files.length ? 'uploading…' : 'sending…';
      try {
        var body;
        var headers = { 'X-RDS-Token': token() };
        if (files.length) {
          body = new FormData();
          body.set('message', msg);
          files.forEach(function (file) { body.append('attachments', file, file.name); });
        } else {
          headers['Content-Type'] = 'application/json';
          body = JSON.stringify({ message: msg });
        }
        var sendRes = await fetch('/chat/sessions/' + encodeURIComponent(id) + '/messages', {
          method: 'POST',
          headers: headers,
          body: body
        });
        if (!sendRes.ok) {
          var t = await sendRes.text();
          if (statusEl) statusEl.textContent = 'send failed: ' + sendRes.status + ' ' + t.slice(0, 180);
          if (sendBtn) sendBtn.disabled = false;
          return false;
        }
      } catch (e) {
        if (statusEl) statusEl.textContent = 'send failed: ' + (e && e.message ? e.message : e);
        if (sendBtn) sendBtn.disabled = false;
        return false;
      }
      clearChatAttachments();
      // Optimistically refresh then poll.
      var fresh = await fetchSession(id);
      renderActiveSession(fresh);
      loadSessions();
      if (rdsChatState.pollTimer) clearTimeout(rdsChatState.pollTimer);
      rdsChatState.pollTimer = setTimeout(pollActive, 2000);
      return false;
    }

    function setupChatDropzone() {
      var form = document.getElementById('chat-form');
      var drop = document.getElementById('chat-dropzone');
      if (!form || !drop || form.dataset.dropReady === '1') return;
      form.dataset.dropReady = '1';
      ['dragenter','dragover'].forEach(function (name) {
        form.addEventListener(name, function (ev) {
          ev.preventDefault();
          drop.classList.remove('hidden');
          drop.classList.add('dropzone-hot');
        });
      });
      ['dragleave','drop'].forEach(function (name) {
        form.addEventListener(name, function (ev) {
          ev.preventDefault();
          if (name === 'drop' && ev.dataTransfer && ev.dataTransfer.files) rdsChatAddFiles(ev.dataTransfer.files);
          drop.classList.add('hidden');
          drop.classList.remove('dropzone-hot');
        });
      });
    }

    async function submitOverviewChat(ev) {
      if (ev && ev.preventDefault) ev.preventDefault();
      var input = document.getElementById('overview-chat-input');
      var status = document.getElementById('overview-chat-status');
      var buildId = window.RDS_BUILD_ID || '';
      var msg = input ? (input.value || '').trim() : '';
      if (!msg || !buildId) return false;
      if (status) status.textContent = 'sending…';
      try {
        var byBuild = await fetch('/chat/sessions/by-build/' + encodeURIComponent(buildId), {
          method: 'POST',
          headers: { 'X-RDS-Token': token() }
        });
        if (!byBuild.ok) throw new Error('thread ' + byBuild.status);
        var data = await byBuild.json();
        var sid = data.session.id;
        var send = await fetch('/chat/sessions/' + encodeURIComponent(sid) + '/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-RDS-Token': token() },
          body: JSON.stringify({ message: msg })
        });
        if (!send.ok) throw new Error('send ' + send.status + ' ' + (await send.text()).slice(0, 180));
        if (input) input.value = '';
        rdsChatState.activeId = sid;
        await loadSessions();
        showTab('chat');
        selectChatThread(sid);
        if (status) status.textContent = '';
      } catch (e) {
        if (status) status.textContent = 'send failed: ' + e;
      }
      return false;
    }

    async function rdsBumpUnreadBadge() {
      try {
        var res = await fetch('/chat/unread');
        if (!res.ok) return;
        var data = await res.json();
        var badge = document.getElementById('rds-chat-nav-badge');
        if (!badge) return;
        if (data.unread > 0) {
          badge.textContent = String(data.unread);
          badge.classList.remove('hidden');
        } else {
          badge.classList.add('hidden');
          badge.textContent = '';
        }
      } catch (e) { /* ignore */ }
    }

    async function bootChatPanel() {
      var panel = document.getElementById('chat-panel');
      if (!panel) return;
      // 1. Render from cache instantly so reload feels snappy.
      var hadCache = loadCachedSessions();
      var initial = (panel.getAttribute('data-initial-session') || '').trim();
      var initialBuild = (panel.getAttribute('data-initial-build') || '').trim();
      var stored = '';
      try { stored = localStorage.getItem('rds_chat_active') || ''; } catch (e) {}
      // If we have cache + a stored active id, paint right away.
      if (hadCache && !initial && !initialBuild && stored) {
        var cachedActive = loadCachedSession(stored);
        if (cachedActive) {
          rdsChatState.activeId = stored;
          renderSessionList();
          renderActiveSession(cachedActive);
        }
      }
      // 2. Refresh from network in the background.
      await loadSessions();
      var pickId = '';
      if (initial) pickId = initial;
      else if (initialBuild) {
        var byBuild = rdsChatState.sessions.find(function (s) { return s.build_id === initialBuild; });
        if (byBuild) pickId = byBuild.id;
        else {
          var res = await fetch('/chat/sessions/by-build/' + encodeURIComponent(initialBuild), {
            method: 'POST',
            headers: { 'X-RDS-Token': token() }
          });
          if (res.ok) {
            var data = await res.json();
            pickId = data.session.id;
            await loadSessions();
          }
        }
      } else if (stored && rdsChatState.sessions.find(function (s) { return s.id === stored; })) {
        pickId = stored;
      } else if (rdsChatState.sessions[0]) {
        pickId = rdsChatState.sessions[0].id;
      }
      // If nothing exists yet, render the empty-but-typeable state.
      if (!pickId) renderActiveSession(null);
      else if (pickId !== rdsChatState.activeId) selectChatThread(pickId);
      else { var fresh = await fetchSession(pickId); if (fresh) renderActiveSession(fresh); }
      // Refresh sidebar list every 5s to surface other-tab updates.
      if (rdsChatState.listTimer) clearInterval(rdsChatState.listTimer);
      rdsChatState.listTimer = setInterval(function () {
        loadSessions();
        if (rdsChatState.activeId) {
          fetchSession(rdsChatState.activeId).then(function (s) {
            if (!s || s.id !== rdsChatState.activeId) return;
            renderActiveSession(s);
            if (s.last_read_at < s.updated_at) markRead(s.id);
          });
        }
        rdsBumpUnreadBadge();
      }, 5000);
    }

    window.submitChat = submitChat;
    window.submitOverviewChat = submitOverviewChat;
    window.chatKeydown = chatKeydown;
    window.selectChatThread = selectChatThread;
    window.newChatThread = newChatThread;
    window.toggleChatThreads = toggleChatThreads;
    window.renameChatThread = renameChatThread;
    window.deleteChatThread = deleteChatThread;
    window.runChatAction = runChatAction;
    window.chatQuickAction = chatQuickAction;
    window.rdsChatAddFiles = rdsChatAddFiles;
    window.rdsRemoveChatAttachment = rdsRemoveChatAttachment;
    window.rdsBumpUnreadBadge = rdsBumpUnreadBadge;

    document.addEventListener('DOMContentLoaded', function () { setupChatDropzone(); bootChatPanel(); });
    if (document.readyState !== 'loading') { setupChatDropzone(); bootChatPanel(); }
  `;
}

function layout(title: string, body: string, opts: { nav?: NavKey; topbarTab?: "builds" | "overview" } = {}): string {
  const navKey: NavKey = opts.nav ?? "hub";
  // Styles are precompiled (tailwind.config.js → public/tailwind.css) and
  // served from /static — no CDN JIT, no unstyled flash, works offline.
  return `<!doctype html>
<html class="dark" lang="en">
<head>
<meta charset="utf-8">
<meta content="width=device-width, initial-scale=1.0" name="viewport">
<meta name="theme-color" content="#070908">
<title>${escapeHtml(title)} — RDS</title>
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" type="image/png" sizes="32x32" href="/static/favicon-32.png">
<link rel="icon" type="image/png" sizes="16x16" href="/static/favicon-16.png">
<link rel="apple-touch-icon" sizes="180x180" href="/static/apple-touch-icon.png">
<link rel="manifest" href="/site.webmanifest">
<link rel="stylesheet" href="/static/tailwind.css">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
<link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap" rel="stylesheet">
<script src="/static/ansi_up.min.js"></script>
<script>
  (function () {
    function primeMaterialIcons() {
      document.querySelectorAll('.material-symbols-outlined').forEach(function (el) {
        if (!el.getAttribute('data-icon')) {
          el.setAttribute('data-icon', (el.textContent || '').trim());
        }
        el.textContent = '';
        el.setAttribute('aria-hidden', 'true');
      });
    }
    primeMaterialIcons();
    document.addEventListener('DOMContentLoaded', function () {
      primeMaterialIcons();
      new MutationObserver(primeMaterialIcons).observe(document.body, { childList: true, subtree: true });
    });
    if (document.fonts && document.fonts.load) {
      document.fonts.load('16px "Material Symbols Outlined"').then(function (fonts) {
        if (fonts && fonts.length) document.documentElement.classList.add('rds-icons-ready');
      }).catch(function () {});
    }
  })();
</script>
<style>
  html { font-size: 16px; }
  :root {
    /* Native controls (checkboxes, radios, scrollbars, date pickers) follow
       the console theme instead of defaulting to platform blue. */
    accent-color: #6ad7a3;
    color-scheme: dark;
  }
  /* No cross-document view transitions: they freeze rendering during
     navigation snapshots, which breaks Playwright-driven QA (including our
     own selftest) waiting for elements to become stable. */
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      animation-duration: 0.01ms !important;
      animation-iteration-count: 1 !important;
      transition-duration: 0.01ms !important;
    }
  }
  body {
    font-family: "Inter", system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
    font-feature-settings: "cv05", "cv11", "ss01";
  }
  code, pre, kbd, samp {
    font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  input, select, textarea, button {
    font-size: 13.5px;
    font-family: inherit;
  }
  input, select {
    min-height: 36px;
  }
  button {
    min-height: 34px;
  }
  textarea {
    line-height: 1.55;
  }
  button, a {
    text-underline-offset: 3px;
  }
  :focus-visible {
    outline: 2px solid rgba(106, 215, 163, 0.55);
    outline-offset: 1px;
  }
  input:focus-visible, select:focus-visible, textarea:focus-visible {
    outline: none;
  }
  input[type="text"], input[type="search"], input[type="url"], input[type="number"], select, textarea {
    transition: border-color .15s ease, box-shadow .15s ease;
  }
  input[type="text"]:focus, input[type="search"]:focus, input[type="url"]:focus, input[type="number"]:focus, select:focus, textarea:focus {
    box-shadow: 0 0 0 3px rgba(106, 215, 163, 0.12);
  }
  .font-code {
    line-height: 1.55;
  }
  .rds-sidenav {
    width: 240px;
    background:
      radial-gradient(circle at 50% 120px, rgba(106, 215, 163, 0.10), transparent 210px),
      linear-gradient(180deg, rgba(16,20,18,.98), rgba(7,9,8,.99));
  }
  .rds-shell-panel {
    background: linear-gradient(180deg, rgba(20,25,23,.98), rgba(12,15,14,.98));
    border: 1px solid rgba(36,43,40,.92);
    box-shadow: inset 0 1px 0 rgba(255,255,255,.035), 0 18px 48px -36px rgba(0,0,0,.72);
  }
  .rds-page-header {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 16px;
  }
  .rds-page-eyebrow {
    color: #6ad7a3;
    font-family: var(--font-ribbon);
    font-size: 11px;
    line-height: 15px;
    font-weight: 760;
    text-transform: uppercase;
    letter-spacing: .08em;
  }
  .rds-page-title {
    margin-top: 3px;
    color: #eef5ee;
    font-family: var(--font-h1);
    font-size: 28px;
    line-height: 34px;
    font-weight: 780;
    letter-spacing: -0.02em;
  }
  .rds-page-copy {
    margin-top: 5px;
    max-width: 760px;
    color: #a5b0a9;
    font-family: var(--font-body);
    font-size: 14px;
    line-height: 21px;
  }
  .rds-action-primary,
  .rds-action-secondary,
  .rds-action-danger {
    min-height: 38px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    border-radius: 6px;
    padding: 8px 12px;
    font-family: var(--font-ribbon);
    font-size: 12.5px;
    line-height: 17px;
    font-weight: 750;
    /* Action labels never wrap — a two-line button reads as broken. */
    white-space: nowrap;
    transition: background .15s ease, border-color .15s ease, color .15s ease, transform .15s ease;
  }
  .rds-action-primary {
    border: 1px solid rgba(106,215,163,.72);
    background: #6ad7a3;
    color: #042315;
  }
  .rds-action-primary:hover {
    background: #7ee2ae;
    transform: translateY(-1px);
  }
  .rds-action-secondary {
    border: 1px solid rgba(36,43,40,.95);
    background: rgba(16,20,18,.86);
    color: #e9eeea;
  }
  .rds-action-secondary:hover {
    border-color: rgba(106,215,163,.42);
    background: rgba(27,33,30,.92);
    color: #f4fbf6;
  }
  .rds-action-danger {
    border: 1px solid rgba(255,180,171,.42);
    background: rgba(255,180,171,.08);
    color: #ffd3cd;
  }
  .rds-wire-globe {
    width: clamp(116px, 52vw, 150px);
    aspect-ratio: 1;
    margin: 0;
    display: grid;
    place-items: center;
    position: relative;
    filter: drop-shadow(0 0 22px rgba(106, 215, 163, 0.2));
  }
  .rds-wire-globe-wrap {
    display: flex;
    justify-content: center;
  }
  .rds-wire-globe-link {
    width: fit-content;
    display: flex;
    justify-content: center;
    border-radius: 999px;
    outline: none;
  }
  .rds-wire-globe-link:hover .rds-wire-globe,
  .rds-wire-globe-link:focus-visible .rds-wire-globe {
    filter: drop-shadow(0 0 26px rgba(106, 215, 163, 0.32));
  }
  .rds-wire-globe-link:focus-visible {
    box-shadow: 0 0 0 2px rgba(106, 215, 163, 0.66);
  }
  .rds-wire-globe::before {
    content: "";
    position: absolute;
    width: 72%;
    height: 12%;
    bottom: 7%;
    border-radius: 999px;
    background: radial-gradient(ellipse, rgba(106,215,163,.3), rgba(106,215,163,0) 70%);
    filter: blur(5px);
  }
  .rds-globe-canvas {
    display: block;
    width: 100%;
    height: 100%;
    border-radius: 50%;
    animation: rds-wire-globe-float 7s ease-in-out infinite;
  }
  @keyframes rds-wire-globe-float {
    0%, 100% { transform: translate3d(0, 0, 0); }
    50% { transform: translate3d(0, -5px, 0); }
  }
  @media (min-width: 768px) {
    .rds-sidenav {
      position: fixed !important;
      transform: none !important;
      inset: 0 auto 0 0 !important;
      z-index: 20 !important;
      flex: 0 0 240px !important;
    }
    .rds-app-shell {
      margin-left: 240px !important;
      min-width: 0 !important;
      width: calc(100vw - 240px) !important;
    }
  }
  @media (max-width: 767px) {
    .rds-wire-globe {
      width: 118px;
      margin-bottom: 8px;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .rds-globe-canvas {
      animation: none !important;
    }
  }
  .rds-sidenav a {
    min-height: 38px;
  }
  .rds-nav-item {
    border-radius: 7px;
    margin: 0 8px;
  }
  .rds-nav-item-active {
    box-shadow: inset 0 1px 0 rgba(255,255,255,.035);
  }
  .rds-main {
    font-size: 16px;
  }
  ::placeholder {
    color: #7d8781 !important;
    opacity: 1;
  }
  .rds-readable-dense,
  .rds-readable-dense * {
    line-height: 1.5;
  }
  .text-\\[9px\\] { font-size: 10.5px !important; line-height: 15px !important; }
  .text-\\[10px\\] { font-size: 11px !important; line-height: 16px !important; }
  .text-\\[11px\\] { font-size: 11.5px !important; line-height: 17px !important; }
  .text-\\[11\\.5px\\] { font-size: 12px !important; line-height: 17.5px !important; }
  .text-\\[12px\\] { font-size: 12.5px !important; line-height: 18px !important; }
  .text-\\[12\\.5px\\] { font-size: 13px !important; line-height: 19px !important; }
  .text-\\[13px\\] { font-size: 13px !important; line-height: 19.5px !important; }
  .text-\\[14px\\] { font-size: 13.5px !important; line-height: 20px !important; }
  .rds-build-title {
    display: block;
    max-width: min(980px, calc(100vw - 360px));
    font-size: 21px !important;
    line-height: 28px !important;
    letter-spacing: -0.01em;
    overflow-wrap: anywhere;
  }
  #overview-log,
  #log,
  #stage-log,
  #events,
  #diff-body,
  #file-viewer-body,
  #new-build-result {
    font-size: 12.5px !important;
    line-height: 20px !important;
  }
  #overview-log,
  #log,
  #stage-log,
  #events,
  #cmd-result,
  #new-build-result {
    white-space: pre-wrap !important;
    overflow-wrap: anywhere !important;
    word-break: break-word !important;
    overflow-x: hidden !important;
  }
  #trigger-textarea {
    font-size: 15px !important;
    line-height: 24px !important;
  }
  #prompt-attachments > span {
    min-height: 30px;
  }
  .custom-scrollbar::-webkit-scrollbar { width: 6px; height: 6px; }
  .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
  .custom-scrollbar::-webkit-scrollbar-thumb { background-color: #2c332f; border-radius: 999px; }
  .custom-scrollbar::-webkit-scrollbar-thumb:hover { background-color: #39413c; }
  .panel-border { border: 1px solid #242b28; }
  .dropzone-hot { border-color: #6ad7a3 !important; background: rgba(106,215,163,0.08) !important; }
  .conn-on { color: #6ad7a3 !important; }
  .conn-off { color: #ffb4ab !important; }
  .conn-on > span:first-child { background-color: #6ad7a3 !important; box-shadow: 0 0 8px rgba(106, 215, 163, 0.45); }
  .conn-off > span:first-child { background-color: #ffb4ab !important; box-shadow: 0 0 8px rgba(255, 180, 171, 0.35); }
  .rds-hub-card {
    background: linear-gradient(180deg, rgba(23,29,26,.98), rgba(16,20,18,.98));
    border-color: rgba(36,43,40,.9);
    box-shadow: inset 0 1px 0 rgba(255,255,255,.03), 0 1px 2px rgba(0,0,0,.25), 0 8px 24px -18px rgba(0,0,0,.6);
    transition: border-color .16s ease, transform .16s ease, box-shadow .16s ease;
  }
  .rds-hub-card:hover {
    border-color: rgba(106,215,163,.28);
    transform: translateY(-1px);
    box-shadow: inset 0 1px 0 rgba(255,255,255,.035), 0 18px 44px -34px rgba(0,0,0,.8);
  }
  .rds-hub-card h2 {
    letter-spacing: 0;
  }
  .rds-hub-card .font-table {
    color: #b8c3bb;
  }
  .rds-hub-card-compact {
    min-height: 136px;
  }
  .rds-watchdog-strip {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    min-height: 44px;
    border: 1px solid rgba(36,43,40,.75);
    border-radius: 8px;
    background: rgba(7,9,8,.45);
    padding: 8px 10px;
  }
  .rds-recent-build-row {
    display: flex;
    flex-direction: column;
    gap: 5px;
    min-height: 68px;
    border: 1px solid rgba(36,43,40,.58);
    border-radius: 8px;
    padding: 8px 10px;
    background: rgba(7,9,8,.34);
    color: #e9eeea;
    transition: background .15s ease, border-color .15s ease, transform .15s ease;
  }
  .rds-recent-build-row:hover {
    background: rgba(27,33,30,.82);
    border-color: rgba(106,215,163,.28);
    transform: translateY(-1px);
  }
  .rds-recent-build-top,
  .rds-recent-build-title-wrap,
  .rds-recent-build-bottom {
    display: flex;
    align-items: center;
    min-width: 0;
  }
  .rds-recent-build-top {
    justify-content: space-between;
    gap: 10px;
  }
  .rds-recent-build-title-wrap {
    gap: 8px;
    flex: 1 1 auto;
  }
  .rds-recent-build-dot {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
  }
  .rds-recent-build-bottom {
    gap: 6px;
    flex-wrap: wrap;
  }
  .rds-recent-build-title,
  .rds-recent-build-id,
  .rds-recent-build-stage,
  .rds-recent-build-mode {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .rds-recent-build-title {
    font-family: var(--font-body);
    font-size: 13px;
    line-height: 18px;
    color: #e9eeea;
    min-width: 0;
  }
  .rds-recent-build-id {
    font-family: var(--font-code);
    font-size: 10.5px;
    line-height: 15px;
    color: #75817a;
  }
  .rds-recent-build-stage,
  .rds-recent-build-review,
  .rds-recent-build-mode {
    min-height: 22px;
    display: inline-flex;
    align-items: center;
    max-width: 100%;
    border: 1px solid rgba(36,43,40,.78);
    border-radius: 999px;
    background: rgba(16,20,18,.62);
    padding: 2px 8px;
    font-family: var(--font-ribbon);
    font-size: 11px;
    line-height: 16px;
    color: #a5b0a9;
  }
  .rds-recent-build-stage {
    color: #8beebb;
    border-color: rgba(106,215,163,.22);
    background: rgba(106,215,163,.055);
  }
  .rds-recent-build-review {
    color: #d3ddd6;
  }
  .rds-recent-build-age {
    color: #a5b0a9;
    font-family: var(--font-code);
    font-size: 11px;
    text-align: right;
    flex: 0 0 auto;
  }
  .rds-recent-build-host {
    display: inline-flex;
    min-width: 0;
  }
  .rds-builds-toolbar {
    min-height: 70px;
    box-shadow: 0 10px 20px rgba(0,0,0,.34);
  }
  .rds-scroll-table {
    isolation: isolate;
  }
  .rds-desktop-table thead {
    box-shadow: 0 1px 0 rgba(36,43,40,.95), 0 8px 18px rgba(0,0,0,.22);
  }
  .rds-build-filter-panel {
    background: linear-gradient(180deg, rgba(11,13,12,.98), rgba(7,9,8,.99));
  }
  .rds-filter-option-list {
    display: grid;
    gap: 5px;
  }
  .rds-filter-option-list-scroll {
    max-height: 220px;
    overflow-y: auto;
    padding-right: 2px;
  }
  .rds-filter-option {
    display: grid;
    grid-template-columns: 16px minmax(0, 1fr) auto;
    align-items: center;
    gap: 7px;
    min-height: 30px;
    border: 1px solid rgba(36,43,40,.78);
    border-radius: 7px;
    background: rgba(16,20,18,.56);
    padding: 5px 7px;
    cursor: pointer;
    transition: border-color .15s ease, background .15s ease;
  }
  .rds-filter-option:hover {
    border-color: rgba(106,215,163,.35);
    background: rgba(27,33,30,.72);
  }
  .rds-build-filter-panel input[type="checkbox"] {
    width: 13px !important;
    height: 13px !important;
    min-width: 13px !important;
    min-height: 13px !important;
    border-radius: 3px !important;
    border-color: #39413c !important;
    background-color: #070908 !important;
  }
  .rds-filter-option span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .rds-segmented-filter {
    border: 1px solid rgba(36,43,40,.85);
    border-radius: 8px;
    background: #070908;
    padding: 3px;
  }
  .rds-segmented-filter button {
    min-height: 28px;
    border-radius: 6px;
    color: #a5b0a9;
    font-family: var(--font-table);
    font-size: 12px;
    transition: background .15s ease, color .15s ease;
  }
  .rds-segmented-filter button.is-active {
    background: #1b211e;
    color: #e9eeea;
    box-shadow: inset 0 0 0 1px rgba(106,215,163,.36);
  }
  .rds-hub-activity .font-code,
  .rds-hub-card table {
    font-size: 12px;
    line-height: 18px;
  }
  .rds-header-details summary {
    min-height: 36px;
  }
  .rds-command-center {
    border: 1px solid rgba(36,43,40,.9);
    border-radius: 4px;
    background: linear-gradient(180deg, rgba(16,20,18,.99), rgba(11,13,12,.99));
    box-shadow: inset 0 1px 0 rgba(255,255,255,.03);
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .rds-command-bad {
    border-color: rgba(255,180,171,.42);
  }
  .rds-command-warn {
    border-color: rgba(255,216,130,.36);
  }
  .rds-command-good {
    border-color: rgba(106,215,163,.36);
  }
  .rds-command-main {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
  }
  .rds-command-verdict {
    min-width: 0;
    display: flex;
    align-items: flex-start;
    gap: 12px;
  }
  .rds-command-bad .rds-command-verdict .material-symbols-outlined {
    color: #ffb4ab;
  }
  .rds-command-warn .rds-command-verdict .material-symbols-outlined {
    color: #f2c572;
  }
  .rds-command-good .rds-command-verdict .material-symbols-outlined {
    color: #8beebb;
  }
  .rds-command-kicker,
  .rds-command-label {
    color: #8beebb;
    font-family: var(--font-ribbon);
    font-size: 12px;
    line-height: 16px;
    font-weight: 800;
    text-transform: uppercase;
  }
  .rds-command-verdict h2 {
    margin: 1px 0 0;
    color: #eef5ee;
    font-family: var(--font-h1);
    font-size: 24px;
    line-height: 30px;
    font-weight: 720;
  }
  .rds-command-verdict p {
    margin-top: 4px;
    color: #a5b0a9;
    font-family: var(--font-body);
    font-size: 15px;
    line-height: 22px;
    max-width: 760px;
  }
  .rds-command-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 8px;
    max-width: 520px;
  }
  .rds-command-live {
    border: 1px solid rgba(106,215,163,.32);
    border-radius: 4px;
    background: rgba(106,215,163,.055);
    padding: 10px 12px;
    min-width: 0;
  }
  .rds-command-live-row {
    margin-top: 5px;
    display: grid;
    grid-template-columns: auto minmax(0,1fr) auto;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .rds-command-live-row .material-symbols-outlined {
    color: #8beebb;
  }
  .rds-command-live-row a {
    min-width: 0;
    color: #8beebb;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 12px;
    line-height: 18px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .rds-command-live-row button {
    min-height: 28px;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    border: 1px solid rgba(106,215,163,.35);
    border-radius: 4px;
    background: rgba(14,17,15,.72);
    color: #dcf2e6;
    padding: 4px 8px;
    font-family: var(--font-ribbon);
    font-size: 12px;
    line-height: 16px;
    font-weight: 700;
  }
  .rds-command-action {
    min-height: 36px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    border: 1px solid rgba(36,43,40,.95);
    border-radius: 4px;
    background: rgba(14,17,15,.72);
    color: #e9eeea;
    padding: 7px 11px;
    font-family: var(--font-ribbon);
    font-size: 13px;
    line-height: 18px;
    font-weight: 720;
    transition: background .15s ease, border-color .15s ease;
  }
  .rds-command-action:hover {
    background: rgba(27,33,30,.9);
    border-color: rgba(106,215,163,.45);
  }
  .rds-command-action:disabled {
    opacity: .55;
    cursor: not-allowed;
  }
  .rds-command-engine {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    padding: 9px 11px;
    border: 1px solid rgba(36,43,40,.7);
    border-radius: 4px;
    background: rgba(14,17,15,.5);
  }
  .rds-command-ask {
    border: 1px solid rgba(36,43,40,.78);
    border-radius: 4px;
    background: rgba(7,9,8,.42);
    padding: 9px 10px;
  }
  .rds-command-ask-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    margin-bottom: 7px;
  }
  .rds-command-ask-head .rds-command-label {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .rds-command-ask-link {
    color: #8beebb;
    font-family: var(--font-code);
    font-size: 11px;
    line-height: 16px;
  }
  .rds-command-ask-link:hover {
    text-decoration: underline;
  }
  .rds-command-ask-form {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 8px;
  }
  .rds-command-ask-input {
    min-height: 36px;
    border: 1px solid rgba(36,43,40,.95);
    border-radius: 4px;
    background: rgba(10,12,11,.86);
    color: #e9eeea;
    padding: 7px 10px;
    font-family: var(--font-code);
    font-size: 12.5px;
    line-height: 18px;
  }
  .rds-command-ask-input:focus {
    outline: none;
    border-color: rgba(106,215,163,.55);
    box-shadow: 0 0 0 2px rgba(106,215,163,.08);
  }
  .rds-command-ask-submit {
    min-height: 36px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    border-radius: 4px;
    background: #6ad7a3;
    color: #042315;
    padding: 7px 12px;
    font-family: var(--font-ribbon);
    font-size: 13px;
    line-height: 18px;
    font-weight: 760;
  }
  .rds-command-ask-status {
    min-height: 14px;
    margin-top: 4px;
    color: #a5b0a9;
    font-family: var(--font-ribbon);
    font-size: 11px;
    line-height: 14px;
  }
  .rds-overview-top-grid {
    align-items: start;
  }
  .rds-overview-top-grid > * {
    min-width: 0;
  }
  .rds-goal-panel,
  .rds-overview-top-grid > section:first-child {
    min-height: 0;
  }
  .rds-doc-panel-compact {
    min-height: 0;
  }
  .rds-doc-section-head,
  .rds-doc-autonomy-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 18px;
  }
  .rds-doc-count {
    border: 1px solid rgba(36,43,40,.88);
    border-radius: 999px;
    background: rgba(7,9,8,.42);
    color: #a5b0a9;
    padding: 3px 8px;
    font-family: var(--font-ribbon);
    font-size: 11px;
    line-height: 16px;
    white-space: nowrap;
  }
  .rds-doc-status-list,
  .rds-doc-directory {
    display: grid;
    gap: 0;
    border: 1px solid rgba(36,43,40,.78);
    border-radius: 8px;
    overflow: hidden;
    background: rgba(7,9,8,.25);
  }
  .rds-doc-mini-row,
  .rds-doc-directory-row {
    display: grid;
    grid-template-columns: minmax(140px,.34fr) minmax(190px,.36fr) minmax(0,1fr);
    align-items: baseline;
    gap: 12px;
    min-width: 0;
    border-bottom: 1px solid rgba(36,43,40,.62);
    /* rows read as list lines, not nested boxes (DESIGN: light, not boxes) */
    background: transparent;
    padding: 10px 12px;
  }
  .rds-doc-mini-row:last-child,
  .rds-doc-directory-row:last-child {
    border-bottom: 0;
  }
  .rds-doc-mini-row {
    grid-template-columns: minmax(130px,.34fr) minmax(0,1fr);
  }
  .rds-doc-directory-row .font-code,
  .rds-doc-directory-row p,
  .rds-doc-mini-row p {
    min-width: 0;
  }
  .rds-doc-directory-row p {
    margin: 0;
  }
  .rds-doc-autonomy-row p {
    max-width: 760px;
    margin: 0;
  }
  .rds-command-engine-label {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    color: #8beebb;
    font-family: var(--font-body);
    font-size: 11px;
    line-height: 16px;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: .03em;
  }
  .rds-command-engine-select,
  .rds-command-engine-input {
    min-height: 30px;
    border: 1px solid rgba(36,43,40,.95);
    border-radius: 4px;
    background: rgba(10,12,11,.85);
    color: #e6efe7;
    padding: 4px 8px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 12.5px;
    line-height: 18px;
  }
  .rds-command-engine-input {
    width: 200px;
    max-width: 100%;
  }
  .rds-command-engine-select:focus,
  .rds-command-engine-input:focus {
    outline: none;
    border-color: rgba(106,215,163,.55);
  }
  .rds-command-engine-hint {
    color: #8b968f;
    font-family: var(--font-ribbon);
    font-size: 11.5px;
    line-height: 16px;
    flex: 1 1 180px;
    min-width: 0;
  }
  .rds-command-action-primary {
    border-color: rgba(106,215,163,.55);
    background: #6ad7a3;
    color: #042315;
  }
  .rds-command-action-primary:hover {
    background: #7ee2ae;
  }
  .rds-command-action-danger {
    border-color: rgba(255,180,171,.42);
    color: #ffd3cd;
    background: rgba(255,180,171,.09);
  }
  .rds-command-grid {
    display: grid;
    grid-template-columns: minmax(0, 1.2fr) minmax(280px, .8fr);
    gap: 10px;
    align-items: start;
  }
  .rds-command-panel {
    border: 1px solid rgba(36,43,40,.82);
    border-radius: 4px;
    background: rgba(14,17,15,.58);
    padding: 11px;
    min-width: 0;
  }
  .rds-blocker-list {
    margin-top: 8px;
    display: grid;
    gap: 8px;
  }
  .rds-blocker-item {
    min-width: 0;
    border: 1px solid rgba(255,180,171,.18);
    border-radius: 4px;
    background: rgba(255,180,171,.045);
    padding: 9px 10px;
  }
  .rds-blocker-head {
    display: grid;
    grid-template-columns: 22px minmax(0, 1fr) auto;
    align-items: center;
    gap: 8px;
  }
  .rds-blocker-index {
    width: 20px;
    height: 20px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid rgba(255,180,171,.26);
    border-radius: 999px;
    color: #ffd3cd;
    background: rgba(11,13,12,.8);
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 11px;
    line-height: 16px;
  }
  .rds-blocker-head strong {
    min-width: 0;
    color: #ffd3cd;
    font-family: var(--font-ribbon);
    font-size: 13px;
    line-height: 18px;
    font-weight: 760;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .rds-blocker-severity {
    border: 1px solid rgba(255,180,171,.22);
    border-radius: 999px;
    color: #ffb4ab;
    background: rgba(11,13,12,.72);
    padding: 2px 7px;
    font-family: var(--font-body);
    font-size: 11px;
    line-height: 15px;
    font-weight: 760;
  }
  .rds-blocker-item p {
    margin-top: 6px;
    min-width: 0;
    color: #d9e1da;
    font-family: var(--font-ribbon);
    font-size: 13px;
    line-height: 18px;
    overflow-wrap: anywhere;
  }
  .rds-blocker-next {
    margin-top: 6px;
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 7px;
    color: #a5b0a9;
    font-family: var(--font-body);
    font-size: 12.5px;
    line-height: 18px;
  }
  .rds-blocker-next span {
    color: #8beebb;
    font-weight: 780;
    text-transform: uppercase;
    font-size: 11px;
    line-height: 18px;
  }
  .rds-blocker-next b {
    min-width: 0;
    color: #a5b0a9;
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .rds-blocker-source {
    margin-top: 6px;
  }
  .rds-blocker-source summary {
    width: fit-content;
    max-width: 100%;
    cursor: pointer;
    color: #7d8781;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 11px;
    line-height: 16px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .rds-blocker-source code {
    display: block;
    margin-top: 4px;
    color: #7d8781;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 11px;
    line-height: 16px;
    overflow-wrap: anywhere;
  }
  .rds-command-muted {
    margin-top: 8px;
    color: #9aa69f;
    font-size: 14px;
    line-height: 20px;
  }
  .rds-command-link {
    margin-top: 10px;
    color: #6ad7a3;
    font-family: ui-monospace;
    font-size: 12px;
    line-height: 18px;
  }
  .rds-command-chips {
    margin-top: 8px;
    display: flex;
    flex-wrap: wrap;
    gap: 7px;
  }
  .rds-command-chips span {
    min-height: 28px;
    display: inline-flex;
    align-items: center;
    border: 1px solid rgba(36,43,40,.9);
    border-radius: 999px;
    background: rgba(11,13,12,.72);
    color: #a5b0a9;
    padding: 4px 9px;
    font-family: var(--font-ribbon);
    font-size: 12.5px;
    line-height: 18px;
    font-weight: 650;
  }
  .rds-live-term-watch {
    min-height: 30px;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    border: 1px solid rgba(106,215,163,.35);
    border-radius: 4px;
    background: rgba(14,17,15,.72);
    color: #dcf2e6;
    padding: 4px 8px;
    font-family: var(--font-ribbon);
    font-size: 12px;
    line-height: 16px;
    font-weight: 760;
  }
  .rds-goal-mobile-summary {
    display: none;
  }
  .rds-detail-disclosure > summary {
    min-height: 42px;
  }
  .rds-truth-card {
    background: linear-gradient(180deg, rgba(16,20,18,.99), rgba(11,13,12,.99));
    box-shadow: inset 0 1px 0 rgba(255,255,255,.03);
  }
  .rds-truth-good {
    border-color: rgba(106,215,163,.34);
  }
  .rds-truth-warn {
    border-color: rgba(255,216,130,.34);
  }
  .rds-truth-bad {
    border-color: rgba(255,180,171,.4);
  }
  .rds-truth-icon,
  .rds-truth-good .rds-truth-kicker {
    color: #8beebb;
  }
  .rds-truth-warn .rds-truth-icon,
  .rds-truth-warn .rds-truth-kicker {
    color: #f2c572;
  }
  .rds-truth-bad .rds-truth-icon,
  .rds-truth-bad .rds-truth-kicker {
    color: #ffb4ab;
  }
  .rds-truth-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    justify-content: flex-end;
    max-width: 440px;
  }
  .rds-truth-meta span {
    min-height: 28px;
    display: inline-flex;
    align-items: center;
    border: 1px solid rgba(36,43,40,.9);
    border-radius: 999px;
    background: rgba(14,17,15,.72);
    color: #a5b0a9;
    padding: 4px 9px;
    font-family: var(--font-body);
    font-size: 12.5px;
    line-height: 18px;
    font-weight: 650;
  }
  .rds-truth-blockers {
    display: grid;
    gap: 8px;
  }
  .rds-truth-blocker {
    border: 1px solid rgba(255,180,171,.28);
    background: rgba(255,180,171,.055);
    border-radius: 4px;
    padding: 10px;
  }
  .rds-truth-blocker strong {
    color: #ffd3cd;
    font-family: var(--font-ribbon);
    font-size: 13.5px;
    line-height: 19px;
  }
  .rds-truth-blocker code {
    max-width: 45%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: #7d8781;
    font-family: ui-monospace;
    font-size: 11px;
    line-height: 16px;
  }
  .rds-truth-blocker p {
    color: #e9eeea;
    font-family: var(--font-ribbon);
    font-size: 14px;
    line-height: 20px;
    margin-top: 3px;
  }
  .rds-truth-blocker span,
  .rds-truth-empty {
    display: block;
    color: #9aa69f;
    font-family: var(--font-body);
    font-size: 13px;
    line-height: 19px;
    margin-top: 4px;
  }
  .rds-quality-ledger {
    background: linear-gradient(180deg, rgba(16,20,18,.99), rgba(11,13,12,.99));
    box-shadow: inset 0 1px 0 rgba(255,255,255,.03);
  }
  .rds-ledger-blocker-count {
    display: inline-flex;
    align-items: center;
    min-height: 30px;
    border-radius: 3px;
    border: 1px solid #242b28;
    padding: 4px 10px;
    font-family: var(--font-body);
    font-size: 13px;
    line-height: 18px;
    font-weight: 700;
  }
  .rds-ledger-blocker-count-bad {
    border-color: rgba(255,180,171,.42);
    background: rgba(255,180,171,.1);
    color: #ffb4ab;
  }
  .rds-ledger-blocker-count-good {
    border-color: rgba(106,215,163,.38);
    background: rgba(106,215,163,.1);
    color: #6ad7a3;
  }
  .rds-ledger-blockers {
    border: 1px solid rgba(255,180,171,.32);
    background: rgba(255,180,171,.075);
    border-radius: 4px;
    padding: 10px;
  }
  .rds-ledger-blockers span {
    display: inline-flex;
    min-height: 28px;
    align-items: center;
    border: 1px solid rgba(255,180,171,.3);
    background: rgba(11,13,12,.72);
    color: #ffd3cd;
    border-radius: 3px;
    padding: 4px 9px;
    font-family: var(--font-ribbon);
    font-size: 13px;
    line-height: 18px;
    font-weight: 650;
  }
  .rds-input-docs {
    background: linear-gradient(180deg, rgba(16,20,18,.99), rgba(11,13,12,.98));
    box-shadow: inset 0 1px 0 rgba(255,255,255,.035);
  }
  .rds-input-doc-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    gap: 10px;
  }
  .rds-input-doc-card {
    min-width: 0;
    border: 1px solid rgba(36,43,40,.9);
    background: rgba(14,17,15,.74);
    border-radius: 4px;
    padding: 11px;
  }
  .rds-input-doc-kind {
    display: inline-flex;
    align-items: center;
    min-height: 22px;
    border: 1px solid rgba(106,215,163,.25);
    background: rgba(106,215,163,.08);
    color: #b6f0d2;
    border-radius: 3px;
    padding: 2px 6px;
    font-family: var(--font-body);
    font-size: 10.5px;
    line-height: 14px;
    font-weight: 750;
    text-transform: uppercase;
  }
  .rds-input-doc-actions {
    margin-top: 10px;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
  }
  .rds-input-doc-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-height: 28px;
    border: 1px solid rgba(36,43,40,.95);
    background: rgba(16,20,18,.86);
    color: #e9eeea;
    border-radius: 3px;
    padding: 4px 8px;
    font-family: var(--font-ribbon);
    font-size: 12px;
    line-height: 16px;
    font-weight: 650;
    transition: border-color .15s ease, color .15s ease, background .15s ease;
  }
  .rds-input-doc-btn:hover {
    border-color: rgba(106,215,163,.75);
    color: #6ad7a3;
    background: rgba(106,215,163,.08);
  }
  .rds-ledger-metric {
    min-height: 118px;
    border: 1px solid rgba(36,43,40,.9);
    background: rgba(14,17,15,.72);
    border-radius: 4px;
    padding: 12px;
  }
  .rds-ledger-metric-label {
    color: #a5b0a9;
    font-family: var(--font-body);
    font-size: 12px;
    line-height: 16px;
    font-weight: 700;
    text-transform: uppercase;
  }
  .rds-ledger-metric-value {
    margin-top: 5px;
    color: #e9eeea;
    font-family: ui-monospace;
    font-size: 18px;
    line-height: 24px;
    font-weight: 650;
  }
  .rds-ledger-metric-note,
  .rds-ledger-path {
    margin-top: 4px;
    color: #9aa69f;
    font-family: var(--font-ribbon);
    font-size: 13px;
    line-height: 18px;
  }
  .rds-ledger-path {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: ui-monospace;
    font-size: 11.5px;
    color: #7d8781;
  }
  .rds-ledger-artifact {
    margin-top: 7px;
    color: #7d8781;
    font-family: ui-monospace;
    font-size: 11px;
    line-height: 16px;
  }
  .rds-ledger-artifact summary {
    width: fit-content;
    max-width: 100%;
    cursor: pointer;
    color: #8f9a92;
  }
  .rds-ledger-artifact code {
    display: block;
    margin-top: 4px;
    overflow-wrap: anywhere;
  }
  .rds-stage-log-snippet {
    border: 1px solid rgba(36,43,40,.82);
    border-radius: 4px;
    background: rgba(11,13,12,.72);
  }
  .rds-stage-log-snippet summary {
    min-height: 32px;
    display: flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
    padding: 6px 9px;
    color: #a5b0a9;
    font-family: var(--font-body);
    font-size: 12.5px;
    line-height: 18px;
    font-weight: 700;
  }
  .rds-stage-log-snippet ul {
    border-top: 1px solid rgba(36,43,40,.72);
    padding: 10px 12px;
    max-height: 180px;
    overflow-y: auto;
    list-style: disc inside;
    color: #a5b0a9;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 11px;
    line-height: 17px;
  }
  .rds-ledger-attempt {
    margin-top: 9px;
    border-top: 1px solid rgba(36,43,40,.72);
    padding-top: 8px;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 5px 9px;
    color: #9aa69f;
    font-family: ui-monospace;
    font-size: 11.5px;
    line-height: 16px;
  }
  .rds-ledger-attempt span {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .rds-ledger-attempt strong {
    color: #6ad7a3;
    font-weight: 750;
  }
  .rds-ledger-attempt code {
    max-width: 100%;
    color: #7d8781;
    overflow-wrap: anywhere;
  }
  .rds-ledger-attempt-missing strong {
    color: #f2c572;
  }
  .rds-ledger-pill {
    display: inline-flex;
    align-items: center;
    min-height: 28px;
    border-radius: 999px;
    border: 1px solid;
    padding: 4px 9px;
    font-family: var(--font-ribbon);
    font-size: 13px;
    line-height: 18px;
    font-weight: 650;
  }
  .rds-ledger-pill-bad {
    border-color: rgba(255,180,171,.38);
    background: rgba(255,180,171,.09);
    color: #ffb4ab;
  }
  .rds-ledger-pill-good {
    border-color: rgba(106,215,163,.35);
    background: rgba(106,215,163,.08);
    color: #8beebb;
  }
  .rds-ledger-check-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
  }
  .rds-ledger-check {
    border: 1px solid rgba(36,43,40,.9);
    background: rgba(14,17,15,.68);
    border-radius: 4px;
    padding: 12px;
  }
  .rds-ledger-check-bad {
    border-color: rgba(255,180,171,.38);
    background: rgba(255,180,171,.055);
  }
  .rds-ledger-check-good {
    border-color: rgba(106,215,163,.25);
  }
  .rds-ledger-status {
    flex: 0 0 auto;
    border-radius: 999px;
    border: 1px solid;
    padding: 2px 7px;
    font-family: var(--font-ribbon);
    font-size: 12px;
    line-height: 16px;
    font-weight: 700;
  }
  .rds-ledger-status-bad {
    border-color: rgba(255,180,171,.38);
    color: #ffb4ab;
    background: rgba(255,180,171,.09);
  }
  .rds-ledger-status-good {
    border-color: rgba(106,215,163,.35);
    color: #8beebb;
    background: rgba(106,215,163,.08);
  }
  .rds-ledger-evidence {
    margin-top: 8px;
    color: #a5b0a9;
    font-family: var(--font-body);
    font-size: 13.5px;
    line-height: 20px;
    overflow-wrap: anywhere;
  }
  .rds-ledger-step {
    display: grid;
    grid-template-columns: 58px minmax(120px,.8fr) minmax(0,1.2fr);
    gap: 8px;
    color: #e9eeea;
    font-family: ui-monospace;
    font-size: 12.5px;
    line-height: 18px;
  }
  .rds-current-stage {
    min-height: 34px;
    white-space: nowrap;
  }
  .rds-build-header,
  .rds-build-title-row,
  .rds-build-identity,
  .rds-header-ops {
    min-width: 0;
  }
  .rds-build-title {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .rds-meta-chip {
    min-height: 46px;
    min-width: 132px;
    max-width: 100%;
  }
  .rds-header-ops {
    padding-top: 2px;
  }
  .rds-header-ops [data-conn],
  .rds-header-ops [data-refresh-cost],
  .rds-header-ops .rds-hosting-pill,
  .rds-header-ops .rds-elapsed-pill {
    min-height: 30px;
    max-width: 100%;
    min-width: 0;
  }
  .rds-header-ops > span:not(.rds-ops-divider),
  .rds-header-ops > button {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .rds-header-actions:empty {
    display: none !important;
  }
  body:has(#tab-live-log:not(.hidden)) .rds-activity-rail {
    display: none !important;
  }
  .rds-decision-card {
    background: linear-gradient(180deg, rgba(23,29,25,.96), rgba(12,17,14,.96));
  }
  .rds-plan-chip {
    display: inline-flex;
    align-items: center;
    min-height: 24px;
    border: 1px solid #242b28;
    border-radius: 3px;
    background: #0b0d0c;
    color: #a5b0a9;
    padding: 2px 8px;
    font-family: var(--font-ribbon);
    font-size: 12px;
    line-height: 18px;
  }
  .rds-callout {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    border-radius: 3px;
    padding: 8px 10px;
    font-family: var(--font-ribbon);
    font-size: 13px;
    line-height: 19px;
  }
  .rds-callout strong {
    display: block;
    margin-bottom: 1px;
  }
  .rds-callout span {
    display: block;
    color: #a5b0a9;
  }
  .rds-callout-question {
    border: 1px solid rgba(255,177,136,.32);
    background: rgba(255,177,136,.08);
    color: #ffb188;
  }
  .rds-callout-risk {
    border: 1px solid rgba(255,180,171,.32);
    background: rgba(255,180,171,.08);
    color: #ffb4ab;
  }
  .rds-stack-card:has(input[type="radio"]:checked) {
    border-color: #6ad7a3 !important;
    background: rgba(106, 215, 163, 0.08) !important;
  }
  .rds-stack-grid {
    align-items: stretch;
  }
  .rds-stack-card {
    min-height: 0;
    padding: 12px !important;
    transition: border-color .15s ease, background .15s ease, transform .15s ease;
  }
  .rds-stack-card:hover {
    transform: translateY(-1px);
    background: rgba(20,25,23,.96) !important;
  }
  .rds-stack-card .font-h2 {
    font-size: 14px;
    line-height: 19px;
  }
  .rds-stack-card .font-table {
    font-size: 12.5px;
    line-height: 18px;
  }
  .rds-stack-card .line-clamp-3 {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .rds-stack-radio {
    width: 15px !important;
    height: 15px !important;
    min-width: 15px !important;
    min-height: 15px !important;
    border-radius: 999px !important;
    background-color: #070908 !important;
    border-color: #75817a !important;
    box-shadow: none !important;
  }
  .rds-doc-panel,
  .rds-doc-callout {
    box-shadow: inset 0 1px 0 rgba(255,255,255,.028), 0 12px 34px -30px rgba(0,0,0,.72);
  }
  .rds-doc-panel {
    padding: 18px !important;
  }
  .rds-doc-mini-card,
  .rds-doc-card {
    background: rgba(27,33,30,.58) !important;
    transition: border-color .15s ease, background .15s ease;
  }
  .rds-doc-card:hover,
  .rds-doc-mini-card:hover {
    border-color: rgba(106,215,163,.28);
    background: rgba(27,33,30,.82) !important;
  }
  .rds-doc-card-grid {
    grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
  }
  .rds-doc-directory.rds-doc-card-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
  }
  .rds-doc-card {
    min-height: 118px;
  }
  .rds-doc-directory-row.rds-doc-card {
    min-height: 0;
    background: rgba(16,20,18,.42) !important;
  }
  .rds-doc-directory-row.rds-doc-card:hover {
    background: rgba(27,33,30,.62) !important;
  }
  .rds-doc-state-list > div {
    display: grid;
    grid-template-columns: 132px minmax(0, 1fr);
    gap: 12px;
    align-items: start;
  }
  .rds-inventory-disclosure {
    overflow: hidden;
  }
  .rds-inventory-disclosure > summary {
    min-height: 52px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 0 20px;
    list-style: none;
  }
  .rds-inventory-disclosure > summary::-webkit-details-marker {
    display: none;
  }
  .rds-inventory-disclosure > summary::after {
    content: "expand";
    color: #75817a;
    font-family: var(--font-ribbon);
    font-size: 12px;
  }
  .rds-inventory-disclosure[open] > summary::after {
    content: "collapse";
  }
  .rds-inventory-body {
    border-top: 1px solid #242b28;
    padding: 16px;
    max-height: 720px;
    overflow-y: auto;
  }
  .rds-inventory-body > section {
    padding: 0 !important;
    border: 0 !important;
    background: transparent !important;
  }
  .rds-agent-panel {
    padding: 16px !important;
  }
  .rds-agent-step {
    min-height: 106px;
    background: rgba(11,13,12,.68) !important;
  }
  .rds-agent-step p {
    font-size: 12px;
    line-height: 17px;
  }
  .rds-agent-sessions table {
    min-width: 980px;
  }
  .rds-agent-sessions thead {
    text-transform: uppercase;
    letter-spacing: .04em;
  }
  .material-symbols-outlined {
    display: inline-block;
    width: 1em;
    min-width: 1em;
    height: 1em;
    overflow: hidden;
    line-height: 1;
    vertical-align: -0.15em;
    text-indent: -9999px;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .material-symbols-outlined::before {
    content: "";
    display: block;
    width: 1em;
    height: 1em;
    line-height: 1;
    text-indent: 0;
  }
  .rds-icons-ready .material-symbols-outlined::before {
    content: attr(data-icon);
    font-family: "Material Symbols Outlined";
    font-weight: normal;
    font-style: normal;
    font-feature-settings: "liga";
    -webkit-font-feature-settings: "liga";
    direction: ltr;
    text-transform: none;
    letter-spacing: normal;
    white-space: nowrap;
    word-wrap: normal;
  }
  @keyframes rds-modal-in { from { opacity: 0; transform: translateY(-8px) scale(0.98); } to { opacity: 1; transform: none; } }
  .animate-rds-modal-in { animation: rds-modal-in 120ms ease-out; }
  @keyframes rds-toast-in { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: none; } }
  .animate-rds-toast-in { animation: rds-toast-in 160ms ease-out; }
  #rds-toast-root {
    width: min(420px, calc(100vw - 24px));
    align-items: stretch;
  }
  .rds-toast {
    display: grid;
    grid-template-columns: 20px minmax(0, 1fr) 28px;
    gap: 10px;
    align-items: start;
    padding: 12px;
    border: 1px solid #2f3a34;
    border-radius: 8px;
    background: rgba(19, 24, 21, .98);
    color: #dbe7df;
    box-shadow: 0 18px 40px rgba(0, 0, 0, .36);
    font-family: var(--font-body);
    font-size: 13.5px;
    line-height: 19px;
    box-sizing: border-box;
    width: 100%;
  }
  .rds-toast-icon {
    font-size: 18px !important;
    line-height: 20px;
    margin-top: 1px;
  }
  .rds-toast-title {
    display: block;
    margin-bottom: 2px;
    color: #f1f6f2;
    font-family: var(--font-ribbon);
    font-size: 13.5px;
    font-weight: 700;
    line-height: 18px;
  }
  .rds-toast-message {
    color: #bfcbc4;
    overflow-wrap: anywhere;
  }
  .rds-toast-close {
    width: 28px;
    height: 28px;
    border-radius: 6px;
    color: #9ca9a1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .rds-toast-close:hover {
    color: #f1f6f2;
    background: rgba(255, 255, 255, .06);
  }
  .rds-toast-info { border-color: rgba(106, 215, 163, .35); }
  .rds-toast-info .rds-toast-icon { color: #6ad7a3; }
  .rds-toast-warn { border-color: rgba(229, 192, 123, .45); }
  .rds-toast-warn .rds-toast-icon { color: #e5c07b; }
  .rds-toast-error { border-color: rgba(255, 123, 133, .45); }
  .rds-toast-error .rds-toast-icon { color: #ff7b85; }
  .rds-chat-panel-wrap {
    background: linear-gradient(180deg, rgba(16,20,18,.98), rgba(14,17,15,.98));
  }
  .rds-chat-panel-head {
    min-height: 48px;
    background: rgba(14,17,15,.72);
  }
  .rds-chat-panel-head > div:first-child {
    flex: 1 1 auto;
    min-width: 0;
  }
  .rds-chat-panel-head > div:last-child {
    flex: 0 0 auto;
  }
  #chat-title {
    min-width: 0;
    max-width: min(44vw, 520px);
  }
  #chat-build-link a {
    max-width: min(30vw, 420px);
  }
  .rds-chat-log {
    background: radial-gradient(circle at top left, rgba(106,215,163,.055), transparent 32%), #0b0d0c !important;
    scrollbar-gutter: stable;
  }
  .rds-chat-turn {
    max-width: min(1180px, 100%);
  }
  .rds-chat-turn-user {
    max-width: min(820px, 100%);
  }
  .rds-chat-bubble {
    box-shadow: inset 0 1px 0 rgba(255,255,255,.025);
    overflow-wrap: anywhere;
    border-radius: 6px;
  }
  .rds-chat-bubble pre,
  .rds-chat-bubble code {
    font-family: var(--font-code, ui-monospace, SFMono-Regular, Menlo, monospace);
  }
  .rds-chat-bubble pre {
    max-height: 280px;
    overflow: auto;
  }
  .rds-chat-avatar {
    flex: 0 0 auto;
    width: 30px;
    height: 30px;
    border-radius: 9px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    box-shadow: inset 0 1px 0 rgba(255,255,255,.05);
  }
  .rds-chat-avatar .material-symbols-outlined {
    font-size: 17px;
    line-height: 1;
  }
  .rds-chat-avatar-rds {
    background: rgba(106,215,163,.16);
    color: #6ad7a3;
    border: 1px solid rgba(106,215,163,.34);
  }
  .rds-chat-avatar-you {
    background: rgba(125,164,255,.13);
    color: #9db4ff;
    border: 1px solid rgba(125,164,255,.30);
  }
  .rds-chat-turn-head {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin-bottom: 5px;
    min-width: 0;
  }
  .rds-chat-turn-name {
    font-weight: 600;
    font-size: 12.5px;
    letter-spacing: .01em;
  }
  .rds-chat-turn-rds .rds-chat-turn-name { color: #6ad7a3; }
  .rds-chat-turn-user .rds-chat-turn-name { color: #9db4ff; }
  .rds-chat-turn-time {
    font-size: 10.5px;
    color: #6c7a72;
    font-variant-numeric: tabular-nums;
    font-family: var(--font-code, ui-monospace, SFMono-Regular, Menlo, monospace);
  }
  .rds-chat-badge {
    font-size: 10px;
    line-height: 1;
    padding: 2px 7px;
    border-radius: 999px;
    white-space: nowrap;
  }
  .rds-chat-badge-think { color: #e5c07b; background: rgba(229,192,123,.14); }
  .rds-chat-badge-err { color: #ff7b85; background: rgba(255,123,133,.14); }
  .rds-chat-bubble-rds {
    background: #101412;
    border: 1px solid #242b28;
  }
  .rds-chat-bubble-you {
    background: rgba(125,164,255,.07);
    border: 1px solid rgba(125,164,255,.22);
  }
  .rds-chat-bubble-err {
    background: rgba(255,123,133,.08);
    border: 1px solid rgba(255,123,133,.34);
  }
  .rds-chat-day {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 4px 2px 2px;
    color: #7c8a82;
    font-size: 10px;
    letter-spacing: .09em;
    text-transform: uppercase;
  }
  .rds-chat-day::before,
  .rds-chat-day::after {
    content: "";
    flex: 1 1 auto;
    height: 1px;
    background: linear-gradient(90deg, transparent, rgba(255,255,255,.08), transparent);
  }
  .rds-chat-form {
    background: rgba(14,17,15,.96);
  }
  .rds-chat-actions {
    flex-wrap: wrap;
  }
  .rds-chat-actions button {
    min-height: 38px;
  }
  .rds-chat-attach-btn {
    background: rgba(16,20,18,.82);
  }
  .rds-chat-attachment-chip,
  .rds-chat-turn-attachments span {
    min-height: 30px;
  }
  #chat-status {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  #tab-chat {
    flex: 0 0 min(54dvh, 490px) !important;
    height: min(54dvh, 490px) !important;
    min-height: 400px;
    overflow: hidden;
  }
  #tab-chat .rds-chat-form {
    padding: 12px !important;
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 8px;
    align-items: end;
  }
  #tab-chat .rds-chat-helper,
  #tab-chat #chat-dropzone,
  #tab-chat #chat-attachments {
    grid-column: 1 / -1;
  }
  #tab-chat .rds-chat-helper {
    display: none !important;
  }
  #tab-chat #chat-input {
    min-height: 44px;
    max-height: 96px;
  }
  #tab-chat .rds-chat-actions {
    align-self: stretch;
    align-items: stretch;
    flex-wrap: nowrap;
  }
  @media (max-width: 1180px) {
    #chat-build-actions > div {
      align-items: flex-start !important;
      flex-direction: column !important;
    }
    #chat-build-actions .flex.flex-wrap {
      width: 100%;
    }
    #chat-build-actions a,
    #chat-build-actions button {
      min-height: 36px;
    }
    .rds-command-center {
      padding: 14px;
      gap: 12px;
    }
    .rds-command-main {
      flex-direction: column;
      gap: 12px;
    }
    .rds-command-actions {
      justify-content: flex-start;
      max-width: none;
      width: 100%;
    }
    .rds-command-action {
      min-height: 38px;
    }
    .rds-command-grid {
      grid-template-columns: minmax(0, 1fr);
    }
    .rds-blocker-head {
      grid-template-columns: 22px minmax(0, 1fr);
    }
    .rds-blocker-severity {
      display: none;
    }
    .rds-deploy-banner {
      align-items: flex-start !important;
    }
    .rds-deploy-actions {
      width: 100%;
      justify-content: flex-start !important;
    }
    .rds-deploy-banner #deploy-url-link {
      display: block;
      overflow-wrap: anywhere;
    }
  }
  @media (max-width: 767px) {
    html { min-height: 100%; height: auto !important; overflow-y: auto !important; overflow-x: hidden !important; }
    body { min-height: 100dvh !important; height: auto !important; display: block !important; overflow-y: auto !important; overflow-x: hidden !important; }
    .rds-app-shell { min-height: 100dvh !important; height: auto !important; display: block !important; overflow: visible !important; }
    .rds-main { padding: 8px !important; padding-bottom: calc(28px + env(safe-area-inset-bottom)) !important; overflow: visible !important; }
    .rds-builds-toolbar { padding: 8px 10px !important; gap: 8px; }
    .rds-builds-toolbar h1 { display: flex; align-items: baseline; gap: 6px; font-size: 24px !important; line-height: 28px !important; min-width: 0; }
    .rds-build-count { margin-left: 0 !important; white-space: nowrap; }
    .rds-new-build-button { min-height: 42px; padding-left: 10px !important; padding-right: 10px !important; white-space: nowrap; }
    .rds-new-build-button span { white-space: nowrap; }
    .rds-build-mobile-card { padding: 12px !important; background: #101412 !important; }
    .rds-build-mobile-card + .rds-build-mobile-card { margin-top: 8px; }
    .rds-mobile-build-card-stats .rounded,
    .rds-mobile-review-cell .rounded { max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
    .rds-mobile-card-meta { min-width: 0; }
    .rds-mobile-card-title {
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .rds-build-header {
      padding: 10px !important;
      gap: 8px !important;
      background: #101412 !important;
      border-color: #27332d !important;
    }
    .rds-build-header > .flex:first-child {
      gap: 8px !important;
    }
    .rds-build-header > .flex:first-child > .flex:first-child {
      gap: 7px !important;
      width: 100%;
    }
    .rds-build-header a[href="/builds"] {
      font-size: 13px !important;
      line-height: 18px !important;
    }
    .rds-build-title-row {
      display: grid !important;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center !important;
      gap: 7px !important;
      width: 100%;
    }
    .rds-build-title-row .text-outline-variant {
      display: none !important;
    }
    .rds-build-title-row a[href="/builds"] {
      grid-column: 1;
      grid-row: 1;
      justify-self: start;
    }
    .rds-status-badge {
      grid-column: 2;
      grid-row: 1;
      justify-self: end;
      max-width: 160px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .rds-review-badge {
      display: none !important;
    }
    .rds-build-title {
      display: block;
      grid-column: 1 / -1;
      grid-row: 2;
      width: auto;
      max-width: none !important;
      font-size: 20px !important;
      line-height: 25px !important;
      font-weight: 760;
      overflow-wrap: break-word;
      word-break: normal !important;
    }
    .rds-current-stage {
      grid-column: 1 / -1;
      grid-row: 3;
      justify-self: start;
      min-height: 32px !important;
      padding: 4px 9px !important;
    }
    .rds-mobile-build-summary {
      display: grid !important;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 6px;
      width: 100%;
      margin-top: 2px;
    }
    /* Idle builds show exactly three stat cards (Elapsed / run / Cost) —
       lay them out in one even row instead of 2 + 1. */
    .rds-mobile-build-summary.rds-mobile-summary-3 {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }
    .rds-mobile-build-summary > div {
      border: 1px solid #242b28;
      border-radius: 4px;
      background: #0b0d0c;
      padding: 5px 6px;
      min-width: 0;
    }
    .rds-mobile-build-summary span {
      display: block;
      font-family: var(--font-ribbon);
      font-size: 10px;
      line-height: 14px;
      text-transform: uppercase;
    }
    .rds-mobile-build-summary strong {
      display: block;
      font-family: var(--font-code);
      font-size: 11px;
      line-height: 16px;
      color: #e8eaed;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    /* The live terminal already surfaces the log/stream state, so the duplicate
       "LOG" stat box is just noise on a narrow screen. */
    .rds-mobile-build-summary > div:has(#mobile-log-status) { display: none !important; }
    .rds-build-meta { display: none !important; }
    /*
    .rds-build-meta { display: grid !important; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px !important; width: 100%; }
    .rds-build-meta > .text-outline-variant { display: none !important; }
    .rds-build-meta > span:not(.text-outline-variant),
    .rds-build-meta > button {
      min-width: 0;
      width: 100%;
      border: 1px solid #242b28;
      border-radius: 4px;
      background: #101412;
      padding: 4px 6px;
      overflow-wrap: anywhere;
    }
    .rds-build-meta > span:not(.text-outline-variant) { align-items: center; }
    .rds-build-meta > button { min-height: 28px; }
    */
    .rds-build-header > .flex:first-child > .rds-build-actions {
      display: none !important;
    }
    .rds-build-actions { display: grid !important; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px !important; width: 100%; }
    .rds-build-actions > * { width: 100%; min-width: 0; justify-content: center; padding-left: 8px !important; padding-right: 8px !important; white-space: nowrap; }
    .rds-build-actions > .js-open-preview-action {
      grid-column: span 2;
      order: -10;
      min-height: 44px;
      font-size: 13px !important;
      background: #6ad7a3 !important;
      color: #070908 !important;
      border-color: #6ad7a3 !important;
      font-weight: 800;
    }
    .rds-build-actions > .js-spawn-fixer,
    .rds-build-actions > .js-delete-service-action,
    .rds-build-actions > a[href$="/cost"] { grid-column: span 2; }
    .rds-build-actions > .js-iterate-action,
    .rds-build-actions > .js-open-chat-action {
      order: -4;
      min-height: 38px;
      background: #6ad7a3 !important;
      color: #070908 !important;
      border-color: #6ad7a3 !important;
      font-weight: 700;
    }
    .rds-build-actions > .js-iterate-action { grid-column: span 1; }
    .rds-build-actions > .js-open-chat-action { grid-column: span 1; }
    .rds-build-actions > a[target="_blank"]:not(.js-open-preview-action) { order: -2; }
    .rds-build-actions > a.js-open-preview-action { order: -10 !important; }
    .rds-build-actions > .js-spawn-fixer { order: 4; }
    .rds-deploy-banner { align-items: flex-start !important; padding: 12px !important; }
    .rds-deploy-banner > .flex-1 { flex-basis: calc(100% - 32px); }
    .rds-deploy-banner #deploy-url-link { display: block; margin-top: 2px; overflow-wrap: anywhere; word-break: normal; }
    .rds-deploy-actions { width: 100%; display: grid !important; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px !important; }
    .rds-deploy-actions > * { min-width: 0; justify-content: center; padding-left: 8px !important; padding-right: 8px !important; white-space: nowrap; }
    .rds-deploy-actions > .js-delete-service-action { grid-column: span 2; }
    .rds-build-plan-card > .flex:first-child { gap: 8px !important; }
    .rds-build-plan-card > .flex:first-child > .flex { width: 100%; display: grid !important; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px !important; }
    .rds-build-plan-card .font-ribbon { overflow-wrap: anywhere; }
    .rds-sidenav.is-open { transform: translateX(0) !important; }
    .rds-mobile-overlay.is-open { display: block; }
    .rds-scroll-table { overflow-x: auto; -webkit-overflow-scrolling: touch; }
    .rds-desktop-table { min-width: 760px; }
    .rds-build-detail { height: auto !important; min-height: 0 !important; gap: 8px !important; }
    .rds-build-tabs {
      width: calc(100vw - 16px) !important;
      overflow-x: auto;
      position: sticky;
      top: 0;
      z-index: 15;
      padding: 2px !important;
      border-color: #27332d !important;
      background: #0b0d0c !important;
    }
    .rds-build-tabs nav { flex-direction: row; min-width: max-content; }
    .rds-build-tabs button {
      width: auto;
      min-width: 74px;
      min-height: 38px;
      justify-content: center;
      border-left-width: 0 !important;
      border-bottom: 2px solid transparent;
      padding: 6px 8px !important;
      font-size: 13px !important;
      line-height: 18px !important;
    }
    .rds-build-tabs button[data-tab="browser"],
    .rds-build-tabs button[data-tab="files"],
    .rds-build-tabs button[data-tab="diff"] { display: none !important; }
    body:has(#tab-chat:not(.hidden)) .rds-deploy-banner,
    body:has(#tab-chat:not(.hidden)) .rds-review-banner {
      display: none !important;
    }
    body:has(#tab-chat:not(.hidden)) .rds-build-actions,
    body:has(#tab-chat:not(.hidden)) .rds-build-meta,
    body:has(#tab-chat:not(.hidden)) .rds-build-header .rds-build-actions,
    body:has(#tab-chat:not(.hidden)) .rds-build-header details,
    body:has(#tab-chat:not(.hidden)) .rds-build-header .rds-mobile-build-summary {
      display: none !important;
    }
    body:has(#tab-chat:not(.hidden)) .rds-build-header {
      padding: 10px !important;
      margin-bottom: 8px !important;
      gap: 4px !important;
    }
    body:has(#tab-chat:not(.hidden)) .rds-build-header .rds-build-title {
      font-size: 14px !important;
      line-height: 18px !important;
      margin: 0 !important;
      max-height: 36px;
      overflow: hidden;
    }
    .rds-build-canvas { min-height: 70dvh; }
    .rds-status-banner {
      display: none !important;
    }
    .rds-mobile-secondary { display: none !important; }
    .rds-ledger-check-grid {
      grid-template-columns: minmax(0, 1fr) !important;
    }
    .rds-ledger-step {
      grid-template-columns: 44px minmax(0, 1fr) !important;
    }
    .rds-ledger-step span:nth-child(3) {
      grid-column: 2;
    }
    .rds-ledger-metric {
      min-height: 0;
    }
    .rds-mobile-overview-card {
      display: block !important;
    }
    .rds-mobile-overview-card .rds-decision-card {
      padding: 10px !important;
      gap: 8px !important;
    }
    .rds-mobile-overview-card + .rds-mobile-overview-card {
      margin-top: 8px;
    }
    .rds-mobile-overview-card h2,
    .rds-mobile-overview-card .font-h2 {
      font-size: 15px !important;
      line-height: 20px !important;
    }
    .rds-mobile-overview-card .rds-plan-chip {
      max-width: 100%;
      min-height: 22px;
      font-size: 11px;
      line-height: 16px;
      overflow-wrap: anywhere;
    }
    .rds-mobile-overview-card .rds-callout {
      padding: 7px 8px;
      font-size: 12px;
      line-height: 17px;
    }
    .rds-mobile-overview-card details {
      display: none;
    }
    .rds-raw-links {
      display: none !important;
    }
    #live-stage-banner {
      padding: 8px 10px !important;
      gap: 8px !important;
    }
    #live-stage-banner button {
      min-height: 34px;
      padding: 5px 9px !important;
    }
    #tab-overview { padding: 8px !important; gap: 8px !important; }
    #tab-overview > #overview-scaffold-progress-host:empty {
      display: none !important;
    }
    #tab-overview > .rds-command-center {
      order: -30;
    }
    .rds-live-term-primary {
      order: -25;
      padding: 0 !important;
      border-radius: 4px !important;
      overflow: hidden;
    }
    .rds-live-term-primary .rds-live-term-head {
      padding: 9px 10px !important;
      gap: 8px !important;
    }
    .rds-live-term-primary .rds-live-term-title {
      font-size: 13px !important;
      line-height: 18px !important;
    }
    .rds-live-term-primary .rds-live-term-path {
      display: none !important;
    }
    .rds-live-term-primary .rds-live-term-toolbar,
    .rds-live-term-primary #overview-log-panel {
      display: none !important;
    }
    .rds-live-term-primary .rds-live-term-meta {
      flex-wrap: nowrap !important;
      gap: 6px !important;
    }
    .rds-live-term-primary .rds-live-term-count {
      display: none !important;
    }
    .rds-live-term-watch {
      min-height: 32px !important;
      white-space: nowrap;
    }
    #tab-overview > .rds-deploy-banner {
      order: -20;
    }
    #tab-overview > .flex.flex-col.gap-stack-gap {
      order: -10;
    }
    #tab-overview > #quality-ledger-details {
      order: 0;
    }
    #tab-overview > details:not(#quality-ledger-details) {
      order: 10;
    }
    .rds-overview-chat-card {
      order: 20;
      position: static;
      padding: 10px !important;
      gap: 8px !important;
      box-shadow: none;
    }
    .rds-overview-chat-card h2 {
      font-size: 16px !important;
      line-height: 21px !important;
    }
  .rds-overview-chat-card input,
  .rds-overview-chat-card button { min-height: 38px; }
  .rds-chat-panel-wrap {
    background: linear-gradient(180deg, rgba(16,20,18,.98), rgba(14,17,15,.98));
  }
  .rds-chat-panel-head {
    min-height: 48px;
    background: rgba(14,17,15,.72);
  }
  .rds-chat-log {
    background: radial-gradient(circle at top left, rgba(106,215,163,.055), transparent 32%), #0b0d0c !important;
    scrollbar-gutter: stable;
  }
  .rds-chat-turn {
    max-width: min(1180px, 100%);
  }
  .rds-chat-turn-user {
    max-width: min(820px, 100%);
  }
  .rds-chat-bubble {
    box-shadow: inset 0 1px 0 rgba(255,255,255,.025);
    overflow-wrap: anywhere;
    border-radius: 6px;
  }
  .rds-chat-form {
    background: rgba(14,17,15,.96);
  }
  .rds-chat-actions {
    flex-wrap: wrap;
  }
  .rds-chat-actions button {
    min-height: 38px;
  }
  .rds-chat-attach-btn {
    background: rgba(16,20,18,.82);
  }
  .rds-chat-attachment-chip,
  .rds-chat-turn-attachments span {
    min-height: 30px;
  }
  #chat-status {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  #tab-chat {
    min-height: 560px;
  }
  #tab-chat .rds-chat-form {
    padding: 12px !important;
  }
    .rds-command-center {
      padding: 11px !important;
      gap: 10px !important;
      border-color: rgba(106,215,163,.38);
    }
    .rds-command-main {
      gap: 9px !important;
    }
    .rds-command-verdict {
      gap: 9px !important;
    }
    .rds-command-verdict h2 {
      font-size: 24px !important;
      line-height: 29px !important;
      margin-top: 0 !important;
    }
    .rds-command-verdict p {
      font-size: 14px !important;
      line-height: 20px !important;
      margin-top: 3px !important;
    }
    .rds-command-actions {
      display: grid !important;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 7px !important;
      width: 100%;
    }
    .rds-command-action {
      min-height: 38px !important;
      padding: 7px 9px !important;
      font-size: 13px !important;
      line-height: 18px !important;
    }
    .rds-command-actions .rds-command-action-primary:first-child {
      grid-column: span 2;
    }
    .rds-command-grid {
      gap: 8px !important;
    }
    .rds-command-panel {
      padding: 10px !important;
    }
    .rds-command-panel:first-child:has(.rds-command-muted) {
      display: none !important;
    }
    .rds-command-label {
      font-size: 11px !important;
      line-height: 15px !important;
    }
    .rds-command-chips {
      gap: 6px !important;
    }
    .rds-command-chips span {
      min-height: 26px !important;
      padding: 3px 8px !important;
      font-size: 12px !important;
      line-height: 17px !important;
    }
    .rds-command-live {
      display: none !important;
    }
    .rds-goal-panel {
      padding: 10px !important;
      gap: 8px !important;
    }
    .rds-goal-panel .rds-goal-head h2 {
      font-size: 18px !important;
      line-height: 23px !important;
    }
    .rds-goal-panel .rds-goal-head p {
      display: none !important;
    }
    .rds-goal-panel .rds-goal-head > .flex {
      display: none !important;
    }
    .rds-goal-mobile-summary {
      display: flex !important;
      flex-wrap: wrap;
      gap: 6px;
    }
    .rds-goal-mobile-summary span {
      min-height: 26px;
      display: inline-flex;
      align-items: center;
      border: 1px solid rgba(36,43,40,.86);
      border-radius: 999px;
      background: rgba(14,17,15,.7);
      color: #a5b0a9;
      padding: 3px 8px;
    font-family: var(--font-ribbon);
      font-size: 12px;
      line-height: 17px;
      font-weight: 650;
    }
    .rds-goal-nodes,
    .rds-goal-stats,
    .rds-goal-detail-block {
      display: none !important;
    }
    .rds-agent-sessions-empty {
      padding: 10px !important;
      gap: 8px !important;
    }
    .rds-agent-sessions-empty h2 {
      font-size: 16px !important;
      line-height: 21px !important;
    }
    .rds-agent-empty-copy {
      font-size: 13px !important;
      line-height: 18px !important;
    }
    .rds-agent-empty-path {
      display: none !important;
    }
    .rds-detail-disclosure > summary {
      min-height: 38px !important;
      padding: 8px 10px !important;
      font-size: 17px !important;
      line-height: 22px !important;
    }
    #stage-timeline-host { max-height: 42dvh; overflow-y: auto; }
    #overview-log-panel { height: min(34dvh, 320px) !important; min-height: 220px; }
    #tab-live-log { height: calc(100dvh - 210px) !important; min-height: 460px !important; }
    #tab-live-log > .relative { min-height: 390px; }
    #tab-live-log #log,
    #overview-log {
      white-space: pre-wrap !important;
      overflow-x: hidden !important;
      word-break: break-word !important;
      overflow-wrap: anywhere !important;
      font-size: 13.5px !important;
      line-height: 22px !important;
    }
    .rds-log-line {
      grid-template-columns: 58px minmax(0, 1fr) !important;
      gap: 9px !important;
      padding: 4px 8px 4px 0 !important;
    }
    .rds-log-body .rds-log-line::after {
      font-size: 11px !important;
      line-height: 22px !important;
    }
    .rds-log-content {
      line-height: 22px !important;
    }
    .rds-mobile-stack { grid-template-columns: minmax(0, 1fr) !important; }
    .rds-stack-mobile-select select { min-height: 46px !important; }
    .rds-new-actions { grid-template-columns: 1fr 1fr !important; }
    .rds-new-actions button {
      min-height: 40px !important;
      padding-left: 8px !important;
      padding-right: 8px !important;
      white-space: nowrap !important;
    }
    .rds-skill-picker {
      display: grid !important;
      grid-template-columns: minmax(0, 1fr) !important;
      max-height: 180px !important;
      gap: 6px !important;
    }
    .rds-skill-picker label {
      width: 100%;
      min-width: 0;
      justify-content: flex-start;
      padding: 8px 9px !important;
    }
    .rds-skill-picker label span:first-of-type {
      min-width: 0;
      flex: 1;
      overflow-wrap: break-word;
    }
    /* Readiness chip is catalog metadata — drop it on narrow rows so the
       skill name stays readable. It remains in Settings → Skills. */
    .rds-skill-picker label span.font-code { display: none; }
    .rds-mobile-actions { width: 100%; }
    .rds-mobile-actions > * { flex: 1 1 auto; justify-content: center; }
    .rds-mobile-hide { display: none !important; }
    .rds-compact-empty { min-height: 0 !important; }
    .rds-compact-empty > div:last-child { min-height: 0 !important; flex: 0 0 auto !important; }
    .rds-hub-activity { margin-bottom: calc(8px + env(safe-area-inset-bottom)); }
    .rds-footer { display: none !important; }
    body:has(.rds-chat-page) .rds-main {
      padding: 10px 8px 0 !important;
      overflow: hidden !important;
    }
    .rds-chat-page { height: calc(100dvh - 58px) !important; min-height: 0 !important; overflow: hidden; }
    .rds-chat-header { margin-bottom: 6px !important; align-items: center !important; }
    .rds-chat-header > div:first-child {
      display: flex !important;
      align-items: center !important;
      gap: 8px !important;
      min-width: 0 !important;
    }
    .rds-chat-header h1 {
      font-size: 18px !important;
      line-height: 24px !important;
      white-space: nowrap !important;
    }
    .rds-chat-header a[href="/"] {
      margin-bottom: 0 !important;
      font-size: 13px !important;
      line-height: 18px !important;
      white-space: nowrap !important;
      flex: 0 0 auto !important;
    }
    .rds-chat-grid { display: flex !important; flex-direction: column; min-height: 0; overflow: hidden; gap: 7px; position: relative; }
    .rds-chat-rail {
      flex: 0 0 auto;
      min-height: 48px;
      max-height: 48px;
      overflow: hidden;
      border-radius: 6px !important;
      transition: max-height 160ms ease;
    }
    .rds-chat-rail > div:first-child {
      min-height: 47px;
      padding: 8px 10px !important;
    }
    .rds-chat-rail > div:first-child .text-h2 {
      font-size: 17px !important;
      line-height: 22px !important;
    }
    .rds-chat-rail:not(.rds-chat-rail-open) #chat-session-list {
      display: none !important;
    }
    .rds-chat-rail:not(.rds-chat-rail-open) {
      display: none !important;
    }
    .rds-chat-rail.rds-chat-rail-collapsed {
      display: none !important;
    }
    .rds-chat-rail.rds-chat-rail-open {
      position: absolute !important;
      top: 0 !important;
      left: 0 !important;
      right: 0 !important;
      z-index: 40 !important;
      max-height: min(66dvh, 460px) !important;
      min-height: 0 !important;
      border: 1px solid #2c332f !important;
      box-shadow: 0 20px 44px rgba(0,0,0,.55) !important;
    }
    #chat-session-list {
      display: block !important;
      overflow-x: hidden !important;
      overflow-y: auto !important;
      -webkit-overflow-scrolling: touch;
      scroll-snap-type: none !important;
    }
    #chat-session-list > li {
      flex: none !important;
      width: auto !important;
      border-right: 0 !important;
      border-bottom: 1px solid rgba(36,43,40,.6) !important;
      scroll-snap-align: none !important;
    }
    #chat-session-list > li:last-child { border-bottom: 0 !important; }
    #chat-session-list a {
      min-height: 0 !important;
      padding: 12px 13px !important;
    }
    #chat-threads-backdrop {
      position: absolute !important;
      inset: 0 !important;
      z-index: 35 !important;
      background: rgba(3,6,4,.55) !important;
      backdrop-filter: blur(1px);
    }
    .rds-chat-grid:has(.rds-chat-rail-open) #chat-threads-backdrop {
      display: block !important;
    }
    .rds-chat-panel-wrap, .rds-chat-panel { min-height: 0; overflow: hidden; }
    .rds-chat-panel-wrap { flex: 1 1 auto; height: auto; }
    #tab-chat { flex: 0 0 auto !important; height: calc(100dvh - 176px) !important; min-height: 0 !important; overflow: hidden !important; }
    #tab-chat .rds-chat-panel { height: 100%; }
    #tab-chat .rds-chat-log { max-height: none; }
    .rds-chat-log { overscroll-behavior: contain; -webkit-overflow-scrolling: touch; touch-action: pan-y; }
    .rds-chat-panel-head {
      min-height: 46px !important;
      padding: 8px 10px !important;
    }
    #chat-title {
      max-width: 58vw;
      font-size: 17px !important;
      line-height: 22px !important;
    }
    #chat-build-actions {
      padding: 8px 10px !important;
    }
    #chat-build-actions > div {
      gap: 8px !important;
    }
    #chat-build-actions > div > .min-w-0 {
      display: none !important;
    }
    #chat-build-actions .rds-chat-build-hint,
    #chat-build-actions-id {
      display: none !important;
    }
    #chat-build-actions .flex.flex-wrap {
      display: grid !important;
      grid-template-columns: 1fr 1fr;
      gap: 7px !important;
    }
    #chat-build-actions a,
    #chat-build-actions button {
      justify-content: center;
      min-height: 40px;
      padding: 8px 9px !important;
      font-size: 13.5px !important;
      line-height: 18px !important;
    }
    .rds-chat-form {
      flex: 0 0 auto;
      position: sticky;
      bottom: 0;
      z-index: 20;
      background: #111812;
      border-top-color: rgba(106,215,163,.18) !important;
      padding: 9px 10px calc(9px + env(safe-area-inset-bottom)) !important;
      box-shadow: 0 -16px 30px rgba(0,0,0,.32);
    }
    #tab-chat .rds-chat-form { display: block !important; }
    .rds-chat-helper { display: none !important; }
    .rds-chat-form textarea {
      min-height: 58px;
      max-height: 112px;
      padding: 11px 12px !important;
      font-size: 16px !important;
      line-height: 23px !important;
      border-radius: 8px !important;
    }
    .rds-chat-log {
      padding: 12px 10px !important;
      gap: 12px !important;
      background: #080d0a !important;
    }
    .rds-chat-log > .rds-mobile-stack { gap: 6px !important; }
    .rds-chat-turn {
      display: flex !important;
      gap: 9px !important;
      max-width: 100%;
    }
    .rds-chat-turn-user {
      max-width: 100%;
    }
    .rds-chat-avatar {
      width: 26px;
      height: 26px;
      border-radius: 8px;
    }
    .rds-chat-avatar .material-symbols-outlined { font-size: 15px; }
    .rds-chat-turn-name { font-size: 12px !important; }
    .rds-chat-turn-time { font-size: 11px !important; }
    .rds-chat-bubble {
      font-size: 16px !important;
      line-height: 24px !important;
      border-radius: 8px !important;
      padding: 12px !important;
      max-width: 100%;
    }
    .rds-chat-bubble pre {
      max-height: 128px;
      overflow: auto;
      font-size: 12px !important;
      line-height: 18px !important;
    }
    #chat-build-link { display: none !important; }
    #chat-rename-btn span,
    #chat-delete-btn span { display: none !important; }
    #chat-rename-btn,
    #chat-delete-btn { min-height: 34px; min-width: 34px; justify-content: center; }
    .rds-chat-actions {
      display: grid !important;
      grid-template-columns: 0.74fr 1fr;
      gap: 9px !important;
      align-items: stretch;
    }
    .rds-chat-actions button {
      min-height: 48px !important;
      justify-content: center;
      border-radius: 8px !important;
      font-size: 16px !important;
      line-height: 21px !important;
    }
    #chat-status {
      grid-column: 1 / -1;
      min-height: 18px;
      font-size: 13px !important;
      line-height: 18px !important;
    }
    #stage-bar-host > div { min-width: 720px; }
    #rds-toast-root {
      left: 50% !important;
      right: auto !important;
      top: 10px;
      width: calc(100dvw - 20px) !important;
      max-width: 420px;
      transform: translateX(-50%);
    }
    /* ---- live terminal: stop header overlap + collapse 5-row control stack ---- */
    .rds-live-term-head {
      padding: 8px 10px !important;
      gap: 8px !important;
      flex-wrap: wrap;
    }
    .rds-live-term-id { gap: 8px !important; flex: 0 1 auto; min-width: 0; }
    /* Build name + stage already shown in the page title row above — drop the
       long path/subtitle here so the title and state badge stop colliding. */
    .rds-live-term-path { display: none !important; }
    .rds-live-term-title { font-size: 11px !important; }
    .rds-live-term-meta { gap: 8px !important; flex-shrink: 0; }
    .rds-live-term-count { padding: 1px 7px !important; }
    .rds-live-term-toolbar {
      flex-direction: column;
      align-items: stretch;
      gap: 6px !important;
      padding: 7px 8px !important;
    }
    .rds-live-term-filters,
    .rds-live-term-tools {
      flex-wrap: nowrap !important;
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
      scrollbar-width: none;
      gap: 6px !important;
      /* These rows are stretched flex items in a column toolbar, so their
         width is the cross axis — min-width:0 alone won't stop the chip run
         from overflowing. Cap the box at the toolbar width so overflow-x
         actually scrolls instead of pushing past the viewport edge. */
      min-width: 0 !important;
      max-width: 100% !important;
    }
    .rds-live-term-filters::-webkit-scrollbar,
    .rds-live-term-tools::-webkit-scrollbar { display: none; }
    .rds-term-chip,
    .rds-term-tool { flex: 0 0 auto; }
    /* ---- RDS Goal panel: stop the card overflowing its grid track ----
       As a grid item it keeps min-width:auto, so its min-content width
       (~463px) blows past the mobile column and clips the subtitle. Let it
       shrink to the track, then drop the chip cluster below the heading so
       the goal text gets the full width and wraps instead of being cut off. */
    .rds-goal-panel { min-width: 0 !important; max-width: 100% !important; }
    .rds-goal-head { min-width: 0 !important; }
    .rds-goal-headtext { flex: 1 1 100% !important; min-width: 0 !important; }
    .rds-goal-head > .flex { flex: 1 1 100% !important; }
    /* The inner node/stat grids keep min-width:auto, so their cards' min-content
       grows the single mobile track past the card. Pin both to 0 so the track
       collapses to the panel width and the cards wrap instead of overflowing. */
    .rds-goal-panel .grid { min-width: 0 !important; }
    .rds-goal-panel .grid > div { min-width: 0 !important; max-width: 100% !important; }
  }
  .ansi-black-fg{color:#000}.ansi-red-fg{color:#e06c75}.ansi-green-fg{color:#98c379}.ansi-yellow-fg{color:#e5c07b}.ansi-blue-fg{color:#61afef}.ansi-magenta-fg{color:#c678dd}.ansi-cyan-fg{color:#56b6c2}.ansi-white-fg{color:#abb2bf}.ansi-bright-black-fg{color:#5c6370}.ansi-bright-red-fg{color:#ff7b85}.ansi-bright-green-fg{color:#aedba0}.ansi-bright-yellow-fg{color:#f5d491}.ansi-bright-blue-fg{color:#7cc1ff}.ansi-bright-magenta-fg{color:#d490e8}.ansi-bright-cyan-fg{color:#76d1d9}.ansi-bright-white-fg{color:#ffffff}.ansi-bold{font-weight:600}.ansi-italic{font-style:italic}.ansi-underline{text-decoration:underline}
  .rds-log-line{display:grid;grid-template-columns:74px minmax(0,1fr);gap:14px;align-items:start;min-height:26px;padding:4px 14px 4px 0;border-left:3px solid transparent;color:#dbe7df;overflow-wrap:anywhere}
  .rds-log-line:nth-child(2n){background:rgba(255,255,255,.018)}
  .rds-log-line:hover{background:rgba(106,215,163,.055)}
  .rds-log-line.log-error{border-left-color:#ff7b85;color:#ffb3ba;background:rgba(224,108,117,.08)}
  .rds-log-line.log-error::after{color:#ffb3ba}
  .rds-log-line.log-warn{border-left-color:#e5c07b;color:#f5d491;background:rgba(229,192,123,.07)}
  .rds-log-line.log-ok{border-left-color:#98c379;color:#b8e3aa}
  .rds-log-line.log-agent{border-left-color:#56b6c2;color:#a9dce2}
  .rds-log-line.log-stage{border-left-color:#6ad7a3;color:#dcf2e6}
  .rds-log-line.log-file{border-left-color:#242b28;color:#c7d2cb}
  .rds-log-line.log-source{border-left-color:#7cc1ff;color:#dce7ff;background:rgba(124,193,255,.08);font-weight:700;text-transform:none}
  .rds-log-line.log-json{color:#abb2bf}
  .log-json-key{color:#7cc1ff}.log-json-string{color:#aedba0}.log-number{color:#f5d491}.log-path{color:#dcf2e6;font-weight:650}.log-token{display:inline-flex;align-items:center;min-height:18px;border:1px solid rgba(106,215,163,.3);background:rgba(106,215,163,.08);border-radius:3px;padding:0 5px;color:#b6f0d2;font-weight:800}
  .rds-terminal-frame{border-color:rgba(106,215,163,.24)!important;background:#050807!important;box-shadow:inset 0 1px 0 rgba(255,255,255,.04), inset 0 0 0 1px rgba(106,215,163,.06), 0 14px 40px rgba(0,0,0,.26)}
  .rds-terminal-frame::before{content:"";position:absolute;inset:0;pointer-events:none;background:linear-gradient(180deg, rgba(106,215,163,.045), transparent 22%);opacity:.5}
  .rds-terminal-frame::after{content:"";position:absolute;inset:0;pointer-events:none;background:repeating-linear-gradient(180deg, transparent 0, transparent 31px, rgba(255,255,255,.012) 32px);opacity:.7}
  .rds-log-body{counter-reset:rds-log-line;tab-size:2;padding:8px 0;font-size:14px!important;line-height:22px!important;color:#dbe7df}
  .rds-log-body .rds-log-line{counter-increment:rds-log-line;position:relative}
  .rds-log-body .rds-log-line::before{content:"";display:none}
  .rds-log-body .rds-log-line::after{content:attr(data-time);grid-column:1;grid-row:1;color:#7f9084;font-size:12px;line-height:22px;text-align:right;user-select:none;font-variant-numeric:tabular-nums}
  .rds-log-body .rds-log-line.log-same-time::after{content:"";color:#3f4b43}
  .rds-log-body .rds-log-line:hover::after{color:#a8b8ad}
  .rds-log-content{grid-column:2;grid-row:1;min-width:0;white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;line-height:22px}
  .rds-log-fold{display:block;border:1px solid rgba(255,255,255,.08);border-radius:4px;background:rgba(0,0,0,.22);max-width:100%}
  .rds-log-fold summary{display:flex;align-items:center;gap:8px;min-width:0;cursor:pointer;list-style:none;padding:3px 7px;white-space:normal}
  .rds-log-fold summary::-webkit-details-marker{display:none}
  .rds-log-fold-kind{flex:0 0 auto;color:#ffb3ba;border:1px solid rgba(255,123,133,.32);background:rgba(255,123,133,.08);border-radius:999px;padding:0 6px;font-size:10px;line-height:16px;font-family:var(--font-ribbon)}
  .rds-log-fold-preview{min-width:0;color:#d8dbe3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .rds-log-fold pre{margin:0;border-top:1px solid rgba(255,255,255,.08);padding:8px;max-height:260px;overflow:auto;color:#cbd0dc;background:rgba(0,0,0,.25);white-space:pre-wrap;word-break:break-word}
  .rds-log-chip{display:inline-flex;align-items:center;height:18px;border-radius:999px;border:1px solid rgba(255,255,255,.12);padding:0 7px;font-family:var(--font-code, monospace);font-size:10px;line-height:18px}
  .rds-log-chip.log-stage{color:#dcf2e6;border-color:rgba(106,215,163,.35);background:rgba(106,215,163,.08)}
  .rds-log-chip.log-agent{color:#a9dce2;border-color:rgba(86,182,194,.35);background:rgba(86,182,194,.08)}
  .rds-log-chip.log-warn{color:#f5d491;border-color:rgba(229,192,123,.35);background:rgba(229,192,123,.08)}
  .rds-log-chip.log-error{color:#ffb3ba;border-color:rgba(224,108,117,.4);background:rgba(224,108,117,.1)}
  /* ---- live build terminal (prominent + idle) -------------------------------- */
  .rds-live-term{display:flex;flex-direction:column;border:1px solid rgba(106,215,163,.26);border-radius:12px;background:linear-gradient(180deg,#0b1310,#070b09);box-shadow:0 18px 48px rgba(0,0,0,.34),inset 0 1px 0 rgba(255,255,255,.04);overflow:hidden}
  .rds-live-term-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 14px;background:linear-gradient(180deg,rgba(106,215,163,.10),rgba(106,215,163,.02));border-bottom:1px solid rgba(106,215,163,.16)}
  .rds-live-term-id{display:flex;align-items:center;gap:12px;min-width:0}
  .rds-term-dots{display:inline-flex;gap:6px;align-items:center;flex-shrink:0}
  .rds-term-dots i{width:11px;height:11px;border-radius:999px;display:block}
  .rds-term-dots i:nth-child(1){background:#ff5f57;box-shadow:0 0 0 1px rgba(0,0,0,.25)}
  .rds-term-dots i:nth-child(2){background:#febc2e;box-shadow:0 0 0 1px rgba(0,0,0,.25)}
  .rds-term-dots i:nth-child(3){background:#28c840;box-shadow:0 0 0 1px rgba(0,0,0,.25)}
  .rds-live-term-title{display:inline-flex;align-items:center;gap:7px;font-family:var(--font-ribbon);font-size:12px;letter-spacing:.04em;text-transform:uppercase;font-weight:800;color:#dcf2e6;flex-shrink:0}
  .rds-live-term-title .material-symbols-outlined{color:#6ad7a3}
  .rds-live-term-path{font-size:12px;color:#7f9a8c;min-width:0}
  .rds-live-term-meta{display:flex;align-items:center;gap:12px;flex-shrink:0}
  .rds-live-term-count{font-size:11px;color:#86a394;padding:2px 8px;border:1px solid rgba(106,215,163,.18);border-radius:999px;background:rgba(106,215,163,.05);font-variant-numeric:tabular-nums;white-space:nowrap}
  .rds-live-term-state{font-family:var(--font-ribbon);font-size:11px;color:#9aa69f;white-space:nowrap}
  .rds-live-term-toolbar{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;padding:8px 12px;background:rgba(4,7,6,.72);border-bottom:1px solid rgba(106,215,163,.12)}
  .rds-live-term-filters,.rds-live-term-tools{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
  .rds-term-chip{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 11px;border-radius:999px;border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.02);color:#9aa69f;font-family:var(--font-ribbon);font-size:11px;letter-spacing:.02em;cursor:pointer;transition:all .14s ease;user-select:none}
  .rds-term-chip:hover{border-color:rgba(106,215,163,.4);color:#dcf2e6;background:rgba(106,215,163,.07)}
  .rds-term-chip.is-active{border-color:rgba(106,215,163,.55);background:rgba(106,215,163,.16);color:#eafff4;font-weight:700;box-shadow:0 0 0 1px rgba(106,215,163,.12)}
  .rds-term-dot{width:8px;height:8px;border-radius:999px;display:block;flex-shrink:0}
  .rds-term-dot-error{background:#ff7b85}.rds-term-dot-warn{background:#f5d491}.rds-term-dot-agent{background:#76d1d9}.rds-term-dot-stage{background:#6ad7a3}
  .rds-term-tool{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;border-radius:7px;border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.015);color:#9aa69f;font-family:var(--font-ribbon);font-size:11px;cursor:pointer;transition:all .14s ease;user-select:none}
  .rds-term-tool .material-symbols-outlined{color:inherit}
  .rds-term-tool:hover{border-color:rgba(106,215,163,.4);color:#eafff4;background:rgba(106,215,163,.08)}
  .rds-term-tool.is-active{border-color:rgba(106,215,163,.5);background:rgba(106,215,163,.14);color:#eafff4}
  .rds-live-term-body{height:clamp(320px,46vh,560px);min-height:240px;background:#050807!important;resize:vertical}
  .rds-live-term-body.rds-live-term-body-sm{height:200px;min-height:140px}
  .rds-live-term-body[data-filter="error"] .rds-log-line:not(.log-error){display:none}
  .rds-live-term-body[data-filter="warn"] .rds-log-line:not(.log-warn):not(.log-error){display:none}
  .rds-live-term-body[data-filter="agent"] .rds-log-line:not(.log-agent){display:none}
  .rds-live-term-body[data-filter="stage"] .rds-log-line:not(.log-stage){display:none}
  #overview-log.rds-log-nowrap .rds-log-content{white-space:pre;overflow-x:auto}
  .rds-live-term-empty{color:#7f9084;pointer-events:none}
  .rds-live-term-empty-title{font-family:var(--font-ribbon);font-size:13px;color:#bcd4c6;font-weight:700}
  .rds-live-term-empty-sub{font-size:11px;color:#6c7e73;max-width:360px}
  .rds-live-term-pulse{width:13px;height:13px;border-radius:999px;background:#6ad7a3;box-shadow:0 0 0 0 rgba(106,215,163,.5);animation:rds-term-pulse 1.6s ease-out infinite}
  @keyframes rds-term-pulse{0%{box-shadow:0 0 0 0 rgba(106,215,163,.45)}70%{box-shadow:0 0 0 12px rgba(106,215,163,0)}100%{box-shadow:0 0 0 0 rgba(106,215,163,0)}}
  .rds-live-term-idle{border-radius:12px;background:linear-gradient(180deg,#0a110e,#070b09)}
  .rds-live-term-idle-summary{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 14px;font-family:var(--font-ribbon);font-size:12px;color:#9aa69f;list-style:none}
  .rds-live-term-idle-summary::-webkit-details-marker{display:none}
  .rds-live-term-idle-summary:hover{color:#dcf2e6}
  .rds-live-term-idle-caret{display:inline-flex;transition:transform .18s ease;color:#6c7e73}
  .rds-live-term-idle[open] .rds-live-term-idle-caret{transform:rotate(180deg)}
  .rds-live-term-idle-inner{padding:0 12px 12px}
  .rds-live-term-expand-link{font-size:11px;color:#6ad7a3}
  .rds-live-term-expand-link:hover{text-decoration:underline}
  #stage-summary-host,
  #stage-summary-host ul,
  #stage-summary-host li,
  #stage-summary-host div {
    font-family: var(--font-body);
  }
  #stage-summary-host ul {
    list-style-position: outside;
    padding-left: 1.15rem;
    font-size: 13px;
    line-height: 20px;
  }
  #stage-summary-host li + li {
    margin-top: 2px;
  }
  #stage-bar-host {
    scrollbar-gutter: stable;
  }
</style>
</head>
<body class="bg-background text-on-surface h-screen flex overflow-hidden selection:bg-primary-container selection:text-on-primary-container font-body">
${sidenav(navKey)}
<div id="rds-mobile-overlay" class="rds-mobile-overlay hidden fixed inset-0 z-30 bg-black/60 md:hidden" onclick="rdsToggleNav(false)"></div>
<div class="rds-app-shell flex-1 flex flex-col h-screen overflow-hidden min-w-0">
  ${topbar({ activeTab: opts.topbarTab })}
  <main class="rds-main flex-1 overflow-y-auto custom-scrollbar p-container-padding bg-background pb-12">
    ${body}
  </main>
  ${ribbonFooter()}
</div>
<!-- RDS modal mount (in-app dialogs replace native confirm/alert/prompt) -->
<div id="rds-modal-root" class="hidden fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-start justify-center pt-24 px-4">
  <div id="rds-modal-card" class="bg-surface-container border border-outline-variant rounded-DEFAULT shadow-2xl max-w-md w-full overflow-hidden animate-rds-modal-in">
    <div id="rds-modal-head" class="px-container-padding py-3 border-b border-outline-variant flex items-center gap-2">
      <span id="rds-modal-icon" class="material-symbols-outlined text-primary-container text-[20px]">help</span>
      <h2 id="rds-modal-title" class="font-h2 text-h2 text-on-surface flex-1 truncate">Confirm</h2>
      <button id="rds-modal-x" type="button" class="text-on-surface-variant hover:text-on-surface transition-colors flex items-center" aria-label="Close">
        <span class="material-symbols-outlined text-[18px]">close</span>
      </button>
    </div>
    <div id="rds-modal-body" class="px-container-padding py-3 font-body text-body text-on-surface-variant whitespace-pre-wrap break-words"></div>
    <div id="rds-modal-input-wrap" class="px-container-padding pb-3 hidden">
      <input id="rds-modal-input" type="text" class="w-full bg-[#101412] panel-border rounded px-2 py-1.5 font-code text-[13px] text-on-surface focus:border-primary-container focus:ring-0 focus:outline-none placeholder-[#7d8781]">
    </div>
    <div class="px-container-padding pb-3 pt-1 flex justify-end gap-2">
      <button id="rds-modal-cancel" type="button" class="px-3 py-1.5 border border-outline-variant bg-surface hover:bg-surface-bright text-on-surface rounded-DEFAULT font-ribbon text-ribbon transition-colors">Cancel</button>
      <button id="rds-modal-ok" type="button" class="px-3 py-1.5 bg-primary-container hover:bg-surface-tint text-on-primary-container rounded-DEFAULT font-ribbon text-ribbon font-bold transition-colors">OK</button>
    </div>
  </div>
</div>
<!-- RDS toast mount (replaces native alert for non-blocking notices) -->
<div id="rds-toast-root" class="fixed top-4 right-4 z-[60] flex flex-col gap-2 pointer-events-none"></div>
<script>
  // Auto-provision the dashboard token: anyone who can render this page
  // already has access, so we sync it into localStorage so write actions
  // (start build, watchdog toggle, approve/reject, deploy) just work.
  ${DASHBOARD_TOKEN ? `
  (function () {
    var t = ${JSON.stringify(DASHBOARD_TOKEN)};
    if (t && localStorage.getItem('rds_token') !== t) localStorage.setItem('rds_token', t);
  })();
  ` : ""}
  // ---- RDS in-app modal/toast (replaces native confirm/alert/prompt) ------
  var __rdsModalState = { resolver: null };
  function __rdsModalEls() {
    return {
      root: document.getElementById('rds-modal-root'),
      title: document.getElementById('rds-modal-title'),
      icon: document.getElementById('rds-modal-icon'),
      body: document.getElementById('rds-modal-body'),
      inputWrap: document.getElementById('rds-modal-input-wrap'),
      input: document.getElementById('rds-modal-input'),
      ok: document.getElementById('rds-modal-ok'),
      cancel: document.getElementById('rds-modal-cancel'),
      close: document.getElementById('rds-modal-x')
    };
  }
  function __rdsCloseModal(value) {
    var el = __rdsModalEls();
    if (!el.root) return;
    el.root.classList.add('hidden');
    el.input.value = '';
    el.inputWrap.classList.add('hidden');
    var r = __rdsModalState.resolver;
    __rdsModalState.resolver = null;
    if (r) r(value);
  }
  function __rdsOpenModal(opts) {
    var el = __rdsModalEls();
    if (!el.root) return Promise.resolve(null);
    if (__rdsModalState.resolver) __rdsCloseModal(null);
    el.title.textContent = opts.title || 'Confirm';
    el.body.textContent = opts.message || '';
    el.icon.textContent = opts.iconName || 'help';
    el.icon.classList.remove('text-primary-container','text-tertiary-container','text-error');
    el.icon.classList.add(opts.iconColor || 'text-primary-container');
    el.ok.textContent = opts.okLabel || 'OK';
    el.ok.classList.remove('bg-primary-container','hover:bg-surface-tint','text-on-primary-container','bg-error','hover:bg-error/80','text-on-error','bg-tertiary-container','hover:bg-tertiary-container/80','text-on-tertiary-container');
    if (opts.danger) {
      el.ok.classList.add('bg-error','hover:bg-error/80','text-on-error');
    } else if (opts.warn) {
      el.ok.classList.add('bg-tertiary-container','hover:bg-tertiary-container/80','text-on-tertiary-container');
    } else {
      el.ok.classList.add('bg-primary-container','hover:bg-surface-tint','text-on-primary-container');
    }
    el.cancel.textContent = opts.cancelLabel || 'Cancel';
    el.cancel.style.display = opts.hideCancel ? 'none' : '';
    if (opts.kind === 'prompt') {
      el.inputWrap.classList.remove('hidden');
      el.input.value = opts.defaultValue || '';
      el.input.placeholder = opts.placeholder || '';
      setTimeout(function () { el.input.focus(); el.input.select(); }, 30);
    } else {
      el.inputWrap.classList.add('hidden');
      setTimeout(function () { el.ok.focus(); }, 30);
    }
    el.root.classList.remove('hidden');
    return new Promise(function (resolve) {
      __rdsModalState.resolver = resolve;
    });
  }
  document.addEventListener('DOMContentLoaded', function () {
    var el = __rdsModalEls();
    if (!el.root) return;
    el.ok.addEventListener('click', function () {
      var v = el.inputWrap.classList.contains('hidden') ? true : (el.input.value || '');
      __rdsCloseModal(v);
    });
    el.cancel.addEventListener('click', function () { __rdsCloseModal(null); });
    el.close.addEventListener('click', function () { __rdsCloseModal(null); });
    el.root.addEventListener('click', function (ev) { if (ev.target === el.root) __rdsCloseModal(null); });
    el.input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); __rdsCloseModal(el.input.value || ''); }
      if (ev.key === 'Escape') { ev.preventDefault(); __rdsCloseModal(null); }
    });
    document.addEventListener('keydown', function (ev) {
      if (el.root.classList.contains('hidden')) return;
      if (ev.key === 'Escape') { __rdsCloseModal(null); }
    });
  });
  function rdsConfirm(message, opts) {
    opts = opts || {};
    return __rdsOpenModal({
      kind: 'confirm', title: opts.title || 'Confirm', message: message,
      iconName: opts.iconName || (opts.danger ? 'warning' : 'help'),
      iconColor: opts.iconColor || (opts.danger ? 'text-error' : opts.warn ? 'text-tertiary-container' : 'text-primary-container'),
      okLabel: opts.okLabel || 'Confirm', cancelLabel: opts.cancelLabel || 'Cancel',
      danger: !!opts.danger, warn: !!opts.warn
    }).then(function (v) { return v === true; });
  }
  function rdsPrompt(message, defaultValue, opts) {
    opts = opts || {};
    return __rdsOpenModal({
      kind: 'prompt', title: opts.title || 'Input required', message: message,
      iconName: 'edit', iconColor: 'text-primary-container',
      okLabel: opts.okLabel || 'Save', cancelLabel: opts.cancelLabel || 'Cancel',
      defaultValue: defaultValue || '', placeholder: opts.placeholder || ''
    }).then(function (v) { return v === null ? null : String(v); });
  }
  function rdsToast(message, kind) {
    var root = document.getElementById('rds-toast-root');
    if (!root) return;
    kind = kind === 'error' || kind === 'warn' ? kind : 'info';
    var iconName = kind === 'error' ? 'error' : kind === 'warn' ? 'warning' : 'check_circle';
    var title = kind === 'error' ? 'Action failed' : kind === 'warn' ? 'Needs attention' : 'Done';
    var text = String(message || '');
    var safeText = text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    var div = document.createElement('div');
    div.className = 'rds-toast rds-toast-' + kind + ' pointer-events-auto animate-rds-toast-in';
    div.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    div.innerHTML = '<span class="material-symbols-outlined rds-toast-icon">' + iconName + '</span>'
      + '<span><strong class="rds-toast-title">' + title + '</strong><span class="rds-toast-message">' + safeText + '</span></span>'
      + '<button type="button" class="rds-toast-close" aria-label="Dismiss notification"><span class="material-symbols-outlined text-[16px]">close</span></button>';
    root.appendChild(div);
    var remove = function () {
      div.style.transition = 'opacity 200ms';
      div.style.opacity = '0';
      setTimeout(function () { if (div.parentNode) div.parentNode.removeChild(div); }, 220);
    };
    div.querySelector('button')?.addEventListener('click', remove);
    setTimeout(remove, kind === 'error' ? 7000 : 4000);
  }
  function rdsAlert(message, kind) { rdsToast(message, kind || 'info'); }
  function rdsToggleNav(force) {
    var nav = document.getElementById('rds-sidenav');
    var overlay = document.getElementById('rds-mobile-overlay');
    if (!nav || !overlay) return;
    var next = typeof force === 'boolean' ? force : !nav.classList.contains('is-open');
    nav.classList.toggle('is-open', next);
    overlay.classList.toggle('is-open', next);
    overlay.classList.toggle('hidden', !next);
  }
  (function () {
    var startX = 0, startY = 0, tracking = false;
    document.addEventListener('touchstart', function (ev) {
      var nav = document.getElementById('rds-sidenav');
      if (!nav || !nav.classList.contains('is-open') || !ev.touches || !ev.touches.length) return;
      var t = ev.touches[0];
      startX = t.clientX; startY = t.clientY; tracking = true;
    }, { passive: true });
    document.addEventListener('touchmove', function (ev) {
      if (!tracking || !ev.touches || !ev.touches.length) return;
      var t = ev.touches[0];
      var dx = t.clientX - startX;
      var dy = Math.abs(t.clientY - startY);
      if (dx < -70 && dy < 60) {
        tracking = false;
        rdsToggleNav(false);
      }
    }, { passive: true });
    document.addEventListener('touchend', function () { tracking = false; }, { passive: true });
  })();
  window.rdsConfirm = rdsConfirm;
  window.rdsPrompt = rdsPrompt;
  window.rdsToast = rdsToast;
  window.rdsAlert = rdsAlert;
  window.rdsToggleNav = rdsToggleNav;

  function rdsClearToken() { localStorage.removeItem('rds_token'); rdsToast('Local token cleared. Reload to re-provision.', 'info'); }
  async function rdsPollChatBadge() {
    try {
      var res = await fetch('/chat/unread');
      if (!res.ok) return;
      var data = await res.json();
      var badge = document.getElementById('rds-chat-nav-badge');
      if (!badge) return;
      if (data.unread > 0) {
        badge.textContent = String(data.unread);
        badge.classList.remove('hidden');
      } else {
        badge.classList.add('hidden');
        badge.textContent = '';
      }
    } catch (e) { /* ignore */ }
  }
  rdsPollChatBadge();
  setInterval(rdsPollChatBadge, 7000);
  function rdsSearch(ev) {
    var q = ((ev && ev.target && ev.target.value) || '').trim().toLowerCase();
    document.querySelectorAll('[data-search]').forEach(function (row) {
      var text = (row.getAttribute('data-search') || '').toLowerCase();
      row.style.display = (!q || text.indexOf(q) !== -1) ? '' : 'none';
    });
  }
  window.rdsClearToken = rdsClearToken;
  window.rdsSearch = rdsSearch;

  document.addEventListener('click', function (ev) {
    var t = ev.target;
    while (t && t !== document.body) {
      if (t.getAttribute && t.getAttribute('data-stop') === '1') return;
      if (t.tagName === 'A' || t.tagName === 'BUTTON' ||
          t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return;
      if (t.classList && t.classList.contains('row-clickable')) {
        var href = t.getAttribute('data-href');
        if (!href) return;
        if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button === 1) window.open(href, '_blank');
        else location.href = href;
        return;
      }
      t = t.parentNode;
    }
  });
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') rdsToggleNav(false);
    // Keyboard access for click-to-open table rows.
    if ((ev.key === 'Enter' || ev.key === ' ') && ev.target && ev.target.classList &&
        ev.target.classList.contains('row-clickable')) {
      var href = ev.target.getAttribute('data-href');
      if (href) { ev.preventDefault(); location.href = href; }
    }
  });
  window.addEventListener('resize', function () {
    if (window.innerWidth >= 768) rdsToggleNav(false);
  });
</script>
</body>
</html>`;
}


// ---------- bootstrap -------------------------------------------------------

console.log(`[rds-dashboard] listening on http://0.0.0.0:${PORT} (RDS_ROOT=${RDS_ROOT}, token=${DASHBOARD_TOKEN ? "set" : "UNSET"})`);
export default {
  port: PORT,
  hostname: "0.0.0.0",
  idleTimeout: 120,
  fetch: app.fetch
};
