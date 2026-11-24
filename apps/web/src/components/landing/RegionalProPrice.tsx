import { useEffect, useState } from 'react';
import { PLAN_PRICES_USD } from '@gopaylocal/shared/constants';
import { regionalOfferFromAnswer, type RegionalOffer } from '@gopaylocal/shared/currency';

// Pro is priced with GoPayLocal itself: the house workspace's campaign holds
// each country's discount, served by the same config endpoint our customers'
// banners use, and Dodo Payments charges that price at checkout. Without the
// key (a fork, a local build) nothing renders and the card shows the list price.
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

/** The visitor's Pro price, under the list price, when their country has one. */
export default function RegionalProPrice() {
  const [offer, setOffer] = useState<RegionalOffer | null>(null);

  useEffect(() => {
    if (!HOUSE_KEY) return;
    let cancelled = false;
    fetch(`${API_BASE}/v1/banner/config/${encodeURIComponent(HOUSE_KEY)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((answer) => {
        if (!cancelled) setOffer(regionalOfferFromAnswer(answer, PLAN_PRICES_USD.pro.month, 'USD'));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  if (!offer) return null;
  return (
    <p className="mt-3 border-l-2 border-accent-500 pl-3 text-sm leading-relaxed text-text-primary">
      <span className="font-semibold">
        {format(offer.amount, offer.currency)}/mo in {offer.countryName}
      </span>
      <span className="text-text-secondary">
        {' '}
        · {offer.discount}% off, charged at checkout when your billing address is in {offer.countryName}
      </span>
    </p>
  );
}
