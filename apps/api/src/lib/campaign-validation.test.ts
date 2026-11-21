import { describe, it, expect, vi } from "vitest";
import {
  isCampaignOwnedByOrg,
  isWellFormedCampaignId,
  resolveCampaignOwners,
} from "./campaign-validation";
import { createMockKV } from "../test/helpers";
import { kvGet } from "./kv";
import type { createDb } from "../db";

/**
 * Build a minimal mock of the BATCH drizzle chain that backs the
 * isCampaignOwnedByOrg wrapper (it now resolves via resolveCampaignOwners):
 *   db.select(...).from(...).where(...)  →  resolves to a {id, organizationId}[]
 * `result` is the legacy single-row shape ({ organizationId }); we attach the
 * CAMPAIGN id so the resolver can key it. `throwErr` rejects (fail-closed path).
 */
function mockDb(opts: {
  result?: Array<{ organizationId: string }>;
  throwErr?: boolean;
}): ReturnType<typeof createDb> {
  const rows = (opts.result ?? []).map((r) => ({
    id: CAMPAIGN,
    organizationId: r.organizationId,
  }));
  const chain: any = {
    select: () => chain,
    from: () => chain,
    where: () =>
      opts.throwErr
        ? Promise.reject(new Error("db down"))
        : Promise.resolve(rows),
  };
  return chain as ReturnType<typeof createDb>;
}

/**
 * Build a mock of the BATCH drizzle chain used by resolveCampaignOwners:
 *   db.select(...).from(...).where(...)  →  resolves to a row array (no .limit).
 * `where` is a vi.fn so tests can assert the DB was queried exactly once. `rows`
 * is what the final .where() promise resolves to; `throwErr` rejects it (to
 * exercise the fail-closed path).
 */
function mockBatchDb(opts: {
  rows?: Array<{ id: string; organizationId: string }>;
  throwErr?: boolean;
}): { db: ReturnType<typeof createDb>; where: ReturnType<typeof vi.fn> } {
  const where = vi.fn(() =>
    opts.throwErr
      ? Promise.reject(new Error("db down"))
      : Promise.resolve(opts.rows ?? []),
  );
  const chain: any = {
    select: () => chain,
    from: () => chain,
    where,
  };
  return { db: chain as ReturnType<typeof createDb>, where };
}

const ORG = "org_aaa";
const OTHER_ORG = "org_bbb";
// Valid 26-char Crockford-base32 ULID (matches the shape guard); the old
// "cmp_123" would now be rejected before any KV/DB I/O.
const CAMPAIGN = "01HZX9ABCDEFGHJKMNPQRSTVWX";

