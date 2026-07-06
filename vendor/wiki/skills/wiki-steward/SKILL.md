---
name: wiki-steward
description: Turn product artifacts into a structured product wiki that stays current. Supports both brownfield (code-based) and greenfield (artifact-based) wiki builds. Use when building or maintaining a product wiki, identifying gaps, performing research, suggesting UX improvements, preparing PO questions, or building a searchable index.
---

# Product Wiki Steward

## Overview

Create a product wiki that is useful to both humans and agents. Start from the provided inputs — either a codebase (brownfield) or product artifacts (greenfield) — separate confirmed facts from inferred details, record gaps explicitly, and keep the wiki easy to navigate and easy to index.

Use the scripts in this plugin to create the initial wiki scaffold and to rebuild the search index after meaningful wiki updates:

- `scripts/bootstrap_wiki.py`: create the wiki skeleton and intake summary from source artifacts
- `scripts/build_wiki_index.py`: build JSON and Markdown indexes for downstream agents

Two related skills cover incremental updates once the wiki exists — delegate to them rather than re-running the full build:

- `/wiki:wiki-amend` — fold new source artifacts (PDF, docx, xlsx, markdown, URLs) into the existing wiki. See `references/source-amendment.md`.
- `/wiki:wiki-answer-integrator` — reconcile product-owner answers into the wiki.

Load these references as needed:

- `references/wiki-blueprint.md`: canonical folder layout, document contract, and section expectations
- `references/greenfield-guidance.md`: epistemic markers, artifact intake, and completeness heuristic for greenfield mode
- `references/source-amendment.md`: claim extraction, change classification, and conflict policy for incremental amendments
- `references/agent-topology.md`: specialist agent roles, ownership, and parallelization pattern
- `references/research-and-review.md`: gap analysis, web research, UX review, and product-owner question workflow
- `references/indexing-contract.md`: index format and retrieval expectations for coding agents

## Workflow

### 1. Ingest the source inputs

Collect the product inputs first. The input type depends on the analysis mode:

**Brownfield / Replacement:** The analyze skill provides a context bundle
(JSON from `arnold context`) containing stack fingerprint, artifact map, and
file summary. Use the artifact map to read high-signal files first.

**Greenfield:** The user provides product artifacts directly — documents,
mockups, screenshots, spreadsheets, URLs. Process them in three tiers per
`references/greenfield-guidance.md`:
- **Text-native** (MD, TXT, JSON, YAML, CSV) — parse directly
- **Visual** (PNG, JPG, PDF) — extract via vision model
- **Reference URLs** — fetch then extract content

If the user has not chosen a destination folder yet, create a wiki workspace
first and keep source artifacts listed in the intake output.

Run `scripts/bootstrap_wiki.py` to create a first-pass wiki shell:

```bash
python3 scripts/bootstrap_wiki.py \
  --product-name "Sample Product" \
  --output-dir ./wiki \
  specs/prd.md docs/roadmap.md notes/interviews/
```

If the source set is incomplete, proceed anyway. The wiki should make unknowns obvious instead of blocking on missing detail.

### 2. Establish the wiki baseline

Use the generated structure from `references/wiki-blueprint.md`. Keep every page grounded in evidence:

- Record confirmed facts under `Confirmed`
- Record reasoned but unverified interpretations under `Inferred`
- Record missing information under `Open questions` or `Gaps`
- Record artifact provenance in `Sources`

**Greenfield note:** The meaning of these markers differs when there is no
code. See `references/greenfield-guidance.md` for the adapted definitions:
- `Confirmed` = PO-approved or corroborated by 2+ independent artifacts
- `Inferred` = single artifact source
- `Gap` = logical dependency with no artifact coverage

Prefer concise, high-signal pages over long narrative dumps. A wiki should optimize for lookup speed.

### 3. Expand the wiki with specialist passes

After the baseline exists, deepen it with targeted passes:

- Product synthesis: explain goals, users, flows, roles, states, dependencies, and operating constraints
- Gap analysis: identify contradictions, missing decisions, unowned flows, and undocumented edge cases
- UX review: note friction, unclear terminology, missing affordances, and accessibility risks
- Research: use web browsing when the missing details are current, market-facing, regulatory, competitive, or otherwise unstable
- Question curation: write product-owner questions that are specific, answerable, and decision-oriented

When the user explicitly asks for a team of agents or parallel work, split the job using `references/agent-topology.md`. Give each agent a narrow output surface and a disjoint ownership area where possible.

### 3.5. Reconcile product-owner answers

Treat product-owner answers as structured decision inputs, not loose commentary. Keep the canonical queue in `review/product-owner-questions.md`, move answered items to `answered-unreviewed`, and reconcile them before treating them as wiki truth.

The reconciliation pass should:

- assess whether the answer is actionable or still ambiguous
- update the affected source pages
- record accepted decisions in `product/decision-log.md`
- trigger follow-on specialist review when the answer changes UX, gaps, research needs, or retrieval terms

### 4. Keep research disciplined

Treat the wiki as a knowledge base, not a speculation log.

- Prefer primary sources for technical and product claims
- Include links for facts discovered through web research
- Mark inferences clearly
- Do not fill important unknowns with confident prose
- Preserve unresolved questions even when you have a likely answer

Use browsing for current information whenever there is any realistic chance the fact has changed.

### 5. Rebuild the retrieval index

Any time the wiki structure or content changes substantially, rebuild the index:

```bash
python3 scripts/build_wiki_index.py ./wiki
```

This produces:

- `index/wiki-index.json`: machine-oriented retrieval index with completeness scores
- `index/wiki-index.md`: human-readable lookup table

The index is part of the product. Coding agents should be able to answer "where is X documented?" in one pass.

### 6. Check completeness (greenfield)

When building a greenfield wiki that will feed into spec formalization, check
the completeness heuristic from `references/greenfield-guidance.md` before
declaring the wiki ready:

1. No page scores 0 (empty)
2. Product section pages (`product/*.md`) average 2+ (partial or better)
3. No HIGH-priority open questions remain unanswered
4. Core pages score 2+ (`overview`, `features`, `journeys`, `data-and-entities`)

Report the completeness status:
```
Wiki completeness: 85% (spec-ready)
  All pages have content
  Product section average: 2.4
  0 HIGH-priority questions remaining
```

If not spec-ready, list what's blocking and suggest next actions (provide
more artifacts, answer PO questions, or use `--force-spec` to proceed anyway).

## Output Standard

Aim for a wiki that answers these questions quickly:

- What problem does the product solve?
- Who uses it and what are their main journeys?
- What are the important entities, flows, permissions, integrations, and edge cases?
- What is confirmed versus inferred?
- What gaps still block confident implementation or design work?
- What UX improvements appear most valuable?
- What should the product owner answer next?
- Where should another agent look for each topic?

If the wiki does not make those answers easy to retrieve, improve the structure before adding more volume.
