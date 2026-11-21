# @gopaylocal/react

React components and hooks for [GoPayLocal](https://gopaylocal.com), purchasing power parity (PPP) discounts for your website. The provider asks the GoPayLocal API for the current visitor's country-specific discount and coupon code; the components show discounted prices and an optional discount banner.

Not using React? See [`@gopaylocal/js`](https://www.npmjs.com/package/@gopaylocal/js). Only need a banner? The [script tag](https://docs.gopaylocal.com/banner/installation/) needs no install.

MIT licensed. Source: [`packages/react-sdk`](https://github.com/RayLabsHQ/gopaylocal/tree/main/packages/react-sdk).

## Install

```sh
npm install @gopaylocal/react
```

Peer dependency: `react` 18 or 19. Ships ES module and CommonJS builds with TypeScript declarations for both.

## Quick start

You need a public API key (starts with `gpl_pk_`) from the [GoPayLocal dashboard](https://app.gopaylocal.com), and an active campaign there.

```tsx
import { GoPayLocalProvider, PPPBanner, PPPPrice } from '@gopaylocal/react';

export function App() {
  return (
    <GoPayLocalProvider
      apiKey={import.meta.env.VITE_GOPAYLOCAL_KEY} // public key; safe in client code
      productId="prod_..." // optional: only this product's campaign
      baseCurrencyCode="USD" // optional: the currency your prices are written in (default: your product's)
    >
      <p>
        Pro: <PPPPrice price={29} />/month
      </p>
      <PPPBanner />
    </GoPayLocalProvider>
  );
}
```

`<PPPPrice>` shows the base price until data loads or when no discount applies. `<PPPBanner>` renders nothing when there is no discount.

### Next.js App Router

The package is marked `'use client'`, so a Server Component such as `app/layout.tsx` can render the provider directly:

```tsx
// app/layout.tsx
import { GoPayLocalProvider } from '@gopaylocal/react';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <GoPayLocalProvider apiKey={process.env.NEXT_PUBLIC_GOPAYLOCAL_KEY!}>
          {children}
        </GoPayLocalProvider>
      </body>
    </html>
  );
}
```

Function props (`onLoad`, `onError`, `onPlanSelect`) cannot cross from a Server Component, so pass those from your own `'use client'` component. Files that call the hooks need `'use client'` too. The re-exported helpers (`formatCurrency`, `countryToFlag`, `splitPrice`) are client references here; import them from `@gopaylocal/js` to use them on the server.

### Hooks

```tsx
'use client';

import { usePPP, usePrice } from '@gopaylocal/react';

export function ProPrice() {
  const { discount, code, flag } = usePPP();
  const { formatted, formattedOriginal, hasDiscount } = usePrice({ price: 29 });

  return (
    <p>
      {hasDiscount && <s>{formattedOriginal}</s>} <strong>{formatted}</strong>
      {hasDiscount && code && ` ${flag} ${discount}% off with code ${code}`}
    </p>
  );
}
```

## Exports

- `GoPayLocalProvider` (props: `apiKey`, `apiBase`, `productId`, `visitorId`, `persistVisitorId`, `baseCurrencyCode`, `baseCurrencySymbol`, `onLoad`, `onError`)
- Hooks: `usePPP()` (adds `campaignId`, `experimentId`, `variant`, `track` to the discount data), `usePrice({ price, localize?, showDecimal?, minimumDecimalDigits?, maximumDecimalDigits? })`
- Components: `PPPBanner`, `PPPPrice`, `PPPPriceFormatted`, `PPPPriceInteger`, `PPPPriceDecimal`, `PPPCurrencySymbol`, `PPPCurrencyCode`, `PPPPricingTable`
- Helpers: `formatCurrency`, `countryToFlag`, `splitPrice`; constants `DEFAULT_API_BASE`, `VISITOR_ID_STORAGE_KEY`

## Good to know

- Everything runs in the browser. The discount depends on the country of the device making the request; on the server the provider has no data, so server-rendered HTML shows base prices and there is no hydration mismatch.
- `discount` is a number (`40` means 40% off).
- When the API converted your product's price for the visitor and `baseCurrencyCode` is your product's currency, `usePrice()`, the price components and `<PPPPricingTable>` convert your prices with the response's rate and round them with the campaign's charm pricing, using the same code as the API: $19 at 60% off shows an Indian visitor ₹719 (was ₹1,769). Converted prices are estimates; your payment provider charges the exact discounted price in your currency. Otherwise prices are the base price minus the discount, exact ($7.60, was $19). Whole amounts show no decimals.
- `<PPPBanner />` uses the campaign's banner design, reports `copy` events (the API counts the impression when it serves the discount), and shows "Powered by GoPayLocal" when the API asks for it (Free plan). Use it or the script tag, not both.
- A/B experiments: the provider keeps a random visitor id in `localStorage` (`gpl_vid`, shared with the script tag and the JS SDK) so a visitor stays in one arm. `visitorId` uses your own; `persistVisitorId={false}` stores nothing. `usePPP().variant` is the arm, also when the arm has no discount for the visitor.
- Responses with a discount are cached in `sessionStorage` for 5 minutes, per key and product. Blocked storage never breaks the provider.
- Self-hosting: set `apiBase` to your API's URL. The default is `https://api.gopaylocal.com`.

## Docs

- React SDK guide: https://docs.gopaylocal.com/react/installation/
- Reference card for coding agents: https://docs.gopaylocal.com/ai/reference-card.md
- Docs index for LLMs: https://docs.gopaylocal.com/llms.txt
