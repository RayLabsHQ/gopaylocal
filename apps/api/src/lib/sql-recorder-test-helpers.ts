// Test-only helper (imported by unit tests, never by the Worker).
//
// A fake `Database` that builds REAL Drizzle queries but never connects. The
// queries come from `drizzle.mock()` with the app schema, so the SQL text and
// parameters recorded here are exactly what production would send to
// Postgres: tests can assert the statement shape (tenant filters, conflict
// targets, bare vs table-qualified identifiers, Date serialization) without a
// database. Awaiting a query records its `toSQL()` and resolves the next
// canned result in order (or rejects, when the canned result is an Error).
// `transaction(fn)` runs `fn` against the same recorder and records whether it
// committed or rolled back (threw).
//
// Only public Drizzle builder APIs are relied on (`toSQL()` and the builders'
// thenable interface), so the helper survives driver/internal changes.

import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../db/schema";
import type { Database } from "../db";

export interface RecordedQuery {
  sql: string;
  params: unknown[];
}

export interface SqlRecorder {
  db: Database;
  /** Every awaited statement, in execution order. */
  queries: RecordedQuery[];
  /** One entry per `transaction()` call. */
  transactions: Array<"commit" | "rollback">;
  /** Canned results still to be consumed (shifted per awaited statement). */
  results: Array<unknown[] | Error>;
}

type Thenable = { toSQL(): RecordedQuery };

function isBuilder(value: unknown): value is Thenable {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { toSQL?: unknown }).toSQL === "function"
  );
}

export function createSqlRecorder(results: Array<unknown[] | Error> = []): SqlRecorder {
  const real = drizzle.mock({ schema }) as unknown as Record<string, (...args: unknown[]) => object>;
  const queries: RecordedQuery[] = [];
  const transactions: Array<"commit" | "rollback"> = [];
  const recorder = { results } as SqlRecorder;

  const wrap = <T extends object>(target: T): T =>
    new Proxy(target, {
      get(obj, prop, receiver) {
        if (prop === "then" && isBuilder(obj)) {
          return (onFulfilled?: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) => {
            queries.push(obj.toSQL());
            const next = recorder.results.shift() ?? [];
            const settled = next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
            return settled.then(onFulfilled, onRejected);
          };
        }
        const value = Reflect.get(obj, prop, receiver);
        if (typeof value !== "function" || prop === "constructor") return value;
        // Call with the proxy as `this` so builder methods that return `this`
        // (and QueryPromise.catch/finally, which call this.then) stay recorded.
        return (...args: unknown[]) => {
          const out = (value as (...a: unknown[]) => unknown).apply(receiver, args);
          return out !== receiver && isBuilder(out) ? wrap(out) : out;
        };
      },
    });

  const db = {
    select: (...args: unknown[]) => wrap(real.select!(...args)),
    selectDistinct: (...args: unknown[]) => wrap(real.selectDistinct!(...args)),
    insert: (...args: unknown[]) => wrap(real.insert!(...args)),
    update: (...args: unknown[]) => wrap(real.update!(...args)),
    delete: (...args: unknown[]) => wrap(real.delete!(...args)),
    async transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      try {
        const out = await fn(db);
        transactions.push("commit");
        return out;
      } catch (err) {
        transactions.push("rollback");
        throw err;
      }
    },
  };

  recorder.db = db as unknown as Database;
  recorder.queries = queries;
  recorder.transactions = transactions;
  return recorder;
}
