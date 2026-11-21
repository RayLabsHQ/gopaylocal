// ── Token encryption (AES-GCM) ──────────────────────────────────────────────
// Encrypts provider OAuth/access tokens at rest. Each ciphertext carries its own
// random PBKDF2 salt (so identical plaintexts under the same key produce
// unrelated keys/ciphertexts), and the key should come from a DEDICATED secret
// (TOKEN_ENCRYPTION_KEY) rather than the auth signing secret — see
// tokenEncryptionSecret().
//
// Format (v1, base64-encoded):  0x01 | salt(16) | iv(12) | ciphertext+tag
// Legacy format (pre-salt):     iv(12) | ciphertext+tag, derived with a fixed
//   salt. decrypt() transparently falls back to it so existing tokens keep
//   working; they are upgraded to the new format the next time they're written.

import type { Bindings } from "../bindings";

const ALGORITHM = "AES-GCM";
const LEGACY_SALT = "gopaylocal-v1";
const VERSION_V1 = 0x01;
const SALT_LEN = 16;
const IV_LEN = 12;

/**
 * The secret used to derive the token-encryption key. Prefer a dedicated
 * TOKEN_ENCRYPTION_KEY so it can be rotated independently of the auth secret;
 * fall back to BETTER_AUTH_SECRET when it isn't provisioned (keeps existing
 * deployments and already-encrypted tokens working).
 */
export function tokenEncryptionSecret(
  env: Pick<Bindings, "TOKEN_ENCRYPTION_KEY" | "BETTER_AUTH_SECRET">,
): string {
  return env.TOKEN_ENCRYPTION_KEY ?? env.BETTER_AUTH_SECRET;
}

async function deriveKey(secret: string, salt: Uint8Array): Promise<CryptoKey> {
  // Normalize to a fresh ArrayBuffer-backed view (salt may arrive as a subarray
  // view typed Uint8Array<ArrayBufferLike>, which WebCrypto's BufferSource rejects).
  const saltBytes = new Uint8Array(salt);
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: saltBytes, iterations: 100000, hash: "SHA-256" },
    keyMaterial,
    { name: ALGORITHM, length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encrypt(plaintext: string, secret: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const key = await deriveKey(secret, salt);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: ALGORITHM, iv }, key, new TextEncoder().encode(plaintext)),
  );

  const combined = new Uint8Array(1 + SALT_LEN + IV_LEN + ciphertext.length);
  combined[0] = VERSION_V1;
  combined.set(salt, 1);
  combined.set(iv, 1 + SALT_LEN);
  combined.set(ciphertext, 1 + SALT_LEN + IV_LEN);
  return btoa(String.fromCharCode(...combined));
}

export async function decrypt(encrypted: string, secret: string): Promise<string> {
  const combined = Uint8Array.from(atob(encrypted), (ch) => ch.charCodeAt(0));

  // Versioned format with a per-record salt.
  if (combined[0] === VERSION_V1 && combined.length > 1 + SALT_LEN + IV_LEN) {
    try {
      const salt = combined.slice(1, 1 + SALT_LEN);
      const iv = combined.slice(1 + SALT_LEN, 1 + SALT_LEN + IV_LEN);
      const ciphertext = combined.slice(1 + SALT_LEN + IV_LEN);
      const key = await deriveKey(secret, salt);
      const decrypted = await crypto.subtle.decrypt({ name: ALGORITHM, iv }, key, ciphertext);
      return new TextDecoder().decode(decrypted);
    } catch {
      // Not actually v1 (or wrong key) — fall through to the legacy scheme.
    }
  }

  // Legacy format: iv(12) || ciphertext, fixed salt.
  const iv = combined.slice(0, IV_LEN);
  const ciphertext = combined.slice(IV_LEN);
  const key = await deriveKey(secret, new TextEncoder().encode(LEGACY_SALT));
  const decrypted = await crypto.subtle.decrypt({ name: ALGORITHM, iv }, key, ciphertext);
  return new TextDecoder().decode(decrypted);
}
