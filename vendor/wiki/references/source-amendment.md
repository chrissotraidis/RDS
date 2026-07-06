# Source Amendment

Reference for `wiki-amend`. Covers claim extraction, change classification, target-page selection, conflict policy, and the archive convention.

Load this when folding new source artifacts into an existing wiki.

---

## Location contract

The amendment workflow uses three stable directories under the wiki root:

| Path | Purpose | Lifecycle |
|---|---|---|
| `intake/inbox/` | Where new artifacts land before processing | Emptied after each amend run |
| `intake/sources/<YYYY-MM-DD>/` | Archive of processed artifacts, keyed by amendment date | Append-only; never deleted |
| `intake/source-manifest.md` | Canonical list of every source the wiki has consumed | Updated per amendment |

The `inbox/` directory is the skill's entry point. Anything in it is treated as unprocessed input. Anything under `sources/` has already been reconciled into the wiki — it is reference material.

If a user commits artifacts directly to `product/`, `engineering/`, or any other content folder, treat that as a wiki convention violation and move the artifact to `intake/inbox/` before amending.

---

## Claim extraction

Extract **atomic, page-addressable claims** from each artifact, not prose summaries. A claim is one fact a wiki bullet could hold.

### Good claim shape

- Subject + predicate + concrete detail
- Survives out of surrounding document context
- Maps cleanly to one wiki page's topic

Examples:

- `Admins can reassign care plans between clinicians` → `product/roles-and-permissions.md`
- `Appointments have a required duration field in 15-minute increments` → `engineering/data-and-entities.md`
- `Password reset emails expire after 30 minutes` → `engineering/system-behavior.md`

### Bad claim shape

Rewrite or split these:

- `The product should be user-friendly` (not addressable, no wiki page owns this)
- `Chapter 3 describes the permission model, which includes several roles` (meta-commentary, not a fact)
- `Admins, clinicians, and patients each have different permissions, and admins can do X, Y, Z while clinicians can do A, B` (compound — split into one claim per role+permission)

### Extraction patterns by source type

| Source | Where to look |
|---|---|
| PRD / spec doc | Requirement lists, user stories, acceptance criteria, constraints tables |
| Decision memo | "Decision", "Rationale", "Implications" sections |
| Data dictionary (xlsx) | Each row = one entity/field/relationship claim |
| Mockups / wireframes | Visible fields, labels, affordances, navigation, role-gated UI |
| Competitor URL | Feature list, pricing tiers, UX patterns — always `Inferred`, typically to `review/research-backlog.md` rather than feature pages |
| Meeting notes | Decisions, action items, stated constraints (ignore discussion threading) |

---

## Target page selection

Map each claim to the narrowest authoritative page(s) using the blueprint's purpose table. A claim may target multiple pages only when it genuinely belongs in both (e.g., a new user role is both a persona and a permission change).

### Quick routing table

| Claim type | Primary page |
|---|---|
| Product scope, problem statement, non-goals | `product/overview.md` |
| User segments, personas | `product/users-and-personas.md` |
| Feature inventory, capabilities | `product/features-and-capabilities.md` |
| End-to-end user journeys | `product/journeys-and-flows.md` |
| Roles, permissions, authorization | `product/roles-and-permissions.md` |
| Accepted decisions with rationale | `product/decision-log.md` |
| Navigation, IA, page structure | `design/information-architecture.md` |
| Terminology, naming, copy | `design/content-and-terminology.md` |
| Accessibility requirements | `design/accessibility-and-inclusion.md` |
| UX friction observations | `design/ux-observations.md` |
| Entities, fields, relationships, lifecycle | `engineering/data-and-entities.md` |
| State machines, background jobs, rules | `engineering/system-behavior.md` |
| APIs, integrations, imports/exports | `engineering/interfaces-and-integrations.md` |
| Events, metrics, dashboards | `engineering/analytics-and-observability.md` |
| Rollout, support, ops ownership | `operations/release-and-support.md` |
| Risks, unresolved gaps | `operations/risks-and-known-gaps.md` |
| Competitor observations | `review/research-backlog.md` |

If a claim does not fit any page, capture it in `intake/synthesis-notes.md` under "Unrouted claims" and file a PO question asking where it belongs.

---

## Change classification

For each claim, find the best-matching existing bullet on the target page and classify the change:

| Class | Match criterion | Action |
|---|---|---|
| `add` | No matching bullet | Append to `Inferred` |
| `strengthen` | Matches `Inferred` bullet, different source | Promote to `Confirmed`, merge sources |
| `fill-gap` | Matches item in `Gaps` or `Open questions` | Move to `Inferred` / `Confirmed`, remove gap entry |
| `refine` | Matches `Confirmed` bullet, adds compatible detail | Edit bullet in place, append source |
| `conflict` | Matches `Confirmed` bullet, contradicts it | File PO question, do not edit page |
| `duplicate` | Matches bullet with the same source already cited | Skip |

### Match criterion

A claim "matches" an existing bullet when:

- They describe the same subject (same entity, role, feature, or flow)
- They make a statement about the same predicate (same property, behavior, or relationship)
- A reader would consider them the same fact, not two independent facts

Two claims about the same subject with **different predicates** are not a match — they are both `add` (e.g., "admin can delete workspaces" and "admin can reassign workspaces" are distinct).

### Promotion path

