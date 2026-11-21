// ── Entitlements ────────────────────────────────────────────────────────────
// The ONE place an organization's effective plan, limits and branding are
// resolved. Two inputs decide it:
//
// 1. Deployment mode. When the Worker env var SELF_HOSTED is "true", every
//    organization is unlimited with branding off and billing disabled,
//    regardless of subscription rows or admin overrides.
// 2. Subscription status (hosted only). A paid plan only grants paid limits
//    while the subscription is active (or within a grace window until the paid
//    period ends). Churned, expired, or failed subscriptions fall back to 'free'
//    so paid limits don't leak after a cancellation or payment failure.
//
// Use resolveEntitlements() wherever limits or branding are read (product caps,
// API-hit quota, team size, analytics retention, branding) instead of reading
// subscriptions.plan or PLAN_LIMITS directly. Limits use `null` for unlimited.

import { PLAN_LIMITS, SELF_HOSTED_LIMITS, normalizePlan } from "@gopaylocal/shared";
import type { Plan, PlanLimits } from "@gopaylocal/shared";

export interface SubscriptionLike {
  // Typed as string, not Plan: rows written before the two-plan pricing can
  // still hold the retired 'business' value, which is folded into 'pro'.
  plan: string;
  status: string;
  currentPeriodEnd: Date | null;
}

/** The slice of the Worker env that entitlements read. `Bindings` satisfies it. */
export interface DeploymentEnv {
  SELF_HOSTED?: string;
}

/** Per-org admin overrides (organization_limit_overrides). null = no override. */
export interface LimitOverrideLike {
  maxProducts?: number | null;
  maxApiHitsPerMonth?: number | null;
  maxTeamMembers?: number | null;
}

export interface Entitlements {
  /**
   * Subscription-derived effective plan. In self-hosted mode there is no
   * billing, so this is normally 'free'; read `selfHosted`/`limits`, not
   * `plan`, to decide what an org may do.
   */
  plan: Plan;
  selfHosted: boolean;
  /** Effective caps after deployment mode and overrides. null = unlimited. */
  limits: PlanLimits;
  /** Whether the banner renders the "Powered by GoPayLocal" link. */
  showBranding: boolean;
  /** Whether checkout / billing portal are available. */
  billingEnabled: boolean;
}

/** True when this Worker runs as a self-hosted deployment (SELF_HOSTED="true"). */
export function isSelfHosted(env: DeploymentEnv | null | undefined): boolean {
  return env?.SELF_HOSTED?.trim().toLowerCase() === "true";
}

/** Effective plan from subscription status alone (ignores deployment mode). */
export function effectivePlan(sub: SubscriptionLike | null | undefined): Plan {
  const stored = normalizePlan(sub?.plan);
  if (!sub || !stored || stored === "free") return "free";

  const periodActive = sub.currentPeriodEnd
    ? sub.currentPeriodEnd.getTime() > Date.now()
    : false;

  switch (sub.status) {
    case "active":
      return stored;
    // Cancel-at-period-end and dunning grace: keep the paid plan until the
    // already-paid period actually ends, then drop to free.
    case "canceled":
    case "cancelled":
    case "past_due":
    case "on_hold":
      return periodActive ? stored : "free";
    // Hard-ended / unknown states never retain paid limits.
    case "expired":
    default:
      return "free";
  }
}

/**
 * Resolve everything an org is entitled to. `env` decides self-hosted mode;
 * omitting it means hosted behavior. Overrides only apply when hosted.
 */
export function resolveEntitlements(
  sub: SubscriptionLike | null | undefined,
  env?: DeploymentEnv | null,
  override?: LimitOverrideLike | null,
): Entitlements {
  const plan = effectivePlan(sub);

  if (isSelfHosted(env)) {
    return {
      plan,
      selfHosted: true,
      limits: { ...SELF_HOSTED_LIMITS },
      showBranding: false,
      billingEnabled: false,
    };
  }

  const base = PLAN_LIMITS[plan];
  return {
    plan,
    selfHosted: false,
    limits: {
      products: override?.maxProducts ?? base.products,
      apiHitsPerMonth: override?.maxApiHitsPerMonth ?? base.apiHitsPerMonth,
      teamMembers: override?.maxTeamMembers ?? base.teamMembers,
      analyticsRetentionDays: base.analyticsRetentionDays,
    },
    showBranding: plan === "free",
    billingEnabled: true,
  };
}

/**
 * Serve-time branding decision for the banner endpoint. The KV banner config
 * caches the plan-derived bit; this applies the deployment override on top so
 * a self-hosted Worker never shows branding, even if a cache entry was built
 * without env. Pre-field cache entries (undefined) default to showing it.
 */
export function bannerShowsBranding(
  cachedShowBranding: boolean | undefined,
  env: DeploymentEnv | null | undefined,
): boolean {
  if (isSelfHosted(env)) return false;
  return cachedShowBranding ?? true;
}
