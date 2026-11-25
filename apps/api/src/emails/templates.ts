// ── GoPayLocal's emails ─────────────────────────────────────────────────────
// Pure builders: each takes what the email says and returns its subject, HTML
// and plain text (./layout.ts). What they say must match the code: the limits
// come from PLAN_LIMITS and PLAN_PRICES_USD, the quota rule from
// lib/limits.ts (a UTC calendar month; at the limit the config endpoint answers
// quota_exceeded, so the banner shows no offer), the grace rule from
// lib/entitlements.ts (a failed or cancelled Pro keeps its limits until the
// paid period ends) and the invitation's lifetime from Better Auth's default
// (48 hours).

import { PLAN_LIMITS, PLAN_PRICES_USD } from "@gopaylocal/shared/constants";
import { button, callout, type Email, type EmailLinks, facts, layout, meter, note, para, steps } from "./layout";

/** A count or a plan limit (null = unlimited), as the emails write it. */
const n = (v: number | null) => (v === null ? "Unlimited" : v.toLocaleString("en-US"));

/** "1 December" (UTC), the way the emails write a day. */
export function emailDay(date: Date): string {
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "UTC" });
}

const FREE = PLAN_LIMITS.free;
const PRO_PRICE = `$${PLAN_PRICES_USD.pro.month}`;
const PRO_LINE = `Pro is ${PRO_PRICE} a month, less in many countries, with unlimited products and 20 million API calls a month.`;

function freeRows(): ReadonlyArray<readonly [string, string]> {
  return [
    ["Products", n(FREE.products)],
    ["API calls", `${n(FREE.apiHitsPerMonth)} a month`],
    ["Team members", n(FREE.teamMembers)],
    ["Analytics", `Last ${FREE.analyticsRetentionDays} days`],
    ["Banner", "Shows “Powered by GoPayLocal”"],
  ];
}

const billingUrl = (links: EmailLinks) => `${links.app}/dashboard/settings?tab=billing`;
/** Straight to Dodo's checkout for Pro, through sign-in if needed (dashboard routes/upgrade.tsx). */
const upgradeUrl = (links: EmailLinks) => `${links.app}/upgrade`;

// ── 1. Welcome ──────────────────────────────────────────────────────────────

export function welcomeEmail(input: { name: string | null; links: EmailLinks }): Email {
  const first = input.name?.trim().split(/\s+/)[0];
  return layout({
    subject: "Welcome to GoPayLocal",
    preheader: "Three steps to show every visitor a price that fits their country.",
    eyebrow: "Welcome",
    heading: "Show every visitor a price that fits their country",
    blocks: [
      para(
        `${first ? `Hi ${first}, thanks` : "Thanks"} for signing up. GoPayLocal works out where each visitor is and shows them their country's price on your site, before they reach checkout. Three steps get your first banner live:`,
      ),
      steps([
        {
          title: "Add your product",
          body: "Under **Products**, add it by hand or import it from the payment platform you connect.",
        },
        {
          title: "Create a campaign",
          body: "Choose how much each country gets off, and the payment platform that creates the codes.",
        },
        {
          title: "Add the banner to your site",
          body: "Paste one script tag with your public key, or use the React SDK.",
          code: '<script src="https://api.gopaylocal.com/v1/banner/script.js?key=YOUR_PUBLIC_KEY" async></script>',
        },
      ]),
      button("Open your dashboard", `${input.links.app}/dashboard`),
      facts("Your plan: Free", [
        ["Products", n(FREE.products)],
        ["API calls", `${n(FREE.apiHitsPerMonth)} a month`],
        ["Features", "All of them"],
      ]),
      para(`Every feature is on every plan, VPN detection and A/B tests included. ${PRO_LINE}`),
      ...(input.links.support ? [note(`Stuck on a step? Write to ${input.links.support} and a person will answer.`)] : []),
    ],
    reason: "You're getting this because you just created a GoPayLocal account.",
    links: input.links,
  });
}

// ── 2. Usage: 80% and 100% of a capped monthly quota ────────────────────────

