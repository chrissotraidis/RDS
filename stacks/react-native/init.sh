#!/usr/bin/env bash
set -euo pipefail

APP_NAME="${1:-rds_mobile_app}"
APP_DEST="${2:?app destination required}"

slug="$(printf '%s' "$APP_NAME" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//; s/-+/-/g')"
[[ -n "$slug" ]] || slug="rds-mobile-app"
package_slug="$(printf '%s' "$slug" | tr '-' '.')"

mkdir -p "$APP_DEST/app/(tabs)" "$APP_DEST/assets/images" "$APP_DEST/components/ui" "$APP_DEST/hooks" "$APP_DEST/lib" "$APP_DEST/constants" "$APP_DEST/mockup-screens" "$APP_DEST/preview" "$APP_DEST/tmp/pids" "$APP_DEST/log"

cat > "$APP_DEST/package.json" <<JSON
{
  "name": "${slug}",
  "version": "0.1.0",
  "private": true,
  "main": "expo-router/entry",
  "scripts": {
    "start": "expo start --host tunnel",
    "android": "expo start --android",
    "ios": "expo start --ios",
    "web": "expo start --web",
    "check": "tsc --noEmit",
    "preview": "bun preview-server.ts"
  },
  "dependencies": {
    "@expo/vector-icons": "latest",
    "@types/bun": "latest",
    "@types/react": "latest",
    "expo": "latest",
    "expo-constants": "latest",
    "expo-linking": "latest",
    "expo-router": "latest",
    "expo-status-bar": "latest",
    "react": "latest",
    "react-dom": "latest",
    "react-native": "latest",
    "react-native-safe-area-context": "latest",
    "react-native-screens": "latest",
    "react-native-web": "latest",
    "typescript": "latest"
  },
  "devDependencies": {}
}
JSON

cat > "$APP_DEST/app.json" <<JSON
{
  "expo": {
    "name": "${APP_NAME}",
    "slug": "${slug}",
    "scheme": "${slug}",
    "version": "0.1.0",
    "orientation": "portrait",
    "userInterfaceStyle": "automatic",
    "newArchEnabled": true,
    "ios": {
      "bundleIdentifier": "io.rds.${package_slug}",
      "supportsTablet": true
    },
    "android": {
      "package": "io.rds.${package_slug}"
    },
    "web": {
      "bundler": "metro",
      "output": "static"
    },
    "plugins": ["expo-router"],
    "experiments": {
      "typedRoutes": true
    }
  }
}
JSON

cat > "$APP_DEST/eas.json" <<'JSON'
{
  "cli": { "version": ">= 15.0.0" },
  "build": {
    "development": {
      "developmentClient": true,
      "distribution": "internal"
    },
    "preview": {
      "distribution": "internal",
      "android": { "buildType": "apk" }
    },
    "production": {}
  }
}
JSON

cat > "$APP_DEST/tsconfig.json" <<'JSON'
{
  "extends": "expo/tsconfig.base",
  "compilerOptions": {
    "strict": true,
    "types": ["bun-types"],
    "paths": {
      "@/*": ["./*"]
    }
  },
  "include": ["**/*.ts", "**/*.tsx", ".expo/types/**/*.ts", "expo-env.d.ts"]
}
JSON

cat > "$APP_DEST/expo-env.d.ts" <<'TS'
/// <reference types="expo/types" />
TS

cat > "$APP_DEST/app/_layout.tsx" <<'TSX'
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";

export default function RootLayout() {
  return (
    <>
      <Stack screenOptions={{ headerShown: false }} />
      <StatusBar style="auto" />
    </>
  );
}
TSX

cat > "$APP_DEST/app/(tabs)/_layout.tsx" <<'TSX'
import { Tabs } from "expo-router";
import { Platform } from "react-native";

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: "#0f766e",
        headerShown: false,
        tabBarStyle: Platform.select({ ios: { position: "absolute" }, default: {} }),
      }}
    >
      <Tabs.Screen name="index" options={{ title: "Home" }} />
      <Tabs.Screen name="profile" options={{ title: "Profile" }} />
    </Tabs>
  );
}
TSX

cat > "$APP_DEST/app/(tabs)/index.tsx" <<'TSX'
import { StyleSheet, Text, View } from "react-native";

