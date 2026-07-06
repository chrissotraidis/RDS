# RDS Skills

RDS skills are built-in capability guides used during stack selection, build
planning, implementation, QA, and deploy/review workflows.

## Layout

```text
skills/
├── registry.json          # generated/curated skill index consumed by RDS
├── catalog/               # catalog metadata
└── built-in/<skill>/      # skill guide, manifest, checks, and references
```

## Status Levels

- `ready`: safe for RDS to recommend or attach when the stack/PRD matches.
- `curated`: researched guidance that is not yet promoted to default use.
- `roadmap`: known future candidate.

## Contribution Rules

- Keep skill docs deterministic and implementation-oriented.
- Include verification hooks when a skill changes runtime behavior.
- Do not commit secrets, account-specific credentials, private screenshots, or
  generated app artifacts.
- Keep stack applicability explicit so New Build does not attach irrelevant
  skills.

Use `docs/STACKS_AND_SKILLS.md` for the full contract.
