import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { is, sql } from "drizzle-orm";
import { PgTable, getTableConfig, type PgColumn } from "drizzle-orm/pg-core";
import * as schema from "../db/schema";
import { createAuth } from "../auth";
import { createTestBindings } from "./helpers";
import { closeTestDb, getTestDb } from "./setup";

/*
 * The code is written against src/db/schema.ts, but production gets its tables
 * from the SQL files in apps/api/drizzle, applied on deploy. CI's integration
 * job builds its database the same way (`pnpm db:test:migrate`). Nothing else
 * checks that the two agree. A column added to schema.ts without a migration
 * passes the unit tests, Better Auth's offline schema check (auth.test.ts) and
 * every integration test that doesn't touch it, then fails in production. So
 * these tests compare the live test database with schema.ts.
 *
 * Against a database built by `drizzle-kit push` they pass trivially. Against
 * a migrated one (CI, and the pre-release migration check) they catch drift.
 * They only read the catalog, so they need no cleanup between tests.
 */

type DbColumn = { table: string; column: string; type: string; not_null: boolean; has_default: boolean };
type DbIndex = { table: string; name: string; def: string };
type DbConstraint = { table: string; name: string; type: string; def: string };
type DbPrimaryKey = { table: string; column: string };

const tables = Object.entries(schema as Record<string, unknown>)
  .filter((entry): entry is [string, PgTable] => is(entry[1], PgTable))
  .map(([key, table]) => ({ key, table, config: getTableConfig(table) }));

/** Postgres's spelling (format_type) of the SQL type drizzle-kit emits for a column. */
function pgType(column: PgColumn): string {
  const type = column.getSQLType();
  const precision = /^timestamp(\(\d+\))?( with time zone)?$/.exec(type);
  if (precision) return `timestamp${precision[1] ?? ""} ${precision[2] ? "with" : "without"} time zone`;
  if (type === "serial") return "integer";
  if (type === "bigserial") return "bigint";
  if (type.startsWith("varchar")) return type.replace("varchar", "character varying");
  return type.replace(/,\s+/g, ",");
}

let columns: DbColumn[] = [];
let indexes: DbIndex[] = [];
let constraints: DbConstraint[] = [];
let primaryKeys: DbPrimaryKey[] = [];

const columnsOf = (table: string) => columns.filter((c) => c.table === table);

beforeAll(async () => {
  const db = getTestDb();
  columns = Array.from(
    await db.execute<DbColumn>(sql`
      SELECT c.relname AS "table", a.attname AS "column",
             format_type(a.atttypid, a.atttypmod) AS "type",
             a.attnotnull AS not_null,
             (a.atthasdef OR a.attidentity <> '' OR a.attgenerated <> '') AS has_default
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped`),
  );
  indexes = Array.from(
    await db.execute<DbIndex>(sql`
      SELECT tablename AS "table", indexname AS name, indexdef AS def
      FROM pg_indexes WHERE schemaname = 'public'`),
  );
  constraints = Array.from(
    await db.execute<DbConstraint>(sql`
      SELECT rel.relname AS "table", con.conname AS name, con.contype::text AS "type",
             pg_get_constraintdef(con.oid) AS def
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = con.connamespace
      WHERE n.nspname = 'public'`),
  );
  primaryKeys = Array.from(
    await db.execute<DbPrimaryKey>(sql`
      SELECT c.relname AS "table", a.attname AS "column"
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
      WHERE i.indisprimary AND n.nspname = 'public'`),
  );
});

afterAll(async () => {
  await closeTestDb();
});

