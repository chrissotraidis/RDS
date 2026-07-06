# rds-mockup-fidelity

Use this skill as the universal fidelity contract. RDS cannot claim a build is done until the preview is compared against the right mockup analog for the selected stack.

Implementation contract:
- `rails-web`: UI kit/styleguide route, app screenshots, or provided HTML mockup.
- `nextjs-fullstack`: rendered app shell plus key responsive routes.
- `astro-thin-web`: static page screenshots and content hierarchy.
- `python-ai-service`: API docs, sample request/response, or report page.
- `web-3d`: canvas screenshot plus scene/framing notes.
- `game-engine`: playable loop evidence, controls, score/state, and game-over/restart path.
- `game-asset-pipeline`: target asset spec, validator report, and preview image.
- `mobile-native`: screen-sized web/Expo preview screenshots.
- `browser-extension`: popup/options HTML preview and manifest/permission check.

Expected build artifacts:
- `builds/<id>/mockup-diff/` exists when QA has run.
- The report names the analog used and what was actually checked.
- Screenshots or text reports are saved for the primary surface.

Verification:
- Open the preview in a browser, not only via curl.
- Check desktop and mobile when the build has a user-facing UI.
- For canvas/3D/game output, verify nonblank pixels and interaction/state changes.
- Document any mismatch as follow-up instead of calling it done.

Sources:
- Playwright: https://playwright.dev/
