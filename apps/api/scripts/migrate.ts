/**
 * Applies the SQL migrations in apps/api/drizzle to DATABASE_URL, exactly as
 * `drizzle-kit migrate` does, and prints the database error when one fails.
 *
 * Why it exists: drizzle-kit 0.31 exits 1 without printing anything but its
 * spinner when a migration fails (the spinner's error path exits the process
 * before drizzle-kit's own error handler runs). So `db:migrate` and
 * `deploy:full` run `drizzle-kit migrate || tsx scripts/migrate.ts`: only when
 * drizzle-kit fails does this script try once more. All pending migrations run
 * in one transaction, so a failed attempt leaves nothing behind and the retry
 * starts from the same state. It either succeeds (the first failure was
 * transient) or fails the same way and says why.
 *
 * Interchangeable with drizzle-kit migrate:
 * - the same migrator (drizzle-orm/postgres-js/migrator, which drizzle-kit
 *   imports for the "postgres" driver);
 * - the same journal table, drizzle.__drizzle_migrations (drizzle-orm's default;
 *   drizzle.config.ts sets no `migrations` block), with the same rows: the
 *   sha256 of each .sql file and the journal's `when`;
 * - the same connection: postgres(DATABASE_URL, { max: 1 }). TLS comes from
 *   `sslmode` in DATABASE_URL or PGSSLMODE, as with drizzle-kit.
 *
 * Reads only DATABASE_URL (the postgres driver also falls back to the standard
 * PG* variables for anything the URL leaves out, as it does under drizzle-kit).
 * Loads no .env or .dev.vars file. Never prints the connection string.
 *
 *   DATABASE_URL=postgres://... pnpm exec tsx scripts/migrate.ts [--migrations-folder <dir>]
 *
 * Exit codes: 0 applied, or nothing to apply; 1 a migration failed (rolled
 * back) or the database could not be reached; 2 usage error.
 */

import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

/** drizzle-orm's defaults (pg-core/dialect.js), which drizzle-kit also uses. */
export const MIGRATIONS_SCHEMA = "drizzle";
export const MIGRATIONS_TABLE = "__drizzle_migrations";
/** drizzle.config.ts `out`, relative to apps/api. */
export const DEFAULT_MIGRATIONS_FOLDER = fileURLToPath(new URL("../drizzle", import.meta.url));

const USAGE = "Usage: DATABASE_URL=postgres://... tsx scripts/migrate.ts [--migrations-folder <dir>]";
const MAX_STATEMENT_CHARS = 4000;

export type ParsedArgs = { kind: "run"; migrationsFolder: string } | { kind: "help" } | { kind: "error"; message: string };

export function parseArgs(argv: readonly string[], cwd: string): ParsedArgs {
  let migrationsFolder = DEFAULT_MIGRATIONS_FOLDER;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") return { kind: "help" };
    if (arg === "--migrations-folder" || arg.startsWith("--migrations-folder=")) {
      const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : argv[++i];
      if (!value || value.startsWith("--")) {
        return { kind: "error", message: `--migrations-folder needs a directory.\n${USAGE}` };
      }
      migrationsFolder = resolve(cwd, value);
      continue;
    }
    return { kind: "error", message: `Unknown argument: ${arg}\n${USAGE}` };
  }
  return { kind: "run", migrationsFolder };
}

export function readDatabaseUrl(env: Record<string, string | undefined>): { url: string } | { error: string } {
  const url = env.DATABASE_URL?.trim();
  if (!url) {
    return {
      error:
        "DATABASE_URL is not set. Set it to the connection string of the database to migrate " +
        "(postgres://user:password@host:5432/database). Nothing was done.",
    };
  }
  return { url };
}

