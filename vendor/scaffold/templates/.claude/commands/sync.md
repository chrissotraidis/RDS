Run `bin/task sync` to produce a sync proposal for spec changes, or review an existing one.

Workflow:

1. If `.scaffold/sync-proposal.md` does not exist yet, run `bin/task sync` to generate it. Report any errors from the dirty-spec gate or batched-sync warning back to the user.

2. If the proposal now exists (or already did), read it and summarize:
   - How many changes in each classification (new-task, modify-pending, inject-against-completed, deprecate, refinement-noop)
   - Highlight any change blocks with `confidence: low` or `provenance.double_sample_agreement: classification-divergent` — those are the highest-uncertainty entries the operator should review first
   - If a `## Drift detected` section is present at the tail, call out which completed tasks have drift

3. Do NOT auto-apply. The operator reviews the proposal file directly (editing `status:` fields), then runs `bin/task sync --apply` themselves. Your job here is to summarize, not to accept on their behalf.

4. If the user asks you to review specific change blocks, read them and give a short assessment — does the classification seem right given the spec_diff_hunk? Is the proposed done_when observable? Do the depends_on edges make sense?

Never run `bin/task sync --apply` unless the user explicitly asks for it by that phrasing.
