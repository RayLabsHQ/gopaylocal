// Tests for scripts/migrate.ts (the fallback after `drizzle-kit migrate` in
// `db:migrate` and `deploy:full`). Lives under src/ only because the `api`
// vitest project includes src/**/*.test.ts. Nothing here opens a database
// connection: the spawned runs have no DATABASE_URL and stop before connecting.
// Applying migrations against a real database is checked by hand on the local
// test database (see the test-infra report), not here.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DrizzleQueryError } from "drizzle-orm";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import drizzleConfig from "../../drizzle.config";
import {
  DEFAULT_MIGRATIONS_FOLDER,
  MIGRATIONS_SCHEMA,
  MIGRATIONS_TABLE,
  describeApplied,
  formatMigrationError,
  isBookkeepingNotice,
  isConnectFailure,
  parseArgs,
  pendingMigrations,
  readDatabaseUrl,
  readMigrations,
  redact,
  type MigrationFile,
} from "../../scripts/migrate";

const API_DIR = fileURLToPath(new URL("../..", import.meta.url));
const SCRIPT = resolve(API_DIR, "scripts/migrate.ts");
const TSX = resolve(API_DIR, "node_modules/.bin/tsx");
const URL_WITH_SECRET = "postgres://deployer:p%40ss%2Fw0rd@db.example.com:5432/gopaylocal?sslmode=require";

describe("defaults match drizzle-kit", () => {
  it("migrates the folder drizzle.config.ts names, into drizzle-orm's default journal table", () => {
    expect(drizzleConfig.dialect).toBe("postgresql");
    expect(resolve(API_DIR, drizzleConfig.out ?? "")).toBe(DEFAULT_MIGRATIONS_FOLDER);
    // No `migrations` block: drizzle-kit leaves table and schema to drizzle-orm,
    // whose defaults are drizzle.__drizzle_migrations (pg-core/dialect.js).
    expect("migrations" in drizzleConfig).toBe(false);
    expect([MIGRATIONS_SCHEMA, MIGRATIONS_TABLE]).toEqual(["drizzle", "__drizzle_migrations"]);
  });

  it("reads every journal entry with the statements the migrator runs", () => {
    const migrations = readMigrations(DEFAULT_MIGRATIONS_FOLDER);
    const journal = JSON.parse(readFileSync(resolve(DEFAULT_MIGRATIONS_FOLDER, "meta/_journal.json"), "utf8")) as {
      entries: { tag: string; when: number }[];
    };
    expect(migrations.map((m) => [m.tag, m.when])).toEqual(journal.entries.map((e) => [e.tag, e.when]));
    for (const m of migrations) {
      const file = readFileSync(resolve(DEFAULT_MIGRATIONS_FOLDER, `${m.tag}.sql`), "utf8");
      expect(m.statements.join("--> statement-breakpoint")).toBe(file);
    }
  });
});

describe("parseArgs", () => {
  it("defaults to apps/api/drizzle", () => {
    expect(parseArgs([], "/anywhere")).toEqual({ kind: "run", migrationsFolder: DEFAULT_MIGRATIONS_FOLDER });
  });

  it("takes --migrations-folder as a separate or = value, relative to the working directory", () => {
    expect(parseArgs(["--migrations-folder", "scratch/drizzle"], "/work")).toEqual({
      kind: "run",
      migrationsFolder: "/work/scratch/drizzle",
    });
    expect(parseArgs(["--migrations-folder=/abs/drizzle"], "/work")).toEqual({
      kind: "run",
      migrationsFolder: "/abs/drizzle",
    });
  });

  it("refuses a missing folder value and unknown arguments, with the usage line", () => {
    for (const argv of [["--migrations-folder"], ["--migrations-folder="], ["--migrations-folder", "--help"]]) {
      const parsed = parseArgs(argv, "/work");
      expect(parsed.kind).toBe("error");
      expect(parsed.kind === "error" && parsed.message).toMatch(/--migrations-folder needs a directory\.\nUsage: /);
    }
    const unknown = parseArgs(["--force"], "/work");
    expect(unknown).toEqual({ kind: "error", message: expect.stringMatching(/^Unknown argument: --force\nUsage: /) });
  });

  it("answers --help and -h", () => {
    expect(parseArgs(["--help"], "/work")).toEqual({ kind: "help" });
    expect(parseArgs(["-h"], "/work")).toEqual({ kind: "help" });
  });
});

