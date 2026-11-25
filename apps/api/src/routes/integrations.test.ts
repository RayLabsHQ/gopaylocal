import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { createSqlRecorder, type SqlRecorder } from "../lib/sql-recorder-test-helpers";
import { createMockKV, createTestBindings, createTestClient, mountRoutes } from "../test/helpers";
import { ProviderAuthError, ProviderError, type ProviderConfig } from "../services/providers";

// Unit tests for the integrations routes: webhook provisioning in the right
// environment, failures surfaced to the merchant, the account-id guard, and a
// disconnect that can't strand campaigns/coupons. No database: createDb()
// returns the SQL recorder (canned rows, in order); providers are faked.

const state = vi.hoisted(() => ({
  recorder: null as unknown as SqlRecorder,
  create: null as unknown as Mock,
  push: null as unknown as Mock,
}));

vi.mock("../db", () => ({ createDb: () => state.recorder.db }));
vi.mock("../services/banner-cache.service", () => ({
  pushBannerConfigForOrg: (...args: unknown[]) => state.push(...args),
}));
vi.mock("../services/providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/providers")>();
  return { ...actual, createProvider: (...args: unknown[]) => state.create(...args) };
});
vi.mock("../lib/crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/crypto")>();
  return {
    ...actual,
    encrypt: async (v: string) => `enc:${v}`,
    decrypt: async (v: string) => v.replace(/^enc:/, ""),
    tokenEncryptionSecret: () => "secret",
  };
});

const { default: integrationsRoute } = await import("./integrations");
const { healthWrites } = await import("../services/integration-health-test-helpers");

const ORG = "org_1";
const ID = "int_1";
const BASE = `/v1/teams/${ORG}/integrations`;

type FakeProvider = {
  provisionWebhook: Mock;
  deleteWebhook: Mock;
  listDiscounts: Mock;
};

let providers: Record<"live" | "test", FakeProvider>;
let configs: Array<{ provider: string; config: ProviderConfig }>;

function makeProvider(e: "live" | "test"): FakeProvider {
  return {
    provisionWebhook: vi.fn(async () => ({ endpointId: `we_${e}_new`, secret: "whsec_new" })),
    deleteWebhook: vi.fn(async () => {}),
    listDiscounts: vi.fn(async () => []),
  };
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: ID,
    organizationId: ORG,
    provider: "stripe",
    liveAccessTokenEnc: "enc:sk_live",
    liveRefreshTokenEnc: null,
    testAccessTokenEnc: null,
    testRefreshTokenEnc: null,
    providerAccountId: null,
    testProviderAccountId: null,
    webhookEndpointId: null,
    webhookSecretEnc: null,
    testWebhookEndpointId: null,
    testWebhookSecretEnc: null,
    health: {},
    status: "active",
    createdAt: new Date("2026-11-01T00:00:00Z"),
    updatedAt: new Date("2026-11-01T00:00:00Z"),
    ...overrides,
  };
}

function client(role: "owner" | "admin" | "member" = "admin") {
  return createTestClient(
    mountRoutes(integrationsRoute, { userId: "u_1", role }),
    createTestBindings({ CACHE: createMockKV() }),
  );
}

