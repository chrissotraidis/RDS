# Wiki

A Claude Code plugin that turns product artifacts into a living product wiki and formal spec.

## TL;DR

You point it at a project. It reads your code, PRDs, design docs -- whatever you've got -- and produces:

1. **A product wiki** -- human-readable, organized by features, journeys, data model, permissions, etc. Everything tagged as *confirmed*, *inferred*, or *gap*.
2. **A formal spec** -- machine-readable, consumed by downstream tools to generate tasks, tests, and code.

It also generates **questions for the product owner** when it finds gaps or contradictions.

### The loop

**Analyze** the project. **Deepen** with specialist passes (gaps, UX, research). **Answer** the generated questions. **Maintain** as things change. Repeat.

### Modes

| Mode | When | What you get |
|---|---|---|
| **Brownfield** | Existing codebase (default) | Wiki + as-built spec |
| **Greenfield** | No code yet, just artifacts | Wiki + target spec |
| **Replacement** | Rebuilding on a new stack | Wiki + both specs + feature triage |

### Prerequisites

Install Arnold, the CLI that reads your codebase:

```bash
brew install arnold
```

Keep it current with `brew upgrade arnold`.

---

## How it works

### 1. Analyze

Point the `analyze` command at a codebase or a folder of product artifacts:

```
/wiki:analyze /path/to/project
```

Mode is auto-detected, or you can be explicit:

```
/wiki:analyze --mode replacement --target-stack nextjs
```

For **replacement** mode, a triage step collects keep/change/drop decisions per feature and runs impact analysis before finalizing the target spec:

```
/wiki:triage
```

### 2. Deepen with specialist passes

Run targeted reviews to fill in what the analysis missed:

| Command | What it does |
|---|---|
| `/wiki:wiki-gap-analysis` | Finds contradictions, missing requirements, and blockers |
| `/wiki:wiki-research` | Fills gaps using external sources (vendors, standards, competitors) |
| `/wiki:wiki-ux-review` | Identifies UX friction, terminology issues, and accessibility risks |
| `/wiki:wiki-questions` | Audits every page and funnels open questions into the central PO queue |

Every specialist pass above files questions directly into `review/product-owner-questions.md` as it runs — that file is the single canonical queue. Per-page `## Open questions` sections are pointer lists into it. See the *Single-funnel rule* in [references/wiki-blueprint.md](references/wiki-blueprint.md).

### 3. Answer questions

Every skill in the plugin funnels open questions into one place: `review/product-owner-questions.md`. Whether a question comes from `analyze`, `wiki-gap-analysis`, `wiki-ux-review`, or `wiki-amend`, it lands as a `POQ-NNN` entry in this queue. Per-page `## Open questions` sections are pointer lists that reference those ids — so you scan one file, answer in one place, and the results cascade back to the pages.

Each question explains what decision is needed, why it matters, and what's blocked.

**To answer a question:**

1. Find the question in `review/product-owner-questions.md`
2. Fill in the "Product owner answer" section (Decision, Rationale, Constraints)
3. Change the Status from `open` to `answered-unreviewed`
4. Run `/wiki:wiki-maintenance`

The plugin then:

- Assesses whether the answer is clear enough to act on
- Updates the affected wiki pages with the new decision
- Records it in `product/decision-log.md` as a durable record
- Triggers follow-on reviews if the answer affects UX, gaps, or external facts
- Marks the question `integrated`, `needs-clarification`, or `conflicts-existing-docs`

### 4. Keep it current

Run the maintenance cycle after any substantial changes:

```
/wiki:wiki-maintenance
```

This rebuilds the search index, generates specialist briefs, and syncs the spec with wiki changes. You can also sync the spec directly:

```
/wiki:spec-sync
```

**When new artifacts arrive** (a revised PRD, a decision memo, a new data dictionary, a competitor spec), drop them into `wiki/intake/inbox/` and run:

```
/wiki:wiki-amend
```

The amend skill extracts atomic claims from the new artifact, diffs them against the existing wiki, applies non-conflicting changes in place with provenance, and files conflicts as product-owner questions rather than silently overwriting confirmed facts. Processed artifacts are archived to `wiki/intake/sources/<date>/`.

## All commands

| Command | Purpose |
|---|---|
| `/wiki:analyze` | Analyze a codebase or artifacts into wiki + spec |
| `/wiki:spec-sync` | Sync spec with wiki changes |
| `/wiki:triage` | Keep/change/drop decisions for replacement mode |
| `/wiki:wiki-steward` | Full wiki builder and orchestrator |
| `/wiki:wiki-bootstrap` | Scaffold a new wiki from product artifacts |
| `/wiki:wiki-amend` | Fold new artifacts into an existing wiki with conflict detection |
| `/wiki:wiki-gap-analysis` | Find contradictions, missing requirements, and blockers |
| `/wiki:wiki-research` | Fill gaps with sourced external context |
| `/wiki:wiki-ux-review` | Review for UX risks, navigation, terminology, accessibility |
| `/wiki:wiki-questions` | Audit pages and funnel open questions into the PO queue |
| `/wiki:wiki-reindex` | Rebuild the retrieval index |
| `/wiki:wiki-answer-integrator` | Reconcile answered questions into the wiki |
| `/wiki:wiki-process-answers` | Process answered questions into specialist briefs |
| `/wiki:wiki-maintenance` | Full maintenance cycle |

## Wiki structure

```
wiki/
  index.md                        Start here
  intake/
    inbox/                        Drop new artifacts here for amendment
    sources/<date>/               Archive of processed artifacts
    source-manifest.md            Catalog of every ingested source
    synthesis-notes.md            Cross-artifact notes and dated amendment log
  product/
    overview.md                   What the product is and who it's for
    decision-log.md               Accepted decisions and rationale
    users-and-personas.md         User segments and roles
    journeys-and-flows.md         End-to-end workflows
    features-and-capabilities.md  Feature inventory
    roles-and-permissions.md      Authorization model
  design/
    ux-observations.md            Usability findings
    information-architecture.md   Navigation and grouping
    content-and-terminology.md    Naming and copy
    accessibility-and-inclusion.md
  engineering/
    system-behavior.md            State transitions and business rules
    data-and-entities.md          Core data model
    interfaces-and-integrations.md
    analytics-and-observability.md
  operations/
    risks-and-known-gaps.md       Risk register
    release-and-support.md
  review/
    product-owner-questions.md    Questions for you
    ux-improvements.md            Recommended UX changes
    research-backlog.md           Facts that need follow-up
    migration-triage.yml          Keep/change/drop decisions (replacement mode)
spec.md                            Formal spec (brownfield or greenfield)
spec.as-built.md                   Existing system spec (replacement mode)
spec.target.md                     Target system spec (replacement mode)
```

## Installation

### Prerequisites

```bash
brew install arnold
```

### Local testing

```bash
git clone https://github.com/chrissotraidis/RDS.git
claude --plugin-dir ./wiki
```

### Team install

```
/plugin marketplace add chrissotraidis/RDS
/plugin install wiki
```

## License

MIT
