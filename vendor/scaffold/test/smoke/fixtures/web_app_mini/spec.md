# 1. Overview

> A lightweight coaching workspace where leadership coaches manage clients,
> log session notes, and share curated recommendations through a web portal.

## Primary User Stories

- As a coach, I sign in to a dashboard showing my active clients as a grid of cards.
- As a coach, I open a client profile to see notes history, focus areas, and shared resources organized in tabs.
- As a coach, I add a session note tied to a client, tag it with a focus area, and optionally share it with the client.
- As a client, I sign in to my portal, read shared notes, and mark them reviewed.
- As a coach, I invite a new client by email; the client follows a link to set a password.

## Data Model

- **Coach**: id, email, password_digest, name, timezone.
- **Client**: id, coach_id, email, name, archived_at, invited_at.
- **SessionNote**: id, client_id, coach_id, body (rich text), shared_at, focus_area_id.
- **FocusArea**: id, client_id, title, status (active/archived).

## Surfaces

- Browser-based web app with mobile-responsive layouts.
- Portal pages for clients with restricted write access.
- Email delivery via SMTP, with a dev-friendly Letter Opener fallback.

## Verification

- Coach can sign up, invite a client, and confirm the client lands in their portal.
- Notes flagged private to the coach never appear in the client portal.
- Audit log records every note share / revocation action.
