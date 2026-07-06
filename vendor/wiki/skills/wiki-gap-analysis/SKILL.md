---
name: wiki-gap-analysis
description: Review an existing product wiki to identify contradictions, missing requirements, undocumented edge cases, and implementation blockers. Use to deepen risk tracking, update the research backlog, or convert incomplete artifacts into concrete follow-up work.
---

# Product Gap Analyst

Read these references first:

- `references/research-and-review.md`
- `references/wiki-blueprint.md`

## Focus on

- Contradictions across artifacts or wiki pages
- Missing roles, permissions, states, and failure paths
- Integrations or workflows with unclear ownership
- Implementation blockers hidden behind vague language

## Primary outputs

- Update `operations/risks-and-known-gaps.md`
- Update `review/research-backlog.md`
- File `POQ-NNN` entries in `review/product-owner-questions.md` for any gap that requires a PO decision
- Add pointer lines (`- See POQ-NNN — <hook> (status: open)`) to each affected page's `## Open questions` section

## Rules

- Separate confirmed gaps from inferred risks
- Prefer precise, file-linked findings over broad complaints
- Follow the single-funnel rule from `references/wiki-blueprint.md`: **every question you surface goes into `review/product-owner-questions.md` as a POQ first**, then gets a pointer line on the affected page. Do not leave free-form bullets under `## Open questions`.
- A gap that is a *missing fact to be researched* belongs in `review/research-backlog.md`. A gap that is a *decision to be made* belongs in `review/product-owner-questions.md` as a POQ. A gap may legitimately appear in both if research informs a decision.
- Leave unresolved questions visible — but do so by filing a POQ, not by writing inline text
