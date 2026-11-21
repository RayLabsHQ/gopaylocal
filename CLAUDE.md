# GoPayLocal

PPP (Purchasing Power Parity) discount SaaS. Detects visitor location at the Cloudflare edge and applies country-appropriate discounts automatically.

## Open source + pricing (decided by the founder, November 2026)

GoPayLocal is open source: `apps/*` are AGPL-3.0-only, `packages/*` (SDKs, banner,
shared) are MIT. See `LICENSING.md`. There is a hosted version with exactly two plans,
and a self-hosted mode with no limits and no billing.

| | Free | Pro ($19/mo or $180/yr) | Self-hosted |
|---|---|---|---|
| Products | 1 | Unlimited | Unlimited |
| API calls/mo | 10K | Unlimited (fair use) | Unlimited |
| Team members | 1 | Unlimited | Unlimited |
| Analytics | 7-day | 365-day | Unlimited |
| Branding | GoPayLocal shown | Removed | Removed |
| Billing | None | Dodo Payments | Disabled |

- Enforced limits live in `packages/shared/src/constants/index.ts` (`PLAN_LIMITS`); the
  `Plan` type is in `packages/shared/src/types/index.ts`. The effective plan is always
  resolved through `apps/api/src/lib/entitlements.ts`; never read `subscriptions.plan`
  directly.
- "Fair use" means nothing is enforced on Pro; an admin alert fires above 20M API
  calls in a month.
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

### Key Files

- `src/lib/landing-data.ts` — All 3 variant content datasets + pricing cards
- `src/lib/use-case-data.ts` — All 4 use case content datasets
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

### Toolchain notes

- TypeScript 7 has no compiler API. `apps/web` (astro check) and the two SDKs (tsup
  dts) alias `typescript` to TypeScript 6 for that reason; do not "fix" the alias.
- The docs theme (`starlight-theme-black`) is pinned at 0.6.0 because 0.7 restyles
  every docs page. The `cssMinify: 'esbuild'` setting in `apps/docs/astro.config.mjs`
  exists only for that pin; remove both together.
- Better Auth validates the Drizzle schema on every auth request. A column its plugins
  expect and `apps/api/src/db/schema.ts` lacks makes every auth route fail;
  `apps/api/src/auth.test.ts` covers this.