describe("readDatabaseUrl", () => {
  it("reads DATABASE_URL only, trimmed", () => {
    expect(readDatabaseUrl({ DATABASE_URL: `  ${URL_WITH_SECRET}\n` })).toEqual({ url: URL_WITH_SECRET });
  });

  it("explains an unset or blank DATABASE_URL, whatever else is set", () => {
    for (const env of [{}, { DATABASE_URL: "" }, { DATABASE_URL: "   " }, { PGHOST: "db", HYPERDRIVE: "x" }]) {
      const result = readDatabaseUrl(env);
      expect(result).toEqual({ error: expect.stringMatching(/^DATABASE_URL is not set\. .* Nothing was done\.$/) });
    }
  });
});

describe("redact", () => {
  it("removes the connection string, its password in both encodings, and other URL credentials", () => {
    const text = [
      `connecting to ${URL_WITH_SECRET}`,
      "password p%40ss%2Fw0rd or p@ss/w0rd",
      "other: postgresql://admin:hunter2@10.0.0.1/db",
    ].join("\n");
    const out = redact(text, URL_WITH_SECRET);
    expect(out).not.toContain("p%40ss%2Fw0rd");
    expect(out).not.toContain("p@ss/w0rd");
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("db.example.com");
    expect(out).toBe(
      ["connecting to <DATABASE_URL>", "password <password> or <password>", "other: postgresql://<credentials>@10.0.0.1/db"].join(
        "\n",
      ),
    );
  });

  it("leaves text without credentials as it is", () => {
    expect(redact('relation "x" does not exist', URL_WITH_SECRET)).toBe('relation "x" does not exist');
    expect(redact("no url given", undefined)).toBe("no url given");
  });
});

describe("pendingMigrations (the migrator's own rule)", () => {
  const migrations = [{ when: 100 }, { when: 200 }, { when: 300 }];

  it("is everything when nothing is applied yet", () => {
    expect(pendingMigrations(migrations, null)).toEqual(migrations);
    expect(pendingMigrations(migrations, undefined)).toEqual(migrations);
  });

  it("is what comes after the latest applied created_at (a bigint string from the driver)", () => {
    expect(pendingMigrations(migrations, "200")).toEqual([{ when: 300 }]);
    expect(pendingMigrations(migrations, 300)).toEqual([]);
    expect(pendingMigrations(migrations, "150")).toEqual([{ when: 200 }, { when: 300 }]);
  });
});

// A two-statement-plus migration with known line numbers:
//   1 CREATE TABLE a (id int);
//   2 --> statement-breakpoint
//   3 CREATE TABLE b (
//   4   id int,
//   5   x nope
//   6 );
//   7 --> statement-breakpoint
//   8 SELECT 1;
const FILE = "CREATE TABLE a (id int);\n--> statement-breakpoint\nCREATE TABLE b (\n  id int,\n  x nope\n);\n--> statement-breakpoint\nSELECT 1;";
const MIGRATION: MigrationFile = { tag: "0007_example", when: 700, statements: FILE.split("--> statement-breakpoint") };
const FAILING = MIGRATION.statements[1]!;

function serverError(fields: Record<string, string>, query: string): DrizzleQueryError {
  // The shape the migrator throws: drizzle's DrizzleQueryError around the
  // driver's PostgresError.
  return new DrizzleQueryError(query, [], new postgres.PostgresError({ severity: "ERROR", ...fields } as never));
}