describe("the database matches src/db/schema.ts", () => {
  it("has the schema's tables at all (sanity: the catalog queries return rows)", () => {
    expect(tables.length).toBeGreaterThan(10);
    expect(columns.length).toBeGreaterThan(100);
    expect(tables.map((t) => t.config.name)).toEqual(expect.arrayContaining(["user", "products", "campaigns"]));
  });

  it("has every table and column, with the same type, nullability and default, and nothing extra", () => {
    const problems: string[] = [];
    for (const { config } of tables) {
      const inDb = columnsOf(config.name);
      if (inDb.length === 0) {
        problems.push(`${config.name}: table missing from the database`);
        continue;
      }
      const compositePk = new Set(config.primaryKeys.flatMap((pk) => pk.columns.map((c) => c.name)));
      for (const column of config.columns) {
        const actual = inDb.find((c) => c.column === column.name);
        const where = `${config.name}.${column.name}`;
        if (!actual) {
          problems.push(`${where}: missing from the database`);
          continue;
        }
        if (actual.type !== pgType(column)) {
          problems.push(`${where}: type is ${actual.type} in the database, ${pgType(column)} in schema.ts`);
        }
        const notNull = column.notNull || compositePk.has(column.name);
        if (actual.not_null !== notNull) {
          problems.push(`${where}: ${actual.not_null ? "NOT NULL" : "nullable"} in the database, ${notNull ? "NOT NULL" : "nullable"} in schema.ts`);
        }
        // `.default()` / `.defaultNow()` are DB defaults that drizzle relies on when
        // an insert omits the column; `$defaultFn` runs in JS and leaves none.
        const hasDefault = column.default !== undefined;
        if (actual.has_default !== hasDefault) {
          problems.push(`${where}: ${actual.has_default ? "has" : "has no"} default in the database, ${hasDefault ? "has" : "has no"} DB default in schema.ts`);
        }
      }
      for (const actual of inDb) {
        if (!config.columns.some((c) => c.name === actual.column)) {
          problems.push(`${config.name}.${actual.column}: in the database but not in schema.ts`);
        }
      }
    }
    const known = new Set(tables.map((t) => t.config.name));
    for (const table of new Set(columns.map((c) => c.table))) {
      if (!known.has(table)) problems.push(`${table}: table in the database but not in schema.ts`);
    }
    expect(problems).toEqual([]);
  });

  it("has every primary key, index, unique constraint and foreign key (with its ON DELETE rule)", () => {
    const problems: string[] = [];
    const constraintNamed = (table: string, name: string, type: string) =>
      constraints.find((c) => c.table === table && c.name === name && c.type === type);

    for (const { config } of tables) {
      const table = config.name;

      const expectedPk = new Set([
        ...config.columns.filter((c) => c.primary).map((c) => c.name),
        ...config.primaryKeys.flatMap((pk) => pk.columns.map((c) => c.name)),
      ]);
      const actualPk = new Set(primaryKeys.filter((p) => p.table === table).map((p) => p.column));
      if ([...expectedPk].sort().join(",") !== [...actualPk].sort().join(",")) {
        problems.push(`${table}: primary key is (${[...actualPk].join(", ")}) in the database, (${[...expectedPk].join(", ")}) in schema.ts`);
      }

      for (const index of config.indexes) {
        const { name, unique, where } = index.config;
        if (!name) {
          problems.push(`${table}: an index in schema.ts has no name, so drizzle-kit invents one; name it`);
          continue;
        }
        const actual = indexes.find((i) => i.table === table && i.name === name);
        if (!actual) {
          problems.push(`${table}: index ${name} missing from the database`);
          continue;
        }
        if (/^CREATE UNIQUE INDEX/.test(actual.def) !== !!unique) {
          problems.push(`${table}: index ${name} is ${unique ? "" : "not "}unique in schema.ts but not in the database: ${actual.def}`);
        }
        if (/ WHERE /.test(actual.def) !== !!where) {
          problems.push(`${table}: index ${name} is ${where ? "" : "not "}partial in schema.ts but not in the database: ${actual.def}`);
        }
      }

      const uniques = [
        // drizzle fills in a default name for both, so these are never undefined at runtime.
        ...config.columns.filter((c) => c.isUnique).map((c) => ({ name: c.uniqueName ?? "", nnd: c.uniqueType === "not distinct" })),
        ...config.uniqueConstraints.map((u) => ({ name: u.getName() ?? "", nnd: u.nullsNotDistinct })),
      ];
      for (const { name, nnd } of uniques) {
        const actual = constraintNamed(table, name, "u");
        if (!actual) {
          problems.push(`${table}: unique constraint ${name} missing from the database`);
        } else if (actual.def.includes("NULLS NOT DISTINCT") !== nnd) {
          problems.push(`${table}: unique constraint ${name} differs on NULLS NOT DISTINCT: ${actual.def}`);
        }
      }

      for (const fk of config.foreignKeys) {
        const name = fk.getName();
        const actual = constraintNamed(table, name, "f");
        if (!actual) {
          problems.push(`${table}: foreign key ${name} missing from the database`);
          continue;
        }
        const rule = (fk.onDelete ?? "no action").toUpperCase();
        const actualRule = /ON DELETE (CASCADE|RESTRICT|SET NULL|SET DEFAULT)/.exec(actual.def)?.[1] ?? "NO ACTION";
        if (actualRule !== rule) {
          problems.push(`${table}: foreign key ${name} is ON DELETE ${actualRule} in the database, ${rule} in schema.ts`);
        }
      }

      const declaredIndexes = new Set<string | undefined>(config.indexes.map((i) => i.config.name));
      const constraintNames = new Set(constraints.filter((c) => c.table === table).map((c) => c.name));
      for (const actual of indexes.filter((i) => i.table === table)) {
        if (!declaredIndexes.has(actual.name) && !constraintNames.has(actual.name)) {
          problems.push(`${table}: index ${actual.name} in the database but not in schema.ts: ${actual.def}`);
        }
      }
      const declaredFks = new Set(config.foreignKeys.map((fk) => fk.getName()));
      for (const actual of constraints.filter((c) => c.table === table && c.type === "f")) {
        if (!declaredFks.has(actual.name)) {
          problems.push(`${table}: foreign key ${actual.name} in the database but not in schema.ts: ${actual.def}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});

describe("the database satisfies Better Auth", () => {
  // Better Auth 1.7 checks schema.ts, not the database (see auth.test.ts). This
  // repeats its rules (@better-auth/core's getExpectedSchema + diffSchema)
  // against the real tables: every column it writes exists, and every column it
  // does not write accepts an insert that omits it.
  it("has every table and column Better Auth and its plugins write, and no NOT NULL column it leaves out", async () => {
    const ctx = await createAuth(createTestBindings()).$context;
    const expected = new Map<string, { fields: Set<string>; skip: boolean }>();
    for (const table of Object.values(ctx.tables)) {
      // auth.ts passes usePlural: true to the drizzle adapter.
      const key = `${table.modelName}s`;
      const entry = expected.get(key) ?? { fields: new Set(["id"]), skip: true };
      for (const [name, field] of Object.entries(table.fields)) entry.fields.add(field.fieldName || name);
      entry.skip = entry.skip && !!table.disableMigrations;
      expected.set(key, entry);
    }
    expect(expected.has("users") && expected.has("organizations")).toBe(true);

    const problems: string[] = [];
    for (const [key, { fields, skip }] of expected) {
      if (skip) continue;
      const drizzleTable = (schema as Record<string, unknown>)[key];
      if (!is(drizzleTable, PgTable)) {
        problems.push(`${key}: Better Auth writes this table but schema.ts exports no such table`);
        continue;
      }
      const tableName = getTableConfig(drizzleTable).name;
      const written = new Set<string>();
      for (const field of fields) {
        const column = (drizzleTable as unknown as Record<string, PgColumn | undefined>)[field];
        if (!column) {
          problems.push(`${key}.${field}: Better Auth writes it but schema.ts has no such column`);
          continue;
        }
        written.add(column.name);
        if (!columnsOf(tableName).some((c) => c.column === column.name)) {
          problems.push(`${tableName}.${column.name}: Better Auth writes ${key}.${field} but the database has no such column`);
        }
      }
      for (const actual of columnsOf(tableName)) {
        if (!written.has(actual.column) && actual.not_null && !actual.has_default) {
          problems.push(`${tableName}.${actual.column}: NOT NULL with no default, and Better Auth never writes it, so its inserts into ${tableName} fail`);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});
