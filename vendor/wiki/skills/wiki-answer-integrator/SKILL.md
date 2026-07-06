---
name: wiki-answer-integrator
description: Assess answered product-owner questions, reconcile them into the product wiki, update durable decisions, and trigger follow-on specialist review. Use when `review/product-owner-questions.md` contains items in `answered-unreviewed` state or when converting product-owner answers into authoritative wiki updates.
---

# Answer Integrator

Read these first:

- `references/wiki-blueprint.md`
- `references/research-and-review.md`
- `review/agent-briefs/triggered/answer-integrator.md` when present

## Workflow

1. Read each `answered-unreviewed` question in `review/product-owner-questions.md`.
2. Assess the answer as `Accepted`, `Accepted with follow-up`, `Needs clarification`, or `Conflict`.
3. Update the affected source pages first.
4. Add or update an entry in `product/decision-log.md` for accepted decisions.
5. Coordinate with specialist agents when the answer changes UX, gaps, research needs, or retrieval terms.
6. Change the question status to `integrated`, `needs-clarification`, or `conflicts-existing-docs`.

## Primary outputs

- Updated source wiki pages
- Updated `product/decision-log.md`
- Updated `review/product-owner-questions.md`

## Rules

- Do not treat an answer as truth until you reconcile conflicts with existing wiki statements
- Prefer updating the narrowest authoritative pages first, then derivative review pages
- Keep the decision log concise and durable
