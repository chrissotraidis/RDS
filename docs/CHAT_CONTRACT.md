# Chat Contract

> What the operator says → what the RDS agent does. Every pattern here must
> be recognized by AGENT.md-driven Claude Code. If a chat pattern doesn't
> match any row here, AGENT.md §3.3 applies — ask the operator for clarification.

## Build triggers

| Operator says | RDS agent does |
|---|---|
| *"Build the thing from `<Notion URL>`"* | **Green-field.** Fetch the page via Notion MCP → write to `inbox/research-<slug>-<ts>.md` → run `./bin/rds-build <path>`. |
| *"Build from `inbox/foo.md`"* | **Green-field.** Verify the path → run `./bin/rds-build inbox/foo.md`. |
| *"Pull down `github.com/<org>/<repo>` and build per `<PRD source>`"* | **Brown-field.** Normalize repo URL → pre-fetch Notion PRD if needed → run `./bin/rds-build --repo=<url> --prd=<source>`. |
| *"Work on `<repo URL>` based on this PRD: `<Notion URL>`"* | **Brown-field.** Same as above. |
| *"Continue `<repo>` on the `develop` branch per `<PRD>`"* | **Brown-field.** Pass `--branch=develop`. |

Stack and skill hints are allowed in the same trigger. If the operator says
`stack=web-3d`, `use mobile-native`, or `with rds-usd-validator`, pass the
corresponding `--stack=<slug>` and `--skills=<slug,...>` to `bin/rds-build`.
If the operator does not specify skills, leave the default V1 skill set enabled.

## Dashboard New Build trigger

The `/new` dashboard page is the preferred trigger when the operator has a PRD or
brief but has not already chosen a stack. The current flow is:

1. Paste or attach the PRD/brief/source first.
2. The page remains neutral until there is source input. It does not preselect
   Rails or any other stack on load.
3. RDS analyzes the source with the shared backend analyzer and recommends:
   - stack;
   - confidence;
   - clarification questions;
   - core ready RDS skills.
4. Text uploads (`.md`, `.markdown`, `.txt`) are imported into the PRD field
   for analysis when possible. PDF uploads are extracted server-side for
   stack/skill analysis and still attached to the generated build input.
   Images remain attachments that the backend includes in the generated build
   input.
5. The operator can accept the recommendation or override stack/skills manually.
6. The page submits to `POST /new`, which calls `bin/rds-start` with
   `--stack`, `--skills`, `--provider`, `--claude-model`/`--codex-model`,
   `--app-type`, source fields, and deploy target.

`POST /new` requires an explicit stack. If the page has not analyzed source
input and the operator has not manually chosen a build type, it returns a
validation error instead of defaulting to Rails.

The New Build recommendation is deliberately deterministic and cheap. It is
not a substitute for AGENT.md stack detection inside a chat-triggered build;
it is a pre-launch review step so the operator can catch "wrong stack / wrong skills"
before spending a full build.

New Build starts from the core ready RDS skills:

- `rds-context7-mount`
- `rds-mockup-fidelity`
- `rds-secrets-broker`

It now auto-adds ready specialized skills when the PRD and selected stack justify
them: browser QA, Vitest/Playwright tests, Postgres context, Better Auth,
PostHog analytics, Sentry/OpenTelemetry, eval harnesses, USD/glTF validation,
shadcn/ui, Stripe payments, Resend email, Solid Queue jobs, S3/R2 storage,
Vercel AI SDK, Pydantic AI, or pgvector. Curated skills remain manual. The
Skills Catalog shows every ready skill guide with source links, stack fit, and
rationale. External credentials and human release steps remain explicit in the
guide for skills such as payments, app stores, and external deploys.

Builder provider controls are mutually exclusive. When Claude is selected,
Codex model controls are hidden, disabled, and not submitted. When Codex is
selected, Claude model controls are hidden, disabled, and not submitted.

## Agent Session intents

Build chat recognizes worker-launch phrasing such as:

- `Start a Claude worker to fix this.`
- `Start a Codex worker to review the diff.`
- `Launch Claude Code agent session for this build.`

RDS responds with a confirmation-gated **Start worker** action card inside the
same build chat. Confirming
the card calls `bin/rds-agent-start`, creates an isolated git worktree, starts a
tmux-backed provider session, and records metadata under
`builds/<id>/agent-sessions/`.

Chat must not launch, stop, discard, hand off, merge, or review an agent session
from model text alone. Every mutating action requires the dashboard token and an
explicit confirmation value.

`/agents` is a monitoring and review surface for sessions after they exist; it
does not expose separate Claude/Codex launch buttons.

## Status and inspection

| Operator says | RDS agent does |
|---|---|
| *"Status?"* / *"How's the build?"* | Read the latest `builds/*/state.json`, summarize in 2–5 lines. Include mode (green-field / brown-field) and the current stage. |
| *"How's the Acme build going?"* | `bin/rds-status --slug=acme` → summarize. |
| *"Show me the logs"* | Tail the current stage's log file (`builds/<id>/logs/<stage>.log`). |
| *"Show PO questions"* | Print `builds/<id>/po-questions.md` if it exists. Say so if it doesn't (green-field only). |
| *"Preview URL?"* | `cat builds/<id>/preview-url.txt`. |
| *"What version of RDS am I on?"* | `cat .rds-installed`. |
| *"What was that client's repo / PRD?"* | Read `builds/<id>/state.json` and (brown-field) `builds/<id>/app/.rds/provenance.json`. Include repo URL, branch, commit SHA, clone timestamp. |

