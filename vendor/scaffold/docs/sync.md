# `bin/task sync` — spec-to-task iteration

After the initial build, `spec.md` will change — new features land, contracts
tighten, features get sunset. `bin/task sync` compiles spec-level edits into
task-level proposals: you review, you approve, `--apply` mutates `tasks.json`
and commits. Completed tasks are never modified; anything affecting built
work becomes a new pending task.

This page is the operator reference. The short pitch lives in the
[main README](../README.md#iterating-on-the-spec).

## At a glance

```bash
# Commit the spec change first — sync refuses to run on a dirty tree
git add spec.md
git commit -m "spec: add password reset flow"

# Generate the proposal
bin/task sync

# Review .scaffold/sync-proposal.md in your editor:
#   - flip `status: accept | reject | edit` per change block
#   - optionally tweak task titles, done_when, depends_on

# Apply the accepted changes
bin/task sync --apply

# Standalone: audit completed tasks whose cheap probes no longer pass
bin/task sync --show-drift
```

| Command | What |
|---|---|
| `bin/task sync` | Produce `.scaffold/sync-proposal.md` from the spec diff |
| `bin/task sync --apply` | Apply accepted changes and commit `tasks: sync against spec.md at <sha>` |
| `bin/task sync --show-drift` | Audit-only: list completed tasks whose cheap probes now fail |
| `bin/task sync --allow-dirty-spec` | Generate proposal against the working tree instead of HEAD |
| `bin/task sync --confirm-batch` | Proceed when spec has drifted >10 commits since last sync |
| `bin/task sync --apply --force` | Apply despite stale `generated_against_sha` (rare; breaks recoverability) |

## The five classifications

The classifier buckets every spec-diff hunk into exactly one of these. The
choice drives what `--apply` does.

### 1. `new-task`

The hunk introduces a feature not covered by any existing task. Proposes a
new pending task, appended at the tail of `tasks.json`.

```yaml
change_id: C-001
classification: new-task
confidence: high
target:
  position: 42            # next available integer
  depends_on: [1, 5]      # completed prerequisites
```

### 2. `modify-pending`

The hunk changes the contract of a task that is still **pending** (not yet
built). The existing task's fields are overlaid with whatever `task_payload`
supplies.

```yaml
change_id: C-002
classification: modify-pending
confidence: medium
target:
  position: 12            # the existing pending task
```

`task_payload` contains only the fields to overwrite — it is a partial
object, not a replacement. `status`, `position`, and `sync_provenance` are
never overwritten.

**Forbidden against completed tasks.** If the hunk affects a `done` task,
the classifier is supposed to choose `inject-against-completed` instead.
`--apply` will skip any `modify-pending` block targeting a completed task
and log a warning in the commit body.

### 3. `inject-against-completed`

The hunk requires a change that affects a feature already built. Since
completed tasks are immutable, this proposes a **new** pending task whose
`depends_on` includes the completed task, and whose `done_when` encodes the
updated behavior.

```yaml
change_id: C-003
classification: inject-against-completed
confidence: high
target:
  position: 43            # new; runs after the original
  depends_on: [5]         # the completed task being extended
```

Example: Task 5 (Login) is `done`. Spec adds "login should redirect to
`/onboarding` on first login." Result: Task 43 with `depends_on: [5]` and
`done_when` that proves the onboarding redirect.

### 4. `deprecate`

The hunk removes a feature from the spec. Proposes a new pending task whose
`done_when` proves the feature's **absence** (route returns 404, symbol not
referenced, file deleted).

```yaml
change_id: C-004
classification: deprecate
confidence: high
target:
  position: 44
  depends_on: [17]        # the task that originally added the feature
```

The classifier is instructed to use `deprecate` only with high confidence.
If a hunk could plausibly be editorial cleanup rather than removal intent,
it should land as `refinement-noop` instead. Deprecation tasks are flagged
in the proposal under a "requires review" marker — auto-deleting code is
more dangerous than auto-adding it.

### 5. `refinement-noop`

The hunk is a wording change, reorganization, clarification, or formatting
edit that does not alter any behavioral contract. No task is generated.

```yaml
change_id: C-005
classification: refinement-noop
confidence: low
```

The classifier is instructed to prefer `refinement-noop` over guessing.
Surfacing ambiguity is the right answer — the operator can manually add a
task if needed.

## Proposal file anatomy

`.scaffold/sync-proposal.md` has two structural parts:

