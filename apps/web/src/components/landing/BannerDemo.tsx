import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_PARITY_TIERS } from '@gopaylocal/shared/parity';
import { COUNTRY_NAMES } from '@gopaylocal/shared/constants';
import { cn } from '@/lib/utils';

// The demo runs the same inputs the production banner can run on: the default
// parity tiers (packages/shared/src/parity) and the campaign
// `maxDiscountPercent` cap. Nothing here is invented.

const DEMO_COUNTRIES = ['IN', 'PK', 'NG', 'ID', 'VN', 'EG', 'PH', 'BR', 'MX', 'TR', 'US'];

const BASE_PRICE_USD = 49;
const DISCOUNT_CAPS = [50, 60, 70];
const DEFAULT_CAP = 70; // campaigns.max_discount_percent default

// Same substitution the banner runtime performs; `code` and `discount` are the
// two variables it wraps in <strong>.
const MESSAGE_TEMPLATE =
  "It looks like you're visiting from {{countryName}}! Use code {{code}} for {{discount}} off.";
const BOLD_VARS = new Set(['code', 'discount']);

// Exactly what the dashboard hands you on a campaign page.
const EMBED_SNIPPET = `<!-- Add to your website's <head> or before </body> -->
<script src="https://api.gopaylocal.com/v1/banner/script.js?key=YOUR_PUBLIC_KEY" async></script>`;

// Banner defaults from packages/shared BANNER_DEFAULTS.
const BANNER_BG = '#1a1a2e';
const BANNER_FG = '#ffffff';
const BANNER_CTA_BG = '#e94560';
const BANNER_CTA_FG = '#ffffff';

const LABEL_CLASS =
  'font-mono text-xs font-medium uppercase tracking-[0.16em] text-text-secondary';

function flagFor(countryCode: string): string {
  const cc = countryCode.toUpperCase();
  return String.fromCodePoint(
    0x1f1e6 + cc.charCodeAt(0) - 65,
    0x1f1e6 + cc.charCodeAt(1) - 65,
  );
}

function tierDiscountFor(countryCode: string): number {
  const tier = DEFAULT_PARITY_TIERS.find((t) => t.countries.includes(countryCode));
  return tier ? tier.discountPercent : 0;
}

/** Group-mode discount: the tier percentage, capped by the campaign setting. */
function discountFor(countryCode: string, cap: number): number {
  return Math.min(tierDiscountFor(countryCode), cap);
}

// Real codes end in a random 4-char suffix so one country's code can't be used
// to guess another's (see coupon.service.ts). The demo pins a suffix per country
// instead of generating one: the value has to survive hydration unchanged.
const DEMO_CODE_SUFFIX: Record<string, string> = {
  IN: 'K7QX', PK: 'R4TM', NG: 'H9VZ', ID: 'C3WY', VN: 'T6BJ', EG: 'M2FQ',
  PH: 'D8KR', BR: 'W8DM', MX: 'G5NP', TR: 'S7CV',
};

/** Same format the coupon service generates for providers that allow hyphens. */
function couponCode(countryCode: string, discount: number): string {
  const suffix = DEMO_CODE_SUFFIX[countryCode] ?? 'K7QX';
  return `PPP-${countryCode}${discount}-${suffix}`.toUpperCase();
}

function formatUsd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

function renderMessage(template: string, values: Record<string, string>) {
  return template.split(/(\{\{\w+\}\})/g).map((part, i) => {
    const match = part.match(/^\{\{(\w+)\}\}$/);
    if (!match) return <span key={i}>{part}</span>;
    const value = values[match[1]!] ?? '';
    return BOLD_VARS.has(match[1]!) ? (
      <strong key={i} style={{ fontWeight: 700 }}>
        {value}
      </strong>
    ) : (
      <span key={i}>{value}</span>
    );
  });
}

/** Copy-to-clipboard button that reports success in its own label. */
function CopyButton({
  value,
  label,
  idleText,
  className,
  style,
}: {
  value: string;
  label: string;
  idleText: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const onClick = useCallback(async () => {
    const ok = await copyText(value);
    if (!ok) return;
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 2000);
  }, [value]);

  return (
    <button type="button" onClick={onClick} aria-label={label} className={className} style={style}>
      {copied ? 'Copied!' : idleText}
    </button>
  );
}

