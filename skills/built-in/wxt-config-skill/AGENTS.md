# wxt-config-skill

WXT manifest and config setup for MV3 extensions.

Applies to: browser-extension
Category: browser-extension
Maturity: stable

Use when:
- The PRD describes Chrome/Edge extension behavior, popup UI, content scripts, page overlays, background workers, or MV3 permissions.

Implementation contract:
- Use WXT conventions for `entrypoints/`, manifest generation, and extension packaging.
- Keep permissions minimal and explain why each permission exists.
- Add a popup/options preview page that can be inspected through the RDS browser even before store packaging.
- Separate content-script behavior from popup UI behavior.
- Do not claim Chrome Web Store readiness unless packaging and human submission steps are documented.

Verification:
- Run the WXT build/check command when available.
- Inspect generated manifest output for MV3, permissions, host permissions, and entrypoints.
- Open the popup/options preview in the browser and click the primary flow.

Source references:
- wxt.dev: https://wxt.dev/