```markdown
---
generated_against_sha: <HEAD sha when proposal was generated>
last_synced_spec_sha: <previous sync anchor>
generated_at: 2026-04-18T15:00:00Z
---

# Sync proposal: N changes

(free-form summary)

---
change_id: C-001
status: accept              # operator flips this: accept | reject | edit
classification: new-task
confidence: high
provenance:
  spec_diff_hunk: "@@ -142,3 +142,8 @@ ..."
  double_sample_agreement: full    # present when critic pass ran
target:
  position: 42
  depends_on: [8]
---

### Proposed task 42: Password reset flow

(readable prose)

<details><summary>Raw task payload</summary>

```json
{
  "title": "Password reset flow",
  "done_when": "POST /password_reset returns 302 ...",
  ...
}
```

</details>

---
change_id: C-002
...
```

**Authoritative source for `task_payload` is the JSON inside the
`<details>` block.** The surrounding prose is informational. If you edit
the prose, `--apply` ignores those edits. If you edit the JSON, `--apply`
takes your edits. This is intentional — the JSON block is stricter than
prose, easier to validate, and survives round-trips through `--apply` and
re-generation.

Frontmatter is authoritative for `status`, `classification`, `confidence`,
and `target`. Edit those to change what apply does; edit them *to* edit
rather than accept.

### Drift advisory tail

If drift detection finds failing probes on completed tasks, it appends a
section after the last change block:

```markdown
## ⚠️  Drift detected

| Task | Title | Failing probes |
|------|-------|-----------------|
| 17 | Survey upload with progress | `seed_credentials`, `ui_affordance` |
| 22 | Client portal | `authz_wiring` |

<details><summary>Details</summary>
...
</details>
```

Drift is **advisory only**. `--apply` does not generate tasks from drift
alone. Use the two-signal rule: drift + spec removal → deprecate task;
drift alone → manual investigation (probably `bin/task reset N` or a real
`bin/task verify N` against a live runtime).

## Flag reference

| Flag | What |
|---|---|
| `--show-drift` | Run drift detection, print markdown table, exit. No proposal written, no LLM calls. |
| `--allow-dirty-spec` | Generate the proposal against the working-tree `spec.md` instead of HEAD. `generated_against_sha` is written as `WORKING_TREE`. |
| `--confirm-batch` | Proceed despite >10 commits having accumulated on `spec.md` since last sync. Large batches degrade classifier accuracy. |
| `--apply` | Parse `.scaffold/sync-proposal.md`, apply accepted changes, write `tasks.json`, commit. |
| `--force` | With `--apply`: proceed despite `generated_against_sha` not matching HEAD. Use only when you understand the spec has moved since the proposal was generated and you accept the staleness. |

Tunable via env vars:

- `SCAFFOLD_BATCHED_SYNC_THRESHOLD` — integer, default 10. Raises or lowers
  the batched-sync-debt threshold.

## Design principles

These aren't code comments; they're the contract `sync` offers.

### Completed tasks are immutable

Every sync iteration preserves built work. Changes affecting completed
tasks become new pending tasks that depend on them. This means:

- `git log` shows a linear history even after many sync iterations
- `runbook.md` keeps growing; nothing rewrites prior entries
- Telemetry files for completed tasks stay where they are
- `Task N: Title` commit messages remain meaningful forever

### Provenance + confidence per change

Every change block carries:

- `provenance.spec_diff_hunk` — the exact `git diff` hunk that triggered the
  classification. Operators can always see "this change came from these
  three lines of spec."
- `confidence: high | medium | low` — the classifier's honest self-report
- `provenance.double_sample_agreement` — for medium/low-confidence entries
  that were re-sampled with a critic pass: `full` (critic agreed),
  `payload-divergent` (critic agreed on classification, different done_when
  or depends_on), `classification-divergent` (critic proposed a different
  bucket — confidence downgraded to `low`, critic's rationale included in
  frontmatter)

The debate synthesis that drove this design flagged "silent classifier
drift" as the P0 risk at iteration 10. Provenance + confidence + double-
sampling are the three guardrails against it.

### Two-signal rule for deprecation

Deprecation is the only classification that can cause code to be deleted.
It's subjected to a higher bar:

