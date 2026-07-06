---
name: triage
description: Triage features from an as-built spec for replacement mode. Collects keep/change/drop decisions per feature, runs impact analysis on drops, and produces a migration-triage.yml that feeds into target spec refinement and task generation.
---

# Migration Triage

## Overview

After a replacement-mode analysis produces an as-built spec and wiki, the
product owner needs to decide what happens to each feature in the new system.
This skill presents the feature inventory and collects **keep / change / drop**
decisions, then runs impact analysis on drops to surface hidden dependencies.

The output — `review/migration-triage.yml` — is a machine-parseable decision
record that downstream tools consume:
- **Keep** features → parity contract tests
- **Change** features → modified spec requirements (SpecDelta)
- **Drop** features → absence tests + dependency impact report

Load these references:

- `references/analyze-workflow.md`: how triage integrates with the replacement workflow
- `references/wiki-blueprint.md`: wiki structure and triage artifact location
- `references/greenfield-guidance.md`: epistemic markers (for target spec updates)

## Prerequisites

This skill requires:
1. A completed wiki (from `/wiki:analyze --mode replacement`)
2. An as-built spec (`spec.as-built.md`)
3. A target spec (`spec.target.md`) — will be refined by triage decisions

If these don't exist, prompt the user to run the analyze skill first.

## Inputs

Required:
- Path to the wiki directory containing the as-built analysis

Optional:
- `--tier <N>` — only triage features in the specified build tier (1-based)
- `--interactive` — present features one at a time for decision (default)
- `--batch` — accept a pre-filled `migration-triage.yml` without prompting

## Workflow

### Step 1: Extract feature inventory

Read the as-built spec's feature list and build the initial triage manifest.
For each feature:

1. Read `spec.as-built.md` Section 2 (Features) for the feature inventory
2. Cross-reference with `product/features-and-capabilities.md` for detail
3. Identify the feature's dependency graph from the wiki:
   - Which journeys reference it (`product/journeys-and-flows.md`)
   - Which entities it touches (`engineering/data-and-entities.md`)
   - Which integrations it uses (`engineering/interfaces-and-integrations.md`)

### Step 2: Generate triage template

Create `review/migration-triage.yml` pre-populated with all features
defaulting to `keep`:

```yaml
# Migration Triage — Feature Disposition Decisions
# Generated from: spec.as-built.md
# Date: YYYY-MM-DD
# Instructions: Change disposition to 'change' or 'drop' for exceptions.
#               For 'change' entries, fill in the behavior fields.
#               For 'drop' entries, impact analysis will run automatically.

metadata:
  source_spec: spec.as-built.md
  target_stack: <from --target-stack>
  generated_at: <timestamp>
  tier_filter: <N or null>
  total_features: <count>
  triaged: 0
  pending: <count>

features:
  - feature: "User Authentication"
    req_id: REQ-AUTH-001
    tier: 1
    disposition: keep  # keep | change | drop
    dependencies:
      journeys: ["Login flow", "Password reset"]
      entities: ["User", "Session"]
      integrations: ["OAuth provider"]

  - feature: "Care Plan Management"
    req_id: REQ-CARE-001
    tier: 1
    disposition: keep
    dependencies:
      journeys: ["Create care plan", "Review care plan"]
      entities: ["CarePlan", "Goal", "Intervention"]
      integrations: []
    # Uncomment for 'change':
    # current_behavior: ""
    # desired_behavior: ""
    # rationale: ""
```

### Step 3: Collect decisions (interactive mode)

Present features grouped by tier, starting with tier 1:

```
Feature: User Authentication [REQ-AUTH-001] (Tier 1)
  Journeys: Login flow, Password reset
  Entities: User, Session
  Integrations: OAuth provider

  [K]eep  [C]hange  [D]rop  [S]kip
```

For **change** decisions, collect:
- `current_behavior` — what the feature does now
- `desired_behavior` — what it should do on the new stack
- `rationale` — why the change is needed

