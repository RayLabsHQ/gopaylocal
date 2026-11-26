# Contributing to GoPayLocal

Thanks for your interest in GoPayLocal. This guide covers how to get the
monorepo running locally, how the code is organised, and what we expect from a
pull request.

Please read the [Code of Conduct](CODE_OF_CONDUCT.md) before taking part. To
report a security problem, do not open an issue: follow [SECURITY.md](SECURITY.md).

## Prerequisites

- **Node.js 22.23.4 or newer on the 22 line, 24.11 or newer on the 24 line, or
  26 and later** (the `engines` field of the root `package.json`). Astro 7 needs
  22.23.4; Vitest 5 and tsup 9 do not support the odd-numbered releases (23, 25).
  The maintainers use Node 26, which is what [`.nvmrc`](.nvmrc) selects
  (`nvm use`).
- **pnpm 12**, at the exact version pinned in the `packageManager` field of the
  root `package.json`. Run `corepack enable` once and Corepack will fetch and use
  exactly that version whenever you run `pnpm` in this repository. CI reads the
  same field, so the two never drift apart. Node 26 does not ship Corepack, so
  install it first (`npm install -g corepack`) or install pnpm 12 another way;
  Node 22 and 24 ship it.
- pnpm refuses to install packages published less than a day ago
  (`minimumReleaseAge`, on by default since pnpm 11), so `pnpm update` may stop
  one release short of the newest. Dependencies may only run install scripts if
  they are listed under `allowBuilds` in
  [`pnpm-workspace.yaml`](pnpm-workspace.yaml); an install fails on any other
  package with a build script, so add a new one there deliberately.
- **Docker** with Compose, for the local Postgres databases in
  [`docker-compose.yml`](docker-compose.yml). GoPayLocal needs Postgres 15 or
  newer; the compose services run 18.
- **TypeScript 7** comes with `pnpm install`. It has no compiler API, so
  `apps/web` (`astro check`) and the two SDKs (tsup's declaration build) alias
  `typescript` to TypeScript 6. Leave that alias in place.

You do not need a Cloudflare account for local development: `wrangler dev` runs
the API Worker locally, with local stand-ins for its KV namespaces.

## Setup

```sh
git clone https://github.com/RayLabsHQ/gopaylocal.git
cd gopaylocal
pnpm install
```

### Known pitfall: `sharp` on macOS with Homebrew `vips`

If Homebrew's `vips` is installed, `pnpm install` tries to build `sharp` (an
Astro dependency) from source against it and fails. Tell sharp to ignore the
global libvips:

```sh
SHARP_IGNORE_GLOBAL_LIBVIPS=1 pnpm install
```

### Local database and API configuration

```sh
# 1. Start the development database (Postgres 18 on localhost:5433).
docker compose up -d postgres

# 2. Apply the migrations in apps/api/drizzle.
DATABASE_URL=postgresql://gopaylocal:gopaylocal@localhost:5433/gopaylocal pnpm db:migrate

# 3. Create your local Worker config. The defaults work as-is for local
#    development; fill in OAuth credentials only if you need them.
cp apps/api/.dev.vars.example apps/api/.dev.vars

# 4. Build the banner bundle once. The API serves packages/banner/dist/banner.js
#    and will not start without it.
pnpm build:banner

# 5. Start everything (or use the per-app commands below).
pnpm dev
```

Locally the API Worker reaches Postgres through the `HYPERDRIVE` binding, whose
`localConnectionString` in `apps/api/wrangler.toml` points at the docker-compose
database above. `apps/api/.dev.vars` is gitignored; never commit it.

### Signing in locally

Public email sign-up is disabled, so you have two options:

- **OAuth.** Create a Google OAuth client or GitHub OAuth app with the callback
  `http://localhost:8787/api/auth/callback/google` (or `.../github`) and put
  the client ID and secret in `apps/api/.dev.vars`.
- **A seeded password user.** From `apps/api`, run the local-only seeding script
  (it is never deployed), then open `http://localhost:3000/login?pw=1`, which
  shows an email and password form under the OAuth buttons:

  ```sh
  cd apps/api
  DATABASE_URL=postgresql://gopaylocal:gopaylocal@localhost:5433/gopaylocal \
  BETTER_AUTH_SECRET="<the value from your .dev.vars>" \
  TEST_USER_EMAIL=you@example.com \
  TEST_USER_PASSWORD="$(openssl rand -base64 24)" \
  TEST_USER_NAME="Your Name" \
  pnpm tsx scripts/create-test-user.ts
  ```

