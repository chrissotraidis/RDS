# r3f-drei-helpers

React Three Fiber and Drei scene helpers for browser 3D experiences.

Applies to: web-3d
Category: frontend
Maturity: stable

Use when:
- The selected stack is `web-3d`.
- The PRD needs a 3D scene, product configurator, model viewer, immersive canvas, or interactive WebGL surface.

Implementation contract:
- Build a real scene, not a decorative empty canvas. Include camera, lights, controls, environment/background, loading state, and at least one inspectable object or model.
- Keep the primary 3D scene full-bleed or clearly dominant, with UI controls layered ergonomically instead of burying the scene inside cards.
- Use Drei helpers where they reduce boilerplate: camera controls, bounds, environment, loaders, Html labels, performance helpers.
- Make the canvas responsive with stable dimensions and no overlap at mobile and desktop breakpoints.
- Provide fallback/loading/error states for asset loading.

Verification:
- Run the stack build/check command.
- Open desktop and mobile previews and verify the canvas is nonblank, framed correctly, and interactive.
- Capture screenshot or pixel evidence; a blank or tiny canvas is a blocker.
- Check console for WebGL, asset loading, and hydration errors.

Source references:
- React Three Fiber: https://r3f.docs.pmnd.rs/
- Drei: https://drei.docs.pmnd.rs/
