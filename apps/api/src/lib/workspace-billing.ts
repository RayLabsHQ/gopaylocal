// ── Deleting a workspace that pays for Pro ──────────────────────────────────
//
// A deleted workspace must never keep being charged. Deleting a workspace does
// not cancel anything at Dodo; instead the delete is refused while the Dodo
// subscription is still set to renew, and the owner cancels it first under
// Settings > Billing > Manage Billing (Dodo's customer portal, where they pick
// "cancel now" or "cancel at the next billing date"). A subscription that is
// already cancelled, expired, or set to end at the period end does not block.
// Self-hosted deployments have no billing, so nothing blocks there.
//
// Our subscriptions row cannot tell "renews" from "set to end at the period
// end": Dodo keeps such a subscription `active` with
// `cancel_at_next_billing_date: true`, and routes/webhooks.ts does not store
// that flag. So whenever the row could still renew, Dodo is asked. Only an
// answer that positively says the subscription will not renew lets the delete
// go ahead; anything else (renewing, an unknown status, an error, a timeout)
// refuses it with nothing deleted. A failed check is a visible refusal, never
// a silent pass.
//
// Dodo docs:
//   GET /subscriptions/{id}  https://docs.dodopayments.com/api-reference/subscriptions/get-subscriptions
//   Customer portal cancel   https://docs.dodopayments.com/features/customer-portal

import type { Bindings } from "../bindings";
import { isSelfHosted } from "./entitlements";
import { errorSummary } from "./log";

/** The subscriptions columns the check reads. */
export interface SubscriptionForDelete {
  status: string;
  dodoSubId: string | null;
}

export type WorkspaceDeleteBillingCheck =
  | { ok: true }
  | {
      ok: false;
      status: 409 | 502;
      body: { error: string; code: "subscription_renews" | "billing_check_failed" };
    };

/**
 * Our row's statuses that come from Dodo saying the subscription is over or
 * will not renew (webhooks.ts: subscription.cancelled, subscription.expired).
 */
const ENDED_IN_OUR_ROW: ReadonlySet<string> = new Set(["canceled", "cancelled", "expired"]);

/** Dodo statuses after which nothing more is charged. */
const DODO_ENDED: ReadonlySet<string> = new Set(["cancelled", "expired", "failed"]);

const DODO_TIMEOUT_MS = 10_000;

export const BILLING_CHECK_FAILED_MESSAGE =
  "Could not confirm with Dodo Payments that this workspace's subscription won't renew, so nothing was deleted. Try again in a few minutes.";

function dodoApiBase(env: Pick<Bindings, "DODO_ENVIRONMENT">): string {
  return env.DODO_ENVIRONMENT === "test_mode"
    ? "https://test.dodopayments.com"
    : "https://live.dodopayments.com";
}

function checkFailed(): WorkspaceDeleteBillingCheck {
  return { ok: false, status: 502, body: { error: BILLING_CHECK_FAILED_MESSAGE, code: "billing_check_failed" } };
}

function renews(nextBillingDate: unknown): WorkspaceDeleteBillingCheck {
  const date = typeof nextBillingDate === "string" ? new Date(nextBillingDate) : null;
  const when = date && !Number.isNaN(date.getTime()) ? ` renews on ${date.toISOString().slice(0, 10)}` : " is set to renew";
  return {
    ok: false,
    status: 409,
    body: {
      error:
        `This workspace's Pro subscription${when}. Cancel it under Settings > Billing > Manage Billing, ` +
        "then delete the workspace. Nothing was deleted.",
      code: "subscription_renews",
    },
  };
}

/**
 * Whether deleting the workspace would leave a subscription that keeps
 * charging. Call it before deleting anything; on `ok: false` answer with its
 * status and body.
 */
export async function checkBillingAllowsWorkspaceDelete(
  env: Pick<Bindings, "SELF_HOSTED" | "DODO_API_KEY" | "DODO_ENVIRONMENT">,
  subscription: SubscriptionForDelete | null,
  orgId: string,
): Promise<WorkspaceDeleteBillingCheck> {
  if (isSelfHosted(env)) return { ok: true };
  if (!subscription) return { ok: true };
  if (ENDED_IN_OUR_ROW.has(subscription.status)) return { ok: true };

  if (!subscription.dodoSubId) {
    // Only the Dodo webhook writes subscription rows, and Dodo's subscription
    // payloads always carry the id, so there is no Dodo subscription to check
    // or cancel. Logged so a row like this is visible.
    console.warn("billing: workspace delete found a subscription row without a Dodo subscription id", {
      orgId,
      status: subscription.status,
    });
    return { ok: true };
  }

  if (!env.DODO_API_KEY) {
    console.error("billing: workspace delete cannot check the Dodo subscription: DODO_API_KEY is not set", { orgId });
    return checkFailed();
  }

  let body: { status?: unknown; cancel_at_next_billing_date?: unknown; next_billing_date?: unknown };
  try {
    const res = await fetch(
      `${dodoApiBase(env)}/subscriptions/${encodeURIComponent(subscription.dodoSubId)}`,
      {
        headers: { Authorization: `Bearer ${env.DODO_API_KEY}` },
        signal: AbortSignal.timeout(DODO_TIMEOUT_MS),
      },
    );
    if (!res.ok) {
      console.error("billing: Dodo refused the subscription lookup for a workspace delete", {
        orgId,
        status: res.status,
        body: (await res.text().catch(() => "")).slice(0, 500),
      });
      return checkFailed();
    }
    body = (await res.json()) as typeof body;
  } catch (err) {
    console.error("billing: Dodo subscription lookup failed for a workspace delete", {
      orgId,
      error: errorSummary(err),
    });
    return checkFailed();
  }

  if (typeof body?.status !== "string") {
    console.error("billing: Dodo subscription lookup returned no status", { orgId });
    return checkFailed();
  }
  if (DODO_ENDED.has(body.status) || body.cancel_at_next_billing_date === true) return { ok: true };
  return renews(body.next_billing_date);
}
