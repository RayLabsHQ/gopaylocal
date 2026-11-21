// ── Stripe Managed Payments probes: verify:provider stripe --managed-payments ─
// Owner: prov-stripe-paddle (Stripe verify flows). flows.ts calls these in
// place of the plain checkout-url step (verify mode) and after
// parse-redemption (replay mode); main.ts lists them in a dry run.
//
// The Managed Payments docs leave three things open that only a real Stripe
// TEST account can answer:
//   1. Does a promotion code attach to a Managed Payments Checkout Session?
//      update-checkout lists the parameters Managed Payments rejects;
//      `discounts` and `allow_promotion_codes` are not on that list, but no
//      page says they are supported
//      (https://docs.stripe.com/payments/managed-payments/update-checkout#remove-unsupported-parameters).
//      -> mp-promotion-code, mp-coupon, mp-customer-code
//   2. Does the code show in the completed-session webhook?  -> mp-delivery
//   3. What do the tax and currency fields look like?        -> mp-delivery
// mp-session runs first as a control: if Stripe refuses a managed session
// without any discount (feature not activated, product tax code not eligible,
// account location not supported), a discount failure would say nothing.

import type Stripe from 'stripe';
import type { StripeCheckoutSessionParams } from '../../src/services/providers/stripe';
import type { FlowContext, VerifyArtifacts } from './flows';
import { describeError } from './runner';

/**
 * Adaptive Pricing's documented test hook: a `+location_XX` suffix in the
 * customer email shows the Checkout page in that country's currency
 * (https://docs.stripe.com/payments/currencies/localize-prices/adaptive-pricing?payment-ui=stripe-hosted#testing).
 * France: EUR presentment, and a country where Managed Payments collects tax
 * (https://docs.stripe.com/payments/managed-payments/tax-compliance).
 */
export const MP_LOCATION_EMAIL = 'gopaylocal-verify+location_FR@example.com';

export const MP_VERIFY_STEPS = ['mp-session', 'mp-promotion-code', 'mp-coupon', 'mp-customer-code'] as const;
export const MP_REPLAY_STEPS = ['mp-delivery'] as const;

const SETUP_HINTS =
  'Managed Payments needs: the feature activated at https://dashboard.stripe.com/settings/managed-payments; ' +
  'a product whose tax code is eligible (https://docs.stripe.com/payments/managed-payments/eligibility#eligible-tax-codes); ' +
  'an account based in a supported location (https://docs.stripe.com/payments/managed-payments/eligibility#supported-business-locations); ' +
  'a direct account, not Connect.';

interface ManagedCheckoutCapable {
  createCheckoutSession(params: StripeCheckoutSessionParams): Promise<Stripe.Checkout.Session>;
}

function managedCapable(provider: unknown): provider is ManagedCheckoutCapable {
  return typeof (provider as { createCheckoutSession?: unknown } | null)?.createCheckoutSession === 'function';
}

/** What the dry run says each step would do. No call is made to build it. */
export function managedPaymentsPlan(
  mode: 'verify' | 'replay',
  options: { product?: string; replayFile?: string },
): Array<{ name: string; call: string }> {
  if (mode === 'replay') {
    return [
      {
        name: 'mp-delivery',
        call: `managedPaymentsReplaySteps() on ${options.replayFile} (reads managed_payments, amounts, total_details, presentment_details and discounts; no API call)`,
      },
    ];
  }
  const base = `createCheckoutSession('${options.product}', managed_payments[enabled]=true, customer_email=${MP_LOCATION_EMAIL}`;
  return [
    { name: 'mp-session', call: `${base}) as the no-discount control` },
    { name: 'mp-promotion-code', call: `${base}, discounts[0][promotion_code]=<the throwaway code's promo id>)` },
    { name: 'mp-coupon', call: `${base}, discounts[0][coupon]=<the throwaway coupon id>)` },
    { name: 'mp-customer-code', call: `${base}, allow_promotion_codes=true)` },
  ];
}

