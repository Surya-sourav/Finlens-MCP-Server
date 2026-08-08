import { migrate } from "drizzle-orm/neon-serverless/migrator";
import { closeDb, getDb } from "./client.js";

/**
 * Applies pending Drizzle migrations using only drizzle-orm (no drizzle-kit),
 * so it can run in the production image. Used as the Fly `release_command`.
 */
async function main(): Promise<void> {
  await migrate(getDb(), { migrationsFolder: "./drizzle/migrations" });
  await closeDb();
  // eslint-disable-next-line no-console
  console.log("[migrate] migrations applied.");
}

main()
  .then(() => process.exit(0)) // exit cleanly so it can chain before the server starts
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[migrate] failed:", err);
    process.exit(1);
  });
