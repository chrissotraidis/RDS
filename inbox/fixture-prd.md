# Dockside Meal Planner — Brown-Field Fixture PRD

> Fixture PRD used to smoke-test the **brown-field** path. Pair this with a
> pre-existing Rails repo — see the "Fixture repo" note at the bottom.
>
> This PRD assumes the app already has a minimal skeleton and asks
> Scaffold to **continue** the build by adding the operator cook-list
> screen.

## 1. Context

Dockside Kitchen has an in-progress Rails 8 app (see fixture repo below).
The customer magic-link ordering flow is complete. What remains is the
**operator cook list** — the Friday-morning screen that tells the operator
what to cook.

## 2. What this PRD adds

### 2.1 `/cook` (operator-only)

- Route: `GET /cook`
- Controller: `Cook::DashboardController#index`
- Auth: `operator_required` before-action (already present in the app).
- Query: all `Order` records in the current week (`Time.current.beginning_of_week..end_of_week`) with `status: :paid_deposit`.
- Group by meal; for each meal show:
  - Meal title.
  - Total headcount across all orders.
  - Per-boat breakdown: customer name, headcount, any notes.
- Button: "Export shopping list (PDF)" → `POST /cook/shopping_list` that
  emails the PDF to the operator's email address using `CookMailer`.

### 2.2 Shopping list PDF

- Prawn gem (already in Gemfile).
- One row per ingredient, quantity aggregated across all orders for the
  week.
- Each recipe has an `ingredients` text field; parsing is deliberately
  naive — split on newlines, assume the first token is a quantity. The
  operator will clean up by hand.

### 2.3 Acceptance criteria

- [ ] `/cook` redirects to `/operator/sign_in` for non-operators.
- [ ] With 3 orders across 2 meals in the current week, `/cook` shows
      both meals grouped, with correct totals.
- [ ] Clicking "Export shopping list" triggers a background job that
      sends an email with a PDF attachment to the signed-in operator.
- [ ] Feature test in `test/system/cook/dashboard_test.rb` covers the
      happy path.

## 3. Out of scope

- No customer-facing changes.
- No mobile navigation changes — the operator view is desktop-only
  for V1.
- No accessibility pass yet; add to the backlog.

## 4. Fixture repo

The brown-field smoke test runs against a bare git repo built on demand
from the RDS-owned Rails starter. To build it:

```
./fixtures/build-fixture-repo.sh
```

This produces `fixtures/fixture-brown-field-repo.git/` (~12 MB,
gitignored). The build script is committed to RDS; the bare repo itself
is not — that keeps the RDS repo small.

The smoke-test invocation:

```
./bin/rds-build \
    --repo="file://$(pwd)/fixtures/fixture-brown-field-repo.git" \
    --prd=./inbox/fixture-prd.md \
    --deploy-target=none
```

Pre-populated content from the Rails starter:
- A neutral Rails 8 app skeleton.
- RDS/Zo-compatible database, health, host, and setup defaults.
- The non-interactive setup path used by `bin/rds-rails-init`.

Domain models referenced by this PRD (`Order`, `Customer`, `Boat`,
`Meal`, the operator Devise scaffold, the Stripe webhook stub) do **not**
exist in the seeded fixture. They're what Scaffold is asked to build
during the smoke test — exercising the brown-field "continue building"
path against an in-progress codebase. If a fuller pre-existing app is
preferred, override with `--repo=https://github.com/<org>/<repo>.git`.

## 5. Build-time assumptions

- No seed data migration needed — existing fixtures in `test/fixtures/`
  cover the cook-list scenario.
- No new gems beyond what the fixture repo already has.
- Scaffold's task-generation step should produce fewer than 10 tasks
  for this PRD; if it produces more, the PRD was misread.
