import { describe, it, expect } from "vitest";
import { PLAN_LIMITS } from "@gopaylocal/shared";
import {
  bannerShowsBranding,
  effectivePlan,
  isSelfHosted,
  resolveEntitlements,
  type SubscriptionLike,
} from "./entitlements";

const DAY = 86_400_000;
const future = () => new Date(Date.now() + 10 * DAY);
const past = () => new Date(Date.now() - 10 * DAY);

const sub = (
  plan: string,
  status: string,
  currentPeriodEnd: Date | null = future(),
  environment: string | null = "live",
): SubscriptionLike => ({
  plan,
  status,
  currentPeriodEnd,
  environment,
});

const HOSTED = { SELF_HOSTED: "false" };
const SELF = { SELF_HOSTED: "true" };

describe("isSelfHosted", () => {
  it('is true only for SELF_HOSTED="true" (trimmed, case-insensitive)', () => {
    expect(isSelfHosted({ SELF_HOSTED: "true" })).toBe(true);
    expect(isSelfHosted({ SELF_HOSTED: " TRUE " })).toBe(true);
  });

  it("is false when unset or anything else", () => {
    expect(isSelfHosted(undefined)).toBe(false);
    expect(isSelfHosted(null)).toBe(false);
    expect(isSelfHosted({})).toBe(false);
    expect(isSelfHosted({ SELF_HOSTED: "false" })).toBe(false);
    expect(isSelfHosted({ SELF_HOSTED: "1" })).toBe(false);
    expect(isSelfHosted({ SELF_HOSTED: "yes" })).toBe(false);
    expect(isSelfHosted({ SELF_HOSTED: "" })).toBe(false);
  });
});

describe("effectivePlan", () => {
  it("no subscription is free", () => {
    expect(effectivePlan(null)).toBe("free");
    expect(effectivePlan(undefined)).toBe("free");
  });

  it("active pro is pro", () => {
    expect(effectivePlan(sub("pro", "active"))).toBe("pro");
  });

  it("legacy business is treated as pro", () => {
    expect(effectivePlan(sub("business", "active"))).toBe("pro");
    expect(effectivePlan(sub("business", "canceled", future()))).toBe("pro");
    expect(effectivePlan(sub("business", "canceled", past()))).toBe("free");
  });

  it("unknown stored plan values never grant paid limits", () => {
    expect(effectivePlan(sub("enterprise", "active"))).toBe("free");
    expect(effectivePlan(sub("", "active"))).toBe("free");
  });

  it("grace states keep pro until the paid period ends", () => {
    for (const status of ["canceled", "cancelled", "past_due", "on_hold"]) {
      expect(effectivePlan(sub("pro", status, future()))).toBe("pro");
      expect(effectivePlan(sub("pro", status, past()))).toBe("free");
      expect(effectivePlan(sub("pro", status, null))).toBe("free");
    }
  });

  it("expired and unknown statuses drop to free", () => {
    expect(effectivePlan(sub("pro", "expired"))).toBe("free");
    expect(effectivePlan(sub("pro", "weird"))).toBe("free");
  });

  it("a test-mode subscription counts only while the API runs in Dodo test mode", () => {
    const test = sub("pro", "active", future(), "test");
    expect(effectivePlan(test, { DODO_ENVIRONMENT: "test_mode" })).toBe("pro");
    expect(effectivePlan(test, { DODO_ENVIRONMENT: "live_mode" })).toBe("free");
    // Unset means live, as the webhook handler reads it.
    expect(effectivePlan(test, {})).toBe("free");
    expect(effectivePlan(test)).toBe("free");
    // Grace states follow the same rule.
    expect(effectivePlan(sub("pro", "canceled", future(), "test"), { DODO_ENVIRONMENT: "live_mode" })).toBe("free");
    expect(effectivePlan(sub("pro", "canceled", future(), "test"), { DODO_ENVIRONMENT: "test_mode" })).toBe("pro");
  });

  it("a live subscription counts in both modes", () => {
    for (const mode of ["live_mode", "test_mode", undefined]) {
      expect(effectivePlan(sub("pro", "active"), { DODO_ENVIRONMENT: mode })).toBe("pro");
      expect(effectivePlan(sub("pro", "active", future(), null), { DODO_ENVIRONMENT: mode })).toBe("pro");
    }
  });
});

