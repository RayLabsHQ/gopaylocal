# GoPayLocal

PPP (Purchasing Power Parity) discount SaaS. Detects visitor location at the Cloudflare edge and applies country-appropriate discounts automatically.

## Open source + pricing (decided by the founder, November 2026)

GoPayLocal is open source: `apps/*` are AGPL-3.0-only, `packages/*` (SDKs, banner,
shared) are MIT. See `LICENSING.md`. There is a hosted version with exactly two plans,
and a self-hosted mode with no limits and no billing.

| | Free | Pro ($19/mo or $180/yr) | Self-hosted |
|---|---|---|---|
| Products | 1 | Unlimited | Unlimited |
| API calls/mo | 10K | 20M (contact us for more) | Unlimited |
| Team members | 1 | Unlimited | Unlimited |
| Analytics | 7-day | 365-day | Unlimited |
| Branding | GoPayLocal shown | Removed | Removed |
| Billing | None | Dodo Payments | Disabled |

- Enforced limits live in `packages/shared/src/constants/index.ts` (`PLAN_LIMITS`); the
  `Plan` type is in `packages/shared/src/types/index.ts`. The effective plan is always
  resolved through `apps/api/src/lib/entitlements.ts`; never read `subscriptions.plan`
  directly.
- Pro's API calls: public copy says "20 million API calls a month, contact us for more"
  (never "unlimited"). Nothing is enforced on Pro; an admin alert fires above 20M API
  calls in a month (`PRO_FAIR_USE_API_HITS_PER_MONTH`) and the banner keeps working.
- Self-hosted mode is the Worker var `SELF_HOSTED="true"`: every organization is
  unlimited, branding is off, billing endpoints are disabled.
- The Dodo products and `DODO_PRICE_ID_PRO_MONTHLY` / `DODO_PRICE_ID_PRO_ANNUAL` are
  managed by the founder in the Dodo dashboard.

Positioning: the open-source PPP tool with one flat price. Compete on completeness
(VPN detection, A/B testing, multi-currency, charm pricing, many integrations) and on
not metering API hits. Every feature is available on every plan including Free.
Marketing and docs claims must match the code; do not describe a feature as available
until it is implemented and tested.

## Tech Stack

- **API**: Cloudflare Workers (Hono) + Postgres (via Hyperdrive) + KV (analytics are Postgres rollups)
- **Dashboard**: React (Vite) + TanStack Router + shadcn/ui
- **Admin**: React (Vite) + TanStack Router + shadcn/ui
- **Web (landing)**: Astro 7 + Tailwind v4 + React (shadcn/ui components)
- **Docs**: Astro Starlight
- **Auth**: Better Auth
- **Payments**: Dodo Payments
- **SDKs**: JS SDK + React SDK

## Web App (Landing Pages)

The landing site at `apps/web/` uses a Swiss Clean design (white bg, red #E42313 accent, Space Grotesk + Inter fonts).

### Landing Page Variants (UTM-routed)

Three variants share the same section components with different content data:

- `/` — Full variant (default for organic/direct traffic)
- `/landing/dev` — Developer-focused (utm_source: github, hackernews, devto, stackoverflow)
- `/landing/revenue` — Business/ROI-focused (utm_source: linkedin, twitter; utm_medium: cpc/paid)

Client-side JS on index checks UTM params and redirects. Cookie persists variant for returning visitors.

### Use Case Pages (SEO)

- `/use-cases/saas` — SaaS subscription businesses
- `/use-cases/digital-products` — Templates, ebooks, digital assets
- `/use-cases/online-courses` — Course creators (Teachable, Podia, etc.)
- `/use-cases/developer-tools` — Dev tool companies

### Comparison Pages (SEO)

- `/vs/paritydeals`, `/vs/parityvend`, `/vs/parity-kit` — GoPayLocal next to one other product
- `/alternatives/paritydeals`, `/alternatives/parityvend`, `/alternatives/parity-kit` — the other ways to do PPP pricing
- `/compare` — the hub that links to all six

All of their content is in `src/lib/comparison-data.ts`. What it says about GoPayLocal is
computed from the shared plan constants. What it says about another product comes from that
product's own website, read on `COMPARISON_CHECKED_ON`; where the site says nothing the page
says "not listed", never that the product lacks something. Each page has a section on when
the other product is the better choice: keep it. When you re-read the sources, update the
facts and the date together.

### Key Files

- `src/lib/landing-data.ts` — All 3 variant content datasets + pricing cards
- `src/lib/use-case-data.ts` — All 4 use case content datasets
- `src/lib/comparison-data.ts` — The comparison pages' content (other products' facts are dated)
- `src/lib/utm-router.ts` — UTM routing logic
- `src/components/ui/button.tsx` — shadcn/ui Button (CVA variants: primary/secondary/ghost/dark)
- `src/components/ui/badge.tsx` — shadcn/ui Badge
- `src/components/ui/feature-icon.tsx` — Lucide icon mapper
- `src/components/landing/` — Shared section components (Hero, HowItWorks, Features, SocialProof, Pricing, FAQ, FinalCTA)
- `src/layouts/SwissLayout.astro` — Swiss Clean layout