beforeEach(() => {
  providers = { live: makeProvider("live"), test: makeProvider("test") };
  configs = [];
  state.create = vi.fn((provider: string, config: ProviderConfig) => {
    configs.push({ provider, config });
    return providers[config.environment ?? "live"];
  });
  state.push = vi.fn(async () => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("permissions (integrations.view / integrations.manage / integrations.import)", () => {
  it("lets a member list integrations but not connect, test, re-create, import or disconnect", async () => {
    state.recorder = createSqlRecorder([[]]);
    expect((await client("member").request(BASE)).status).toBe(200);

    state.recorder = createSqlRecorder([]);
    const member = client("member");
    for (const [method, path] of [
      ["POST", BASE],
      ["POST", `${BASE}/${ID}/webhook`],
      ["POST", `${BASE}/${ID}/test`],
      ["GET", `${BASE}/${ID}/products`],
      ["POST", `${BASE}/${ID}/products/import`],
      ["DELETE", `${BASE}/${ID}`],
    ] as const) {
      const res = await member.request(path, { method, ...(method === "GET" || method === "DELETE" ? {} : { json: {} }) });
      expect({ path, method, status: res.status }).toEqual({ path, method, status: 403 });
    }
    expect(state.recorder.queries).toHaveLength(0);
  });
});

describe("POST /integrations: webhook provisioning", () => {
  it("provisions the live webhook with the stored integration's id and reports it", async () => {
    state.recorder = createSqlRecorder([[], [row()], [row({ webhookEndpointId: "we_live_new", webhookSecretEnc: "enc:whsec_new" })]]);

    const res = await client().request(BASE, { method: "POST", json: { provider: "stripe", accessToken: "sk_live" } });

    expect(res.status).toBe(201);
    expect(providers.live.provisionWebhook).toHaveBeenCalledWith(`http://localhost/v1/webhooks/stripe/${ID}`);
    const body = (await res.json()) as { data: Record<string, any> };
    expect(body.data.webhooks).toEqual({ live: { status: "active" }, test: null });
    expect(body.data.webhookSetup).toEqual({ status: "active", environment: "live" });
    expect(body.data).not.toHaveProperty("liveAccessTokenEnc");
  });

  it("provisions a TEST webhook, with the test key, for a test-only integration", async () => {
    // Previously test-only integrations never got a webhook: no test redemptions were tracked.
    const testRow = row({ liveAccessTokenEnc: null, testAccessTokenEnc: "enc:sk_test" });
    state.recorder = createSqlRecorder([[], [testRow], [{ ...testRow, testWebhookEndpointId: "we_test_new", testWebhookSecretEnc: "enc:whsec_new" }]]);

    const res = await client().request(BASE, {
      method: "POST",
      json: { provider: "stripe", accessToken: "sk_test", environment: "test" },
    });

    expect(res.status).toBe(201);
    expect(configs[0]!.config).toMatchObject({ apiKey: "sk_test", environment: "test" });
    expect(providers.test.provisionWebhook).toHaveBeenCalledWith(`http://localhost/v1/webhooks/stripe/${ID}/test`);
    // Stored in the TEST endpoint columns.
    expect(state.recorder.queries[2]!.sql).toMatch(/^update "integrations" set "test_webhook_endpoint_id" = \$1, "test_webhook_secret_enc" = \$2/);
    expect(((await res.json()) as any).data.webhooks).toEqual({ live: null, test: { status: "active" } });
  });

  it("provisions on the update path when the integration has no webhook yet", async () => {
    // Re-entering credentials after a failed provisioning used to never retry it.
    const existing = row();
    state.recorder = createSqlRecorder([[existing], [existing], [{ ...existing, webhookEndpointId: "we_live_new" }]]);

    const res = await client().request(BASE, { method: "POST", json: { provider: "stripe", accessToken: "sk_live2" } });

    expect(res.status).toBe(200);
    expect(providers.live.provisionWebhook).toHaveBeenCalledOnce();
    expect(((await res.json()) as any).data.webhookSetup.status).toBe("active");
  });

  it("adds a live webhook next to the test one when live credentials are added (the test endpoint stays)", async () => {
    // With one shared slot, adding live credentials used to delete the test endpoint.
    const existing = row({ liveAccessTokenEnc: null, testAccessTokenEnc: "enc:sk_test", testWebhookEndpointId: "we_test_old", testWebhookSecretEnc: "enc:old" });
    const updated = { ...existing, liveAccessTokenEnc: "enc:sk_live" };
    state.recorder = createSqlRecorder([[existing], [updated], [{ ...updated, webhookEndpointId: "we_live_new", webhookSecretEnc: "enc:whsec_new" }]]);

    const res = await client().request(BASE, { method: "POST", json: { provider: "stripe", accessToken: "sk_live" } });

    expect(res.status).toBe(200);
    expect(state.recorder.queries[1]!.sql.split(" where ")[0]).not.toContain("webhook_endpoint_id");
    expect(providers.test.deleteWebhook).not.toHaveBeenCalled();
    expect(providers.live.provisionWebhook).toHaveBeenCalledWith(`http://localhost/v1/webhooks/stripe/${ID}`);
    expect(((await res.json()) as any).data.webhooks).toEqual({ live: { status: "active" }, test: { status: "active" } });
  });

  it("replaces the live webhook when the live key changes (the endpoint may belong to another account)", async () => {
    const existing = row({ liveAccessTokenEnc: "enc:sk_live_old", webhookEndpointId: "we_live_old", webhookSecretEnc: "enc:old" });
    const updated = { ...existing, liveAccessTokenEnc: "enc:sk_live_new", webhookEndpointId: null, webhookSecretEnc: null };
    state.recorder = createSqlRecorder([[existing], [updated], [{ ...updated, webhookEndpointId: "we_live_new" }]]);

    const res = await client().request(BASE, { method: "POST", json: { provider: "stripe", accessToken: "sk_live_new" } });

    expect(res.status).toBe(200);
    expect(state.recorder.queries[1]!.sql).toMatch(/"webhook_endpoint_id" = \$\d+, "webhook_secret_enc" = \$\d+/);
    // New key checked first, old endpoint removed with the OLD key, new one created with the new key.
    expect(configs.map((c) => c.config.apiKey)).toEqual(["sk_live_new", "sk_live_old", "sk_live_new"]);
    expect(providers.live.deleteWebhook).toHaveBeenCalledWith("we_live_old");
    expect(providers.live.provisionWebhook).toHaveBeenCalledOnce();
  });

  it("leaves a working webhook alone when the same key is re-submitted", async () => {
    const existing = row({ webhookEndpointId: "we_live", webhookSecretEnc: "enc:s" });
    state.recorder = createSqlRecorder([[existing], [existing]]);

    const res = await client().request(BASE, { method: "POST", json: { provider: "stripe", accessToken: "sk_live" } });

    expect(res.status).toBe(200);
    expect(state.recorder.queries[1]!.sql.split(" where ")[0]).not.toContain("webhook_endpoint_id");
    // Only the key check talks to Stripe; the endpoint is neither removed nor re-created.
    expect(configs.map((c) => c.config.apiKey)).toEqual(["sk_live"]);
    expect(providers.live.deleteWebhook).not.toHaveBeenCalled();
    expect(providers.live.provisionWebhook).not.toHaveBeenCalled();
    expect(((await res.json()) as any).data.webhookSetup).toEqual({ status: "active", environment: "live" });
  });

  it("provisions a test webhook next to the live one when test credentials are added (live untouched)", async () => {
    const existing = row({ webhookEndpointId: "we_live", webhookSecretEnc: "enc:s" });
    const updated = { ...existing, testAccessTokenEnc: "enc:sk_test" };
    state.recorder = createSqlRecorder([[existing], [updated], [{ ...updated, testWebhookEndpointId: "we_test_new" }]]);

    await client().request(BASE, {
      method: "POST",
      json: { provider: "stripe", accessToken: "sk_test", environment: "test" },
    });

    expect(state.recorder.queries[1]!.sql.split(" where ")[0]).not.toContain("webhook_endpoint_id");
    expect(providers.live.deleteWebhook).not.toHaveBeenCalled();
    expect(providers.live.provisionWebhook).not.toHaveBeenCalled();
    expect(providers.test.provisionWebhook).toHaveBeenCalledWith(`http://localhost/v1/webhooks/stripe/${ID}/test`);
  });

  it("replaces only the test webhook when the test key changes", async () => {
    const existing = row({
      webhookEndpointId: "we_live", webhookSecretEnc: "enc:s",
      testAccessTokenEnc: "enc:sk_test_old", testWebhookEndpointId: "we_test_old", testWebhookSecretEnc: "enc:t",
    });
    const updated = { ...existing, testAccessTokenEnc: "enc:sk_test_new", testWebhookEndpointId: null, testWebhookSecretEnc: null };
    state.recorder = createSqlRecorder([[existing], [updated], [{ ...updated, testWebhookEndpointId: "we_test_new" }]]);

    await client().request(BASE, { method: "POST", json: { provider: "stripe", accessToken: "sk_test_new", environment: "test" } });

    const write = state.recorder.queries[1]!.sql.split(" where ")[0]!;
    expect(write).toMatch(/"test_webhook_endpoint_id" = \$\d+, "test_webhook_secret_enc" = \$\d+/);
    expect(write).not.toMatch(/"webhook_endpoint_id"/);
    expect(providers.test.deleteWebhook).toHaveBeenCalledWith("we_test_old");
    expect(providers.live.deleteWebhook).not.toHaveBeenCalled();
  });

  it("tells the dashboard (and the integration's health) when provisioning fails", async () => {
    providers.live.provisionWebhook.mockRejectedValueOnce(
      new ProviderError("stripe", "provisionWebhook", "This API key lacks the webhook_endpoints permission", 403),
    );
    state.recorder = createSqlRecorder([[], [row()]]);
    const c = client();

    const res = await c.request(BASE, { method: "POST", json: { provider: "stripe", accessToken: "sk_live" } });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: Record<string, any> };
    expect(body.data.webhookSetup).toMatchObject({ status: "failed", environment: "live" });
    expect(body.data.webhookSetup.error).toContain("webhook_endpoints permission");
    expect(body.data.webhooks.live.status).toBe("missing");
    expect(body.data.health[0]).toMatchObject({ area: "webhook_setup" });
    expect(healthWrites(state.recorder)).toEqual([expect.objectContaining({ area: "webhook_setup", environment: "live" })]);
  });

  it("removes the new endpoint again when it can't be saved", async () => {
    state.recorder = createSqlRecorder([[], [row()], new Error("connection reset")]);

    const res = await client().request(BASE, { method: "POST", json: { provider: "stripe", accessToken: "sk_live" } });

    expect(res.status).toBe(201);
    expect(providers.live.deleteWebhook).toHaveBeenCalledWith("we_live_new");
    expect(((await res.json()) as any).data.webhookSetup.status).toBe("failed");
  });
});

describe("POST /integrations: the key is checked before it is saved", () => {
  it("lists discounts with the new key, in the chosen environment, before writing anything", async () => {
    state.recorder = createSqlRecorder([[], [row()], [row({ webhookEndpointId: "we_live_new" })]]);

    const res = await client().request(BASE, { method: "POST", json: { provider: "stripe", accessToken: "sk_live" } });

    expect(res.status).toBe(201);
    expect(configs[0]!.config).toMatchObject({ apiKey: "sk_live", environment: "live" });
    expect(providers.live.listDiscounts).toHaveBeenCalledOnce();
  });

  it("refuses a key the platform rejects with a 400 that passes on the platform's reason, and saves nothing", async () => {
    providers.live.listDiscounts.mockRejectedValueOnce(
      new ProviderAuthError("stripe", "The provided key does not have the required permissions"),
    );
    state.recorder = createSqlRecorder([[]]);

    const res = await client().request(BASE, { method: "POST", json: { provider: "stripe", accessToken: "rk_live_x" } });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe("key_rejected");
    expect(body.error).toContain("does not have the required permissions");
    // Only the lookup of an existing integration ran: no insert, no update.
    expect(state.recorder.queries).toHaveLength(1);
    expect(providers.live.provisionWebhook).not.toHaveBeenCalled();
  });

  it("leaves the saved key in place when a replacement is rejected", async () => {
    providers.live.listDiscounts.mockRejectedValueOnce(new ProviderAuthError("stripe", "Invalid API Key provided"));
    state.recorder = createSqlRecorder([[row({ webhookEndpointId: "we_live" })]]);

    const res = await client().request(BASE, { method: "POST", json: { provider: "stripe", accessToken: "sk_live_typo" } });

    expect(res.status).toBe(400);
    expect(state.recorder.queries).toHaveLength(1);
    expect(providers.live.deleteWebhook).not.toHaveBeenCalled();
  });

  it("answers 502 and saves nothing when the platform can't be asked", async () => {
    providers.live.listDiscounts.mockRejectedValueOnce(new ProviderError("stripe", "listDiscounts", "Service unavailable", 503));
    state.recorder = createSqlRecorder([[]]);

    const res = await client().request(BASE, { method: "POST", json: { provider: "stripe", accessToken: "sk_live" } });

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: "key_unchecked" });
    expect(state.recorder.queries).toHaveLength(1);
  });

  it("checks the key with the normalized account id it will be saved with", async () => {
    state.recorder = createSqlRecorder([[], [row({ provider: "chargebee", providerAccountId: "acme" })], [row()]]);

    await client().request(BASE, {
      method: "POST",
      json: { provider: "chargebee", accessToken: "k", providerAccountId: "https://Acme.chargebee.com/" },
    });

    expect(configs[0]!.config).toMatchObject({ apiKey: "k", siteId: "acme" });
  });
});

