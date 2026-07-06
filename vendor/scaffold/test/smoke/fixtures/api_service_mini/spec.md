# 1. Overview

> A JSON REST API for an internal billing reconciliation service. No frontend.
> Consumers are other backend services and operations tooling.

## Endpoints

- `POST /invoices` — create an invoice, returning 201 with the created record.
- `GET /invoices/:id` — fetch one invoice, returning 200 or 404.
- `GET /invoices` — list invoices with pagination (`?page=N&limit=M`).
- `POST /invoices/:id/reconcile` — mark invoice reconciled; returns 200 with updated state.
- `POST /webhooks/stripe` — receive Stripe webhook events, verify signature, persist.

## Auth

- Bearer token in `Authorization` header. Tokens issued out-of-band by ops.
- Every endpoint requires auth except `/health`.
- Unauthenticated requests return 401 with a JSON error body.

## Data Model

- **Invoice**: id, amount_cents, currency, status, stripe_customer_id, reconciled_at.
- **Event**: id, invoice_id, kind, payload (jsonb), received_at.

## Verification

- `POST /invoices` with a valid token returns 201 and a JSON body with `id`.
- `POST /invoices` without a token returns 401.
- Stripe webhook with a bad signature returns 400; valid signature returns 200 and persists an Event.
