Read CLAUDE.md for the full project context, conventions, and validation rules.

**Before starting the loop:** check whether `.scaffold/sync-proposal.md` exists. If it does, stop and tell the user:

> ⚠️ A sync proposal is pending at `.scaffold/sync-proposal.md`. Tasks from that proposal are not yet in `tasks.json`, so /build will skip them. Run `bin/task sync --apply` to accept the proposal (or delete the file to discard), then re-run /build.

Do NOT proceed with the build loop when a pending proposal exists. The user needs to decide first.

---

You are running in continuous build mode. Execute this loop until all tasks are done:

1. Run `bin/task next` to get the next eligible task. If no more, report final status and stop.
2. Run `bin/task start {position}`.
3. Run `bin/task prepare {position}` to generate the task bundle.
4. Run `bin/task dossier {position}` and read its output end-to-end. The dossier has already sliced the spec, runbook, and wiki for this task's needs — prefer it over re-reading those files by hand.
5. Implement the task so `done_when` is observably true through normal user flows.
6. Run `bin/task verify {position} --skip-runtime-deps`. Fix any static failures.
7. Commit: `git add -A && git commit -m "Task {position}: {title}"`.
8. Run `bin/task done {position}`.
9. Loop back to step 1.

Do not edit `runbook.md` manually; the harness appends runbook entries after verification passes.

Report a concise summary after each task: position, title, status, any issues.
