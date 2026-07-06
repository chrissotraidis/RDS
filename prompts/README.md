# prompts/

Text handed to Claude Code at different points in the RDS pipeline.

These files are **normative content**, not templates — the shell scripts
cat them as-is and append runtime context (file paths, IDs) at the bottom.
Changing the wording here changes Claude's behavior at that stage.

| File | Consumer | When it runs |
|---|---|---|
| `wiki-prd-from-research.md` | `bin/rds-spec` | Stage 2, green-field. Tells the Wiki plugin to produce a Scaffold-compatible spec from a research document, unattended, without blocking on PO questions. |
| `scaffold-intro.md` | `vendor/scaffold/scaffold.sh` (via `--context`) | Stage 4, both modes. Injected into each Scaffold sub-task so a fresh Claude session knows it's building a Rails app against a specific `$APP_ROOT`. |

## Tips when editing

- Target audience is **Claude Code running unattended**. Say what to do,
  what not to do, and how to exit. Do not use ambiguous instructions
  ("if in doubt, ask") — there is no one to ask.
- Keep each prompt short. Long prompts drift. Leave details to the
  reference docs in `$APP_ROOT/docs/`.
- Mention concrete file paths. Claude follows paths more reliably than
  abstract descriptions.
- If a prompt needs runtime values, reference them with `$NAME` and let the
  shell caller append them at the bottom. Do not embed placeholders that
  require sed-style substitution.
