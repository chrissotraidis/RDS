Run `bin/task status` and provide a concise summary:

- How many tasks are done, pending, in progress, errored
- Which task is next (if any)
- Any blocked tasks and what they're blocked on
- Recent git log (`git log --oneline -5`) for context

Also check whether a sync proposal is pending: if `.scaffold/sync-proposal.md` exists, flag it with a note like:

> ⚠️ A sync proposal is pending at `.scaffold/sync-proposal.md`. Tasks from that proposal are NOT in `tasks.json` yet — review the file and run `bin/task sync --apply` before starting a batch, or delete it to discard.

Do not attempt to read or interpret the proposal unless the user asks.
