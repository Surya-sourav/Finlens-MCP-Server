import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle, type NeonDatabase } from "drizzle-orm/neon-serverless";
import ws from "ws";
import * as schema from "./schema.js";

// The Neon pooled/transaction driver needs a WebSocket implementation in Node.
neonConfig.webSocketConstructor = ws;

export type Db = NeonDatabase<typeof schema>;

let pool: Pool | undefined;
let dbInstance: Db | undefined;

/** Lazily creates (and memoizes) the Neon-backed Drizzle client. */
export function getDb(): Db {
  if (!dbInstance) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error("DATABASE_URL is required for the multi-tenant Vault.");
    }
    pool = new Pool({ connectionString: url });
    dbInstance = drizzle(pool, { schema });
  }
  return dbInstance;
}

/** Closes the pool (call on graceful shutdown). */
export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
    dbInstance = undefined;
  }
}