describe("isCampaignOwnedByOrg", () => {
  it("returns false for empty campaignId or organizationId (no DB call)", async () => {
    const kv = createMockKV();
    const db = mockDb({ throwErr: true }); // would throw if touched
    expect(await isCampaignOwnedByOrg(db, kv, "", ORG)).toBe(false);
    expect(await isCampaignOwnedByOrg(db, kv, CAMPAIGN, "")).toBe(false);
  });

  it("returns true when KV positive cache matches the org (no DB call)", async () => {
    const kv = createMockKV();
    // Seed via JSON.stringify (how the helper's kvSet writes), so kvGet parses it.
    await kv.put(`campaign-org:${CAMPAIGN}`, JSON.stringify(ORG));
    const db = mockDb({ throwErr: true }); // must not be called
    expect(await isCampaignOwnedByOrg(db, kv, CAMPAIGN, ORG)).toBe(true);
  });

  it("returns false when KV positive cache is a DIFFERENT org (poisoning attempt)", async () => {
    const kv = createMockKV();
    await kv.put(`campaign-org:${CAMPAIGN}`, JSON.stringify(OTHER_ORG));
    const db = mockDb({ throwErr: true }); // must not be called
    expect(await isCampaignOwnedByOrg(db, kv, CAMPAIGN, ORG)).toBe(false);
  });

  it("returns false when KV holds the negative marker (known-unknown id)", async () => {
    const kv = createMockKV();
    await kv.put(`campaign-org:${CAMPAIGN}`, JSON.stringify("0"));
    const db = mockDb({ throwErr: true }); // must not be called
    expect(await isCampaignOwnedByOrg(db, kv, CAMPAIGN, ORG)).toBe(false);
  });

  it("resolves via DB on cache miss, returns true, and caches the positive org", async () => {
    const kv = createMockKV();
    const db = mockDb({ result: [{ organizationId: ORG }] });
    expect(await isCampaignOwnedByOrg(db, kv, CAMPAIGN, ORG)).toBe(true);
    // Positive entry cached for subsequent fast-path hits.
    expect(await kvGet<string>(kv, `campaign-org:${CAMPAIGN}`)).toBe(ORG);
  });

  it("returns false when DB says the campaign belongs to another org (and caches real owner)", async () => {
    const kv = createMockKV();
    const db = mockDb({ result: [{ organizationId: OTHER_ORG }] });
    expect(await isCampaignOwnedByOrg(db, kv, CAMPAIGN, ORG)).toBe(false);
    // Cache stores the TRUE owner, not the requester's org.
    expect(await kvGet<string>(kv, `campaign-org:${CAMPAIGN}`)).toBe(OTHER_ORG);
  });

  it("returns false and caches a negative marker for an unknown campaign id", async () => {
    const kv = createMockKV();
    const db = mockDb({ result: [] }); // no row
    expect(await isCampaignOwnedByOrg(db, kv, CAMPAIGN, ORG)).toBe(false);
    expect(await kvGet<string>(kv, `campaign-org:${CAMPAIGN}`)).toBe("0");
  });

  it("FAILS CLOSED (false) on DB error and does NOT cache", async () => {
    const kv = createMockKV();
    const db = mockDb({ throwErr: true });
    expect(await isCampaignOwnedByOrg(db, kv, CAMPAIGN, ORG)).toBe(false);
    // No cache entry written, so a later request can re-resolve.
    expect(await kvGet<string>(kv, `campaign-org:${CAMPAIGN}`)).toBeNull();
  });

  it("returns false for a malformed campaign id (shape guard, NO DB call)", async () => {
    const kv = createMockKV();
    const { db, where } = mockBatchDb({ throwErr: true }); // would throw if touched
    expect(await isCampaignOwnedByOrg(db, kv, "cmp_123", ORG)).toBe(false);
    expect(where).not.toHaveBeenCalled();
  });
});

// Distinct valid ULIDs for the batch tests.
const CAMPAIGN_A = "01HZX9ABCDEFGHJKMNPQRSTVWX";
const CAMPAIGN_B = "01J0000000000000000000000B";
const CAMPAIGN_C = "01J0000000000000000000000C";

describe("isWellFormedCampaignId", () => {
  it("accepts valid 26-char Crockford ULIDs (either case)", () => {
    expect(isWellFormedCampaignId(CAMPAIGN_A)).toBe(true);
    expect(isWellFormedCampaignId(CAMPAIGN_A.toLowerCase())).toBe(true);
  });

  it("rejects wrong length, the excluded letters I/L/O/U, and empty", () => {
    expect(isWellFormedCampaignId("cmp_123")).toBe(false);
    expect(isWellFormedCampaignId("01HZX9ABCDEFGHJKMNPQRSTVW")).toBe(false); // 25
    expect(isWellFormedCampaignId("01HZX9ABCDEFGHJKMNPQRSTVWXY")).toBe(false); // 27
    expect(isWellFormedCampaignId("0IZX9ABCDEFGHJKMNPQRSTVWXY")).toBe(false); // has I
    expect(isWellFormedCampaignId("0LZX9ABCDEFGHJKMNPQRSTVWXY")).toBe(false); // has L
    expect(isWellFormedCampaignId("0OZX9ABCDEFGHJKMNPQRSTVWXY")).toBe(false); // has O
    expect(isWellFormedCampaignId("0UZX9ABCDEFGHJKMNPQRSTVWXY")).toBe(false); // has U
    expect(isWellFormedCampaignId("")).toBe(false);
  });
});

