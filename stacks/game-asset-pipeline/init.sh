#!/usr/bin/env bash
set -euo pipefail

APP_NAME="${1:-rds_asset_pipeline}"
APP_DEST="${2:?app destination required}"

slug="$(printf '%s' "$APP_NAME" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//; s/-+/-/g')"
[[ -n "$slug" ]] || slug="rds-asset-pipeline"

mkdir -p "$APP_DEST/pipeline/transforms" "$APP_DEST/pipeline/renderers" "$APP_DEST/scripts" "$APP_DEST/spec" "$APP_DEST/assets/in" "$APP_DEST/assets/out" "$APP_DEST/assets/cache" "$APP_DEST/web/models" "$APP_DEST/tests/fixtures" "$APP_DEST/tmp/pids" "$APP_DEST/log"

cat > "$APP_DEST/pyproject.toml" <<TOML
[project]
name = "${slug}"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = [
  "pytest>=9.0",
  "pyyaml>=6.0",
]

[tool.pytest.ini_options]
testpaths = ["tests"]
pythonpath = ["."]
TOML

cat > "$APP_DEST/.python-version" <<'EOF'
3.12
EOF

cat > "$APP_DEST/Makefile" <<'MK'
.PHONY: process preview test serve

process:
	uv run python scripts/process_asset.py --input assets/in/sample_asset.json --spec spec/target_spec.yaml

preview:
	uv run python scripts/build_preview.py

test:
	uv run pytest -q

serve:
	uv run python scripts/serve_preview.py
MK

cat > "$APP_DEST/pipeline/__init__.py" <<'PY'
__all__ = ["config", "io_trimesh", "io_usd"]
PY

cat > "$APP_DEST/pipeline/config.py" <<'PY'
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ASSETS_IN = ROOT / "assets" / "in"
ASSETS_OUT = ROOT / "assets" / "out"
WEB = ROOT / "web"
PY

cat > "$APP_DEST/pipeline/io_blender.py" <<'PY'
import shutil


def blender_available() -> bool:
    return shutil.which("blender") is not None


def require_blender() -> None:
    if not blender_available():
        raise RuntimeError("Blender is not installed on this Zo image; use fallback transforms or install Blender before bpy jobs.")
PY

cat > "$APP_DEST/pipeline/io_usd.py" <<'PY'
from pathlib import Path


def write_placeholder_usda(path: Path, name: str) -> None:
    path.write_text(f'#usda 1.0\n\ndef Xform "{name}" {{}}\n', encoding="utf-8")
PY

