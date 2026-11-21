export type Bindings = {
  HYPERDRIVE: Hyperdrive;
  CACHE: KVNamespace;
  VPN_DATA: KVNamespace;
  BETTER_AUTH_SECRET: string;
  // Dedicated key for encrypting provider tokens at rest. Falls back to
  // BETTER_AUTH_SECRET when unset (see lib/crypto.tokenEncryptionSecret).
  TOKEN_ENCRYPTION_KEY?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  DODO_API_KEY: string;
  DODO_WEBHOOK_SECRET: string;
  DODO_ENVIRONMENT?: "test_mode" | "live_mode";
  API_BASE_URL?: string;
  APP_BASE_URL?: string;
  ADMIN_BASE_URL?: string;
  CORS_ALLOWED_ORIGINS?: string; // extra comma-separated origins allowed credentialed CORS (see middleware/cors.ts)
  ACS_CONNECTION_STRING?: string;
  // Sender for invitation emails, on a domain linked to the ACS resource. Unset:
  // the hosted sender when hosted; when SELF_HOSTED="true", no email is sent
  // (lib/email.ts senderAddressFor).
  EMAIL_FROM?: string;
  // Dodo product ids for the one paid plan (Pro: $19/month, $180/year).
  DODO_PRICE_ID_PRO_MONTHLY?: string;
  DODO_PRICE_ID_PRO_ANNUAL?: string;
  // "true" = self-hosted deployment: every org is unlimited with branding off,
  // billing endpoints return 404 billing_disabled. Anything else = hosted.
  // Resolved only through lib/entitlements.ts (isSelfHosted / resolveEntitlements).
  SELF_HOSTED?: string;
  // Exchange rates for local prices (services/fx-refresh.service.ts, the
  // "40 */6 * * *" cron). Unset: the built-in sources. "off" on FX_RATES_URL
  // turns conversion off (exact prices in the product's currency); "off" on the
  // fallback turns off the cross-check. FX_EXCLUDED_CURRENCIES: comma-separated
  // codes that are never converted.
  FX_RATES_URL?: string;
  FX_RATES_FALLBACK_URL?: string;
  FX_EXCLUDED_CURRENCIES?: string;

  // ── Native Workers Rate Limiting bindings (per-colo) ──────────────────────
  // OPTIONAL on purpose: in local dev and unit tests the binding is not present,
  // and the rate-limit helper fails OPEN when it's undefined (see lib/rate-limit.ts).
  // Typing them optional means tests/local never break for lack of a limiter.
  // Configured in wrangler.toml as [[ratelimits]] stanzas.

  // Banner hot path, per client IP — generous (every visitor pageview hits it).
  RL_BANNER_IP?: RateLimit;
  // Banner DB-fallback for UNKNOWN keys, per client IP — tight; guards Postgres
  // from a flood of distinct invalid keys that bypass the negative cache.
  RL_BANNER_MISS_IP?: RateLimit;
  // POST /v1/events, per API key — sized for legitimate batching.
  RL_EVENTS_KEY?: RateLimit;
  // POST /v1/events, per client IP — backstop when key is missing/invalid.
  RL_EVENTS_IP?: RateLimit;
  // Auth POST (sign-in/up/credentials), per IP — tight (credential stuffing).
  RL_AUTH_POST_IP?: RateLimit;
  // Auth GET (get-session polling, OAuth callbacks), per IP — loose.
  RL_AUTH_GET_IP?: RateLimit;
  // Gumroad sale pings, per integration (each ping costs a sale read-back).
  RL_GUMROAD_PING?: RateLimit;
  // Management API requests made with a secret key, per key (after the key is found).
  RL_API_KEY?: RateLimit;
  // Secret-key lookups that found no key (unknown or revoked), per IP — tight;
  // bounds the database reads a wrong key can cost (middleware/api-key.ts).
  RL_API_KEY_FAIL_IP?: RateLimit;
};

/** The secret API key a /v1/teams or /v1/me request authenticated with (middleware/api-key.ts). */
export interface ApiKeyPrincipal {
  id: string;
  name: string;
  keyPrefix: string;
  createdAt: Date;
  organizationId: string;
  organizationName: string;
}

export type AppEnv = {
  Bindings: Bindings;
  Variables: {
    // A session request sets user, session and memberRole; a secret-key
    // request sets only apiKey. Never both.
    user: any;
    session: any;
    memberRole?: string; // 'owner' | 'admin' | 'member'
    apiKey?: ApiKeyPrincipal;
  };
};
