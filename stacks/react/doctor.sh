#!/usr/bin/env bash
set -euo pipefail

command -v bun >/dev/null 2>&1 || { echo "missing bun"; exit 1; }
bun --version
