# End-to-end tests (Playwright)

These tests drive the real merchant dashboard in Chromium against the real API
Worker running under `wrangler dev`, backed by a **local** Postgres. They are
not run in CI: they need the whole local stack, and the integrations test also
needs a Dodo Payments test-mode key. CI runs the API integration tests
(`pnpm test:integration`) instead, which cover the same server paths without a
browser.

| File | What it covers | Needs |
|---|---|---|
| `auth.test.ts` | Password test login at `/login?pw=1` lands on the dashboard; a wrong password shows an error | Local stack |
| `integrations.test.ts` | Connect Dodo Payments in test mode, then "Test" the connection | Local stack + `DODO_TEST_API_KEY` (skipped without it) |

## How accounts are created

Public email sign-up is disabled in the API (`emailAndPassword.disableSignUp`
in `apps/api/src/auth.ts`), so the suite cannot sign up through the API.
Instead, every test gets a fresh account seeded **directly into the local
database** by `support/seed-user.ts`. It creates the user the same way
`apps/api/scripts/create-test-user.ts` does (a Better Auth instance with
`allowEmailSignUp`), then an organization owned by that user. The password is
random per test (nothing is hardcoded). The `teamId` fixture then signs in
through the dashboard's test login form, `/login?pw=1`, exactly as a person
would.

Seeded users look like `e2e-<timestamp>-<hex>@example.test`, their
organizations have a slug starting with `e2e-`, and neither is deleted
afterwards. To clear the accounts from your local dev database (sessions and
credentials cascade with the user; rows a test created inside those
organizations, such as integrations, stay):

```sh
docker compose exec postgres psql -U gopaylocal -d gopaylocal -c \
  "DELETE FROM member WHERE \"organizationId\" IN (SELECT id FROM organization WHERE slug LIKE 'e2e-%');
   DELETE FROM organization WHERE slug LIKE 'e2e-%';
   DELETE FROM \"user\" WHERE email LIKE 'e2e-%@example.test';"
```

## Safety checks

`global-setup.ts` runs before any test and stops the run unless:

1. `E2E_DATABASE_URL` is a loopback database. It defaults to the docker-compose
   dev database, `postgresql://gopaylocal:gopaylocal@localhost:5433/gopaylocal`,
   which is the Hyperdrive `localConnectionString` in `apps/api/wrangler.toml`
   that `wrangler dev` uses.
2. The API (`http://localhost:8787/health`) and dashboard
   (`http://localhost:3000`) respond.
3. An account freshly seeded into `E2E_DATABASE_URL` can sign in through the
   running API. A brand-new random email only exists in that database, so this
   proves the API is using the same local database.

The seeding child process receives only `PATH` and its own `E2E_*` variables,
never your shell's other secrets.

## Running it

All commands run from the repository root.

1. **Local database** (Postgres 18 on `localhost:5433`) with migrations applied:

   ```sh
   docker compose up -d postgres
   DATABASE_URL=postgresql://gopaylocal:gopaylocal@localhost:5433/gopaylocal pnpm db:migrate
   ```

2. **Local API configuration.** `wrangler dev` loads `apps/api/.dev.vars`.
   It must contain local values only: create it from the example and keep
   `API_BASE_URL=http://localhost:8787` and `APP_BASE_URL=http://localhost:3000`.
   Never put production credentials (database URLs, provider or OAuth secrets)
   in this file, because everything in it is loaded by the local Worker.

   ```sh
   cp apps/api/.dev.vars.example apps/api/.dev.vars
   ```

3. **Build the banner bundle** (the API will not start without it) and
   **install Chromium** for Playwright, once:

   ```sh
   pnpm build:banner
   pnpm exec playwright install chromium
   ```

4. **Start the stack** in two terminals:

   ```sh
   pnpm dev:api        # API Worker on http://localhost:8787
   pnpm dev:dashboard  # dashboard on http://localhost:3000
   ```

   Or let Playwright start (or reuse) them by exporting `E2E_START_SERVERS=1`.
   Servers are never started implicitly, because `pnpm dev:api` loads
   `.dev.vars`.

5. **Run the suite:**

   ```sh
   pnpm test:e2e                 # headless, HTML report in playwright-report/
   pnpm test:e2e:ui              # Playwright UI mode
   ```

   To include the Dodo integration tests, export a Dodo **test-mode** API key
   from your own Dodo dashboard first: `export DODO_TEST_API_KEY=...`.

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `E2E_DATABASE_URL` | `postgresql://gopaylocal:gopaylocal@localhost:5433/gopaylocal` | Where accounts are seeded. Must be loopback and must be the database the local API uses. |
| `E2E_START_SERVERS` | unset | `1` lets Playwright start or reuse `pnpm dev:api` and `pnpm dev:dashboard`. |
| `DODO_TEST_API_KEY` | unset | Enables `integrations.test.ts`. Test-mode keys only. |

### Notes

- The API rate-limits auth POSTs per IP (`RL_AUTH_POST_IP`, 10 per minute in
  `wrangler.toml`). One run makes about five sign-ins, so back-to-back runs can
  hit it. Wait a minute if sign-in starts returning 429.
- Seeding runs `support/seed-user.ts` with plain Node 22.18+ (Node strips the
  types itself; the resolve hook is `support/ts-resolve.mjs`). It needs no
  extra dependency.
- Status: the fixtures, preflight and seeding were repaired without a running
  stack. The seeding script was run against a local Postgres, and
  `playwright test --list` loads the suite, but the browser flows themselves
  have not yet run end to end after this repair. If a selector no longer
  matches the dashboard, fix the test, not the safety checks.