export function usageWarningEmail(input: {
  workspace: string;
  used: number;
  limit: number;
  resetsOn: Date;
  links: EmailLinks;
}): Email {
  const { workspace, used, limit } = input;
  const pct = Math.floor((used / limit) * 100);
  return layout({
    subject: `${workspace} has used ${pct}% of this month's API calls`,
    preheader: `At ${n(limit)} the banner stops offering discounts until ${emailDay(input.resetsOn)}.`,
    eyebrow: "Usage",
    heading: `You've used ${pct}% of this month's API calls`,
    blocks: [
      meter(used, limit, `resets ${emailDay(input.resetsOn)}`),
      para(
        `**${workspace}** has made ${n(used)} of its ${n(limit)} API calls this month. An API call is one request for a visitor's offer, from the banner or an SDK.`,
      ),
      callout(
        `At ${n(limit)}, your banner stops offering discounts until the count resets on **${emailDay(input.resetsOn)}**. Your site keeps working; visitors just aren't shown their country's price.`,
      ),
      button("Upgrade to Pro", upgradeUrl(input.links)),
      note(PRO_LINE),
    ],
    reason: `You're getting this because you own ${workspace} on GoPayLocal. We send it once a month, at ${pct}%.`,
    links: input.links,
  });
}

export function usageLimitEmail(input: {
  workspace: string;
  limit: number;
  reachedOn: Date;
  resetsOn: Date;
  links: EmailLinks;
}): Email {
  const { workspace, limit } = input;
  return layout({
    subject: `${workspace}'s banner has stopped offering discounts`,
    preheader: `${workspace} reached ${n(limit)} API calls. Discounts resume on ${emailDay(input.resetsOn)}, or as soon as you upgrade.`,
    eyebrow: "Limit reached",
    heading: "Your banner has stopped offering discounts",
    blocks: [
      meter(limit, limit, `resets ${emailDay(input.resetsOn)}`),
      para(
        `**${workspace}** reached its ${n(limit)} API calls on ${emailDay(input.reachedOn)}. Until **${emailDay(input.resetsOn)}**, visitors see your site without a country price.`,
      ),
      callout(`Upgrading to Pro turns discounts back on within about ten minutes, with 20 million API calls a month.`),
      button("Upgrade to Pro", upgradeUrl(input.links)),
      note(`Pro is ${PRO_PRICE} a month, less in many countries.`),
    ],
    reason: `You're getting this because you own ${workspace} on GoPayLocal.`,
    links: input.links,
  });
}

// ── 3. Billing: a failed payment, and the end of Pro ────────────────────────

export function paymentFailedEmail(input: {
  workspace: string;
  /** "₹529" or "$19": what Dodo tried to charge; null when the event didn't say. */
  amount: string | null;
  /** When Pro ends unless the payment goes through; null when the paid period is already over. */
  proUntil: Date | null;
  links: EmailLinks;
}): Email {
  const { workspace, proUntil } = input;
  const charge = input.amount ? `**${input.amount}**` : "this month's payment";
  return layout({
    subject: "Your GoPayLocal payment didn't go through",
    preheader: proUntil
      ? `Pro stays on until ${emailDay(proUntil)}. Update your payment method to keep it.`
      : "Update your payment method to get Pro back.",
    eyebrow: "Billing",
    heading: "We couldn't take this month's payment for Pro",
    blocks: [
      para(
        `Dodo Payments, which bills GoPayLocal, couldn't charge ${charge} for Pro on **${workspace}**. Usually the card has expired, or the bank declined a payment from abroad.`,
      ),
      callout(
        proUntil
          ? `Pro stays on until **${emailDay(proUntil)}**. Update your payment method before then and nothing changes.`
          : `**${workspace}** is on the Free plan until the payment goes through. Update your payment method and Pro comes back once Dodo takes the payment.`,
      ),
      button("Update payment method", billingUrl(input.links)),
      facts(proUntil ? `On Free after ${emailDay(proUntil)}` : "Free, in the meantime", freeRows()),
      note("Nothing is deleted. Products and campaigns over Free's limits stay in your account for when Pro is back."),
    ],
    reason: `You're getting this because you own ${workspace} on GoPayLocal.`,
    links: input.links,
  });
}

