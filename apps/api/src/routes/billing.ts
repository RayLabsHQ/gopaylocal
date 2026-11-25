import { Hono } from "hono";
import type { Context } from "hono";
import { eq } from "drizzle-orm";
import { normalizePlan, remainingUnder } from "@gopaylocal/shared";
import type { AppEnv } from "../bindings";
import { createDb } from "../db";
import { subscriptions } from "../db/schema";
import { getUsageSummary } from "../lib/limits";
import { isSelfHosted, resolveEntitlements } from "../lib/entitlements";
import { requirePermission } from "../middleware/permissions";

const app = new Hono<AppEnv>();

// Self-hosted deployments (SELF_HOSTED="true") have no billing. The read
// endpoints below stay up and report `selfHosted: true` so the dashboard can
// hide billing UI without an extra round trip; the endpoints that would talk
// to Dodo (checkout, portal) answer with this typed 404.
function billingDisabled(c: Context<AppEnv>) {
  return c.json(
    { error: "Billing is disabled on self-hosted deployments.", code: "billing_disabled" },
    404,
  );
}

// Get current plan + subscription info.
// `plan` is the stored plan (legacy 'business' reported as 'pro');
// `effectivePlan` is what the org is entitled to right now (a lapsed Pro
// subscription reads plan 'pro', effectivePlan 'free').
app.get("/v1/teams/:orgId/billing", requirePermission("billing.view"), async (c) => {
  const orgId = c.req.param("orgId");
  const db = createDb(c.env);

  try {
    const result = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.organizationId, orgId))
      .limit(1);

    const subscription = result[0];
    const ent = resolveEntitlements(subscription ?? null, c.env);
    const mode = {
      effectivePlan: ent.plan,
      selfHosted: ent.selfHosted,
      billingEnabled: ent.billingEnabled,
    };

    if (!subscription) {
      // No subscription record — default to free plan
      return c.json({
        data: {
          plan: "free",
          status: "active",
          currentPeriodEnd: null,
          dodoCustId: null,
          dodoSubId: null,
          ...mode,
        },
      });
    }

    return c.json({
      data: {
        ...subscription,
        plan: normalizePlan(subscription.plan) ?? "free",
        ...mode,
      },
    });
  } catch (err) {
    return c.json({ error: "Failed to fetch billing info" }, 500);
  }
});

// Get usage / limits for the org's three metered resources.
// Returns structured `meters` (products / apiHits / teamMembers) for the billing
// UI, plus flat product fields kept for back-compat with the product-creation
// and integration-import gates. Every cap (`max`, `maxProducts`) and
// `remaining` is `null` when unlimited.
app.get("/v1/teams/:orgId/billing/usage", requirePermission("billing.view"), async (c) => {
  const orgId = c.req.param("orgId");
  const db = createDb(c.env);

  try {
    const summary = await getUsageSummary(db, orgId, c.env);
    return c.json({
      data: {
        plan: summary.plan,
        selfHosted: summary.selfHosted,
        billingEnabled: summary.billingEnabled,
        // Legacy flat product fields (products/new + integrations import gates).
        maxProducts: summary.products.max,
        currentCount: summary.products.current,
        remaining: remainingUnder(summary.products.max, summary.products.current),
        // Structured meters for the billing usage panel.
        meters: {
          products: summary.products,
          apiHits: summary.apiHits,
          teamMembers: summary.teamMembers,
        },
      },
    });
  } catch (err) {
    return c.json({ error: "Failed to fetch usage info" }, 500);
  }
});

/**
 * Why a new checkout is refused for a workspace, or null when it may check out.
 * Pro is the only paid plan, so a second checkout while a subscription still
 * bills would charge twice; changes go through the billing portal. A cancelled
 * subscription bills no more: its workspace keeps Pro until the paid period
 * ends and may subscribe again before then (Dodo starts a new monthly period
 * that day). A failed payment is fixed by updating the payment method, not by
 * a second subscription.
 */
export function checkoutRefusal(
  existing: Parameters<typeof resolveEntitlements>[0],
  env: Parameters<typeof resolveEntitlements>[1],
): { error: string; code: "already_subscribed" | "payment_method_needed" } | null {
  if (resolveEntitlements(existing, env).plan !== "pro") return null;
  switch (existing?.status) {
    case "canceled":
    case "cancelled":
    case "expired":
      return null;
    case "past_due":
    case "on_hold":
      return {
        error: "The last payment for Pro didn't go through. Update the payment method in Manage billing.",
        code: "payment_method_needed",
      };
    default:
      return { error: "This organization already has Pro. Use Manage Billing to change it.", code: "already_subscribed" };
  }
}