## Control

| Operator says | RDS agent does |
|---|---|
| *"Tear down the preview"* | Run `./bin/rds-deploy --build-id=<current> --target=teardown`. (V0 RDS extension — `none` means "skip deploy, leave running, localhost preview", per PRD §6.12 + §15.4.) |
| *"Retry the last stage"* | Re-run only the failed stage (i.e. the underlying `bin/rds-*` script) against the same `$BUILD_DIR`. Do not re-run earlier stages that already succeeded. |
| *"Start over"* | Archive the failed build dir (`builds/<id>/` → `builds/<id>.failed-YYYYMMDD/`) and start a new build from the same trigger. |
| *"Pause the build"* | Use the dashboard pause action or run `bin/rds-pause <build-id>`. This kills the active runner, marks `state.json.status="paused"`, resets the active stage to `pending`, and leaves the build resumable. |
| *"Stop the build"* | Run `bin/rds-stop <build-id>` after confirmation. This is a harder cancellation path than pause and should not be used when the operator only wants to resume later. |

## Build-scoped dashboard chat actions

These patterns apply inside a build's dashboard chat panel, where the
dashboard can identify the build id from the current page.

| Operator says | RDS does |
|---|---|
| *"Make the paddle faster"* / *"Fix the mobile layout"* / *"Change the scoring to 21"* | Show a confirmation-gated **Iterate app** action card. If confirmed, run `bin/rds-iterate <build-id>` with the requested change. The command patches only the generated app, runs checks + QA, and redeploys only after green verification. |
| *"Run QA again"* / *"Check it in Playwright"* | Show a confirmation-gated **Run QA** action card. If confirmed, run the build QA path and write an action-run record. |
| *"Redeploy this"* / *"Push it back to Zo"* | Show a confirmation-gated **Redeploy** action card. If confirmed, redeploy the current generated app and write an action-run record. |
| *"Approve this build"* / *"Looks good, approve it"* | Show a confirmation-gated **Approve build** action card. If confirmed, run `bin/rds-approve <build-id>` and write an action-run record. |
| *"Delete the Zo service"* / *"Take it offline"* | Show a confirmation-gated **Delete Zo service** action card. If confirmed, run `bin/rds-zo-deregister` for only the recorded service id, then clear the preview URL only after deletion is verified. |

Confirmed actions write durable records under
`builds/<id>/actions/action-*.json`. Chat action cards hydrate from those
records, show current status/phase, and keep polling while queued or
running. When an action completes, the chat appends exactly one final RDS
summary with outcome, phase/exit code, summary file, preview URL, latest
QA signal, and iteration diff/review pointers when available.

Dashboard chat is real-time where the browser supports EventSource. Each
thread exposes `/chat/sessions/<id>/stream`, which emits the current session,
pending reply text, action status, and build context as server-sent events.
The JSON files in `dashboard/chat/` remain the durable source of truth; polling
is only a fallback for reconnects or unsupported clients.

Build-scoped chat accepts file and screenshot attachments. Uploaded files are
persisted under the build's `chat-attachments/` directory and attached to the
visible user turn. The same attachment list is injected into ordinary RDS chat
prompts and into confirmed iteration prompts, so visual feedback, screenshots,
PDFs, source snippets, and small bundles become first-party evidence for the
next repair pass instead of disappearing into browser state.

Chat must not silently mutate a build from model output. Every write,
QA rerun, redeploy, approval, or service deletion path stays
confirmation-gated.

## Non-matches

If the operator's message doesn't match any pattern — for example *"can you add
a second staging URL?"* or *"tell the client the build is slow"* — do not
guess. Ask the operator what they want. V0 does not take ad-hoc actions outside
the pipeline.

## Edge cases worth memorizing

- **Mode is ambiguous** (e.g. a repo URL with no PRD). Ask the operator.
- **Notion URL in brown-field mode.** Fetch to `inbox/prd-<reposlug>-<ts>.md`,
  then pass the local path as `--prd=`.
- **Notion URL in green-field mode.** Fetch to `inbox/research-<slug>-<ts>.md`,
  then pass as the positional argument.
- **`.md` path referenced by name only.** Resolve relative to the RDS
  repo root.
- **Private client repo.** RDS does not manage git credentials — assume
  the Zo shell can clone. If it can't, say so.
- **The operator asks for a summary while a build is running.** Summarize from
  `state.json` and recent log tails. Do not block waiting for the build.
- **Build finishes while the operator is asking.** Reply with the final summary
  anyway; that's what he's asking for.

## Voice

AGENT.md §10 and §11 specify terse, factual replies. Include concrete
numbers (elapsed minutes, current stage, URL) and avoid narrating your
reasoning. The RDS agent is the operator's build system, not a chatty assistant.
