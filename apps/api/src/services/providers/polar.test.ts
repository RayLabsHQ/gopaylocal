// ── Polar provider tests ────────────────────────────────────────────────────
// Every expectation below comes from Polar's official docs / OpenAPI spec for
// API version 2026-10 (fetched 2026-11-18):
//   spec:       https://api.polar.sh/openapi.json   (info.version "2026-10")
//   versioning: https://polar.sh/docs/api-reference/2026-10/versioning.md
//   webhooks:   https://polar.sh/docs/integrate/webhooks/delivery.md
//               https://polar.sh/docs/changelog/api.md
//   SDK source: @polar-sh/sdk@1.3.0 dist/webhooks-*.mjs (hmacKeys/verifySignature)
// The provider talks to the REST API with plain fetch, so global `fetch` is the
// mocked transport and the assertions are on the real outgoing request.

import { readFileSync } from "node:fs";
import { createHmac, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PolarProvider } from "./polar";
import { ProviderAuthError, ProviderError, ProviderNotFoundError } from "./types";

// Route-level tests further down import routes/webhooks.ts; these mocks keep it
// off the real database / crypto. They do not affect the provider itself.
vi.mock("../../db", () => ({ createDb: vi.fn() }));
vi.mock("../../lib/crypto", () => ({
  decrypt: vi.fn(),
  encrypt: vi.fn(),
  tokenEncryptionSecret: vi.fn(() => "test-encryption-secret"),
}));
vi.mock("../redemption.service", () => ({ handleRedemption: vi.fn(async () => true) }));
vi.mock("../banner-cache.service", () => ({ pushBannerConfigForOrg: vi.fn(async () => {}) }));

const LIVE = "https://api.polar.sh";
const SANDBOX = "https://sandbox-api.polar.sh";
const TOKEN = "polar_oat_test_token";
// The API contract these tests were verified against. Bump together with
// POLAR_API_VERSION in polar.ts after re-checking the new version's changes.
const PINNED_VERSION = "2026-10";

const fixture = (name: string): string =>
  readFileSync(new URL(`./__fixtures__/polar/${name}`, import.meta.url), "utf8");

// ── fetch mock ──────────────────────────────────────────────────────────────

interface Captured {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function installFetch(...replies: Array<Response | Error>) {
  const calls: Captured[] = [];
  const queue = [...replies];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    calls.push({
      url: new URL(href),
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : (init?.body ?? undefined),
    });
    const next = queue.shift();
    if (!next) throw new Error(`unexpected fetch: ${init?.method ?? "GET"} ${href}`);
    if (next instanceof Error) throw next;
    return next;
  });
  vi.stubGlobal("fetch", fn);
  return { calls, fn };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const noContent = () => new Response(null, { status: 204 });

const target = (c: Captured) => ({
  path: c.url.origin + c.url.pathname,
  query: Object.fromEntries(c.url.searchParams),
});

