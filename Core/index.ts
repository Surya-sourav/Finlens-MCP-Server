import { buildApp } from "./http/app.js";

// Multi-tenant HTTP entry point (the Fly / container CMD). The single-tenant
// stdio entry point remains at src/index.ts for local/desktop use.
const app = buildApp();
const port = Number(process.env.PORT ?? 8080);

app
  .listen({ host: "0.0.0.0", port })
  .then((addr) => {
    app.log.info(`Finlens MCP server listening on ${addr}`);
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
