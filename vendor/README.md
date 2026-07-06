# vendor/

Third-party components that RDS orchestrates. Treat these as imported component
copies, not runtime scratch space. RDS does not fetch upstream code during a
build; it uses whatever is checked into `vendor/` when the build starts.

For the component contract, upgrade impact, and "what changes affect existing
builds" matrix, read `docs/COMPONENTS.md` first.

## What's here

| Directory | Upstream | Role in RDS |
|---|---|---|
| `scaffold/` | RDS-owned vendored copy | Stage 4 — turns a spec into a running Rails app build plan and executes it. |
| `wiki/` | vendored in this repo | Stage 2 (green-field only) — turns a research document into a Scaffold-compatible spec. Loaded as a Claude Code plugin. |
| `rails-starter/` | stock Rails 8.1.2 plus RDS/Zo setup | Stage 3 (green-field only) — the starter Rails 8 app that Scaffold builds on top of. |

## How it was vendored

RDS V0 can use `git subtree` when an upstream component repository is available:

```bash
git subtree add --prefix=vendor/scaffold \
    <component-repo-url> main --squash
```

If `git subtree` is not available on the build machine (or if RDS is being
bootstrapped offline), the directories are shipped as plain copies with their
`.git/` directories stripped. In that case, the `versions.lock` records the
source commit as `copied-from-local` rather than a real SHA. See
`config/versions.lock` for the current state.

## How to update a vendored component

With subtrees:

```bash
git subtree pull --prefix=vendor/scaffold \
    <component-repo-url> main --squash
```

Then re-run `./bootstrap/install.sh` so that any patches under `patches/`
re-apply to the fresh upstream code. Bump `config/versions.lock` to the new
commit SHA.

Without subtrees (plain copies):

1. Re-clone upstream to a scratch dir.
2. `rsync -a --exclude='.git' <scratch>/ vendor/<component>/`.
3. Re-run `./bootstrap/install.sh`.
4. Update `config/versions.lock`.

## Patches

See `patches/README.md`. Patches under `patches/` are applied to vendored
components by `bootstrap/install.sh`. They are idempotent — re-running
`install.sh` is safe.

## What not to do

- Do not commit ad-hoc edits directly to files under `vendor/`. Either update
  upstream or add a patch.
- Do not rely on `vendor/*/\.git/` — it is intentionally absent. If you need
  git history for a vendored component, run `git log` in the upstream clone.
