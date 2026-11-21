// ── Standard Webhooks verification ──────────────────────────────────────────
// Implements the Standard Webhooks spec (https://www.standardwebhooks.com) used
// by Dodo Payments, Whop, and Polar. The pinned SDKs for these providers do not
// ship a Workers-compatible verifier, so we verify manually with Web Crypto.
//
// Signed content:  `${webhook-id}.${webhook-timestamp}.${rawBody}`
// Signature header: space-separated `version,base64sig` tokens (e.g. `v1,<b64>`).
// Algorithm:        HMAC-SHA256, base64-encoded signature.

export interface StandardWebhookHeaders {
  id: string | null | undefined; // webhook-id
  timestamp: string | null | undefined; // webhook-timestamp (unix seconds)
  signature: string | null | undefined; // webhook-signature
}

/**
 * How the configured secret maps to the raw HMAC key:
 *  - 'whsec'  → Dodo/Whop: secret is `whsec_<base64>`; strip the prefix and
 *               base64-decode the remainder to obtain the key bytes.
 *  - 'raw'    → Polar: the configured secret string is used as the key bytes
 *               directly (Polar's SDK base64-encodes it before handing it to the
 *               standardwebhooks lib, which base64-decodes it straight back).
 */
export type SecretMode = "whsec" | "raw";

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const bytes = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/**
 * Verify a Standard Webhooks signature. Returns true only if a provided
 * signature matches and the timestamp is within `toleranceSeconds` (replay
 * protection). Never throws — malformed input returns false.
 */
export async function verifyStandardWebhook(
  rawBody: string,
  headers: StandardWebhookHeaders,
  secret: string,
  secretMode: SecretMode = "whsec",
  toleranceSeconds = 300,
): Promise<boolean> {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > toleranceSeconds) return false;

  try {
    const keyBytes =
      secretMode === "raw"
        ? new TextEncoder().encode(secret)
        : base64ToBytes(secret.startsWith("whsec_") ? secret.slice(6) : secret);

    const key = await crypto.subtle.importKey(
      "raw",
      keyBytes,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );

    const signedContent = `${id}.${timestamp}.${rawBody}`;
    const expected = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedContent)),
    );

    // The header is a space-separated list of `version,base64sig` tokens.
    // Only `v1` (HMAC-SHA256) tokens are this scheme; anything else, including
    // a bare signature with no version, is skipped (the spec's reference
    // libraries do the same; `v1a` is the asymmetric scheme).
    for (const token of signature.split(" ")) {
      if (!token.startsWith("v1,")) continue;
      const sigPart = token.slice(3);
      try {
        if (timingSafeEqual(expected, base64ToBytes(sigPart))) return true;
      } catch {
        // malformed base64 token — skip it
      }
    }
    return false;
  } catch {
    return false;
  }
}