```
Gap → Inferred → Confirmed
```

Never skip levels unless a PO decision explicitly promotes `Gap → Confirmed`. In that case, require the decision to be captured in `product/decision-log.md` with its own DEC-NNN id and referenced in the bullet's source line.

---

## Conflict policy

A `conflict` is the most important case. The rules:

1. **Do not edit the wiki page.** The existing `Confirmed` statement stands until the PO decides.
2. **File a PO question** per the blueprint's POQ format, with both the existing claim and the new claim quoted verbatim. Priority is `high` by default.
3. **Add a risk** to `operations/risks-and-known-gaps.md` referencing the POQ.
4. **Tag the target page** at the top of its `Sources` section with a note:
   ```
   > Amendment conflict pending: see POQ-014
   ```
   Remove this note after the PO answer is integrated.
5. **Still archive the artifact** — the POQ references its archived path.

### Bulk-conflict escape hatch

If more than ~30% of a page's `Confirmed` bullets conflict with the new artifact, stop. This is not an amendment — it is a rewrite. Tell the user:

```
Source <name> contradicts 12 of 27 Confirmed statements on product/overview.md.
This looks like a replacement, not an amendment. Options:
  1. Run /wiki:analyze --mode greenfield on the new artifact alone
     and diff the resulting wiki against the current one.
  2. File all 12 as PO questions and wait for decisions before proceeding.
  3. Mark the new artifact as authoritative and re-bootstrap from it.
```

Do not proceed without explicit user direction.

---

## Provenance and source attribution

Every change must carry its source. The rules:

### On the target page

Append the artifact to the page's `Sources` list, using the artifact's archived path (Step 6 of the skill moves it from `inbox/` to `sources/<date>/`):

```markdown
## Sources

- intake/source-manifest.md
- intake/sources/2026-04-23/product-spec-v2.pdf (§3.2, Permissions)
```

Include a section/page reference when the artifact is long — a reader should be able to re-locate the claim inside the source.

### On the bullet itself

For bullets that trace to a specific artifact, append an inline source tag:

```markdown
## Confirmed

- Admins can reassign care plans between clinicians (Source: product-spec-v2.pdf §3.2)
```

Do this for `strengthen`, `refine`, and `fill-gap` changes. For pure `add` entries, the page-level `Sources` list is sufficient.

### In the synthesis notes

Log the amendment run in `intake/synthesis-notes.md`:

```markdown
## 2026-04-23 Amendment from product-spec-v2.pdf, roles.xlsx

- Applied: 38 claims across 9 pages
- Conflicts: 4 (POQ-014..017)
- Notable: introduced `clinician-supervisor` role; confirmed MFA requirement from two independent sources
```

---

## Archive convention

Processed artifacts live at `intake/sources/<YYYY-MM-DD>/<original-filename>`. Rules:

- **Date is the amendment date**, not the artifact's authoring date. Multiple artifacts processed in one run share a date folder.
- **Original filename is preserved.** If two amendments contain files with the same name, suffix the later one with ` (2)`, ` (3)`, etc.
- **Do not rewrite or strip the artifact.** Archive it as-is so future amendments can reconcile against the same bytes.
- **Do not commit large binaries naively.** If an artifact exceeds 10MB, warn the user and let them decide whether to store it in the repo, in git-lfs, or outside the wiki with a pointer file.

A pointer file has this shape:

```markdown
# product-spec-v2.pdf (external)

- Original location: s3://company-product-docs/specs/product-spec-v2.pdf
- SHA-256: abc123...
- Size: 42 MB
- Archived on: 2026-04-23
- Retrieved via: aws s3 cp s3://...
```

---

## Downstream triggers

After a successful amend run, these downstream skills should fire (in order):

1. **`wiki-reindex`** — always. The index must reflect the new pages/sources.
2. **`spec-sync`** — always, unless `--no-sync`. Uses the list of touched pages to decide patch vs. re-formalize.
3. **`wiki-answer-integrator`** — only if conflicts were filed and the PO later answers them.
4. **`wiki-ux-review`** — only if the amendment touched `design/*.md` pages substantively.
5. **`wiki-gap-analysis`** — only if the amendment *introduced* new gaps (filled old ones doesn't count).

Steps 3-5 are not automatic — they run on the user's cadence via the maintenance cycle.

---

## Interaction with other modes

| Mode | Interaction with amend |
|---|---|
| Brownfield | Amend works the same way. The artifact is treated as a new source alongside the code-derived wiki content. |
| Greenfield | Amend is the primary update path after the initial bootstrap. Most amendments will happen in greenfield wikis. |
| Replacement | Amendments update the **as-built** wiki. If the artifact describes target behavior, route changes to `spec.target.md` via `spec-sync`, not the as-built wiki. Ambiguous cases become PO questions. |

---

## Idempotency

Running `wiki-amend` twice with the same artifacts must produce zero changes on the second run. Guaranteed by:

- Checking each claim's source against the target page's `Sources` list before applying
- Archiving the artifact after the first run so its inbox path no longer exists
- Using a content hash (SHA-256) in the source manifest to detect re-submission under a different filename

If the same logical artifact is re-submitted with new content (e.g., `product-spec-v2.pdf` replaced with `product-spec-v3.pdf`), that is a **new** amendment — the old archived version stays, the new one goes through the full flow, and every change is recomputed against the current wiki state.
