# Analyze Workflow Reference

This document defines the end-to-end workflow for the `/wiki:analyze`
skill: from input to wiki to spec.

---

## Overview

The analyze workflow has three phases:

```
Phase 0: Mode        Detect or accept analysis mode
Phase 1: Context     Gather inputs (code context or product artifacts)
Phase 2: Wiki        Wiki build (Claude Code, LLM)
Phase 3: Spec        Spec formalization (Claude Code, LLM)
```

Phase 0 determines which mode to operate in.
Phase 1 produces a structured context bundle (brownfield/replacement) or a
source manifest (greenfield).
Phase 2 produces a human-readable wiki.
Phase 3 produces a machine-readable spec for `arnold run`.

After initial creation, the PO Update Loop keeps wiki and spec in sync as
product decisions are made.

---

## Phase 0: Mode Detection

Determine the analysis mode before any other work.

### Explicit mode

If the user provides `--mode`, use it directly. No detection needed.

If the user provides `--target-stack` without `--mode`, set mode to
`replacement`.

### Auto-detection

When no mode is specified:

1. Check the target directory:
   - Does not exist or is empty (no files besides `.git`, `.gitignore`,
     `README.md`) → **greenfield**
   - Contains source files or package manifests → **brownfield**
2. `--target-stack` present → **replacement** (overrides directory check)

### Validation

| Mode | Required inputs | Validation |
|---|---|---|
| `greenfield` | Directory path or artifact files/URLs | Warn if directory has code |
| `brownfield` | Directory path with code | Fail if directory is empty |
| `replacement` | Directory path with code + `--target-stack` | Warn if `--target-stack` omitted (prompt for it) |

Log the detected/selected mode at the start of output:
```
Mode: greenfield (auto-detected: empty directory)
Mode: brownfield (explicit)
Mode: replacement (auto-detected: --target-stack provided)
```

---

## Phase 1: Context Gathering

This phase differs by mode.

### Brownfield / Replacement: Code Context

Run `arnold context` to get the deterministic context bundle. This is a CLI
command that makes zero LLM calls — it uses file pattern matching and signal
weighting to detect the stack and discover key artifacts.

#### Single root
```bash
arnold context <path> [--hint <framework>]
```

#### Workspace (multiple roots)
```bash
arnold context --workspace <workspace.yml>
```

#### Output structure (per root)
```json
{
  "name": "<root name>",
  "path": "<absolute path>",
  "stack": {
    "language": "<detected language>",
    "framework": "<detected or hinted framework>",
    "confidence": "<0-100>",
    "signals_matched": ["<signal descriptions>"]
  },
  "artifacts": [
    {
      "role": "<schema|routes|components|dependency_manifest|entry_point|orm_config|ci_config>",
      "path": "<relative path or null>",
      "content": "<truncated file content or null>",
      "format": "<file format>"
    }
  ],
  "file_summary": {
    "total_files": "<count>",
    "by_extension": { ".rb": 186, ".js": 42 }
  }
}
```

#### What context gives the wiki build

- **Stack fingerprint** — language, framework, confidence. Tells Claude what
  kind of codebase it's looking at before reading a single file.
- **Artifact map** — the exact locations of schema, routes, components,
  dependencies, entry points, config. These are the high-value files to read
  first.
- **File summary** — extension counts and total files. Gives a quick sense of
  codebase scale and composition.

#### When context is unavailable

If `arnold context` is not installed or fails, the wiki build proceeds without
it. Claude reads the codebase directly, starting with common file patterns
(package.json, Gemfile, requirements.txt, go.mod, etc.). This is slower and
less targeted but still functional.

### Greenfield: Artifact Gathering

Skip `arnold context` — there is no code to analyze. Instead, process the
product artifacts the user provides.

#### Artifact types and processing

| Type | Extensions / signals | Processing method |
|---|---|---|
| Text-native | `.md`, `.txt`, `.json`, `.yaml`, `.csv` | Direct parse |
| Visual | `.png`, `.jpg`, `.pdf` (with layouts/mockups) | Vision model extraction |
| Reference URL | `http://`, `https://` | Fetch → extract text content |

#### Source manifest

Build `intake/source-manifest.md` in the wiki directory:

