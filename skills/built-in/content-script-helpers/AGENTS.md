# content-script-helpers

MV3 content script and page messaging contract for browser extensions.

Applies to: browser-extension
Category: browser-extension
Maturity: stable

Use when:
- The selected stack is `browser-extension`.
- The PRD needs page inspection, overlays, DOM extraction, selection tools, injected UI, or popup-to-page messaging.

Implementation contract:
- Separate popup/options UI from content scripts and background/service-worker code.
- Keep host permissions narrow and tied to explicit PRD needs.
- Use message passing for popup/content/background communication; do not rely on long-lived MV3 worker state.
- Make content-script behavior testable through a fixture page or documented manual preview path.
- Avoid injecting broad global CSS or scripts that would break arbitrary pages.

Verification:
- Run the extension build/check command.
- Inspect manifest permissions and entrypoints.
- Exercise popup-to-content-script messaging against a local fixture or preview page.
- Record any behavior that requires installing the packed extension manually.

Source references:
- Chrome content scripts: https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts
