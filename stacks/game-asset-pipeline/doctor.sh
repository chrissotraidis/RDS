#!/usr/bin/env bash
set -euo pipefail

command -v uv >/dev/null 2>&1 || { echo "missing uv"; exit 1; }
command -v python3.12 >/dev/null 2>&1 || { echo "missing python3.12"; exit 1; }
uv --version
python3.12 --version
if command -v blender >/dev/null 2>&1; then
  blender --version | head -n1
else
  echo "blender not installed; bpy transforms disabled"
fi
