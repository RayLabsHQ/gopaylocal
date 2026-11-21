## What this changes

<!-- A short description of the change and why it is needed. -->

Closes #

## How it was tested

<!-- Commands you ran and what you checked by hand. -->

- [ ] `pnpm typecheck`
- [ ] `pnpm test:shared` and `pnpm test:api`
- [ ] `pnpm test:integration` (if the API or the database schema changed)
- [ ] Checked the change in the running app (if it affects the UI or the banner)

## Checklist

- [ ] Docs in `apps/docs` are updated, or no user-visible behaviour changed.
- [ ] Schema changes include the migration from `pnpm db:generate` and the updated files in `apps/api/drizzle/meta/`.
- [ ] No secrets, real API keys, `.dev.vars` files or customer data are included.
- [ ] Payment provider changes were verified against the real provider in test mode, following `apps/api/PROVIDER_VERIFICATION.md`, and the redacted results are included below.

<!-- Provider verification results (if applicable): -->

---

By submitting this pull request, I confirm that my contribution is made under the license of the files it changes (AGPL-3.0-only for `apps/`, MIT for `packages/`), as described in [CONTRIBUTING.md](https://github.com/RayLabsHQ/gopaylocal/blob/main/CONTRIBUTING.md#licensing-of-contributions).
