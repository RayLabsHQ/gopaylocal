import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import { createTestBindings } from "../test/helpers";
import type { Bindings } from "../bindings";
import { checkBillingAllowsWorkspaceDelete, type SubscriptionForDelete } from "./workspace-billing";

// No real Dodo calls: fetch is stubbed at the client boundary.

const hosted = (overrides?: Partial<Bindings>) => createTestBindings({ SELF_HOSTED: "false", ...overrides });
const renewing: SubscriptionForDelete = { status: "active", dodoSubId: "sub_123" };

let fetchMock: MockInstance<typeof fetch>;
const dodoAnswers = (status: number, body: unknown) =>
  fetchMock.mockResolvedValue(new Response(typeof body === "string" ? body : JSON.stringify(body), { status }));

beforeEach(() => {
  fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected fetch"));
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("checkBillingAllowsWorkspaceDelete: no Dodo call needed", () => {
  it("self-hosted: nothing blocks, even a subscription row that looks active", async () => {
    const env = createTestBindings({ SELF_HOSTED: "true" });
    expect(await checkBillingAllowsWorkspaceDelete(env, renewing, "org1")).toEqual({ ok: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("no subscription row (Free): nothing blocks", async () => {
    expect(await checkBillingAllowsWorkspaceDelete(hosted(), null, "org1")).toEqual({ ok: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["canceled", "cancelled", "expired"])("our row already says %s: nothing blocks", async (status) => {
    expect(await checkBillingAllowsWorkspaceDelete(hosted(), { status, dodoSubId: "sub_123" }, "org1")).toEqual({ ok: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a row with no Dodo subscription id has nothing to check or cancel: allowed, and logged", async () => {
    expect(await checkBillingAllowsWorkspaceDelete(hosted(), { status: "active", dodoSubId: null }, "org1")).toEqual({ ok: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
  });
});

describe("checkBillingAllowsWorkspaceDelete: asks Dodo when the row could still renew", () => {
  it("asks for that subscription on the live host with the API key", async () => {
    dodoAnswers(200, { status: "active", cancel_at_next_billing_date: true });
    await checkBillingAllowsWorkspaceDelete(hosted({ DODO_API_KEY: "dodo_live_x" }), renewing, "org1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://live.dodopayments.com/subscriptions/sub_123");
    expect(new Headers((init as RequestInit).headers).get("authorization")).toBe("Bearer dodo_live_x");
    expect((init as RequestInit).method ?? "GET").toBe("GET");
  });

  it("uses the test host in test mode and encodes the id", async () => {
    dodoAnswers(200, { status: "cancelled" });
    await checkBillingAllowsWorkspaceDelete(hosted({ DODO_ENVIRONMENT: "test_mode" }), { status: "past_due", dodoSubId: "sub/1?x" }, "org1");
    expect(fetchMock.mock.calls[0]![0]).toBe("https://test.dodopayments.com/subscriptions/sub%2F1%3Fx");
  });

  it("refuses with 409 while the subscription renews, naming the renewal date", async () => {
    dodoAnswers(200, { status: "active", cancel_at_next_billing_date: false, next_billing_date: "2026-12-19T10:00:00Z" });
    const result = await checkBillingAllowsWorkspaceDelete(hosted(), renewing, "org1");
    expect(result).toMatchObject({ ok: false, status: 409, body: { code: "subscription_renews" } });
    if (!result.ok) {
      expect(result.body.error).toContain("renews on 2026-12-19");
      expect(result.body.error).toContain("Settings > Billing > Manage Billing");
    }
  });

  it.each(["active", "on_hold", "past_due", "paused", "pending", "something_new"])(
    "refuses Dodo status %s without the cancel-at-period-end flag",
    async (status) => {
      dodoAnswers(200, { status });
      expect(await checkBillingAllowsWorkspaceDelete(hosted(), renewing, "org1")).toMatchObject({
        ok: false,
        status: 409,
        body: { code: "subscription_renews" },
      });
    },
  );

  it("allows a subscription set to end at the period end (still active at Dodo)", async () => {
    dodoAnswers(200, { status: "active", cancel_at_next_billing_date: true });
    expect(await checkBillingAllowsWorkspaceDelete(hosted(), renewing, "org1")).toEqual({ ok: true });
  });

  it.each(["cancelled", "expired", "failed"])("allows Dodo status %s", async (status) => {
    dodoAnswers(200, { status, cancel_at_next_billing_date: false });
    expect(await checkBillingAllowsWorkspaceDelete(hosted(), renewing, "org1")).toEqual({ ok: true });
  });

  it("only a literal true counts as set to end", async () => {
    dodoAnswers(200, { status: "active", cancel_at_next_billing_date: "true" });
    expect(await checkBillingAllowsWorkspaceDelete(hosted(), renewing, "org1")).toMatchObject({ ok: false, status: 409 });
  });
});

describe("checkBillingAllowsWorkspaceDelete: a check that cannot complete refuses (502), loudly", () => {
  const refusedLoudly = async (env = hosted()) => {
    const result = await checkBillingAllowsWorkspaceDelete(env, renewing, "org1");
    expect(result).toMatchObject({ ok: false, status: 502, body: { code: "billing_check_failed" } });
    expect(console.error).toHaveBeenCalled();
  };

  it("Dodo answers an error status", async () => {
    dodoAnswers(500, "upstream trouble");
    await refusedLoudly();
  });

  it("Dodo answers 404 for the id", async () => {
    dodoAnswers(404, "not found");
    await refusedLoudly();
  });

  it("the request fails or times out", async () => {
    fetchMock.mockRejectedValue(new DOMException("The operation timed out.", "TimeoutError"));
    await refusedLoudly();
  });

  it("the body is not JSON", async () => {
    dodoAnswers(200, "<html>");
    await refusedLoudly();
  });

  it("the body has no status", async () => {
    dodoAnswers(200, { cancel_at_next_billing_date: true });
    await refusedLoudly();
  });

  it("DODO_API_KEY is not set (no request is made)", async () => {
    await refusedLoudly(hosted({ DODO_API_KEY: "" }));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
