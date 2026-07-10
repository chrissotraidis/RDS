# RDS V1 Stacks and Skills

RDS V1 separates two decisions that were previously mixed together:

- **Stack**: the runtime shape of the build. It decides the starter, commands,
  preview model, smoke checks, and deployment path.
- **Skill**: a capability pack layered on top of a stack. It can add build
  context, verification expectations, integration guidance, deploy instructions,
  or stack-specific setup notes.

The dashboard exposes this in three places:

- `/new`: PRD-first analysis, recommendation, approval, and launch.
- `/settings/stacks`: stack/app-type reference with when-to-use guidance and
  external framework links.
- `/settings/skills`: searchable skill catalog with status, stack fit, source
  links, and rationale.

## Stack Status

| Status | Meaning |
|---|---|
| `ready` | Launchable from New Build. The stack has an RDS contract, manifest, init script, local-run path, doctor/smoke path, and Zo preview model. |
| `defer` | Registered for compatibility or future work, but hidden from New Build. |
| `stub` / `disabled` | Not considered launchable. |

Current launchable V1 stacks:

| Stack | Use when | External references |
|---|---|---|
| `rails-web` | Records, workflows, dashboards, admin operations, CRUD, portals. | Rails Guides, Hotwire |
| `nextjs-fullstack` | Polished React product, SaaS shell, auth/payments, customer-facing app UI. | Next.js Docs, React RSC docs |
| `python-ai-service` | FastAPI, LLM/agent backend, RAG, embeddings, webhooks, tool endpoints. | FastAPI, Pydantic AI |
| `astro-thin-web` | Marketing, docs, blogs, content hubs, SEO-heavy sites. | Astro Docs, Starlight |
| `web-3d` | Three.js/R3F scenes, product configurators, 3D explainers, model viewers. | React Three Fiber, Three.js |
| `game-engine` | Playable HTML5/browser games, abstract strategy games, loops, scoring, responsive play surfaces, and future Godot-ready work. | Playwright, Godot Docs |
| `game-asset-pipeline` | GLTF/USD processing, validation, preview, downloadable asset handoff. | OpenUSD tools, glTF Validator |
| `mobile-native` | iOS/Android-first apps with Expo/EAS path and web preview fallback. | Expo Docs, EAS Build |
| `browser-extension` | Chrome MV3, popup/content/background scripts, browser automation. | Chrome Extension docs, WXT |

`react-spa` remains registered as a deferred legacy Vite-only path. New V1 React
product work should use `nextjs-fullstack` unless the PRD explicitly requires a
Vite-only SPA.

## Skill Status

RDS does not mark a skill ready unless RDS owns enough of the implementation to
mount or verify it repeatably.

| Status | Meaning |
|---|---|
| `ready` | RDS-owned operational skill guide. It has a built-in manifest, source links, app-local materialization or metadata mount, and a verify hook. |
| `curated` | Researched but not yet promoted to a built-in guide. Currently zero catalog entries remain in this state. |
| `roadmap` | Known future candidate that should not be recommended without more work. |

Current ready RDS-owned skill coverage:

| Coverage | Examples |
|---|---|
| Core RDS safety | `rds-context7-mount`, `rds-mockup-fidelity`, `rds-secrets-broker`, `rds-eval-harness`, `rds-usd-validator` |
| Auth, payments, email | `auth-rails-generator`, `auth-better-auth`, `payments-stripe-mcp`, `email-resend`, `actionmailbox-ingest` |
| Tests and browser QA | `testing-vitest-playwright`, `playwright-mcp`, `playwright-canvas-snapshot`, `gdunit4-suite`, `pydantic-evals` |
| Data, jobs, storage | `postgres-mcp`, `solid-queue`, `arq-jobs-skill`, `storage-s3-r2`, `storage-active-storage`, `vector-pgvector` |
| Web frameworks and UI | `shadcn-add`, `hotwire-stimulus-generator`, `astro-content-collections-skill`, `starlight-add`, `hono-catchall-mount` |
| AI/MCP/search | `llm-vercel-ai-sdk`, `llm-pydantic-ai`, `litellm-gateway-skill`, `mcp-builder`, `search-meilisearch` |
| Mobile/extensions/deploy | `expo-skills-mount`, `wxt-config-skill`, `deploy-vercel`, `deploy-fly`, `deploy-eas-build`, `deploy-chrome-web-store` — note: `deploy-fly` is a capability guide only; the `fly` pipeline deploy *target* was removed (see `docs/PIPELINE.md`) |
| 3D/game/assets | `browser-game-product-quality`, `playwright-canvas-snapshot`, `r3f-drei-helpers`, `rapier-physics`, `gltf-transform-pipeline`, `gltf-validator-skill`, `godot-scene-scaffolder` |

