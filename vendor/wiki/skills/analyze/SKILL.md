---
name: analyze
description: Analyze a codebase or product idea to produce a product wiki and specification. Supports greenfield (from artifacts), brownfield (from code), and replacement (old code → new stack) modes. Builds structured understanding, then formalizes it into a spec consumable by arnold run.
---

# Analyze

## Overview

Analyze a product and produce two artifacts:
1. A **product wiki** — human/agent-readable documentation of what the product does
2. A **spec** — machine-readable blueprint for `arnold run` to build the product

This skill operates in three modes:
- **Greenfield** — no existing code; wiki is built from product artifacts (docs, mockups, URLs)
- **Brownfield** — existing codebase; wiki is built from code analysis
- **Replacement** — existing codebase to be rebuilt on a new stack; produces both an as-built spec (what exists) and a target spec (what to build)

The skill orchestrates three phases: context gathering, wiki build, and spec
formalization. It runs in batch mode by default (no user interaction).

Load these references:

- `references/analyze-workflow.md`: end-to-end workflow, phase details, error handling
- `references/spec-format.md`: spec output format, epistemic markers, section structure
- `references/wiki-blueprint.md`: wiki structure, page contracts, section expectations
- `references/greenfield-guidance.md`: epistemic markers, artifact intake, completeness heuristic (greenfield mode)
- `references/agent-topology.md`: specialist roles and parallelization pattern
- `references/research-and-review.md`: gap analysis, research, UX review workflows
- `references/indexing-contract.md`: index format, completeness scoring, spec-readiness

## Inputs

The user provides one of:
- A **directory path** to a codebase or empty project directory
- A **workspace.yml** manifest pointing to multiple roots
- Product artifacts (docs, mockups, URLs) — greenfield mode only

Required:
- `--mode greenfield|brownfield|replacement` — analysis mode (auto-detected if omitted)

Optional:
- `--hint <framework>` — stack override (e.g., `rails`, `react`, `react_native`)
- `--target-stack <framework>` — target tech stack for replacement mode (e.g., `rails`, `nextjs`)
- `--wiki-only` — stop after Phase 2 (produce wiki but skip spec)
- `--interactive` — pause at natural breakpoints for user review

### Mode Auto-Detection

When `--mode` is omitted, the skill auto-detects:

| Condition | Detected mode |
|---|---|
| Directory is empty or does not exist | `greenfield` |
| Directory contains code (source files, package manifests) | `brownfield` |
| `--target-stack` is provided | `replacement` |

Replacement mode **cannot** be auto-detected from directory contents alone — it
requires explicit intent via `--mode replacement` or `--target-stack`. A codebase
that should be rebuilt looks identical to one that should be documented.

If auto-detection picks the wrong mode, the user can always override with `--mode`.

## Workflow

### Phase 1: Context Gathering

This phase differs by mode:

#### Brownfield / Replacement

Run `arnold context` to get the deterministic context bundle. This CLI command
makes zero LLM calls — it detects the tech stack and discovers key artifact
file locations through pattern matching.

```bash
# Single root
arnold context <path> [--hint <framework>]

# Workspace
arnold context --workspace <workspace.yml>
```

Parse the JSON output. The context provides:
- **Stack fingerprint**: language, framework, confidence score
- **Artifact map**: paths to schema, routes, components, dependencies, entry point, config
- **File summary**: extension counts, total file count

If `arnold context` is not available or fails, proceed without it. Fall back to
reading common files directly (package.json, Gemfile, requirements.txt, etc.)
and infer the stack from what you find.

#### Greenfield

Skip `arnold context` entirely — there is no code to analyze.

Instead, gather product artifacts provided by the user:
- Text-native files (MD, TXT, JSON, YAML, CSV) — parse directly
- Visual files (PNG, JPG, PDF with layouts) — route through vision model
- Reference URLs (competitor sites, docs, Figma) — fetch then extract

Build a `source-manifest.md` in the wiki's `intake/` directory listing each
artifact with its `processing_method` (text_parse, vision, url_fetch).

