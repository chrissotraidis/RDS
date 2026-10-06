// dashboard/tests/seed-selftest-fixtures.ts
//
// Seeds the build folders that dashboard/tests/selftest.ts expects but does
// not create itself, so the full suite can run on a clean machine (CI) instead
// of skipping or failing on a missing operator build:
//
//   - a "pong" build with an app folder and one Playwright QA iteration
//     (selftest prefers a row whose id contains "pong")
//   - the pending-review Trove build
//   - an approved terminal build
//   - an older build that is live on Zo (the Hub must list it first)
//
// Usage: RDS_BUILDS_DIR=/tmp/rds/builds bun run tests/seed-selftest-fixtures.ts
// Existing folders are left alone, so this never overwrites real builds.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const RDS_ROOT = process.env.RDS_ROOT || (existsSync(join(process.cwd(), "AGENT.md")) ? process.cwd() : join(process.cwd(), ".."));
const BUILDS_DIR = process.env.RDS_BUILDS_DIR || join(RDS_ROOT, "builds");

const now = Date.now();
const iso = (hoursAgo: number) => new Date(now - hoursAgo * 3_600_000).toISOString();
const done = { status: "done" };
const allStages = Object.fromEntries(
  ["intake", "spec", "taste", "skill-resolve", "rails-init", "scaffold", "skill-install", "local-run", "deploy", "qa", "taste-review"].map((s) => [s, done]),
);

function write(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n");
}

function seed(id: string, files: Record<string, unknown>) {
  const dir = join(BUILDS_DIR, id);
  if (existsSync(join(dir, "state.json"))) {
    console.log("[seed] keep " + id);
    return;
  }
  for (const [rel, value] of Object.entries(files)) write(join(dir, rel), value);
  console.log("[seed] wrote " + id);
}

const pongId = "pong-selftest-20260101-000000";
const pongApp = join(BUILDS_DIR, "_selftest-apps", "pong");
write(join(pongApp, "index.html"), "<!doctype html><title>Pong</title><canvas id=game></canvas>\n");
write(join(pongApp, "README.md"), "# Pong\n\nSelftest fixture app.\n");
seed(pongId, {
  "state.json": {
    build_id: pongId,
    display_name: "Pong",
    mode: "green",
    app_type: "game",
    stack: "react",
    status: "done",
    stage: "qa",
    app_dest: pongApp,
    started_at: iso(3),
    updated_at: iso(2),
    inference: { provider: "claude" },
    stages: allStages,
  },
  "spec.md": "# Pong\n\nA two-player paddle game in the browser.\n",
  "logs/scaffold.log": "task 1 ok\n",
  "playwright/iter-1/summary.json": { converged: true, gapsFound: 0 },
});

const troveId = "ok-this-is-the-plan-for-trove-review-the-prd-fil-20260523-220809";
seed(troveId, {
  "state.json": {
    build_id: troveId,
    display_name: "Trove Vinyl Portfolio",
    mode: "green",
    app_type: "website",
    stack: "nextjs",
    status: "pending_review",
    stage: "taste-review",
    started_at: iso(6),
    updated_at: iso(5),
    review: { status: "pending" },
    inference: { provider: "codex" },
    stages: allStages,
  },
  "evidence-ledger.json": {
    verdict: "pending_review",
    blockers: [],
    summary: { nextAction: "Open the preview, inspect the app, then approve or reject.", operatorReviewStatus: "pending" },
  },
});

const approvedId = "the-web-agnostic-master-prompt-1777549671354-20260430-114751";
seed(approvedId, {
  "state.json": {
    build_id: approvedId,
    display_name: "Web Agnostic Master Prompt",
    mode: "green",
    app_type: "web-app",
    stack: "rails-web",
    status: "done",
    stage: "approved",
    started_at: iso(30),
    updated_at: iso(29),
    review: { status: "approved", decided_by: "operator" },
    inference: { provider: "claude" },
    stages: allStages,
  },
});

const hostedId = "field-notes-hosted-20251201-000000";
seed(hostedId, {
  "state.json": {
    build_id: hostedId,
    display_name: "Field Notes",
    mode: "green",
    app_type: "content-site",
    stack: "astro",
    status: "done",
    stage: "approved",
    preview_url: "https://field-notes.example.com",
    started_at: iso(400),
    updated_at: iso(399),
    review: { status: "approved", decided_by: "operator" },
    inference: { provider: "codex" },
    stages: allStages,
  },
  "service.json": { service_id: "svc-selftest", label: "field-notes", url: "https://field-notes.example.com", status: "live" },
});
