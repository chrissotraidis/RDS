// RDS prescaffold: shadcn-add root layout.
// Builders: keep `import "./globals.css"` and the design-token classes on body.
// You can extend metadata, fonts, and providers, but do not remove the imports.
import type { Metadata } from "next";
import "./globals.css";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: "App",
  description: "Built with RDS",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={cn(
          "min-h-screen bg-background text-foreground antialiased",
        )}
      >
        {children}
      </body>
    </html>
  );
}