```markdown
# Source Manifest

| Artifact | Type | Processing | Key signals |
|---|---|---|---|
| product-brief.md | text | text_parse | Features, user roles, domain |
| homepage-mockup.png | visual | vision | Layout, navigation, branding |
| https://competitor.com | url | url_fetch | Feature comparison |
```

This manifest is the greenfield equivalent of the context bundle — it tells
Phase 2 what evidence exists and where it came from.

#### What artifacts give the wiki build

- **Product intent** — what the user wants to build (from briefs, PRDs)
- **Design signals** — UI patterns, information architecture (from mockups)
- **Competitive context** — feature expectations, market positioning (from URLs)
- **Data hints** — entity names, field types (from schemas, spreadsheets)

Unlike code context, artifacts rarely provide complete coverage. Expect more
`Gap` and `Inferred` markers than in brownfield mode.

---

## Phase 2: Wiki Build

This phase uses the wiki-steward workflow, seeded with the context bundle.

### Step 2a: Bootstrap with context

Instead of blind file discovery, the bootstrap uses the context bundle:

1. Read the context JSON for each root
2. For each discovered artifact (schema, routes, components, etc.), read the
   full file content — these are the highest-signal files
3. Start the intake manifest pre-populated with artifact paths and stack info
4. Run `bootstrap_wiki.py` to scaffold the wiki structure

### Step 2b: Fill baseline pages

With the context providing the map, fill wiki pages systematically:

| Context signal | Wiki pages to fill |
|---|---|
| `artifacts[role=schema]` | `engineering/data-and-entities.md` |
| `artifacts[role=routes]` | `engineering/interfaces-and-integrations.md`, `design/information-architecture.md` |
| `artifacts[role=components]` | `design/information-architecture.md`, `product/features-and-capabilities.md` |
| `artifacts[role=dependency_manifest]` | `engineering/interfaces-and-integrations.md` (external deps) |
| `artifacts[role=entry_point]` | `product/overview.md` (application type) |
| `artifacts[role=ci_config]` | `operations/release-and-support.md` |
| `stack.framework` | All pages (domain vocabulary, expected patterns) |

For each page, follow the page contract from `references/wiki-blueprint.md`:
Purpose, Confirmed, Inferred, Gaps, Open questions, Sources.

### Step 2c: Specialist passes

After baseline is established, run specialist passes per
`references/agent-topology.md`:

- Gap analysis: contradictions, missing requirements, edge cases
- UX review: friction, terminology, accessibility
- Research: external facts for integrations, standards, regulations
- Question curation: PO-ready decision questions

### Step 2d: Multi-root synthesis

For workspaces with multiple roots:

1. Build each root's wiki pages independently
2. Then do a cross-root synthesis pass:
   - Read all `engineering/data-and-entities.md` pages across roots
   - Identify shared entities (same name, similar attributes)
   - Map cross-root data flows (frontend calls backend APIs, etc.)
   - Identify naming inconsistencies (same concept, different names)
   - Surface contradictions in `intake/synthesis-notes.md`

### Step 2e: Index

Run `build_wiki_index.py` to create the retrieval index.

---

## Phase 3: Spec Formalization

Read the completed wiki and transform into the spec format defined in
`references/spec-format.md`.

### Process

1. Read `wiki/index.md` for the product overview
2. For each spec section (1-11), read the mapped wiki pages
   (see mapping table in `references/spec-format.md`)
3. Transform wiki content into spec format:
   - Wiki "Confirmed" sections become `[CONFIRMED]` requirements
   - Wiki "Inferred" sections become `[INFERRED]` requirements
   - Wiki "Gaps" become `[GAP]` entries
   - Wiki "Open questions" become OQ entries in Section 11
4. Generate GWT (Given/When/Then) scenarios from journey descriptions
5. Assign requirement IDs: `[REQ-{DOMAIN}-{NNN}]`
6. Build the JSON metadata block from wiki content
7. Build the Source Provenance table mapping features to wiki pages

### Mode-specific spec behavior

#### Brownfield

Produce a single as-built spec. The JSON metadata block includes:
```json
{ "spec_type": "as_built" }
```

Output: `spec.md`

#### Greenfield

Produce a single target spec. The JSON metadata block includes:
```json
{ "spec_type": "target" }
```

