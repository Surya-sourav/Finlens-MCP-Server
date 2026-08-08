import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./Core/Vault/db/schema.ts",
  out: "./drizzle/migrations",
  dbCredentials: {
    // Only required for `drizzle-kit migrate`/`push`; `generate` reads the
    // schema and emits SQL without a live connection.
    url: process.env.DATABASE_URL ?? "postgres://localhost:5432/placeholder",
  },
});
