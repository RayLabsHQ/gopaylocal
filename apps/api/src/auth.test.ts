import { describe, it, expect } from "vitest";
import { createAuth } from "./auth";
import { createTestBindings } from "./test/helpers";

// Locks the email/password security boundary: public email sign-up must stay
// disabled on every worker code path (createAuth is always called without opts
// in the worker — see routes/auth.ts and middleware/session.ts). Only the local
// seeding script (scripts/create-test-user.ts) may opt in to sign-up.
describe("createAuth email/password gating", () => {
  it("disables public email sign-up by default", () => {
    const auth = createAuth(createTestBindings());
    expect(auth.options.emailAndPassword?.enabled).toBe(true);
    expect(auth.options.emailAndPassword?.disableSignUp).toBe(true);
  });

  it("allows sign-up only when explicitly requested (local seeding script)", () => {
    const auth = createAuth(createTestBindings(), { allowEmailSignUp: true });
    expect(auth.options.emailAndPassword?.disableSignUp).toBe(false);
  });
});

// Better Auth 1.7 checks the drizzle schema before every request and every
// auth.api.* call (advanced.database.validateSchema, on by default) and fails
// all of them on a mismatch. The drizzle adapter compares src/db/schema.ts with
// the columns Better Auth and its plugins expect, without opening a connection,
// so a missing column (organization.metadata was one) fails here, not in production.
describe("createAuth sign-in tokens", () => {
  it("encrypts the GitHub and Google tokens it stores", () => {
    expect(createAuth(createTestBindings()).options.account?.encryptOAuthTokens).toBe(true);
  });
});

describe("createAuth drizzle schema check", () => {
  // Unreachable on purpose: the check must not need a database.
  const offline = () =>
    createTestBindings({
      HYPERDRIVE: { connectionString: "postgresql://offline:offline@127.0.0.1:9/offline_test" } as Hyperdrive,
    });

  it("keeps runtime schema validation on", async () => {
    const ctx = await createAuth(offline()).$context;
    expect(ctx.checkSchema).toBeTypeOf("function");
  });

  it("finds every column Better Auth and its plugins expect in src/db/schema.ts", async () => {
    const ctx = await createAuth(offline()).$context;
    await expect(Promise.resolve(ctx.checkSchema?.())).resolves.toBeUndefined();
  });

  it("lets a request through the check (get-session without a cookie reads no table)", async () => {
    const auth = createAuth(offline());
    const res = await auth.handler(new Request(`${auth.options.baseURL}/api/auth/get-session`));
    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();
  });
});