// Bearer auth (securitySchemes.oat); version pinning via the `Polar-Version`
// header ("Pin a version in every production integration").
const expectPolarHeaders = (c: Captured, withBody: boolean) => {
  expect(c.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
  expect(c.headers["accept"]).toBe("application/json");
  expect(c.headers["polar-version"]).toBe(PINNED_VERSION);
  if (withBody) expect(c.headers["content-type"]).toBe("application/json");
  else expect(c.headers["content-type"]).toBeUndefined();
};

// components.schemas.DiscountPercentageOnceForeverDuration (2026-10)
const discountObj = (over: Record<string, unknown> = {}) => ({
  duration: "forever",
  type: "percentage",
  basis_points: 4000,
  created_at: "2026-11-01T00:00:00Z",
  modified_at: null,
  id: "3e9d1c7b-2a4f-4b6e-9c8d-7f1e2d3c4b5a",
  metadata: { gopaylocal: "true" },
  name: "PPP IN 40%",
  code: "PPPIN40K7QX",
  starts_at: null,
  ends_at: null,
  max_redemptions: null,
  max_redemptions_per_customer: null,
  redemptions_count: 0,
  organization_id: "1dbfc517-0bbf-4301-9ba8-555ca42b9737",
  products: [],
  ...over,
});

const provider = (environment: "live" | "test" = "live") => new PolarProvider({ apiKey: TOKEN, environment });

beforeEach(() => {
  vi.unstubAllGlobals();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

// ── API version pin ─────────────────────────────────────────────────────────

describe("Polar API version pin", () => {
  it(`is still inside the support window for ${PINNED_VERSION}`, () => {
    // Versions live ~9 months: 3 as Next, 3 as Current, 3 as Deprecated, then a
    // removed version answers every request with 404 ("A malformed, unknown, or
    // removed version returns 404 Not Found"). 2026-10 is Current from
    // 2026-10-01, Deprecated from early 2027-01, removed in early 2027-04.
    // This test fails a month before removal so the bump is not missed: review
    // https://polar.sh/docs/changelog/api.md, bump POLAR_API_VERSION + this
    // constant, and update the date.
    expect(Date.now(), `Polar API ${PINNED_VERSION} is removed in April 2027 — upgrade it`).toBeLessThan(
      Date.UTC(2027, 2, 1),
    );
  });
});

// ── createDiscount ──────────────────────────────────────────────────────────
// POST /v1/discounts/ — DiscountPercentageCreate: required name, duration,
// basis_points; code "between 3 and 256 characters long and contain only
// alphanumeric characters"; organization_id "Required unless you use an
// organization token".

describe("PolarProvider: createDiscount", () => {
  it("POSTs a forever percentage discount with basis_points and gopaylocal metadata", async () => {
    const { calls } = installFetch(json(discountObj(), 201));
    const result = await provider().createDiscount({
      name: "PPP IN 40%",
      code: "PPPIN40K7QX",
      discountType: "percentage",
      amount: 40,
    });

    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.method).toBe("POST");
    expect(target(c)).toEqual({ path: `${LIVE}/v1/discounts/`, query: {} });
    expectPolarHeaders(c, true);
    expect(c.body).toEqual({
      name: "PPP IN 40%",
      code: "PPPIN40K7QX",
      duration: "forever",
      metadata: { gopaylocal: "true" },
      type: "percentage",
      basis_points: 4000, // "to create a 25.5% discount, set this to 2550"
    });
    expect(result).toEqual({
      providerDiscountId: "3e9d1c7b-2a4f-4b6e-9c8d-7f1e2d3c4b5a",
      code: "PPPIN40K7QX",
      discountPercent: 40,
      provider: "polar",
    });
  });

  it("keeps fractional percentages exact in basis points", async () => {
    const { calls } = installFetch(json(discountObj({ basis_points: 3350 }), 201));
    const result = await provider().createDiscount({
      name: "n",
      code: "PPPBR34ABCD",
      discountType: "percentage",
      amount: 33.5,
    });
    expect((calls[0]!.body as { basis_points: number }).basis_points).toBe(3350);
    expect(result.discountPercent).toBe(33.5);
  });

  it("maps productIds → products, maxRedemptions → max_redemptions, expiresAt → ends_at", async () => {
    const { calls } = installFetch(json(discountObj(), 201));
    await provider().createDiscount({
      name: "n",
      code: "PPPIN40K7QX",
      discountType: "percentage",
      amount: 40,
      productIds: ["1b2c3d4e-5f60-4718-8293-a4b5c6d7e8f9"],
      maxRedemptions: 10,
      expiresAt: "2027-01-31T00:00:00.000Z",
    });
    expect(calls[0]!.body).toMatchObject({
      products: ["1b2c3d4e-5f60-4718-8293-a4b5c6d7e8f9"],
      max_redemptions: 10,
      ends_at: "2027-01-31T00:00:00.000Z",
    });
    expect(calls[0]!.body).not.toHaveProperty("product_ids");
    expect(calls[0]!.body).not.toHaveProperty("expires_at");
  });

  it("sends fixed discounts through the `amounts` currency map only (amount/currency are deprecated, removed in 2027-01)", async () => {
    const { calls } = installFetch(
      json(discountObj({ type: "fixed", basis_points: undefined, amounts: { eur: 500 } }), 201),
    );
    const result = await provider().createDiscount({
      name: "n",
      code: "PPPFIXED500",
      discountType: "fixed",
      amount: 500,
      currency: "EUR",
    });
    const body = calls[0]!.body as Record<string, unknown>;
    expect(body).toMatchObject({ type: "fixed", duration: "forever", amounts: { eur: 500 } });
    expect(body).not.toHaveProperty("amount");
    expect(body).not.toHaveProperty("currency");
    expect(body).not.toHaveProperty("basis_points");
    expect(result.discountPercent).toBe(0);
  });

  it("defaults a fixed discount without currency to usd (the documented default)", async () => {
    const { calls } = installFetch(json(discountObj({ type: "fixed" }), 201));
    await provider().createDiscount({ name: "n", code: "PPPFIXED500", discountType: "fixed", amount: 500 });
    expect((calls[0]!.body as { amounts: unknown }).amounts).toEqual({ usd: 500 });
  });

  it("uses the sandbox API for the test environment", async () => {
    const { calls } = installFetch(json(discountObj(), 201));
    await provider("test").createDiscount({ name: "n", code: "PPPIN40K7QX", discountType: "percentage", amount: 40 });
    expect(target(calls[0]!).path).toBe(`${SANDBOX}/v1/discounts/`);
  });

  it.each([
    ["PPP-IN40-K7QX", "hyphens"],
    ["PP", "shorter than 3"],
    ["A".repeat(257), "longer than 256"],
    ["PPP IN40", "spaces"],
  ])("rejects code %s (%s) before calling the API", async (code) => {
    const { fn } = installFetch();
    await expect(
      provider().createDiscount({ name: "n", code, discountType: "percentage", amount: 40 }),
    ).rejects.toThrow(/alphanumeric/);
    expect(fn).not.toHaveBeenCalled();
  });

  it("surfaces a 422 HTTPValidationError as a readable message with status", async () => {
    installFetch(
      json(
        { detail: [{ loc: ["body", "percentage", "code"], msg: "Discount code already exists", type: "value_error" }] },
        422,
      ),
    );
    const err = (await provider()
      .createDiscount({ name: "n", code: "PPPIN40K7QX", discountType: "percentage", amount: 40 })
      .catch((e: unknown) => e)) as ProviderError;
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.statusCode).toBe(422);
    expect(err.message).toContain("body.percentage.code: Discount code already exists");
  });
});

// ── deleteDiscount ──────────────────────────────────────────────────────────
// DELETE /v1/discounts/{id} — 204 (no body) | 404 ResourceNotFound

describe("PolarProvider: deleteDiscount", () => {
  it("DELETEs /v1/discounts/{id} and accepts 204", async () => {
    const { calls } = installFetch(noContent());
    await expect(provider().deleteDiscount("3e9d1c7b-2a4f-4b6e-9c8d-7f1e2d3c4b5a")).resolves.toBeUndefined();
    expect(calls[0]!.method).toBe("DELETE");
    expect(target(calls[0]!)).toEqual({
      path: `${LIVE}/v1/discounts/3e9d1c7b-2a4f-4b6e-9c8d-7f1e2d3c4b5a`,
      query: {},
    });
    expectPolarHeaders(calls[0]!, false);
    expect(calls[0]!.body).toBeUndefined();
  });

  it("maps 404 ResourceNotFound to ProviderNotFoundError (statusCode 404)", async () => {
    installFetch(json({ error: "ResourceNotFound", detail: "Not found" }, 404));
    const err = await provider().deleteDiscount("missing").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderNotFoundError);
    expect((err as ProviderError).statusCode).toBe(404);
  });
});