## Integrations

Stripe, Paddle, Gumroad, Chargebee, Dodo, Polar, Whop, Creem, WooCommerce.

Lemon Squeezy was removed in November 2026 (the platform stops processing payments
on 2027-03-31); do not re-add it. Its merchants are being moved to Stripe Managed
Payments (Stripe as merchant of record, opted into per Checkout Session), which
belongs in the Stripe integration, not in a new provider.

## Testing

### Dashboard test login (Playwright / e2e)

The login page is OAuth-only for real users. For automated testing there is a
hidden email+password sign-in:

- Open `https://app.gopaylocal.com/login?pw=1` (locally: `http://localhost:3000/login?pw=1`) —
  the `?pw=1` search param reveals an email+password form below the OAuth buttons.
  The param is cosmetic only; security is enforced server-side.
- Public email **signup is disabled** (`emailAndPassword: { disableSignUp: true }`
  in `apps/api/src/auth.ts`, locked by `apps/api/src/auth.test.ts`). Test users are
  seeded out-of-band with `apps/api/scripts/create-test-user.ts` (local-only, never
  deployed):

```sh
cd apps/api && \
  DATABASE_URL="postgresql://..." \
  BETTER_AUTH_SECRET="..." \
  TEST_USER_EMAIL="test@example.com" \
  TEST_USER_PASSWORD="$(openssl rand -base64 24)" \
  TEST_USER_NAME="Test User" \
  pnpm tsx scripts/create-test-user.ts
```

Use a high-entropy password and keep test accounts non-privileged (don't make
them owners of real orgs).

Playwright flow: navigate to `/login?pw=1`, fill the email + password fields,
submit — lands on `/dashboard` exactly like the OAuth flow.

### Test commands

- `pnpm test:api` — API unit tests (vitest, from repo root)
- `pnpm test:shared` — shared package tests
- `pnpm test:sdk` — JS SDK, React SDK and banner tests
- `pnpm test:integration` — API integration tests. They need a local Postgres test
  database (`pnpm db:test:up`, then `pnpm db:test:migrate`) and refuse to run against
  anything else
- `pnpm typecheck` — every package, plus the API tests and scripts
  (`apps/api/tsconfig.test.json`) and the e2e suite (`tsconfig.e2e.json`)

### Scheduled GitHub workflows

Besides `ci.yml` (typecheck, unit, integration and docs build on every push and pull request):

- `provider-checks.yml` (nightly, and `gh workflow run provider-checks.yml -f provider=stripe`):
  runs `verify:provider` against each provider's sandbox. A provider is checked once
  its key exists as the repository secret `VERIFY_<PROVIDER>_API_KEY`; without it the
  job reports "not set up". Never runs for pull requests.
- `woocommerce-store.yml` (nightly, and on pull requests that touch the WooCommerce
  integration): starts a real WooCommerce store in the job and checks coupon,
  checkout link, order and webhook end to end. Uses no secrets.
- `vpn-refresh.yml` (daily): rebuilds the VPN dataset and writes it to the `VPN_DATA`
  KV namespace through Cloudflare's API, because the Worker's own cron cannot finish
  on Workers Free. Needs the secrets `CLOUDFLARE_KV_API_TOKEN` and
  `CLOUDFLARE_ACCOUNT_ID`; without them it reports "not set up".

