# expo-skills-mount

Expo official skill/context mount for mobile-native builds.

Applies to: mobile-native
Category: mobile
Maturity: stable

Use when:
- The PRD targets iOS/Android, Expo, React Native, native device APIs, or phone-first UX.

Implementation contract:
- Prefer Expo-compatible dependencies and file structure.
- Keep navigation, app config, assets, and environment variables explicit.
- Provide a browser-inspectable fallback preview when a native simulator/device is not available.
- Record whether EAS credentials are required or pending.
- Do not imply App Store or Play Store submission is automated.

Verification:
- Run the Expo/React Native static check available in the generated project.
- Inspect the mobile-sized preview screenshot for layout overflow.
- Record any blocked native behavior that requires a real device.

Source references:
- docs.expo.dev: https://docs.expo.dev/