/** Removes the connection string, and any URL credentials, from text about to be printed. */
export function redact(text: string, url: string | undefined): string {
  let out = text;
  if (url) {
    out = out.split(url).join("<DATABASE_URL>");
    let password = "";
    try {
      password = new URL(url).password;
    } catch {
      // Not a URL: the whole-string replacement above is all we can do.
    }
    if (password) {
      for (const form of new Set([password, safeDecode(password)])) {
        if (form) out = out.split(form).join("<password>");
      }
    }
  }
  // Credentials in any other postgres URL that reached the text.
  return out.replace(/(postgres(?:ql)?:\/\/)[^\s/@]*@/gi, "$1<credentials>@");
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export interface MigrationFile {
  tag: string;
  /** The journal's `when`: what the migrator compares and stores as created_at. */
  when: number;
  /** The statements the migrator runs: the file split on "--> statement-breakpoint". */
  statements: string[];
}

/** Reads the folder the way drizzle-orm's readMigrationFiles does, keeping each tag. */
export function readMigrations(folder: string): MigrationFile[] {
  const journal = JSON.parse(readFileSync(resolve(folder, "meta/_journal.json"), "utf8")) as {
    entries: { tag: string; when: number }[];
  };
  return journal.entries.map((entry) => ({
    tag: entry.tag,
    when: entry.when,
    statements: readFileSync(resolve(folder, `${entry.tag}.sql`), "utf8").split("--> statement-breakpoint"),
  }));
}

/**
 * Which migrations the migrator will run, by its own rule (pg-core/dialect.js):
 * every migration whose `when` is later than the latest applied created_at, or
 * all of them when nothing is applied yet.
 */
export function pendingMigrations<T extends { when: number }>(
  migrations: readonly T[],
  lastAppliedCreatedAt: string | number | null | undefined,
): T[] {
  if (lastAppliedCreatedAt === null || lastAppliedCreatedAt === undefined) return [...migrations];
  const last = Number(lastAppliedCreatedAt);
  return migrations.filter((m) => last < m.when);
}

interface PgErrorFields {
  message: string;
  code?: string;
  severity?: string;
  detail?: string;
  hint?: string;
  where?: string;
  position?: string;
  schema_name?: string;
  table_name?: string;
  column_name?: string;
  constraint_name?: string;
  query?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/** The server's error (postgres.js PostgresError), wherever it sits in the cause chain. */
function findPostgresError(error: unknown): PgErrorFields | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    const rec = asRecord(current);
    if (!rec) return null;
    if (rec.name === "PostgresError" || (typeof rec.code === "string" && typeof rec.severity === "string")) {
      return rec as unknown as PgErrorFields;
    }
    current = rec.cause;
  }
  return null;
}

/** The SQL that failed: drizzle's DrizzleQueryError.query, or the driver's own (non-enumerable) query. */
function findFailedStatement(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    const rec = asRecord(current);
    if (!rec) return null;
    if (typeof rec.query === "string" && rec.query.trim()) return rec.query;
    current = rec.cause;
  }
  return null;
}

function locate(statement: string, migrations: readonly MigrationFile[]) {
  for (const m of migrations) {
    const index = m.statements.indexOf(statement);
    if (index === -1) continue;
    // Breakpoint markers contain no newline, so a statement starts on the line
    // after every newline in the statements before it.
    const firstLine = 1 + m.statements.slice(0, index).join("").split("\n").length - 1;
    return { tag: m.tag, index, total: m.statements.length, firstLine };
  }
  return null;
}

function errorText(error: unknown): string {
  const rec = asRecord(error);
  if (rec && typeof rec.message === "string" && rec.message) return rec.message;
  // AggregateError (e.g. connection refused on every address of a host) has an
  // empty message of its own.
  if (rec && Array.isArray(rec.errors) && rec.errors.length) {
    return [...new Set(rec.errors.map((e) => errorText(e)))].join("; ");
  }
  return String(error);
}

/** Driver-side codes for a connection that never opened. */
const CONNECT_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "CONNECT_TIMEOUT",
]);

/**
 * Server SQLSTATEs raised while connecting: 08 connection exception, 28 invalid
 * authorization (wrong password, no pg_hba entry), 3D000 no such database,
 * 53300 too many connections, 57P03 cannot connect now.
 */
