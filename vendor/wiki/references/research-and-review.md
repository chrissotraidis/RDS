# Research And Review

Use this guide when building out missing detail after the baseline wiki exists.

## Gap analysis

Look for:

- conflicting descriptions of the same flow
- missing actors, permissions, and approval steps
- hidden state transitions
- undocumented failure handling
- vague success metrics
- integrations without ownership or data contracts
- UI flows with no entry point, exit condition, or fallback

Record product holes in:

- `operations/risks-and-known-gaps.md`
- `review/research-backlog.md`

## Web research

Use browsing when the answer could plausibly have changed or when the wiki needs sourced external context. Typical cases:

- current competitor positioning
- active standards, policies, or regulations
- vendor capabilities and pricing
- up-to-date platform constraints
- public product behavior of comparable tools

Rules:

- prefer primary sources
- capture links inline or in `Sources`
- state when a conclusion is inferred rather than directly confirmed
- do not over-research low-value curiosities

## UX review

Focus on problems that matter to usage and implementation:

- confusing labels or duplicated concepts
- hidden steps or poor system feedback
- overloaded screens or role-dependent complexity
- missing accessibility expectations
- brittle flows that will create support load

Write recommendations in `review/ux-improvements.md` with:

- issue
- impact
- proposed change
- rationale
- likely dependencies

## Product-owner questions

`review/product-owner-questions.md` is the single canonical queue for PO decisions. Per-page `## Open questions` sections are pointer lists, not authoring surfaces. See the *Single-funnel rule for open questions* in `references/wiki-blueprint.md` for the full policy.

When you identify a new question during any pass (gap analysis, UX review, research, amendment, or ad-hoc editing):

1. File a `POQ-NNN` entry in `review/product-owner-questions.md` first
2. Add a pointer line to each affected page's `## Open questions` section in the form `- See POQ-NNN — <short hook> (status: open)`
3. List every affected page under the POQ's `Source pages` field — this is the reverse index

Questions should be:

- decision-oriented
- scoped to one ambiguity each
- prioritized by delivery risk
- answerable without reading the entire wiki

Prefer formulations like:

- “Should workspace admins be able to delete shared automations created by others?”
- “What is the expected fallback when a third-party sync partially succeeds?”

Avoid formulations like:

- “Tell us more about permissions”
- “What should the UX be?”

## Product-owner answer reconciliation

When a product owner answers a queued question:

1. mark the question `answered-unreviewed`
2. capture the answer in the structured answer block
3. run the answer-processing hook to generate integration briefs
4. have an answer-integrator assess the answer quality and update the affected pages
5. update `product/decision-log.md` for accepted decisions
6. change the question state to `integrated`, `needs-clarification`, or `conflicts-existing-docs`

Use this assessment rubric:

- `Accepted`: answer is specific, internally consistent, and actionable
- `Accepted with follow-up`: the main decision is clear but secondary implications remain
- `Needs clarification`: the answer is too vague to change product behavior confidently
- `Conflict`: the answer contradicts current wiki truth and requires explicit resolution
