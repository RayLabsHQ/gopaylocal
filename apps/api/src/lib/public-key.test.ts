import { describe, expect, it } from "vitest";
import { SECRET_KEY_NOT_ALLOWED, SECRET_KEY_NOT_ALLOWED_JS, isSecretKey } from "./public-key";

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
  it.each([
    ["JSON body", SECRET_KEY_NOT_ALLOWED.error],
    ["script comment", SECRET_KEY_NOT_ALLOWED_JS],
  ])("the %s says the key is exposed and must be revoked and replaced", (_name, text) => {
    expect(text).toContain("Secret keys (gpl_sk_) must never be used in a browser.");
    expect(text).toContain("This key is now exposed");
    expect(text).toMatch(/revoke it in the dashboard/);
    expect(text).toMatch(/replace it with a new secret key/);
    expect(text).toContain("gpl_pk_");
  });

  it("the script comment is a single JavaScript line comment", () => {
    expect(SECRET_KEY_NOT_ALLOWED_JS.startsWith("// ")).toBe(true);
    expect(SECRET_KEY_NOT_ALLOWED_JS).not.toContain("\n");
    expect(SECRET_KEY_NOT_ALLOWED_JS.slice(3)).toBe(SECRET_KEY_NOT_ALLOWED.error);
  });
});