export function isConnectFailure(code: string | undefined): boolean {
  if (!code) return false;
  return (
    CONNECT_ERROR_CODES.has(code) ||
    code.startsWith("08") ||
    code.startsWith("28") ||
    code === "3D000" ||
    code === "53300" ||
    code === "57P03"
  );
}

/**
 * The lines printed when the migration run fails. `pending` is searched first,
 * then `all`, to name the migration and statement that failed.
 */
export function formatMigrationError(
  error: unknown,
  migrations: { pending: readonly MigrationFile[]; all: readonly MigrationFile[] },
  url: string | undefined,
): string {
  const pg = findPostgresError(error);
  const statement = findFailedStatement(error);
  const lines: string[] = [];
  const rec = asRecord(error);
  const code = pg?.code ?? (rec && typeof rec.code === "string" ? rec.code : undefined);

  if (isConnectFailure(code)) {
    lines.push("Could not connect to the database; nothing was applied.");
    lines.push(`  error:     ${pg ? pg.message : errorText(error)}`);
    lines.push(`  code:      ${code}${pg ? " (SQLSTATE)" : ""}`);
    if (pg?.hint) lines.push(`  hint:      ${pg.hint}`);
    return redact(lines.join("\n"), url);
  }

  if (!pg) {
    // Not an error from the server, and not a refused connection: TLS, a lost
    // connection, a bug. A transaction cut off before COMMIT is not applied.
    lines.push("Migration run failed without an error from the database server.");
    lines.push(`  error:     ${errorText(error)}`);
    if (code) lines.push(`  code:      ${code}`);
    lines.push("  Run it again to see what is still pending: it applies only that.");
    return redact(lines.join("\n"), url);
  }

  const where = statement ? (locate(statement, migrations.pending) ?? locate(statement, migrations.all)) : null;
  lines.push(
    "Migration failed; nothing from this run was applied (pending migrations run in one transaction, rolled back on error).",
  );
  if (where) lines.push(`  migration: ${where.tag}.sql (statement ${where.index + 1} of ${where.total})`);
  lines.push(`  error:     ${pg.message}`);
  if (pg.code) lines.push(`  code:      ${pg.code} (SQLSTATE)`);
  if (pg.detail) lines.push(`  detail:    ${pg.detail}`);
  if (pg.hint) lines.push(`  hint:      ${pg.hint}`);
  if (pg.where) lines.push(`  where:     ${pg.where}`);
  const objects = [
    pg.schema_name && `schema ${pg.schema_name}`,
    pg.table_name && `table ${pg.table_name}`,
    pg.column_name && `column ${pg.column_name}`,
    pg.constraint_name && `constraint ${pg.constraint_name}`,
  ].filter(Boolean);
  if (objects.length) lines.push(`  object:    ${objects.join(", ")}`);
  if (statement) {
    const position = Number(pg.position);
    if (Number.isInteger(position) && position > 0) {
      const lineInStatement = statement.slice(0, position - 1).split("\n").length;
      lines.push(
        where
          ? `  at:        ${where.tag}.sql line ${where.firstLine + lineInStatement - 1} (character ${position} of the statement)`
          : `  at:        character ${position} of the statement`,
      );
    } else if (where) {
      // No position from the server (e.g. "already exists"): point at the line
      // where the statement's text starts.
      const leading = statement.slice(0, statement.length - statement.trimStart().length);
      lines.push(`  at:        ${where.tag}.sql line ${where.firstLine + leading.split("\n").length - 1} (start of the statement)`);
    }
    const trimmed = statement.trim();
    const shown =
      trimmed.length > MAX_STATEMENT_CHARS ? `${trimmed.slice(0, MAX_STATEMENT_CHARS)}\n… (truncated)` : trimmed;
    lines.push("  statement:");
    for (const line of shown.split("\n")) lines.push(`    ${line}`);
  }
  return redact(lines.join("\n"), url);
}

/**
 * The two notices the migrator's own bookkeeping raises on every run after the
 * first (CREATE SCHEMA / CREATE TABLE IF NOT EXISTS for its journal). Other
 * notices, such as a migration's own IF EXISTS skips, are printed.
 */
