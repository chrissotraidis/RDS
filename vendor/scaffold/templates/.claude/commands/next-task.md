Read CLAUDE.md for the full project context, conventions, and validation rules.

Execute ONE task only:

1. Run `bin/task next` to get the next eligible task.
2. If no tasks available, report status and stop.
3. Run `bin/task start {position}`.
4. Run `bin/task prepare {position}` to generate the task bundle.
5. Run `bin/task dossier {position}` and read its output end-to-end. The dossier is the consolidated per-task context — done_when, workflow gates, predecessor runbook in dependency-closure order, wiki entity excerpts + risk flags, implementation guidance, verification commands. Prefer this over re-reading spec.md / runbook.md / wiki-index.json by hand; the dossier has already sliced those for this task.
6. Implement the task so `done_when` is observably true through normal user flows.
7. Run `bin/task verify {position} --skip-runtime-deps` and fix any static failures.
8. Commit: `git add -A && git commit -m "Task {position}: {title}"`.
9. Run `bin/task done {position}`.
10. Stop after this one task. Do not edit `runbook.md` manually; the harness owns it.