For **drop** decisions, immediately run impact analysis (Step 4).

For **skip**, mark as `pending` — un-triaged features block task generation
for that feature but do not block the overall pipeline.

### Step 4: Impact analysis on drops

When a feature is marked `drop`, traverse the wiki to find all references:

1. **Journey impact**: Which user journeys reference this feature?
   Read `product/journeys-and-flows.md` for mentions.
2. **Entity impact**: Which entities are exclusively used by this feature?
   Read `engineering/data-and-entities.md` for relationships.
3. **Integration impact**: Which integrations serve only this feature?
   Read `engineering/interfaces-and-integrations.md` for dependencies.
4. **Downstream impact**: Which other features depend on this one?
   Cross-reference the dependency graph.

Append the impact report to the triage entry:

```yaml
  - feature: "Legacy Reporting"
    req_id: REQ-RPT-001
    tier: 2
    disposition: drop
    impact:
      affected_journeys: ["Monthly reporting", "Compliance audit"]
      orphaned_entities: ["LegacyReport", "ReportTemplate"]
      orphaned_integrations: ["PDF export service"]
      dependent_features: ["Dashboard widgets"]
      risk_level: HIGH  # LOW | MEDIUM | HIGH | CRITICAL
      summary: "Dropping this removes 2 journeys and orphans 2 entities. Dashboard widgets depend on report data."
```

If `risk_level` is HIGH or CRITICAL, warn the PO:
```
WARNING: Dropping "Legacy Reporting" has HIGH impact.
  2 journeys removed, 2 entities orphaned, 1 dependent feature affected.
  Continue with drop? [Y/n]
```

### Step 5: Update target spec

After triage is complete, apply decisions to `spec.target.md`:

| Disposition | Spec action |
|---|---|
| `keep` | No change — requirement preserved verbatim |
| `change` | Update requirement with `desired_behavior`, mark as `[MODIFIED]`, add SpecDelta |
| `drop` | Remove requirement, add `[DROPPED]` entry with rationale and impact summary |

SpecDelta format for `change` entries:
```markdown
#### SpecDelta: REQ-CARE-001

- **Action:** modify
- **Current:** [current_behavior from triage]
- **Target:** [desired_behavior from triage]
- **Rationale:** [rationale from triage]
- **Affected GWT scenarios:** [list scenarios that need rewriting]
```

### Step 6: Generate triage summary

Report the triage results:

```
Migration Triage Complete
  Total features: 24
  Keep: 18 (75%)
  Change: 4 (17%)
  Drop: 2 (8%)
  Pending: 0

  High-impact drops: 1 (Legacy Reporting — affects 2 journeys)
  Spec deltas: 4 change entries applied to spec.target.md

  Output: review/migration-triage.yml
  Updated: spec.target.md
```

## Tier-Aligned Triage

When `--tier <N>` is specified:
- Only present features tagged with that tier
- Features in other tiers remain `pending` (not `keep`)
- Un-triaged features block task generation for that feature only
- The pipeline can proceed with triaged tiers while others wait

This prevents decision fatigue — POs don't have to decide on 50 features
upfront. They triage tier 1, build starts, then triage tier 2.

## Batch Mode

When `--batch` is specified:
- Read an existing `review/migration-triage.yml` with decisions pre-filled
- Validate all entries have valid dispositions
- Run impact analysis on any `drop` entries that don't have impact data
- Apply all decisions to target spec
- Report summary

This supports workflows where the PO fills in the YAML offline.

## Three-Bucket Classification

The triage decisions create three distinct downstream paths:

| Bucket | Downstream consumer | What it produces |
|---|---|---|
| Keep | Scaffold (parity tests) | Contract tests verifying old behavior works on new stack |
| Change | Arnold (SpecDelta) | Modified requirements with new GWT scenarios |
| Drop | Scaffold (absence tests) | Tests verifying dropped features return 404/disabled/removed |

This classification is consumed by the scaffold tool (Phase B2) when
generating tasks and acceptance criteria.
