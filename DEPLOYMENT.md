# Deploying GoPayLocal

The deployment guide lives in the docs, so there is one copy to keep current:

- **Self-hosting guide:** [docs.gopaylocal.com/self-hosting](https://docs.gopaylocal.com/self-hosting/)
  (source: [`apps/docs/src/content/docs/self-hosting/`](apps/docs/src/content/docs/self-hosting/)).
  It covers requirements and Cloudflare plans, the database and migrations, Cloudflare
  resources, configuration, OAuth, the first admin user, upgrading, and how self-hosted
  differs from the hosted service.
- **Configuration templates:** `wrangler.example.toml` next to each app's `wrangler.toml`
  ([`apps/api/wrangler.example.toml`](apps/api/wrangler.example.toml) is the one that
  matters). Every binding, variable and secret has a comment.
- **Local development:** [CONTRIBUTING.md](CONTRIBUTING.md).

## The hosted deployment (gopaylocal.com)

The hosted service runs the same steps as the self-hosting guide, with the committed
`wrangler.toml` files (the hosted resource ids) instead of the examples, and these
differences:

- `SELF_HOSTED = "false"` in `apps/api/wrangler.toml`, which turns on the Free and Pro
  plans (`PLAN_LIMITS` in `packages/shared/src/constants/index.ts`) and billing.
- Billing through Dodo Payments: secrets `DODO_API_KEY` and `DODO_WEBHOOK_SECRET`; vars
  `DODO_ENVIRONMENT` (`test_mode` or `live_mode`), `DODO_PRICE_ID_PRO_MONTHLY` and
  `DODO_PRICE_ID_PRO_ANNUAL` (the Pro products, $19/month and $180/year, managed in the
  Dodo dashboard).
- Dodo sends subscription webhooks to `https://api.gopaylocal.com/v1/webhooks/dodo`
  (`apps/api/src/routes/webhooks.ts`). Handled events: `subscription.active`,
  `subscription.renewed`, `subscription.plan_changed`, `subscription.on_hold`,
  `subscription.cancelled`, `subscription.expired`, `payment.failed`.
- The API is deployed with `pnpm run deploy:full` in `apps/api` (migrations, then
  `scripts/sync-admins.js` with `ADMIN_EMAILS`, then `wrangler deploy`), after
  `pnpm build:banner`. Migrations therefore reach the production database on every
  deploy, so each new migration must be safe to apply to the live schema. If a migration
  fails, `deploy:full` stops before the admin sync and the deploy, nothing from the
  migration run is applied (one transaction), and `scripts/migrate.ts`, which runs only
  when `drizzle-kit migrate` fails, prints the Postgres error, its SQLSTATE code, the
  migration file and line, and the failing statement.