describe("POST /integrations: providers without a test mode", () => {
  it("refuses test-mode credentials for Gumroad and WooCommerce with a 400 that says why, before any query", async () => {
    state.recorder = createSqlRecorder([]);
    const c = client();
    const cases = [
      { name: "Gumroad", json: { provider: "gumroad", accessToken: "tok", environment: "test" } },
      {
        name: "WooCommerce",
        json: {
          provider: "woocommerce",
          accessToken: `ck_${"a".repeat(40)}:cs_${"b".repeat(40)}`,
          providerAccountId: "https://shop.example.com",
          environment: "test",
        },
      },
    ];
    for (const { name, json } of cases) {
      const res = await c.request(BASE, { method: "POST", json });
      expect(res.status, name).toBe(400);
      expect(await res.json()).toMatchObject({ error: `${name} has no test mode. Connect it in Live.` });
    }
    expect(state.recorder.queries).toHaveLength(0);
    expect(state.create).not.toHaveBeenCalled();
  });

  it("still connects Gumroad in live mode", async () => {
    state.recorder = createSqlRecorder([[], [row({ provider: "gumroad" })], [row({ provider: "gumroad" })]]);
    const res = await client().request(BASE, { method: "POST", json: { provider: "gumroad", accessToken: "tok" } });
    expect(res.status).toBe(201);
  });
});