- A spec hunk that removes a feature, **alone**, is `refinement-noop` +
  advisory note ("spec removed feature X; code still references it — is
  this documentation cleanup or intent?")
- Drift evidence that code no longer references something referenced in
  spec, **alone**, is an advisory note ("task N appears drifted — is this a
  revert or a feature still needed?")
- Both signals firing together → deprecate task generated, flagged in the
  proposal under "requires review"

One signal alone is never enough to delete code.

### Apply-time DAG hygiene

Before writing `tasks.json`, `--apply` runs two checks:

- **Cycle detection** (DFS with color state): refuses to apply if any
  proposed change would create a cycle in the `depends_on` graph. Reports
  the cycle path so you can identify which inject-against-completed block
  is the offender.
- **Transitive reduction**: if Task X has `depends_on: [A, B]` and B already
  transitively reaches A, the direct `X→A` edge is pruned. Keeps the graph
  minimal as sync iterations accumulate. Pruned edges are logged in the
  commit body.

### Dirty-tree policy

`spec.md` with uncommitted changes is rejected by default:

```
spec.md has uncommitted changes. Commit the spec first, or pass
--allow-dirty-spec to snapshot the working-tree content.
```

The anchor written to `tasks.json.last_synced_spec_sha` after `--apply` is a
real git SHA; it's meaningless if HEAD doesn't match what sync saw.
Committing first is the recoverable path. `--allow-dirty-spec` exists for
iteration speed — it writes `WORKING_TREE` as the anchor, which has to be
resolved against the operator's memory at the next sync.

### Batched-sync-debt warning

When >10 commits have landed on `spec.md` since `last_synced_spec_sha`,
sync refuses to run without `--confirm-batch`. The reasoning: classifier
accuracy degrades on large change sets — hunks get under-sampled, the
proposal has too many items to review carefully, and misclassifications
slip through.

The threshold is configurable (`SCAFFOLD_BATCHED_SYNC_THRESHOLD`), but the
path of least resistance should be "sync more often, not less."

## Apply semantics per classification

What `bin/task sync --apply` does for each accepted block:

| Classification | Action |
|---|---|
| `new-task` | Appends to `tasks.json` with `status: pending`, the frontmatter's `target.position` and `depends_on`, and `task_payload` as the task body. Records `sync_provenance: {change_id, classification, spec_sha, spec_diff_hunk}` on the new task. |
| `modify-pending` | Finds the task at `target.position`. Refuses if `status: done`. Overlays `task_payload` fields onto the existing task (never touches `status`, `position`, `sync_provenance`). Appends `sync_provenance.last_modified_by = change_id`. |
| `inject-against-completed` | Same as `new-task`. The `depends_on` edge is what makes this different — it runs after the completed task that it's extending. |
| `deprecate` | Same as `new-task`. Flagged in the commit body as `[deprecation]`. `done_when` should prove absence (route 404, symbol unreferenced). |
| `refinement-noop` | No tasks.json mutation. Logged in commit body as `[noop]`. |

After applying, `--apply`:

1. Runs cycle detection — aborts on any cycle
2. Runs transitive reduction — prunes redundant edges, logs pruned list
3. Writes `tasks.json` with the advanced `last_synced_spec_sha`
4. Deletes `.scaffold/sync-proposal.md`
5. Commits `tasks: sync against spec.md at <short-sha>` with a body
   summarizing applied / rejected / noop counts + pruned edges

## Drift detection

`bin/task sync --show-drift` (and the advisory section in `sync`) run a
**cheap subset** of every completed task's verification primitives against
current code:

| Included probe types | Excluded |
|---|---|
| File scans (`file_exists`, `ui_affordance`, `accessibility`, `authz_wiring`, `audit_text`, `turbo_navigation`, `readiness`, `seed_credentials`) | HTTP probes (`$APP_BASE_URL`) |
| Pure-Ruby checks | `bin/rails` commands (need DB) |
| `command_exits` with shell commands | `npm` / `yarn` test runners |

The exclusion is deliberate: drift detection should be **fast and
runtime-free**. If a completed task's probes all need a live server,
drift detection skips them and says so — the operator runs a real
`bin/task verify N` against a live runtime for full-fidelity audit.

Drift alone never generates a task. It's a prompt for investigation.

## Cookbook

Common scenarios and what to do.

### Adding a feature to the spec

```bash
# Edit spec.md, add the feature section
git add spec.md && git commit -m "spec: add team invitations"
bin/task sync
# Open .scaffold/sync-proposal.md — expect one or more new-task blocks
# Accept them (status: accept is default), edit titles/done_when if needed
bin/task sync --apply
# New pending tasks are in tasks.json, ready for the next build pass
./launch-build.sh --auto --batch
```

### Tightening a done_when on a pending task

```bash
# Edit spec.md, refine the language around task 12's behavior
git add spec.md && git commit -m "spec: clarify survey import error states"
bin/task sync
# Expect a modify-pending block targeting position 12
# Verify the proposed done_when matches your intent; edit the JSON if not
bin/task sync --apply
```

### Updating a feature that's already built

```bash
# Edit spec.md — e.g., login should also emit an audit log entry now
git add spec.md && git commit -m "spec: audit login events"
bin/task sync
# Expect an inject-against-completed block depending on the completed
# login task. The proposed new task encodes ONLY the audit-log addition,
# not re-building login.
bin/task sync --apply
```

### Removing a feature

```bash
# Edit spec.md, delete the section describing the feature
git add spec.md && git commit -m "spec: drop legacy SMS notifications"
bin/task sync --show-drift
# Check whether the code still references SMS. If yes, proceed.
bin/task sync
# Expect either:
#   - A deprecate block (spec removed + drift found — two-signal fired)
#   - An advisory note under "refinement-noop" if code already doesn't
#     reference the feature (documentation cleanup only)
# For a deprecate block, verify the done_when proves absence (route 404,
# symbol not referenced). Edit if too weak or too strong.
bin/task sync --apply
```

### Undoing a sync

```bash
# You ran --apply, don't like the result, spec hasn't changed further:
git reset --hard HEAD~1        # drops the sync commit + its tasks.json changes
# tasks.json is back to pre-sync state; .scaffold/sync-proposal.md is gone
# If you want the proposal back: `bin/task sync` regenerates it
```

Note: `git reset --hard` is destructive and requires confirmation. It's the
safest undo because sync always writes its own commit — you're dropping
exactly what sync added, nothing more.

## Known failure modes

### "Proposal is stale"

`--apply` reports `generated_against_sha` doesn't match current HEAD. This
fires when the spec has moved between `bin/task sync` and `bin/task sync
--apply`.

Two fixes:
- **Recommended**: delete `.scaffold/sync-proposal.md`, re-run `bin/task
  sync`. The new proposal sees the full current diff.
- `--force`: apply the stale proposal anyway. Rare, breaks the
  recoverability property. Usually wrong.

### "Refusing to apply: would introduce a cycle"

The DAG hygiene check detected a cycle in the proposed graph. Cycle path is
printed. Cause is almost always an `inject-against-completed` block whose
`depends_on` creates a loop with a task that transitively depends on the
injected position.

Fix: edit the offending block's `target.depends_on` to remove the
back-edge, or `status: reject` that block and re-run.

### Drift flagged after a successful build

A completed task's cheap probes no longer pass. Check what `--show-drift`
reports. Three common causes:

- **Real regression**: later work broke the earlier feature. Run the full
  `bin/task verify N` to confirm, then `bin/task reset N` and re-build.
- **Probe assumption drift**: the task's `done_when` asserted a file path
  or symbol name that has since been refactored. The feature works, but
  the probe is stale. Document this in the runbook and consider updating
  the probe (rare).
- **Code intentionally removed**: the feature was deprecated cleanly but
  the original task's probes weren't updated. This is what sync's two-
  signal deprecation flow is supposed to catch — if it didn't, the
  deprecation happened outside of sync and the task just needs to be
  `bin/task reset`-ed.

### "Classifier returned no changes"

The spec diff exists, but every hunk was classified `refinement-noop` and
`--skip-empty` skipped emitting the proposal. The classifier read your
changes as purely editorial.

If you disagree: re-run with stronger signal — commit the spec change with
a clearer message, or manually add a task with `bin/task split` against the
relevant existing task.

## See also

- [Main README](../README.md) — what scaffold is, how initial builds work
- [`templates/bin/task`](../templates/bin/task) — the command implementation
- [`templates/lib/scaffold_task/sync_proposal.rb`](../templates/lib/scaffold_task/sync_proposal.rb) — proposal parser/writer
- [`templates/lib/scaffold_task/sync_classifier.rb`](../templates/lib/scaffold_task/sync_classifier.rb) — classifier + critic prompts
- [`templates/lib/scaffold_task/drift.rb`](../templates/lib/scaffold_task/drift.rb) — drift detection
- [`templates/lib/scaffold_task/dag_hygiene.rb`](../templates/lib/scaffold_task/dag_hygiene.rb) — cycle detection + transitive reduction
