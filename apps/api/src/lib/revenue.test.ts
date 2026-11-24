import { describe, expect, it } from "vitest";
import { activationFunnel, signupsByWeek, summarizeRevenue, type OrgActivationFacts, type RevenueRow } from "./revenue";

const NOW = new Date(Date.UTC(2026, 10, 24, 12));
const BEFORE_MONTH = new Date(Date.UTC(2026, 9, 10));
const THIS_MONTH = new Date(Date.UTC(2026, 10, 5));

const sub = (fields: Partial<RevenueRow>): RevenueRow => ({
  organizationId: "org",
  organizationName: "Org",
  plan: "pro",
  status: "active",
  environment: "live",
  recurringAmount: 1900,
  currency: "USD",
  billingCountry: "US",
  createdAt: BEFORE_MONTH,
  updatedAt: BEFORE_MONTH,
  currentPeriodEnd: null,
  internal: false,
  ...fields,
});

describe("summarizeRevenue", () => {
  it("counts live subscriptions of non-internal workspaces at what they are charged, per currency and country", () => {
    const out = summarizeRevenue(
      [
        sub({}),
        sub({ recurringAmount: 47_900, currency: "INR", billingCountry: "IN" }),
        sub({ recurringAmount: 52_900, currency: "INR", billingCountry: "IN" }),
        sub({ environment: "test" }),
        sub({ internal: true }),
        sub({ plan: "free" }),
      ],
      NOW,
    );
    expect(out.active).toBe(3);
    expect(out.mrrByCurrency).toEqual({ USD: 19, INR: 1008 });
    expect(out.estimatedMRR).toBe(19);
    expect(out.byCountry).toEqual([
      { country: "IN", countryName: "India", subscriptions: 2, mrrByCurrency: { INR: 1008 } },
      { country: "US", countryName: "United States", subscriptions: 1, mrrByCurrency: { USD: 19 } },
    ]);
    expect(out.leftOut).toEqual({ test: 1, internal: 1 });
  });

  it("reports new, cancelled and past-due subscriptions this month, and churn of those running on the 1st", () => {
    const out = summarizeRevenue(
      [
        sub({}), // running since before the month
        sub({ createdAt: THIS_MONTH, updatedAt: THIS_MONTH }), // new
        sub({ status: "canceled", updatedAt: THIS_MONTH }), // ended this month: churn
        sub({ status: "expired", updatedAt: BEFORE_MONTH }), // ended before: not running on the 1st
        sub({ status: "past_due", updatedAt: THIS_MONTH }),
      ],
      NOW,
    );
    expect(out).toMatchObject({ active: 2, newThisMonth: 1, cancelledThisMonth: 1, pastDue: 1 });
    expect(out.churn).toEqual({ runningOnFirst: 3, ended: 1, rate: 1 / 3 });
  });

  it("has no churn rate when nothing was running on the 1st, and counts an older row at the list price", () => {
    const out = summarizeRevenue([sub({ createdAt: THIS_MONTH, recurringAmount: null, currency: null, billingCountry: null })], NOW);
    expect(out.churn.rate).toBeNull();
    expect(out.mrrByCurrency).toEqual({ USD: 19 });
    expect(out.byCountry[0]).toMatchObject({ country: null, countryName: "Not recorded" });
  });
});

describe("activationFunnel", () => {
  const org = (id: string, days: number, facts: Partial<OrgActivationFacts>): OrgActivationFacts => ({
    id,
    name: id,
    createdAt: new Date(NOW.getTime() - days * 86_400_000),
    ownerEmail: `${id}@example.com`,
    hasProduct: false,
    hasActiveCampaign: false,
    hasLiveViews: false,
    isPro: false,
    ...facts,
  });

  it("counts a step only when every step before it is done, and lists who is stuck at each", () => {
    const steps = activationFunnel(
      [
        org("new", 1, {}),
        org("product", 3, { hasProduct: true }),
        org("live", 10, { hasProduct: true, hasActiveCampaign: true, hasLiveViews: true }),
        org("pro", 30, { hasProduct: true, hasActiveCampaign: true, hasLiveViews: true, isPro: true }),
        // Pro without a product: stuck at the product step, not counted as Pro.
        org("odd", 2, { isPro: true }),
      ],
      NOW,
    );
    expect(steps.map((s) => [s.key, s.reached, s.stuckCount])).toEqual([
      ["signedUp", 5, 0],
      ["hasProduct", 3, 2],
      ["hasActiveCampaign", 2, 1],
      ["hasLiveViews", 2, 0],
      ["isPro", 1, 1],
    ]);
    expect(steps[1]!.stuck.map((s) => s.id)).toEqual(["new", "odd"]);
    expect(steps[4]!.stuck[0]).toMatchObject({ id: "live", ownerEmail: "live@example.com", daysSinceSignup: 10 });
  });
});

describe("signupsByWeek", () => {
  it("counts sign-ups per UTC week starting Monday, oldest first", () => {
    // 2026-11-24 is a Tuesday; this week starts Monday 2026-11-23.
    const weeks = signupsByWeek(
      [new Date(Date.UTC(2026, 10, 23)), new Date(Date.UTC(2026, 10, 24)), new Date(Date.UTC(2026, 10, 22)), new Date(Date.UTC(2025, 0, 1))],
      NOW,
      3,
    );
    expect(weeks).toEqual([
      { weekStart: "2026-11-09", signups: 0 },
      { weekStart: "2026-11-16", signups: 1 },
      { weekStart: "2026-11-23", signups: 2 },
    ]);
  });
});