// ── listDiscounts ───────────────────────────────────────────────────────────
// GET /v1/discounts/ — page (default 1), limit ("Maximum is 100");
// ListResource_Discount_ = { items, pagination: { total_count, max_page } }

describe("PolarProvider: listDiscounts", () => {
  it("pages with page/limit=100 until pagination.max_page and keeps only GoPayLocal discounts", async () => {
    const { calls } = installFetch(
      json({
        items: [discountObj({ id: "d1", code: "PPPIN40AAAA" }), discountObj({ id: "mine-not", metadata: {} })],
        pagination: { total_count: 3, max_page: 2 },
      }),
      json({
        items: [discountObj({ id: "d2", code: null, basis_points: 2550 })],
        pagination: { total_count: 3, max_page: 2 },
      }),
    );
    const result = await provider().listDiscounts();

    expect(calls).toHaveLength(2);
    expect(target(calls[0]!)).toEqual({ path: `${LIVE}/v1/discounts/`, query: { page: "1", limit: "100" } });
    expect(target(calls[1]!)).toEqual({ path: `${LIVE}/v1/discounts/`, query: { page: "2", limit: "100" } });
    calls.forEach((c) => {
      expect(c.method).toBe("GET");
      expectPolarHeaders(c, false);
    });
    expect(result).toEqual([
      { providerDiscountId: "d1", code: "PPPIN40AAAA", discountPercent: 40, provider: "polar" },
      { providerDiscountId: "d2", code: "", discountPercent: 25.5, provider: "polar" },
    ]);
  });

  it("leaves out discounts whose ends_at has passed (listDiscounts returns only redeemable ones)", async () => {
    // An ended discount used to be listed, so coupon sync kept showing it.
    installFetch(
      json({
        items: [
          discountObj({ id: "ended", ends_at: "2000-01-01T00:00:00Z" }),
          discountObj({ id: "later", ends_at: "2999-01-01T00:00:00Z" }),
          discountObj({ id: "open", ends_at: null }),
        ],
        pagination: { total_count: 3, max_page: 1 },
      }),
    );
    const result = await provider().listDiscounts();
    expect(result.map((d) => d.providerDiscountId)).toEqual(["later", "open"]);
  });
});

