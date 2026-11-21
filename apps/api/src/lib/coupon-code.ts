// ── Coupon code generation ──────────────────────────────────────────────────
// The one generator for every code GoPayLocal creates at a provider: banner
// coupons and the codes of holiday deals (services/coupon.service.ts), and the
// verify tool's throwaway codes (scripts/verify-provider/code.ts). No imports,
// so the Node-run script can load it directly.
//
// Provider code-format constraints (official docs):
//  - Paddle: ^[a-zA-Z0-9]{1,32}$
//  - Polar: alphanumeric only
//  - Stripe: promotion code `code` accepts a-z, A-Z, 0-9 and, since the endive
//    API versions, dashes (POST /v1/promotion_codes). Codes stay dash-free so they
//    match what Stripe stored before the upgrade; see normalizeStripeCode in providers/stripe.ts.
//  - Creem: charset undocumented (docs.creem.io); alphanumeric is the safe subset
//    until a live run shows hyphens work (a rejected code fails every country)
//  - Dodo: at most 16 characters
//  - Chargebee, Gumroad, Whop: accept hyphens
//  - WooCommerce: accepts hyphens ("letters, numbers, and special characters
//    (such as &, $, -, or @)", woocommerce.com/document/coupon-management/)
// The generated code is what the banner displays (and what the duplicate check
// compares), so format rules apply here, not only in the adapters.

export const ALNUM_ONLY_PROVIDERS: ReadonlySet<string> = new Set(['creem', 'paddle', 'polar', 'stripe']);
export const CODE_MAX_LENGTH: Readonly<Record<string, number>> = { dodopayments: 16, paddle: 32 };

// A purely deterministic {PREFIX}-{CC}-{PCT} stem lets anyone enumerate other
// countries' discounts at checkout ("try PPP-IN-65"), so every code carries a
// random suffix. Charset drops 0/O/1/I/L so codes stay typable from a banner.
export const SUFFIX_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const SUFFIX_LENGTH = 4;

export type RandomBytes = (n: number) => Uint8Array;

const defaultRandomBytes: RandomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));

function randomCodeSuffix(randomBytes: RandomBytes): string {
  let out = '';
  while (out.length < SUFFIX_LENGTH) {
    const bytes = randomBytes(SUFFIX_LENGTH * 2);
    for (const b of bytes) {
      // Rejection sampling: 248 = 31 * 8, so `% 31` stays unbiased.
      if (b >= 248) continue;
      out += SUFFIX_CHARS[b % SUFFIX_CHARS.length];
      if (out.length === SUFFIX_LENGTH) break;
    }
  }
  return out;
}

/**
 * Generate a coupon code from prefix, country, and discount, plus a random
 * suffix so knowing one country's code doesn't let a visitor guess another's.
 * Format: {PREFIX}-{COUNTRY}{DISCOUNT}-{RANDOM} (separators dropped for
 * providers that only accept alphanumeric codes).
 * Example: PPP-IN40-K7QX (Chargebee), PPPIN40K7QX (Stripe/Polar/Paddle/Creem)
 */
export function generateCouponCode(
  countryCode: string,
  discountPercent: number,
  prefix?: string | null,
  provider?: string,
  randomBytes: RandomBytes = defaultRandomBytes,
): string {
  const alnumOnly = provider ? ALNUM_ONLY_PROVIDERS.has(provider) : false;
  const sep = alnumOnly ? '' : '-';
  const stem = `${countryCode.toUpperCase()}${Math.round(discountPercent)}`;
  const rand = randomCodeSuffix(randomBytes);
  let prefixPart = prefix ?? 'PPP';
  if (alnumOnly) prefixPart = prefixPart.replace(/[^a-zA-Z0-9]/g, '');
  const maxLen = provider ? CODE_MAX_LENGTH[provider] : undefined;
  // Dodo's 16-char cap: stem (≤5) + rand (4) + 2 separators = 11 fixed, so a
  // long user prefix truncates to 5 rather than pushing the code over the cap.
  if (maxLen) {
    const fixed = stem.length + rand.length + 2 * sep.length;
    prefixPart = prefixPart.slice(0, Math.max(3, maxLen - fixed));
  }
  return `${prefixPart}${sep}${stem}${sep}${rand}`.toUpperCase();
}

/** Most characters of a deal's name that go into its code. */
export const DEAL_SLUG_MAX_LENGTH = 12;

/**
 * Generate the code of a holiday deal from its name and percentage, plus the
 * random suffix every code carries (codes are unique across all workspaces, so
 * two "Black Friday" deals need different ones).
 * Format: {NAME}{PERCENT}-{RANDOM}, the separator dropped for providers that
 * only accept alphanumeric codes, the name cut to fit a provider's length cap.
 * Example: BLACKFRIDAY40-K7QX (Chargebee), BLACKFRIDAY40K7QX (Stripe),
 * BLACKFRID40-K7QX (Dodo, 16 characters). A name without letters or digits
 * becomes DEAL.
 */
export function generateDealCode(
  name: string,
  discountPercent: number,
  provider?: string,
  randomBytes: RandomBytes = defaultRandomBytes,
): string {
  const alnumOnly = provider ? ALNUM_ONLY_PROVIDERS.has(provider) : false;
  const sep = alnumOnly ? '' : '-';
  const percent = String(Math.round(discountPercent));
  const rand = randomCodeSuffix(randomBytes);
  // NFKD splits accented letters into the letter and its mark; the mark is then dropped.
  const slug = name.normalize('NFKD').replace(/[^a-zA-Z0-9]/g, '').toUpperCase() || 'DEAL';
  const maxLen = provider ? CODE_MAX_LENGTH[provider] : undefined;
  const room = maxLen ? maxLen - percent.length - sep.length - rand.length : DEAL_SLUG_MAX_LENGTH;
  return `${slug.slice(0, Math.max(3, Math.min(DEAL_SLUG_MAX_LENGTH, room)))}${percent}${sep}${rand}`;
}
