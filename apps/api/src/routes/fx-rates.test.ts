import { localPricing } from "@gopaylocal/shared/currency";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { guardedPermission } from "../middleware/permissions";
import { resetFxCacheForTests } from "../services/fx-cache";
import { FX_RATES_KEY } from "../services/fx-refresh.service";
import { createCountingKV, type KvState } from "../services/vpn-test-helpers";
import { createTestBindings, createTestClient, mountRoutes, type InjectedMember } from "../test/helpers";
import fxRatesRoute from "./fx-rates";

// GET /v1/teams/:orgId/fx-rates gives the dashboard's banner editor the rates the
// banner endpoint converts with, so its preview shows what visitors see. It must
// answer `available: false` exactly when the banner endpoint would not convert:
// no document, an unusable one (stale, malformed), or FX_RATES_URL=off.

const NOW = Date.parse("2026-11-19T12:00:00Z");
const PATH = "/v1/teams/org_a/fx-rates";
const OWNER: InjectedMember = { userId: "u_owner", role: "owner" };
const MEMBER: InjectedMember = { userId: "u_member", role: "member" };

function doc(overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    base: "USD",
    asOf: "2026-11-18",
    fetchedAt: "2026-11-18T18:40:03.000Z",
    source: "primary",
    rates: { USD: 1, EUR: 0.86, INR: 88.4, NGN: 1452.1 },
    held: ["KPW", "SYP"],
    ...overrides,
  };
}

let kv: KVNamespace;
let state: KvState;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  resetFxCacheForTests();
  ({ kv, state } = createCountingKV());
});
afterEach(() => {
  vi.useRealTimers();
});

function client(member: InjectedMember = OWNER, vars: Record<string, string> = {}) {
  return createTestClient(mountRoutes(fxRatesRoute, member), createTestBindings({ CACHE: kv, ...vars }));
}

describe("GET /v1/teams/:orgId/fx-rates", () => {
  it("is guarded by the banner view permission", () => {
    const route = fxRatesRoute.routes.find((r) => r.method === "GET" && r.path === "/v1/teams/:orgId/fx-rates");
    expect(route && guardedPermission(route.handler)).toBe("banners.view");
  });

  it("returns the stored rates when they are usable", async () => {
    state.store.set(FX_RATES_KEY, JSON.stringify(doc()));
    const res = await client().request(PATH);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { available: true, fx: doc(), excludedCurrencies: [] } });
  });

  it("leaves out the refresh-only baseline and lists FX_EXCLUDED_CURRENCIES for the preview", async () => {
    const baseline = { INR: { rate: 88.4, asOf: "2026-11-18" } };
    state.store.set(FX_RATES_KEY, JSON.stringify(doc({ baseline, heldAsOf: {} })));
    const { data } = await (await client(OWNER, { FX_EXCLUDED_CURRENCIES: "ngn, inr,bad!" }).request(PATH)).json();
    expect(data.fx).not.toHaveProperty("baseline");
    expect(data.fx.rates).toEqual(doc().rates); // still there: a product priced in INR needs its rate
    expect(data.excludedCurrencies).toEqual(["INR", "NGN"]);
    // The preview passes them on, and so shows the exact price, as the banner endpoint does.
    const r = localPricing({
      basePrice: 19, baseCurrency: "USD", discountPercent: 60, country: "IN", strategy: "none",
      fx: data.fx, now: NOW, excludedCurrencies: new Set<string>(data.excludedCurrencies),
    });
    expect([r?.currencyCode, r?.fxRate]).toEqual(["USD", 1]);
  });

  it("returns a document localPricing() converts with, as the banner endpoint does", async () => {
    state.store.set(FX_RATES_KEY, JSON.stringify(doc()));
    const { data } = await (await client().request(PATH)).json();
    const r = localPricing({ basePrice: 19, baseCurrency: "USD", discountPercent: 60, country: "IN", strategy: "none", fx: data.fx, now: NOW });
    expect([r?.currencyCode, r?.fxRate, r?.fxAsOf]).toEqual(["INR", 88.4, "2026-11-18"]);
  });

  it("serves members too (banners.view is scoped for members)", async () => {
    state.store.set(FX_RATES_KEY, JSON.stringify(doc()));
    const res = await client(MEMBER).request(PATH);
    expect(res.status).toBe(200);
    expect((await res.json()).data.available).toBe(true);
  });

  it("answers available: false when there is no document", async () => {
    const res = await client().request(PATH);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { available: false } });
  });

  it("answers available: false for rates older than 96 hours, as the banner endpoint would", async () => {
    // 2026-11-15T00:00Z is 108 h before NOW; 2026-11-16 (84 h) is still usable.
    state.store.set(FX_RATES_KEY, JSON.stringify(doc({ asOf: "2026-11-15" })));
    expect(await (await client().request(PATH)).json()).toEqual({ data: { available: false } });

    resetFxCacheForTests();
    state.store.set(FX_RATES_KEY, JSON.stringify(doc({ asOf: "2026-11-16" })));
    expect((await (await client().request(PATH)).json()).data.available).toBe(true);
  });

  it("answers available: false for a malformed document", async () => {
    state.store.set(FX_RATES_KEY, JSON.stringify(doc({ rates: { USD: 2, INR: 88.4 } })));
    expect(await (await client().request(PATH)).json()).toEqual({ data: { available: false } });
  });

  it("answers available: false without reading KV when FX_RATES_URL is off", async () => {
    state.store.set(FX_RATES_KEY, JSON.stringify(doc()));
    const res = await client(OWNER, { FX_RATES_URL: " OFF " }).request(PATH);
    expect(await res.json()).toEqual({ data: { available: false } });
    expect(state.reads).toBe(0);
  });
});