All ready catalog entries are indexed as ready, but readiness has levels:

- **metadata + verify**: core RDS safety skills that verify registry/build
  contracts and write explicit expectations.
- **guide + verify**: capability guides materialized into the generated app
  under `.rds/skills/` with source links and verification instructions.

That does not mean RDS can bypass external account setup: deploy, payments,
app-store, OAuth, and hosted-service skills still state their credential/human
approval requirements in the mounted guide.

The latest deepening pass removed the generic placeholder language from all
ready skill guides. Every built-in skill guide now has:

- source references
- a clear "Use when" trigger
- an `Implementation contract`
- a `Verification` section
- credential/human-gate caveats where relevant

This makes the catalog honest enough for New Build recommendations. The next
quality frontier is not guide presence; it is exercising each skill against real
builds and replacing generic per-category contracts with more stack-specific
installer logic where repeated builds prove the pattern.

## Provenance Contract

Every skill catalog entry must include:

- `category`
- `maturity`
- `rationale`
- `source_links`
- `applies_to`
- `install`
- `verify`

`bin/rds-skill-index` compiles `skills/catalog/*.yaml` and
`skills/built-in/*/rds-skill.yaml` into `skills/registry.json`. Built-in ready
skills override catalog placeholders with the same slug.

Verification guard:

```bash
./bin/rds-skill-index
ruby -rjson -e 'r=JSON.parse(File.read("skills/registry.json")); abort "missing links" if r["skills"].any?{|s| !s["source_links"].is_a?(Array) || s["source_links"].empty? }'
```

## New Build Behavior

New Build does not select a default stack on page load. The intended flow is:

1. Paste a PRD, brief, URL, path, or attach a text/PDF/image source.
2. RDS analyzes source signals through `bin/rds-analyze-source` and recommends
   a stack, app type, clarification questions, and ready skills. The explicit
   dashboard Analyze source button calls this same analyzer through
   `POST /new/analyze`; browser-side scoring is only a preview/fallback. PDF
   attachments are extracted server-side for this analysis before launch.
3. The operator clicks into stack/skill references when needed.
4. The operator applies the plan or overrides it.
5. `POST /new` can call the same analyzer if a stack was not submitted; it
   rejects only when source analysis still cannot produce a launchable stack.

Skill recommendations are stack- and intent-sensitive. RDS always starts from
the core safety/runtime baseline for the selected stack. Defaults are limited to
skills that should shape nearly every build on that runtime; optional
capabilities are added only from PRD intent. The launch path only submits skills
that apply to the selected or recommended stack; incompatible skill choices are
skipped with a warning instead of aborting the build. Intent signals then add
ready skills such
as `playwright-mcp`, `testing-vitest-playwright`, `postgres-mcp`,
`auth-better-auth`, `analytics-posthog`, `observability-sentry-otel`,
`rds-eval-harness`, `rds-usd-validator`, `shadcn-add`,
`auth-rails-generator`, `payments-stripe-mcp`, `email-resend`, `solid-queue`,
`storage-s3-r2`, `llm-vercel-ai-sdk`, `llm-pydantic-ai`, `vector-pgvector`,
`drizzle-introspect-skill`, `starlight-add`, `gltf-transform-pipeline`,
`blender-mcp-mount`, or `eas-build-skill` when the stack and PRD signals
justify them.

For `game-engine`, the default browser runtime resolves
`browser-game-product-quality`, `testing-vitest-playwright`, and
`playwright-canvas-snapshot`. Godot skills remain available, but they are no
longer default for the HTML5 canvas path until the Godot runtime is actually
provisioned.

Regression: `bin/rds-analysis-fixture` verifies representative PRDs for POLIS-
style strategy games with native apps listed as Non-Goals, classic arcade game
prompts, Tetris-style terse prompts, marketing site, dashboard, browser
extension, mobile app, and Python AI service classification.

The dashboard selftest enforces the neutral initial state, PRD-driven
recommendation, stack/skill reference links, provider-specific model controls,
and the searchable reference pages. `bin/rds-v1-validate` now also fails if any
built-in skill guide regresses to generic placeholder text or lacks
implementation/verification sections.

`bin/rds-skill-matrix-audit` is the stricter default-policy guard. It verifies
the exact default bundle for every ready stack, rejects generic default-skill
guidance, and checks intent probes for optional capabilities that should not be
selected by default.
