import { randomBytes } from "node:crypto";
import { ulid } from "ulid";
import type { Bindings } from "../bindings";
import { createAuth } from "../auth";
import { members, organizations } from "../db/schema";
import type { TestClient } from "./helpers";
import { getTestDb } from "./setup";

/**
 * Helpers for full-app tests: real users, real Better Auth sessions, real
 * session + team middleware. Public email sign-up is disabled in the Worker
 * (auth.ts), so users are seeded the same way scripts/create-test-user.ts
 * does it: a Better Auth instance created with allowEmailSignUp. They then
 * sign in through the Worker's own /api/auth/sign-in/email route.
 */

/** An origin Better Auth trusts (auth.ts trustedOrigins), sent like a browser would. */
export const DASHBOARD_ORIGIN = "http://localhost:3000";

export interface TestUser {
  id: string;
  email: string;
  password: string;
}

export async function seedUser(env: Bindings, name = "Test User"): Promise<TestUser> {
  const email = `user-${ulid().toLowerCase()}@example.test`;
  const password = randomBytes(24).toString("base64url");
  const auth = createAuth(env, { allowEmailSignUp: true });
  const result = await auth.api.signUpEmail({ body: { name, email, password } });
  return { id: result.user.id, email, password };
}

/**
 * Sign in through the Worker and return a Cookie header value carrying the
 * session cookies it set.
 */
export async function signIn(client: TestClient, user: TestUser): Promise<string> {
  const res = await client.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { origin: DASHBOARD_ORIGIN },
    json: { email: user.email, password: user.password },
  });
  if (res.status !== 200) {
    throw new Error(`sign-in failed with ${res.status}: ${await res.text()}`);
  }
  const cookies = res.headers.getSetCookie().map((c) => c.split(";")[0]!.trim());
  if (cookies.length === 0) throw new Error("sign-in set no cookies");
  return cookies.join("; ");
}

/** Insert an organization and make `ownerId` its owner. Returns the org id. */
export async function seedOrg(ownerId: string, name = "Test Org"): Promise<string> {
  const db = getTestDb();
  const id = ulid();
  await db.insert(organizations).values({ id, name, slug: `org-${id.toLowerCase()}` });
  await addMember(id, ownerId, "owner");
  return id;
}

export async function addMember(orgId: string, userId: string, role: "owner" | "admin" | "member") {
  await getTestDb()
    .insert(members)
    .values({ id: ulid(), organizationId: orgId, userId, role });
}

/** A signed-in owner of a fresh organization. */
export interface TestTenant {
  user: TestUser;
  orgId: string;
  cookie: string;
}

export async function seedTenant(client: TestClient, name: string): Promise<TestTenant> {
  const user = await seedUser(client.env, `${name} Owner`);
  const orgId = await seedOrg(user.id, name);
  const cookie = await signIn(client, user);
  return { user, orgId, cookie };
}

/**
 * Request headers for an authenticated dashboard call: the session cookie plus
 * the dashboard Origin, as a browser sends them. Better Auth rejects
 * cookie-bearing POSTs to its own routes without a trusted Origin (403
 * INVALID_ORIGIN / MISSING_OR_NULL_ORIGIN). That check is live in tests too:
 * auth.ts pins advanced.disableOriginCheck: false, overriding Better Auth's
 * NODE_ENV=test default of skipping it. http://localhost:3000 is trusted here
 * because test requests go to http://localhost (a loopback API URL).
 */
export function as(tenant: Pick<TestTenant, "cookie">, extra?: Record<string, string>) {
  return { cookie: tenant.cookie, origin: DASHBOARD_ORIGIN, ...extra };
}
