// fixtures/vps-hello/server.ts — the tiny app bin/rds-vps-smoke publishes.
// Serves RDS deploy markers (so the fingerprint check can run) and a page
// that proves which runtime and host it was started with.
const port = Number(process.env.PORT || 3000);
Bun.serve({
  port,
  hostname: "0.0.0.0",
  async fetch(req) {
    const path = new URL(req.url).pathname;
    for (const candidate of ["public" + path, path.slice(1)]) {
      if (candidate.includes("..")) continue;
      if (path.endsWith("rds-deploy-fingerprint.json")) {
        const file = Bun.file(candidate);
        if (await file.exists()) return new Response(file, { headers: { "content-type": "application/json" } });
      }
    }
    return new Response(
      "<!doctype html><title>RDS VPS smoke</title><h1>RDS VPS smoke OK</h1>" +
        "<p>runtime=" + process.env.RDS_RUNTIME + " host=" + process.env.APP_PUBLIC_HOST + "</p>",
      { headers: { "content-type": "text/html" } },
    );
  },
});
