#!/usr/bin/env bash
set -euo pipefail

command -v bun >/dev/null 2>&1 || { echo "missing bun"; exit 1; }
command -v node >/dev/null 2>&1 || { echo "missing node"; exit 1; }
node_major="$(node -p 'process.versions.node.split(".")[0]')"
if (( node_major < 20 )); then
  echo "node >=20 required, found $(node --version)"
  exit 1
fi
bun --version
node --version
