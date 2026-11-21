import { describe, it, expect } from "vitest";
import {
  hmacSha256Base64,
  hmacSha256Hex,
  timingSafeEqual,
  verifyPaddleSignature,
} from "./webhook-verify";

const secret = "ntfset_test_secret_abc123";
const body = JSON.stringify({ event_type: "transaction.completed", data: { id: "txn_1" } });

describe("webhook-verify: Paddle (ts:body HMAC hex)", () => {
  const nowTs = () => Math.floor(Date.now() / 1000).toString();

  it("accepts a valid signature within the window", async () => {
    const ts = nowTs();
    const h1 = await hmacSha256Hex(secret, `${ts}:${body}`);
    expect(await verifyPaddleSignature(body, `ts=${ts};h1=${h1}`, secret)).toBe(true);
  });
  it("ignores unknown header keys", async () => {
    const ts = nowTs();
    const h1 = await hmacSha256Hex(secret, `${ts}:${body}`);
    expect(await verifyPaddleSignature(body, `ts=${ts};h1=${h1};h2=ignored`, secret)).toBe(true);
  });
  it("rejects a tampered body", async () => {
    const ts = nowTs();
    const h1 = await hmacSha256Hex(secret, `${ts}:${body}`);
    expect(await verifyPaddleSignature(body + "x", `ts=${ts};h1=${h1}`, secret)).toBe(false);
  });
  it("rejects an expired timestamp", async () => {
    const ts = (Math.floor(Date.now() / 1000) - 10_000).toString();
    const h1 = await hmacSha256Hex(secret, `${ts}:${body}`);
    expect(await verifyPaddleSignature(body, `ts=${ts};h1=${h1}`, secret)).toBe(false);
  });
  it("rejects a signature computed without the timestamp prefix", async () => {
    // Guards against signing the bare body instead of `${ts}:${body}`.
    const ts = nowTs();
    const wrong = await hmacSha256Hex(secret, body);
    expect(await verifyPaddleSignature(body, `ts=${ts};h1=${wrong}`, secret)).toBe(false);
  });
  it("accepts a header with several h1 values when any one matches (secret rotation)", async () => {
    // Only the last h1 used to be checked, so a rotation header failed when the
    // matching signature came first.
    const ts = nowTs();
    const h1 = await hmacSha256Hex(secret, `${ts}:${body}`);
    const other = await hmacSha256Hex("ntfset_previous_secret", `${ts}:${body}`);
    expect(await verifyPaddleSignature(body, `ts=${ts};h1=${h1};h1=${other}`, secret)).toBe(true);
    expect(await verifyPaddleSignature(body, `ts=${ts};h1=${other};h1=${h1}`, secret)).toBe(true);
    expect(await verifyPaddleSignature(body, `ts=${ts};h1=${other};h1=${other}`, secret)).toBe(false);
  });
  it("rejects malformed / missing headers", async () => {
    expect(await verifyPaddleSignature(body, null, secret)).toBe(false);
    expect(await verifyPaddleSignature(body, "h1=abc", secret)).toBe(false);
    expect(await verifyPaddleSignature(body, "ts=abc;h1=def", secret)).toBe(false);
  });
});

describe("timingSafeEqual", () => {
  it("matches equal strings and rejects differences/lengths", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "ab")).toBe(false);
  });
});

describe("webhook-verify: hmacSha256Base64", () => {
  it("matches RFC 4231 test case 2 in standard base64, and the hex helper byte for byte", async () => {
    const msg = "what do ya want for nothing?";
    expect(await hmacSha256Base64("Jefe", msg)).toBe("W9zBRr9gdU5qBCQmCJV1x1oAPwidJzmDnexYuWTsOEM=");
    const hex = await hmacSha256Hex("Jefe", msg);
    expect(Buffer.from(await hmacSha256Base64("Jefe", msg), "base64").toString("hex")).toBe(hex);
  });
});