// ── buildCheckoutUrl ────────────────────────────────────────────────────────
// POST /v1/checkouts/ — CheckoutProductsCreate (snake_case): products,
// discount_id, success_url, customer_email, metadata. There is no
// discount_code field on checkout sessions; discounts go by id.
// Response: Checkout (url required).

describe("PolarProvider: buildCheckoutUrl", () => {
  it("POSTs snake_case fields and returns checkout.url", async () => {
    const { calls } = installFetch(
      json({ id: "chk_1", url: "https://buy.polar.sh/polar_c_abc", discount_id: "d1" }, 201),
    );
    const url = await provider().buildCheckoutUrl({
      productId: "1b2c3d4e-5f60-4718-8293-a4b5c6d7e8f9",
      discountId: "d1",
      discountCode: "PPPIN40K7QX",
      successUrl: "https://merchant.example/thanks?checkout_id={CHECKOUT_ID}",
      customerEmail: "asha@example.com",
      metadata: { country: "IN" },
    });

    expect(url).toBe("https://buy.polar.sh/polar_c_abc");
    const c = calls[0]!;
    expect(c.method).toBe("POST");
    expect(target(c)).toEqual({ path: `${LIVE}/v1/checkouts/`, query: {} });
    expectPolarHeaders(c, true);
    expect(c.body).toEqual({
      products: ["1b2c3d4e-5f60-4718-8293-a4b5c6d7e8f9"],
      success_url: "https://merchant.example/thanks?checkout_id={CHECKOUT_ID}",
      discount_id: "d1",
      customer_email: "asha@example.com",
      metadata: { country: "IN" },
    });
  });

  it("throws when the checkout has no url", async () => {
    installFetch(json({ id: "chk_1" }, 201));
    await expect(
      provider().buildCheckoutUrl({ productId: "p", successUrl: "https://m.example/t" }),
    ).rejects.toThrow(/No checkout URL/);
  });
});

// ── provisionWebhook / deleteWebhook ────────────────────────────────────────
// POST /v1/webhooks/endpoints — WebhookEndpointCreate: required url, format,
// events; api_version enum ["2026-04","2026-10"]; `secret` was REMOVED from
// the request in 2026-10 ("New endpoint secrets are generated by Polar").
// Response WebhookEndpoint has required id + secret.
// DELETE /v1/webhooks/endpoints/{id} — 204.

