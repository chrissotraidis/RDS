# rds-secrets-broker

Use this skill whenever a build mentions API keys, OAuth, payments, webhooks, email, storage, deploy credentials, private databases, or third-party services.

Implementation contract:
- Never hardcode real credentials in source files, prompts, logs, generated docs, screenshots, or examples.
- Record required variable names, not values.
- Prefer explicit names such as `STRIPE_SECRET_KEY`, `RESEND_API_KEY`, `POSTHOG_PROJECT_API_KEY`, or stack-specific equivalents.
- If a secret is missing, implement a safe disabled/pending state with a clear message.
- Do not fake successful integration with placeholder credentials.

Expected build artifacts:
- `.env.example` or equivalent lists required variable names with empty values.
- The build notes state which secrets are required for production behavior.
- Runtime code reads from environment variables or managed service config.
- Webhook skills include signing-secret requirements where applicable.

Verification:
- Search generated files for suspicious literal tokens before approval.
- Confirm missing secrets fail closed or degrade gracefully.
- Confirm docs tell the operator where credentials must be configured.

Sources:
- Zo docs: https://docs.zocomputer.com/
