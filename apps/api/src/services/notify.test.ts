import { describe, expect, it, vi } from "vitest";

const sent = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock("../lib/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/email")>()),
  sendEmail: async (_conn: string, options: Record<string, unknown>) => {
    sent.push(options);
  },
}));

import { emailSetupProblem, formatCharge, mailerFor, quietly, usageEmailDue } from "./notify";
import { welcomeEmail } from "../emails/templates";

const ACS = "endpoint=https://acs.example.com/;accesskey=FAKE";

describe("usageEmailDue", () => {
  it("80 from 80% of the limit, 100 at the limit, nothing without one", () => {
    expect(usageEmailDue(7_999, 10_000)).toBeNull();
    expect(usageEmailDue(8_000, 10_000)).toBe(80);
    expect(usageEmailDue(9_999, 10_000)).toBe(80);
    expect(usageEmailDue(10_000, 10_000)).toBe(100);
    expect(usageEmailDue(25_000, 10_000)).toBe(100);
    expect(usageEmailDue(25_000_000, null)).toBeNull();
    expect(usageEmailDue(5, 0)).toBeNull();
  });
});

describe("formatCharge", () => {
  it("prints minor units in the charge's currency, without empty decimals", () => {
    expect(formatCharge(52_900, "INR")).toBe("₹529");
    expect(formatCharge(1_900, "USD")).toBe("$19");
    expect(formatCharge(1_950, "USD")).toBe("$19.50");
    expect(formatCharge(2_500, "JPY")).toBe("¥2,500");
  });
});

describe("mailerFor", () => {
  it("hosted: the hosted sender and dashboard, replies to support", async () => {
    const mailer = mailerFor({ ACS_CONNECTION_STRING: ACS, SELF_HOSTED: "false" });
    expect(mailer?.links).toEqual({ app: "https://app.gopaylocal.com", support: "support@gopaylocal.com" });
    sent.length = 0;
    await mailer!.send("owner@example.test", welcomeEmail({ name: null, links: mailer!.links }));
    expect(sent).toEqual([
      expect.objectContaining({
        to: "owner@example.test",
        senderAddress: "DoNotReply@mail.gopaylocal.com",
        replyTo: "support@gopaylocal.com",
        subject: "Welcome to GoPayLocal",
        text: expect.any(String),
      }),
    ]);
  });

  it("self-hosted: only with EMAIL_FROM and APP_BASE_URL; SUPPORT_EMAIL is optional", () => {
    const base = { ACS_CONNECTION_STRING: ACS, SELF_HOSTED: "true" };
    expect(mailerFor(base)).toBeNull();
    expect(mailerFor({ ...base, EMAIL_FROM: "mail@example.com" })).toBeNull();
    expect(mailerFor({ ...base, APP_BASE_URL: "https://app.example.com" })).toBeNull();
    expect(mailerFor({ ...base, EMAIL_FROM: "mail@example.com", APP_BASE_URL: "https://app.example.com" })?.links).toEqual({
      app: "https://app.example.com",
      support: null,
    });
    expect(
      mailerFor({ ...base, EMAIL_FROM: "mail@example.com", APP_BASE_URL: "https://app.example.com", SUPPORT_EMAIL: "help@example.com" })
        ?.links.support,
    ).toBe("help@example.com");
  });

  it("no ACS connection string: no mailer, and the reason names the setting", () => {
    expect(mailerFor({ SELF_HOSTED: "false" })).toBeNull();
    expect(emailSetupProblem({ SELF_HOSTED: "false" })).toContain("ACS_CONNECTION_STRING");
    expect(emailSetupProblem({ ACS_CONNECTION_STRING: ACS, SELF_HOSTED: "true" })).toContain("APP_BASE_URL");
    expect(emailSetupProblem({ ACS_CONNECTION_STRING: ACS, SELF_HOSTED: "true", APP_BASE_URL: "https://app.example.com" })).toContain(
      "EMAIL_FROM",
    );
  });
});

describe("quietly", () => {
  it("logs a failure instead of throwing it", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(quietly("test email", async () => Promise.reject(new Error("ACS down")))).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith("[email] test email failed", expect.anything());
    error.mockRestore();
  });
});