describe("PolarProvider: provisionWebhook / deleteWebhook", () => {
  const endpoint = {
    created_at: "2026-11-18T00:00:00Z",
    modified_at: null,
    id: "we_9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a",
    url: "https://api.example/v1/webhooks/polar/int_1",
    name: null,
    api_version: "2026-10",
    format: "raw",
    secret: "whsec_FAKE-not-a-real-secret",
    organization_id: "1dbfc517-0bbf-4301-9ba8-555ca42b9737",
    events: ["order.paid"],
    enabled: true,
    uses_standard_webhook_signature: true,
  };

  it("creates a raw-format order.paid endpoint pinned to the API version and reads id + secret", async () => {
    const { calls } = installFetch(json(endpoint, 201));
    const res = await provider().provisionWebhook("https://api.example/v1/webhooks/polar/int_1");

    const c = calls[0]!;
    expect(c.method).toBe("POST");
    expect(target(c)).toEqual({ path: `${LIVE}/v1/webhooks/endpoints`, query: {} });
    expectPolarHeaders(c, true);
    expect(c.body).toEqual({
      url: "https://api.example/v1/webhooks/polar/int_1",
      format: "raw",
      events: ["order.paid"],
      api_version: PINNED_VERSION,
    });
    expect(c.body).not.toHaveProperty("secret");
    expect(res).toEqual({ endpointId: endpoint.id, secret: endpoint.secret });
  });

  it("throws if the response carries no id or secret (nothing usable to store)", async () => {
    installFetch(json({ ...endpoint, secret: undefined }, 201));
    await expect(provider().provisionWebhook("https://x.example/a")).rejects.toBeInstanceOf(ProviderError);
  });

  it("maps a 403 (token lacks webhooks:write) to ProviderAuthError", async () => {
    installFetch(json({ error: "NotPermitted", detail: "Insufficient scope" }, 403));
    await expect(provider().provisionWebhook("https://x.example/a")).rejects.toBeInstanceOf(ProviderAuthError);
  });

  it("wraps a network failure in ProviderError", async () => {
    installFetch(new TypeError("fetch failed"));
    await expect(provider().provisionWebhook("https://x.example/a")).rejects.toBeInstanceOf(ProviderError);
  });

  it("DELETEs /v1/webhooks/endpoints/{id} and accepts 204", async () => {
    const { calls } = installFetch(noContent());
    await expect(provider().deleteWebhook(endpoint.id)).resolves.toBeUndefined();
    expect(calls[0]!.method).toBe("DELETE");
    expect(target(calls[0]!)).toEqual({ path: `${LIVE}/v1/webhooks/endpoints/${endpoint.id}`, query: {} });
    expectPolarHeaders(calls[0]!, false);
  });
});

// ── verifyWebhook ───────────────────────────────────────────────────────────
// https://polar.sh/docs/integrate/webhooks/delivery.md#custom-validation:
//   "Secrets generated on or after 8 September 2026, 00:00 UTC are Standard
//    Webhooks. Older secrets are Polar HMAC."
//   Before: "Key is the UTF-8 bytes of the full whsec_… string."
//   After:  Standard Webhooks — "Pass the whsec_… secret to the library as-is"
//           (the library strips whsec_ and base64-decodes the rest).
//   "Polar SDKs 1.0.0-alpha.19 and later try both keys." (confirmed in
//   @polar-sh/sdk@1.3.0: hmacKeys() = [utf8(secret), b64decode(secret sans whsec_)];
//   tolerance 300s).
// Signed content `${webhook-id}.${webhook-timestamp}.${body}`, HMAC-SHA256,
// base64, header `v1,<sig>` (space-separated list).