describe("formatMigrationError", () => {
  it("names the migration, statement, file line and SQLSTATE, and prints the statement", () => {
    const position = String(FAILING.indexOf("nope") + 1);
    const error = serverError(
      { message: 'type "nope" does not exist', code: "42704", position, hint: "Check the type name." },
      FAILING,
    );
    const out = formatMigrationError(error, { pending: [MIGRATION], all: [MIGRATION] }, URL_WITH_SECRET);
    expect(out.split("\n")).toEqual([
      "Migration failed; nothing from this run was applied (pending migrations run in one transaction, rolled back on error).",
      "  migration: 0007_example.sql (statement 2 of 3)",
      '  error:     type "nope" does not exist',
      "  code:      42704 (SQLSTATE)",
      "  hint:      Check the type name.",
      `  at:        0007_example.sql line 5 (character ${position} of the statement)`,
      "  statement:",
      "    CREATE TABLE b (",
      "      id int,",
      "      x nope",
      "    );",
    ]);
  });

  it("prints detail, where and the objects involved when the server sends them", () => {
    const error = serverError(
      {
        message: 'could not create unique index "coupons_one_active_per_country_idx"',
        code: "23505",
        detail: "Key (campaign_id, country_code)=(c1, IN) is duplicated.",
        where: "SQL statement",
        schema_name: "public",
        table_name: "coupons",
        constraint_name: "coupons_one_active_per_country_idx",
      },
      MIGRATION.statements[2]!,
    );
    const out = formatMigrationError(error, { pending: [MIGRATION], all: [MIGRATION] }, URL_WITH_SECRET);
    expect(out).toContain("  migration: 0007_example.sql (statement 3 of 3)");
    // No position from the server: the line where the statement starts (line 8).
    expect(out).toContain("  at:        0007_example.sql line 8 (start of the statement)");
    expect(out).toContain("  detail:    Key (campaign_id, country_code)=(c1, IN) is duplicated.");
    expect(out).toContain("  where:     SQL statement");
    expect(out).toContain("  object:    schema public, table coupons, constraint coupons_one_active_per_country_idx");
  });

  it("still prints a statement it cannot place in a migration file (the migrator's bookkeeping)", () => {
    const error = serverError({ message: "permission denied for database gopaylocal", code: "42501" }, 'CREATE SCHEMA IF NOT EXISTS "drizzle"');
    const out = formatMigrationError(error, { pending: [MIGRATION], all: [MIGRATION] }, URL_WITH_SECRET);
    expect(out).not.toContain("migration:");
    expect(out).toContain("  code:      42501 (SQLSTATE)");
    expect(out).toContain('    CREATE SCHEMA IF NOT EXISTS "drizzle"');
  });

  it("truncates a very long statement", () => {
    const long = `\nINSERT INTO t VALUES ${"(1),".repeat(2000)}(1);`;
    const out = formatMigrationError(serverError({ message: "boom", code: "XX000" }, long), { pending: [], all: [] }, undefined);
    expect(out).toContain("… (truncated)");
    expect(out.length).toBeLessThan(4400);
  });

  it("reports a connection failure as such, without a statement", () => {
    const refused = Object.assign(
      new AggregateError([new Error("connect ECONNREFUSED ::1:5432"), new Error("connect ECONNREFUSED 127.0.0.1:5432")]),
      { code: "ECONNREFUSED" },
    );
    expect(formatMigrationError(refused, { pending: [], all: [] }, URL_WITH_SECRET)).toBe(
      [
        "Could not connect to the database; nothing was applied.",
        "  error:     connect ECONNREFUSED ::1:5432; connect ECONNREFUSED 127.0.0.1:5432",
        "  code:      ECONNREFUSED",
      ].join("\n"),
    );

    const auth = serverError(
      { message: 'password authentication failed for user "deployer"', code: "28P01" },
      "select to_regclass($1)::text as exists",
    );
    expect(formatMigrationError(auth, { pending: [], all: [] }, URL_WITH_SECRET)).toBe(
      [
        "Could not connect to the database; nothing was applied.",
        '  error:     password authentication failed for user "deployer"',
        "  code:      28P01 (SQLSTATE)",
      ].join("\n"),
    );
  });

  it("reports an error that did not come from the server", () => {
    const out = formatMigrationError(new Error("self-signed certificate"), { pending: [], all: [] }, URL_WITH_SECRET);
    expect(out.split("\n")[0]).toBe("Migration run failed without an error from the database server.");
    expect(out).toContain("  error:     self-signed certificate");
  });

  it("never prints the connection string, even when an error message carries it", () => {
    const error = serverError({ message: `bad thing near ${URL_WITH_SECRET}`, code: "XX000" }, FAILING);
    const out = formatMigrationError(error, { pending: [MIGRATION], all: [MIGRATION] }, URL_WITH_SECRET);
    expect(out).toContain("bad thing near <DATABASE_URL>");
    expect(out).not.toContain("p%40ss");
    expect(out).not.toContain("db.example.com");
    const plain = formatMigrationError(new Error(`cannot reach ${URL_WITH_SECRET}`), { pending: [], all: [] }, URL_WITH_SECRET);
    expect(plain).not.toContain("p%40ss");
  });
});

