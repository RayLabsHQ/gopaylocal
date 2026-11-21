import {
  memo,
  useCallback,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { usePPP } from '../hooks/use-ppp';
import type { PPPContextValue } from '../types';
import { formatCurrency } from '../utils';
// Bundled into this package at build time.
import { chargedPrice, digitOptions } from '../../../js-sdk/src/price';

// ── Types ────────────────────────────────────────────────────────────────────

export interface PPPPricingPlan {
  /** Plan name (e.g., 'Free', 'Pro', 'Business'). */
  name: string;
  /** Monthly price in your base currency (e.g., 9 for $9/mo). Use 0 for free plans. */
  price: number;
  /** List of features included in this plan. */
  features: string[];
  /** Whether this plan should be visually highlighted (recommended plan). */
  highlighted?: boolean;
  /** Optional description shown below the plan name. */
  description?: string;
  /** Optional custom CTA text for this specific plan. */
  ctaText?: string;
  /** Optional plan identifier passed to onPlanSelect. */
  planId?: string;
}

/** The plan passed to `onPlanSelect`, with its prices for this visitor. */
export type PPPSelectedPlan = PPPPricingPlan & {
  /**
   * The monthly price after the annual and PPP discounts, in your base
   * currency, exact to its ISO minor unit (what your payment provider
   * charges, such as PKR 1838.14). Never converted.
   */
  finalPrice: number;
  /** The price the table shows, in `currencyCode`: converted and charm-rounded when prices are converted. */
  localPrice: number;
  /** The currency of `localPrice`. */
  currencyCode: string;
  billingPeriod: 'monthly' | 'annual';
};

export interface PPPPricingTableProps {
  /** Array of plan configurations. */
  plans: PPPPricingPlan[];
  /** Billing period toggle. Defaults to 'monthly'. */
  billingPeriod?: 'monthly' | 'annual';
  /** Discount percentage for annual billing (e.g., 20 for 20% off). Defaults to 0. */
  annualDiscount?: number;
  /** CTA button text. Defaults to 'Get Started'. */
  ctaText?: string;
  /** Callback when a plan's CTA is clicked. */
  onPlanSelect?: (plan: PPPSelectedPlan) => void;
  /** Whether to show a monthly/annual toggle. Defaults to true if annualDiscount > 0. */
  showBillingToggle?: boolean;
  /** Additional CSS class name for the container. */
  className?: string;
  /** If true, no default styles are applied. Defaults to false. */
  noStyles?: boolean;
  /** Custom header content rendered above the plans. */
  header?: ReactNode;
  /** Whether to show the country adjustment banner. Defaults to true. */
  showCountryBanner?: boolean;
}

/**
 * A plan's prices for this visitor: `localPrice` as the table shows it, and
 * `finalPrice`, the same discounts in your base currency, exact. Free plans
 * stay 0. Exported for tests; not public API.
 */
export function planPrices(
  basePrice: number,
  ppp: Pick<PPPContextValue, 'discount' | 'baseCurrencyCode' | 'localPrice'>,
  period: 'monthly' | 'annual',
  annualDiscount: number,
): { finalPrice: number; localPrice: number } {
  if (basePrice === 0) return { finalPrice: 0, localPrice: 0 };
  const monthly = period === 'annual' && annualDiscount > 0 ? basePrice * (1 - annualDiscount / 100) : basePrice;
  return {
    finalPrice: chargedPrice(monthly, ppp.discount, ppp.baseCurrencyCode),
    localPrice: ppp.localPrice(monthly),
  };
}

// ── Component ────────────────────────────────────────────────────────────────

/**
 * A full pricing table component that applies the visitor's PPP discount to
 * every plan price, converted to the visitor's currency when the API
 * converted your product's price (see `usePrice`).
 *
 * A drop-in pricing table that needs no configuration beyond your plan data.
 *
 * @example
 * ```tsx
 * <PPPPricingTable
 *   plans={[
 *     { name: 'Free', price: 0, features: ['3 products', '50K hits'] },
 *     { name: 'Pro', price: 9, features: ['Unlimited products', '500K hits'], highlighted: true },
 *     { name: 'Business', price: 29, features: ['Unlimited everything'] },
 *   ]}
 *   billingPeriod="monthly"
 *   annualDiscount={20}
 *   ctaText="Get Started"
 *   onPlanSelect={(plan) => console.log(plan)}
 * />
 * ```
 */
export const PPPPricingTable = memo(function PPPPricingTable({
  plans,
  billingPeriod: billingPeriodProp,
  annualDiscount = 0,
  ctaText = 'Get Started',
  onPlanSelect,
  showBillingToggle,
  className,
  noStyles = false,
  header,
  showCountryBanner = true,
}: PPPPricingTableProps) {
  const ppp = usePPP();
  const [activePeriod, setActivePeriod] = useState<'monthly' | 'annual'>(
    billingPeriodProp ?? 'monthly',
  );

  const shouldShowToggle = showBillingToggle ?? annualDiscount > 0;

  /** The price shown for a plan: PPP discount, and conversion when prices are converted. */
  const computePrice = useCallback(
    (basePrice: number): number => planPrices(basePrice, ppp, activePeriod, annualDiscount).localPrice,
    [activePeriod, annualDiscount, ppp],
  );

  /** Format a price for display. */
  const displayPrice = useCallback(
    (amount: number): string => {
      if (amount === 0) return 'Free';
      return formatCurrency(amount, ppp.currencyCode, digitOptions(amount, ppp.currencyCode));
    },
    [ppp.currencyCode],
  );

  const handlePlanSelect = useCallback(
    (plan: PPPPricingPlan) => {
      onPlanSelect?.({
        ...plan,
        ...planPrices(plan.price, ppp, activePeriod, annualDiscount),
        currencyCode: ppp.currencyCode,
        billingPeriod: activePeriod,
      });
    },
    [onPlanSelect, activePeriod, annualDiscount, ppp],
  );

  const computedPlans = useMemo(
    () =>
      plans.map((plan) => ({
        ...plan,
        formattedPrice: displayPrice(computePrice(plan.price)),
      })),
    [plans, computePrice, displayPrice],
  );

  // ── Unstyled rendering ──────────────────────────────────────────────────

  if (noStyles) {
    return (
      <div className={className} data-gopaylocal-pricing-table>
        {header}
        {showCountryBanner && ppp.discount > 0 && ppp.country && (
          <div data-gopaylocal-pricing-country-banner>
            {ppp.flag} Prices adjusted for {ppp.data?.countryName ?? ppp.country}
            {ppp.discount > 0 && ` (${ppp.discount}% off)`}
          </div>
        )}
        {shouldShowToggle && (
          <div data-gopaylocal-pricing-toggle>
            <button
              type="button"
              onClick={() => setActivePeriod('monthly')}
              data-active={activePeriod === 'monthly' || undefined}
            >
              Monthly
            </button>
            <button
              type="button"
              onClick={() => setActivePeriod('annual')}
              data-active={activePeriod === 'annual' || undefined}
            >
              Annual{annualDiscount > 0 ? ` (-${annualDiscount}%)` : ''}
            </button>
          </div>
        )}
        <div data-gopaylocal-pricing-plans>
          {computedPlans.map((plan) => (
            <div
              key={plan.name}
              data-gopaylocal-pricing-plan
              data-highlighted={plan.highlighted || undefined}
            >
              <div data-gopaylocal-pricing-plan-name>{plan.name}</div>
              {plan.description && (
                <div data-gopaylocal-pricing-plan-description>
                  {plan.description}
                </div>
              )}
              <div data-gopaylocal-pricing-plan-price>
                <span data-gopaylocal-pricing-plan-amount>
                  {plan.formattedPrice}
                </span>
                {plan.price > 0 && (
                  <span data-gopaylocal-pricing-plan-period>
                    /{activePeriod === 'annual' ? 'mo' : 'mo'}
                  </span>
                )}
              </div>
              <ul data-gopaylocal-pricing-plan-features>
                {plan.features.map((feature) => (
                  <li key={feature}>{feature}</li>
                ))}
              </ul>
              <button
                type="button"
                onClick={() => handlePlanSelect(plan)}
                data-gopaylocal-pricing-plan-cta
              >
                {plan.ctaText ?? ctaText}
              </button>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // ── Default styled rendering ────────────────────────────────────────────

  const styles = getDefaultStyles(ppp.discount > 0);

  return (
    <div style={styles.container} className={className} data-gopaylocal-pricing-table>
      {header}

      {showCountryBanner && ppp.discount > 0 && ppp.country && (
        <div style={styles.countryBanner}>
          <span style={{ fontSize: '20px' }}>{ppp.flag}</span>
          <span>
            Prices adjusted for{' '}
            <strong>{ppp.data?.countryName ?? ppp.country}</strong>
            {ppp.discount > 0 && (
              <span style={styles.discountBadge}>{ppp.discount}% off</span>
            )}
          </span>
        </div>
      )}

      {shouldShowToggle && (
        <div style={styles.toggleContainer}>
          <div style={styles.toggleWrapper}>
            <button
              type="button"
              style={{
                ...styles.toggleButton,
                ...(activePeriod === 'monthly'
                  ? styles.toggleButtonActive
                  : {}),
              }}
              onClick={() => setActivePeriod('monthly')}
            >
              Monthly
            </button>
            <button
              type="button"
              style={{
                ...styles.toggleButton,
                ...(activePeriod === 'annual'
                  ? styles.toggleButtonActive
                  : {}),
              }}
              onClick={() => setActivePeriod('annual')}
            >
              Annual{annualDiscount > 0 ? ` (-${annualDiscount}%)` : ''}
            </button>
          </div>
        </div>
      )}

      <div style={styles.plansGrid}>
        {computedPlans.map((plan) => (
          <div
            key={plan.name}
            style={{
              ...styles.planCard,
              ...(plan.highlighted ? styles.planCardHighlighted : {}),
            }}
          >
            <div style={styles.planHeader}>
              <h3 style={styles.planName}>{plan.name}</h3>
              {plan.description && (
                <p style={styles.planDescription}>{plan.description}</p>
              )}
            </div>
            <div style={styles.priceSection}>
              <span style={styles.priceAmount}>{plan.formattedPrice}</span>
              {plan.price > 0 && (
                <span style={styles.pricePeriod}>/mo</span>
              )}
            </div>
            {activePeriod === 'annual' && plan.price > 0 && (
              <div style={styles.billedAnnually}>
                billed annually
              </div>
            )}
            <ul style={styles.featureList}>
              {plan.features.map((feature) => (
                <li key={feature} style={styles.featureItem}>
                  <span style={styles.featureCheck}>&#10003;</span>
                  {feature}
                </li>
              ))}
            </ul>
            <button
              type="button"
              style={{
                ...styles.ctaButton,
                ...(plan.highlighted ? styles.ctaButtonHighlighted : {}),
              }}
              onClick={() => handlePlanSelect(plan)}
            >
              {plan.ctaText ?? ctaText}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
});

// ── Default Styles ───────────────────────────────────────────────────────────

function getDefaultStyles(_hasDiscount: boolean) {
  const base: Record<string, CSSProperties> = {
    container: {
      fontFamily: 'system-ui, -apple-system, sans-serif',
      maxWidth: '1080px',
      margin: '0 auto',
      padding: '20px',
    },
    countryBanner: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '8px',
      padding: '12px 16px',
      backgroundColor: '#f0fdf4',
      border: '1px solid #bbf7d0',
      borderRadius: '8px',
      marginBottom: '24px',
      fontSize: '14px',
      color: '#166534',
    },
    discountBadge: {
      display: 'inline-block',
      marginLeft: '8px',
      padding: '2px 8px',
      backgroundColor: '#16a34a',
      color: '#ffffff',
      borderRadius: '12px',
      fontSize: '12px',
      fontWeight: 600,
    },
    toggleContainer: {
      display: 'flex',
      justifyContent: 'center',
      marginBottom: '32px',
    },
    toggleWrapper: {
      display: 'inline-flex',
      backgroundColor: '#f3f4f6',
      borderRadius: '8px',
      padding: '4px',
    },
    toggleButton: {
      padding: '8px 20px',
      border: 'none',
      borderRadius: '6px',
      cursor: 'pointer',
      fontSize: '14px',
      fontWeight: 500,
      color: '#6b7280',
      backgroundColor: 'transparent',
      transition: 'all 0.15s ease',
    },
    toggleButtonActive: {
      backgroundColor: '#ffffff',
      color: '#111827',
      boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
    },
    plansGrid: {
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
      gap: '24px',
      alignItems: 'start',
    },
    planCard: {
      border: '1px solid #e5e7eb',
      borderRadius: '12px',
      padding: '32px 24px',
      backgroundColor: '#ffffff',
      display: 'flex',
      flexDirection: 'column' as const,
    },
    planCardHighlighted: {
      border: '2px solid #3b82f6',
      boxShadow: '0 4px 14px rgba(59, 130, 246, 0.15)',
      position: 'relative' as const,
    },
    planHeader: {
      marginBottom: '16px',
    },
    planName: {
      margin: '0 0 4px 0',
      fontSize: '20px',
      fontWeight: 600,
      color: '#111827',
    },
    planDescription: {
      margin: 0,
      fontSize: '14px',
      color: '#6b7280',
    },
    priceSection: {
      marginBottom: '4px',
      display: 'flex',
      alignItems: 'baseline',
      gap: '4px',
    },
    priceAmount: {
      fontSize: '36px',
      fontWeight: 700,
      color: '#111827',
      lineHeight: 1.1,
    },
    pricePeriod: {
      fontSize: '16px',
      color: '#6b7280',
    },
    billedAnnually: {
      fontSize: '13px',
      color: '#6b7280',
      marginBottom: '16px',
    },
    featureList: {
      listStyle: 'none',
      padding: 0,
      margin: '16px 0 24px 0',
      flex: '1',
    },
    featureItem: {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      padding: '6px 0',
      fontSize: '14px',
      color: '#374151',
    },
    featureCheck: {
      color: '#16a34a',
      fontWeight: 700,
      fontSize: '14px',
      flexShrink: 0,
    },
    ctaButton: {
      width: '100%',
      padding: '12px 24px',
      border: '1px solid #d1d5db',
      borderRadius: '8px',
      cursor: 'pointer',
      fontSize: '15px',
      fontWeight: 600,
      color: '#374151',
      backgroundColor: '#ffffff',
      transition: 'all 0.15s ease',
      marginTop: 'auto',
    },
    ctaButtonHighlighted: {
      backgroundColor: '#3b82f6',
      color: '#ffffff',
      border: '1px solid #3b82f6',
    },
  };

  return base;
}