const sessionSummary = (s: Stripe.Checkout.Session) =>
  `${s.id}: managed_payments ${JSON.stringify(s.managed_payments ?? null)}, mode ${s.mode}, ` +
  `amount_total ${s.amount_total ?? 'null'} ${s.currency ?? ''}`.trimEnd();

const discountsOf = (s: Stripe.Checkout.Session) =>
  (s.discounts ?? []).map((d) => ({
    coupon: typeof d.coupon === 'string' ? d.coupon : d.coupon?.id ?? null,
    promotion_code: typeof d.promotion_code === 'string' ? d.promotion_code : d.promotion_code?.id ?? null,
  }));

/**
 * Verify mode, in place of checkout-url. Needs --product (a Price or Product
 * whose tax code is eligible). Sets art.checkoutUrl to the session that has
 * the promotion code pre-applied (else the coupon one, else the control).
 */
export async function managedPaymentsSteps(ctx: FlowContext, art: VerifyArtifacts): Promise<void> {
  const { runner, out, options, provider } = ctx;
  const productId = options.product;
  if (!productId) {
    for (const name of MP_VERIFY_STEPS) runner.skip(name, 'not requested: --managed-payments needs --product <price_... or prod_...>');
    return;
  }
  if (!managedCapable(provider)) {
    for (const name of MP_VERIFY_STEPS) {
      runner.skip(name, `unsupported: ${ctx.providerName} has no createCheckoutSession(); --managed-payments is Stripe-only`);
    }
    return;
  }
  const create = (extra: Partial<StripeCheckoutSessionParams>) =>
    provider.createCheckoutSession({
      productId,
      successUrl: options.successUrl,
      customerEmail: MP_LOCATION_EMAIL,
      managedPayments: true,
      ...extra,
    });
  const urls: Array<{ label: string; url: string }> = [];
  const keep = (label: string, s: Stripe.Checkout.Session) => {
    if (s.url) urls.push({ label, url: s.url });
  };
  const notManaged = (s: Stripe.Checkout.Session) =>
    s.managed_payments?.enabled === true
      ? null
      : `Stripe created the session but returned managed_payments ${JSON.stringify(s.managed_payments ?? null)}: Managed Payments was not applied. ${SETUP_HINTS}`;

  // mp-session: the control.
  let control: Stripe.Checkout.Session | undefined;
  const controlResult = await runner.step('mp-session', async () => {
    try {
      control = await create({});
    } catch (err) {
      return { status: 'FAIL', detail: `Stripe refused a Managed Payments session with no discount: ${describeError(err)}. ${SETUP_HINTS}` };
    }
    keep('no discount (control)', control);
    const problem = notManaged(control);
    const data = { session: sessionSummary(control) };
    return problem ? { status: 'FAIL', detail: problem, data } : { detail: `created ${sessionSummary(control)}`, data };
  });
  if (controlResult.status !== 'PASS') {
    for (const name of MP_VERIFY_STEPS.slice(1)) {
      runner.block(name, 'mp-session failed, so a failure here would not be about discounts');
    }
    return;
  }

  const discount = art.discount;
  let promoUrl: string | undefined;
  let couponUrl: string | undefined;

  // mp-promotion-code: question 1, the way GoPayLocal's own sessions attach codes.
  if (!discount) {
    runner.block('mp-promotion-code', 'create-discount did not succeed');
  } else {
    await runner.step('mp-promotion-code', async () => {
      let s: Stripe.Checkout.Session;
      try {
        s = await create({ discountCode: discount.code });
      } catch (err) {
        return {
          status: 'FAIL',
          detail:
            `Stripe REJECTED promotion code ${discount.code} on a Managed Payments session: ${describeError(err)}. ` +
            `Open question 1 answered "no" for pre-applied promotion codes.`,
        };
      }
      const got = discountsOf(s);
      const problems: string[] = [];
      const managed = notManaged(s);
      if (managed) problems.push(managed);
      if (got.length !== 1 || !got[0]!.promotion_code) {
        problems.push(`session.discounts is ${JSON.stringify(got)}, expected the promotion code (did listing the code find it?)`);
      } else if (discount.providerPromoCodeId && got[0]!.promotion_code !== discount.providerPromoCodeId) {
        problems.push(`session.discounts names ${got[0]!.promotion_code}, expected ${discount.providerPromoCodeId}`);
      }
      if (control?.amount_total != null && s.amount_total != null && !(s.amount_total < control.amount_total)) {
        problems.push(`amount_total ${s.amount_total} is not below the control's ${control.amount_total}`);
      }
      const data = { session: sessionSummary(s), discounts: got, controlAmountTotal: control?.amount_total ?? null };
      if (problems.length) return { status: 'FAIL', detail: problems.join('; '), data };
      keep(`promotion code ${discount.code} pre-applied`, s);
      promoUrl = s.url ?? undefined;
      return {
        detail: `Stripe accepted the promotion code on a managed session: ${sessionSummary(s)} (control ${control?.amount_total ?? '?'}), discounts ${JSON.stringify(got)}`,
        data,
      };
    });
  }

  // mp-coupon: the coupon-id path buildCheckoutUrl takes when it has an id.
  if (!discount) {
    runner.block('mp-coupon', 'create-discount did not succeed');
  } else {
    await runner.step('mp-coupon', async () => {
      let s: Stripe.Checkout.Session;
      try {
        s = await create({ discountId: discount.providerDiscountId });
      } catch (err) {
        return {
          status: 'FAIL',
          detail: `Stripe REJECTED coupon ${discount.providerDiscountId} on a Managed Payments session: ${describeError(err)}`,
        };
      }
      const got = discountsOf(s);
      const problems: string[] = [];
      const managed = notManaged(s);
      if (managed) problems.push(managed);
      if (got.length !== 1 || got[0]!.coupon !== discount.providerDiscountId) {
        problems.push(`session.discounts is ${JSON.stringify(got)}, expected coupon ${discount.providerDiscountId}`);
      }
      const data = { session: sessionSummary(s), discounts: got };
      if (problems.length) return { status: 'FAIL', detail: problems.join('; '), data };
      keep(`coupon ${discount.providerDiscountId} pre-applied`, s);
      couponUrl = s.url ?? undefined;
      return { detail: `Stripe accepted the coupon on a managed session: ${sessionSummary(s)}`, data };
    });
  }

  // mp-customer-code: the field merchants' own sessions and Payment Links rely on.
  await runner.step('mp-customer-code', async () => {
    let s: Stripe.Checkout.Session;
    try {
      s = await create({ allowPromotionCodes: true });
    } catch (err) {
      return {
        status: 'FAIL',
        detail: `Stripe REJECTED allow_promotion_codes=true on a Managed Payments session: ${describeError(err)}`,
      };
    }
    const managed = notManaged(s);
    const data = { session: sessionSummary(s), allow_promotion_codes: s.allow_promotion_codes ?? null };
    if (managed) return { status: 'FAIL', detail: managed, data };
    keep(`customer types ${discount?.code ?? 'a code'}`, s);
    return {
      detail:
        `Stripe accepted allow_promotion_codes on a managed session: ${sessionSummary(s)}, allow_promotion_codes ${JSON.stringify(s.allow_promotion_codes ?? null)}. ` +
        `Whether the hosted page shows the field and takes the code is a manual check (URL below).`,
      data,
    };
  });

  art.checkoutUrl = promoUrl ?? couponUrl ?? control?.url ?? undefined;
  if (urls.length) {
    out.info('');
    out.info('Managed Payments checkout URLs (TEST mode):');
    for (const u of urls) out.info(`  ${u.label}:\n    ${u.url}`);
    out.info(
      [
        'To answer "does the code reach the webhook" and "what do tax and currency look like":',
        '  1. Open the promotion-code URL. The page should be in EUR (location_FR email).',
        '  2. Enter a French billing address so tax is calculated; pay with card 4242 4242 4242 4242.',
        '  3. Capture the checkout.session.completed delivery (--capture plus --webhook-url, --wait), then:',
        `     verify:provider stripe --replay <file> --managed-payments${discount ? ` --expect-code ${discount.code}` : ''}`,
      ].join('\n'),
    );
  }
}