describe("isConnectFailure", () => {
  it("covers driver connect errors and the connection-phase SQLSTATEs only", () => {
    for (const code of ["ECONNREFUSED", "ENOTFOUND", "CONNECT_TIMEOUT", "08006", "28P01", "28000", "3D000", "53300", "57P03"]) {
      expect(isConnectFailure(code), code).toBe(true);
    }
    for (const code of [undefined, "42P01", "23505", "42501", "XX000", "ECONNRESET"]) {
      expect(isConnectFailure(code), String(code)).toBe(false);
    }
  });
});

describe("notices and the success line", () => {
  it("skips only the migrator's two bookkeeping notices", () => {
    expect(isBookkeepingNotice('schema "drizzle" already exists, skipping')).toBe(true);
    expect(isBookkeepingNotice('relation "__drizzle_migrations" already exists, skipping')).toBe(true);
    expect(
      isBookkeepingNotice('constraint "coupons_integration_id_integrations_id_fk" of relation "coupons" does not exist, skipping'),
    ).toBe(false);
    expect(isBookkeepingNotice(undefined)).toBe(false);
  });

  it("says what was applied, or that there was nothing to apply", () => {
    expect(describeApplied([], "0002_oss_launch")).toBe("Nothing to apply: the database is up to date (latest: 0002_oss_launch).");
    expect(describeApplied([], null)).toBe("Nothing to apply: the database is up to date.");
    expect(describeApplied(["0002_oss_launch"], "0002_oss_launch")).toBe("Applied 1 migration: 0002_oss_launch.");
    expect(describeApplied(["0000_init", "0001_x"], "0001_x")).toBe("Applied 2 migrations: 0000_init, 0001_x.");
  });
});

describe("running the script", () => {
  // No DATABASE_URL and no PG* variables: every run below stops before connecting.
  const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
  const run = (...args: string[]) => spawnSync(TSX, [SCRIPT, ...args], { cwd: API_DIR, env, encoding: "utf8", timeout: 30_000 });

  it("exits 2 with a clear message when DATABASE_URL is not set", () => {
    const result = run();
    expect(result.status).toBe(2);
    expect(result.stderr.trim()).toBe(
      "DATABASE_URL is not set. Set it to the connection string of the database to migrate " +
        "(postgres://user:password@host:5432/database). Nothing was done.",
    );
    expect(result.stdout).toBe("");
  }, 30_000);

  it("exits 2 on an unknown argument, before reading DATABASE_URL", () => {
    const result = run("--yes");
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/^Unknown argument: --yes\nUsage: /);
  }, 30_000);

  it("does not run when imported (this file imported it above)", () => {
    expect(process.exitCode ?? 0).toBe(0);
  });
});
