import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ulid } from "ulid";
import type { Database } from "../db";
import { analyticsRollups, apiUsageDaily, sessions, users } from "../db/schema";
import { runRetention } from "./retention.service";
import { cleanupTestDb, closeTestDb, getTestDb } from "../test/setup";

/**
 * The daily clean-up on real Postgres: what is deleted on the hosted service,
 * what a self-hosted deployment keeps, and that the cut-offs are exact.
 */

const NOW = new Date("2026-11-21T03:00:00Z");
// 24 months before NOW, start of the UTC day.
const CUTOFF = new Date("2024-11-21T00:00:00Z");
const DAY_MS = 24 * 3600 * 1000;

const db = () => getTestDb() as unknown as Database;

async function seedRollup(periodStart: Date, environment: "live" | "test" = "live") {
  const id = ulid();
  await getTestDb().insert(analyticsRollups).values({
    id,
    organizationId: "org_1",
    campaignId: "camp_1",
    countryCode: "IN",
    period: "day",
    periodStart,
    impressions: 5,
    environment,
  });
  return id;
}

async function seedSession(expiresAt: Date) {
  const id = ulid();
  await getTestDb().insert(sessions).values({
    id,
    token: `tok_${id}`,
    userId: "user_1",
    expiresAt,
    ipAddress: "203.0.113.7",
    userAgent: "test-agent",
  });
  return id;
}

async function remaining() {
  const [rollups, usage, sess] = await Promise.all([
    getTestDb().select({ id: analyticsRollups.id }).from(analyticsRollups),
    getTestDb().select({ day: apiUsageDaily.day, environment: apiUsageDaily.environment }).from(apiUsageDaily),
    getTestDb().select({ id: sessions.id }).from(sessions),
  ]);
  return {
    rollups: rollups.map((r) => r.id).sort(),
    usage: usage.map((u) => `${u.day}:${u.environment}`).sort(),
    sessions: sess.map((s) => s.id).sort(),
  };
}

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  await cleanupTestDb();
  await getTestDb().insert(users).values({ id: "user_1", name: "Test User", email: "user-1@example.test", emailVerified: true });
});

afterAll(async () => {
  await closeTestDb();
});

describe("runRetention", () => {
  it("hosted: deletes analytics and usage from before the 24-month cut-off, keeps the rest", async () => {
    const old = await seedRollup(new Date(CUTOFF.getTime() - DAY_MS));
    const oldTest = await seedRollup(new Date(CUTOFF.getTime() - 400 * DAY_MS), "test");
    const boundary = await seedRollup(CUTOFF);
    const recent = await seedRollup(new Date(NOW.getTime() - DAY_MS));
    await getTestDb().insert(apiUsageDaily).values([
      { organizationId: "org_1", day: "2024-11-20", environment: "live", count: 10 },
      { organizationId: "org_1", day: "2023-01-01", environment: "test", count: 3 },
      { organizationId: "org_1", day: "2024-11-21", environment: "live", count: 20 },
      { organizationId: "org_1", day: "2026-11-20", environment: "live", count: 30 },
    ]);

    const result = await runRetention(db(), { SELF_HOSTED: "false" }, NOW);

    expect(result).toEqual({ analyticsRollups: 2, apiUsageDaily: 2, sessions: 0 });
    const left = await remaining();
    expect(left.rollups).toEqual([boundary, recent].sort());
    expect(left.rollups).not.toContain(old);
    expect(left.rollups).not.toContain(oldTest);
    expect(left.usage).toEqual(["2024-11-21:live", "2026-11-20:live"]);
  });

  it("hosted is the default: an unset SELF_HOSTED deletes too", async () => {
    await seedRollup(new Date(CUTOFF.getTime() - DAY_MS));
    expect((await runRetention(db(), {}, NOW)).analyticsRollups).toBe(1);
    expect((await remaining()).rollups).toEqual([]);
  });

  it("self-hosted: keeps all analytics and usage, however old", async () => {
    const ancient = await seedRollup(new Date("2019-01-01T00:00:00Z"));
    await getTestDb().insert(apiUsageDaily).values({ organizationId: "org_1", day: "2019-01-01", environment: "live", count: 1 });

    const result = await runRetention(db(), { SELF_HOSTED: "true" }, NOW);

    expect(result).toEqual({ analyticsRollups: null, apiUsageDaily: null, sessions: 0 });
    const left = await remaining();
    expect(left.rollups).toEqual([ancient]);
    expect(left.usage).toEqual(["2019-01-01:live"]);
  });

  it("deletes sessions that expired more than a day ago, on hosted and self-hosted alike", async () => {
    for (const env of [{ SELF_HOSTED: "false" }, { SELF_HOSTED: "true" }]) {
      await getTestDb().delete(sessions);
      const longExpired = await seedSession(new Date(NOW.getTime() - 30 * DAY_MS));
      const justExpired = await seedSession(new Date(NOW.getTime() - DAY_MS + 60_000));
      const live = await seedSession(new Date(NOW.getTime() + 7 * DAY_MS));

      const result = await runRetention(db(), env, NOW);

      expect(result.sessions).toBe(1);
      const left = (await remaining()).sessions;
      expect(left).toEqual([justExpired, live].sort());
      expect(left).not.toContain(longExpired);
    }
  });

  it("a second run deletes nothing more", async () => {
    await seedRollup(new Date(CUTOFF.getTime() - DAY_MS));
    await seedSession(new Date(NOW.getTime() - 30 * DAY_MS));
    await runRetention(db(), {}, NOW);
    expect(await runRetention(db(), {}, NOW)).toEqual({ analyticsRollups: 0, apiUsageDaily: 0, sessions: 0 });
  });
});
