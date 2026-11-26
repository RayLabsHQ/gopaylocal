# GoPayLocal

PPP (Purchasing Power Parity) discount SaaS. Detects visitor location at the Cloudflare edge and applies country-appropriate discounts automatically.

## Open source + pricing (decided by the founder, November 2026)

GoPayLocal is open source: `apps/*` are AGPL-3.0-only, `packages/*` (SDKs, banner,
shared) are MIT. See `LICENSING.md`. There is a hosted version with exactly two plans,
and a self-hosted mode with no limits and no billing.

| | Free | Pro ($19/mo) | Self-hosted |
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
- Pro is billed monthly. The yearly plan was removed in November 2026 by the founder;
  do not re-add it. The checkout refuses any interval other than `month`.
- The Dodo product and `DODO_PRICE_ID_PRO_MONTHLY` are managed by the founder in the
  Dodo dashboard. The Dodo business that bills Pro also sells other products, and Dodo sends
  every event of a business to every webhook endpoint: the billing webhook acknowledges
  and does not store a delivery about another product (`isOtherDodoProduct` in
  `apps/api/src/routes/webhooks.ts`), and only the Pro product id grants a plan.
- Pro has a regional price (decided by the founder, November 2026), priced with GoPayLocal
  itself. A display-only campaign (no payment platform, so no codes; capped at 70%) in an
  internal "house" workspace, chosen on the admin's Regional price page, sets each
  country's discount. Dodo charges it through per-country Localized Pricing rules that
  `apps/api/src/services/house-pricing.service.ts` writes (amounts from `regionalCharge`,
  `packages/shared/src/currency/regional-charge.ts`) and records after every sync. The
  website's Pro card and the dashboard's Billing page show that record through
  `GET /v1/pricing/pro`, so they only ever show a price Dodo charges; never compute the
  shown price separately. The website's banner uses the house public key
  (`PUBLIC_GOPAYLOCAL_PUBLIC_KEY`, set when `apps/web` is built and never committed),
  which also switches the card's regional price on. Dodo's own PPP and Charm Pricing
  settings stay off (PPP would discount again; Charm would round the $19 Dodo converts for
  countries without a rule), and the house campaign gets no deals or A/B tests (Dodo would
  not charge them). The sync charm-rounds each price DOWN with the house campaign's own
  strategy (`houseCharge`), local and USD alike, so the "70% off" shown is never more than
  the real discount; a price no charm point fits within 8% under stays exact.
- Internal workspaces (`internal_organizations`, set in the admin) and Dodo test-mode
  subscriptions (`subscriptions.environment = 'test'`) are left out of every admin metric.
  A test-mode subscription also grants Pro only while the Worker runs in Dodo test mode
  (`DODO_ENVIRONMENT="test_mode"`, checked in `effectivePlan`), so test purchases stop
  counting when the hosted service switches to live.

Positioning: the open-source PPP tool with one paid plan, priced per country with
GoPayLocal itself. Compete on completeness (VPN detection, A/B testing, multi-currency,
charm pricing, many integrations) and on not metering API hits. Every feature is available on every plan including Free.
Marketing and docs claims must match the code; do not describe a feature as available
until it is implemented and tested.

## This repository is public

Anyone can read the code, the history, the pull requests and everything GitHub Actions
prints: logs, step summaries, artifacts. Write tests, scripts, workflows, fixtures, docs
and commit messages with that reader in mind.

- Never print a secret or any part of one: no first or last characters, no encoded form.
  Print its length, or that it is set.
- Never print what an account holds: product names, prices and ids, customers, emails,
  checkout or dashboard links, account names, store hosts. Print counts and pass or fail.
  The accounts used for checks are shared with other projects.
- `verify:provider` does both with `--public-log`, which the CI wrapper
  (`apps/api/scripts/verify-provider/ci.ts`) always passes. Anything new the tool prints,
  or puts in its JSON report, must respect that flag and have a test in
  `apps/api/src/scripts/verify-provider.test.ts`.
- A workflow that uses secrets or `id-token: write` runs on a schedule or by hand, never
  for pull requests and never on `pull_request_target`. It gives a secret only to the step
  that needs it, pins every action to a commit and uploads no artifact.
  `apps/api/src/scripts/verify-provider-ci.test.ts` enforces part of this; keep it passing
  when you add or rename a workflow.
- Fixtures and examples use made-up values (`sk_test_FAKE…`, `example.com`). Never commit a
  real key, a payload captured from a real account, a personal email address, or the host
  of the production database.