describe("resolveEntitlements (hosted)", () => {
  it("a test-mode Pro subscription gets Free limits and branding once the API runs live", () => {
    const test = sub("pro", "active", future(), "test");
    const live = resolveEntitlements(test, { ...HOSTED, DODO_ENVIRONMENT: "live_mode" });
    expect(live.plan).toBe("free");
    expect(live.limits).toEqual(PLAN_LIMITS.free);
    expect(live.showBranding).toBe(true);
    const testMode = resolveEntitlements(test, { ...HOSTED, DODO_ENVIRONMENT: "test_mode" });
    expect(testMode.plan).toBe("pro");
    expect(testMode.showBranding).toBe(false);
  });

  it("free: plan caps, branding on, billing on", () => {
    const ent = resolveEntitlements(null, HOSTED);
    expect(ent).toEqual({
      plan: "free",
      selfHosted: false,
      limits: PLAN_LIMITS.free,
      showBranding: true,
      billingEnabled: true,
    });
  });

  it("omitting env behaves as hosted", () => {
    expect(resolveEntitlements(null)).toEqual(resolveEntitlements(null, HOSTED));
    expect(resolveEntitlements(sub("pro", "active"), undefined).selfHosted).toBe(false);
  });

  it("active pro: unlimited products/API/seats, 365-day analytics, branding off", () => {
    const ent = resolveEntitlements(sub("pro", "active"), HOSTED);
    expect(ent.plan).toBe("pro");
    expect(ent.limits).toEqual({
      products: null,
      apiHitsPerMonth: null,
      teamMembers: null,
      analyticsRetentionDays: 365,
    });
    expect(ent.showBranding).toBe(false);
    expect(ent.billingEnabled).toBe(true);
  });

  it("legacy business resolves exactly like pro", () => {
    expect(resolveEntitlements(sub("business", "active"), HOSTED)).toEqual(
      resolveEntitlements(sub("pro", "active"), HOSTED),
    );
  });

  it("a lapsed pro subscription gets free caps and branding", () => {
    const ent = resolveEntitlements(sub("pro", "expired"), HOSTED);
    expect(ent.plan).toBe("free");
    expect(ent.limits).toEqual(PLAN_LIMITS.free);
    expect(ent.showBranding).toBe(true);
  });

  it("admin overrides win over plan caps; null overrides are ignored", () => {
    const ent = resolveEntitlements(null, HOSTED, {
      maxProducts: 5,
      maxApiHitsPerMonth: null,
      maxTeamMembers: 4,
    });
    expect(ent.limits.products).toBe(5);
    expect(ent.limits.apiHitsPerMonth).toBe(PLAN_LIMITS.free.apiHitsPerMonth);
    expect(ent.limits.teamMembers).toBe(4);
    expect(ent.limits.analyticsRetentionDays).toBe(7);
  });

  it("an override can put a finite cap on a pro org", () => {
    const ent = resolveEntitlements(sub("pro", "active"), HOSTED, { maxProducts: 25 });
    expect(ent.limits.products).toBe(25);
    expect(ent.limits.apiHitsPerMonth).toBeNull();
  });

  it("never returns the shared PLAN_LIMITS object itself (no aliasing)", () => {
    const ent = resolveEntitlements(null, HOSTED);
    expect(ent.limits).not.toBe(PLAN_LIMITS.free);
  });
});

describe("resolveEntitlements (self-hosted)", () => {
  const unlimited = {
    products: null,
    apiHitsPerMonth: null,
    teamMembers: null,
    analyticsRetentionDays: null,
  };

  it("every org is unlimited with branding and billing off, with no subscription", () => {
    const ent = resolveEntitlements(null, SELF);
    expect(ent).toEqual({
      plan: "free",
      selfHosted: true,
      limits: unlimited,
      showBranding: false,
      billingEnabled: false,
    });
  });

  it("ignores subscription rows of any kind", () => {
    for (const s of [sub("pro", "active"), sub("pro", "expired"), sub("business", "active"), sub("free", "active")]) {
      const ent = resolveEntitlements(s, SELF);
      expect(ent.limits).toEqual(unlimited);
      expect(ent.showBranding).toBe(false);
      expect(ent.billingEnabled).toBe(false);
    }
  });

  it("ignores admin overrides", () => {
    const ent = resolveEntitlements(null, SELF, { maxProducts: 1, maxApiHitsPerMonth: 10, maxTeamMembers: 1 });
    expect(ent.limits).toEqual(unlimited);
  });

  it("limits survive JSON unchanged (null, not Infinity)", () => {
    const ent = resolveEntitlements(null, SELF);
    expect(JSON.parse(JSON.stringify(ent))).toEqual(ent);
  });
});

describe("bannerShowsBranding", () => {
  it("uses the cached plan-derived bit when hosted", () => {
    expect(bannerShowsBranding(true, HOSTED)).toBe(true);
    expect(bannerShowsBranding(false, HOSTED)).toBe(false);
  });

  it("defaults pre-field cache entries to showing branding when hosted", () => {
    expect(bannerShowsBranding(undefined, HOSTED)).toBe(true);
    expect(bannerShowsBranding(undefined, undefined)).toBe(true);
  });

  it("is always false on a self-hosted deployment, whatever the cache holds", () => {
    expect(bannerShowsBranding(true, SELF)).toBe(false);
    expect(bannerShowsBranding(undefined, SELF)).toBe(false);
  });
});
