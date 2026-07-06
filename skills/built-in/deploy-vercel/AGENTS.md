# deploy-vercel

Vercel deployment contract for Next.js.

Applies to: nextjs-fullstack
Category: deploy
Maturity: stable
RDS readiness: guide materialization + verify hook

Use when:
- The PRD explicitly asks for deploy behavior, or the selected stack commonly needs this capability.
- The capability changes implementation, verification, deploy posture, or operator handoff.
- The build needs source-linked guidance rather than an ad hoc package install.

Implementation contract:
- Match the selected stack conventions and avoid adding a parallel framework style.
- Name the generated files, commands, environment variables, and artifacts affected by this skill.
- Keep user-visible behavior inspectable in the RDS preview when possible.
- Treat external accounts, paid services, store submission, and private credentials as human-gated unless the PRD explicitly says they are configured.
- Avoid broad dependencies unless the PRD clearly needs them.

Verification:
- Run or document the skill verify hook: `bin/rds-skill-verify deploy-vercel`.
- Verify the primary user-visible or operator-visible affordance, not just package installation.
- Record blockers clearly when credentials, native devices, external stores, or optional CLIs are unavailable.
- Leave enough notes for `rds-fix` or a later builder to continue without rediscovering the context.

Source references:
- vercel.com: https://vercel.com/docs
