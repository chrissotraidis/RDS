# builds/

Per-build working directories. Every `bin/rds-build` invocation creates
exactly one subdirectory here and writes all its artifacts into it.

## Structure of one build

```
builds/<build-id>/
├── state.json                   # single source of truth for status
├── preview-url.txt              # final public URL (one line)
├── research.md                  # green-field only
├── spec.md                      # green-field (generated) or brown-field (fetched)
├── po-questions.md              # green-field only, optional
├── wiki/                        # green-field only — Wiki workspace
│   └── review/product-owner-questions.md
├── scaffold-out/                # Scaffold's generated build artifacts
│   └── launch-build.sh
├── app/                         # the Rails app being built
│   └── .rds/provenance.json     # brown-field only — records clone source
└── logs/
    ├── intake.log
    ├── spec.log
    ├── rails-init.log
    ├── scaffold.log
    ├── local-run.log
    └── deploy.log
```

## `build-id` format

```
<slug>-<YYYYMMDD-HHMMSS>
```

`<slug>` is derived from:

- Green-field: the research trigger's basename (URL tail or filename stem).
- Brown-field: the repo name.

Override with `--build-id=<custom>` on `bin/rds-build`. The explicit id is
used verbatim.

## Ignored by git

Everything under `builds/` except this file and `.gitkeep` is gitignored.
See the root `.gitignore`.

## Lifecycle

- Created at the start of `bin/rds-build`.
- Grown in place throughout the 6 stages.
- Never deleted automatically. If a build fails and the operator says "start
  over", AGENT.md instructs the agent to rename the dir to
  `<id>.failed-YYYYMMDD/` rather than delete it, so logs survive for
  post-mortem.

V0 does not include a `rds-gc` utility. Cleanup is manual.