- After changing a workflow or what one prints, read the log of a real run the way a
  stranger would before calling the work done.

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
- `/vs/dodo-payments` — Dodo Payments' built-in PPP next to GoPayLocal on top of Dodo
  (`dodoComparison`; Dodo's facts come from its docs, dated `DODO_CHECKED_ON`). It describes
  "Dodo charges the country price", so it ships only where that delivery is deployed
- `/compare` — the hub that links to all of them

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

The permissions each platform's key needs are in `PROVIDER_KEY_ACCESS`
(`packages/shared/src/constants/provider-key-access.ts`), shown in the dashboard's
Connect panel and repeated on each integration's docs page: change both together
when an integration starts or stops calling an endpoint.

Connecting checks the key with the platform before anything is stored
(`checkKey` in `apps/api/src/routes/integrations.ts`, the same `listDiscounts` call
as the Test button), so a key the platform refuses is never saved and never
replaces a working one.

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

### Dashboard screenshots

`pnpm screenshots` (`e2e/screenshots/capture.ts`) takes the dashboard images for the
docs and the README. It starts only the dashboard's Vite dev server and answers every
API request in the browser from made-up data (`e2e/screenshots/demo-data.ts`); the
API address is a `.invalid` host, so nothing reaches a real server. Never take docs or
README images from a real account, and never use mockups in them: retake from the
built dashboard. Add a shot to `SHOTS` and any data it needs to `demo-data.ts` and
`fake-api.ts`; the script lists requests the demo data didn't answer.

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
describe an integration as verified beyond what it says. Public pages (README, docs, the
website) don't state verification status at all (decided by the founder, November 2026):
problems come in as GitHub issues.

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

### Emails

GoPayLocal's own emails are built in `apps/api/src/emails/templates.ts` (pure; the layout
escapes every value) and sent by `apps/api/src/services/notify.ts` through ACS, replying to
`SUPPORT_EMAIL` (hosted: support@gopaylocal.com). Welcome (sign-up, not for invitees),
usage at 80% and 100% (Free's monthly cap), payment failed (Dodo webhook), Pro ended and
key refused (the `*/10` job) go to a workspace's owners, each once: a row in `emails_sent`
is claimed before sending and released when every send failed. Self-hosted sends only the
invitation and key-refused emails. Sending never breaks the request or job behind it.
The docs (`dashboard/billing.mdx`, `integrations/overview.mdx`, `self-hosting/*`) say which
emails exist: change them together.

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

### Country prices at Dodo (merchant campaigns)

A campaign whose `discount_delivery` is `provider_price` has no codes: GoPayLocal writes one
Dodo Localized Pricing rule per discounted country on the merchant's Dodo product
(`campaigns.provider_product_id`) with the merchant's key, and Dodo charges it by billing
country. Sync: `apps/api/src/services/campaign-country-prices.service.ts` (state in
`campaign_country_prices`, one row per campaign and Dodo product) on top of
`dodo-country-prices.ts`; dashboard tab **Prices at Dodo**; docs in
`integrations/dodo-payments.mdx`.

- Shown = charged: the banner serves a country only when the recorded price was written for
  its current discount (`campaignCountries` in `banner-cache.service.ts`), with
  `priceCharged: true` and no code. Never show a computed price for these campaigns.
- Before the first write the product must cost what the GoPayLocal product costs, have
  Dodo's PPP off and no rules of its own; `verified_at` is set just before that write.
  Only rules for countries GoPayLocal published may ever be archived (`ownedCountries`), and
  a row never verified is dropped without a Dodo call. Do not loosen either.
- Dodo integration only; one campaign per Dodo product; no holiday deals, no A/B tests;
  codes are refused while Dodo still charges a campaign's prices ("pause first", or a
  buyer gets both). Choosing the Dodo product needs access to every product.
- Disconnecting Dodo pauses these campaigns and removes their prices with the key first.

### Toolchain notes

- TypeScript 7 has no compiler API. `apps/web` (astro check) and the two SDKs (tsup
  dts) alias `typescript` to TypeScript 6 for that reason; do not "fix" the alias.
- The docs theme (`starlight-theme-black`) is pinned at 0.6.0 because 0.7 restyles
  every docs page. The `cssMinify: 'esbuild'` setting in `apps/docs/astro.config.mjs`
  exists only for that pin; remove both together.
- Better Auth validates the Drizzle schema on every auth request. A column its plugins
  expect and `apps/api/src/db/schema.ts` lacks makes every auth route fail;
  `apps/api/src/auth.test.ts` covers this.