/** Fills the banner slot whenever no banner renders, so the frame never sits empty. */
function StatusStrip({
  marker,
  children,
}: {
  marker: 'blocked' | 'none';
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 border-t border-border px-4 py-4 md:px-6">
      <span
        aria-hidden="true"
        className={cn(
          'h-2.5 w-2.5 shrink-0',
          marker === 'blocked' ? 'bg-accent-500' : 'bg-text-muted',
        )}
      />
      <p className="text-sm text-text-secondary">{children}</p>
    </div>
  );
}

export default function BannerDemo({ className }: { className?: string }) {
  const [country, setCountry] = useState('IN');
  const [vpn, setVpn] = useState(false);
  const [cap, setCap] = useState(DEFAULT_CAP);
  const [dismissed, setDismissed] = useState(false);

  const countryName = COUNTRY_NAMES[country] ?? country;
  const discount = discountFor(country, cap);
  const code = couponCode(country, discount);
  const localPrice = BASE_PRICE_USD * (1 - discount / 100);

  const withheldByVpn = vpn && discount > 0;
  const showBanner = discount > 0 && !vpn && !dismissed;

  const selectCountry = (cc: string) => {
    setCountry(cc);
    setDismissed(false);
  };

  const apiResponse = withheldByVpn
    ? '{ "show": false, "reason": "vpn_detected" }'
    : discount === 0
      ? '{ "show": false, "reason": "no_discount" }'
      : `{ "show": true, "country": "${country}", "discount": ${discount}, "code": "${code}" }`;

  const lead = withheldByVpn
    ? 'Banner withheld — VPN detected'
    : discount === 0
      ? `No banner — ${countryName}`
      : `Banner shown — ${countryName}, ${discount}% off`;

  const detail = withheldByVpn
    ? 'The visitor’s ASN and IP are checked against known datacenter and VPN ranges at the edge. No banner, no code, standard price.'
    : discount === 0
      ? 'High-purchasing-power countries see your normal pricing. There is nothing to discount here.'
      : `One code per country, created once and reused for every visitor from ${countryName}. The random suffix stops anyone guessing another country’s code.`;

  return (
    <div className={cn('border border-border bg-bg', className)}>
      <div className="grid lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
        {/* ── Controls ─────────────────────────────────────────────── */}
        <div className="min-w-0 border-b border-border p-6 lg:border-b-0 lg:border-r">
          <h3 className={LABEL_CLASS}>Visitor country</h3>
          <div
            role="group"
            aria-label="Visitor country"
            className="mt-4 grid grid-cols-1 gap-px border border-border bg-border sm:grid-cols-2 lg:grid-cols-1"
          >
            {DEMO_COUNTRIES.map((cc) => {
              const selected = cc === country;
              const pct = discountFor(cc, cap);
              return (
                <button
                  key={cc}
                  type="button"
                  onClick={() => selectCountry(cc)}
                  aria-pressed={selected}
                  className={cn(
                    'flex items-center gap-2.5 border-l-[3px] px-3 py-3 text-left transition-colors',
                    // 11 countries in a 2-up grid leaves a hole; the last one fills it.
                    'sm:last:col-span-2 lg:last:col-span-1',
                    'focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-500',
                    selected
                      ? 'border-l-white bg-accent-500 text-white'
                      : 'border-l-transparent bg-bg text-text-secondary hover:bg-bg-surface hover:text-text-primary',
                  )}
                >
                  <span aria-hidden="true" className="text-base leading-none">
                    {flagFor(cc)}
                  </span>
                  <span className={cn('truncate text-sm', selected && 'font-semibold')}>
                    {COUNTRY_NAMES[cc] ?? cc}
                  </span>
                  <span
                    className={cn(
                      'ml-auto font-display text-base font-bold tabular-nums',
                      selected ? 'text-white' : pct > 0 ? 'text-text-primary' : 'text-text-muted',
                    )}
                  >
                    {pct > 0 ? `−${pct}%` : '—'}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="mt-8">
            <h3 className={LABEL_CLASS}>Abuse check</h3>
            <button
              type="button"
              role="switch"
              aria-checked={vpn}
              onClick={() => setVpn((v) => !v)}
              className="mt-4 flex w-full items-center gap-3 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
            >
              <span
                aria-hidden="true"
                className={cn(
                  'relative h-5 w-9 shrink-0 border',
                  vpn ? 'border-accent-500 bg-accent-light' : 'border-border bg-bg-surface',
                )}
              >
                <span
                  className={cn(
                    'absolute top-[2px] h-[14px] w-[14px] transition-[left] duration-150',
                    vpn ? 'left-[18px] bg-accent-500' : 'left-[2px] bg-text-muted',
                  )}
                />
              </span>
              <span className="text-sm text-text-primary">Simulate a VPN visitor</span>
            </button>
          </div>

          <div className="mt-8">
            <h3 className={LABEL_CLASS}>Max discount</h3>
            <div
              role="group"
              aria-label="Campaign maximum discount"
              className="mt-4 inline-flex border border-border"
            >
              {DISCOUNT_CAPS.map((value, i) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setCap(value)}
                  aria-pressed={cap === value}
                  className={cn(
                    'px-4 py-2 font-display text-sm font-semibold tabular-nums transition-colors',
                    i > 0 && 'border-l border-border',
                    'focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-500',
                    cap === value
                      ? 'bg-accent-500 text-white'
                      : 'bg-bg text-text-secondary hover:bg-bg-surface hover:text-text-primary',
                  )}
                >
                  {value}%
                </button>
              ))}
            </div>
            <p className="mt-3 max-w-[38ch] text-sm leading-relaxed text-text-secondary">
              A real campaign setting — every tier is capped at this number.
            </p>
          </div>
        </div>

        {/* ── Mock storefront ──────────────────────────────────────── */}
        <div className="flex min-w-0 flex-col p-6">
          <div className="flex flex-1 flex-col border border-border bg-bg-surface">
            <div className="flex items-center gap-3 border-b border-border px-4 py-2.5">
              <span className="font-mono text-xs text-text-muted">yourstore.com/pricing</span>
              <span className="ml-auto font-mono text-[10px] uppercase tracking-[0.16em] text-text-muted">
                Your site
              </span>
            </div>

            <div className="flex min-h-[380px] flex-1 flex-col">
              <div className="flex flex-1 flex-col items-center justify-center gap-8 px-6 py-10">
                <div className="text-center">
                  <p className="font-display text-2xl font-semibold tracking-tight text-text-primary">
                    Pricing
                  </p>
                  <p className="mt-2 text-sm text-text-secondary">One plan. Everything included.</p>
                </div>

                <div className="w-full max-w-sm border border-border bg-bg p-6">
                  <p className={LABEL_CLASS}>Your product</p>
                  <div className="mt-4 flex flex-wrap items-baseline gap-3">
                    {discount > 0 && !vpn && (
                      <span className="font-display text-xl text-text-secondary line-through">
                        {formatUsd(BASE_PRICE_USD)}
                      </span>
                    )}
                    <span className="font-display text-4xl font-semibold tabular-nums tracking-tight text-text-primary">
                      {formatUsd(vpn ? BASE_PRICE_USD : localPrice)}
                    </span>
                  </div>
                  <p className="mt-3 text-sm leading-relaxed text-text-secondary">
                    {withheldByVpn
                      ? 'Standard price. No code issued for this visitor.'
                      : discount === 0
                        ? 'Standard price. No discount applies here.'
                        : `Code ${code} takes ${discount}% off at checkout.`}
                  </p>
                  <div
                    aria-hidden="true"
                    className="mt-6 border border-border px-4 py-2.5 text-center text-sm font-semibold text-text-primary"
                  >
                    Buy now
                  </div>
                </div>
              </div>

              {showBanner ? (
                <div
                  style={{
                    background: BANNER_BG,
                    color: BANNER_FG,
                    fontFamily: 'system-ui, sans-serif',
                    fontSize: 14,
                    lineHeight: 1.4,
                    // The real bar keeps the dismiss button in flow; inside a
                    // frame this narrow that strands it on a line of its own,
                    // so it is pinned right — where it sits on a full-width page.
                    padding: '10px 40px 10px 16px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 10,
                    flexWrap: 'wrap',
                    position: 'relative',
                    boxShadow: '0 -2px 6px rgba(0,0,0,.12)',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      flexWrap: 'wrap',
                      justifyContent: 'center',
                    }}
                  >
                    <span aria-hidden="true" style={{ fontSize: 22, lineHeight: 1 }}>
                      {flagFor(country)}
                    </span>
                    <span>
                      {renderMessage(MESSAGE_TEMPLATE, {
                        countryName,
                        country,
                        code,
                        discount: `${discount}%`,
                      })}
                    </span>
                    <CopyButton
                      value={code}
                      label={`Copy discount code ${code}`}
                      idleText="Copy Code"
                      style={{
                        background: BANNER_CTA_BG,
                        color: BANNER_CTA_FG,
                        border: 0,
                        fontWeight: 600,
                        cursor: 'pointer',
                        borderRadius: 6,
                        padding: '6px 16px',
                        fontSize: 13,
                        whiteSpace: 'nowrap',
                        fontFamily: 'inherit',
                      }}
                    />
                    <a
                      href="https://gopaylocal.com/?utm_source=banner&utm_medium=referral"
                      style={{
                        color: 'inherit',
                        textDecoration: 'none',
                        opacity: 0.55,
                        fontWeight: 500,
                        fontSize: 11,
                        whiteSpace: 'nowrap',
                      }}
                    >
                      Powered by GoPayLocal
                    </a>
                  </div>
                  <button
                    type="button"
                    onClick={() => setDismissed(true)}
                    aria-label="Dismiss banner"
                    style={{
                      background: 'none',
                      border: 0,
                      color: BANNER_FG,
                      cursor: 'pointer',
                      opacity: 0.7,
                      lineHeight: 1,
                      fontSize: 20,
                      padding: '4px 6px',
                      position: 'absolute',
                      right: 8,
                      top: '50%',
                      transform: 'translateY(-50%)',
                    }}
                  >
                    &times;
                  </button>
                </div>
              ) : withheldByVpn ? (
                <StatusStrip marker="blocked">No banner rendered for this visitor.</StatusStrip>
              ) : dismissed ? (
                <StatusStrip marker="none">
                  Dismissed — the real widget remembers that for the session.{' '}
                  <button
                    type="button"
                    onClick={() => setDismissed(false)}
                    className="font-semibold text-accent-text underline underline-offset-2 hover:text-text-primary"
                  >
                    Show it again
                  </button>
                </StatusStrip>
              ) : (
                <StatusStrip marker="none">
                  No banner — this visitor pays your normal price.
                </StatusStrip>
              )}
            </div>
          </div>

          {/* ── What just happened ─────────────────────────────────── */}
          <div className="mt-6 border border-border" aria-live="polite">
            <div className="p-5">
              <p className="font-display text-base font-semibold text-text-primary">{lead}</p>
              <p className="mt-2 max-w-[66ch] text-sm leading-relaxed text-text-secondary">
                {detail}
              </p>
            </div>
            <div className="overflow-x-auto border-t border-border bg-bg-surface px-5 py-3">
              <code className="whitespace-nowrap font-mono text-xs text-text-secondary">
                GET /v1/banner/config &rarr; {apiResponse}
              </code>
            </div>
          </div>

          <p className="mt-4 max-w-[66ch] text-sm leading-relaxed text-text-secondary">
            Message, colors and position are campaign settings. The &ldquo;Powered by
            GoPayLocal&rdquo; link only appears on the Free plan.
          </p>
        </div>
      </div>

      {/* ── Embed snippet ──────────────────────────────────────────── */}
      <div className="border-t border-border">
        <div className="flex items-center justify-between gap-4 border-b border-border px-6 py-3">
          <span className={LABEL_CLASS}>Embed snippet</span>
          <CopyButton
            value={EMBED_SNIPPET}
            label="Copy embed snippet"
            idleText="Copy"
            className="border border-border bg-bg px-3 py-1.5 font-mono text-xs text-text-secondary transition-colors hover:bg-bg-surface hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-500"
          />
        </div>
        <pre className="overflow-x-auto px-6 py-5 font-mono text-[13px] leading-relaxed text-text-secondary">
          <code>{EMBED_SNIPPET}</code>
        </pre>
        <p className="border-t border-border px-6 py-4 text-sm text-text-secondary">
          That is the entire integration. Everything above is decided at the edge, per visitor.
        </p>
      </div>
    </div>
  );
}
