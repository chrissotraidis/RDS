// Tailwind build config for the RDS dashboard.
//
// The dashboard is server-rendered from src/server.ts; all class names live
// in template literals there. This config precompiles them into
// public/tailwind.css (vendored, served from /static/tailwind.css) so pages
// style instantly — no CDN JIT compile, no flash of unstyled content, and no
// network dependency for a self-hosted install.
//
// Regenerate after changing markup or tokens:  bun run build:css
// Theme tokens mirror docs/DESIGN.md; do not add colors outside the ramp.
module.exports = {
  darkMode: "class",
  content: ["./src/**/*.ts"],
  theme: {
    extend: {
      colors: {
        "surface-variant": "#2c332f", "on-primary": "#04170d", "surface-dim": "#0b0d0c",
        "on-tertiary": "#3d2a08", "inverse-primary": "#1f6b47", "outline-variant": "#242b28",
        "on-background": "#e9eeea", "primary-fixed": "#8beebb", "secondary-fixed-dim": "#b9c2bc",
        "secondary": "#b9c2bc", "surface-tint": "#7ee2ae", "surface-container": "#141917",
        "primary-container": "#6ad7a3", "error": "#ffb4ab", "on-tertiary-container": "#3d2a08",
        "surface-container-highest": "#242b28", "on-tertiary-fixed": "#341f00",
        "on-error": "#690005", "inverse-surface": "#e9eeea", "surface": "#0b0d0c",
        "surface-container-high": "#1b211e", "on-surface-variant": "#a5b0a9",
        "on-secondary": "#272b28", "on-primary-container": "#042315",
        "primary": "#8beebb", "inverse-on-surface": "#262c28", "tertiary-fixed": "#ffe7c2",
        "tertiary": "#ffd9a0", "secondary-fixed": "#dde4de",
        "on-primary-fixed-variant": "#0a5233", "on-error-container": "#ffdad6",
        "tertiary-container": "#f0b869", "surface-container-low": "#101412",
        "background": "#0b0d0c", "surface-bright": "#2d3531",
        "error-container": "#93000a", "surface-container-lowest": "#070908",
        "secondary-container": "#39413c", "on-surface": "#e9eeea",
        "on-secondary-fixed-variant": "#3d453f", "primary-fixed-dim": "#6ad7a3",
        "tertiary-fixed-dim": "#f0b869", "on-primary-fixed": "#002113",
        "outline": "#75817a", "on-secondary-fixed": "#171c18",
        "on-secondary-container": "#b7c1ba", "on-tertiary-fixed-variant": "#6b4d14"
      },
      borderRadius: { DEFAULT: "0.5rem", lg: "0.625rem", xl: "0.875rem", full: "9999px" },
      spacing: {
        "stack-gap": "8px", "container-padding": "20px", unit: "12px",
        gutter: "16px", "component-gap": "12px"
      },
      fontFamily: {
        h2: ["Inter", "system-ui", "sans-serif"], body: ["Inter", "system-ui", "sans-serif"],
        table: ["Inter", "system-ui", "sans-serif"], h1: ["Inter", "system-ui", "sans-serif"],
        ribbon: ["Inter", "system-ui", "sans-serif"],
        code: ["JetBrains Mono", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"]
      },
      fontSize: {
        h2: ["15px", { lineHeight: "22px", letterSpacing: "-0.005em", fontWeight: "650" }],
        body: ["14px", { lineHeight: "21px", fontWeight: "400" }],
        table: ["13px", { lineHeight: "19.5px", fontWeight: "400" }],
        h1: ["22px", { lineHeight: "30px", letterSpacing: "-0.015em", fontWeight: "700" }],
        ribbon: ["12.5px", { lineHeight: "18px", letterSpacing: "0", fontWeight: "600" }],
        code: ["12.5px", { lineHeight: "19px", fontWeight: "400" }]
      }
    }
  },
  plugins: [
    require("@tailwindcss/forms"),
    require("@tailwindcss/container-queries"),
  ],
};
