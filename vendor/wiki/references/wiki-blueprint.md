# Wiki Blueprint

Use this structure unless the user already has a strong wiki convention to preserve.

## Recommended layout

```text
<wiki-root>/
  index.md
  intake/
    inbox/                        # staging area for new artifacts pending amendment
    sources/<YYYY-MM-DD>/         # archive of processed artifacts, keyed by amendment date
    source-manifest.md
    source-manifest.json
    synthesis-notes.md
  product/
    overview.md
    decision-log.md
    users-and-personas.md
    journeys-and-flows.md
    features-and-capabilities.md
    roles-and-permissions.md
  design/
    information-architecture.md
    ux-observations.md
    content-and-terminology.md
    accessibility-and-inclusion.md
  engineering/
    system-behavior.md
    data-and-entities.md
    interfaces-and-integrations.md
    analytics-and-observability.md
  operations/
    release-and-support.md
    risks-and-known-gaps.md
  review/
    ux-improvements.md
    product-owner-questions.md
    research-backlog.md
    migration-triage.yml          # replacement mode only
  index/
    wiki-index.json
    wiki-index.md
```

## Page contract

Each substantive page should contain most of these sections when relevant:

```markdown
# Title

## Purpose

## Confirmed

## Inferred

## Gaps

## Open questions

- See POQ-NNN — one-line hook (status: open)

## Sources
```

Use shorter pages when the topic is narrow, but keep the meaning of those sections intact.

### Single-funnel rule for open questions

`review/product-owner-questions.md` is the **only** canonical queue for questions that need a product-owner decision. Per-page `## Open questions` sections are *page-local indexes* into that queue — they reference POQ ids, they do not originate content.

The rule:

- **Every bullet under a page's `## Open questions` section MUST reference a `POQ-NNN` id.** Free-form bullets are not allowed.
- **Any skill that discovers a new question files a POQ first**, then adds a `- See POQ-NNN — short hook (status: <status>)` line to each affected page's `## Open questions` section.
- **The page-local line is a pointer, not a duplicate.** The decision, rationale, constraints, and answer all live in the POQ entry; the page line exists so a reader scanning one page can see what's unresolved there without grepping the queue.
- **`wiki-questions` is the auditor.** It sweeps for any free-form bullets that slipped in, promotes them to POQs, and replaces them with pointer lines. It is not the primary author of questions — every skill that touches wiki pages shares that responsibility.

Why: without this funnel, questions scattered across per-page sections are invisible to `wiki-answer-integrator`, `wiki-process-answers`, and the status workflow. A single inbox lets the PO answer once and have the result cascade.

## Document guidance

- `index.md`: top-level map, major sections, and where to find key answers quickly
- `intake/inbox/`: staging directory for new artifacts awaiting amendment. Entry point for `/wiki:wiki-amend`. Should be empty between amendment runs
- `intake/sources/<YYYY-MM-DD>/`: archive of processed sources, keyed by amendment date. Append-only; never edited after archival. Oversized binaries may be replaced with pointer files per `references/source-amendment.md`
- `intake/source-manifest.md`: every artifact, its path or URL, and what it appears to cover. Updated on every amendment; the canonical list of sources the wiki has consumed
- `intake/synthesis-notes.md`: cross-artifact conflicts, assumptions, early interpretation notes, and a dated log of amendment runs
- `product/overview.md`: problem statement, product promise, users, scope, and non-goals
- `product/decision-log.md`: durable record of accepted product decisions and the questions or evidence that led to them
- `product/users-and-personas.md`: user segments, operators, admins, and external actors
- `product/journeys-and-flows.md`: end-to-end jobs, branching points, prerequisites, and failure paths
- `product/features-and-capabilities.md`: feature inventory with status, dependencies, and unclear areas
- `product/roles-and-permissions.md`: authorization model, role differences, and access questions
- `design/information-architecture.md`: navigation model, grouping, labels, and discoverability concerns
- `design/ux-observations.md`: observed or inferred usability issues and friction points
- `design/content-and-terminology.md`: definitions, naming inconsistencies, and copy guidance
- `design/accessibility-and-inclusion.md`: accessibility expectations, known risks, and missing standards
- `engineering/system-behavior.md`: state transitions, background jobs, automation, and notable rules
- `engineering/data-and-entities.md`: core entities, important fields, relationships, and lifecycle
- `engineering/interfaces-and-integrations.md`: APIs, imports, exports, third parties, and handoffs
- `engineering/analytics-and-observability.md`: events, metrics, dashboards, alerts, and tracking gaps
- `operations/release-and-support.md`: rollout, support paths, operational ownership, and escalation paths
- `operations/risks-and-known-gaps.md`: the current risk register and unresolved product holes
- `review/ux-improvements.md`: concrete UX recommendations ranked by expected impact and cost
- `review/product-owner-questions.md`: a short list of decision-ready questions for the product owner
- `review/research-backlog.md`: missing facts that require follow-up or external research
- `review/migration-triage.yml`: feature disposition decisions for replacement mode (keep/change/drop per feature, with impact analysis on drops). Generated by `/wiki:triage`. Machine-parseable YAML consumed by scaffold for task generation

