import { describe, it, expect } from "vitest";
import { HOSTED_SENDER_ADDRESS, senderAddressFor } from "./email";

describe("senderAddressFor", () => {
  it("hosted with EMAIL_FROM unset keeps the hosted sender", () => {
    expect(senderAddressFor({})).toBe("DoNotReply@mail.gopaylocal.com");
    expect(senderAddressFor({ SELF_HOSTED: "false" })).toBe(HOSTED_SENDER_ADDRESS);
  });

  it("uses EMAIL_FROM when set, hosted or self-hosted", () => {
    expect(senderAddressFor({ EMAIL_FROM: " invites@mail.example.com " })).toBe("invites@mail.example.com");
    expect(senderAddressFor({ SELF_HOSTED: "true", EMAIL_FROM: "invites@mail.example.com" })).toBe("invites@mail.example.com");
  });

  it("self-hosted with EMAIL_FROM unset or blank has no sender (never the hosted one)", () => {
    expect(senderAddressFor({ SELF_HOSTED: "true" })).toBeNull();
    expect(senderAddressFor({ SELF_HOSTED: "true", EMAIL_FROM: "  " })).toBeNull();
  });
});