- `release-sdks.yml` (by hand only, from `main`): publishes `@gopaylocal/js` and
  `@gopaylocal/react` to npm when the version in a package's `package.json` is not on
  npm yet (`.github/scripts/release-sdks.sh`); `-f dry_run=true` builds and lists the
  files and publishes nothing. It signs in through npm's trusted publishing, so there
  is no token; the file name is part of what npm checks, so do not rename it. A run
  without `dry_run` publishes, and a published version cannot be taken back: run it
  only on the maintainer's instruction.

Guide for the first two: `apps/api/PROVIDER_VERIFICATION.md`. The status table there
is the record of which integrations have been verified against a real account; do not
describe an integration as verified beyond what it says.

### Banner request path

- `/v1/banner/script.js` and `/v1/banner/bundle.js` are static assets (`apps/api/static`,
  the `[assets]` block in `wrangler.toml`), answered by Cloudflare before the Worker runs.
  `apps/api/static/v1/` is generated from the banner build by
  `apps/api/scripts/build-static.mjs` (the `[build]` command). The Worker routes for the
  two paths are a fallback for tests and for deployments without assets.
- Impressions are counted by the config endpoint when it serves an offer
  (`apps/api/src/services/impression-meter.ts`). Clients send only `click` and `copy` to
  `/v1/events`; do not re-add a client-sent impression.
- The config endpoint keeps three lookups in isolate memory
  (`apps/api/src/services/banner-hot-cache.ts`): the key and the quota for 60 s, the
  banner document for 15 s. A revoked public key can therefore keep working for about
  two minutes, and a dashboard change can take 15 s longer to show. The docs state both;
  change the numbers there when you change them in the code.
- KV is written when something changes, not on a timer. A banner document is written by
  `pushBannerConfigForOrg` on a change; one older than 15 minutes is compared with the
  database in the background and rewritten only if it differs
  (`refreshBannerConfigForOrg`). The usage job writes an organization's snapshot only when
  its limit, its over-quota state or its branding changes. An unknown public key is
  remembered in isolate memory only. Do not add a KV write that runs whether or not
  anything changed, or one that an anonymous request can cause.

### Holiday deals

A deal is a percentage with a start and an end on a campaign, with one code for every
visitor (`deals` table, routes in `apps/api/src/routes/deals.ts`, dashboard tab
**Holiday deals**). While it runs, a visitor is offered the larger of the deal and their
country's discount; the deal on a tie.

- The rule is in `packages/shared/src/deals` (`pickActiveDeal`,
  `dealReplacesCountryDiscount`) and applied per request in the config endpoint, after the
  allowed-domain check. `unknown_country`, `vpn_detected` and `quota_exceeded` come first
  and are unchanged.
- A deal's code at the payment platform is a `coupons` row with `deal_id` set and no
  country. `coupons.deal_id` has no foreign key on purpose: a row whose deal is gone is a
  code still to be removed at the provider. The `*/10` scheduled job removes the codes of
  ended and deleted deals (`retireEndedDealCoupons`), a few per run.
- The banner document lists a campaign's deals that had not ended when the rows were read
  (`loadServingInputs`); the pure builder must not look at the clock, or a stored document
  and a rebuilt one would differ for no reason. `deals` is left out of a campaign that has
  none.
- `{{deal}}` and `{{ends}}` are filled in by the API, because the banner script is cached
  for up to a day. The two SDKs drop a cached answer when its deal has ended.
- Docs: `guides/holiday-deals.mdx` and `api/deals.mdx`. Not built: a deal for some
  countries, a deal added on top of the country discount, a percentage that changes by
  day (all in `ROADMAP.md`).

### Toolchain notes

- TypeScript 7 has no compiler API. `apps/web` (astro check) and the two SDKs (tsup
  dts) alias `typescript` to TypeScript 6 for that reason; do not "fix" the alias.
- The docs theme (`starlight-theme-black`) is pinned at 0.6.0 because 0.7 restyles
  every docs page. The `cssMinify: 'esbuild'` setting in `apps/docs/astro.config.mjs`
  exists only for that pin; remove both together.
- Better Auth validates the Drizzle schema on every auth request. A column its plugins
  expect and `apps/api/src/db/schema.ts` lacks makes every auth route fail;
  `apps/api/src/auth.test.ts` covers this.