/** Arithmetic only (see stripeTaxAndDiscount in stripe.ts): how the tax relates to the totals. */
export function describeTaxShape(s: {
  amount_subtotal?: number | null;
  amount_total?: number | null;
  total_details?: { amount_discount?: number; amount_shipping?: number | null; amount_tax?: number } | null;
}): string {
  const td = s.total_details;
  if (!td || typeof td.amount_tax !== 'number') return 'tax not reported';
  if (td.amount_tax === 0) return 'no tax';
  const sub = s.amount_subtotal;
  const total = s.amount_total;
  const disc = td.amount_discount ?? 0;
  const ship = td.amount_shipping ?? 0;
  if (sub == null || total == null) return `tax ${td.amount_tax}, totals incomplete`;
  if (sub - disc + ship + td.amount_tax === total) return `tax ${td.amount_tax} added on top (exclusive prices)`;
  if (sub - disc + ship === total) return `tax ${td.amount_tax} contained in the prices (inclusive)`;
  return `tax ${td.amount_tax}, totals match neither exclusive nor inclusive (mixed?)`;
}

/** Replay mode, after parse-redemption: the raw Managed Payments fields of a captured delivery. */
export async function managedPaymentsReplaySteps(ctx: FlowContext, rawBody: string): Promise<void> {
  const { runner, out, options } = ctx;
  let fields: Record<string, unknown> | undefined;
  await runner.step('mp-delivery', async () => {
    let evt: { type?: unknown; api_version?: unknown; data?: { object?: Record<string, any> } };
    try {
      evt = JSON.parse(rawBody);
    } catch {
      return { status: 'FAIL', detail: 'the delivery body is not JSON' };
    }
    const s = evt?.data?.object;
    if (typeof evt?.type !== 'string' || !evt.type.startsWith('checkout.session.') || !s) {
      return { status: 'FAIL', detail: `expected a checkout.session.* event, got ${JSON.stringify(evt?.type ?? null)}` };
    }
    fields = {
      event_type: evt.type,
      event_api_version: evt.api_version ?? null,
      managed_payments: s.managed_payments ?? null,
      mode: s.mode ?? null,
      payment_status: s.payment_status ?? null,
      currency: s.currency ?? null,
      amount_subtotal: s.amount_subtotal ?? null,
      amount_total: s.amount_total ?? null,
      total_details: s.total_details ?? null,
      presentment_details: s.presentment_details ?? null,
      discounts: s.discounts ?? null,
      allow_promotion_codes: s.allow_promotion_codes ?? null,
      automatic_tax: s.automatic_tax ?? null,
      customer_country: s.customer_details?.address?.country ?? null,
    };
    const problems: string[] = [];
    if (s.managed_payments?.enabled !== true) {
      problems.push(`not a Managed Payments session (managed_payments ${JSON.stringify(s.managed_payments ?? null)})`);
    }
    const discounts = Array.isArray(s.discounts) ? s.discounts : [];
    if (!options.expectNone && discounts.length === 0) {
      problems.push('the completed session carries no discount: the code did not reach the webhook (or none was used; then pass --expect-none)');
    }
    const presentment = s.presentment_details
      ? `${s.presentment_details.presentment_amount} ${s.presentment_details.presentment_currency}`
      : 'none';
    const summary =
      `${s.amount_total ?? 'null'} ${s.currency ?? ''} (subtotal ${s.amount_subtotal ?? 'null'}, ` +
      `discount ${s.total_details?.amount_discount ?? 'null'}, ${describeTaxShape(s)}); presentment ${presentment}; ` +
      `discounts ${JSON.stringify(discounts)}; event api_version ${JSON.stringify(evt.api_version ?? null)}`;
    if (problems.length) return { status: 'FAIL', detail: `${problems.join('; ')}. Seen: ${summary}`, data: { fields } };
    return { detail: `managed session: ${summary}`, data: { fields } };
  });
  if (fields) {
    out.info('');
    out.info(`Managed Payments fields in the delivery:\n${JSON.stringify(fields, null, 2)}`);
  }
}
