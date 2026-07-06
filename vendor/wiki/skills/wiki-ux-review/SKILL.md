---
name: wiki-ux-review
description: Review a product wiki for UX risks, navigation issues, terminology problems, missing affordances, and accessibility concerns. Derive concrete UX improvements from specs, flows, or existing wiki pages.
---

# Wiki UX Reviewer

Read these references first:

- `references/research-and-review.md`
- `references/wiki-blueprint.md`

## Focus on

- Task flow friction and dead ends
- Unclear terminology and overloaded concepts
- Information architecture and discoverability issues
- Missing accessibility expectations

## Primary outputs

- Update `design/ux-observations.md`
- Update `review/ux-improvements.md`
- File `POQ-NNN` entries in `review/product-owner-questions.md` for any UX decision that the PO owns (terminology choices, role-gated affordances, navigation trade-offs, accessibility scope)
- Add pointer lines (`- See POQ-NNN — <hook> (status: open)`) to each affected page's `## Open questions` section

## Rules

- Write concrete improvements with rationale and likely dependencies
- Prefer user-impact language over visual taste language
- Connect each recommendation to a documented flow or page
- Follow the single-funnel rule from `references/wiki-blueprint.md`: **every PO-owned UX decision goes into `review/product-owner-questions.md` as a POQ first**, then gets a pointer line on the affected page. Do not leave free-form bullets under `## Open questions`.
- Distinguish *recommendations* (which go to `review/ux-improvements.md` for the team to execute) from *decisions* (which go to POQs for the PO to make). A single finding may produce both.