### Phase 2: Wiki Build

Build the product wiki using the steward workflow from
`references/wiki-blueprint.md`, seeded with the context bundle.

#### Step 2a: Bootstrap

1. Determine the wiki output directory:
   - If the user specified one, use it
   - Otherwise, create `./wiki/` adjacent to the codebase (or workspace.yml)

2. Run the bootstrap script:
   ```bash
   python3 scripts/bootstrap_wiki.py \
     --product-name "<project name from context or directory>" \
     --output-dir <wiki-dir> \
     <root paths...>
   ```

3. Read the context bundle's artifact list. For each discovered artifact with
   content (schema, routes, components, etc.), these are the highest-signal
   files — read them first and use them to populate the wiki baseline.

#### Step 2b: Fill baseline pages

##### Brownfield / Replacement

Use the context-to-wiki mapping from `references/analyze-workflow.md`:
- Schema artifacts inform `engineering/data-and-entities.md`
- Route artifacts inform `engineering/interfaces-and-integrations.md` and
  `design/information-architecture.md`
- Component artifacts inform `product/features-and-capabilities.md`
- Entry point informs `product/overview.md`
- CI config informs `operations/release-and-support.md`

Read additional files as needed. The context gives you the map; Claude's file
reading gives you the depth. For each wiki page, follow the page contract:
Purpose, Confirmed, Inferred, Gaps, Open questions, Sources.

**Single-funnel rule**: when you identify a question the PO must answer while
filling in any wiki page, file a `POQ-NNN` entry in
`review/product-owner-questions.md` first, then put a pointer line on the
page (`- See POQ-NNN — <hook> (status: open)`). Do not write free-form
bullets under `## Open questions`. See `references/wiki-blueprint.md` for
the rule and POQ format.

##### Greenfield

Fill wiki pages from the processed product artifacts instead of code. Without
code as a source of truth, epistemic markers have different semantics:

| Marker | Greenfield meaning |
|---|---|
| `Confirmed` | PO-approved or corroborated by 2+ independent artifacts |
| `Inferred` | Derived from a single artifact source |
| `Gap` | Logical dependency with no artifact coverage |

Competitive analysis and reference URLs produce `Inferred` evidence. Items
only become `Confirmed` through PO sign-off or multi-artifact corroboration.

The single-funnel rule applies in greenfield mode too: every question you
surface while filling a wiki page becomes a POQ in
`review/product-owner-questions.md` first, with a pointer line on the page.

#### Step 2c: Specialist passes

After the baseline exists, run specialist passes per
`references/agent-topology.md`:
- **Gap analysis**: contradictions, missing requirements, undocumented edge cases
- **UX review**: friction, terminology, accessibility issues
- **Question curation / audit**: sweep per-page `## Open questions` sections,
  promote any free-form bullets to `POQ-NNN` entries in
  `review/product-owner-questions.md`, and leave pointer lines behind. Every
  pass above must also follow the single-funnel rule as it runs; the curator
  is the final auditor.

Skip web research in batch mode unless the user explicitly requested it.

#### Step 2d: Multi-root synthesis (workspace only)

For workspaces with multiple roots:
1. Build each root's wiki content within the shared wiki structure
2. Do a cross-root synthesis pass:
   - Identify shared entities across roots
   - Map cross-root data flows (frontend → backend API calls)
   - Surface naming inconsistencies
   - Record contradictions in `intake/synthesis-notes.md`

#### Step 2e: Index

```bash
python3 scripts/build_wiki_index.py <wiki-dir>
```

#### Stop here if `--wiki-only`

Report summary and exit: files created, pages with gaps, open question count.

### Phase 3: Spec Formalization

Read the completed wiki and produce the as-built spec per
`references/spec-format.md`.

#### Process

1. Read `wiki/index.md` and `wiki/product/overview.md` to determine domain
   classification and user roles for the spec Overview.

