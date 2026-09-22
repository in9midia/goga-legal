import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { config } from "../config.js";
import * as schema from "./schema.js";

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
export const db = drizzle(pool, { schema });
export type Db = typeof db;
export { schema };

export async function runMigrations(): Promise<void> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // src/db -> ../../drizzle; dist/db -> ../../drizzle. Mesmo caminho nos dois.
  await migrate(db, { migrationsFolder: path.resolve(here, "../../drizzle") });
  await pool.query("INSERT INTO production (id) VALUES (1) ON CONFLICT DO NOTHING");
}
