import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";
import type { Bindings } from "../bindings";

export function createDb(env: Bindings) {
  const client = postgres(env.HYPERDRIVE.connectionString);
  return drizzle(client, { schema });
}

export type Database = ReturnType<typeof createDb>;