describe("POST /integrations: account ids", () => {
  it("rejects a Whop account id that isn't a biz_ id", async () => {
    state.recorder = createSqlRecorder([]);
    const res = await client().request(BASE, {
      method: "POST",
      json: { provider: "whop", accessToken: "k", providerAccountId: "AbC123" },
    });
    expect(res.status).toBe(400);
    expect(state.recorder.queries).toHaveLength(0);
  });

  it("stores the normalized Chargebee site name", async () => {
    state.recorder = createSqlRecorder([[], [row({ provider: "chargebee", providerAccountId: "acme" })], [row()]]);

    await client().request(BASE, {
      method: "POST",
      json: { provider: "chargebee", accessToken: "k", providerAccountId: "https://Acme.chargebee.com/" },
    });

    expect(state.recorder.queries[1]!.params).toContain("acme");
  });

  it("stores a test-mode account id of its own, leaving the live one alone (e.g. a Whop sandbox company)", async () => {
    // One shared account id used to make this a 409.
    const existing = row({ provider: "whop", providerAccountId: "biz_LIVE1" });
    state.recorder = createSqlRecorder([[existing], [{ ...existing, testAccessTokenEnc: "enc:k", testProviderAccountId: "biz_SANDBOX2" }], []]);

    const res = await client().request(BASE, {
      method: "POST",
      json: { provider: "whop", accessToken: "k", providerAccountId: "biz_SANDBOX2", environment: "test" },
    });

    expect(res.status).toBe(200);
    const write = state.recorder.queries[1]!;
    expect(write.sql.split(" where ")[0]).toContain('"test_provider_account_id" = $');
    expect(write.sql.split(" where ")[0]).not.toContain('"provider_account_id" = $');
    expect(write.params).toContain("biz_SANDBOX2");
    expect(configs.at(-1)!.config).toMatchObject({ environment: "test", siteId: "biz_SANDBOX2" });
  });

  it("keeps test mode on its old account when the live account id changes", async () => {
    const existing = row({ provider: "whop", providerAccountId: "biz_OLD", testAccessTokenEnc: "enc:t" });
    state.recorder = createSqlRecorder([[existing], [existing]]);

    await client().request(BASE, { method: "POST", json: { provider: "whop", accessToken: "k2", providerAccountId: "biz_NEW" } });

    const write = state.recorder.queries[1]!;
    expect(write.sql).toContain('"provider_account_id" = $');
    expect(write.sql).toContain('"test_provider_account_id" = $');
    expect(write.params).toEqual(expect.arrayContaining(["biz_NEW", "biz_OLD"]));
  });
});