Greenfield specs will have more `[INFERRED]` and `[GAP]` markers than
brownfield specs — this is expected. The completeness heuristic from the wiki
index (`wiki-index.json`) determines spec readiness:
- No wiki page scores 0 (empty)
- Product section pages average 2+ (partial or better)
- No HIGH-priority open questions remain

Output: `spec.md`

#### Replacement

Produce two specs from the same wiki:

1. **As-built spec** (`spec.as-built.md`) — documents the existing system
   exactly as brownfield mode would. `spec_type: as_built`.

2. **Target spec** (`spec.target.md`) — derived from the as-built spec with
   these transformations:
   - Tech stack section updated to `--target-stack` value
   - Implementation-specific details generalized:
     - ORM column types → logical types (`varchar(255)` → `string`)
     - Framework-specific patterns → generic descriptions
     - Library references → capability descriptions
   - All functional requirements preserved verbatim
   - `spec_type: target`, `target_stack: <value>` in metadata

   The target spec does NOT make triage decisions (keep/change/drop) — that
   is deferred to the `/wiki:triage` skill (Phase B). At this stage,
   every feature is assumed to be `keep`.

Output: `spec.as-built.md` + `spec.target.md`

### Multi-root spec generation

For workspaces:
1. Produce one spec per root, focused on that root's capabilities
2. Produce one workspace-level synthesis spec that:
   - Uses the project name from workspace.yml
   - Unifies entities across roots
   - Maps which root implements which features
   - Includes cross-root contradictions as `[CONFLICT]` entries

In replacement mode, each root gets both as-built and target variants:
- `spec.<root>.as-built.md` + `spec.<root>.target.md`
- `spec.workspace.as-built.md` + `spec.workspace.target.md`

### Output

| Mode | Single root | Multi-root |
|---|---|---|
| Brownfield | `spec.md` | `spec.<root>.md` + `spec.workspace.md` |
| Greenfield | `spec.md` | `spec.<root>.md` + `spec.workspace.md` |
| Replacement | `spec.as-built.md` + `spec.target.md` | `spec.<root>.{as-built,target}.md` + `spec.workspace.{as-built,target}.md` |

The wiki directory persists as human-readable documentation in all modes.

---

## Triage Workflow (Replacement Mode Only)

After the analyze skill produces both specs in replacement mode, the triage
workflow refines the target spec based on product owner decisions.

### Position in the pipeline

```
analyze --mode replacement
  → spec.as-built.md + spec.target.md (all features assumed 'keep')
  → /wiki:triage
  → migration-triage.yml (keep/change/drop per feature)
  → spec.target.md updated (drops removed, changes applied as SpecDelta)
  → scaffold (consumes triaged spec + wiki for task generation)
```

Triage is optional but recommended. Without it, the target spec assumes every
feature is kept — which is the safe default but may generate unnecessary work.

### How triage feeds downstream

| Disposition | Target spec effect | Scaffold effect |
|---|---|---|
| `keep` | Requirement preserved | Parity contract tests generated |
| `change` | Requirement updated with SpecDelta marker | New GWT scenarios, modified acceptance criteria |
| `drop` | Requirement removed, `[DROPPED]` entry added | Absence tests (404s, disabled features) |

### Tier-aligned triage

Triage supports `--tier <N>` to limit decisions to the current build tier.
This maps to Arnold's existing tiered task management:
- Tier 1 features are triaged first, tasks generated, build starts
- Tier 2 triage happens in parallel with tier 1 execution
- Un-triaged features block task generation for that feature only

### Integration with PO Update Loop

Triage decisions can trigger the PO Update Loop:
- A `change` decision may raise new open questions
- A `drop` decision with HIGH impact may need PO confirmation
- Both feed back through `review/product-owner-questions.md`

After the PO loop resolves triage-related questions, `spec-sync` updates the
target spec accordingly.

---

## PO Update Loop

After initial analysis, product owner answers cascade through the wiki to the
spec.

### Flow

```
PO answers question in review/product-owner-questions.md
  |
  v
process_product_owner_answers.py (generates trigger briefs)
  |
  v
answer-integrator skill (reconciles into wiki pages + decision-log)
  |
  v
triggered specialists (UX, gap, research re-review affected areas)
  |
  v
build_wiki_index.py (reindex)
  |
  v
spec-sync skill (cascades wiki changes to spec)
```

