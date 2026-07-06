---
name: wiki-amend
description: Fold new product artifacts (PDFs, Word docs, spreadsheets, markdown, URLs) into an existing product wiki. Use when a PO drops a new spec, decision memo, research doc, or mockup into `wiki/intake/inbox/` and the wiki needs to be updated to reflect it without starting over.
---

# Wiki Amend

## Overview

Incremental counterpart to `wiki-bootstrap` and `analyze`. Those skills build a wiki from nothing; this skill **amends** an existing wiki with new source material. It extracts requirements from the new artifact(s), diffs them against the current wiki, applies non-conflicting changes in place, and files conflicts as product-owner questions instead of silently overwriting confirmed facts.

Load these references:

- `references/source-amendment.md`: change classification, conflict policy, target-page selection, archive convention
- `references/wiki-blueprint.md`: page contract, page-to-topic mapping, PO question format
- `references/greenfield-guidance.md`: three-tier artifact intake (text / visual / URL), epistemic markers
- `references/indexing-contract.md`: what the reindex step expects

## When to Use

- A PO dropped a new PDF spec, Word decision memo, Excel data dictionary, or markdown doc into the wiki
- A new competitor URL or vendor spec needs to be reconciled with the wiki
- The user says "fold this into the wiki" or "update the wiki with this document"
- An existing artifact was revised and its updates need to cascade

Do **not** use this skill when:

- The wiki does not exist yet — run `/wiki:wiki-bootstrap` or `/wiki:analyze`
- The input is a product-owner *answer* to an existing question — run `/wiki:wiki-answer-integrator`
- The input is a code change — update the wiki manually or re-run `/wiki:analyze`

## Inputs

Required one of:

- Artifact file path(s) passed as arguments
- Artifacts already staged in `<wiki-root>/intake/inbox/`

Required:

- Path to the wiki directory (the one containing `index.md`, `product/`, etc.)

Optional:

- `--scope <pages>` — restrict amendment to a subset of wiki pages (comma-separated relative paths)
- `--dry-run` — produce the change plan without writing to wiki pages
- `--no-sync` — skip the downstream spec-sync step

## Prerequisites

Before running:

1. The wiki directory exists and follows the blueprint layout
2. `<wiki-root>/intake/inbox/` exists (create it if missing) and contains the new artifact(s), OR artifact paths are passed as arguments
3. Git working tree is clean, or the user has accepted that changes will touch many wiki pages

If the wiki doesn't exist, prompt the user to run `/wiki:wiki-bootstrap` first and stop.

## Workflow

### 1. Stage the artifacts

If artifact paths were passed as arguments, copy them into `<wiki-root>/intake/inbox/`. If the inbox is empty after staging, stop and tell the user where to put the artifacts.

List every file in the inbox, including nested directories. For each, record:

- File path (relative to wiki root)
- Size, mtime, SHA-256 (short)
- Detected type (text / visual / spreadsheet / document / url-list / unknown)

### 2. Extract content per tier

Extend the three tiers from `references/greenfield-guidance.md`:

| Tier | Extensions | Extraction method |
|---|---|---|
| Text-native | `.md`, `.txt`, `.json`, `.yaml`, `.yml`, `.csv`, `.tsv` | Read directly |
| Document | `.pdf`, `.docx` | Read the file with the Read tool; for `.docx` use the `docx` skill if available; for `.pdf` use the `pdf` skill if available, else Read with the `pages` parameter |
| Spreadsheet | `.xlsx`, `.xlsm` | Use the `xlsx` skill if available, else ask the user to export to CSV |
| Visual | `.png`, `.jpg`, `.jpeg`, `.gif` | Read the file (multimodal) and describe what's relevant |
| URL list | `url-list.txt` or `.md` with bare URLs | Fetch each URL, extract key text |

For each artifact, produce a **candidate statement list** — atomic, page-addressable facts. Examples:

- "Admin role can delete other users' workspaces"
- "Payment terms are net-30, configurable per customer"
- "Login requires MFA for users with role `clinician`"

Do not copy prose wholesale. Decompose into claims a wiki bullet would hold. See `references/source-amendment.md` for claim extraction patterns.

### 3. Classify and target each claim

For each candidate statement:

1. **Pick the target page(s)** using the blueprint's topic map (e.g., role claims → `product/roles-and-permissions.md`, entity claims → `engineering/data-and-entities.md`).
2. **Diff against the target page**. Search the existing `Confirmed`, `Inferred`, and `Gaps` bullets for a matching claim.
3. **Classify the change**:

| Class | Meaning | Action |
|---|---|---|
| `add` | No matching bullet on any target page | Append to `Inferred` (single artifact) or `Confirmed` (corroborates existing Inferred) |
| `strengthen` | Matches an `Inferred` bullet from a different source | Promote to `Confirmed`, list both sources |
| `fill-gap` | Matches a bullet under `Gaps` or `Open questions` | Move to `Inferred` or `Confirmed`, remove from gap list |
| `refine` | Matches a `Confirmed` bullet, adds non-contradictory detail | Edit in place, append source |
| `conflict` | Contradicts an existing `Confirmed` bullet | Do NOT edit the page — file a PO question (Step 5) |
| `duplicate` | Already in the wiki with the same source | Skip |

Build the change plan as a list of `(target_page, class, existing_bullet, new_bullet, artifact)` tuples.

If `--dry-run`, print the plan and stop.

### 4. Apply non-conflict changes

For every non-`conflict` entry:

1. Edit the target page — add, strengthen, fill, or refine the bullet.
2. Append the artifact to the page's `Sources` section (use the artifact's relative path under `intake/inbox/` — it will be archived in Step 6).
3. Update the `intake/source-manifest.md` table with a new row per new artifact.
4. Log the change in `intake/synthesis-notes.md` under a dated heading (`## YYYY-MM-DD Amendment from <artifact-names>`).

Preserve the page contract (`Purpose` / `Confirmed` / `Inferred` / `Gaps` / `Open questions` / `Sources`). Do not reorder sections.

### 5. File conflicts as PO questions

For each `conflict` entry, append a new question to `review/product-owner-questions.md` using the blueprint's POQ format:

```markdown
### POQ-NNN: Resolve conflict between <topic> and <artifact>

- Status: open
- Priority: high
- Source pages: <target page>
- Trigger agents: `answer-integrator`
- Decision needed: Which statement is correct — the existing wiki claim or the new artifact?
- Why this matters: <one sentence on what's blocked>
- Affected areas: <list>

#### Existing wiki claim

- Page: <target>
- Statement: <quoted bullet>
- Sources: <current sources>

#### New artifact claim

- Artifact: <inbox path>
- Statement: <extracted claim>
- Context: <nearby context or page/section where it appeared>

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

Do not modify the conflicting wiki page until the PO answers. The new artifact is also **not** added to that page's sources yet.

Also add a row to `operations/risks-and-known-gaps.md` flagging the unresolved conflict.

### 6. Archive processed artifacts

After applying changes (or filing all conflicts):

1. Create `intake/sources/<YYYY-MM-DD>/` if it does not exist.
2. Move each inbox artifact into that dated folder.
3. Update the `intake/source-manifest.md` entries to point to the archived path.
4. Leave `intake/inbox/` empty (ready for the next amendment).

If a conflict blocked the artifact from being applied anywhere, still archive it — the conflict question references the archived path.

### 7. Rebuild index and cascade to spec

```bash
python3 scripts/build_wiki_index.py <wiki-root>
```

Then, unless `--no-sync` was passed, invoke `/wiki:spec-sync` with the list of pages touched in Step 4. The spec-sync skill decides patch vs. re-formalize based on scope.

### 8. Report

Print a summary:

```
Wiki amend complete:
  Artifacts processed: 3 (product-spec-v2.pdf, roles.xlsx, vendor-notes.md)
  Claims extracted: 47
  Applied: 38 (add: 22, strengthen: 9, fill-gap: 4, refine: 3)
  Conflicts filed: 4 (see review/product-owner-questions.md POQ-014..017)
  Duplicates skipped: 5
  Pages touched: 9
  Sources archived to: intake/sources/2026-04-23/
  Spec sync: cascaded to sections 2, 3, 9
```

## Rules

- **Never silently overwrite a `Confirmed` statement.** Conflicts become PO questions, not edits.
- **Single-funnel rule**: follow the rule in `references/wiki-blueprint.md`. Conflicts are the obvious case, but the same rule applies to any *new* ambiguity the artifact surfaces (e.g., the artifact introduces a concept with no clear owner, or references a workflow that isn't documented). File a POQ for each, then add a pointer line to the affected page's `## Open questions` section. Never leave free-form question bullets behind.
- **Single artifact = `Inferred` by default.** Promotion to `Confirmed` requires a second independent source or PO sign-off, per `references/greenfield-guidance.md`.
- **Preserve provenance.** Every edited bullet gets its source appended; no orphan claims.
- **Do not collapse or rewrite sections outside the amendment scope.** If a page has unrelated gaps, leave them alone — that is `wiki-gap-analysis`'s job.
- **Stop and ask** if more than ~30% of a page's `Confirmed` bullets conflict with the new artifact — that signals a rewrite, not an amendment, and the PO should decide how to proceed.
- **Idempotent.** Running the skill again with the same (already-archived) artifacts should produce zero changes.

## Primary outputs

- Updated wiki pages (per the change plan)
- Appended entries in `intake/source-manifest.md` and `intake/synthesis-notes.md`
- New PO questions for every conflict
- Archived artifacts under `intake/sources/<date>/`
- Rebuilt `index/wiki-index.{json,md}`
- Spec updates via `spec-sync` (unless `--no-sync`)
