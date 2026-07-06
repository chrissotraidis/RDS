# patches/

Unified-diff patches applied to vendored components by `bootstrap/install.sh`.

Patches live here (not upstream) because:

1. RDS must work without waiting on upstream PR merges.
2. Vendored components may move faster than our integration can tolerate.
3. The PRD (Section 3 — Non-Goals) explicitly says no upstream contributions
   for V0.

## How patches are applied

`bootstrap/install.sh` iterates over `patches/*.patch` and runs, from the repo
root:

```bash
git apply --check <patch> && git apply <patch>
```

If the patch is already applied (detected via `git apply --reverse --check`),
install.sh skips it silently. If it does not apply cleanly, install.sh warns
and continues — re-vendoring the target component usually fixes this.

## Current patches

No component patches are required right now. The Rails starter owns its
non-interactive `bin/template-setup` script directly.

## Anti-goals

- Patches here must be **small** and **idempotent**. Large modifications
  belong upstream.
- Patches must not depend on RDS-specific config at the script level. They
  expose knobs (flags, env vars); RDS scripts decide how to use them.