describe("POST /integrations/:id/webhook", () => {
  it("re-creates the webhook: removes the old endpoint, then provisions a fresh one", async () => {
    const existing = row({ webhookEndpointId: "we_old", webhookSecretEnc: "enc:old" });
    state.recorder = createSqlRecorder([
      [existing],
      [{ ...existing, webhookEndpointId: null, webhookSecretEnc: null }],
      [{ ...existing, webhookEndpointId: "we_live_new" }],
    ]);

    const res = await client().request(`${BASE}/${ID}/webhook`, { method: "POST" });

    expect(res.status).toBe(200);
    expect(providers.live.deleteWebhook).toHaveBeenCalledWith("we_old");
    expect(providers.live.provisionWebhook).toHaveBeenCalledOnce();
    expect(((await res.json()) as any).data.webhookSetup).toEqual({ status: "active", environment: "live" });
  });

  it("re-creates the test endpoint when asked for ?environment=test", async () => {
    const existing = row({ testAccessTokenEnc: "enc:sk_test", testWebhookEndpointId: "we_test_old", testWebhookSecretEnc: "enc:t" });
    state.recorder = createSqlRecorder([[existing], [{ ...existing, testWebhookEndpointId: null }], [{ ...existing, testWebhookEndpointId: "we_test_new" }]]);

    const res = await client().request(`${BASE}/${ID}/webhook?environment=test`, { method: "POST" });

    expect(res.status).toBe(200);
    expect(providers.test.deleteWebhook).toHaveBeenCalledWith("we_test_old");
    expect(providers.live.deleteWebhook).not.toHaveBeenCalled();
    expect(((await res.json()) as any).data.webhookSetup).toEqual({ status: "active", environment: "test" });
  });

  it("answers 404 for another org's integration", async () => {
    state.recorder = createSqlRecorder([[]]);
    const res = await client().request(`${BASE}/${ID}/webhook`, { method: "POST" });
    expect(res.status).toBe(404);
  });
});

