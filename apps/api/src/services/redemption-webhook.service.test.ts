import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { createSqlRecorder, type RecordedQuery, type SqlRecorder } from "../lib/sql-recorder-test-helpers";
import { createTestBindings } from "../test/helpers";
import { healthWrites } from "./integration-health-test-helpers";
import type { PaymentProvider, RedemptionEvent } from "./providers";
import type { WebhookContext } from "./redemption-webhook.service";

// Unit tests for verified-webhook ingestion and the scheduled retry. The SQL
// recorder builds the real statements and answers with canned rows in order.

const fake = vi.hoisted(() => ({ create: null as unknown as Mock }));

vi.mock("./providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./providers")>();
  return { ...actual, createProvider: (...args: unknown[]) => fake.create(...args) };
});

vi.mock("../lib/crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/crypto")>();
  return { ...actual, decrypt: async (v: string) => `key:${v}`, tokenEncryptionSecret: () => "secret" };
});

const svc = await import("./redemption-webhook.service");
const {
  EVENT_TYPE_UNPARSED,
  RETRY_BATCH_SIZE,
  RETRY_WINDOW_MS,
  ingestVerifiedWebhook,
  nextAttemptDelayMs,
  parseWebhookKey,
  redemptionKey,
  retryPendingRedemptions,
  unparsedKey,
} = svc;

const env = createTestBindings();
const INTEGRATION = "int_1";
const ORG = "org_1";
const BODY = JSON.stringify({ type: "order.paid", id: "evt_1" });

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

function providerParsing(result: RedemptionEvent | null | Error): PaymentProvider {
  return {
    parseRedemption: vi.fn(async () => {
      if (result instanceof Error) throw result;
      return result;
    }),
  } as unknown as PaymentProvider;
}

function ctx(provider: PaymentProvider, overrides: Partial<WebhookContext> = {}): WebhookContext {
  return {
    providerName: "polar",
    integrationId: INTEGRATION,
    organizationId: ORG,
    environment: "live",
    provider,
    rawBody: BODY,
    ...overrides,
  };
}

/** Parameters bound for a jsonb column come through as JSON text. */
function jsonParams(q: RecordedQuery): Array<Record<string, unknown>> {
  return q.params
    .filter((p): p is string => typeof p === "string" && p.startsWith("{"))
    .map((p) => JSON.parse(p) as Record<string, unknown>);
}

let r: SqlRecorder;

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ingestVerifiedWebhook", () => {
  it("claims the event (processed=false → true) and writes the rollup in ONE transaction", async () => {
    r = createSqlRecorder([[], [{ id: "evt_row" }], [couponRow], [{ organizationId: ORG }], []]);

    const out = await ingestVerifiedWebhook(r.db, ctx(providerParsing(redemption)));

    expect(out).toEqual({ kind: "recorded", matched: true });
    expect(r.transactions).toEqual(["commit"]);
    const [dedupe, claim] = r.queries;
    expect(dedupe!.sql).toMatch(/^insert into "webhook_events" .* on conflict \("webhook_id"\) do nothing$/);
    expect(dedupe!.params).toContain(`polar:${INTEGRATION}:evt_1`);
    expect(claim!.sql).toMatch(
      /^update "webhook_events" set .* where \("webhook_events"\."webhook_id" = \$\d+ and "webhook_events"\."processed" = \$\d+\) returning "id"$/,
    );
    expect(claim!.params).toContain(false);
    expect(r.queries.at(-1)!.sql).toMatch(/^insert into "analytics_rollups"/);
  });

  it("reports a duplicate, without touching the rollup, when another delivery already claimed it", async () => {
    // The claim updates zero rows: the event is processed (or being processed).
    r = createSqlRecorder([[], []]);

    const out = await ingestVerifiedWebhook(r.db, ctx(providerParsing(redemption)));

    expect(out).toEqual({ kind: "duplicate" });
    expect(r.queries).toHaveLength(2);
    expect(r.queries.some((q) => q.sql.includes("analytics_rollups"))).toBe(false);
  });

  it("rolls the claim back and asks for a retry when the rollup write fails", async () => {
    r = createSqlRecorder([[], [{ id: "evt_row" }], [couponRow], [{ organizationId: ORG }], new Error("deadlock"), []]);

    const out = await ingestVerifiedWebhook(r.db, ctx(providerParsing(redemption)));

    expect(out).toMatchObject({ kind: "retry", persisted: true });
    expect(r.transactions).toEqual(["rollback"]);
    const note = r.queries.at(-1)!;
    expect(note.sql).toMatch(/^update "webhook_events" set "error_message" = \$1, "processed_at" = \$2 where/);
    expect(note.params[0]).toContain("deadlock");
  });

  it("acknowledges a non-redemption event without writing anything", async () => {
    r = createSqlRecorder([]);
    expect(await ingestVerifiedWebhook(r.db, ctx(providerParsing(null)))).toEqual({ kind: "ignored" });
    expect(r.queries).toHaveLength(0);
  });

  it("stores the verified body for the scheduled retry when parsing throws", async () => {
    // e.g. Gumroad's sale read-back timed out.
    r = createSqlRecorder([[], []]);

    const out = await ingestVerifiedWebhook(r.db, ctx(providerParsing(new Error("lookup timed out"))));

    expect(out).toMatchObject({ kind: "retry", persisted: true });
    const insert = r.queries[0]!;
    expect(insert.sql).toMatch(/^insert into "webhook_events" .* on conflict \("webhook_id"\) do nothing$/);
    expect(insert.params).toContain(EVENT_TYPE_UNPARSED);
    expect(insert.params).toContain(await unparsedKey("polar", INTEGRATION, BODY));
    expect(jsonParams(insert)[0]).toMatchObject({ rawBody: BODY, environment: "live", attempts: 0 });
  });

  it("says so when even storing the body failed (the route answers 5xx so the provider retries)", async () => {
    r = createSqlRecorder([new Error("db down")]);
    const out = await ingestVerifiedWebhook(r.db, ctx(providerParsing(new Error("lookup timed out"))));
    expect(out).toMatchObject({ kind: "retry", persisted: false });
  });

  it("resolves a pre-stored body (Gumroad) once the redemption is recorded, dropping the raw body", async () => {
    r = createSqlRecorder([[], [{ id: "evt_row" }], [couponRow], [{ organizationId: ORG }], [], []]);

    await ingestVerifiedWebhook(r.db, ctx(providerParsing(redemption), { providerName: "gumroad" }), {
      bodyAlreadyStored: true,
    });

    const resolve = r.queries.at(-1)!;
    expect(resolve.sql).toMatch(/^update "webhook_events" set "data" = \$\d+, "processed" = \$\d+/);
    expect(resolve.params).toContain(await unparsedKey("gumroad", INTEGRATION, BODY));
    expect(jsonParams(resolve)[0]).not.toHaveProperty("rawBody");
    expect(jsonParams(resolve)[0]).toMatchObject({ resolvedEventId: "evt_1" });
  });
});

