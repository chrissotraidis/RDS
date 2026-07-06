---
name: wiki-questions
description: Audit the wiki for unresolved product ambiguity and funnel it into the canonical product-owner queue. Sweeps per-page Open questions sections, promotes free-form bullets to POQ-NNN entries in review/product-owner-questions.md, and replaces per-page content with pointer lines. Use after gap-analysis, UX review, amend, or any pass that touches wiki pages.
---

# Product Owner Question Curator / Auditor

Read these references first:

- `references/research-and-review.md`
- `references/wiki-blueprint.md` — especially the *Single-funnel rule for open questions*

## Role

Under the single-funnel rule, `review/product-owner-questions.md` is the only canonical queue for PO decisions. Per-page `## Open questions` sections are page-local pointers into that queue. Every skill that edits wiki pages is responsible for filing POQs as it goes.

This skill is the **auditor**. Its job is to:

1. Sweep every wiki page for free-form bullets under `## Open questions` that did not get promoted to the queue.
2. Convert them to proper `POQ-NNN` entries in `review/product-owner-questions.md`.
3. Replace the per-page bullet with a pointer (`- See POQ-NNN — <hook> (status: open)`).
4. Curate the queue: deduplicate near-identical POQs, sharpen vague ones, set priorities, assign trigger agents.

Run this skill after any pass that touches wiki pages and at the start of each maintenance cycle.

## Focus on questions that unblock decisions

- Permissions and role boundaries
- Workflow branching and failure handling
- Product scope and non-goals
- Metrics, approvals, and ownership

## Workflow

### 1. Sweep per-page Open questions

For every wiki page with an `## Open questions` section, read its bullets. Classify each bullet:

| Bullet shape | Action |
|---|---|
| `- See POQ-NNN — <hook> (status: <status>)` | Already compliant — verify the POQ exists and the status matches; fix drift if any. |
| Free-form question without a POQ id | Promote: create a new POQ, replace the bullet with the pointer. |
| Empty / `TODO` placeholder | Remove. |

### 2. Promote free-form bullets to POQs

For each free-form bullet, create a new POQ-NNN entry in `review/product-owner-questions.md` using the format from `references/wiki-blueprint.md`:

```markdown
### POQ-NNN: <decision title>

- Status: open
- Priority: <low | medium | high>
- Source pages: <list of pages that surfaced the question>
- Trigger agents: <relevant specialists>
- Decision needed: <one-sentence description of the decision>
- Why this matters: <what is blocked by the missing answer>
- Affected areas: <scope tags>

#### Product owner answer

- Decision:
- Rationale:
- Constraints:
- Examples:
- Confidence:
- Answered by:
- Answered on:

#### Integration notes

- Assessment:
- Follow-up:
- Status owner:
```

Then replace the original per-page bullet with:

```markdown
- See POQ-NNN — <short hook> (status: open)
```

If the same free-form question appears on multiple pages, create **one** POQ with all pages listed under `Source pages`, and add the pointer line to each.

### 3. Curate the queue

After the sweep:

- **Deduplicate** — merge near-identical POQs (same decision, different wording) into a single entry. Update all pointer lines to reference the surviving id.
- **Sharpen** — rewrite vague POQs to target exactly one decision. Break compound ones into multiple POQs.
- **Prioritize** — set `Priority` based on delivery risk. `high` = blocks implementation or design; `medium` = blocks completeness; `low` = informational.
- **Assign trigger agents** — which specialists should act on the answer. Typical routing in `references/agent-topology.md`.
- **Re-run the sweep** if any POQ was renumbered so pointer lines stay in sync.

## Rules

- One decision per POQ
- Explain why the answer matters
- Prioritize by delivery risk
- Every per-page `## Open questions` bullet must end as a pointer line, not free text
- A POQ's `Source pages` field is the reverse index: if a page references POQ-NNN, that page must appear in the POQ's `Source pages`

## Primary outputs

- Updated `review/product-owner-questions.md` with newly promoted POQs
- Updated wiki pages with pointer lines replacing free-form bullets
- A summary report of what was swept, promoted, merged, and reprioritized:

```
Question audit complete:
  Pages scanned: 18
  Free-form bullets found: 7
  Promoted to POQs: 5 (POQ-019..023)
  Merged as duplicates: 2 (into POQ-011, POQ-017)
  Queue rebalanced: 3 reprioritized, 1 resharpened
  Pointer lines updated: 14
```
