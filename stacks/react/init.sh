#!/usr/bin/env bash
set -euo pipefail

APP_NAME="${1:-rds_react_app}"
APP_DEST="${2:?app destination required}"

slug="$(printf '%s' "$APP_NAME" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//; s/-+/-/g')"
[[ -n "$slug" ]] || slug="rds-react-app"

mkdir -p "$APP_DEST/src" "$APP_DEST/tmp/pids" "$APP_DEST/log"

cat > "$APP_DEST/package.json" <<JSON
{
  "name": "${slug}",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "test": "echo \\"No tests configured yet\\""
  },
  "dependencies": {
    "@vitejs/plugin-react": "latest",
    "vite": "latest",
    "typescript": "latest",
    "react": "latest",
    "react-dom": "latest",
    "lucide-react": "latest",
    "@types/react": "latest",
    "@types/react-dom": "latest"
  },
  "devDependencies": {}
}
JSON

cat > "$APP_DEST/index.html" <<'HTML'
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>RDS React App</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
HTML

cat > "$APP_DEST/tsconfig.json" <<'JSON'
{
  "compilerOptions": {
    "target": "ES2022",
    "useDefineForClassFields": true,
    "lib": ["DOM", "DOM.Iterable", "ES2022"],
    "allowJs": false,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "strict": true,
    "forceConsistentCasingInFileNames": true,
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx"
  },
  "include": ["src"],
  "references": []
}
JSON

cat > "$APP_DEST/vite.config.ts" <<'TS'
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    allowedHosts: true,
  },
});
TS

cat > "$APP_DEST/src/main.tsx" <<'TSX'
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
TSX

cat > "$APP_DEST/src/vite-env.d.ts" <<'TS'
/// <reference types="vite/client" />
TS

cat > "$APP_DEST/src/App.tsx" <<'TSX'
const readinessItems = [
  ["Works now", "Starter shell and Vite runtime are wired."],
  ["Seeded/sample", "Feature data is sample-only until product tasks replace this panel."],
  ["Stubbed/missing", "Production integrations, credentials, and PRD-specific workflows are not connected yet."],
  ["Review access", "Add seeded review credentials here when authentication is introduced."],
] as const;

function ReviewReadiness() {
  return (
    <section className="readiness-panel" aria-labelledby="review-readiness-title">
      <p className="eyebrow">Review mode</p>
      <h2 id="review-readiness-title">What is real right now</h2>
      <div className="readiness-grid">
        {readinessItems.map(([label, value]) => (
          <article key={label}>
            <h3>{label}</h3>
            <p>{value}</p>
          </article>
        ))}
      </div>
      <p className="readiness-note">
        Keep this panel current as seeded, stubbed, credential-gated, or missing workflows change.
      </p>
    </section>
  );
}

export default function App() {
  return (
    <main className="app-shell">
      <section className="hero">
        <p className="eyebrow">RDS React stack</p>
        <h1>Ready for implementation</h1>
        <p>
          The scaffold stage will replace this starter with the app described
          in the PRD.
        </p>
      </section>
      <ReviewReadiness />
    </main>
  );
}
TSX

cat > "$APP_DEST/src/index.css" <<'CSS'
:root {
  color: #eef2f7;
  background: #101318;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-width: 320px;
  min-height: 100vh;
}

.app-shell {
  min-height: 100vh;
  display: grid;
  align-content: center;
  justify-items: center;
  gap: 28px;
  padding: 32px;
}

.hero {
  width: min(720px, 100%);
}

.eyebrow {
  color: #5bd699;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

h1 {
  margin: 0;
  font-size: clamp(40px, 8vw, 84px);
  line-height: 0.95;
}

h2 {
  margin: 0;
  font-size: 24px;
}

h3 {
  margin: 0 0 6px;
  font-size: 14px;
  color: #eef2f7;
}

p {
  color: #a8b3c2;
  font-size: 18px;
  line-height: 1.55;
}

.readiness-panel {
  width: min(720px, 100%);
  border: 1px solid #2b3442;
  border-radius: 8px;
  padding: 20px;
  background: #151a22;
}

.readiness-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
  gap: 12px;
  margin-top: 16px;
}

.readiness-grid article {
  border: 1px solid #28313e;
  border-radius: 8px;
  padding: 12px;
  background: #101318;
}

.readiness-grid p,
.readiness-note {
  margin: 0;
  font-size: 14px;
}

.readiness-note {
  margin-top: 14px;
  color: #d3dbe6;
}
CSS

cat > "$APP_DEST/.gitignore" <<'EOF'
node_modules
dist
.env
tmp/pids
log
EOF

if [[ ! -f "$APP_DEST/.env" ]]; then
  : > "$APP_DEST/.env"
fi

cat > "$APP_DEST/AGENTS.md" <<'MD'
# RDS React Build Notes

- Keep this as a React + Vite project unless the build plan changes the stack.
- Generated product work should replace the starter UI, not the runtime plumbing.
- Preserve and update the app-visible review readiness panel until the product
  has a better truthfulness surface. It must say what works, what is
  seeded/sample, what is stubbed or credential-gated, what is missing, and how
  review credentials work.
MD

echo "Initialized React + Vite app at $APP_DEST"