The admin app (`localhost:3001`) requires `user.role = 'admin'`. Grant it to
your local user directly in the database:

```sh
docker compose exec postgres psql -U gopaylocal -d gopaylocal \
  -c "UPDATE \"user\" SET role = 'admin' WHERE email = 'you@example.com'"
```

## Commands

All commands run from the repository root.

| Command | What it does |
|---|---|
| `pnpm dev` | Runs every workspace's `dev` script in parallel |
| `pnpm dev:api` | API Worker via `wrangler dev` on `http://localhost:8787` |
| `pnpm dev:dashboard` | Merchant dashboard on `http://localhost:3000` |
| `pnpm dev:admin` | Admin dashboard on `http://localhost:3001` |
| `pnpm dev:web` | Marketing site (Astro) on `http://localhost:4321` |
| `pnpm dev:docs` | Docs site (Starlight) on `http://localhost:4322` |
| `pnpm build` | Builds every workspace that has a `build` script |
| `pnpm build:api` | Bundles the Worker into `apps/api/dist` (`wrangler deploy --dry-run`; nothing is deployed) |
| `pnpm build:dashboard` / `build:web` / `build:docs` | Builds one app |
| `pnpm build:banner` | Builds the banner bundle into `packages/banner/dist/banner.js` |
| `pnpm typecheck` | Type-checks every workspace that has a `typecheck` script, including the API's tests and scripts (`apps/api/tsconfig.test.json`), then the root e2e suite and configs (`tsconfig.e2e.json`) |
| `pnpm db:generate` | Generates a new migration from `apps/api/src/db/schema.ts` |
| `pnpm db:migrate` | Applies migrations to the database in `DATABASE_URL` |
| `pnpm test` | Runs all Vitest projects (shared, sdk, api and integration) |
| `pnpm test:watch` | Vitest in watch mode |
| `pnpm test:shared` | Unit tests for `packages/shared` |
| `pnpm test:sdk` | Unit tests for the banner and the JavaScript and React SDKs |
| `pnpm test:api` | Unit tests for `apps/api` |
| `pnpm test:integration` | API integration tests (needs the test database) |
| `pnpm db:test:up` | Starts the `postgres-test` database on `localhost:5434` |
| `pnpm db:test:migrate` | Applies migrations to the test database |
| `pnpm db:test:down` | Stops the docker-compose services (`docker compose down`) |
| `pnpm test:e2e` / `test:e2e:ui` | Playwright end-to-end tests |
| `pnpm clean` | Removes build output in every workspace |

## Tests

Vitest is configured in [`vitest.config.ts`](vitest.config.ts) with four
projects. Test files live next to the code they test:

- `*.test.ts` in `packages/shared` is the **shared** project.
- `*.test.ts(x)` in `packages/banner`, `packages/js-sdk` and `packages/react-sdk`
  is the **sdk** project (Node environment, no DOM).
- `*.test.ts` in `apps/api/src` is the **api** project (no database).
- `*.integration.test.ts` in `apps/api/src` is the **integration** project.

Unit tests need nothing but the install:

```sh
pnpm test:shared
pnpm test:sdk
pnpm test:api
```

Integration tests run the real route handlers against Postgres. They use the
`postgres-test` service from `docker-compose.yml` (Postgres 18 on port 5434,
stored in tmpfs, so its data is discarded when it stops):

```sh
pnpm db:test:up
pnpm db:test:migrate
pnpm test:integration
pnpm db:test:down   # note: stops all compose services, including the dev database
```

The integration tests read `DATABASE_URL` and fall back to
`postgresql://gopaylocal_test:gopaylocal_test@localhost:5434/gopaylocal_test`
(the value in `.env.test`). They truncate tables between tests, so they refuse
to start unless `DATABASE_URL` is a loopback host and a database whose name
contains `test` (see `apps/api/src/test/setup.ts`).

### Writing integration tests

Helpers live in [`apps/api/src/test/`](apps/api/src/test/):

- `createTestClient(app, env)` sends requests through a Hono app or the whole
  Worker (`import worker from "../index"`) with a stub `ExecutionContext`, and
  waits for every `waitUntil()` promise before returning, so background work
  (KV cache pushes, coupon generation, analytics writes) can be asserted.
  Pass `cf: { country: "IN" }` to set `request.cf`. Routes read the visitor's
  country only from `request.cf`, never from the spoofable `cf-ipcountry` header.
- `mountRoutes(routes, member)` mounts route modules behind an injected user
  and team role, to test a route's own logic.