describe("GET /integrations", () => {
  it("includes per-environment webhook state and the health stored on the row", async () => {
    state.recorder = createSqlRecorder([
      [
        row({
          webhookEndpointId: "we_1",
          testAccessTokenEnc: "enc:t",
          health: { coupon_sync: { area: "coupon_sync", message: "boom", at: "2026-11-18T10:00:00.000Z" } },
        }),
      ],
    ]);

    const res = await client().request(BASE);
    const body = (await res.json()) as { data: Array<Record<string, any>> };

    expect(body.data[0]!.webhooks).toEqual({ live: { status: "needs_attention" }, test: { status: "missing" } });
    expect(body.data[0]!.health).toEqual([{ area: "coupon_sync", message: "boom", at: "2026-11-18T10:00:00.000Z" }]);
    expect(body.data[0]).not.toHaveProperty("testWebhookSecretEnc");
    expect(state.recorder.queries).toHaveLength(1); // no per-integration health lookups
  });
});

describe("POST /integrations/:id/test", () => {
  it("records a rejected key on the integration's health", async () => {
    providers.live.listDiscounts.mockRejectedValueOnce(new ProviderAuthError("stripe", "Invalid API key"));
    state.recorder = createSqlRecorder([[row()]]);
    const c = client();

    const res = await c.request(`${BASE}/${ID}/test`, { method: "POST" });

    expect(((await res.json()) as any).ok).toBe(false);
    expect(healthWrites(state.recorder)).toEqual([expect.objectContaining({ area: "credentials", environment: "live" })]);
  });
});

