# rds-eval-harness

Use this skill when the build includes prompts, inference, recommendations, extraction, ranking, classification, agent behavior, or any output that can regress without a visual change.

Implementation contract:
- Define 3-5 representative fixtures before calling the feature done.
- Include at least one negative/edge case.
- Record expected shape and pass criteria in plain language.
- Prefer deterministic checks for schema, required fields, citations, refusal behavior, and routing decisions.
- Keep model/provider assumptions explicit.

Expected build artifacts:
- `evals/`, `test/fixtures/`, `tests/evals/`, or a stack-native equivalent.
- A one-command check listed in the build notes.
- A short report showing pass/fail for the current run.

Verification:
- Run the eval command or document why credentials/model access block it.
- Confirm failures are visible in the app or build report.
- Do not substitute a generic unit test for an LLM behavior eval.

Sources:
- Ragas: https://docs.ragas.io/
