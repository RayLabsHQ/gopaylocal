import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { createSqlRecorder, type SqlRecorder } from "../lib/sql-recorder-test-helpers";
import { createMockKV, createTestBindings, createTestClient } from "../test/helpers";
import type { PaymentProvider, ProviderConfig, RedemptionEvent } from "../services/providers";

// Unit tests for the merchant webhook route (POST /v1/webhooks/:provider/:id
// and its /test twin). No database: createDb() returns the SQL recorder; the
// provider factory and decryption are faked. The Dodo billing webhook in the
// same file is not exercised here.

const state = vi.hoisted(() => ({
  recorder: null as unknown as SqlRecorder,
  create: null as unknown as Mock,
}));

vi.mock("../db", () => ({ createDb: () => state.recorder.db }));
vi.mock("../services/banner-cache.service", () => ({ pushBannerConfigForOrg: async () => {} }));
vi.mock("../services/providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/providers")>();
  return { ...actual, createProvider: (...args: unknown[]) => state.create(...args) };
});
vi.mock("../lib/crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/crypto")>();
  return {
    ...actual,
    decrypt: async (v: string) => {
      if (v.startsWith("undecryptable")) throw new Error("The operation failed for an operation-specific reason");
      return `dec:${v}`;
    },
    tokenEncryptionSecret: () => "secret",
  };
});

const { default: webhooksRoute, GUMROAD_ACK_BUDGET_MS } = await import("./webhooks");
const { healthClears, healthWrites } = await import("../services/integration-health-test-helpers");

const INTEGRATION = "int_1";

function integrationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: INTEGRATION,
    organizationId: "org_1",
    provider: "polar",
    liveAccessTokenEnc: "live-enc",
    liveRefreshTokenEnc: null,
    testAccessTokenEnc: "test-enc",
    testRefreshTokenEnc: null,
    providerAccountId: null,
    testProviderAccountId: null,
    webhookEndpointId: "we_1",
    webhookSecretEnc: "secret-enc",
    testWebhookEndpointId: "we_test",
    testWebhookSecretEnc: "test-secret-enc",
    health: {},
    status: "active",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

const redemption: RedemptionEvent = {
  eventId: "evt_1",
  code: "PPPIN40ABCD",
  providerCouponId: null,
  providerPromoCodeId: null,
  discountAmountCents: 1000,
  chargedAmountCents: 4000,
  currency: "USD",
} as RedemptionEvent;

const couponRow = {
  id: "cpn_1",
  campaignId: "cmp_1",
  integrationId: INTEGRATION,
  countryCode: "IN",
  environment: "live",
  code: "PPPIN40ABCD",
  discountPercent: 40,
  providerCouponId: "disc_1",
  providerPromoCodeId: null,
  status: "active",
  createdAt: new Date(),
};

type FakeProvider = PaymentProvider & {
  verifyWebhook: Mock;
  parseRedemption: Mock;
};

let provider: FakeProvider;
let configs: ProviderConfig[];

function client(overrides: Parameters<typeof createTestBindings>[0] = {}) {
  return createTestClient(webhooksRoute, createTestBindings({ CACHE: createMockKV(), ...overrides }));
}