describe("PolarProvider: verifyWebhook", () => {
  const rawBody = fixture("order-paid-purchase-with-discount.json");
  const msgId = "msg_2pQJk1a3xYz";
  const now = () => Math.floor(Date.now() / 1000);

  // Independent signer (node:crypto), not the code under test.
  const sign = (key: Buffer, id: string, ts: number, body: string) =>
    createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64");

  const standardKey = randomBytes(32);
  const standardSecret = `whsec_${standardKey.toString("base64")}`; // generated by Polar ≥ 2026-09-08
  const legacySecret = `whsec_${randomBytes(24).toString("base64")}`; // generated before the cutoff
  const legacyKey = Buffer.from(legacySecret, "utf8");

  const verify = (
    body: string,
    secret: string | null,
    headers: Partial<Record<"webhook-id" | "webhook-timestamp" | "webhook-signature", string>>,
  ) => provider().verifyWebhook({ rawBody: body, headers: new Headers(headers as Record<string, string>), secret });

  const signedHeaders = (key: Buffer, ts = now(), body = rawBody) => ({
    "webhook-id": msgId,
    "webhook-timestamp": String(ts),
    "webhook-signature": `v1,${sign(key, msgId, ts, body)}`,
  });

  it("accepts a Standard Webhooks signature (secret generated on/after 2026-09-08)", async () => {
    expect(await verify(rawBody, standardSecret, signedHeaders(standardKey))).toBe(true);
  });

  it("accepts a legacy Polar HMAC signature (key = UTF-8 bytes of the full secret)", async () => {
    expect(await verify(rawBody, legacySecret, signedHeaders(legacyKey))).toBe(true);
  });

  it("accepts a legacy user-provided secret that is not base64 at all", async () => {
    const secret = "my-own-webhook-secret!";
    expect(await verify(rawBody, secret, signedHeaders(Buffer.from(secret, "utf8")))).toBe(true);
  });

  it("accepts when one of several space-separated signatures matches", async () => {
    const ts = now();
    const good = sign(standardKey, msgId, ts, rawBody);
    expect(
      await verify(rawBody, standardSecret, {
        "webhook-id": msgId,
        "webhook-timestamp": String(ts),
        "webhook-signature": `v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= v1,${good}`,
      }),
    ).toBe(true);
  });

  it("rejects a tampered body", async () => {
    const headers = signedHeaders(standardKey);
    expect(await verify(rawBody.replace('"discount_amount": 800', '"discount_amount": 1800'), standardSecret, headers)).toBe(
      false,
    );
  });

  it("rejects a signature made with a different secret", async () => {
    expect(await verify(rawBody, standardSecret, signedHeaders(randomBytes(32)))).toBe(false);
  });

  it("rejects a tampered webhook-id (it is part of the signed content)", async () => {
    const headers = { ...signedHeaders(standardKey), "webhook-id": "msg_other" };
    expect(await verify(rawBody, standardSecret, headers)).toBe(false);
  });

  it.each(["webhook-id", "webhook-timestamp", "webhook-signature"] as const)(
    "rejects when %s is missing",
    async (missing) => {
      const headers: Record<string, string> = signedHeaders(standardKey);
      delete headers[missing];
      expect(await verify(rawBody, standardSecret, headers)).toBe(false);
    },
  );

  it.each([
    ["garbage", "not-a-signature"],
    ["empty v1", "v1,"],
    ["bad base64", "v1,!!!!"],
  ])("rejects a malformed signature header (%s)", async (_label, sig) => {
    const headers = { ...signedHeaders(standardKey), "webhook-signature": sig };
    expect(await verify(rawBody, standardSecret, headers)).toBe(false);
  });

  it("rejects a non-numeric timestamp", async () => {
    const headers = { ...signedHeaders(standardKey), "webhook-timestamp": "yesterday" };
    expect(await verify(rawBody, standardSecret, headers)).toBe(false);
  });

  it("enforces the 300s tolerance in both directions", async () => {
    expect(await verify(rawBody, standardSecret, signedHeaders(standardKey, now() - 290))).toBe(true);
    expect(await verify(rawBody, standardSecret, signedHeaders(standardKey, now() - 310))).toBe(false);
    expect(await verify(rawBody, standardSecret, signedHeaders(standardKey, now() + 310))).toBe(false);
  });

  it("rejects everything when no secret is stored for the integration", async () => {
    expect(await verify(rawBody, null, signedHeaders(standardKey))).toBe(false);
  });
});

// ── parseRedemption ─────────────────────────────────────────────────────────
// Payload: components.schemas.WebhookOrderPaidPayload { type: "order.paid",
// timestamp, api_version, data: Order }. Order amounts are "in cents";
// billing_reason ∈ purchase | subscription_create | subscription_cycle |
// subscription_update | subscription_meter_cycle
// (https://polar.sh/docs/features/orders.md). On renewal Polar emits
// order.created → order.updated → order.paid for the new cycle's order
// (https://polar.sh/docs/integrate/webhooks/events.md, "Renewal Sequences"),
// and a forever discount stays on it — so billing_reason must be checked.
// Fixtures are built from the 2026-10 Order schema (every required field);
// Polar publishes no example payload.

