import { describe, it, expect } from "vitest";
import { encrypt, decrypt, tokenEncryptionSecret } from "./crypto";

// Reproduce the LEGACY on-disk format (iv(12) || ciphertext, fixed
// 'gopaylocal-v1' salt) to prove tokens encrypted before per-record salts still
// decrypt. A regression here would break every existing provider integration.
async function legacyEncrypt(plaintext: string, secret: string): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: new TextEncoder().encode("gopaylocal-v1"), iterations: 100000, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext)),
  );
  const combined = new Uint8Array(iv.length + ct.length);
  combined.set(iv);
  combined.set(ct, iv.length);
  return btoa(String.fromCharCode(...combined));
}

describe("token crypto", () => {
  const secret = "test-secret-key-123";

  it("round-trips encrypt -> decrypt", async () => {
    const token = "gpl_sk_live_abc123";
    expect(await decrypt(await encrypt(token, secret), secret)).toBe(token);
  });

  it("uses a random per-record salt (same plaintext -> different ciphertext)", async () => {
    const a = await encrypt("same", secret);
    const b = await encrypt("same", secret);
    expect(a).not.toBe(b);
    expect(await decrypt(a, secret)).toBe("same");
    expect(await decrypt(b, secret)).toBe("same");
  });

  it("still decrypts legacy fixed-salt ciphertext (backward compatibility)", async () => {
    const legacy = await legacyEncrypt("legacy_token", secret);
    expect(await decrypt(legacy, secret)).toBe("legacy_token");
  });

  it("fails to decrypt with the wrong secret", async () => {
    const enc = await encrypt("secret-data", secret);
    await expect(decrypt(enc, "wrong-secret")).rejects.toBeDefined();
  });
});

describe("tokenEncryptionSecret", () => {
  it("prefers TOKEN_ENCRYPTION_KEY, falls back to BETTER_AUTH_SECRET", () => {
    expect(
      tokenEncryptionSecret({ TOKEN_ENCRYPTION_KEY: "dedicated", BETTER_AUTH_SECRET: "auth" } as any),
    ).toBe("dedicated");
    expect(tokenEncryptionSecret({ BETTER_AUTH_SECRET: "auth" } as any)).toBe("auth");
  });
});