## Product owner answer contract

Use `review/product-owner-questions.md` as the canonical queue for unresolved and recently answered questions.

Each question should use this shape:

```markdown
### POQ-001: Decision title

- Status: open
- Priority: high
- Source pages: `product/overview.md`, `product/journeys-and-flows.md`
- Trigger agents: `answer-integrator`, `wiki-index-maintainer`
- Decision needed: one-sentence description of the decision
- Why this matters: why the answer changes product or implementation work
- Affected areas: permissions, navigation, analytics

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

Use these statuses:

- `open`
- `answered-unreviewed`
- `integrated`
- `needs-clarification`
- `conflicts-existing-docs`
- `closed`

`answered-unreviewed` is the trigger state for the answer reconciliation workflow.

## Spec section mapping

When a wiki page changes, the corresponding spec section(s) need updating.
This mapping is used by the `spec-sync` skill and the analyze workflow.

| Wiki Page | Spec Section(s) | Update triggers |
|-----------|----------------|-----------------|
| `product/overview.md` | 1. Overview | Domain, users, scope, boundaries |
| `product/features-and-capabilities.md` | 2. Features | Feature added, removed, or reclassified |
| `product/users-and-personas.md` | 1. Overview, 2. Features | Role definitions, capabilities |
| `engineering/data-and-entities.md` | 3. Entities & Data Model | Entity, attribute, or relationship change |
| `product/journeys-and-flows.md` | 4. User Journeys | Journey added or modified |
| `design/information-architecture.md` | 5. Views & Interfaces | Screen, navigation, or layout change |
| `design/ux-observations.md` | 5. Views & Interfaces | Friction or usability finding |
| `engineering/system-behavior.md` | 6. System Behaviors, 7. Logic | Job, automation, or algorithm change |
| `engineering/interfaces-and-integrations.md` | 8. External Connections | Integration added or changed |
| `product/roles-and-permissions.md` | 9. Security & Privacy | Role, permission, or access change |
| `design/content-and-terminology.md` | 3. Entities (naming) | Domain vocabulary change |
| `engineering/analytics-and-observability.md` | 6. System Behaviors | Monitoring or audit change |
| `operations/release-and-support.md` | 10. Future Considerations | Deployment gap identified |
| `operations/risks-and-known-gaps.md` | 11. Review (risks) | Risk added or resolved |
| `review/product-owner-questions.md` | 11. Review (open questions) | Question answered or added |
| `product/decision-log.md` | Cross-cutting (any section) | Accepted decision may affect any section |

The `spec-sync` skill uses this table to determine which spec sections to
update when wiki pages change. See `references/spec-format.md` for the full
spec output format and `references/analyze-workflow.md` for the update rules.

## Writing rules

- Prefer bullets and tables when they improve scan speed
- Distinguish confirmed statements from inferred ones
- Keep open questions visible; do not bury them in prose
- Link across pages when one topic depends on another
- Avoid generic filler such as “The product should be user friendly”

## Minimum viable wiki

If the artifact quality is low, still produce at least these files:

- `index.md`
- `intake/source-manifest.md`
- `product/overview.md`
- `product/decision-log.md`
- `product/journeys-and-flows.md`
- `operations/risks-and-known-gaps.md`
- `review/product-owner-questions.md`
- `index/wiki-index.json`
