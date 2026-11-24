import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import type { AppEnv, Bindings } from "../bindings";
import { createTestBindings } from "../test/helpers";
import billingRoute from "./billing";

// Only paths that return before touching the database are exercised here
// (self-hosted gating and request validation). Plan/limit resolution behind
// the read endpoints is covered by lib/limits.test.ts.

function appWith(env: Bindings, role = "owner") {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.env = env;
    c.set("memberRole", role);
    await next();
  });
  app.route("/", billingRoute);
  return app;
}

const post = (app: Hono<AppEnv>, path: string, body?: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const selfHostedEnv = () =>
  createTestBindings({
    SELF_HOSTED: "true",
    DODO_PRICE_ID_PRO_MONTHLY: "pdt_month",
  });

const hostedEnv = (overrides?: Partial<Bindings>) =>
  createTestBindings({
    SELF_HOSTED: "false",
    DODO_PRICE_ID_PRO_MONTHLY: "pdt_month",
    ...overrides,
  });

describe("billing on a self-hosted deployment", () => {
  it("checkout answers 404 billing_disabled", async () => {
    const res = await post(appWith(selfHostedEnv()), "/v1/teams/org1/billing/checkout", { plan: "pro" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: "Billing is disabled on self-hosted deployments.",
      code: "billing_disabled",
    });
  });

  it("portal answers 404 billing_disabled", async () => {
    const res = await post(appWith(selfHostedEnv()), "/v1/teams/org1/billing/portal");
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe("billing_disabled");
  });
});

describe("checkout validation (hosted)", () => {
  it("rejects the retired business plan", async () => {
    const res = await post(appWith(hostedEnv()), "/v1/teams/org1/billing/checkout", { plan: "business" });
    expect(res.status).toBe(400);
  });

  it("rejects a missing or malformed body", async () => {
    const res = await post(appWith(hostedEnv()), "/v1/teams/org1/billing/checkout");
    expect(res.status).toBe(400);
  });

  it("refuses yearly billing, which no longer exists, and any other interval", async () => {
    for (const interval of ["year", "week"]) {
      const res = await post(appWith(hostedEnv()), "/v1/teams/org1/billing/checkout", { plan: "pro", interval });
      expect(res.status, interval).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe("invalid_interval");
    }
  });

  it("answers 503 billing_not_configured when the Pro product id is unset", async () => {
    const res = await post(
      appWith(hostedEnv({ DODO_PRICE_ID_PRO_MONTHLY: undefined })),
      "/v1/teams/org1/billing/checkout",
      { plan: "pro", interval: "month" },
    );
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe("billing_not_configured");
  });

  it("is owner-only", async () => {
    const res = await post(appWith(hostedEnv(), "admin"), "/v1/teams/org1/billing/checkout", { plan: "pro" });
    expect(res.status).toBe(403);
  });
});