describe("POST /integrations/:id/products/import", () => {
  it("rejects productIds that aren't an array of strings, before any query", async () => {
    state.recorder = createSqlRecorder([]);
    const c = client();

    for (const productIds of [undefined, [], "prod_1", [1, 2], [{ id: "x" }]]) {
      const res = await c.request(`${BASE}/${ID}/products/import`, { method: "POST", json: { productIds } });
      expect(res.status, JSON.stringify(productIds)).toBe(400);
    }
    expect(state.recorder.queries).toHaveLength(0);
  });

  it("never invents a product URL: a product without one is stored with an empty URL and deduplicated by name", async () => {
    Object.assign(providers.live, {
      listProducts: vi.fn(async () => [
        { providerProductId: "12", name: "Course", price: 49, currency: "USD", url: null },
        { providerProductId: "13", name: "Ebook", price: 9, currency: "USD", url: null },
        { providerProductId: "14", name: "Templates", price: 19, currency: "USD", url: "https://shop.example.com/product/templates/" },
      ]),
    });
    state.recorder = createSqlRecorder([
      [row({ provider: "woocommerce", providerAccountId: "https://shop.example.com" })],
      [], // subscription (none)
      [], // product count
      [{ maxProducts: 10 }], // limit override
      [{ url: "", name: "Ebook" }], // already imported without a URL
      [], // insert Course
      [], // insert Templates
    ]);

    const res = await client().request(`${BASE}/${ID}/products/import`, {
      method: "POST",
      json: { productIds: ["12", "13", "14"] },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { imported: 2, limitReached: false, skipped: [] } });
    const inserts = state.recorder.queries.filter((q) => q.sql.startsWith('insert into "products"'));
    expect(inserts).toHaveLength(2);
    expect(inserts[0]!.params).toEqual(expect.arrayContaining(["Course", ""]));
    expect(inserts[1]!.params).toEqual(expect.arrayContaining(["Templates", "https://shop.example.com/product/templates/"]));
    for (const q of inserts) expect(q.params.join(" ")).not.toMatch(/woocommerce\.com/);
  });

  it("stores the currency in upper case and skips (and reports) a product priced outside the supported currencies", async () => {
    // Stripe returns lower-case ISO codes; the insert bypasses the product
    // schema, so the route applies the same rule.
    Object.assign(providers.live, {
      listProducts: vi.fn(async () => [
        { providerProductId: "prod_usd", name: "Starter", price: 19, currency: "usd", url: null },
        { providerProductId: "prod_inr", name: "India plan", price: 1499, currency: "inr", url: null },
        { providerProductId: "prod_xxx", name: "Test currency", price: 5, currency: "xxx", url: null },
        { providerProductId: "prod_clf", name: "Chile UF plan", price: 1.25, currency: "clf", url: null },
        { providerProductId: "prod_none", name: "No currency", price: null, currency: null, url: null },
      ]),
    });
    state.recorder = createSqlRecorder([
      [row({ provider: "stripe" })],
      [], // subscription (none)
      [], // product count
      [{ maxProducts: 10 }], // limit override
      [], // nothing imported yet
      [], // insert Starter
      [], // insert India plan
      [], // insert No currency
    ]);

    const res = await client().request(`${BASE}/${ID}/products/import`, {
      method: "POST",
      json: { productIds: ["prod_usd", "prod_inr", "prod_xxx", "prod_clf", "prod_none"] },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: {
        imported: 3,
        limitReached: false,
        skipped: [
          { providerProductId: "prod_xxx", name: "Test currency", currency: "xxx", reason: "unsupported_currency" },
          { providerProductId: "prod_clf", name: "Chile UF plan", currency: "clf", reason: "unsupported_currency" },
        ],
      },
    });
    const inserts = state.recorder.queries.filter((q) => q.sql.startsWith('insert into "products"'));
    expect(inserts).toHaveLength(3);
    expect(inserts[0]!.params).toEqual(expect.arrayContaining(["Starter", "USD"]));
    expect(inserts[1]!.params).toEqual(expect.arrayContaining(["India plan", "INR"]));
    expect(inserts[2]!.params).toEqual(expect.arrayContaining(["No currency", "USD"])); // no currency: USD, as before
    for (const q of inserts) {
      expect(q.params).not.toContain("usd");
      expect(q.params).not.toContain("inr");
    }
  });
});