### Spec-sync behavior

The spec-sync skill reads which wiki pages were modified and updates the
corresponding spec sections. See the page-to-section mapping in
`references/spec-format.md`.

#### Patch vs. re-formalize

| Change scope | Action |
|---|---|
| Single wiki page updated, affects one spec section | Patch: update that spec section in place |
| PO decision affects 2+ spec sections | Targeted re-formalize: regenerate affected sections from their wiki sources |
| Cross-cutting decision (new user role, domain reclassification) | Full re-formalize: regenerate entire spec from wiki |
| Risk resolved or question answered | Patch: update Review section only |

#### Epistemic marker updates

When a PO answers a question:
- `[GAP]` may become `[CONFIRMED]` if the answer provides clarity
- `[CONFLICT]` may resolve to `[CONFIRMED]` with the chosen resolution
- New `[GAP]` entries may appear if the answer reveals new unknowns
- OQ entries move from "open" to "resolved" in Section 11

#### Decision provenance

Every spec change from the PO loop traces back through:
```
Spec change ← wiki page update ← decision-log entry ← PO answer ← open question ← wiki gap
```

This chain is preserved in the Source Provenance table (Section 11).

---

## Batch vs. Interactive Mode

### Batch (default)

The analyze skill runs all phases autonomously. The flow depends on mode:

**Brownfield:**
1. Detect mode → `brownfield`
2. `arnold context` → parse JSON
3. Wiki build → specialist passes → index
4. Formalize as-built spec

**Greenfield:**
1. Detect mode → `greenfield`
2. Ingest artifacts → build source manifest
3. Wiki build from artifacts → specialist passes → index
4. Formalize target spec

**Replacement:**
1. Accept mode (explicit `--mode` or `--target-stack`)
2. `arnold context` → parse JSON
3. Wiki build → specialist passes → index
4. Formalize as-built spec → derive target spec

All modes end with a summary report.

### Interactive

When the user wants control, pause at natural breakpoints:

| Breakpoint | When to pause | What to ask |
|---|---|---|
| After mode detection | Mode is ambiguous or overrideable | "Detected mode: {mode}. Override?" |
| After context | Stack detection confidence < 50% (brownfield/replacement) | "Detected {lang}/{fw} at {confidence}%. Override?" |
| After artifact intake | Greenfield, fewer than 3 artifacts | "Only {N} artifacts found. Enough to proceed?" |
| After wiki baseline | Always if `--interactive` | "Wiki baseline complete. Review before specialist passes?" |
| After specialists | Open questions or conflicts found | "Found {N} open questions and {M} conflicts. Review before spec?" |
| After spec | Replacement mode | "As-built and target specs generated. Review?" |
| After spec | Other modes | "Spec generated. Review before writing?" |

---

## Error Handling

### Common errors (all modes)

| Error | Behavior |
|---|---|
| Workspace root directory missing | Fail with clear error message |
| Wiki build finds no meaningful content | Produce minimal wiki with gaps, warn in spec |
| Spec formalization has low confidence | Flag in JSON metadata, add prominent warning in Overview |

### Brownfield / Replacement errors

| Error | Behavior |
|---|---|
| `arnold context` not installed | Warn, proceed without context (direct file reading) |
| `arnold context` fails on a root | Warn for that root, proceed with remaining roots |
| Directory is empty but mode is brownfield | Fail: "No code found. Did you mean --mode greenfield?" |

### Greenfield errors

| Error | Behavior |
|---|---|
| No artifacts provided | Fail: "Greenfield mode requires product artifacts (docs, mockups, or URLs)" |
| All visual artifacts fail vision processing | Warn, proceed with text-only artifacts |
| URL fetch fails | Warn for that URL, proceed with remaining artifacts |
| Directory has code but mode is greenfield | Warn: "Directory contains code. Ignoring it in greenfield mode." |

### Replacement errors

| Error | Behavior |
|---|---|
| `--target-stack` omitted | Prompt: "What stack should the replacement target?" (interactive) or fail (batch) |
| Target stack same as detected stack | Warn: "Target stack matches existing. Did you mean --mode brownfield?" |