function post(c: ReturnType<typeof client>, path: string, body = '{"type":"order.paid"}') {
  return c.request(path, { method: "POST", body, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  configs = [];
  provider = {
    verifyWebhook: vi.fn(async () => true),
    parseRedemption: vi.fn(async () => redemption),
  } as unknown as FakeProvider;
  state.create = vi.fn((_name: string, config: ProviderConfig) => {
    configs.push(config);
    return provider;
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("billing webhook (/v1/webhooks/dodo)", () => {
  it("is disabled on self-hosted deployments, like the other billing endpoints", async () => {
    // It used to verify and process deliveries even with SELF_HOSTED="true".
    state.recorder = createSqlRecorder([]);
    const res = await post(client({ SELF_HOSTED: "true" }), "/v1/webhooks/dodo");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "billing_disabled" });
    expect(state.recorder.queries).toHaveLength(0);
  });
});

describe("merchant webhook: environment slot", () => {
  it("serves a test-only integration at /test, with the test key", async () => {
    const row = integrationRow({ liveAccessTokenEnc: null });
    state.recorder = createSqlRecorder([[row], [], [{ id: "e" }], [couponRow], [{ organizationId: "org_1" }], []]);

    const res = await post(client(), `/v1/webhooks/polar/${INTEGRATION}/test`);

    expect(res.status).toBe(200);
    expect(configs[0]).toMatchObject({ apiKey: "dec:test-enc", environment: "test" });
  });

  it("refuses the live URL for a test-only integration (not a webhook we provisioned)", async () => {
    state.recorder = createSqlRecorder([[integrationRow({ liveAccessTokenEnc: null })]]);
    const res = await post(client(), `/v1/webhooks/polar/${INTEGRATION}`);
    expect(res.status).toBe(404);
    expect(state.create).not.toHaveBeenCalled();
  });

  it("refuses the /test URL for an integration without test credentials", async () => {
    state.recorder = createSqlRecorder([[integrationRow({ testAccessTokenEnc: null })]]);
    const res = await post(client(), `/v1/webhooks/polar/${INTEGRATION}/test`);
    expect(res.status).toBe(404);
  });

  it("serves live and test side by side, each verified with its own endpoint's secret and key", async () => {
    const rows = () => [[integrationRow()], [], [{ id: "e" }], [couponRow], [{ organizationId: "org_1" }], []];
    state.recorder = createSqlRecorder(rows());
    expect((await post(client(), `/v1/webhooks/polar/${INTEGRATION}`)).status).toBe(200);
    state.recorder = createSqlRecorder(rows());
    expect((await post(client(), `/v1/webhooks/polar/${INTEGRATION}/test`)).status).toBe(200);

    expect(provider.verifyWebhook.mock.calls.map(([input]) => input.secret)).toEqual([
      "dec:secret-enc",
      "dec:test-secret-enc",
    ]);
    expect(configs.map((c) => [c.apiKey, c.environment])).toEqual([
      ["dec:live-enc", "live"],
      ["dec:test-enc", "test"],
    ]);
  });

  it("uses the test-mode account id for test deliveries", async () => {
    state.recorder = createSqlRecorder([
      [integrationRow({ providerAccountId: "biz_live", testProviderAccountId: "biz_sandbox" })],
      [],
      [{ id: "e" }],
      [couponRow],
      [{ organizationId: "org_1" }],
      [],
    ]);
    await post(client(), `/v1/webhooks/polar/${INTEGRATION}/test`);
    expect(configs[0]).toMatchObject({ environment: "test", siteId: "biz_sandbox" });
  });

  it("refuses a provider name that doesn't match the integration", async () => {
    state.recorder = createSqlRecorder([[integrationRow()]]);
    const res = await post(client(), `/v1/webhooks/stripe/${INTEGRATION}`);
    expect(res.status).toBe(404);
  });
});

describe("merchant webhook: status contract", () => {
  it("answers 200 duplicate, without counting, when a concurrent delivery holds the claim", async () => {
    // The dedupe row exists but is not processed yet (another delivery is mid-flight).
    state.recorder = createSqlRecorder([[integrationRow()], [], []]);

    const res = await post(client(), `/v1/webhooks/polar/${INTEGRATION}`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, duplicate: true });
    expect(state.recorder.queries.some((q) => q.sql.includes('from "coupons"'))).toBe(false);
    expect(state.recorder.queries.some((q) => q.sql.includes("analytics_rollups"))).toBe(false);
  });

  it("stores the verified body and answers 500 when parsing fails transiently, and shows the delay", async () => {
    provider.parseRedemption.mockRejectedValueOnce(new Error("order lookup timed out"));
    state.recorder = createSqlRecorder([[integrationRow()], [], []]);
    const c = client();

    const res = await post(c, `/v1/webhooks/polar/${INTEGRATION}`);

    expect(res.status).toBe(500);
    const insert = state.recorder.queries.find((q) => q.sql.startsWith('insert into "webhook_events"'))!;
    expect(insert.params).toContain("redemption_unparsed");
    expect(healthWrites(state.recorder)).toEqual([
      expect.objectContaining({ area: "webhook_delivery", message: expect.stringContaining("order lookup timed out") }),
    ]);
  });

  it("clears a delivery problem once a delivery is processed (and costs nothing when there is none)", async () => {
    const withIssue = integrationRow({
      health: { webhook_delivery: { area: "webhook_delivery", message: "bad signature", at: new Date().toISOString() } },
    });
    state.recorder = createSqlRecorder([[withIssue], [], [{ id: "e" }], [couponRow], [{ organizationId: "org_1" }], []]);

    const res = await post(client(), `/v1/webhooks/polar/${INTEGRATION}`);

    expect(res.status).toBe(200);
    expect(healthClears(state.recorder)).toEqual(["webhook_delivery"]);

    state.recorder = createSqlRecorder([[integrationRow()], [], [{ id: "e" }], [couponRow], [{ organizationId: "org_1" }], []]);
    await post(client(), `/v1/webhooks/polar/${INTEGRATION}`);
    expect(state.recorder.queries.some((q) => q.sql.startsWith('update "integrations"'))).toBe(false);
  });

  it("answers 500 (provider retries) when the rollup write fails", async () => {
    state.recorder = createSqlRecorder([
      [integrationRow()],
      [],
      [{ id: "e" }],
      [couponRow],
      [{ organizationId: "org_1" }],
      new Error("connection reset"),
      [],
    ]);

    const res = await post(client(), `/v1/webhooks/polar/${INTEGRATION}`);

    expect(res.status).toBe(500);
    expect(state.recorder.transactions).toEqual(["rollback"]);
  });

  it("answers 401 for a bad signature and shows it on the integration's health", async () => {
    provider.verifyWebhook.mockResolvedValueOnce(false);
    state.recorder = createSqlRecorder([[integrationRow()]]);
    const c = client();

    const res = await post(c, `/v1/webhooks/polar/${INTEGRATION}`);

    expect(res.status).toBe(401);
    expect(healthWrites(state.recorder)).toEqual([
      expect.objectContaining({ area: "webhook_delivery", environment: "live" }),
    ]);
  });

  it("reports an undecryptable signing secret as such (not as a bad signature)", async () => {
    // e.g. the token encryption secret was rotated: every delivery 401s until the
    // provider disables the endpoint, so the real cause must be visible.
    provider.verifyWebhook.mockResolvedValueOnce(false);
    state.recorder = createSqlRecorder([[integrationRow({ webhookSecretEnc: "undecryptable-secret" })]]);
    const c = client();

    const res = await post(c, `/v1/webhooks/polar/${INTEGRATION}`);

    expect(res.status).toBe(401);
    expect(provider.verifyWebhook).toHaveBeenCalledWith(expect.objectContaining({ secret: null }));
    expect(console.error).toHaveBeenCalled();
    const writes = healthWrites(state.recorder);
    expect(writes).toHaveLength(1); // not also reported as a bad signature
    expect(writes[0]!.message).toContain("couldn't decrypt the stored live webhook signing secret");
  });

  it("reports an undecryptable API key on the integration's credentials", async () => {
    state.recorder = createSqlRecorder([
      [integrationRow({ liveAccessTokenEnc: "undecryptable-key" })],
      [], // health write
      [],
      [{ id: "e" }],
      [couponRow],
      [{ organizationId: "org_1" }],
      [],
    ]);
    const c = client();

    await post(c, `/v1/webhooks/polar/${INTEGRATION}`);

    expect(configs[0]).toMatchObject({ apiKey: "" });
    expect(healthWrites(state.recorder)[0]).toMatchObject({
      area: "credentials",
      message: expect.stringContaining("couldn't decrypt the stored live API key"),
    });
  });

  it("answers a provider's setup ping with 200 without verifying, storing or touching health", async () => {
    const isHandshake = vi.fn(() => true);
    Object.assign(provider, { isHandshake });
    state.recorder = createSqlRecorder([[integrationRow({ provider: "woocommerce" })]]);
    const c = client();

    const res = await post(c, `/v1/webhooks/woocommerce/${INTEGRATION}`, "webhook_id=12");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
    expect(isHandshake).toHaveBeenCalledWith(expect.objectContaining({ rawBody: "webhook_id=12" }));
    expect(provider.verifyWebhook).not.toHaveBeenCalled();
    expect(provider.parseRedemption).not.toHaveBeenCalled();
    expect(state.recorder.queries).toHaveLength(1); // the integration lookup only
  });

  it("verifies anything the provider doesn't call a handshake", async () => {
    Object.assign(provider, { isHandshake: vi.fn(() => false) });
    provider.verifyWebhook.mockResolvedValueOnce(false);
    state.recorder = createSqlRecorder([[integrationRow({ provider: "woocommerce" })]]);
    const c = client();

    const res = await post(c, `/v1/webhooks/woocommerce/${INTEGRATION}`, "webhook_id=12");

    expect(res.status).toBe(401);
    expect(provider.verifyWebhook).toHaveBeenCalled();
  });

  it("acks a delivery it can never process (provider init failed), but logs it and shows it", async () => {
    state.create = vi.fn(() => {
      throw new Error("Chargebee site is required");
    });
    state.recorder = createSqlRecorder([[integrationRow({ provider: "chargebee" })]]);
    const c = client();

    const res = await post(c, `/v1/webhooks/chargebee/${INTEGRATION}`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, unsupported: true });
    expect(console.error).toHaveBeenCalled();
    expect(healthWrites(state.recorder)[0]!.message).toContain("site is required");
  });
});

describe("merchant webhook: Gumroad pings", () => {
  const gumroad = () => integrationRow({ provider: "gumroad", webhookSecretEnc: null });

  it("stores the ping BEFORE the sale read-back, then answers 200 once recorded", async () => {
    const order: string[] = [];
    provider.parseRedemption.mockImplementationOnce(async () => {
      order.push(`parse after ${state.recorder.queries.length} queries`);
      return redemption;
    });
    state.recorder = createSqlRecorder([
      [gumroad()],
      [], // store ping
      [], // dedupe insert
      [{ id: "e" }], // claim
      [couponRow],
      [{ organizationId: "org_1" }],
      [], // rollup
      [], // resolve stored ping
    ]);

    const res = await post(client(), `/v1/webhooks/gumroad/${INTEGRATION}`, "sale_id=abc");

    expect(res.status).toBe(200);
    expect(state.recorder.queries[1]!.params).toContain("redemption_unparsed");
    expect(order).toEqual(["parse after 2 queries"]);
  });

  it("answers 503 (Gumroad retries it) when the read-back fails, instead of a 200 that loses the sale", async () => {
    provider.parseRedemption.mockRejectedValueOnce(new Error("Gumroad API 502"));
    state.recorder = createSqlRecorder([[gumroad()], [], [], []]);

    const res = await post(client(), `/v1/webhooks/gumroad/${INTEGRATION}`, "sale_id=abc");

    expect(res.status).toBe(503);
  });

  it("answers 503 when it can't even store the ping", async () => {
    state.recorder = createSqlRecorder([[gumroad()], new Error("db down")]);
    const res = await post(client(), `/v1/webhooks/gumroad/${INTEGRATION}`, "sale_id=abc");
    expect(res.status).toBe(503);
    expect(provider.parseRedemption).not.toHaveBeenCalled();
  });

  it("rate limits pings per integration on its own limiter, so forged pings can't burn the merchant's API quota", async () => {
    const limit = vi.fn(async () => ({ success: false }));
    // RL_EVENTS_KEY is sized for banner analytics (3000/min): it must not be the gate.
    const eventsLimit = vi.fn(async () => ({ success: true }));
    state.recorder = createSqlRecorder([[gumroad()]]);

    const res = await post(
      client({ RL_GUMROAD_PING: { limit } as unknown as RateLimit, RL_EVENTS_KEY: { limit: eventsLimit } as unknown as RateLimit }),
      `/v1/webhooks/gumroad/${INTEGRATION}`,
      "sale_id=abc",
    );

    expect(res.status).toBe(503);
    expect(limit).toHaveBeenCalledWith({ key: `gumroad-ping:${INTEGRATION}` });
    expect(eventsLimit).not.toHaveBeenCalled();
    expect(provider.parseRedemption).not.toHaveBeenCalled();
  });

  it("answers 503 within the 5 s window when the read-back is slow, and lets it finish afterwards", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let release!: (v: RedemptionEvent | null) => void;
    provider.parseRedemption.mockImplementationOnce(
      () => new Promise<RedemptionEvent | null>((resolve) => (release = resolve)),
    );
    state.recorder = createSqlRecorder([[gumroad()], [], []]);

    const pending = post(client(), `/v1/webhooks/gumroad/${INTEGRATION}`, "sale_id=abc");
    // Wait (on real macrotasks) until the read-back has started, then run out the budget.
    for (let i = 0; i < 100 && !release; i++) await new Promise((r) => setImmediate(r));
    await vi.advanceTimersByTimeAsync(GUMROAD_ACK_BUDGET_MS);
    release(null); // the read-back eventually finishes (not a redemption)
    const res = await pending;

    expect(GUMROAD_ACK_BUDGET_MS).toBeLessThan(5000);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Still processing" });
  });
});
