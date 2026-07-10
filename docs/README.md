# RDS Documentation

Start with the root [README](../README.md) for what RDS is and how to install
it. `AGENT.md` at the repo root is the operating contract for the coding agent
that drives RDS through chat.

## Understanding the System

| Doc | Read it for |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Why RDS exists, subsystem ownership, runtime data layout, state model, deployment model. |
| [PIPELINE.md](PIPELINE.md) | Stage-by-stage build behavior: gates, evidence, QA, deploy, recovery. |
| [COMPONENTS.md](COMPONENTS.md) | Vendored component inventory, upgrade workflow, third-party notices. |
| [STACKS_AND_SKILLS.md](STACKS_AND_SKILLS.md) | Stack manifests, skill catalog, and how New Build selects them. |
| [AUTONOMY.md](AUTONOMY.md) | Goal Mode (evidence-driven repair loop) and Agent Sessions (operator-controlled Claude/Codex workers). |
| [DASHBOARD.md](DASHBOARD.md) | Page-by-page map of the operator console, auth model, local dev quickstart, smoke test. |
| [DESIGN.md](DESIGN.md) | The dashboard's visual language: tokens, color discipline, typography, motion. |

## Operating RDS

| Doc | Read it for |
|---|---|
| [RUNNING_ON_ZO.md](RUNNING_ON_ZO.md) | Host model and full setup checklist for Zo or a Zo-like VPS. |
| [CHAT_CONTRACT.md](CHAT_CONTRACT.md) | Operator chat phrases and the exact actions they trigger. |
| [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | Common failures, diagnosis commands, recovery paths. |

## Project

| Doc | Read it for |
|---|---|
| [PROJECT.md](PROJECT.md) | Maturity, roadmap, contributing rules, security model, change-history policy. |