- `seedTenant(client, name)` in `test/auth.ts` creates a real user (the way
  `scripts/create-test-user.ts` does), an organization it owns, and a real
  session cookie by signing in through the Worker. Use it with the full Worker
  to test authentication, roles and tenant isolation (`as(tenant)` builds the
  request headers).

A test that documents a known bug uses `it.fails(...)` with a comment naming
the file and the bug; remove `.fails` when the bug is fixed.

### End-to-end tests

The Playwright suite in `e2e/` needs the full local stack (local Postgres, the
API under `wrangler dev`, the dashboard) and is not run in CI. It seeds a fresh
password user per test directly into the local database and signs in through
`/login?pw=1`. [`e2e/README.md`](e2e/README.md) lists exactly what must be
running, the safety checks it performs, and how to start it against local
services only.

CI (`.github/workflows/ci.yml`) runs on every pull request and on pushes to
`main`: `pnpm install --frozen-lockfile`, `pnpm build:banner`, `pnpm typecheck`,
`pnpm test:shared`, `pnpm test:sdk`, `pnpm test:api`, the integration tests against a Postgres 18
service container, and `pnpm build:docs`.

## Repository layout

```
apps/
  api/        Hono API on Cloudflare Workers: REST API, auth (Better Auth),
              banner serving, provider integrations, webhooks, cron jobs
    drizzle/  SQL migrations generated by drizzle-kit (plus meta/ snapshots)
    scripts/  Local and deploy-time Node scripts (never part of the Worker)
  dashboard/  Merchant dashboard (React, TanStack Start in SPA mode)
  admin/      Platform admin dashboard (React, TanStack Start in SPA mode)
  web/        Marketing site (Astro)
  docs/       Documentation site (Astro Starlight)
packages/
  shared/     Types, constants (including plan limits), PPP data, Zod schemas
  banner/     The embeddable banner script (esbuild IIFE bundle)
  js-sdk/     @gopaylocal/js, the browser SDK
  react-sdk/  @gopaylocal/react, React provider, hooks and components
e2e/          Playwright end-to-end tests
```

Inside `apps/api/src`: `routes/` holds one Hono router per resource (mounted in
`index.ts`), `services/` holds business logic and the payment providers,
`lib/` holds small shared helpers (crypto, rate limiting, webhook signatures,
plan entitlements), `middleware/` holds session, team, admin and CORS
middleware, and `db/schema.ts` is the Drizzle schema.

## Adding a payment provider

Every provider implements one interface and is created through one factory.
Read [`apps/api/src/services/providers/types.ts`](apps/api/src/services/providers/types.ts)
and an existing provider (for example
[`polar.ts`](apps/api/src/services/providers/polar.ts)) before starting.

1. **Register the identifier.** Add it to the `IntegrationProvider` union in
   `packages/shared/src/types/index.ts` and to the `provider` enum of
   `createIntegrationSchema` in `packages/shared/src/validation/index.ts` (plus
   the provider list in `validation/index.test.ts`). If the provider needs an
   account, store or site ID on every call, require it in that schema's
   `superRefine`, as Chargebee and Whop do. The `integrations.provider`
   column is plain text, so no migration is needed.
2. **Implement `PaymentProvider`** in
   `apps/api/src/services/providers/<id>.ts`. Required: `name`,
   `createDiscount`, `deleteDiscount`, `listDiscounts` and `buildCheckoutUrl`.
   Optional: `listProducts` (product import) and the webhook methods
   `provisionWebhook`, `deleteWebhook`, `verifyWebhook`, `isHandshake` and
   `parseRedemption`.
   Things the existing providers get right:
   - Tag the discounts you create (the existing providers use metadata such as
     `{ gopaylocal: 'true' }`) so `listDiscounts` returns only GoPayLocal's.
   - `CreateDiscountParams.amount` is a 0-100 percentage or a fixed amount in
     cents; `RedemptionEvent` amounts are in the currency's smallest unit.
   - Convert every failure into `ProviderError`, `ProviderAuthError` or
     `ProviderNotFoundError` so callers can map them to HTTP responses.
   - Use `fetch` and WebCrypto (`crypto.subtle`); the code runs on Cloudflare
     Workers. Cite the provider's API reference in comments for anything
     non-obvious (field names, units, pagination).
3. **Wire it into the factory**: add a `case` to `createProvider` in
   `apps/api/src/services/providers/index.ts`.
