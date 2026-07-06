#!/usr/bin/env bash
set -euo pipefail

APP_NAME="${1:-rds_3d_experience}"
APP_DEST="${2:?app destination required}"

slug="$(printf '%s' "$APP_NAME" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//; s/-+/-/g')"
[[ -n "$slug" ]] || slug="rds-3d-experience"

mkdir -p "$APP_DEST/src/scenes" "$APP_DEST/src/components" "$APP_DEST/src/hooks" "$APP_DEST/src/stores" "$APP_DEST/src/shaders" "$APP_DEST/public/models" "$APP_DEST/public/textures" "$APP_DEST/assets/reference" "$APP_DEST/scripts" "$APP_DEST/tmp/pids" "$APP_DEST/log"

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
    "test": "bun run build",
    "assets:inspect": "node scripts/inspect-assets.mjs"
  },
  "dependencies": {
    "@react-three/drei": "latest",
    "@react-three/fiber": "latest",
    "@types/react": "latest",
    "@types/react-dom": "latest",
    "@vitejs/plugin-react": "latest",
    "lucide-react": "latest",
    "react": "latest",
    "react-dom": "latest",
    "three": "latest",
    "typescript": "latest",
    "vite": "latest",
    "zustand": "latest"
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
    <title>RDS 3D Experience</title>
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
  "include": ["src", "vite.config.ts"],
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
import { Canvas } from "@react-three/fiber";
import { MainScene } from "./scenes/MainScene";

export default function App() {
  return (
    <main className="shell">
      <section className="scene-panel" aria-label="3D scene preview">
        <Canvas
          camera={{ position: [3.5, 2.4, 5], fov: 45 }}
          dpr={[1, 1.75]}
          gl={{ antialias: true, powerPreference: "high-performance", preserveDrawingBuffer: true }}
        >
          <MainScene />
        </Canvas>
      </section>
      <aside className="hud" aria-label="Scene status">
        <p className="eyebrow">RDS web-3d stack</p>
        <h1>Interactive scene online</h1>
        <p>Vite, React, Three.js, and React Three Fiber are ready for the PRD-specific build.</p>
      </aside>
    </main>
  );
}
TSX

cat > "$APP_DEST/src/scenes/MainScene.tsx" <<'TSX'
import { Environment, Float, Grid, OrbitControls, Text } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useRef } from "react";
import type { Mesh } from "three";

export function MainScene() {
  const mesh = useRef<Mesh>(null);

  useFrame((_, delta) => {
    if (mesh.current) {
      mesh.current.rotation.x += delta * 0.28;
      mesh.current.rotation.y += delta * 0.42;
    }
  });

  return (
    <>
      <color attach="background" args={["#101318"]} />
      <ambientLight intensity={0.55} />
      <directionalLight position={[4, 6, 4]} intensity={2.2} castShadow />
      <Float speed={1.4} rotationIntensity={0.6} floatIntensity={0.45}>
        <mesh ref={mesh} position={[0, 0.4, 0]} castShadow>
          <torusKnotGeometry args={[0.85, 0.26, 144, 18]} />
          <meshStandardMaterial color="#6ee7b7" metalness={0.2} roughness={0.32} />
        </mesh>
      </Float>
      <Text position={[0, -1.35, 0]} fontSize={0.22} color="#e5edf5" anchorX="center" anchorY="middle">
        Replace with product scene, GLTF, or game camera
      </Text>
      <Grid args={[10, 10]} cellColor="#334155" sectionColor="#64748b" fadeDistance={16} position={[0, -1.2, 0]} />
      <Environment preset="city" />
      <OrbitControls enablePan={false} minDistance={3} maxDistance={8} />
    </>
  );
}
TSX

cat > "$APP_DEST/src/index.css" <<'CSS'
:root {
  color: #e5edf5;
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

.shell {
  min-height: 100vh;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(280px, 420px);
}

.scene-panel {
  min-height: 100vh;
}

.hud {
  align-self: end;
  padding: 40px;
}

.eyebrow {
  color: #6ee7b7;
  font-size: 12px;
  font-weight: 800;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

h1 {
  margin: 0;
  font-size: clamp(36px, 6vw, 72px);
  line-height: 0.95;
}

p {
  color: #a8b3c2;
  font-size: 17px;
  line-height: 1.55;
}

canvas {
  display: block;
}

@media (max-width: 820px) {
  .shell {
    grid-template-columns: 1fr;
    grid-template-rows: 68vh auto;
  }

  .scene-panel {
    min-height: 68vh;
  }

  .hud {
    padding: 24px;
  }
}
CSS

cat > "$APP_DEST/assets/reference/scene-spec.md" <<'MD'
# Scene Spec

- Camera: 45 degree FOV, three-quarter product angle.
- Lighting: soft environment light plus one strong key light.
- Target: replace starter torus with the PRD's product, world, or game scene.
- Motion: keep motion purposeful; avoid per-frame React state.
- QA: screenshot the canvas at desktop and mobile sizes and confirm nonblank render.
MD

cat > "$APP_DEST/scripts/inspect-assets.mjs" <<'JS'
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const roots = ["public/models", "public/textures"];
let total = 0;
for (const root of roots) {
  try {
    for (const file of readdirSync(root)) {
      const path = join(root, file);
      const stat = statSync(path);
      if (stat.isFile()) {
        total += stat.size;
        console.log(`${path}\t${Math.round(stat.size / 1024)} KB`);
      }
    }
  } catch {
    // Optional asset folder.
  }
}
console.log(`asset_total_kb=${Math.round(total / 1024)}`);
JS

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
# RDS Web-3D Build Notes

- Keep this as a Vite + React Three Fiber project.
- Preserve a rendered canvas at `/`; RDS uses browser screenshots and canvas checks during QA.
- Put GLTF/texture assets under `public/models` and `public/textures`.
- Avoid per-frame React state; mutate refs in `useFrame` and keep UI state separate.
MD

echo "Initialized web-3d app at $APP_DEST"
