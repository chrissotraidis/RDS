#!/usr/bin/env bash
# Verify shadcn-add installed Tailwind + shadcn + starter components.
set -euo pipefail

slug="shadcn-add"

# Repo-side self-check (manifest + guide present).
root="$(cd "$(dirname "$0")/../../.." && pwd)"
[[ -f "${root}/skills/built-in/${slug}/rds-skill.yaml" ]] || { echo "missing ${slug} manifest" >&2; exit 1; }
[[ -f "${root}/skills/built-in/${slug}/AGENTS.md"      ]] || { echo "missing ${slug} guide" >&2; exit 1; }

# When RDS_APP_DEST is set, confirm the imperative install actually landed.
if [[ -n "${RDS_APP_DEST:-}" ]]; then
  app="${RDS_APP_DEST}"
  for path in \
    ".rds/skills/${slug}.md" \
    ".rds/skills/${slug}.yaml" \
    "components.json" \
    "tailwind.config.ts" \
    "postcss.config.mjs" \
    "lib/utils.ts" \
    "components/ui/button.tsx" \
    "components/ui/card.tsx" \
    "components/ui/input.tsx" \
    "components/ui/label.tsx" \
    "components/ui/badge.tsx" \
    "app/globals.css"
  do
    [[ -f "${app}/${path}" ]] || { echo "shadcn-add verify: missing ${path}" >&2; exit 1; }
  done
  grep -q '@tailwind base'  "${app}/app/globals.css" || { echo "shadcn-add verify: globals.css missing @tailwind directives" >&2; exit 1; }
  grep -q '"tailwindcss"'   "${app}/package.json"    || { echo "shadcn-add verify: tailwindcss not in package.json" >&2; exit 1; }
fi

echo "${slug} verify ok"