4. **Coupon code rules.** If the provider restricts code characters or length,
   update `ALNUM_ONLY_PROVIDERS` or `CODE_MAX_LENGTH` in
   `apps/api/src/lib/coupon-code.ts`. Codes are generated there, not in the
   adapters, because the banner displays them.
5. **Webhooks (redemption tracking).** When an integration is connected,
   `routes/integrations.ts` calls `provisionWebhook` with
   `<API_BASE_URL>/v1/webhooks/<provider>/<integrationId>`, and
   `routes/webhooks.ts` handles deliveries to that path. Redemption tracking
   needs both `verifyWebhook` and `parseRedemption`. Providers that follow the
   Standard Webhooks spec use `lib/standard-webhooks.ts`; others use the HMAC
   helpers in `lib/webhook-verify.ts`. Add unit tests next to those files.
6. **Dashboard.** Add the provider to the list in
   `apps/dashboard/src/routes/dashboard/integrations/index.tsx` (name,
   description, API-key placeholder, docs link), add its label to
   `PROVIDER_LABELS` in `apps/dashboard/src/lib/api.ts`, and add a logo at
   `apps/dashboard/public/logos/<id>.svg`.
7. **Docs.** Add a page under `apps/docs/src/content/docs/integrations/` and
   link it from the docs sidebar (`apps/docs/src/sidebar.mjs`).
8. **Verify against the real provider** in test or sandbox mode, following
   [`apps/api/PROVIDER_VERIFICATION.md`](apps/api/PROVIDER_VERIFICATION.md),
   and include the results (redacted) in your pull request.

Please do not add a provider to marketing pages or claim support in the docs
until its integration is implemented and tested, and record what you checked in
`PROVIDER_VERIFICATION.md`, the maintainers' record of which providers have been run
against a real account. The README and the docs don't state verification status.

## Coding conventions

- **TypeScript everywhere**, with `strict` and `noUncheckedIndexedAccess` from
  `tsconfig.base.json`. Avoid `any` in new code.
- **Formatting:** two-space indentation, LF line endings and a final newline
  (see [`.editorconfig`](.editorconfig)). There is no shared formatter or linter
  config yet, so match the file you are editing: `apps/api` routes, `lib` and
  middleware use double quotes and semicolons; the provider adapters and the
  `packages/*` code use single quotes and semicolons; the dashboard and admin
  apps use single quotes without semicolons.
- **Validation:** request bodies are validated with the Zod schemas in
  `packages/shared/src/validation`, shared by the API and the dashboards.
- **Plan limits and entitlements:** limits live in `PLAN_LIMITS` in
  `packages/shared/src/constants/index.ts`. Resolve an organization's effective
  plan through `apps/api/src/lib/entitlements.ts`; do not read
  `subscriptions.plan` directly.
- **Database changes:** edit `apps/api/src/db/schema.ts`, run `pnpm db:generate`,
  and commit the generated SQL together with the updated files in
  `apps/api/drizzle/meta/`. Never edit a migration that has already shipped.
- **IDs** are ULIDs (`ulid()`).
- **Comments** explain why, not what. Many files open with a short block
  describing their constraints; keep those accurate when you change behaviour.
- **Tests** go next to the code. Add or update tests with every behaviour change.

## Commits and pull requests

- Keep pull requests focused on one change. Open an issue first for large
  changes or new features so the approach can be agreed before you write code.
- Write commit subjects as a short, specific sentence describing the change
  (for example "Coupon codes get a random suffix so cross-country guessing
  fails"). Use the body to explain why.
- Before opening a pull request, run `pnpm typecheck`, `pnpm test:shared`,
  `pnpm test:sdk` and `pnpm test:api`, plus the integration tests if you touched the API or the
  schema. CI runs all of them.
- Update the docs (`apps/docs`) when you change behaviour users can see.
- Never commit secrets, real API keys, `.dev.vars` files or customer data, and
  redact them from logs you paste into issues or pull requests.
- Fill in the pull request template. A maintainer reviews every pull request;
  this is a small team, so please allow a few days for a first response.

## Licensing of contributions

GoPayLocal is licensed per directory: everything under `apps/` is
[AGPL-3.0-only](LICENSE) and everything under `packages/` is
[MIT](packages/shared/LICENSE). See [LICENSING.md](LICENSING.md) for what that
means in practice.

Contributions are accepted under the same license as the files they change
(inbound equals outbound): by submitting a pull request, you agree that your
contribution to a file under `apps/` is licensed under AGPL-3.0-only and your
contribution to a file under `packages/` is licensed under the MIT License. You
also confirm that you have the right to submit it under that license. There is
no separate contributor license agreement to sign.