// Create Dodo checkout session for upgrade to Pro (the only paid plan).
// Body: { plan: "pro" }. Pro is billed monthly; there is no yearly plan.
app.post("/v1/teams/:orgId/billing/checkout", requirePermission("billing.manage"), async (c) => {
  if (isSelfHosted(c.env)) return billingDisabled(c);

  const orgId = c.req.param("orgId");

  try {
    const body = (await c.req.json().catch(() => ({}))) as {
      plan?: unknown;
      interval?: unknown;
    };

    if (body.plan !== "pro") {
      return c.json({ error: "Invalid plan. Must be 'pro'." }, 400);
    }

    // A dashboard page loaded before the yearly plan was removed can still ask
    // for it. Refuse, so nobody is put on monthly billing who chose yearly.
    if (body.interval !== undefined && body.interval !== "month") {
      return c.json({ error: "Pro is billed monthly.", code: "invalid_interval" }, 400);
    }

    const productId = c.env.DODO_PRICE_ID_PRO_MONTHLY;
    if (!productId) {
      return c.json(
        { error: "Billing is not configured on this deployment.", code: "billing_not_configured" },
        503,
      );
    }

    const db = createDb(c.env);
    const existing = await db
      .select({
        plan: subscriptions.plan,
        status: subscriptions.status,
        currentPeriodEnd: subscriptions.currentPeriodEnd,
        environment: subscriptions.environment,
      })
      .from(subscriptions)
      .where(eq(subscriptions.organizationId, orgId))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    const refusal = checkoutRefusal(existing, c.env);
    if (refusal) return c.json(refusal, 409);

    // Derive redirect base from request origin or env var, falling back to production
    const appBaseUrl = c.env.APP_BASE_URL
      ?? c.req.header("origin")
      ?? "https://app.gopaylocal.com";

    const dodoBase = c.env.DODO_ENVIRONMENT === "test_mode"
      ? "https://test.dodopayments.com"
      : "https://live.dodopayments.com";

    // Create a checkout session with Dodo Payments API
    const response = await fetch(`${dodoBase}/checkouts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${c.env.DODO_API_KEY}`,
      },
      body: JSON.stringify({
        product_cart: [
          {
            product_id: productId,
            quantity: 1,
          },
        ],
        metadata: {
          organizationId: orgId,
          plan: "pro",
        },
        return_url: `${appBaseUrl}/dashboard/settings?tab=billing&success=true`,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error("Dodo checkout error:", errorBody);
      return c.json(
        { error: "Failed to create checkout session", details: errorBody },
        502,
      );
    }

    const session = (await response.json()) as { checkout_url: string; session_id: string };
    return c.json({ data: { checkoutUrl: session.checkout_url, sessionId: session.session_id } });
  } catch (err) {
    return c.json({ error: "Failed to create checkout session" }, 500);
  }
});

// Redirect to Dodo billing portal
app.post("/v1/teams/:orgId/billing/portal", requirePermission("billing.manage"), async (c) => {
  if (isSelfHosted(c.env)) return billingDisabled(c);

  const orgId = c.req.param("orgId");
  const db = createDb(c.env);

  try {
    const result = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.organizationId, orgId))
      .limit(1);

    const subscription = result[0];

    if (!subscription?.dodoCustId) {
      return c.json({ error: "No billing account found. Subscribe to a plan first." }, 404);
    }

    // Derive redirect base from request origin or env var, falling back to production
    const appBaseUrl = c.env.APP_BASE_URL
      ?? c.req.header("origin")
      ?? "https://app.gopaylocal.com";

    const dodoBase = c.env.DODO_ENVIRONMENT === "test_mode"
      ? "https://test.dodopayments.com"
      : "https://live.dodopayments.com";

    // Create a customer portal session with Dodo Payments. The customer id is a
    // path segment, the params go in the query string, and the body is empty.
    const sessionUrl = new URL(
      `${dodoBase}/customers/${encodeURIComponent(subscription.dodoCustId)}/customer-portal/session`,
    );
    sessionUrl.searchParams.set(
      "return_url",
      `${appBaseUrl}/dashboard/settings?tab=billing`,
    );

    const response = await fetch(sessionUrl.toString(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${c.env.DODO_API_KEY}`,
      },
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error("Dodo customer portal error:", errorBody);
      return c.json({ error: "Failed to create billing portal session" }, 502);
    }

    const portal = (await response.json()) as { link: string };
    return c.json({ data: { portalUrl: portal.link } });
  } catch (err) {
    return c.json({ error: "Failed to create billing portal session" }, 500);
  }
});

export default app;
