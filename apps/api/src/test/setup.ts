import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import * as schema from "../db/schema";

/** The docker-compose `postgres-test` service, CI's service container and `.env.test`. */
export const DEFAULT_TEST_DATABASE_URL =
  "postgresql://gopaylocal_test:gopaylocal_test@localhost:5434/gopaylocal_test";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Where the integration tests may connect. Reads DATABASE_URL (default: the
 * local test database above) and REFUSES anything that is not a loopback host
 * with "test" in the database name: the integration tests TRUNCATE tables, so
 * an exported DATABASE_URL pointing at a dev, staging or production database
 * must never be used. The error names host and database only (no password).
 */
export function testDatabaseUrl(raw: string | undefined = process.env.DATABASE_URL): string {
  const value = raw?.trim() ? raw.trim() : DEFAULT_TEST_DATABASE_URL;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Refusing to run integration tests: DATABASE_URL is not a valid URL.");
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!LOOPBACK_HOSTS.has(url.hostname) || !/test/i.test(database)) {
    throw new Error(
      `Refusing to run integration tests against ${url.hostname}:${url.port || "5432"}/${database}. ` +
        `They TRUNCATE tables, so DATABASE_URL must be a loopback host and a database whose name ` +
        `contains "test" (default: localhost:5434/gopaylocal_test).`,
    );
  }
  return value;
}

let _client: ReturnType<typeof postgres> | null = null;
let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;

/** Direct database handle for seeding and assertions (never used by routes). */
export function getTestDb() {
  if (!_db) {
    _client = postgres(testDatabaseUrl());
    _db = drizzle(_client, { schema });
  }
  return _db;
}

/**
 * Empty every table in the `public` schema between tests (Better Auth tables
 * included), so a table added to schema.ts is covered without editing a list
 * here: a forgotten table would leak rows from one test into the next.
 * TRUNCATE ... CASCADE handles foreign keys atomically. Drizzle's migration
 * journal lives in the `drizzle` schema and is left alone. getTestDb() only
 * ever connects to the local test database (see testDatabaseUrl), so this can
 * never reach anything else.
 */
export async function cleanupTestDb() {
  const db = getTestDb();
  const rows = await db.execute<{ tablename: string }>(
    sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
  );
  const tables = Array.from(rows, (row) => `"public"."${row.tablename.replaceAll('"', '""')}"`);
  if (tables.length === 0) return;
  await db.execute(sql.raw(`TRUNCATE TABLE ${tables.join(", ")} CASCADE`));
}

export async function closeTestDb() {
  if (_client) {
    await _client.end();
    _client = null;
    _db = null;
  }
}

export type TestDb = ReturnType<typeof getTestDb>;