cat > "$APP_DEST/pipeline/io_trimesh.py" <<'PY'
from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def load_asset(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def summarize_asset(asset: dict[str, Any]) -> dict[str, Any]:
    vertices = int(asset.get("vertices", 0))
    triangles = int(asset.get("triangles", 0))
    return {
        "name": asset.get("name", "asset"),
        "vertices": vertices,
        "triangles": triangles,
        "estimated_lod1_triangles": max(1, triangles // 2),
    }
PY

cat > "$APP_DEST/pipeline/transforms/normalize_scale.py" <<'PY'
def normalize_scale(value: float, target: float = 1.0) -> float:
    if value <= 0:
        raise ValueError("scale must be positive")
    return target / value
PY

cat > "$APP_DEST/pipeline/transforms/decimate.py" <<'PY'
def decimate_triangles(triangles: int, ratio: float) -> int:
    if not 0 < ratio <= 1:
        raise ValueError("ratio must be between 0 and 1")
    return max(1, int(triangles * ratio))
PY

cat > "$APP_DEST/pipeline/transforms/bake_textures.py" <<'PY'
def clamp_texture_resolution(size: int, max_size: int) -> int:
    if size <= 0 or max_size <= 0:
        raise ValueError("texture sizes must be positive")
    return min(size, max_size)
PY

cat > "$APP_DEST/pipeline/renderers/turntable.py" <<'PY'
from pathlib import Path


def write_placeholder_turntable(path: Path, title: str) -> None:
    path.write_text(f"Turntable placeholder for {title}\n", encoding="utf-8")
PY

cat > "$APP_DEST/scripts/process_asset.py" <<'PY'
from __future__ import annotations

import argparse
import json
from pathlib import Path

import yaml

from pipeline.config import ASSETS_OUT
from pipeline.io_trimesh import load_asset, summarize_asset
from pipeline.io_usd import write_placeholder_usda


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--spec", required=True)
    args = parser.parse_args()

    source = Path(args.input)
    spec = yaml.safe_load(Path(args.spec).read_text(encoding="utf-8"))
    asset = load_asset(source)
    summary = summarize_asset(asset)
    summary["target"] = spec.get("name", "target")
    summary["formats"] = spec.get("formats", [])
    ASSETS_OUT.mkdir(parents=True, exist_ok=True)
    (ASSETS_OUT / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    write_placeholder_usda(ASSETS_OUT / "scene.usda", summary["name"])
    print(json.dumps(summary))


if __name__ == "__main__":
    main()
PY

cat > "$APP_DEST/scripts/build_preview.py" <<'PY'
from __future__ import annotations

import json
import shutil
from pathlib import Path

from pipeline.config import ASSETS_OUT, WEB


def main() -> None:
    WEB.mkdir(parents=True, exist_ok=True)
    (WEB / "models").mkdir(exist_ok=True)
    summary_path = ASSETS_OUT / "summary.json"
    summary = json.loads(summary_path.read_text(encoding="utf-8")) if summary_path.exists() else {"name": "pending", "triangles": 0}
    if (ASSETS_OUT / "scene.usda").exists():
      shutil.copyfile(ASSETS_OUT / "scene.usda", WEB / "models" / "scene.usda")
    (WEB / "health.json").write_text(json.dumps({"ok": True, "stack": "game-asset-pipeline"}), encoding="utf-8")
    (WEB / "index.html").write_text(f"""<!doctype html>
<html lang=\"en\">
  <head>
    <meta charset=\"UTF-8\" />
    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\" />
    <title>RDS Asset Pipeline Preview</title>
    <style>
      :root {{ color: #172033; background: #f7fafc; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }}
      body {{ margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; }}
      main {{ width: min(840px, 100%); }}
      .panel {{ border: 1px solid #cbd5e1; background: #fff; padding: 24px; }}
      .kicker {{ color: #0f766e; font-size: 12px; font-weight: 800; text-transform: uppercase; }}
      h1 {{ margin: 8px 0 12px; font-size: 44px; line-height: 1; }}
      pre {{ overflow: auto; background: #101820; color: #e2e8f0; padding: 16px; }}
      a {{ color: #0f766e; font-weight: 800; }}
    </style>
  </head>
  <body>
    <main class=\"panel\">
      <p class=\"kicker\">RDS game-asset-pipeline stack</p>
      <h1>{summary.get("name", "Asset")} processed</h1>
      <p>Processed outputs are available under <code>assets/out</code>. Blender/bpy transforms are optional until Blender is installed.</p>
      <pre>{json.dumps(summary, indent=2)}</pre>
      <a href=\"/models/scene.usda\">Download USD scene</a>
    </main>
  </body>
</html>""", encoding="utf-8")
    print(WEB / "index.html")


if __name__ == "__main__":
    main()
PY

cat > "$APP_DEST/scripts/serve_preview.py" <<'PY'
from __future__ import annotations

import http.server
import os
import socketserver
from pathlib import Path

root = Path("web").resolve()
port = int(os.environ.get("HOST_PORT") or os.environ.get("PORT") or "4000")


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(root), **kwargs)


with socketserver.TCPServer(("0.0.0.0", port), Handler) as httpd:
    print(f"asset preview listening on {port}")
    httpd.serve_forever()
PY

cat > "$APP_DEST/spec/target_spec.yaml" <<'YAML'
name: hero_lod0
formats: [usda, glb, usdz]
geometry:
  max_triangles: 50000
  must_be_watertight: true
  uv_channels: 1
materials:
  textures:
    base_color: { max_resolution: 2048, format: ktx2 }
    normal: { max_resolution: 2048, format: ktx2 }
    orm: { max_resolution: 1024, format: ktx2 }
scene:
  up_axis: Y
  unit: meter
validation:
  usd_checker: strict
  gltf_validator: strict
preview:
  turntable: { frames: 36, resolution: 512 }
YAML

cat > "$APP_DEST/assets/in/sample_asset.json" <<'JSON'
{
  "name": "sample_cube",
  "vertices": 8,
  "triangles": 12,
  "scale": 2.0,
  "textures": []
}
JSON

cat > "$APP_DEST/tests/test_pipeline.py" <<'PY'
from pipeline.io_trimesh import summarize_asset
from pipeline.transforms.decimate import decimate_triangles
from pipeline.transforms.normalize_scale import normalize_scale


def test_summarize_asset():
    summary = summarize_asset({"name": "cube", "vertices": 8, "triangles": 12})
    assert summary["estimated_lod1_triangles"] == 6


def test_transforms():
    assert decimate_triangles(100, 0.5) == 50
    assert normalize_scale(2.0) == 0.5
PY

cat > "$APP_DEST/README.md" <<'MD'
# RDS Game Asset Pipeline

This stack processes source assets from `assets/in/`, writes outputs to `assets/out/`, and serves a Zo preview from `web/`.

Blender/bpy is the long-term target runtime for complex asset transforms. The starter keeps Blender hooks isolated so the pipeline still runs on Zo when Blender is not installed.
MD

cat > "$APP_DEST/.gitignore" <<'EOF'
.venv
__pycache__
.pytest_cache
.env
assets/cache
tmp/pids
log
EOF

if [[ ! -f "$APP_DEST/.env" ]]; then
  : > "$APP_DEST/.env"
fi

cat > "$APP_DEST/AGENTS.md" <<'MD'
# RDS Game Asset Pipeline Notes

- Preserve `spec/target_spec.yaml`; it is the mockup analog for this stack.
- Keep source assets in `assets/in` and generated artifacts in `assets/out`.
- Blender/bpy transforms must remain optional unless the runtime is available.
- Do not ingest copyrighted commercial game assets unless the user explicitly confirms rights.
MD

echo "Initialized game-asset-pipeline app at $APP_DEST"
