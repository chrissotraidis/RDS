# hotwire-stimulus-generator

Rails Hotwire and Stimulus conventions for server-rendered product UI.

Applies to: rails-web
Category: frontend
Maturity: stable

Use when:
- The selected stack is Rails and the app needs forms, filters, inline updates, modals, tables, drawers, optimistic UI, or small client-side behavior.
- The feature should remain server-rendered instead of introducing a parallel SPA.

Implementation contract:
- Prefer Turbo Frames/Streams and Stimulus controllers over custom fetch-heavy JavaScript.
- Keep controller names, targets, values, and actions explicit and close to the relevant views.
- Preserve Rails form helpers, route helpers, validation errors, and flash/status behavior.
- Keep interactions inspectable in the Zo preview: filters update, forms submit, modals open/close, and empty/error/success states render.
- Do not add React/Vue/Svelte to a Rails build unless the PRD explicitly requires a separate frontend.

Verification:
- Run the Rails test/check command available in the generated app.
- Open the relevant page, interact with the Stimulus behavior, and verify visible state changes.
- Check browser console for JavaScript errors.
- Document any intentionally deferred interaction in the runbook or task notes.

Source references:
- Stimulus: https://stimulus.hotwired.dev/
