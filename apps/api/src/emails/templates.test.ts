import { describe, expect, it } from "vitest";
import { PLAN_LIMITS } from "@gopaylocal/shared/constants";
import {
  emailDay,
  integrationKeyRefusedEmail,
  invitationEmail,
  paymentFailedEmail,
  proEndedEmail,
  usageLimitEmail,
  usageWarningEmail,
  welcomeEmail,
} from "./templates";

const hosted = { app: "https://app.gopaylocal.com", support: "support@gopaylocal.com" };
const selfHosted = { app: "https://app.example.com", support: null };
const EVIL = `Acme <a href="https://evil.example">Verify</a>`;
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);
/** The visible text of the HTML part, tags removed. */
const visible = (html: string) => html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ");

describe("email templates", () => {
  it("every email escapes a workspace name and carries a plain-text part", () => {
    const emails = [
      usageWarningEmail({ workspace: EVIL, used: 8_100, limit: 10_000, resetsOn: day("2026-12-01"), links: hosted }),
      usageLimitEmail({ workspace: EVIL, limit: 10_000, reachedOn: day("2026-11-20"), resetsOn: day("2026-12-01"), links: hosted }),
      paymentFailedEmail({ workspace: EVIL, amount: "₹529", proUntil: day("2026-12-03"), links: hosted }),
      proEndedEmail({ workspace: EVIL, endedOn: day("2026-11-24"), links: hosted }),
      integrationKeyRefusedEmail({ workspace: EVIL, platform: "Stripe", platformMessage: "<b>Invalid</b>", seenOn: day("2026-11-24"), links: hosted }),
      invitationEmail({ workspace: EVIL, inviterName: "<img src=x>", inviterEmail: "a@example.test", inviteUrl: "https://app.gopaylocal.com/invite/1", links: hosted }),
    ];
    for (const email of emails) {
      expect(email.html).not.toContain('<a href="https://evil.example"');
      expect(email.html).not.toContain("<img src=x>");
      expect(email.html).not.toContain("<b>Invalid</b>");
      // Plain text is never rendered, so it carries the name as typed, and no markup of its own.
      expect(email.text.length).toBeGreaterThan(50);
      expect(email.text).not.toMatch(/<(table|td|p|strong|span|div)\b/);
    }
  });

  it("usage emails use Free's limit and send to checkout", () => {
    const warning = usageWarningEmail({ workspace: "Acme", used: 8_000, limit: 10_000, resetsOn: day("2026-12-01"), links: hosted });
    expect(warning.subject).toBe("Acme has used 80% of this month's API calls");
    expect(warning.html).toContain('href="https://app.gopaylocal.com/upgrade"');
    expect(warning.html).toContain("1 December");
    const limit = usageLimitEmail({ workspace: "Acme", limit: 10_000, reachedOn: day("2026-11-20"), resetsOn: day("2026-12-01"), links: hosted });
    expect(limit.subject).toBe("Acme's banner has stopped offering discounts");
    expect(limit.html).toContain('href="https://app.gopaylocal.com/upgrade"');
    expect(proEndedEmail({ workspace: "Acme", endedOn: day("2026-11-24"), links: hosted }).html).toContain(
      'href="https://app.gopaylocal.com/upgrade"',
    );
  });

  it("the payment-failed email works without an amount, and says Free when the paid period is over", () => {
    const grace = paymentFailedEmail({ workspace: "Acme", amount: "₹529", proUntil: day("2026-12-03"), links: hosted });
    expect(grace.html).toMatch(/<strong[^>]*>₹529<\/strong>/);
    expect(visible(grace.html)).toContain("Pro stays on until 3 December");
    expect(grace.html).toContain('href="https://app.gopaylocal.com/dashboard/settings?tab=billing"');

    const over = paymentFailedEmail({ workspace: "Acme", amount: null, proUntil: null, links: hosted });
    expect(over.text).toContain("couldn't charge this month's payment");
    expect(over.text).toContain("is on the Free plan until the payment goes through");
    expect(over.text).not.toContain("Pro stays on");
  });

  it("the invitation says 'a workspace' when the name can't be printed", () => {
    const email = invitationEmail({
      workspace: null,
      inviterName: "Owner",
      inviterEmail: "owner@example.test",
      inviteUrl: "https://app.gopaylocal.com/invite/inv_1",
      links: hosted,
    });
    expect(email.subject).toBe("You've been invited to a workspace on GoPayLocal");
    expect(email.html).toContain("Join a workspace on GoPayLocal");
    expect(email.text).toContain("https://app.gopaylocal.com/invite/inv_1");
  });

  it("the welcome email states Free's limits from the plan constants", () => {
    const email = welcomeEmail({ name: "Ada Lovelace", links: hosted });
    expect(email.text).toContain("Hi Ada, thanks");
    expect(email.html).toContain(PLAN_LIMITS.free.apiHitsPerMonth!.toLocaleString("en-US"));
    expect(email.html).toContain("support@gopaylocal.com");
    expect(welcomeEmail({ name: null, links: hosted }).text).toContain("Thanks for signing up");
  });

  it("a self-hosted deployment's links never point at gopaylocal.com's dashboard or support address", () => {
    const email = integrationKeyRefusedEmail({
      workspace: "Acme",
      platform: "Stripe",
      platformMessage: "Invalid API key",
      seenOn: day("2026-11-24"),
      links: selfHosted,
    });
    expect(email.html).toContain('href="https://app.example.com/dashboard/integrations"');
    expect(email.html).not.toContain("app.gopaylocal.com");
    expect(email.html).not.toContain("support@gopaylocal.com");
  });

  it("days are written in UTC", () => {
    expect(emailDay(new Date("2026-11-30T23:30:00Z"))).toBe("30 November");
    expect(emailDay(new Date("2026-12-01T00:00:00Z"))).toBe("1 December");
  });
});
