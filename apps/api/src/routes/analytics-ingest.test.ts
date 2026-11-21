import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ulid } from "ulid";
import { createMockKV, createTestBindings, createTestClient } from "../test/helpers";
import { createSqlRecorder, type SqlRecorder } from "../lib/sql-recorder-test-helpers";

// Unit tests for the rollup write behind POST /v1/events. No database: the
// route's createDb() returns a recorder that builds the real Drizzle SQL (what
// production sends) and answers with canned results. The database-backed
// counterpart (rows actually incremented in Postgres) is
// analytics-ingest.integration.test.ts.

const state = vi.hoisted(() => ({ recorder: null as unknown as SqlRecorder }));
vi.mock("../db", () => ({ createDb: () => state.recorder.db }));

const {
  default: analyticsIngestRoute,
  buildRollupUpsert,
  groupRollupIncrements,
  counterForEvent,
} = await import("./analytics-ingest");

const ORG = "org_events_owner";
const OTHER_ORG = "org_events_other";
const RAW_KEY = "gpl_pk_unit_events";

async function sha256Hex(value: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** KV primed so the route resolves the key and campaign owners without the DB. */
async function primedEnv(owners: Record<string, string>) {
  const kv = createMockKV();
  await kv.put(`apikey:${await sha256Hex(RAW_KEY)}`, JSON.stringify({ apiKeyId: "key_1", organizationId: ORG }));
  for (const [campaignId, orgId] of Object.entries(owners)) {
    await kv.put(`campaign-org:${campaignId}`, JSON.stringify(orgId));
  }
  return createTestBindings({ CACHE: kv });
}

const post = (client: ReturnType<typeof createTestClient>, json: unknown) =>
  client.request("/v1/events", { method: "POST", json });

describe("buildRollupUpsert (query shape)", () => {
  const now = new Date("2026-11-18T15:30:00Z");
  const input = {
    organizationId: ORG,
    campaignId: "01JCAMPAIGNAAAAAAAAAAAAAAA",
    countryCode: "in",
    eventType: "impression",
    now,
  };

  it("emits an INSERT ... ON CONFLICT with bare column names and the 6-column target", () => {
    const { sql, params } = buildRollupUpsert(createSqlRecorder().db, input)!.toSQL();

    // The bug: a column object in a raw sql template renders table-qualified,
    // which Postgres rejects in the column list and as the SET target.
    const [insertPart, conflictPart] = sql.split(" on conflict ");
    expect(insertPart).toContain('insert into "analytics_rollups" (');
    expect(insertPart).toContain('"impressions"');
    expect(insertPart).not.toContain('"analytics_rollups"."');
    expect(conflictPart).toBe(
      '("organization_id","campaign_id","country_code","period","period_start","environment") ' +
        'do update set "impressions" = "analytics_rollups"."impressions" + $10',
    );
    expect(params).toEqual([
      expect.any(String), // ulid
      ORG,
      input.campaignId,
      "IN", // normalized
      "day",
      "2026-11-18T00:00:00.000Z", // UTC day bucket, serialized by the column
      1,
      "live",
      "2026-11-18T15:30:00.000Z",
      1,
    ]);
  });

  it("never passes a JS Date as a parameter (the postgres-js driver cannot send it raw)", () => {
    const { params } = buildRollupUpsert(createSqlRecorder().db, input)!.toSQL();
    expect(params.some((p) => p instanceof Date)).toBe(false);
  });

  it.each([
    ["click", "clicks"],
    ["copy", "copies"],
  ])("a %s event increments only %s", (eventType, column) => {
    const { sql } = buildRollupUpsert(createSqlRecorder().db, { ...input, eventType, amount: 4 })!.toSQL();
    expect(sql).toContain(`do update set "${column}" = "analytics_rollups"."${column}" + $10`);
    for (const other of ["impressions", "clicks", "copies", "redemptions"].filter((c) => c !== column)) {
      expect(sql).not.toContain(`"${other}" = `);
    }
  });

  it.each([
    ["a dismiss event", { eventType: "dismiss" }],
    ["a browser-sent redemption (webhooks only)", { eventType: "redemption" }],
    ["an unknown event type", { eventType: "constructor" }],
    ["a missing campaign id", { campaignId: "" }],
    ["a missing country", { countryCode: "" }],
    ["a 3-letter country", { countryCode: "USA" }],
    ["a non-letter country", { countryCode: "1N" }],
  ])("returns null (event dropped) for %s", (_label, override) => {
    expect(buildRollupUpsert(createSqlRecorder().db, { ...input, ...override })).toBeNull();
  });

  it("maps event types to counters and ignores prototype keys", () => {
    expect(counterForEvent("impression")).toBe("impressions");
    expect(counterForEvent("dismiss")).toBeNull();
    expect(counterForEvent("redemption")).toBeNull();
    expect(counterForEvent("toString")).toBeNull();
  });
});

describe("groupRollupIncrements", () => {
  it("collapses a batch to one increment per (campaign, country, counter)", () => {
    const a = "01JCAMPAIGNAAAAAAAAAAAAAAA";
    const b = "01JCAMPAIGNBBBBBBBBBBBBBBB";
    const grouped = groupRollupIncrements([
      { campaignId: a, countryCode: "IN", eventType: "impression" },
      { campaignId: a, countryCode: "in", eventType: "impression" },
      { campaignId: a, countryCode: "IN", eventType: "impression" },
      { campaignId: a, countryCode: "IN", eventType: "click" },
      { campaignId: a, countryCode: "BR", eventType: "impression" },
      { campaignId: b, countryCode: "IN", eventType: "impression" },
      { campaignId: a, countryCode: "IN", eventType: "dismiss" },
      { campaignId: a, countryCode: "IND", eventType: "impression" },
      { campaignId: "", countryCode: "IN", eventType: "impression" },
    ]);
    expect(grouped).toEqual([
      { campaignId: a, countryCode: "IN", eventType: "impression", amount: 3 },
      { campaignId: a, countryCode: "IN", eventType: "click", amount: 1 },
      { campaignId: a, countryCode: "BR", eventType: "impression", amount: 1 },
      { campaignId: b, countryCode: "IN", eventType: "impression", amount: 1 },
    ]);
  });
});

describe("POST /v1/events rollup writes", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    state.recorder = createSqlRecorder();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("writes one upsert per distinct key for owned campaigns and drops other orgs' campaigns", async () => {
    const owned = ulid();
    const foreign = ulid();
    const client = createTestClient(analyticsIngestRoute, await primedEnv({ [owned]: ORG, [foreign]: OTHER_ORG }));

    const res = await post(client, {
      key: RAW_KEY,
      events: [
        { eventType: "impression", campaignId: owned, countryCode: "IN" },
        { eventType: "impression", campaignId: owned, countryCode: "IN" },
        { eventType: "click", campaignId: owned, countryCode: "IN" },
        { eventType: "dismiss", campaignId: owned, countryCode: "IN" },
        { eventType: "impression", campaignId: foreign, countryCode: "IN" },
      ],
    });

    expect(res.status).toBe(204);
    expect(state.recorder.queries).toHaveLength(2);
    const [impressions, clicks] = state.recorder.queries;
    expect(impressions!.sql).toContain('do update set "impressions" = "analytics_rollups"."impressions" + $10');
    expect(impressions!.params.slice(1, 4)).toEqual([ORG, owned, "IN"]);
    expect(impressions!.params.at(-1)).toBe(2);
    expect(clicks!.sql).toContain('do update set "clicks" = "analytics_rollups"."clicks" + $10');
    expect(clicks!.params.at(-1)).toBe(1);
    // Nothing was written for the other org's campaign.
    expect(state.recorder.queries.some((q) => q.params.includes(foreign))).toBe(false);
  });

  it("ignores browser-sent redemption events (simple and batch): 204, nothing written", async () => {
    const owned = ulid();
    const client = createTestClient(analyticsIngestRoute, await primedEnv({ [owned]: ORG }));

    const simple = await post(client, { key: RAW_KEY, event: "redemption", campaignId: owned, countryCode: "IN" });
    expect(simple.status).toBe(204);
    const batch = await post(client, {
      key: RAW_KEY,
      events: [
        { eventType: "redemption", campaignId: owned, countryCode: "IN" },
        { eventType: "redemption", campaignId: owned, countryCode: "BR" },
        { eventType: "impression", campaignId: owned, countryCode: "IN" },
      ],
    });
    expect(batch.status).toBe(204);

    // Only the impression reached the database; no statement touches redemptions.
    expect(state.recorder.queries).toHaveLength(1);
    expect(state.recorder.queries[0]!.sql).toContain('"impressions" = "analytics_rollups"."impressions"');
    expect(state.recorder.queries.some((q) => q.sql.includes('"redemptions" ='))).toBe(false);
  });

  it("drops a simple banner event whose country is not a 2-letter code", async () => {
    const owned = ulid();
    const client = createTestClient(analyticsIngestRoute, await primedEnv({ [owned]: ORG }));
    const res = await post(client, { key: RAW_KEY, event: "impression", campaignId: owned, countryCode: "x".repeat(500) });
    expect(res.status).toBe(204);
    expect(state.recorder.queries).toHaveLength(0);
  });

  it("logs a failed upsert with context and still answers 204", async () => {
    const owned = ulid();
    const client = createTestClient(analyticsIngestRoute, await primedEnv({ [owned]: ORG }));
    const pgError = Object.assign(
      new Error('column "analytics_rollups" of relation "analytics_rollups" does not exist'),
      { code: "42703" },
    );
    state.recorder.results.push(pgError);

    const res = await post(client, { key: RAW_KEY, event: "impression", campaignId: owned, countryCode: "IN" });

    expect(res.status).toBe(204);
    expect(errorSpy).toHaveBeenCalledWith(
      "analytics: rollup upsert failed",
      expect.objectContaining({
        organizationId: ORG,
        campaignId: owned,
        countryCode: "IN",
        eventType: "impression",
        error: expect.stringContaining("(code 42703)"),
      }),
    );
  });

  it("keeps writing the remaining keys when one upsert fails", async () => {
    const a = ulid();
    const b = ulid();
    const client = createTestClient(analyticsIngestRoute, await primedEnv({ [a]: ORG, [b]: ORG }));
    state.recorder.results.push(new Error("boom"), []);

    const res = await post(client, {
      key: RAW_KEY,
      events: [
        { eventType: "impression", campaignId: a, countryCode: "IN" },
        { eventType: "impression", campaignId: b, countryCode: "IN" },
      ],
    });

    expect(res.status).toBe(204);
    expect(state.recorder.queries).toHaveLength(2);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});

// ── Secret keys (gpl_sk_) ───────────────────────────────────────────────────

describe("POST /v1/events with a secret key", () => {
  const SECRET = `gpl_sk_${"cd34".repeat(16)}`;
  const HEX = SECRET.slice(7);

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("is refused with 401 before the per-key limiter, KV or the database; nothing echoed or written", async () => {
    state.recorder = createSqlRecorder();
    const env = createTestBindings({ CACHE: createMockKV() });
    const kvKeys: string[] = [];
    const get = env.CACHE.get.bind(env.CACHE);
    env.CACHE.get = (async (key: string, ...rest: unknown[]) => (kvKeys.push(key), (get as (...a: unknown[]) => unknown)(key, ...rest))) as KVNamespace["get"];
    const limiterKeys: string[] = [];
    const limiter = { limit: vi.fn(async ({ key }: { key: string }) => (limiterKeys.push(key), { success: true })) };
    const client = createTestClient(analyticsIngestRoute, { ...env, RL_EVENTS_KEY: limiter } as typeof env);

    for (const json of [
      { key: SECRET, event: "impression", url: "https://a.example.com/pricing", campaignId: ulid(), countryCode: "IN" },
      { key: SECRET, events: [{ eventType: "impression", campaignId: ulid(), countryCode: "IN" }] },
    ]) {
      const res = await post(client, json);
      const text = await res.text();
      expect(res.status).toBe(401);
      expect(JSON.parse(text)).toMatchObject({ code: "secret_key_not_allowed" });
      expect(text).not.toContain(HEX);
    }
    expect(limiterKeys).toEqual([]);
    expect(kvKeys).toEqual([]);
    expect(state.recorder.queries).toEqual([]);
  });

  it("a key whose database row is not a public key is refused, whatever its prefix", async () => {
    state.recorder = createSqlRecorder([[{ id: "key_s", organizationId: ORG, keyType: "secret", keyHash: "x" }]]);
    const client = createTestClient(analyticsIngestRoute, createTestBindings({ CACHE: createMockKV() }));
    const res = await post(client, { key: "unprefixed_key_value", event: "impression", url: "https://a.example.com/", campaignId: ulid(), countryCode: "IN" });
    expect(res.status).toBe(401);
    // Only the key lookup ran: no campaign resolution, no rollup.
    expect(state.recorder.queries).toHaveLength(1);
    expect(state.recorder.queries[0]!.sql).toContain('from "api_keys"');
  });
});
