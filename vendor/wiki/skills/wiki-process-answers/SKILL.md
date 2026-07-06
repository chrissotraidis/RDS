---
name: wiki-process-answers
description: Convert answered product-owner questions into integration and specialist trigger briefs. Run this after a product owner fills in answers in review/product-owner-questions.md.
---

# Process Product Owner Answers

Parse answered questions from `review/product-owner-questions.md` and generate targeted trigger briefs for specialist agents.

## Usage

```bash
python3 scripts/process_product_owner_answers.py <wiki-root>
```

Or as part of the full maintenance cycle:

```bash
python3 scripts/run_hook.py maintenance-cycle <wiki-root>
```

## What it produces

- `review/agent-briefs/answer-trigger-manifest.json` -- JSON manifest of answered questions with inferred trigger agents
- `review/agent-briefs/triggered/answer-integrator.md` -- brief for answer reconciliation
- `review/agent-briefs/triggered/wiki-ux-reviewer.md` -- brief when answers affect UX
- `review/agent-briefs/triggered/product-gap-analyst.md` -- brief when answers affect gaps/engineering
- `review/agent-briefs/triggered/product-web-researcher.md` -- brief when answers reference external facts
- `review/agent-briefs/triggered/wiki-index-maintainer.md` -- always triggered to rebuild index

## Workflow

1. Product owner answers a question in `review/product-owner-questions.md` and sets status to `answered-unreviewed`
2. Run this script (or `/wiki:wiki-maintenance`)
3. The script writes the trigger manifest and targeted briefs
4. Use `/wiki:wiki-answer-integrator` to reconcile answers into the wiki
5. Triggered specialists then act on their generated briefs
