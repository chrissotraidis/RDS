# rds-context7-mount

Use this skill when the build depends on current framework behavior. Its job is to stop the builder from guessing from stale framework memory.

Implementation contract:
- Identify the selected stack from `build.yaml`.
- Record the framework docs the build depends on before implementation starts.
- Prefer official docs and stable versioned docs over blogs or forum answers.
- Keep the docs list short: primary framework, router/runtime, deploy target, and one relevant library if the PRD requires it.
- If a requested library has breaking recent changes, note the version assumption in the build brief.

Expected build artifacts:
- `build.yaml` includes `rds-context7-mount` in `skills_resolved`.
- The app has `.rds/skills/rds-context7-mount.md` and `.rds/skills/rds-context7-mount.yaml`.
- The build brief or implementation notes name the docs used for the chosen stack.

Verification:
- Confirm the selected stack has at least one external source link in the stack guide.
- Confirm no implementation plan relies on undocumented framework behavior.
- If docs cannot be mounted directly, write a clear pending note instead of pretending live Context7 context was available.

Sources:
- Context7: https://context7.com/
- Context7 GitHub: https://github.com/upstash/context7
