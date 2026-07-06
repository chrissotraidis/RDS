# qr-tunnel-publisher

Expo tunnel QR and deep-link preview handoff for mobile-native builds.

Applies to: mobile-native
Category: preview
Maturity: beta

Use when:
- The selected stack is `mobile-native`.
- The operator needs a phone-friendly preview path, QR code, deep link, or explicit fallback from Zo.

Implementation contract:
- Prefer a real Expo tunnel/QR path when credentials and runtime support exist.
- When tunnel preview is unavailable, write a clear fallback: web preview URL, what it can validate, and what still requires a real device.
- Keep preview metadata in the build artifacts so the dashboard can surface it.
- Do not claim TestFlight, App Store, or Play Store readiness from a QR preview alone.

Verification:
- Confirm the preview URL or QR/deep-link artifact exists.
- Open the browser fallback and inspect mobile layout.
- Record any device-only gaps clearly for operator review.

Source references:
- Expo CLI: https://docs.expo.dev/more/expo-cli/
