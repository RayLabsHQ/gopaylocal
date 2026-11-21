import { useEffect, useState } from 'react';
import { DEFAULT_PARITY_TIERS } from '@gopaylocal/shared/parity';
import { COUNTRY_NAMES } from '@gopaylocal/shared/constants';

// Static, non-interactive rendering of the production banner, for embedding
// near the hero. Discounts come from the default parity groups every new
// organization is seeded with (packages/shared/src/parity), so the numbers
// shown are the numbers a default campaign produces.

const PREVIEW_COUNTRIES = ['IN', 'BR', 'ID'];
const ROTATE_MS = 5000;

// Real codes end in a random 4-char suffix (see coupon.service.ts); a preview
// needs a fixed one so the value survives hydration unchanged.
const CODE_SUFFIX: Record<string, string> = { IN: 'K7QX', BR: 'W8DM', ID: 'C3WY' };

const MESSAGE_PREFIX = "It looks like you're visiting from ";

const BANNER_BG = '#1a1a2e';
const BANNER_FG = '#ffffff';
const BANNER_CTA_BG = '#e94560';
const BANNER_CTA_FG = '#ffffff';

function flagFor(countryCode: string): string {
  const cc = countryCode.toUpperCase();
  return String.fromCodePoint(
    0x1f1e6 + cc.charCodeAt(0) - 65,
    0x1f1e6 + cc.charCodeAt(1) - 65,
  );
}

function discountFor(countryCode: string): number {
  const tier = DEFAULT_PARITY_TIERS.find((t) => t.countries.includes(countryCode));
  return tier ? tier.discountPercent : 0;
}

export default function BannerPreview({ className }: { className?: string }) {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduced) return;
    const id = setInterval(() => {
      setIndex((i) => (i + 1) % PREVIEW_COUNTRIES.length);
    }, ROTATE_MS);
    return () => clearInterval(id);
  }, []);

  const country = PREVIEW_COUNTRIES[index]!;
  const countryName = COUNTRY_NAMES[country] ?? country;
  const discount = discountFor(country);
  const code = `PPP-${country}${discount}-${CODE_SUFFIX[country] ?? 'K7QX'}`;

  return (
    <div
      className={className}
      role="img"
      aria-label={`The GoPayLocal banner as a visitor from ${countryName} sees it: code ${code} for ${discount}% off.`}
      style={{
        background: BANNER_BG,
        color: BANNER_FG,
        fontFamily: 'system-ui, sans-serif',
        fontSize: 14,
        lineHeight: 1.4,
        padding: '10px 16px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        flexWrap: 'wrap',
        position: 'relative',
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
        <span style={{ fontSize: 22, lineHeight: 1 }}>{flagFor(country)}</span>
        <span>
          {MESSAGE_PREFIX}
          {countryName}! Use code <strong style={{ fontWeight: 700 }}>{code}</strong> for{' '}
          <strong style={{ fontWeight: 700 }}>{discount}%</strong> off.
        </span>
        <span
          style={{
            background: BANNER_CTA_BG,
            color: BANNER_CTA_FG,
            fontWeight: 600,
            borderRadius: 6,
            padding: '6px 16px',
            fontSize: 13,
            whiteSpace: 'nowrap',
          }}
        >
          Copy Code
        </span>
      </div>
      <span
        style={{
          position: 'absolute',
          right: 8,
          opacity: 0.7,
          fontSize: 20,
          lineHeight: 1,
          padding: '4px 6px',
        }}
      >
        &times;
      </span>
    </div>
  );
}
