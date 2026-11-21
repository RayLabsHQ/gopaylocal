import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { ulid } from "ulid";
import worker from "../index";
import {
  analyticsRollups,
  apiUsageDaily,
  invitations,
  members,
  organizationLimitOverrides,
  subscriptions,
} from "../db/schema";
import {
  createExecutionContext,
  createTestBindings,
  createTestClient,
  type TestClient,
} from "../test/helpers";
import { addMember, as, seedTenant, seedUser, signIn, type TestTenant } from "../test/auth";
import { cleanupTestDb, closeTestDb, getTestDb } from "../test/setup";
import { usageKey } from "../services/usage.service";
import { utcDay, writeUsageRows } from "../services/usage-meter";
import type { Database } from "../db";

vi.mock("../../../../packages/banner/dist/banner.js", () => ({ default: "" }));

/**
 * Plan limits enforced end to end (full Worker, real sessions, real Postgres):
 * Free (1 product, 1 seat, 10K API hits/month, 7-day analytics) vs Pro
 * (unlimited, 365-day analytics) vs a self-hosted deployment (SELF_HOSTED=
 * "true": unlimited everything, billing disabled), plus status-aware
 * entitlements (a lapsed Pro subscription is Free again) and admin overrides.
 */

const DAY_MS = 86_400_000;

function deployment(selfHosted = false): TestClient {
  return createTestClient(
    worker,
    createTestBindings(selfHosted ? { SELF_HOSTED: "true" } : {}),
  );
}

async function setSubscription(
  orgId: string,
  plan: "free" | "pro",
  status: string,
  currentPeriodEnd: Date | null,
) {
  await getTestDb()
    .insert(subscriptions)
    .values({ id: ulid(), organizationId: orgId, plan, status, currentPeriodEnd });
}

const inDays = (days: number) => new Date(Date.now() + days * DAY_MS);

async function createProduct(client: TestClient, tenant: TestTenant, n: number) {
  return client.request(`/v1/teams/${tenant.orgId}/products`, {
    method: "POST",
    headers: as(tenant),
    json: { name: `Product ${n}`, url: `https://example.com/${n}`, basePrice: 10 },
  });
}

async function usage(client: TestClient, tenant: TestTenant) {
  const res = await client.request(`/v1/teams/${tenant.orgId}/billing/usage`, { headers: as(tenant) });
  expect(res.status).toBe(200);
  return (await res.json()).data;
}

async function invite(client: TestClient, tenant: TestTenant, email: string) {
  return client.request("/api/auth/organization/invite-member", {
    method: "POST",
    headers: as(tenant),
    json: { email, role: "member", organizationId: tenant.orgId },
  });
}

async function pendingInvites(orgId: string) {
  return getTestDb()
    .select()
    .from(invitations)
    .where(and(eq(invitations.organizationId, orgId), eq(invitations.status, "pending")));
}

