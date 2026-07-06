# Greenfield Guidance

This reference defines how the wiki build works when there is no existing
codebase — only product artifacts (docs, mockups, URLs, spreadsheets).

Load this reference when the analyze skill runs in **greenfield** mode.

---

## Epistemic Markers

Without code as a source of truth, confidence comes from artifact
corroboration and product owner sign-off. The wiki page contract
(Confirmed / Inferred / Gaps) uses these adapted definitions:

| Marker | Greenfield definition | Examples |
|---|---|---|
| `Confirmed` | PO-approved, or corroborated by 2+ independent artifacts | PRD says "admin role" AND mockup shows admin nav → Confirmed |
| `Inferred` | Derived from a single artifact source | Only the PRD mentions "audit log" → Inferred |
| `Gap` | Logical dependency with no artifact coverage | PRD lists "payments" but no pricing model artifact exists → Gap |

### Corroboration rules

Two artifacts corroborate a claim when:
- They are **independent sources** (not one quoting the other)
- They agree on the **substance** (not just the terminology)
- At least one provides **concrete detail** (field names, flow steps, UI layout)

A single artifact restated in two places (e.g., PRD executive summary and
PRD feature list) is NOT corroboration — it is the same source.

### Promotion path

```
Gap → Inferred → Confirmed
```

- Gap → Inferred: an artifact is found or provided that addresses the gap
- Inferred → Confirmed: a second independent artifact corroborates, OR the
  PO explicitly approves the inference

Items never skip levels. A PO answer can promote a Gap directly to Confirmed
only if the answer itself constitutes a concrete, actionable decision.

---

## Three-Tier Artifact Intake

### Tier 1: Text-native

| Extensions | Processing |
|---|---|
| `.md`, `.txt`, `.json`, `.yaml`, `.yml`, `.csv`, `.tsv` | Direct parse — extract structure, entities, features, flows |

These are the highest-fidelity inputs. Parse them first. Look for:
- Feature lists, user stories, acceptance criteria
- Entity names, field definitions, relationships
- User roles, permissions, access rules
- Non-functional requirements, constraints

### Tier 2: Visual

| Extensions | Processing |
|---|---|
| `.png`, `.jpg`, `.jpeg`, `.gif`, `.pdf` (with layouts/mockups) | Vision model extraction |

Use Claude's vision capability to extract:
- Screen layouts, navigation structure, component inventory
- Data fields visible in forms and tables
- User flow implied by screen sequences
- Branding signals (colors, typography, density)

Record extracted details with `Source: [filename] (vision extraction)` to
distinguish from text-parsed facts.

### Tier 3: Reference URLs

| Signals | Processing |
|---|---|
| `http://`, `https://` (competitor sites, docs, Figma links) | Fetch → extract text content |

Use web fetch to retrieve content, then extract:
- Feature sets (competitive analysis → `review/research-backlog.md`)
- API documentation (integration requirements)
- Design patterns (UI conventions, information architecture)

URL-sourced information is always `Inferred` unless corroborated by a
first-party artifact. Competitive features go to the research backlog,
not directly into the feature list.

### Source manifest format

Build `intake/source-manifest.md` listing every artifact:

```markdown
# Source Manifest

| # | Artifact | Type | Processing | Status | Key signals |
|---|---|---|---|---|---|
| 1 | product-brief.md | text | text_parse | processed | Features, user roles, domain scope |
| 2 | wireframes.pdf | visual | vision | processed | 12 screens, nav structure, form fields |
| 3 | https://competitor.com | url | url_fetch | processed | Feature comparison, pricing tiers |
| 4 | data-model.csv | text | text_parse | processed | 8 entities, 47 fields |
| 5 | stakeholder-notes.md | text | text_parse | processed | Constraints, timeline, priorities |
```

Status values: `pending`, `processed`, `failed`, `skipped`

---

## Completeness Heuristic

Greenfield wikis need a readiness signal before spec formalization. Use the
wiki index's `completeness_score` field (see `references/indexing-contract.md`)
to assess each page:

| Score | Label | Criteria |
|---|---|---|
| 0 | Empty | Page has only the template heading, no content |
| 1 | Stub | Has some content but mostly gaps and open questions |
| 2 | Partial | Has confirmed and inferred content, some gaps remain |
| 3 | Complete | All sections filled, no critical gaps, sources cited |

### Spec-readiness criteria

The wiki is ready for spec formalization when ALL of these are true:

1. **No page scores 0** — every page has at least stub content
2. **Product section averages 2+** — `product/*.md` pages are partial or better
3. **No HIGH-priority open questions** — all HIGH questions in
   `review/product-owner-questions.md` are answered or integrated
4. **Core pages score 2+** — specifically:
   - `product/overview.md`
   - `product/features-and-capabilities.md`
   - `product/journeys-and-flows.md`
   - `engineering/data-and-entities.md`

If the wiki is not spec-ready, report what's missing:
```
Wiki completeness: 68% (not spec-ready)
  Blocking: product/roles-and-permissions.md (score: 0, empty)
  Blocking: 2 HIGH-priority open questions unanswered
  Weak: engineering/interfaces-and-integrations.md (score: 1, stub)
```

The user can override with `--force-spec` to generate a spec anyway — it
will carry more `[GAP]` and `[INFERRED]` markers than usual.

---

## Competitive Analysis Handling

When reference URLs point to competitor products:

1. Fetch and extract the competitor's visible features, UX patterns, and
   information architecture
2. Record findings in `review/research-backlog.md` as `Inferred` evidence
   with source attribution
3. Do NOT copy competitor features directly into `product/features-and-capabilities.md`
4. Instead, note them as market context that the PO can choose to adopt,
   adapt, or ignore
5. If a competitor feature corroborates something already in a first-party
   artifact, it strengthens that item (single artifact + competitor = still
   `Inferred`, but note the corroboration)

Competitive analysis entries in the research backlog use this format:

```markdown
### RB-00N: Competitor feature observation

- Source: https://competitor.com/feature-page
- Observed: [what the competitor does]
- Relevance: [how this relates to our product]
- Recommendation: adopt | adapt | ignore | needs-PO-decision
- Priority: low | medium | high
```

---

## Differences from Brownfield

| Aspect | Brownfield | Greenfield |
|---|---|---|
| Primary evidence | Code (schema, routes, components) | Artifacts (docs, mockups, URLs) |
| `arnold context` | Required (provides artifact map) | Skipped (no code to scan) |
| Epistemic markers | Code = Confirmed, inference = Inferred | Corroboration = Confirmed, single source = Inferred |
| Typical gap density | Low (code is comprehensive) | High (artifacts are incomplete) |
| Completeness check | Optional (code coverage implies completeness) | Required (spec-readiness heuristic) |
| Engineering pages | Filled from code analysis | Filled from data artifacts + inference |
| Spec type | `as_built` | `target` |
