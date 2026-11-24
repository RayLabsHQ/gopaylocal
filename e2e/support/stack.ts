import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The local stack the e2e suite drives, and how it seeds accounts.
 * See e2e/README.md for how to start that stack safely.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Where the API Worker runs under `wrangler dev`. */
export const API_URL = "http://localhost:8787";
/** Where the dashboard dev server runs (also Playwright's baseURL). */
export const APP_URL = "http://localhost:3000";

/**
 * The database the local API Worker uses: the Hyperdrive localConnectionString
 * in apps/api/wrangler.toml (the docker-compose dev database). Override with
 * E2E_DATABASE_URL if you point the Worker elsewhere, but only ever at a
 * loopback host: seeding writes users and organizations.
 */
export const DEFAULT_E2E_DATABASE_URL = "postgresql://gopaylocal:gopaylocal@localhost:5433/gopaylocal";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function e2eDatabaseUrl(): string {
  const value = process.env.E2E_DATABASE_URL?.trim() || DEFAULT_E2E_DATABASE_URL;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("E2E_DATABASE_URL is not a valid URL.");
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(
      `Refusing to seed e2e accounts into ${url.hostname}: E2E_DATABASE_URL must be a loopback ` +
        "database (the one your local API Worker uses). See e2e/README.md.",
    );
  }
  return value;
}

export interface E2EAccount {
  email: string;
  password: string;
  userId: string;
  orgId: string;
}

/**
 * Seed a fresh password user that owns a fresh organization, directly in the
 * local database (public sign-up is disabled in the API). The password is
 * random per account and never leaves this process except to the child.
 */
export async function seedAccount(label = "E2E"): Promise<E2EAccount> {
  const databaseUrl = e2eDatabaseUrl();
  const suffix = `${Date.now()}-${randomBytes(4).toString("hex")}`;
  const email = `e2e-${suffix}@example.test`;
  const password = randomBytes(24).toString("base64url");

  const stdout = await new Promise<string>((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        "--import",
        resolve(REPO_ROOT, "e2e/support/ts-resolve.mjs"),
        resolve(REPO_ROOT, "e2e/support/seed-user.ts"),
      ],
      {
        cwd: REPO_ROOT,
        // Only what the seed script needs: no inherited secrets.
        env: {
          PATH: process.env.PATH ?? "",
          E2E_DATABASE_URL: databaseUrl,
          E2E_USER_EMAIL: email,
          E2E_USER_PASSWORD: password,
          E2E_USER_NAME: `${label} User`,
          E2E_ORG_NAME: `${label} Org ${suffix}`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise(out);
      else reject(new Error(`seeding the e2e account failed (exit ${code}): ${err.trim()}`));
    });
  });

  const line = stdout.trim().split("\n").reverse().find((l) => l.startsWith("{"));
  if (!line) throw new Error(`seed-user printed no result: ${stdout}`);
  const { userId, orgId } = JSON.parse(line) as { userId: string; orgId: string };
  return { email, password, userId, orgId };
}
