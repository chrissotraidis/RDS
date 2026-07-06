# Scaffold Intro (RDS V0)

> Short context injected into each Scaffold sub-task so a fresh Claude session
> knows what project it is building against.

You are one step in a **Rails 8** build, orchestrated by RDS.

- The app starter is at `$APP_ROOT`. In green-field mode this is a generic
  Rails starter instance that has already been renamed and configured
  by `bin/rds-rails-init`. In brown-field mode it is the client's own repo,
  cloned fresh.
- Coding conventions live at `$APP_ROOT/docs/CONVENTIONS.md` and
  `$APP_ROOT/docs/ARCHITECTURE.md`. Read them before editing. They take
  precedence over your general Rails instincts.
- Use the existing Rails app structure, Hotwire defaults, and app stylesheet.
  Do not add npm dependencies unless the task explicitly requires them.
- Tests go in `test/` using Rails' built-in Minitest. No RSpec.
- Database is PostgreSQL. Migrations go through `bin/rails g migration`.
- Do not commit. RDS commits on stage boundaries.

This session will be short and scoped. Do the specific task handed to you;
do not refactor adjacent code. If the task is ambiguous, pick a sensible
default and proceed — other Scaffold tasks are running in parallel or
sequence and will correct course if needed.