export function proEndedEmail(input: { workspace: string; endedOn: Date; links: EmailLinks }): Email {
  const { workspace } = input;
  return layout({
    subject: `${workspace} is on the Free plan now`,
    preheader: `Pro ended on ${emailDay(input.endedOn)}. Here's what Free includes.`,
    eyebrow: "Billing",
    heading: `${workspace} is on the Free plan now`,
    blocks: [
      para(`Pro ended for **${workspace}** on ${emailDay(input.endedOn)}. Your banner keeps working on the Free plan:`),
      facts("Free", freeRows()),
      note("Nothing is deleted. Products and campaigns over Free's limits stay in your account for when Pro is back."),
      button("Get Pro again", upgradeUrl(input.links)),
      note(PRO_LINE),
    ],
    reason: `You're getting this because you own ${workspace} on GoPayLocal.`,
    links: input.links,
  });
}

// ── 4. A payment platform refuses the key ───────────────────────────────────

export function integrationKeyRefusedEmail(input: {
  workspace: string;
  /** "Stripe", "Paddle"... */
  platform: string;
  /** The platform's own error, one line. */
  platformMessage: string;
  /** When the platform last refused it. */
  seenOn: Date;
  links: EmailLinks;
}): Email {
  const { workspace, platform } = input;
  return layout({
    subject: `${platform} refused GoPayLocal's key for ${workspace}`,
    preheader: `New codes can't be created until you reconnect ${platform}.`,
    eyebrow: "Integration",
    heading: `Reconnect ${platform} to keep creating codes`,
    blocks: [
      para(
        `On ${emailDay(input.seenOn)}, ${platform} refused the key GoPayLocal uses for **${workspace}**. Usually the key was revoked or rolled, or its permissions changed.`,
      ),
      callout(`${platform} said: “${input.platformMessage}”`),
      para(
        `Codes already at ${platform} keep working at checkout. New ones can't be created, so a country you add, a changed discount or a new holiday deal gets no code until you reconnect.`,
      ),
      button(`Reconnect ${platform}`, `${input.links.app}/dashboard/integrations`),
      note("Connecting checks the new key with the platform before it replaces the old one."),
    ],
    reason: `You're getting this because you own ${workspace} on GoPayLocal.`,
    links: input.links,
  });
}

// ── 5. Team invitation ──────────────────────────────────────────────────────

export function invitationEmail(input: {
  /** null when the name can't be printed safely (lib/workspace-name.ts workspaceNameForEmail). */
  workspace: string | null;
  inviterName: string | null;
  inviterEmail: string;
  inviteUrl: string;
  links: EmailLinks;
}): Email {
  const { workspace } = input;
  const inviter = input.inviterName?.trim() || input.inviterEmail;
  const who = input.inviterName?.trim() ? `${input.inviterName.trim()} (${input.inviterEmail})` : input.inviterEmail;
  return layout({
    subject: workspace ? `${inviter} invited you to the ${workspace} workspace` : `${inviter} invited you to a workspace on GoPayLocal`,
    preheader: `Join ${workspace ?? "the workspace"} on GoPayLocal. The invitation is valid for 48 hours.`,
    eyebrow: "Invitation",
    heading: workspace ? `Join the ${workspace} workspace` : "Join a workspace on GoPayLocal",
    blocks: [
      para(
        `**${who}** invited you to work on country pricing for ${workspace ?? "their workspace"} in GoPayLocal: its campaigns, discounts and analytics.`,
      ),
      button("Accept invitation", input.inviteUrl),
      note("The invitation is valid for 48 hours. Sign in with this email address to accept it. Button not working? Open:", input.inviteUrl),
    ],
    reason: "If you didn't expect this invitation, you can ignore it: nothing happens unless you accept.",
    links: input.links,
  });
}
