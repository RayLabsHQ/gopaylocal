# @gopaylocal/js

Browser SDK for [GoPayLocal](https://gopaylocal.com), purchasing power parity (PPP) discounts for your website. It asks the GoPayLocal API for the current visitor's country-specific discount and coupon code, then helps you show discounted prices and an optional discount banner. Works with vanilla JS, Vue, Svelte or any framework that runs in the browser.

Using React? See [`@gopaylocal/react`](https://www.npmjs.com/package/@gopaylocal/react). Only need a banner? The [script tag](https://docs.gopaylocal.com/banner/installation/) needs no install.

MIT licensed. Source: [`packages/js-sdk`](https://github.com/RayLabsHQ/gopaylocal/tree/main/packages/js-sdk).

## Install

```sh
npm install @gopaylocal/js
```

Ships ES module and CommonJS builds with TypeScript declarations for both. No dependencies.

## Quick start

You need a public API key (starts with `gpl_pk_`) from the [GoPayLocal dashboard](https://app.gopaylocal.com), and an active campaign there.

```html
<p>
  Pro: <span data-gopaylocal-price="29">$29</span>/month
  <span data-gopaylocal-discount></span> off with code <code data-gopaylocal-coupon></code>
</p>
```

```js
import { GoPayLocal } from '@gopaylocal/js';

const gpl = new GoPayLocal({
  apiKey: 'gpl_pk_...',     // public key; safe in client code
  productId: 'prod_...',    // optional: only this product's campaign
  baseCurrencyCode: 'USD',  // optional: the currency your prices are written in (default: your product's)
});

const data = await gpl.init(); // null when no discount applies to this visitor
if (data) {
  gpl.bindPriceElements(); // fills every data-gopaylocal-* element
  gpl.showBanner();        // optional: banner with a copy-code button
}
```

When no discount applies, the elements keep their original text, so write the base price in them.

## API at a glance

- `new GoPayLocal({ apiKey, apiBase?, productId?, visitorId?, persistVisitorId?, baseCurrencyCode?, baseCurrencySymbol?, cacheTtl?, onLoad?, onError? })`
- `init()` resolves to `{ show, country, countryName, discount, code, baseCurrencyCode, baseCurrencySymbol, currencyCode, currencySymbol, fxRate, fxAsOf, localPrice, localOriginalPrice, charmPricingStrategy, flag, campaignId, experimentId, variant, banner, showBranding }` or `null`
- `getPrice(basePrice, { localize?, showDecimal? })` returns `{ formatted, formattedOriginal, localPrice, localOriginalPrice, converted, currencyCode, discountedPrice, hasDiscount, discount, ... }`
- `getData()`, `getCode()`, `getCountry()`, `getExperiment()`, `isLoading()`, `getError()`, `formatPrice(amount, currencyCode?)`, `subscribe(listener)`
- `bindPriceElements()` fills `data-gopaylocal-price`, `-price-original`, `-currency-symbol`, `-currency-code`, `-country`, `-country-flag`, `-discount` (rendered with `%`) and `-coupon`
- `showBanner(options?)` returns `{ remove }`
- `track('impression' | 'click' | 'copy' | 'dismiss')` reports your own banner's events
- Helpers: `formatCurrency`, `countryToFlag`, `splitPrice`; constants `DEFAULT_API_BASE`, `VISITOR_ID_STORAGE_KEY`

## Good to know

- Run it in the browser. The discount depends on the country of the device making the request, so calling the API from a server returns the server's location.
- `discount` is a number (`40` means 40% off).
- When the API converted your product's price for the visitor (`fxAsOf` is set) and `baseCurrencyCode` is your product's currency, `getPrice()` converts your prices with the response's rate and rounds them with the campaign's charm pricing, using the same code as the API: $19 at 60% off shows an Indian visitor ₹719 (was ₹1,769). Converted prices are estimates; your payment provider charges the exact discounted price in your currency. Otherwise prices are the base price minus the discount, exact ($7.60, was $19). Whole amounts show no decimals.
- `showBanner()` starts from the campaign's banner design (sent by the API), with your options overriding it. It reports `impression`, `copy` and `dismiss` events, like the script tag, and shows "Powered by GoPayLocal" when the API asks for it (Free plan).
- A/B experiments: the SDK keeps a random visitor id in `localStorage` (`gpl_vid`, shared with the script tag and the React SDK) so a visitor stays in one arm. Pass `visitorId` to use your own, or `persistVisitorId: false` to store nothing. `getExperiment()` returns the arm, also when the arm has no discount for the visitor.
- Responses with a discount are cached in `sessionStorage` for 5 minutes (`cacheTtl`), per key and product. Blocked storage never breaks the SDK.
- Self-hosting: set `apiBase` to your API's URL. The default is `https://api.gopaylocal.com`.

## Docs

- JavaScript SDK guide: https://docs.gopaylocal.com/js/installation/
- Reference card for coding agents: https://docs.gopaylocal.com/ai/reference-card.md
- Docs index for LLMs: https://docs.gopaylocal.com/llms.txt
