import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { INTEGRATION_PROVIDERS, PROVIDERS_WITH_PRODUCT_IMPORT, providerCanImportProducts } from "@gopaylocal/shared";
import { createSqlRecorder, type SqlRecorder } from "../lib/sql-recorder-test-helpers";
import { createMockKV, createTestBindings, createTestClient, mountRoutes } from "../test/helpers";

// PROVIDERS_WITH_PRODUCT_IMPORT (packages/shared; the dashboard shows the
// Import button from it) must say what the products routes actually do. Those
// routes decide on the provider's real adapter: one without listProducts()
// gets 400 "This provider does not support product listing". So every provider
// here goes through the real createProvider; the only change is that an
// adapter's own listProducts() is replaced by a stub, so no provider API is
// called. No database: createDb() returns the SQL recorder.

const state = vi.hoisted(() => ({
  recorder: null as unknown as SqlRecorder,
  listed: [] as string[],
}));

vi.mock("../db", () => ({ createDb: () => state.recorder.db }));
vi.mock("../services/banner-cache.service", () => ({ pushBannerConfigForOrg: async () => {} }));
vi.mock("../services/providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/providers")>();
  return {
    ...actual,
    createProvider: (...args: Parameters<typeof actual.createProvider>) => {
      const adapter = actual.createProvider(...args);
      if (typeof adapter.listProducts === "function") {
        adapter.listProducts = async () => {
          state.listed.push(args[0]);
          return [];
        };
      }
      return adapter;
    },
  };
});
vi.mock("../lib/crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/crypto")>();
  return {
    ...actual,
    decrypt: async (v: string) => v.replace(/^enc:/, ""),
    tokenEncryptionSecret: () => "secret",
  };
});

const { default: integrationsRoute } = await import("./integrations");

const ORG = "org_1";
const ID = "int_1";
const BASE = `/v1/teams/${ORG}/integrations`;
const NOT_SUPPORTED = { error: "This provider does not support product listing" };

const ACCOUNT_IDS: Record<string, string> = {
  woocommerce: "https://shop.example.com",
  chargebee: "acme-test",
};

/** A connected integration with live credentials, as the integrations table stores it. */
function row(provider: string) {
  return {
    id: ID,
    organizationId: ORG,
    provider,
    liveAccessTokenEnc: "enc:key_live",
    liveRefreshTokenEnc: null,
    testAccessTokenEnc: null,
    testRefreshTokenEnc: null,
    // Valid account ids for the adapters that check them at construction:
    // WooCommerce's store URL, Chargebee's site name. Whop takes any id.
    providerAccountId: ACCOUNT_IDS[provider] ?? "acct_1",
    testProviderAccountId: null,
    webhookEndpointId: null,
    webhookSecretEnc: null,
    testWebhookEndpointId: null,
    testWebhookSecretEnc: null,
    health: {},
    status: "active",
    createdAt: new Date("2026-11-01T00:00:00Z"),
    updatedAt: new Date("2026-11-01T00:00:00Z"),
  };
}

function client() {
  return createTestClient(
    mountRoutes(integrationsRoute, { userId: "u_1", role: "admin" }),
    createTestBindings({ CACHE: createMockKV() }),
  );
}

beforeEach(() => {
  state.listed = [];
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PROVIDERS_WITH_PRODUCT_IMPORT matches the products routes", () => {
  it("has providers on both sides, so neither branch below is empty", () => {
    expect(PROVIDERS_WITH_PRODUCT_IMPORT.length).toBeGreaterThan(0);
    expect(INTEGRATION_PROVIDERS.some((p) => !providerCanImportProducts(p))).toBe(true);
  });

  for (const provider of INTEGRATION_PROVIDERS) {
    if (providerCanImportProducts(provider)) {
      it(`${provider}: in the list, and its adapter lists products`, async () => {
        state.recorder = createSqlRecorder([[row(provider)]]);
        const res = await client().request(`${BASE}/${ID}/products`);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ data: [] });
        expect(state.listed).toEqual([provider]);
      });
    } else {
      it(`${provider}: not in the list, and both products routes answer 400`, async () => {
        state.recorder = createSqlRecorder([[row(provider)]]);
        const list = await client().request(`${BASE}/${ID}/products`);
        expect(list.status).toBe(400);
        expect(await list.json()).toEqual(NOT_SUPPORTED);

        state.recorder = createSqlRecorder([[row(provider)]]);
        const imported = await client().request(`${BASE}/${ID}/products/import`, {
          method: "POST",
          json: { productIds: ["p_1"] },
        });
        expect(imported.status).toBe(400);
        expect(await imported.json()).toEqual(NOT_SUPPORTED);
        expect(state.listed).toEqual([]);
      });
    }
  }
});