describe("Plan limits (full Worker)", () => {
  beforeEach(async () => {
    await cleanupTestDb();
  });

  afterAll(async () => {
    await cleanupTestDb();
    await closeTestDb();
  });

  describe("product cap", () => {
    it("Free: the second product is refused with the plan and cap", async () => {
      const client = deployment();
      const t = await seedTenant(client, "Free Org");

      expect((await createProduct(client, t, 1)).status).toBe(201);
      const second = await createProduct(client, t, 2);
      expect(second.status).toBe(403);
      expect(await second.json()).toMatchObject({
        error: "Product limit reached",
        plan: "free",
        maxProducts: 1,
        currentCount: 1,
      });
      expect(await usage(client, t)).toMatchObject({
        plan: "free",
        selfHosted: false,
        billingEnabled: true,
        maxProducts: 1,
        currentCount: 1,
        remaining: 0,
      });
    });

    it("Pro (active): unlimited products, reported as null", async () => {
      const client = deployment();
      const t = await seedTenant(client, "Pro Org");
      await setSubscription(t.orgId, "pro", "active", inDays(30));

      for (const n of [1, 2, 3]) expect((await createProduct(client, t, n)).status).toBe(201);
      expect(await usage(client, t)).toMatchObject({
        plan: "pro",
        maxProducts: null,
        currentCount: 3,
        remaining: null,
      });
    });

    it("Pro cancelled keeps Pro until the paid period ends, then falls back to Free", async () => {
      const client = deployment();
      const grace = await seedTenant(client, "Grace Org");
      await setSubscription(grace.orgId, "pro", "canceled", inDays(5));
      for (const n of [1, 2]) expect((await createProduct(client, grace, n)).status).toBe(201);

      const lapsed = await seedTenant(client, "Lapsed Org");
      await setSubscription(lapsed.orgId, "pro", "canceled", inDays(-1));
      expect((await createProduct(client, lapsed, 1)).status).toBe(201);
      const refused = await createProduct(client, lapsed, 2);
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({ plan: "free", maxProducts: 1 });
    });

    it("an admin override raises a hosted org's cap", async () => {
      const client = deployment();
      const t = await seedTenant(client, "Override Org");
      await getTestDb()
        .insert(organizationLimitOverrides)
        .values({ id: ulid(), organizationId: t.orgId, maxProducts: 2 });

      for (const n of [1, 2]) expect((await createProduct(client, t, n)).status).toBe(201);
      const third = await createProduct(client, t, 3);
      expect(third.status).toBe(403);
      expect(await third.json()).toMatchObject({ maxProducts: 2, currentCount: 2 });
    });

    it("self-hosted: unlimited with no subscription, overrides ignored, billing disabled", async () => {
      const client = deployment(true);
      const t = await seedTenant(client, "Self-hosted Org");
      // Even a restrictive override must not cap a self-hosted deployment.
      await getTestDb()
        .insert(organizationLimitOverrides)
        .values({ id: ulid(), organizationId: t.orgId, maxProducts: 1 });

      for (const n of [1, 2, 3]) expect((await createProduct(client, t, n)).status).toBe(201);
      expect(await usage(client, t)).toMatchObject({
        selfHosted: true,
        billingEnabled: false,
        maxProducts: null,
        meters: { apiHits: { max: null }, teamMembers: { max: null } },
      });

      const checkout = await client.request(`/v1/teams/${t.orgId}/billing/checkout`, {
        method: "POST",
        headers: as(t),
        json: { plan: "pro" },
      });
      expect(checkout.status).toBe(404);
      expect(await checkout.json()).toMatchObject({ code: "billing_disabled" });
    });
  });

  describe("seat cap (Better Auth invitation hooks)", () => {
    it("Free: the owner already fills the one seat, so an invitation is refused", async () => {
      const client = deployment();
      const t = await seedTenant(client, "Free Org");

      const res = await invite(client, t, "teammate@example.test");
      expect(res.status).toBe(403);
      expect(JSON.stringify(await res.json())).toContain("Your plan allows 1 team member");
      expect(await pendingInvites(t.orgId)).toHaveLength(0);
    });

    it("Pro: invitations are unlimited and count as seats in the usage meter", async () => {
      const client = deployment();
      const t = await seedTenant(client, "Pro Org");
      await setSubscription(t.orgId, "pro", "active", inDays(30));

      expect((await invite(client, t, "one@example.test")).status).toBe(200);
      expect((await invite(client, t, "two@example.test")).status).toBe(200);
      expect(await pendingInvites(t.orgId)).toHaveLength(2);
      expect((await usage(client, t)).meters.teamMembers).toEqual({ current: 3, max: null });
    });

    it("self-hosted: invitations are unlimited without any subscription", async () => {
      const client = deployment(true);
      const t = await seedTenant(client, "Self-hosted Org");
      expect((await invite(client, t, "one@example.test")).status).toBe(200);
      expect((await invite(client, t, "two@example.test")).status).toBe(200);
    });

    it("a seat override counts pending invitations against the cap", async () => {
      const client = deployment();
      const t = await seedTenant(client, "Two Seat Org");
      await getTestDb()
        .insert(organizationLimitOverrides)
        .values({ id: ulid(), organizationId: t.orgId, maxTeamMembers: 2 });

      expect((await invite(client, t, "one@example.test")).status).toBe(200);
      const second = await invite(client, t, "two@example.test");
      expect(second.status).toBe(403);
      expect(JSON.stringify(await second.json())).toContain("Your plan allows 2 team members");
      expect(await pendingInvites(t.orgId)).toHaveLength(1);
    });

    it("only the owner may invite, even on Pro", async () => {
      const client = deployment();
      const t = await seedTenant(client, "Pro Org");
      await setSubscription(t.orgId, "pro", "active", inDays(30));
      const adminUser = await seedUser(client.env, "Admin");
      await addMember(t.orgId, adminUser.id, "admin");
      const adminCookie = await signIn(client, adminUser);

      const res = await invite(client, { ...t, cookie: adminCookie }, "x@example.test");
      expect(res.status).toBe(403);
      expect(await pendingInvites(t.orgId)).toHaveLength(0);
    });

    it("accepting is capped too: an invite sent on Pro cannot be accepted after a lapse to Free", async () => {
      const client = deployment();
      const t = await seedTenant(client, "Lapsing Org");
      await setSubscription(t.orgId, "pro", "active", inDays(30));
      const invitee = await seedUser(client.env, "Invitee");

      const sent = await invite(client, t, invitee.email);
      expect(sent.status).toBe(200);
      const [inv] = await pendingInvites(t.orgId);

      await getTestDb()
        .update(subscriptions)
        .set({ status: "expired" })
        .where(eq(subscriptions.organizationId, t.orgId));

      const inviteeCookie = await signIn(client, invitee);
      const accept = await client.request("/api/auth/organization/accept-invitation", {
        method: "POST",
        headers: as({ cookie: inviteeCookie }),
        json: { invitationId: inv!.id },
      });
      // Better Auth's membershipLimit guard (auth.ts) answers 403
      // "Organization membership limit reached".
      expect(accept.status).toBe(403);
      expect(await accept.text()).toMatch(/limit/i);
      const memberRows = await getTestDb()
        .select()
        .from(members)
        .where(eq(members.organizationId, t.orgId));
      expect(memberRows).toHaveLength(1); // still just the owner
    });
  });

  describe("analytics retention", () => {
    async function seedHistory(orgId: string) {
      // One rollup per age; impressions encode the age bucket so sums identify them.
      const rows = [
        { daysAgo: 3, impressions: 1 },
        { daysAgo: 30, impressions: 10 },
        { daysAgo: 200, impressions: 100 },
        { daysAgo: 400, impressions: 1000 },
      ];
      await getTestDb()
        .insert(analyticsRollups)
        .values(
          rows.map((r) => ({
            id: ulid(),
            organizationId: orgId,
            campaignId: `camp-${orgId}`,
            countryCode: "IN",
            period: "day",
            periodStart: new Date(Date.now() - r.daysAgo * DAY_MS),
            impressions: r.impressions,
          })),
        );
    }

    async function totalImpressions(client: TestClient, t: TestTenant, from = "2000-01-01") {
      const res = await client.request(`/v1/teams/${t.orgId}/analytics/overview?from=${from}`, {
        headers: as(t),
      });
      expect(res.status).toBe(200);
      return (await res.json()).data.totalImpressions as number;
    }

    it("Free reads 7 days, Pro 365 days, self-hosted everything, whatever `from` asks for", async () => {
      const hosted = deployment();
      const free = await seedTenant(hosted, "Free Org");
      const pro = await seedTenant(hosted, "Pro Org");
      await setSubscription(pro.orgId, "pro", "active", inDays(30));
      const selfHostedClient = deployment(true);
      const selfHosted = await seedTenant(selfHostedClient, "Self-hosted Org");
      for (const t of [free, pro, selfHosted]) await seedHistory(t.orgId);

      expect(await totalImpressions(hosted, free)).toBe(1);
      expect(await totalImpressions(hosted, pro)).toBe(111);
      expect(await totalImpressions(selfHostedClient, selfHosted)).toBe(1111);

      // The by-country breakdown is clamped the same way.
      const byCountry = await (
        await hosted.request(`/v1/teams/${free.orgId}/analytics/by-country?from=2000-01-01`, {
          headers: as(free),
        })
      ).json();
      expect(byCountry.data).toEqual([
        expect.objectContaining({ countryCode: "IN", impressions: 1 }),
      ]);

      // A later `from` still narrows within the window.
      const tenDaysAgo = new Date(Date.now() - 10 * DAY_MS).toISOString();
      expect(await totalImpressions(hosted, pro, encodeURIComponent(tenDaysAgo))).toBe(1);
    });
  });

  describe("monthly API-hit quota (usage cron + banner endpoint)", () => {
    /** A tenant with a live banner: parity group, public key, active campaign. */
    async function liveBanner(client: TestClient, name: string) {
      const t = await seedTenant(client, name);
      const req = (path: string, init: Parameters<TestClient["request"]>[1]) =>
        client.request(`/v1/teams/${t.orgId}${path}`, { ...init, headers: as(t) });
      const product = await (
        await req("/products", { method: "POST", json: { name: "P", url: "https://p.example.com", basePrice: 20 } })
      ).json();
      const group = await (
        await req("/parity-groups", { method: "POST", json: { name: "Tier", discountPercent: 40, sortOrder: 1 } })
      ).json();
      await req(`/parity-groups/${group.data.id}/countries`, { method: "PUT", json: { countries: ["IN"] } });
      const key = await (await req("/api-keys", { method: "POST", json: { name: "Site", keyType: "public" } })).json();
      const campaign = await req("/campaigns", {
        method: "POST",
        json: { productId: product.data.id, name: "Live", status: "active" },
      });
      expect(campaign.status).toBe(201);
      const campaignId = (await campaign.json()).data.id as string;
      return { t, rawKey: key.data.key as string, campaignId };
    }

    // Usage is metered server-side: every banner config call adds 1 to
    // api_usage_daily (organization, UTC day, environment), and the usage cron
    // sums this month's live rows into the `usage:` KV snapshot the banner reads.
    const usageDb = () => getTestDb() as unknown as Pick<Database, "insert">;

    /** Add `count` calls to an organization's api_usage_daily row (upsert: adds to the stored count). */
    async function meterHits(orgId: string, count: number, environment: "live" | "test" = "live", day = new Date()) {
      await writeUsageRows(usageDb(), [{ organizationId: orgId, day: utcDay(day), environment, count }]);
    }

    /** Calls api_usage_daily holds for an organization today, live. */
    async function meteredToday(orgId: string) {
      const [row] = await getTestDb()
        .select({ count: apiUsageDaily.count })
        .from(apiUsageDaily)
        .where(
          and(
            eq(apiUsageDaily.organizationId, orgId),
            eq(apiUsageDaily.day, utcDay(new Date())),
            eq(apiUsageDaily.environment, "live"),
          ),
        );
      return row?.count ?? 0;
    }

    async function runUsageCron(client: TestClient) {
      const ctx = createExecutionContext();
      await worker.scheduled(
        { cron: "*/10 * * * *", scheduledTime: Date.now(), noRetry() {} } as unknown as ScheduledController,
        client.env,
        ctx,
      );
      await ctx.settle();
    }

    async function banner(client: TestClient, rawKey: string) {
      const res = await client.request(`/v1/banner/config/${rawKey}`, { cf: { country: "IN" } });
      expect(res.status).toBe(200);
      return res.json();
    }

    it("Free stops serving the banner at 10K live hits; Pro keeps serving", async () => {
      const client = deployment();
      const free = await liveBanner(client, "Free Org");
      const pro = await liveBanner(client, "Pro Org");
      await setSubscription(pro.t.orgId, "pro", "active", inDays(30));

      // The real banner route meters each call: written inside the request's
      // waitUntil, which createTestClient settles before returning.
      expect(await meteredToday(free.t.orgId)).toBe(0);
      expect(await banner(client, free.rawKey)).toMatchObject({ show: true, discount: 40, showBranding: true });
      expect(await meteredToday(free.t.orgId)).toBe(1);
      expect(await banner(client, pro.rawKey)).toMatchObject({ show: true });
      expect(await meteredToday(pro.t.orgId)).toBe(1);

      await meterHits(free.t.orgId, 9_997); // 1 + 9,997 = 9,998
      await meterHits(pro.t.orgId, 50_000);
      // Test-mode calls and calls from an earlier month do not count toward the quota.
      await meterHits(free.t.orgId, 5_000, "test");
      await meterHits(free.t.orgId, 5_000, "live", new Date(Date.now() - 40 * DAY_MS));
      await runUsageCron(client);
      expect(await banner(client, free.rawKey)).toMatchObject({ show: true }); // the 9,999th call
      expect(await meteredToday(free.t.orgId)).toBe(9_999);

      await meterHits(free.t.orgId, 1); // 10,000 this month: at the cap
      await runUsageCron(client);

      expect(await banner(client, free.rawKey)).toEqual({ show: false, reason: "quota_exceeded" });
      // The cron also reconciled branding for the Pro org (paid plans hide it).
      expect(await banner(client, pro.rawKey)).toMatchObject({ show: true, showBranding: false });
      expect((await usage(client, free.t)).meters.apiHits).toEqual({ current: 10_000, max: 10_000 });
    });

    it("self-hosted never applies the quota, even with a snapshot that says over", async () => {
      const client = deployment(true);
      const sh = await liveBanner(client, "Self-hosted Org");
      await meterHits(sh.t.orgId, 1_000_000);
      await runUsageCron(client);
      const snapshot = JSON.parse((await client.env.CACHE.get(usageKey(sh.t.orgId)))!);
      expect(snapshot).toMatchObject({ count: 1_000_000, limit: null, over: false });

      // Even a stale or foreign snapshot claiming "over" is ignored when self-hosted.
      await client.env.CACHE.put(
        usageKey(sh.t.orgId),
        JSON.stringify({ ...snapshot, limit: 10_000, over: true }),
      );
      expect(await banner(client, sh.rawKey)).toMatchObject({ show: true, showBranding: false });
      // Still metered (the dashboard meter reads it), never enforced. Self-hosted
      // is unlimited, so this also proves the unlimited flush path writes in tests.
      expect(await meteredToday(sh.t.orgId)).toBe(1_000_001);
    });
  });

  describe("plan changes through the signed Dodo billing webhook", () => {
    const PRO_MONTHLY = "pdt_test_pro_monthly";
    const secretBytes = new Uint8Array(32).map((_, i) => (i * 37 + 11) % 256);
    const WEBHOOK_SECRET = `whsec_${btoa(String.fromCharCode(...secretBytes))}`;

    function billingDeployment(): TestClient {
      return createTestClient(
        worker,
        createTestBindings({ DODO_WEBHOOK_SECRET: WEBHOOK_SECRET, DODO_PRICE_ID_PRO_MONTHLY: PRO_MONTHLY }),
      );
    }

    /** Sign like Dodo does (Standard Webhooks: HMAC-SHA256 over "id.timestamp.body"). */
    async function signedDelivery(client: TestClient, id: string, payload: unknown, secret = WEBHOOK_SECRET) {
      const body = JSON.stringify(payload);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const keyBytes = Uint8Array.from(atob(secret.slice("whsec_".length)), (ch) => ch.charCodeAt(0));
      const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const mac = new Uint8Array(
        await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${body}`)),
      );
      return client.request("/v1/webhooks/dodo", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "webhook-id": id,
          "webhook-timestamp": timestamp,
          "webhook-signature": `v1,${btoa(String.fromCharCode(...mac))}`,
        },
        body,
      });
    }

    it("subscription.active on the Pro product lifts the caps; expiry returns the org to Free", async () => {
      const client = billingDeployment();
      const t = await seedTenant(client, "Upgrading Org");
      expect((await createProduct(client, t, 1)).status).toBe(201);
      expect((await createProduct(client, t, 2)).status).toBe(403);

      const activation = {
        type: "subscription.active",
        data: {
          product_id: PRO_MONTHLY,
          subscription_id: "sub_test_1",
          customer: { customer_id: "cus_test_1" },
          next_billing_date: inDays(30).toISOString(),
          metadata: { organizationId: t.orgId, plan: "pro" },
        },
      };

      // A forged signature changes nothing.
      const forged = await signedDelivery(client, "msg_forged", activation, `whsec_${btoa("not-the-secret-key-at-all")}`);
      expect(forged.status).toBe(401);
      expect((await usage(client, t)).plan).toBe("free");

      const res = await signedDelivery(client, "msg_activate_1", activation);
      expect(res.status).toBe(200);
      const [sub] = await getTestDb().select().from(subscriptions).where(eq(subscriptions.organizationId, t.orgId));
      expect(sub).toMatchObject({ plan: "pro", status: "active", dodoSubId: "sub_test_1", dodoCustId: "cus_test_1" });

      // Redelivery of the same webhook-id is acknowledged, not reprocessed.
      const replay = await signedDelivery(client, "msg_activate_1", activation);
      expect(await replay.json()).toMatchObject({ received: true, duplicate: true });

      expect((await createProduct(client, t, 2)).status).toBe(201);
      expect((await usage(client, t)).plan).toBe("pro");

      const expired = await signedDelivery(client, "msg_expire_1", {
        type: "subscription.expired",
        data: { subscription_id: "sub_test_1", metadata: { organizationId: t.orgId } },
      });
      expect(expired.status).toBe(200);
      expect((await usage(client, t)).plan).toBe("free");
      const refused = await createProduct(client, t, 3);
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({ plan: "free", maxProducts: 1, currentCount: 2 });
    });
  });
});
