// RDS prescaffold: shadcn-add starter homepage.
// Builders: replace this content with the app's real homepage, but keep imports
// from "@/components/ui/*". Removing all shadcn imports fails the consumption gate.
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export default function HomePage() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="container py-16 space-y-10">
        <header className="space-y-3 max-w-2xl">
          <Badge variant="secondary">RDS</Badge>
          <h1 className="text-4xl font-bold tracking-tight md:text-5xl">
            Welcome
          </h1>
          <p className="text-muted-foreground text-lg">
            This app uses shadcn/ui for its design system. Replace this hero
            with your product&apos;s real homepage.
          </p>
        </header>

        <section className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Get started</CardTitle>
              <CardDescription>
                The component library is wired up. Build your first feature on
                top of these primitives.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              <Button>Primary action</Button>
              <Button variant="outline">Secondary</Button>
              <Button variant="ghost">Ghost</Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Design system</CardTitle>
              <CardDescription>
                Use <code>@/components/ui/*</code> primitives and the{" "}
                <code>cn()</code> helper from <code>@/lib/utils</code> for class
                composition. Don&apos;t hand-roll buttons or inputs.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              <Badge>Badge</Badge>
              <Badge variant="secondary">Secondary</Badge>
              <Badge variant="outline">Outline</Badge>
            </CardContent>
          </Card>
        </section>
      </div>
    </main>
  );
}
