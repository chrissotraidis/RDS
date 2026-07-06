#!/usr/bin/env bash
set -euo pipefail

APP_NAME="${1:-rds_game}"
APP_DEST="${2:?app destination required}"

slug="$(printf '%s' "$APP_NAME" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//; s/-+/-/g')"
[[ -n "$slug" ]] || slug="rds-game"

mkdir -p "$APP_DEST/src" "$APP_DEST/tests" "$APP_DEST/docs" "$APP_DEST/assets/sprites" "$APP_DEST/assets/audio" "$APP_DEST/build/web" "$APP_DEST/tmp/pids" "$APP_DEST/log"

cat > "$APP_DEST/package.json" <<JSON
{
  "name": "${slug}",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "bun server.ts",
    "build": "bun scripts/build.ts",
    "test": "bun test"
  },
  "dependencies": {
    "@types/bun": "latest",
    "typescript": "latest"
  },
  "devDependencies": {}
}
JSON

cat > "$APP_DEST/tsconfig.json" <<'JSON'
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["DOM", "DOM.Iterable", "ES2022"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "skipLibCheck": true,
    "types": ["bun-types"]
  },
  "include": ["src", "tests", "server.ts", "scripts"]
}
JSON

mkdir -p "$APP_DEST/scripts"
cat > "$APP_DEST/scripts/build.ts" <<'TS'
import { copyFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const out = "build/web";
mkdirSync(out, { recursive: true });
for (const file of ["index.html", "src/game.js", "src/styles.css", "health.json"]) {
  const dest = join(out, file.replace(/^src\//, ""));
  mkdirSync(dest.split("/").slice(0, -1).join("/") || out, { recursive: true });
  copyFileSync(file, dest);
}
let size = 0;
for (const file of readdirSync(out)) {
  size += statSync(join(out, file)).size;
}
console.log(`built ${out} (${size} bytes)`);
TS

cat > "$APP_DEST/server.ts" <<'TS'
const port = Number(process.env.HOST_PORT || process.env.PORT || 4000);
const root = new URL("./build/web/", import.meta.url);

const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function typeFor(pathname: string) {
  const ext = pathname.match(/\.[^.]+$/)?.[0] || ".html";
  return types[ext] || "application/octet-stream";
}

Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);
    const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = Bun.file(new URL(`.${pathname}`, root));
    if (!(await file.exists())) return new Response("Not found", { status: 404 });
    return new Response(file, {
      headers: {
        "content-type": typeFor(pathname),
        "cross-origin-opener-policy": "same-origin",
        "cross-origin-embedder-policy": "require-corp",
      },
    });
  },
});

console.log(`game preview listening on ${port}`);
TS

cat > "$APP_DEST/index.html" <<'HTML'
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>RDS Game</title>
    <link rel="stylesheet" href="/styles.css" />
  </head>
  <body>
    <main>
      <canvas id="game" width="960" height="540" aria-label="Playable game canvas"></canvas>
      <section class="hud" aria-live="polite">
        <span id="score">Score 0</span>
        <span id="status">Arrow keys or WASD to move</span>
        <button id="restart" type="button">Restart</button>
      </section>
    </main>
    <script type="module" src="/game.js"></script>
  </body>
</html>
HTML