describe("dedupe keys", () => {
  it("never collapses two events without an id into one (the second would be dropped as a duplicate)", async () => {
    const a = await redemptionKey("whop", INTEGRATION, "", '{"sale":1}');
    const b = await redemptionKey("whop", INTEGRATION, "", '{"sale":2}');
    expect(a).not.toBe(b);
    expect(a.startsWith(`whop:${INTEGRATION}:raw:`)).toBe(true);
    expect(await redemptionKey("whop", INTEGRATION, "evt_9", "x")).toBe(`whop:${INTEGRATION}:evt_9`);
  });

  it("parses the provider and integration back out of a key", () => {
    expect(parseWebhookKey("polar:int_1:evt_1")).toEqual({ providerName: "polar", integrationId: "int_1" });
    expect(parseWebhookKey("polar:int_1:raw:abc")).toEqual({ providerName: "polar", integrationId: "int_1" });
    expect(parseWebhookKey("garbage")).toBeNull();
  });

  it("backs off 10 min, 20, 40 ... capped at 6 h", () => {
    expect(nextAttemptDelayMs(1)).toBe(10 * 60_000);
    expect(nextAttemptDelayMs(2)).toBe(20 * 60_000);
    expect(nextAttemptDelayMs(3)).toBe(40 * 60_000);
    expect(nextAttemptDelayMs(20)).toBe(6 * 3600_000);
  });
});

