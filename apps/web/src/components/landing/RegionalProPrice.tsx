import { useEffect, useState } from 'react';
import { regionalOfferFromProPrice, type RegionalOffer } from '@gopaylocal/shared/currency';

// Pro is priced per country with GoPayLocal itself, and Dodo Payments charges
// that price at checkout. GET /v1/pricing/pro answers with what Dodo charges in
// the visitor's country. The house key (which also loads the site's banner)
// marks the hosted site's build: without it (a fork, a local build) nothing is
// fetched and the card shows the list price.
const HOUSE_KEY = import.meta.env.PUBLIC_GOPAYLOCAL_PUBLIC_KEY as string | undefined;
const API_BASE = (import.meta.env.PUBLIC_GOPAYLOCAL_API_URL as string | undefined) || 'https://api.gopaylocal.com';

function format(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      maximumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    }).format(amount);
  } catch {
    return `${currency} ${amount}`;
  }
}

const PRICE_CLASS = 'font-display text-5xl font-bold tracking-[-2px] tabular-nums mt-3 text-text-primary';

/**
 * The Pro card's price. The list price (server-rendered, and all a visitor
 * without a regional price ever sees) until GET /v1/pricing/pro answers with a
 * lower one; then that price is the big number and the list price is struck
 * through under it, with the one condition checkout applies: the billing
 * address. The struck price is the real list price, never a converted one:
 * nobody is charged a converted amount.
 */
export default function RegionalProPrice({ listPrice }: { listPrice: string }) {
  const [offer, setOffer] = useState<RegionalOffer | null>(null);

  useEffect(() => {
    if (!HOUSE_KEY) return;
    let cancelled = false;
    fetch(`${API_BASE}/v1/pricing/pro`)
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (!cancelled) setOffer(regionalOfferFromProPrice(body));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  if (!offer) return <p className={PRICE_CLASS}>{listPrice}</p>;
  return (
    <>
      <p className={PRICE_CLASS}>{format(offer.amount, offer.currency)}/mo</p>
      <p className="mt-2 text-sm leading-relaxed text-text-secondary">
        <s className="text-text-muted">
          <span className="sr-only">List price </span>
          {listPrice}
        </s>
        <span className="text-text-primary">
          {' '}
          · {offer.discount !== null ? `${offer.discount}% off ` : ''}with a billing address in {offer.countryName}
        </span>
      </p>
    </>
  );
}
