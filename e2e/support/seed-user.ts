/**
 * Seeds one e2e account: a password user (created the way
 * apps/api/scripts/create-test-user.ts does it, through a Better Auth instance
 * with allowEmailSignUp, because public sign-up is disabled in the Worker), an
 * organization, and the user's owner membership. Prints { userId, orgId } as
 * JSON on stdout.
 *
 * Spawned by e2e/support/stack.ts (never imported by Playwright). Runs under
 * plain Node with the API's TypeScript resolve hook:
 *   node --import ./e2e/support/ts-resolve.mjs \
 *     e2e/support/seed-user.ts
 *
 * Input (environment): E2E_DATABASE_URL (validated loopback by the parent and
 * again here), E2E_USER_EMAIL, E2E_USER_PASSWORD, E2E_USER_NAME, E2E_ORG_NAME.
 */

// Only node builtins and API source here: pnpm does not hoist the API's
// dependencies to the repo root, but the API files resolve their own imports.
import { randomBytes, randomUUID } from "node:crypto";
import { createAuth } from "../../apps/api/src/auth.ts";
import type { Bindings } from "../../apps/api/src/bindings.ts";
import { createDb } from "../../apps/api/src/db/index.ts";
import { members, organizations } from "../../apps/api/src/db/schema.ts";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    process.stderr.write(`seed-user: missing ${name}\n`);
    process.exit(2);
  }
  return value;
}

const databaseUrl = requireEnv("E2E_DATABASE_URL");
if (!LOOPBACK_HOSTS.has(new URL(databaseUrl).hostname)) {
  process.stderr.write("seed-user: E2E_DATABASE_URL must point at a loopback host\n");
  process.exit(2);
}
const email = requireEnv("E2E_USER_EMAIL");
const password = requireEnv("E2E_USER_PASSWORD");
const name = requireEnv("E2E_USER_NAME");
const orgName = requireEnv("E2E_ORG_NAME");

// Only what createAuth reads. The signing secret is a throwaway: sign-up here
// only writes the user + credential rows; the browser later signs in through
// the running API, which signs its own cookies with its own secret.
const env = {
  HYPERDRIVE: { connectionString: databaseUrl },
  CACHE: undefined,
  VPN_DATA: undefined,
  BETTER_AUTH_SECRET: randomBytes(32).toString("base64url"),
  DODO_API_KEY: "",
  DODO_WEBHOOK_SECRET: "",
} as unknown as Bindings;

try {
  const auth = createAuth(env, { allowEmailSignUp: true });
  const result = await auth.api.signUpEmail({ body: { name, email, password } });
  const userId = result.user.id;

  const db = createDb(env);
  const orgId = randomUUID();
  await db.insert(organizations).values({ id: orgId, name: orgName, slug: `e2e-${orgId}` });
  await db.insert(members).values({ id: randomUUID(), organizationId: orgId, userId, role: "owner" });

  process.stdout.write(`${JSON.stringify({ userId, orgId })}\n`);
  // postgres-js pools keep the process alive; exit explicitly.
  process.exit(0);
} catch (err) {
  process.stderr.write(`seed-user: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
