// ── Secret masking + live-mode guard ────────────────────────────────────────
// Pure helpers: no I/O, so they are unit-tested directly.

import type { DetectedMode, Mode, ProviderProfile } from './profiles';

/**
 * Mask a secret for display. Short secrets are hidden entirely; longer ones
 * keep a short head (usually the non-secret type prefix, e.g. `sk_test_`) and
 * the last 4 characters, the way provider dashboards display keys.
 */
export function mask(value: string | null | undefined): string {
  if (value == null || value === '') return '(not set)';
  const n = value.length;
  if (n < 24) return `[hidden, ${n} chars]`;
  const head = value.slice(0, Math.min(8, Math.floor(n / 6)));
  return `${head}…${value.slice(-4)} [${n} chars]`;
}

/**
 * Replaces every known secret (and its common encodings) in output text with
 * its mask. All tool output passes through one Redactor, so a provider error
 * message that echoes a key never reaches the terminal or the JSON report.
 */
export class Redactor {
  private readonly secrets = new Map<string, string>(); // variant → mask

  add(secret: string | null | undefined): void {
    if (!secret || secret.length < 6) return;
    // A "key:secret" pair (WooCommerce ck_...:cs_...) can be echoed one half at
    // a time; each half gets its own variants. The whole pair, and HTTP Basic
    // base64("key:secret"), are covered below.
    const colon = secret.indexOf(':');
    if (colon > 0) {
      this.add(secret.slice(0, colon));
      this.add(secret.slice(colon + 1));
    }
    const masked = mask(secret);
    const variants = new Set<string>([secret, encodeURIComponent(secret)]);
    try {
      variants.add(btoa(secret));
      variants.add(btoa(`${secret}:`)); // HTTP Basic auth with the key as username (Chargebee)
    } catch {
      // non-Latin1 secret — btoa can't encode it; the raw form is still covered
    }
    for (const v of variants) if (v.length >= 6) this.secrets.set(v, masked);
  }

  redact(text: string): string {
    let out = text;
    // Longest first so a secret never gets partially replaced by a shorter variant.
    const entries = [...this.secrets.entries()].sort((a, b) => b[0].length - a[0].length);
    for (const [secret, masked] of entries) out = out.split(secret).join(masked);
    return out;
  }

  redactDeep<T>(value: T): T {
    if (typeof value === 'string') return this.redact(value) as T;
    if (Array.isArray(value)) return value.map((v) => this.redactDeep(v)) as T;
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = this.redactDeep(v);
      return out as T;
    }
    return value;
  }
}

// ── Live-mode guard ─────────────────────────────────────────────────────────

export interface ModeInput {
  provider: string;
  profile?: ProviderProfile;
  apiKey?: string;
  accountId?: string;
  /** --environment value (defaults to 'test'). */
  requested: Mode;
  /** Whether --environment was passed explicitly. */
  requestedExplicit: boolean;
  allowLive: boolean;
}

export interface ModeDecision {
  allowed: boolean;
  /** What the run will touch, as far as the tool can tell. */
  effective: DetectedMode;
  /** The value passed as ProviderConfig.environment. */
  providerEnvironment: Mode;
  /** How the mode was determined (always printed). */
  basis: string;
  /** Why the run is refused, when !allowed. */
  refusal?: string;
}

export function detectByPrefix(
  key: string | undefined,
  test: string[] = [],
  live: string[] = [],
): DetectedMode {
  if (!key) return 'unknown';
  if (test.some((p) => key.startsWith(p))) return 'test';
  if (live.some((p) => key.startsWith(p))) return 'live';
  return 'unknown';
}

/**
 * Decide whether a run may proceed. The rule: a run proceeds without
 * --allow-live only when the tool can positively establish that it targets a
 * test/sandbox environment. A contradiction between --environment and what the
 * credentials say is always refused (--allow-live doesn't override it): it
 * means the operator is mistaken about what they are pointing at.
 */
