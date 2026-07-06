# expo-router-codegen

Expo Router structure and typed route conventions for mobile-native builds.

Applies to: mobile-native
Category: mobile
Maturity: beta

Use when:
- The selected stack is `mobile-native`.
- The PRD needs multiple screens, tabs, stacks, auth flows, onboarding, settings, or deep links.

Implementation contract:
- Use Expo Router file conventions instead of a single web-style page.
- Model the primary mobile workflow as screens with clear back/forward paths.
- Keep route params typed and documented where supported.
- Include realistic empty/loading/error states per screen.
- Preserve phone-first ergonomics: reachable controls, native-feeling spacing, safe areas, and no desktop dashboard layouts.

Verification:
- Run the generated mobile stack check/build command.
- Inspect mobile-sized preview screenshots for navigation, overflow, clipped controls, and safe-area issues.
- Verify at least one multi-screen path and back navigation.

Source references:
- Expo Router: https://docs.expo.dev/router/introduction/
