---
name: wiki-maintenance
description: Run the full maintenance cycle on a product wiki. Refreshes the retrieval index, generates specialist agent briefs, and processes answered product-owner questions into trigger briefs.
---

# Wiki Maintenance Cycle

Run the routine maintenance pipeline: refresh the index, generate specialist briefs, and process answered product-owner questions.

## Usage

```bash
python3 scripts/run_hook.py maintenance-cycle <wiki-root>
```

Or run each step individually:

```bash
# Step 1: Rebuild the retrieval index
python3 scripts/build_wiki_index.py <wiki-root>

# Step 2: Generate specialist briefs
python3 scripts/generate_agent_briefs.py <wiki-root>

# Step 3: Process answered product-owner questions
python3 scripts/process_product_owner_answers.py <wiki-root>
```

## What it produces

### Retrieval index

- `index/wiki-index.json`: structured retrieval data
- `index/wiki-index.md`: human-readable directory

### Specialist briefs (in `review/agent-briefs/`)

- `product-gap-analyst.md` -- files with TODOs, missing sections, and gap headings
- `product-web-researcher.md` -- engineering, operations, and integration files
- `wiki-ux-reviewer.md` -- design files and journey pages
- `product-owner-question-curator.md` -- files with open questions and gaps
- `answer-integrator.md` -- questions and decision log for answer reconciliation
- `wiki-index-maintainer.md` -- all wiki files for indexing review

### Answer trigger briefs (in `review/agent-briefs/triggered/`)

- `answer-integrator.md` -- answered questions needing reconciliation
- `wiki-ux-reviewer.md` -- when answers affect UX/navigation/design
- `product-gap-analyst.md` -- when answers affect gaps/engineering
- `product-web-researcher.md` -- when answers reference external facts
- `wiki-index-maintainer.md` -- always triggered to rebuild index
- `answer-trigger-manifest.json` -- machine-readable manifest of all triggered questions

Each brief includes: purpose, recommended skill, focus files (up to 8), and notes.

## When to run

- After substantial wiki content or structural changes
- After a product owner answers questions in `review/product-owner-questions.md`
- Before starting a specialist review pass
- As a routine check to keep the wiki current

## Incremental updates from new artifacts

The maintenance cycle handles ongoing wiki upkeep (index, briefs, answer reconciliation), but it does **not** ingest new source material. When a revised PRD, decision memo, data dictionary, or other new artifact arrives, run `/wiki:wiki-amend` first. That skill:

- reads artifacts staged in `intake/inbox/`
- diffs extracted claims against the existing wiki
- applies non-conflicting changes with provenance
- files conflicts as product-owner questions
- archives processed artifacts to `intake/sources/<date>/`
- chains into `spec-sync` and a reindex

After `wiki-amend` completes, the regular maintenance cycle picks up any newly-filed product-owner questions on the next run.