describe("resolveCampaignOwners", () => {
  it("(a) malformed id → null, with NO DB call and NO KV write", async () => {
    const kv = createMockKV();
    const { db, where } = mockBatchDb({ throwErr: true }); // throws if touched
    const owners = await resolveCampaignOwners(db, kv, ["cmp_123", "not-a-ulid"]);
    expect(owners.get("cmp_123")).toBeNull();
    expect(owners.get("not-a-ulid")).toBeNull();
    expect(where).not.toHaveBeenCalled();
    expect(await kvGet<string>(kv, `campaign-org:cmp_123`)).toBeNull();
  });

  it("(b) repeated + distinct ids → exactly ONE db query, correct owners", async () => {
    const kv = createMockKV();
    const { db, where } = mockBatchDb({
      rows: [
        { id: CAMPAIGN_A, organizationId: ORG },
        { id: CAMPAIGN_B, organizationId: OTHER_ORG },
      ],
    });
    const owners = await resolveCampaignOwners(db, kv, [
      CAMPAIGN_A,
      CAMPAIGN_A, // repeated — must be deduped
      CAMPAIGN_B,
    ]);
    expect(where).toHaveBeenCalledTimes(1); // ONE DB query for the whole batch
    expect(owners.get(CAMPAIGN_A)).toBe(ORG);
    expect(owners.get(CAMPAIGN_B)).toBe(OTHER_ORG);
    // Positive results cached for the fast path next time.
    expect(await kvGet<string>(kv, `campaign-org:${CAMPAIGN_A}`)).toBe(ORG);
    expect(await kvGet<string>(kv, `campaign-org:${CAMPAIGN_B}`)).toBe(OTHER_ORG);
  });

  it("(c) mixed batch: owned / other-org / unknown / malformed → correct map", async () => {
    const kv = createMockKV();
    const { db, where } = mockBatchDb({
      rows: [
        { id: CAMPAIGN_A, organizationId: ORG },
        { id: CAMPAIGN_B, organizationId: OTHER_ORG },
        // CAMPAIGN_C not returned → unknown
      ],
    });
    const owners = await resolveCampaignOwners(db, kv, [
      CAMPAIGN_A, // owned
      CAMPAIGN_B, // other org
      CAMPAIGN_C, // unknown (well-formed, no row)
      "cmp_xyz", // malformed
    ]);
    expect(where).toHaveBeenCalledTimes(1);
    expect(owners.get(CAMPAIGN_A)).toBe(ORG);
    expect(owners.get(CAMPAIGN_B)).toBe(OTHER_ORG);
    expect(owners.get(CAMPAIGN_C)).toBeNull();
    expect(owners.get("cmp_xyz")).toBeNull();
    // Unknown well-formed id gets a short negative marker; malformed is never written.
    expect(await kvGet<string>(kv, `campaign-org:${CAMPAIGN_C}`)).toBe("0");
    expect(await kvGet<string>(kv, `campaign-org:cmp_xyz`)).toBeNull();
  });

  it("(d) DB throw → all misses null, nothing cached, and the outage is logged", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const kv = createMockKV();
    const { db } = mockBatchDb({ throwErr: true });
    const owners = await resolveCampaignOwners(db, kv, [CAMPAIGN_A, CAMPAIGN_B]);
    // A database outage silently dropped every analytics event before.
    expect(errorSpy).toHaveBeenCalledWith(
      "analytics: campaign owner lookup failed; dropping these events",
      expect.objectContaining({ campaigns: 2, error: expect.stringContaining("db down") }),
    );
    errorSpy.mockRestore();
    expect(owners.get(CAMPAIGN_A)).toBeNull();
    expect(owners.get(CAMPAIGN_B)).toBeNull();
    // Fail-closed: nothing cached, so a later request re-resolves.
    expect(await kvGet<string>(kv, `campaign-org:${CAMPAIGN_A}`)).toBeNull();
    expect(await kvGet<string>(kv, `campaign-org:${CAMPAIGN_B}`)).toBeNull();
  });

  it("serves KV positive/negative hits without a DB query", async () => {
    const kv = createMockKV();
    await kv.put(`campaign-org:${CAMPAIGN_A}`, JSON.stringify(ORG));
    await kv.put(`campaign-org:${CAMPAIGN_B}`, JSON.stringify("0"));
    const { db, where } = mockBatchDb({ throwErr: true }); // must not be queried
    const owners = await resolveCampaignOwners(db, kv, [CAMPAIGN_A, CAMPAIGN_B]);
    expect(where).not.toHaveBeenCalled();
    expect(owners.get(CAMPAIGN_A)).toBe(ORG);
    expect(owners.get(CAMPAIGN_B)).toBeNull();
  });
});