describe("PolarProvider: parseRedemption", () => {
  const withReason = (reason: string) => {
    const evt = JSON.parse(fixture("order-paid-subscription-cycle.json"));
    evt.data.billing_reason = reason;
    return JSON.stringify(evt);
  };

  it("parses a one-time purchase with a discount", () => {
    expect(provider().parseRedemption(fixture("order-paid-purchase-with-discount.json"))).toEqual({
      eventId: "0f6a9a3e-6f0e-4f3c-9d43-2a1c7d8b5e01",
      code: "PPPIN40K7QX",
      providerCouponId: "3e9d1c7b-2a4f-4b6e-9c8d-7f1e2d3c4b5a",
      providerPromoCodeId: null,
      chargedAmountCents: 1416, // total_amount, integer cents (not 14.16)
      taxAmountCents: 216, // tax_amount
      discountAmountCents: 800, // subtotal_amount 2000 − net_amount 1200 (both pre-tax)
      currency: "usd",
    });
  });

  it("takes the pre-tax discount from subtotal − net, and discount_amount only for an untaxed order (C3)", () => {
    const evt = JSON.parse(fixture("order-paid-purchase-with-discount.json"));
    // discount_amount has no tax wording in the docs; subtotal − net does.
    Object.assign(evt.data, { discount_amount: 999 });
    expect(provider().parseRedemption(JSON.stringify(evt))?.discountAmountCents).toBe(800);

    const { subtotal_amount: _s, net_amount: _n, ...rest } = evt.data;
    expect(provider().parseRedemption(JSON.stringify({ ...evt, data: rest }))?.discountAmountCents).toBeNull();
    expect(
      provider().parseRedemption(JSON.stringify({ ...evt, data: { ...rest, tax_amount: 0 } }))?.discountAmountCents,
    ).toBe(999);
    expect(
      provider().parseRedemption(JSON.stringify({ ...evt, data: { ...rest, tax_amount: undefined } }))?.taxAmountCents,
    ).toBeNull();
  });

  it("returns null for a purchase with no discount", () => {
    expect(provider().parseRedemption(fixture("order-paid-no-discount.json"))).toBeNull();
  });

  it.each(["order.created", "order.updated", "order.refunded", "subscription.active"])(
    "returns null for an unrelated event (%s) even if it carries a discounted order",
    (type) => {
      const evt = JSON.parse(fixture("order-paid-purchase-with-discount.json"));
      evt.type = type;
      expect(provider().parseRedemption(JSON.stringify(evt))).toBeNull();
    },
  );

  it("counts the first order of a new subscription (subscription_create)", () => {
    expect(provider().parseRedemption(withReason("subscription_create"))).toMatchObject({
      eventId: "c4d5e6f7-0819-4a2b-8c3d-4e5f60718293",
      code: "PPPIN40K7QX",
      providerCouponId: "3e9d1c7b-2a4f-4b6e-9c8d-7f1e2d3c4b5a",
      chargedAmountCents: 900,
      discountAmountCents: 600,
    });
  });

  it("does NOT count a renewal (subscription_cycle) of a forever discount as a new redemption", () => {
    expect(provider().parseRedemption(fixture("order-paid-subscription-cycle.json"))).toBeNull();
  });

  it.each(["subscription_meter_cycle", "subscription_update"])("does NOT count %s orders", (reason) => {
    expect(provider().parseRedemption(withReason(reason))).toBeNull();
  });

  it("keeps amounts in minor units and preserves the (lowercase) currency", () => {
    const evt = JSON.parse(fixture("order-paid-purchase-with-discount.json"));
    Object.assign(evt.data, { currency: "eur", subtotal_amount: 6000, net_amount: 4766, tax_amount: 912, total_amount: 5678 });
    expect(provider().parseRedemption(JSON.stringify(evt))).toMatchObject({
      chargedAmountCents: 5678,
      taxAmountCents: 912,
      discountAmountCents: 1234,
      currency: "eur",
    });
  });

  it("falls back to the embedded discount id when discount_id is absent", () => {
    const evt = JSON.parse(fixture("order-paid-purchase-with-discount.json"));
    delete evt.data.discount_id;
    expect(provider().parseRedemption(JSON.stringify(evt))).toMatchObject({
      providerCouponId: "3e9d1c7b-2a4f-4b6e-9c8d-7f1e2d3c4b5a",
    });
  });

  it("returns null for non-JSON or an order without an id", () => {
    expect(provider().parseRedemption("not json")).toBeNull();
    const evt = JSON.parse(fixture("order-paid-purchase-with-discount.json"));
    delete evt.data.id;
    expect(provider().parseRedemption(JSON.stringify(evt))).toBeNull();
  });
});

// ── error mapping ───────────────────────────────────────────────────────────

describe("PolarProvider: error mapping", () => {
  it.each([
    [401, { error: "Unauthorized", detail: "Invalid token" }, ProviderAuthError],
    [403, { error: "NotPermitted", detail: "Missing scope" }, ProviderAuthError],
    [404, { error: "ResourceNotFound", detail: "Not found" }, ProviderNotFoundError],
  ])("maps %i to %o", async (status, body, cls) => {
    installFetch(json(body, status));
    await expect(provider().listDiscounts()).rejects.toBeInstanceOf(cls);
  });

  it("maps other statuses to ProviderError with the method, path, status and detail", async () => {
    installFetch(json({ error: "TooManyRequests", detail: "Rate limit exceeded" }, 429));
    const err = (await provider().listDiscounts().catch((e: unknown) => e)) as ProviderError;
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).not.toBeInstanceOf(ProviderAuthError);
    expect(err.statusCode).toBe(429);
    expect(err.operation).toBe("GET /discounts/?page=1&limit=100");
    expect(err.message).toContain("Rate limit exceeded");
  });

  it("handles a non-JSON error body", async () => {
    installFetch(new Response("<html>bad gateway</html>", { status: 502 }));
    const err = (await provider().listDiscounts().catch((e: unknown) => e)) as ProviderError;
    expect(err.statusCode).toBe(502);
    expect(err.message).toContain("HTTP 502");
  });

  it("wraps a network failure in ProviderError", async () => {
    installFetch(new TypeError("fetch failed"));
    const err = (await provider().listDiscounts().catch((e: unknown) => e)) as ProviderError;
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toContain("fetch failed");
  });
});