export default function HomeScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.kicker}>RDS mobile-native stack</Text>
      <Text style={styles.title}>Expo app shell ready</Text>
      <Text style={styles.body}>
        Replace this starter with the native app described in the PRD. Keep Expo Router, typed routes, and the mockup-screens contract.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: "center", padding: 24, backgroundColor: "#f8fafc" },
  kicker: { color: "#0f766e", fontSize: 12, fontWeight: "800", textTransform: "uppercase", marginBottom: 10 },
  title: { color: "#172033", fontSize: 38, fontWeight: "800", lineHeight: 40, marginBottom: 12 },
  body: { color: "#475569", fontSize: 17, lineHeight: 24 },
});
TSX

cat > "$APP_DEST/app/(tabs)/profile.tsx" <<'TSX'
import { StyleSheet, Text, View } from "react-native";

export default function ProfileScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Profile</Text>
      <Text style={styles.body}>Use this tab as a second screen target or replace it with the PRD's route map.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: "center", padding: 24, backgroundColor: "#eef2f7" },
  title: { color: "#172033", fontSize: 32, fontWeight: "800", marginBottom: 10 },
  body: { color: "#475569", fontSize: 17, lineHeight: 24 },
});
TSX

cat > "$APP_DEST/preview/index.html" <<'HTML'
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>RDS Mobile Preview</title>
    <style>
      :root { color: #172033; background: #e7edf4; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
      body { margin: 0; min-width: 320px; min-height: 100vh; display: grid; place-items: center; padding: 24px; }
      main { display: grid; grid-template-columns: 320px minmax(260px, 420px); gap: 28px; align-items: center; }
      .phone { width: 320px; height: 660px; border: 10px solid #172033; border-radius: 32px; background: #f8fafc; padding: 28px 20px; box-shadow: 0 20px 70px rgba(15, 23, 42, .22); }
      .kicker { color: #0f766e; font-size: 12px; font-weight: 800; text-transform: uppercase; }
      h1 { margin: 8px 0 12px; font-size: 38px; line-height: 1; }
      p { color: #475569; line-height: 1.5; }
      code { background: #dbe4ee; padding: 2px 5px; }
      @media (max-width: 820px) { main { grid-template-columns: 1fr; } .phone { width: min(100%, 320px); } }
    </style>
  </head>
  <body>
    <main>
      <section class="phone">
        <p class="kicker">RDS mobile-native stack</p>
        <h1>Expo app shell ready</h1>
        <p>Native screens are scaffolded under <code>app/</code>. Start an Expo tunnel for device preview when credentials and phone workflow are available.</p>
      </section>
      <section>
        <p class="kicker">Preview contract</p>
        <h2>Zo web preview plus Expo tunnel handoff</h2>
        <p>This page confirms the RDS stack can build and serve on Zo. The native path is <code>bun run start</code> for Expo Go, or EAS preview builds for APK/TestFlight artifacts.</p>
      </section>
    </main>
  </body>
</html>
HTML

cat > "$APP_DEST/preview-server.ts" <<'TS'
import { existsSync } from "node:fs";
import { join } from "node:path";

const port = Number(process.env.HOST_PORT || process.env.PORT || 4000);
const root = process.cwd();

Bun.serve({
  port,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health.json") {
      return Response.json({ ok: true, stack: "mobile-native", preview: "zo-web-fallback" });
    }
    const path = url.pathname === "/" ? join(root, "preview/index.html") : join(root, url.pathname.replace(/^\//, ""));
    if (!existsSync(path)) return new Response("Not found", { status: 404 });
    return new Response(Bun.file(path), { headers: { "content-type": "text/html; charset=utf-8" } });
  },
});

console.log(`mobile preview listening on ${port}`);
TS

cat > "$APP_DEST/mockup-screens/README.md" <<'MD'
# Mockup Screens

Drop route-matched PNG references here, for example:

- `home.png` for `app/(tabs)/index.tsx`
- `profile.png` for `app/(tabs)/profile.tsx`

RDS uses this folder as the mobile-native mockup analog.
MD

cat > "$APP_DEST/.gitignore" <<'EOF'
node_modules
.expo
dist
web-build
.env
tmp/pids
log
EOF

if [[ ! -f "$APP_DEST/.env" ]]; then
  : > "$APP_DEST/.env"
fi

cat > "$APP_DEST/AGENTS.md" <<'MD'
# RDS Mobile-Native Build Notes

- Keep this as an Expo + Expo Router app.
- Preserve `/health.json` in the Zo preview server.
- Use `mockup-screens/` as the screen-fidelity contract.
- Native device preview uses `bun run start` and Expo Go; EAS builds require configured Expo/Apple/Google credentials.
MD

echo "Initialized mobile-native Expo app at $APP_DEST"
