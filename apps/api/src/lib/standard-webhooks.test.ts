import { describe, it, expect } from "vitest";
import { verifyStandardWebhook } from "./standard-webhooks";

// ── test helpers ────────────────────────────────────────────────────────────
function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function sign(keyBytes: Uint8Array<ArrayBuffer>, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg)));
  return bytesToBase64(sig);
}
function nowTs(offset = 0): string {
  return String(Math.floor(Date.now() / 1000) + offset);
}

const id = "msg_2abc";
const body = JSON.stringify({ type: "payment.succeeded", data: { total_amount: 1000 } });

describe("verifyStandardWebhook — whsec mode (Dodo/Whop)", () => {
  const keyBytes = base64ToBytes("c2VjcmV0a2V5MTIzNDU2Nzg5MGFiY2RlZg==");
  const secret = "whsec_" + bytesToBase64(keyBytes);

  it("accepts a valid signature", async () => {
    const ts = nowTs();
    const sig = await sign(keyBytes, `${id}.${ts}.${body}`);
    expect(
      await verifyStandardWebhook(body, { id, timestamp: ts, signature: `v1,${sig}` }, secret, "whsec"),
    ).toBe(true);
  });

  it("rejects a tampered body", async () => {
    const ts = nowTs();
    const sig = await sign(keyBytes, `${id}.${ts}.${body}`);
    expect(
      await verifyStandardWebhook(body + "x", { id, timestamp: ts, signature: `v1,${sig}` }, secret, "whsec"),
    ).toBe(false);
  });

  it("rejects an expired timestamp (replay protection)", async () => {
    const ts = nowTs(-3600);
    const sig = await sign(keyBytes, `${id}.${ts}.${body}`);
    expect(
      await verifyStandardWebhook(body, { id, timestamp: ts, signature: `v1,${sig}` }, secret, "whsec"),
    ).toBe(false);
  });

  it("accepts when one of several space-separated signatures matches", async () => {
    const ts = nowTs();
    const sig = await sign(keyBytes, `${id}.${ts}.${body}`);
    expect(
      await verifyStandardWebhook(body, { id, timestamp: ts, signature: `v1,AAAAbadsig v1,${sig}` }, secret, "whsec"),
    ).toBe(true);
  });

  it("rejects a signature made with the wrong key", async () => {
    const ts = nowTs();
    const wrong = await sign(base64ToBytes("ZGlmZmVyZW50a2V5MDAwMDAwMDAwMA=="), `${id}.${ts}.${body}`);
    expect(
      await verifyStandardWebhook(body, { id, timestamp: ts, signature: `v1,${wrong}` }, secret, "whsec"),
    ).toBe(false);
  });

  it("rejects missing headers", async () => {
    expect(
      await verifyStandardWebhook(body, { id: undefined, timestamp: undefined, signature: undefined }, secret, "whsec"),
    ).toBe(false);
  });

  it("only accepts v1 tokens: a correct signature without the v1 prefix, or under another version, fails", async () => {
    // These used to pass: the version was ignored and a bare token was treated as the signature.
    const ts = nowTs();
    const sig = await sign(keyBytes, `${id}.${ts}.${body}`);
    for (const signature of [sig, `v2,${sig}`, `v1a,${sig}`, `,${sig}`, `V1,${sig}`]) {
      expect(await verifyStandardWebhook(body, { id, timestamp: ts, signature }, secret, "whsec")).toBe(false);
    }
    expect(await verifyStandardWebhook(body, { id, timestamp: ts, signature: `v1a,xyz v1,${sig}` }, secret, "whsec")).toBe(true);
  });
});

describe("verifyStandardWebhook — raw mode (Polar)", () => {
  const secret = "polar_signing_secret_xyz";
  const keyBytes = new TextEncoder().encode(secret) as Uint8Array<ArrayBuffer>;

  it("accepts a valid signature using the raw secret string as key", async () => {
    const ts = nowTs();
    const sig = await sign(keyBytes, `${id}.${ts}.${body}`);
    expect(
      await verifyStandardWebhook(body, { id, timestamp: ts, signature: `v1,${sig}` }, secret, "raw"),
    ).toBe(true);
  });

  it("rejects when verified with the wrong secret", async () => {
    const ts = nowTs();
    const sig = await sign(keyBytes, `${id}.${ts}.${body}`);
    expect(
      await verifyStandardWebhook(body, { id, timestamp: ts, signature: `v1,${sig}` }, "not_the_secret", "raw"),
    ).toBe(false);
  });
});
