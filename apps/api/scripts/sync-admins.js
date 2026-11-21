/**
 * Syncs admin roles from ADMIN_EMAILS env var to the database.
 * Runs during deploy after migrations (`deploy:full` in apps/api/package.json).
 *
 * - Emails in ADMIN_EMAILS get role='admin'
 * - Users who previously had admin but are no longer in the list get role revoked
 *
 * Environment:
 *   DATABASE_URL   Postgres connection string (required; the script skips without it)
 *   ADMIN_EMAILS   comma-separated emails (required; the script skips when empty)
 *   DATABASE_SSL   optional TLS override: disable | require | verify-full
 *                  (also accepted: allow, prefer, true, false)
 *
 * TLS, first match wins (see resolveSsl):
 *   1. DATABASE_SSL, when set.
 *   2. `sslmode` in DATABASE_URL, or the PGSSLMODE env var: left to the postgres
 *      driver, which reads both (same as drizzle-kit for migrations).
 *   3. A loopback host (localhost, 127.0.0.1, ::1): no TLS. Traffic stays on the
 *      machine, and the docker-compose database has no TLS.
 *   4. Anything else: "require" (encrypted; the server certificate is not
 *      verified). Use DATABASE_SSL=verify-full to verify it.
 */
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import postgres from "postgres";

const SSL_VALUES = {
  disable: false,
  false: false,
  allow: "allow",
  prefer: "prefer",
  require: "require",
  true: "require",
  "verify-full": "verify-full",
};

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Decide the `ssl` option for postgres(). Returns false (no TLS), a postgres.js
 * sslmode string, or undefined (pass nothing, so the driver applies sslmode from
 * the URL or PGSSLMODE). Throws on an unknown DATABASE_SSL value.
 *
 * @param {string} databaseUrl
 * @param {Record<string, string | undefined>} env
 * @returns {false | "allow" | "prefer" | "require" | "verify-full" | undefined}
 */
export function resolveSsl(databaseUrl, env) {
  const override = env.DATABASE_SSL?.trim().toLowerCase();
  if (override) {
    if (!Object.hasOwn(SSL_VALUES, override)) {
      throw new Error(
        `DATABASE_SSL=${JSON.stringify(env.DATABASE_SSL)} is not one of: ${Object.keys(SSL_VALUES).join(", ")}`,
      );
    }
    return SSL_VALUES[override];
  }

  let url;
  try {
    url = new URL(databaseUrl);
  } catch {
    // Not a URL (e.g. a key=value DSN): keep the old safe default.
    return "require";
  }
  if (url.searchParams.has("sslmode") || env.PGSSLMODE?.trim()) return undefined;
  if (LOOPBACK_HOSTS.has(url.hostname)) return false;
  return "require";
}

/**
 * @param {Record<string, string | undefined>} env
 */
async function main(env) {
  const databaseUrl = env.DATABASE_URL;
  const adminEmailsRaw = env.ADMIN_EMAILS || "";

  if (!databaseUrl) {
    console.log("DATABASE_URL not set, skipping admin sync.");
    return 0;
  }

  const adminEmails = adminEmailsRaw
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  if (adminEmails.length === 0) {
    console.log("ADMIN_EMAILS is empty, skipping admin sync.");
    return 0;
  }

  let ssl;
  try {
    ssl = resolveSsl(databaseUrl, env);
  } catch (err) {
    console.error("Admin sync failed:", err.message);
    return 1;
  }

  const sql = postgres(databaseUrl, { ssl });

  try {
    // Promote users in the list
    const promoted = await sql`
      UPDATE "user" SET role = 'admin'
      WHERE LOWER(email) IN ${sql(adminEmails)}
      AND (role IS NULL OR role != 'admin')
    `;
    console.log(`Admin sync: promoted ${promoted.count} user(s).`);

    // Revoke admin from users no longer in the list
    const revoked = await sql`
      UPDATE "user" SET role = NULL
      WHERE role = 'admin'
      AND LOWER(email) NOT IN ${sql(adminEmails)}
    `;
    console.log(`Admin sync: revoked ${revoked.count} user(s).`);
    return 0;
  } catch (err) {
    console.error("Admin sync failed:", err.message);
    return 1;
  } finally {
    await sql.end();
  }
}

// Run only when executed directly (`node scripts/sync-admins.js`), not when
// imported by the unit test for resolveSsl.
function invokedPath() {
  try {
    return process.argv[1] ? realpathSync(resolve(process.argv[1])) : "";
  } catch {
    return "";
  }
}
const entry = invokedPath();
if (entry && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = await main(process.env);
}