describe("retryPendingRedemptions", () => {
  const NOW = new Date("2026-11-18T12:00:00Z");
  const integrationRow = {
    id: INTEGRATION,
    organizationId: ORG,
    provider: "polar",
    liveAccessTokenEnc: "live-enc",
    testAccessTokenEnc: "test-enc",
    providerAccountId: null,
    status: "active",
  };

  function unparsedRow(overrides: Record<string, unknown> = {}, data: Record<string, unknown> = {}) {
    return {
      id: "row_u",
      webhookId: `polar:${INTEGRATION}:raw:abc`,
      eventType: EVENT_TYPE_UNPARSED,
      provider: "polar",
      data: { rawBody: BODY, environment: "test", integrationId: INTEGRATION, attempts: 0, ...data },
      processed: false,
      errorMessage: "parse failed",
      createdAt: new Date(NOW.getTime() - 15 * 60_000),
      processedAt: null,
      ...overrides,
    };
  }

  it("selects only unprocessed, settled rows, oldest first, in batches", async () => {
    r = createSqlRecorder([[]]);

    const report = await retryPendingRedemptions(r.db, env, NOW);

    expect(report).toEqual({ attempted: 0, recovered: 0, failed: 0, skipped: 0 });
    const q = r.queries[0]!;
    expect(q.sql).toContain('"webhook_events"."processed" = $');
    expect(q.sql).toContain('order by "webhook_events"."created_at"');
    expect(q.params.at(-1)).toBe(RETRY_BATCH_SIZE);
    // drizzle's postgres-js driver passes timestamps through untouched, and a
    // raw Date bound to an untyped sql`` operand makes postgres-js throw
    // (ERR_INVALID_ARG_TYPE) on every run. Every bound value must be encoded.
    expect(q.params.filter((p) => p instanceof Date)).toEqual([]);
    expect(q.params).toContain(NOW.toISOString());
  });

  it("re-applies a parsed redemption whose recording failed", async () => {
    const row = { ...unparsedRow(), id: "row_r", webhookId: `polar:${INTEGRATION}:evt_1`, eventType: "redemption", data: redemption };
    r = createSqlRecorder([[row], [integrationRow], [{ id: "row_r" }], [couponRow], [{ organizationId: ORG }], []]);

    const report = await retryPendingRedemptions(r.db, env, NOW);

    expect(report).toMatchObject({ attempted: 1, recovered: 1, failed: 0 });
    expect(r.transactions).toEqual(["commit"]);
    expect(r.queries.at(-1)!.sql).toMatch(/^insert into "analytics_rollups"/);
  });

  it("re-parses a stored body with the key for the environment it arrived in", async () => {
    const provider = providerParsing(redemption);
    fake.create = vi.fn(() => provider);
    r = createSqlRecorder([
      [unparsedRow()],
      [integrationRow],
      [], // dedupe insert
      [{ id: "row_new" }], // claim
      [couponRow],
      [{ organizationId: ORG }],
      [], // rollup
      [], // resolve stored body
    ]);

    const report = await retryPendingRedemptions(r.db, env, NOW);

    expect(report).toMatchObject({ attempted: 1, recovered: 1 });
    expect(fake.create).toHaveBeenCalledWith(
      "polar",
      expect.objectContaining({ apiKey: "key:test-enc", environment: "test" }),
    );
    expect(provider.parseRedemption).toHaveBeenCalledWith(BODY);
  });

  it("backs off after another failed parse", async () => {
    fake.create = vi.fn(() => providerParsing(new Error("still down")));
    r = createSqlRecorder([[unparsedRow({}, { attempts: 1 })], [integrationRow], [], [], []]);

    const report = await retryPendingRedemptions(r.db, env, NOW);

    expect(report).toMatchObject({ attempted: 1, failed: 1 });
    const bump = r.queries.at(-1)!;
    expect(bump.sql).toMatch(/^update "webhook_events" set "data" = \$1, "error_message" = \$2 where/);
    expect(jsonParams(bump)[0]).toMatchObject({
      attempts: 2,
      nextAttemptAt: new Date(NOW.getTime() + 20 * 60_000).toISOString(),
      rawBody: BODY,
    });
  });

  it("gives up after the retry window, keeping the row but dropping the body, and says so on the integration", async () => {
    r = createSqlRecorder([[unparsedRow({ createdAt: new Date(NOW.getTime() - RETRY_WINDOW_MS - 1) })], [integrationRow], [], []]);

    const report = await retryPendingRedemptions(r.db, env, NOW);

    expect(report).toMatchObject({ attempted: 1, failed: 1 });
    const giveUp = r.queries.find((q) => /^update "webhook_events" set "data" = \$1/.test(q.sql))!;
    const data = jsonParams(giveUp)[0]!;
    expect(data).toMatchObject({ gaveUp: true });
    expect(data).not.toHaveProperty("rawBody");
    const [issue] = healthWrites(r);
    expect(issue).toMatchObject({ area: "webhook_delivery", environment: "test" });
    expect(issue!.message).toContain("72 hours");
    expect(issue!.message).toContain("parse failed");
    // Recorded on the row of the integration the event belongs to.
    expect(r.queries.at(-1)!.params).toContain(INTEGRATION);
  });

  it("stops retrying events for a disconnected integration", async () => {
    r = createSqlRecorder([[unparsedRow()], [], []]);

    const report = await retryPendingRedemptions(r.db, env, NOW);

    expect(report).toMatchObject({ attempted: 1, skipped: 1 });
    const done = r.queries.at(-1)!;
    expect(done.sql).toMatch(/^update "webhook_events" set "data" = \$1, "processed" = \$2/);
    expect(done.params).toContain("integration no longer exists");
  });
});
