import { API_KEY_PREFIX_SECRET } from "@gopaylocal/shared/constants";

// The public endpoints (banner config, banner script, POST /v1/events) take a
// public key (gpl_pk_), which is safe in a page. A secret key (gpl_sk_) pasted
// there instead is refused before anything uses it: no rate-limiter key, KV read
// or database lookup is built from it, it is never echoed into a response, and
// it is never logged. The check is on the prefix only (case-insensitive, leading
// whitespace ignored), so it costs nothing and needs no lookup.
// The key is not revoked automatically: the message tells the developer that it
// has been exposed and must be revoked and replaced.

const SECRET_PREFIX_RE = new RegExp(`^\\s*${API_KEY_PREFIX_SECRET}`, "i");

/** True when `value` looks like a secret API key. */
export function isSecretKey(value: string | null | undefined): boolean {
  return typeof value === "string" && SECRET_PREFIX_RE.test(value);
}

/** The JSON body for a secret key on a public endpoint (sent with 401). */
export const SECRET_KEY_NOT_ALLOWED = {
  error: "Secret keys (gpl_sk_) must never be used in a browser. This key is now exposed: revoke it in the dashboard, replace it with a new secret key on your server, and use your public key (gpl_pk_) here.",
  code: "secret_key_not_allowed",
} as const;

/** The JavaScript comment body for a secret key on the banner script (sent with 400). */
export const SECRET_KEY_NOT_ALLOWED_JS =
  "// Secret keys (gpl_sk_) must never be used in a browser. This key is now exposed: revoke it in the dashboard, replace it with a new secret key on your server, and use your public key (gpl_pk_) here.";
