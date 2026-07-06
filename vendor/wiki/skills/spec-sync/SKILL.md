---
name: spec-sync
description: Cascade wiki changes to the as-built spec. Use after product-owner answers are integrated, after specialist reviews update wiki pages, or whenever the wiki has changed and the spec needs to catch up.
---

# Spec Sync

## Overview

Update the as-built specification to reflect changes in the product wiki.
This skill performs targeted spec updates — it patches affected sections rather
than regenerating the entire spec.

Load these references:

- `references/spec-format.md`: spec output format, page-to-section mapping, epistemic markers
- `references/analyze-workflow.md`: PO update loop, patch vs. re-formalize rules
- `references/wiki-blueprint.md`: wiki page contracts

## When to Use

- After the answer-integrator reconciles PO answers into the wiki
- After a specialist pass (gap analysis, UX review, research) updates wiki pages
- After manual wiki edits by the user
- As the final step of the maintenance cycle

## Inputs

- Path to the wiki directory
- Path to the existing spec file(s)
- Optionally: a list of wiki pages that changed (if known)

## Workflow

### Step 1: Identify what changed

Determine which wiki pages have been modified since the last spec sync.

If the caller provides a list of changed pages, use it directly.

Otherwise, compare wiki page timestamps against the spec file timestamp, or
read `product/decision-log.md` for recent entries not yet reflected in the spec.

### Step 2: Map changes to spec sections

Use the page-to-section mapping from `references/spec-format.md`:

| Wiki Page | Spec Section |
|-----------|-------------|
| `product/overview.md` | 1. Overview |
| `product/features-and-capabilities.md` | 2. Features |
| `product/users-and-personas.md` | 1. Overview, 2. Features |
| `engineering/data-and-entities.md` | 3. Entities & Data Model |
| `product/journeys-and-flows.md` | 4. User Journeys |
| `design/information-architecture.md` | 5. Views & Interfaces |
| `engineering/system-behavior.md` | 6. System Behaviors, 7. Logic |
| `engineering/interfaces-and-integrations.md` | 8. External Connections |
| `product/roles-and-permissions.md` | 9. Security & Privacy |
| `operations/risks-and-known-gaps.md` | 11. Review (risks) |
| `review/product-owner-questions.md` | 11. Review (open questions) |
| `product/decision-log.md` | Cross-cutting |

### Step 3: Determine update scope

Apply these rules from `references/analyze-workflow.md`:

| Change scope | Action |
|---|---|
| Single wiki page, one spec section affected | **Patch**: update that section in place |
| PO decision affects 2-3 spec sections | **Targeted re-formalize**: regenerate affected sections from wiki sources |
| Cross-cutting decision (new user role, domain reclassification) | **Full re-formalize**: regenerate entire spec from wiki |
| Risk resolved or question answered | **Patch**: update Review section only |

### Step 4: Update the spec

For each affected spec section:

1. **Read the current spec section** — identify the existing requirements,
   their IDs, epistemic markers, and scenarios.

2. **Read the updated wiki page(s)** — identify what changed: new confirmed
   facts, resolved gaps, new gaps, changed relationships.

3. **Apply changes conservatively**:
   - New wiki "Confirmed" content → add or strengthen spec requirements
   - Resolved wiki "Gaps" → promote `[GAP]` to `[CONFIRMED]` or `[INFERRED]`
   - New wiki "Gaps" → add `[GAP]` entries
   - Changed wiki "Inferred" → update `[INFERRED]` evidence summaries
   - Contradictions resolved → remove `[CONFLICT]`, update to `[CONFIRMED]`

4. **Preserve requirement IDs** — do not renumber existing requirements.
   Add new requirements at the end of their functional area with the next
   available ID.

5. **Update GWT scenarios** — if a requirement's behavior changed, update its
   scenarios. If a new capability was confirmed, add scenarios.

### Step 5: Update the Review section

- Move answered questions from open to resolved
- Update the risk register if risks were resolved or new ones surfaced
- Add any new conflicts discovered during wiki updates
- Update the Source Provenance table if new wiki pages contributed

### Step 6: Update the JSON metadata block

Recount:
- `confirmed`: total `[CONFIRMED]` requirements
- `inferred`: total `[INFERRED]` requirements
- `gaps`: total `[GAP]` items
- `open_questions`: total unresolved OQ entries
- `conflicts`: total unresolved CONFLICT entries
- `risks`: total risk register entries

Update `features`, `data_models`, and `user_roles` if those changed.

### Step 7: Report

Print a summary of what changed:
```
Spec sync complete:
  Sections updated: 2, 9, 11
  Requirements added: 2 (REQ-AUTH-008, REQ-CARE-015)
  Requirements updated: 3 (REQ-AUTH-003, REQ-PAY-001, REQ-CARE-007)
  Gaps resolved: 1
  Open questions resolved: 2
  New open questions: 0
```

## Decision Provenance

Every spec change from the PO loop should be traceable:

```
Spec requirement ← wiki page update ← decision-log entry ← PO answer ← open question ← wiki gap
```

When updating a requirement based on a PO decision, note the decision in the
evidence summary:

```markdown
> [CONFIRMED] — Verified via PO decision DEC-007 (2026-04-04): HIPAA compliance
> is required. Originally identified as [GAP] in OQ-001.
```

## Edge Cases

- **Wiki page deleted**: Remove corresponding spec content, add a note in the
  Review section explaining what was removed and why.
- **Conflicting updates**: If two wiki pages now contradict each other, add a
  `[CONFLICT]` entry rather than choosing one.
- **Spec section has manual edits**: If the spec was hand-edited outside of
  this workflow, warn the user before overwriting. Prefer appending new
  requirements over modifying manually-edited ones.
- **No spec exists yet**: Redirect to the full analyze skill instead.