describe("DELETE /integrations/:id", () => {
  it("detaches campaigns and coupons in one transaction BEFORE deleting the integration, then tears down the webhook", async () => {
    // campaigns.integration_id / coupons.integration_id have no ON DELETE action:
    // the old route deleted the integration while they still pointed at it.
    const existing = row({ webhookEndpointId: "we_live" });
    state.recorder = createSqlRecorder([
      [existing],
      [], // no country prices set at Dodo with this key
      [{ id: "cmp_auto" }], // A/B guard: lock the integration's active auto-apply campaigns
      [], // A/B guard: no running experiment uses one of them
      [{ id: "cmp_auto" }], // paused auto-apply campaigns
      [], // detach campaigns
      [{ status: "active" }, { status: "deleted" }, { status: "retiring" }], // coupons removed
      [], // delete integration
    ]);

    const res = await client().request(`${BASE}/${ID}`, { method: "DELETE" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, pausedCampaigns: 1, codesLeftAtProvider: 2 });
    expect(state.recorder.transactions).toEqual(["commit"]);
    expect(state.recorder.queries[1]!.sql).toMatch(/^select "id" from "campaign_country_prices" where/);
    const sqls = state.recorder.queries.slice(2).map((q) => q.sql);
    expect(sqls[0]).toMatch(/^select "id" from "campaigns" where .* for update$/);
    expect(sqls[1]).toMatch(/^select "experiments"."id", "experiments"."name" from "experiments" inner join "campaigns"/);
    expect(sqls[2]).toMatch(/^update "campaigns" set "status" = \$1/);
    expect(sqls[3]).toMatch(/^update "campaigns" set "integration_id" = \$1/);
    expect(sqls[4]).toMatch(/^delete from "coupons" where "coupons"."integration_id" = \$1 returning "status"$/);
    expect(sqls[5]).toMatch(/^delete from "integrations"/);
    expect(providers.live.deleteWebhook).toHaveBeenCalledWith("we_live");
    expect(state.push).toHaveBeenCalledOnce();
  });

  it("refuses (409) a disconnect that would pause an arm of a running A/B test: nothing changes, no provider call", async () => {
    state.recorder = createSqlRecorder([
      [row({ webhookEndpointId: "we_live" })],
      [],
      [{ id: "cmp_auto" }],
      [{ id: "01JEXPERIMENTXXXXXXXXXXXXX", name: "India 30 vs 45" }],
    ]);

    const res = await client().request(`${BASE}/${ID}`, { method: "DELETE" });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: "integration_in_running_experiment",
      experimentId: "01JEXPERIMENTXXXXXXXXXXXXX",
    });
    expect(state.recorder.transactions).toEqual(["rollback"]);
    expect(state.recorder.queries).toHaveLength(4);
    expect(state.recorder.queries[3]!.params).toEqual([ORG, "running", ORG, ID, "active", "auto_apply", 1]);
    expect(state.recorder.queries.some((q) => /^(update|delete)/.test(q.sql))).toBe(false);
    expect(state.create).not.toHaveBeenCalled();
    expect(providers.live.deleteWebhook).not.toHaveBeenCalled();
    expect(state.push).not.toHaveBeenCalled();
  });

  it("keeps the webhook when the database delete fails (no connected-looking integration with dead tracking)", async () => {
    state.recorder = createSqlRecorder([[row({ webhookEndpointId: "we_live" })], [], new Error("deadlock detected")]);

    const res = await client().request(`${BASE}/${ID}`, { method: "DELETE" });

    expect(res.status).toBe(500);
    expect(state.recorder.transactions).toEqual(["rollback"]);
    expect(providers.live.deleteWebhook).not.toHaveBeenCalled();
  });

  it("tears down both endpoints, each with its own environment's key", async () => {
    state.recorder = createSqlRecorder([
      [row({ testAccessTokenEnc: "enc:sk_test", webhookEndpointId: "we_live", testWebhookEndpointId: "we_test" })],
      [],
      [],
      [],
      [],
      [],
      [],
    ]);

    await client().request(`${BASE}/${ID}`, { method: "DELETE" });

    expect(providers.live.deleteWebhook).toHaveBeenCalledWith("we_live");
    expect(providers.test.deleteWebhook).toHaveBeenCalledWith("we_test");
    expect(configs.map((c) => [c.config.environment, c.config.apiKey])).toEqual([
      ["live", "sk_live"],
      ["test", "sk_test"],
    ]);
  });

  it("tears a test-only integration's webhook down with the test key", async () => {
    state.recorder = createSqlRecorder([
      [row({ liveAccessTokenEnc: null, testAccessTokenEnc: "enc:sk_test", testWebhookEndpointId: "we_test" })],
      [],
      [],
      [],
      [],
      [],
      [],
    ]);

    await client().request(`${BASE}/${ID}`, { method: "DELETE" });

    expect(providers.test.deleteWebhook).toHaveBeenCalledWith("we_test");
    expect(providers.live.deleteWebhook).not.toHaveBeenCalled();
  });
});
