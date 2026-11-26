# Roadmap

Two lists. **Not built yet** is a statement about the code today: each item has been
checked against it, and the README and the docs do not describe these as available.
**Under consideration** is ideas, with no promise and no date.

## Not built yet

- **Checkout links with the discount already applied.** The banner shows the visitor a
  code. "Auto-apply" means your own checkout applies that code, using the SDK; GoPayLocal
  does not create hosted checkout links, and a campaign's `auto_apply` delivery setting
  does not change what the banner serves. The one way to skip codes today is a Dodo
  Payments campaign set to country prices at Dodo (`provider_price`), where Dodo charges
  each country's price by billing country.
- **A parity-group editor in the dashboard.** Parity groups (your own discount tiers)
  can be created and edited only through the API (`/v1/teams/:orgId/parity-groups`).
  A Group campaign in a workspace with no groups of its own uses the five default tiers.
- **Per-country percentages in the campaign form.** A Custom campaign's own percentage
  for each country (`discountOverrides`) can be set only through the API; the form saves
  the campaign without them.
- **Coupon prefix and allowed domains in the dashboard.** The API accepts a campaign's
  `couponPrefix` and `allowedDomains`; no dashboard screen sets them.
- **Editing and deleting products in the dashboard.** The dashboard lists and creates
  products. Editing and deleting go through the API
  (`PATCH` and `DELETE /v1/teams/:orgId/products/:id`).
- **Separate live and test API keys.** A key has no environment. Test mode is a setting
  on products and campaigns.
- **Analytics filters.** Analytics come as an overview and as breakdowns by country and
  by campaign over a date range. They cannot be narrowed to one campaign or country, and
  there is no Test view: banner events are recorded as Live.
- **A country override for testing.** The visitor's country comes only from Cloudflare
  (`request.cf.country`); no query parameter or header changes it.
- **Outgoing webhooks.** GoPayLocal receives webhooks from your payment platform; it
  sends none to you.
- **Team management in the dashboard beyond inviting.** Removing a member, changing a
  role, cancelling an invitation, renaming the workspace, leaving it and handing over
  ownership work through the API (Better Auth's `/api/auth/organization/*` routes), with
  the permissions in [`packages/shared/src/permissions`](packages/shared/src/permissions).
  The dashboard can invite people, copy invitation links, set a member's product access
  and delete the workspace.
- **Verification of every payment integration against a live merchant account.** Each of
  the nine integrations has unit and contract tests. Stripe, Gumroad and Dodo Payments
  have been checked against accounts kept for testing (creating, listing and deleting
  codes, and checkout links), but not yet with a test purchase or a redemption webhook.
  WooCommerce is checked end to end every night against a real store started in CI.
  Paddle, Chargebee, Polar, Whop and Creem have not been run against a real account. Progress is recorded per provider in
  [`apps/api/PROVIDER_VERIFICATION.md`](apps/api/PROVIDER_VERIFICATION.md). One open
  question there: whether a Whop checkout link pre-fills the code (the `promoCode`
  parameter appears in a Whop blog post, not in its API reference), so the docs tell
  Whop customers to type the code.
- **End-to-end browser tests in CI.** The Playwright suite in `e2e/` covers signing in
  and connecting Dodo Payments in test mode, and runs only locally against a full local
  stack.

## Under consideration

- A/B tests with a control arm that shows no discount, and a lift figure in the results.
  Today an experiment compares two discount campaigns.
- A/B tests limited to some countries. Today an experiment splits all of a product's
  visitors.
- Banner dismissals in analytics. The banner reports them, but only impressions, clicks
  and code copies are stored.
- Holiday deals for some countries only, and a deal added on top of a country's
  discount. Today a deal applies to every country, and a visitor is offered the larger of
  the deal and their country's discount.
- Holiday deals whose percentage changes from day to day, and a countdown in the banner.
  Today a deal has one percentage, and its message can name its last day.

Have a suggestion? Open an issue so it can be discussed before anyone writes code.
