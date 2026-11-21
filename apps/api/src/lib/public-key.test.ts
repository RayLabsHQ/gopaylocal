import { describe, expect, it } from "vitest";
import { SECRET_KEY_NOT_ALLOWED, isSecretKey } from "./public-key";

describe("isSecretKey", () => {
  it.each([
    ["gpl_sk_abc", true],
    ["  GPL_SK_abc", true],
    ["gpl_pk_abc", false],
    ["", false],
    [null, false],
    [undefined, false],
  ])("%s -> %s", (value, expected) => {
    expect(isSecretKey(value)).toBe(expected);
  });
});

describe("the refusal text", () => {
  // Security review L5: the developer must learn that the key is compromised,
  // not only that it was the wrong kind of key. Nothing is revoked automatically.
  // (The banner logs the same text in the browser: packages/banner/src/index.test.ts.)
  it("says the key is exposed and must be revoked and replaced", () => {
    const text = SECRET_KEY_NOT_ALLOWED.error;
    expect(text).toContain("Secret keys (gpl_sk_) must never be used in a browser.");
    expect(text).toContain("This key is now exposed");
    expect(text).toMatch(/revoke it in the dashboard/);
    expect(text).toMatch(/replace it with a new secret key/);
    expect(text).toContain("gpl_pk_");
  });
});
