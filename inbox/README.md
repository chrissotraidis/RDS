# inbox/

Staging area for inputs to an RDS build.

When the operator drops a file here, or when an agent writes one after
fetching a source document, it becomes available as a trigger for
`bin/rds-build`.

## Naming conventions

RDS does not enforce names, but these are the conventions used by
AGENT.md-driven Claude Code:

- **Green-field research from Notion:**
  `inbox/research-<slug>-<YYYYMMDDHHMMSS>.md`
- **Brown-field PRD from Notion:**
  `inbox/prd-<reposlug>-<YYYYMMDDHHMMSS>.md`
- **Green-field research, hand-dropped:** anything ending in `.md` — the
  operator picks the name.
- **Brown-field PRD, hand-dropped:** anything ending in `.md` — the operator
  picks the name.

## Fixtures shipped with RDS

| File | Purpose |
|---|---|
| `fixture-research.md` | Green-field smoke test. `./bin/rds-build ./inbox/fixture-research.md --deploy-target=none`. |
| `fixture-prd.md` | Brown-field smoke test. Pair with the fixture repo at `fixtures/fixture-brown-field-repo.git/` (see that file's last section). |

## Retention

Files in `inbox/` are not automatically cleaned up. `.gitignore` excludes
ordinary Markdown inputs and attachments by default, while committed fixtures
remain trackable. Do not commit client-confidential inputs.

## What *not* to put here

- Secrets (.env, credentials). Use `.env` at the repo root.
- Large binary blobs — the builds dir is for that.
- Anything outside the green-field or brown-field input formats defined in
  AGENT.md §4 and §5.