export function decideMode(input: ModeInput): ModeDecision {
  const { provider, profile, requested, requestedExplicit, allowLive } = input;
  const rule = profile?.mode;
  let effective: DetectedMode;
  let basis: string;
  let providerEnvironment: Mode = requested;

  const contradiction = (detected: Mode, how: string): ModeDecision => ({
    allowed: false,
    effective: detected,
    providerEnvironment: detected,
    basis: how,
    refusal:
      `The run targets ${requested.toUpperCase()} but ${how}. ` +
      (detected === 'live'
        ? 'If you really mean to use live credentials, pass --environment live --allow-live.'
        : 'Drop --environment live, or use live credentials.'),
  });

  if (!rule) {
    effective = requested === 'live' ? 'live' : 'unknown';
    basis =
      `no verification profile for '${provider}', so the tool cannot tell test credentials from live ones ` +
      `(add an entry to scripts/verify-provider/profiles.ts)`;
  } else {
    switch (rule.kind) {
      case 'key-prefix': {
        const d = detectByPrefix(input.apiKey, rule.test, rule.live);
        basis =
          d === 'unknown'
            ? `the API key has none of the known prefixes (${[...rule.test, ...rule.live].join(', ')})`
            : `the API key prefix marks it as a ${d.toUpperCase()} key`;
        if (requestedExplicit && d !== 'unknown' && d !== requested) return contradiction(d, basis);
        effective = d;
        providerEnvironment = d === 'live' ? 'live' : 'test';
        break;
      }
      case 'environment': {
        const d = detectByPrefix(input.apiKey, rule.test, rule.live);
        basis =
          `the provider targets its ${requested === 'live' ? 'live' : 'sandbox'} API because --environment is ${requested}` +
          (d === 'unknown' ? '' : `, and the key prefix marks it as a ${d.toUpperCase()} key`);
        if (d !== 'unknown' && d !== requested) {
          return contradiction(d, `the API key prefix marks it as a ${d.toUpperCase()} key`);
        }
        if (requested === 'live' && rule.accountTestSuffix && input.accountId?.endsWith(rule.accountTestSuffix)) {
          return contradiction('test', `the account id '${input.accountId}' is a test account (ends in '${rule.accountTestSuffix}')`);
        }
        effective = requested;
        break;
      }
      case 'account-suffix': {
        const d: DetectedMode = input.accountId?.endsWith(rule.testSuffix) ? 'test' : 'unknown';
        basis =
          d === 'test'
            ? `the account id '${input.accountId}' ends in '${rule.testSuffix}' (test-site naming)`
            : `the account id '${input.accountId ?? ''}' does not end in '${rule.testSuffix}', so it cannot be confirmed as a test site`;
        if (requestedExplicit && requested === 'live' && d === 'test') return contradiction('test', basis);
        effective = requestedExplicit && requested === 'live' ? 'live' : d;
        providerEnvironment = effective === 'test' ? 'test' : 'live';
        break;
      }
      case 'always-live': {
        basis = rule.reason;
        if (requestedExplicit && requested === 'test') {
          return {
            allowed: false,
            effective: 'live',
            providerEnvironment: 'live',
            basis,
            refusal: `--environment test cannot be honoured: ${rule.reason}. Pass --allow-live (without --environment test) if you accept that.`,
          };
        }
        effective = 'live';
        providerEnvironment = 'live';
        break;
      }
    }
  }

  if (effective === 'test') return { allowed: true, effective, providerEnvironment, basis };
  if (allowLive) return { allowed: true, effective, providerEnvironment, basis };
  return {
    allowed: false,
    effective,
    providerEnvironment,
    basis,
    refusal:
      effective === 'live'
        ? `Refusing to run against LIVE data: ${basis}. Re-run with --allow-live if you really mean to.`
        : `Refusing to run: cannot confirm these are test/sandbox credentials (${basis}). Re-run with --allow-live to accept that risk.`,
  };
}