export function isBookkeepingNotice(message: string | undefined): boolean {
  return (
    message === `schema "${MIGRATIONS_SCHEMA}" already exists, skipping` ||
    message === `relation "${MIGRATIONS_TABLE}" already exists, skipping`
  );
}

export function describeApplied(appliedTags: readonly string[], latestTag: string | null): string {
  if (appliedTags.length === 0) {
    return `Nothing to apply: the database is up to date${latestTag ? ` (latest: ${latestTag})` : ""}.`;
  }
  const noun = appliedTags.length === 1 ? "migration" : "migrations";
  return `Applied ${appliedTags.length} ${noun}: ${appliedTags.join(", ")}.`;
}

async function main(argv: readonly string[], env: Record<string, string | undefined>): Promise<number> {
  const args = parseArgs(argv, process.cwd());
  if (args.kind === "help") {
    console.log(USAGE);
    return 0;
  }
  if (args.kind === "error") {
    console.error(args.message);
    return 2;
  }
  const db = readDatabaseUrl(env);
  if ("error" in db) {
    console.error(db.error);
    return 2;
  }

  let migrations: MigrationFile[];
  try {
    migrations = readMigrations(args.migrationsFolder);
  } catch (error) {
    console.error(redact(`Cannot read migrations from ${args.migrationsFolder}: ${errorText(error)}`, db.url));
    return 2;
  }

  const sql = postgres(db.url, {
    max: 1,
    onnotice: (notice) => {
      if (isBookkeepingNotice(notice.message)) return;
      console.log(redact(`notice: ${notice.message ?? JSON.stringify(notice)}`, db.url));
    },
  });
  let pending: MigrationFile[] = migrations;
  try {
    const journalTable = `"${MIGRATIONS_SCHEMA}"."${MIGRATIONS_TABLE}"`;
    const [{ exists } = { exists: null }] = await sql<{ exists: string | null }[]>`
      select to_regclass(${journalTable})::text as exists`;
    let maxIdBefore = 0;
    if (exists) {
      const [last] = await sql.unsafe<{ created_at: string | null }[]>(
        `select created_at from ${journalTable} order by created_at desc limit 1`,
      );
      pending = pendingMigrations(migrations, last?.created_at ?? null);
      const [max] = await sql.unsafe<{ max: number | null }[]>(`select max(id) as max from ${journalTable}`);
      maxIdBefore = max?.max ?? 0;
    }

    await migrate(drizzle(sql), {
      migrationsFolder: args.migrationsFolder,
      migrationsTable: MIGRATIONS_TABLE,
      migrationsSchema: MIGRATIONS_SCHEMA,
    });

    // Report what the journal table now records, not what we expected.
    const inserted = await sql.unsafe<{ created_at: string }[]>(
      `select created_at from ${journalTable} where id > $1 order by id`,
      [maxIdBefore],
    );
    const tagOf = (createdAt: string | number) =>
      migrations.find((m) => m.when === Number(createdAt))?.tag ?? `created_at ${createdAt}`;
    const [latest] = await sql.unsafe<{ created_at: string }[]>(
      `select created_at from ${journalTable} order by created_at desc limit 1`,
    );
    // Leading newline: after a failed `drizzle-kit migrate`, its spinner line is
    // left unterminated.
    console.log(`\n${describeApplied(inserted.map((row) => tagOf(row.created_at)), latest ? tagOf(latest.created_at) : null)}`);
    return 0;
  } catch (error) {
    console.error(`\n${formatMigrationError(error, { pending, all: migrations }, db.url)}`);
    return 1;
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

// Run only when executed directly (`tsx scripts/migrate.ts`), not when imported
// by the unit test.
function invokedPath(): string {
  try {
    return process.argv[1] ? realpathSync(resolve(process.argv[1])) : "";
  } catch {
    return "";
  }
}
const entry = invokedPath();
if (entry && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = await main(process.argv.slice(2), process.env);
}