cat > "$APP_DEST/src/styles.css" <<'CSS'
:root {
  color: #f8fafc;
  background: #13151a;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

* { box-sizing: border-box; }
body { margin: 0; min-width: 320px; min-height: 100vh; }
main {
  min-height: 100vh;
  display: grid;
  place-items: center;
  gap: 16px;
  padding: 24px;
}
canvas {
  width: min(100%, 960px);
  aspect-ratio: 16 / 9;
  background: #0f172a;
  border: 1px solid #334155;
}
.hud {
  width: min(100%, 960px);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
button {
  min-height: 40px;
  padding: 0 14px;
  border: 1px solid #475569;
  background: #e2e8f0;
  color: #0f172a;
  font-weight: 700;
  cursor: pointer;
}
@media (max-width: 640px) {
  .hud { align-items: stretch; flex-direction: column; }
}
CSS

cat > "$APP_DEST/src/game.js" <<'JS'
const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
const scoreEl = document.getElementById("score");
const statusEl = document.getElementById("status");
const restart = document.getElementById("restart");

const keys = new Set();
let state;

function reset() {
  state = {
    player: { x: 80, y: 270, r: 18, speed: 230 },
    goal: { x: 850, y: 270, r: 24 },
    score: 0,
    won: false,
    last: performance.now(),
  };
  scoreEl.textContent = "Score 0";
  statusEl.textContent = "Arrow keys or WASD to move";
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

export function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function update(dt) {
  if (state.won) return;
  const dx = (keys.has("ArrowRight") || keys.has("d") ? 1 : 0) - (keys.has("ArrowLeft") || keys.has("a") ? 1 : 0);
  const dy = (keys.has("ArrowDown") || keys.has("s") ? 1 : 0) - (keys.has("ArrowUp") || keys.has("w") ? 1 : 0);
  const len = Math.hypot(dx, dy) || 1;
  state.player.x = clamp(state.player.x + (dx / len) * state.player.speed * dt, state.player.r, canvas.width - state.player.r);
  state.player.y = clamp(state.player.y + (dy / len) * state.player.speed * dt, state.player.r, canvas.height - state.player.r);
  if (distance(state.player, state.goal) < state.player.r + state.goal.r) {
    state.score += 1;
    state.won = true;
    scoreEl.textContent = `Score ${state.score}`;
    statusEl.textContent = "Goal reached. Restart to play again.";
  }
}

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#0f172a";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = "#1e293b";
  for (let x = 0; x < canvas.width; x += 48) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, canvas.height);
    ctx.stroke();
  }
  for (let y = 0; y < canvas.height; y += 48) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(canvas.width, y);
    ctx.stroke();
  }
  ctx.fillStyle = "#facc15";
  ctx.beginPath();
  ctx.arc(state.goal.x, state.goal.y, state.goal.r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#38bdf8";
  ctx.beginPath();
  ctx.arc(state.player.x, state.player.y, state.player.r, 0, Math.PI * 2);
  ctx.fill();
}

function loop(now) {
  const dt = Math.min(0.05, (now - state.last) / 1000);
  state.last = now;
  update(dt);
  draw();
  requestAnimationFrame(loop);
}

window.addEventListener("keydown", (event) => keys.add(event.key));
window.addEventListener("keyup", (event) => keys.delete(event.key));
restart.addEventListener("click", reset);

reset();
requestAnimationFrame(loop);
JS

cat > "$APP_DEST/health.json" <<'JSON'
{"ok":true,"stack":"game-engine"}
JSON

cat > "$APP_DEST/tests/game.test.ts" <<'TS'
import { expect, test } from "bun:test";

function distance(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

test("collision distance detects goal contact", () => {
  expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
  expect(distance({ x: 10, y: 10 }, { x: 12, y: 10 }) < 8).toBe(true);
});
TS

cat > "$APP_DEST/docs/GAMEPLAY_SPEC.md" <<'MD'
# Gameplay Spec

- Goal: move the player to the yellow target.
- Controls: arrow keys or WASD.
- Win condition: player overlaps target.
- Required states: playing, won, restart.
- QA: root page must render a canvas, keyboard input must move the player, restart must reset the game.

Godot note: the RDS V1 research target is Godot 4.6. This starter uses a browser-native canvas runtime because Godot is not installed on the current Zo image. Keep gameplay logic and specs isolated so a later Godot export can preserve behavior.
MD

cat > "$APP_DEST/docs/SCENE_REFERENCE.md" <<'MD'
# Scene Reference

Main
- Canvas renderer
- Player circle
- Goal circle
- HUD with score, status, restart

Replace these primitives with the generated game scene while preserving playable preview and health checks.
MD

cat > "$APP_DEST/.gitignore" <<'EOF'
node_modules
.env
tmp/pids
log
EOF

if [[ ! -f "$APP_DEST/.env" ]]; then
  : > "$APP_DEST/.env"
fi

cat > "$APP_DEST/AGENTS.md" <<'MD'
# RDS Game Build Notes

- Keep the game playable in browser at `/`.
- Preserve `/health.json`; RDS uses it as the stack health check.
- Preserve `docs/GAMEPLAY_SPEC.md` and update it as mechanics change.
- Any generated game must include controls, reset, win/lose or completion state, and at least one automated smoke test.
MD

echo "Initialized game-engine app at $APP_DEST"
