// ── Webhook signature helpers (WebCrypto) ───────────────────────────────────
// Hand-rolled HMAC verification for providers whose SDK validators use
// node:crypto (unavailable on Cloudflare Workers): Paddle.
// Standard Webhooks providers (Dodo/Whop/Polar) use lib/standard-webhooks.ts.

const encoder = new TextEncoder();

async function hmacSha256(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return new Uint8Array(sig);
}

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/** HMAC-SHA256 of `message` keyed with `secret`, lowercase hex. */
export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  return toHex(await hmacSha256(secret, message));
}

/** HMAC-SHA256 of `message` keyed with `secret`, standard base64 (WooCommerce X-WC-Webhook-Signature). */
export async function hmacSha256Base64(secret: string, message: string): Promise<string> {
  let bin = "";
  for (const b of await hmacSha256(secret, message)) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Constant-time string comparison (avoids leaking position of first mismatch). */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

/**
 * Paddle: the `Paddle-Signature` header is `ts=<unixSeconds>;h1=<hexHmac>` where
 * the HMAC-SHA256 (hex) is computed over `${ts}:${rawBody}`. While a secret is
 * being rotated the header carries one `h1` per active secret, so every `h1`
 * is checked and any match passes. Rejects timestamps outside the tolerance
 * window (the SDK's own 5s window is too tight for retries).
 */
export async function verifyPaddleSignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  secret: string,
  toleranceSeconds = 300,
): Promise<boolean> {
  if (!signatureHeader) return false;

  let ts: string | undefined;
  const h1s: string[] = [];
  for (const part of signatureHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === "ts") ts = v;
    else if (k === "h1" && v) h1s.push(v.toLowerCase());
  }
  if (!ts || h1s.length === 0) return false;

  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) return false;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - tsNum) > toleranceSeconds) return false;

  const expected = await hmacSha256Hex(secret, `${ts}:${rawBody}`);
  let match = false;
  for (const h1 of h1s) match = timingSafeEqual(expected, h1) || match; // check all, no early exit
  return match;
}