// ── webhook route behaviour (routes/webhooks.ts, real provider, fake DB) ─────

describe("POST /v1/webhooks/polar/:integrationId", () => {
  const key = randomBytes(32);
  const SECRET = `whsec_${key.toString("base64")}`; // a secret Polar generates today
  const integration = {
    id: "int_polar",
    organizationId: "org_1",
    provider: "polar",
    providerAccountId: null,
    liveAccessTokenEnc: "enc:token",
    webhookSecretEnc: "enc:secret",
  };

  function fakeDb() {
    const chain = (result: unknown): unknown =>
      new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === "then") return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
              Promise.resolve(result).then(res, rej);
            return () => chain(result);
          },
        },
      );
    // update(...).returning() yields a row so the route's conditional
    // "processed: false → true" claim succeeds; the redemption is counted in a
    // transaction, which the fake runs inline on itself (so tx === db).
    const db: Record<string, unknown> = {
      select: () => chain([integration]),
      insert: () => chain([{ id: "evt_1" }]),
      update: () => chain([{ id: "evt_1" }]),
      transaction: async (fn: (tx: unknown) => unknown) => fn(db),
    };
    return db;
  }

  async function setup() {
    const { createDb } = await import("../../db");
    const { decrypt } = await import("../../lib/crypto");
    const { handleRedemption } = await import("../redemption.service");
    const db = fakeDb();
    vi.mocked(createDb).mockReturnValue(db as never);
    vi.mocked(decrypt).mockImplementation(async (enc: string) =>
      enc === "enc:token" ? TOKEN : enc === "enc:secret" ? SECRET : "",
    );
    vi.mocked(handleRedemption).mockClear();
    const app = (await import("../../routes/webhooks")).default;
    const post = (body: string, signWith: Buffer = key) => {
      const ts = Math.floor(Date.now() / 1000);
      const sig = createHmac("sha256", signWith).update(`msg_1.${ts}.${body}`).digest("base64");
      return app.request(
        "/v1/webhooks/polar/int_polar",
        {
          method: "POST",
          body,
          headers: {
            "content-type": "application/json",
            "webhook-id": "msg_1",
            "webhook-timestamp": String(ts),
            "webhook-signature": `v1,${sig}`,
          },
        },
        {},
      );
    };
    return { db, post, handleRedemption: vi.mocked(handleRedemption) };
  }

  it("verifies a Standard Webhooks delivery, records the redemption and answers 200", async () => {
    const { post, handleRedemption, db } = await setup();
    const res = await post(fixture("order-paid-purchase-with-discount.json"));
    expect(res.status).toBe(200);
    expect(handleRedemption).toHaveBeenCalledWith(db, "int_polar", "org_1", {
      eventId: "0f6a9a3e-6f0e-4f3c-9d43-2a1c7d8b5e01",
      code: "PPPIN40K7QX",
      providerCouponId: "3e9d1c7b-2a4f-4b6e-9c8d-7f1e2d3c4b5a",
      providerPromoCodeId: null,
      chargedAmountCents: 1416,
      taxAmountCents: 216,
      discountAmountCents: 800,
      currency: "usd",
    });
  });

  it("acks a renewal with 200 without recording a redemption", async () => {
    const { post, handleRedemption } = await setup();
    const res = await post(fixture("order-paid-subscription-cycle.json"));
    expect(res.status).toBe(200);
    expect(handleRedemption).not.toHaveBeenCalled();
  });

  it("answers 401 for a delivery signed with another key", async () => {
    const { post, handleRedemption } = await setup();
    const res = await post(fixture("order-paid-purchase-with-discount.json"), randomBytes(32));
    expect(res.status).toBe(401);
    expect(handleRedemption).not.toHaveBeenCalled();
  });
});
