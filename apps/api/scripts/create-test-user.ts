/**
 * One-off LOCAL script to seed a credentials-based test user.
 * Never deployed — kept in scripts/ which is outside src/ and excluded from the
 * worker build (wrangler entry is src/index.ts).
 *
 * Usage:
 *   cd apps/api && \
 *     DATABASE_URL="postgresql://..." \
 *     BETTER_AUTH_SECRET="..." \
 *     TEST_USER_EMAIL="test@example.com" \
 *     TEST_USER_PASSWORD="..." \
 *     TEST_USER_NAME="Test User" \
 *     pnpm tsx scripts/create-test-user.ts
 */

import { createAuth } from "../src/auth.js";

const required = [
  "DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "TEST_USER_EMAIL",
  "TEST_USER_PASSWORD",
  "TEST_USER_NAME",
] as const;

const missing = required.filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error("Missing required environment variables:", missing.join(", "));
  process.exit(1);
}

const email = process.env.TEST_USER_EMAIL!;
const password = process.env.TEST_USER_PASSWORD!;
const name = process.env.TEST_USER_NAME!;

// Build minimal env object matching what createAuth reads from Bindings.
// HYPERDRIVE is accessed only for .connectionString; other fields are typed to
// satisfy the Bindings type without Cloudflare runtime objects.
const env = {
  HYPERDRIVE: { connectionString: process.env.DATABASE_URL! } as Hyperdrive,
  CACHE: undefined as unknown as KVNamespace,
  VPN_DATA: undefined as unknown as KVNamespace,
  BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET!,
  DODO_API_KEY: "",
  DODO_WEBHOOK_SECRET: "",
};

const auth = createAuth(env, { allowEmailSignUp: true });

try {
  const result = await auth.api.signUpEmail({
    body: { name, email, password },
  });
  if (!result) {
    console.error("Sign-up returned null — user may already exist.");
    process.exit(1);
  }
  console.log(`Test user created: ${email}`);
  // postgres-js keeps its pool open, so node would hang here — exit explicitly.
  process.exit(0);
} catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  console.error("Failed to create test user:", message);
  process.exit(1);
}
