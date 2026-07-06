# Project

RDS is early, single-operator infrastructure moving toward a public,
self-hostable build workshop for agentic product development on a dedicated
VPS or Zo-like personal server.

## Maturity

- Designed and verified for one trusted operator on one persistent host.
- Public source, private runtime data: builds, uploads, chat, and secrets stay
  out of the repository by design.
- Not a multi-tenant SaaS control plane and not trying to become one soon.

## Roadmap

### Near Term

- Keep fresh-clone verification clean for public users.
- Harden dashboard upload and file-serving paths.
- Document the built-in skills registry and stack-selection model.

### Product Quality

- Strengthen PRD-derived scenario generation.
- Add richer business-state assertions for non-trivial workflows.
- Make skill efficacy evidence more explicit.
- Keep readiness machine-checkable instead of label-driven.

### Operations

- Improve backup and migration guidance for `builds/`, `inbox/`, dashboard
  chat, events, and generated apps.
- Keep Zo as a first-class host while avoiding hardcoded instance details.
- Make VPS setup clearer for non-Zo operators.

### Later

- Split the dashboard server into smaller route/render/state modules.
- Improve safe concurrency beyond one build at a time.
- Add stronger multi-user auth only if the project direction requires it.
- Expand deploy targets after the Zo/VPS path is stable.

## Change History

Git history is the canonical changelog. Release notes will accompany tagged
releases once the project starts tagging them.

## Contributing

Contributions should preserve the core contract: one trusted operator can turn
a PRD/repo handoff into a running app with inspectable evidence and explicit
human approval.

Development rules:

- Keep generated apps, build outputs, dashboard chat, uploads, `.env`, logs,
  and local runtime state out of commits.
- Prefer small, verifiable changes over broad rewrites.
- Update docs when changing pipeline behavior, stack behavior, dashboard launch
  semantics, or quality gates.
- Do not fetch latest vendored component code at build time. Import and verify
  vendored updates explicitly.
- Treat deploy, merge, push, publish, and approval as human-gated actions.

Useful checks:

```bash
./bootstrap/verify.sh --fresh-clone
./bootstrap/verify.sh
./bin/rds-selftest
```

When changing QA, taste review, readiness, stack defaults, or skill resolution:

```bash
./bin/rds-autonomy-fixture
./bin/rds-quality-fixtures --keep-going
```

## Security

RDS is designed for a trusted single operator on a dedicated host. It is not a
multi-tenant SaaS control plane.

Supported model:

- run RDS on infrastructure you control;
- set `RDS_DASHBOARD_PASSWORD` so the built-in Basic Auth gate is active;
- set `RDS_DASHBOARD_TOKEN` for mutating dashboard actions;
- keep `.env`, build artifacts, uploaded source, logs, dashboard chat, and
  generated apps out of the public repository;
- treat public preview services as review artifacts, not hardened production
  deployments.

Not supported yet:

- multi-user roles or permissions;
- untrusted public dashboard access;
- concurrent builds from multiple operators;
- automatic approval, merge, publish, or production deploy without human
  review.

Report vulnerabilities through a GitHub security advisory or private issue.
Include affected commit/version, reproduction steps, expected versus actual
behavior, and whether the issue requires dashboard access, shell access, or only
network access.