2. For each spec section (1-11), read the mapped wiki pages (see mapping table
   in `references/spec-format.md`).

3. Transform wiki content:
   - Wiki "Confirmed" sections → `[CONFIRMED]` requirements with GWT scenarios
   - Wiki "Inferred" sections → `[INFERRED]` requirements with evidence notes
   - Wiki "Gaps" → `[GAP]` entries
   - Wiki "Open questions" → OQ entries in Section 11
   - Decisions from `product/decision-log.md` → strengthen related requirements

4. For each feature, write at least one Given/When/Then scenario. Use concrete
   details from the wiki (specific field names, limits, role names).

5. Assign requirement IDs: `[REQ-{DOMAIN}-{NNN}]` where DOMAIN comes from the
   feature area.

6. Build the JSON metadata block from wiki content — entity names, feature
   list, user roles, confidence counts.

7. Build the Source Provenance table mapping features to wiki pages.

#### Mode-specific spec behavior

##### Greenfield

The spec is a **target spec** — it describes what to build, not what exists.
All requirements come from artifacts and PO decisions. The spec's `spec_type`
metadata field is `target`.

##### Brownfield

The spec is an **as-built spec** — it describes the existing system. The
spec's `spec_type` metadata field is `as_built`.

##### Replacement

Produce **two specs**:
1. `spec.as-built.md` — documents the existing system (from code analysis)
2. `spec.target.md` — describes what to build on the new stack

The as-built spec uses `spec_type: as_built`. The target spec uses
`spec_type: target` and includes the `--target-stack` value in its metadata.

The target spec starts as a copy of the as-built spec with:
- Tech stack section updated to the target stack
- Implementation-specific details generalized (e.g., specific ORM column
  types become logical types)
- All requirements preserved unless the user explicitly marks changes via
  the triage workflow (Phase B, future)

#### Multi-root spec generation

For workspaces:
1. Produce `spec.<root-name>.md` for each root
2. Produce `spec.workspace.md` with unified cross-root view

In replacement mode, each root gets both as-built and target variants.

#### Output

Write spec file(s) adjacent to the wiki directory. Report:
- Total requirements (confirmed / inferred / gap)
- Open questions count
- Risk count
- Confidence assessment
- Mode used and spec type(s) produced

## Batch Behavior

By default, run all three phases without user interaction:

### Brownfield (default)
1. Auto-detect mode (or use `--mode`)
2. Call `arnold context` → parse JSON
3. Bootstrap wiki → fill baseline → specialist passes → index
4. Formalize as-built spec → write output

### Greenfield
1. Auto-detect mode (empty directory)
2. Ingest product artifacts → build source manifest
3. Bootstrap wiki → fill baseline from artifacts → specialist passes → index
4. Formalize target spec → write output

### Replacement
1. Use `--mode replacement` or `--target-stack` flag
2. Call `arnold context` on existing code → parse JSON
3. Bootstrap wiki → fill baseline → specialist passes → index
4. Formalize as-built spec → derive target spec → write both

### Summary output
```
Mode: <greenfield|brownfield|replacement>
Wiki: <wiki-dir>/ (<N> pages, <M> with gaps)
Spec: <spec-path> (<X> confirmed, <Y> inferred, <Z> gaps, <Q> open questions)
```

## Interactive Behavior

When `--interactive` is requested, pause at natural breakpoints:

| Breakpoint | Condition | Prompt |
|---|---|---|
| After mode detection | Mode is ambiguous | "Detected mode: {mode}. Override?" |
| After Phase 1 | Stack confidence < 50% (brownfield/replacement) | "Detected {lang}/{fw} at {confidence}%. Override?" |
| After Phase 1 | Greenfield, artifact count < 3 | "Only {N} artifacts found. Enough to proceed?" |
| After Phase 2 | Always | "Wiki baseline complete. Review before spec formalization?" |
| After Phase 3 | Replacement mode | "As-built and target specs generated. Review before writing?" |
| After Phase 3 | Other modes | "Spec generated with {N} open questions. Review?" |
