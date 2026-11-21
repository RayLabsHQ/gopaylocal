# Provider verification

GoPayLocal talks to nine payment providers through one interface
(`src/services/providers/types.ts`): Stripe, Paddle, Gumroad, Chargebee,
Dodo Payments, Polar, Whop, Creem and WooCommerce. Unit tests mock every HTTP call, so
they prove the code matches our reading of each provider's docs. They don't
prove the provider behaves that way.

`verify:provider` closes that gap. It drives one provider, through the same
factory the API uses (`createProvider()` in `src/services/providers/index.ts`),
against **your own sandbox account**. It creates a throwaway discount, reads it
back, builds a checkout URL you can buy with, provisions a webhook, and cleans
everything up. It can also replay a captured webhook delivery through the
production `verifyWebhook()` and `parseRedemption()` code.

None of the nine integrations (nor Stripe's Managed Payments mode) has been run against a real merchant account yet.
The status table below is the record. Update it when you run the tool.

- [Status](#status)
- [Before you start](#before-you-start)
- [What the tool checks](#what-the-tool-checks)
- [Safety](#safety)
- [Nightly checks](#nightly-checks)
- [Capturing and replaying a webhook](#capturing-and-replaying-a-webhook)
- Providers: [Stripe](#stripe) · [Paddle](#paddle-billing) · [Gumroad](#gumroad) · [Chargebee](#chargebee) · [Dodo Payments](#dodo-payments) · [Polar](#polar) · [Whop](#whop) · [Creem](#creem) · [WooCommerce](#woocommerce)
- [Adding a provider](#adding-a-provider)
- [Troubleshooting](#troubleshooting)

## Status

One row per provider, one column per operation. Change a cell only after a run
with real sandbox credentials. Put **Verified** (or **Fails: short reason**) in
the cell, and fill in the date, your name and the `code:` line the tool prints
in its header (commit plus whether the tree was dirty).

| Provider | List products | Create discount | List discounts | Checkout URL | Test purchase with discount | Provision webhook | Cleanup (delete + confirm) | Replay: verifyWebhook | Replay: parseRedemption | Date | Verifier | Commit |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Stripe | Not yet verified live | Not yet verified live | Not yet verified live | Not yet verified live | Not yet verified live | Not yet verified live | Not yet verified live | Not yet verified live | Not yet verified live | | | |
| Stripe Managed Payments (`--managed-payments`) | Same as Stripe | Same as Stripe | Same as Stripe | Not yet verified live (`mp-*` probes; promotion codes an open question) | Not yet verified live | Same as Stripe | Same as Stripe | Not yet verified live | Not yet verified live (`mp-delivery` too) | | | |
| Paddle | Not yet verified live | Not yet verified live | Not yet verified live | Not yet verified live | Not yet verified live | Not yet verified live | Not yet verified live | Not yet verified live | Not yet verified live | | | |
| Gumroad | Not yet verified live | Not yet verified live | Not yet verified live | Not yet verified live | Not yet verified live | Not yet verified live | Not yet verified live | Not yet verified live | Not yet verified live | | | |
| Chargebee | Not yet verified live (not implemented; reports SKIPPED) | Not yet verified live | Not yet verified live | Not yet verified live | Not yet verified live | Not yet verified live | Not yet verified live | Not yet verified live | Not yet verified live | | | |
| Dodo Payments | Not yet verified live | Not yet verified live | Not yet verified live | Not yet verified live | Not yet verified live | Not yet verified live | Not yet verified live | Not yet verified live | Not yet verified live | | | |
| Polar | Not yet verified live (not implemented; reports SKIPPED) | Not yet verified live | Not yet verified live | Not yet verified live | Not yet verified live | Not yet verified live | Not yet verified live | Not yet verified live | Not yet verified live | | | |
| Whop | Not yet verified live (not implemented; reports SKIPPED) | Not yet verified live | Not yet verified live | Not yet verified live | Not yet verified live | Not yet verified live | Not yet verified live | Not yet verified live | Not yet verified live | | | |
| Creem | Not yet verified live | Not yet verified live | Not yet verified live | Not yet verified live | Not yet verified live | Not yet verified live | Not yet verified live | Not yet verified live | Not yet verified live | | | |
| WooCommerce | Not yet verified live | Not yet verified live | Not yet verified live | Not yet verified live | Not yet verified live | Not yet verified live | Not yet verified live | Not yet verified live | Not yet verified live | | | |

"Test purchase with discount" is a manual step: open the printed URL, pay with
the provider's test card and confirm the discount was applied. The tool can't
check that for you.

## Before you start

- **Node 24.** The repo's `.nvmrc` pins it (`nvm use` from the repo root). The tool
  runs on Node's built-in TypeScript support, so there's no build step and no
  `tsx`. It needs Node 22.15 or newer and says so if your Node is older.
- **Dependencies installed:** `pnpm install` from the repo root.
- **A sandbox account of your own.** Never use a customer's account or credentials.
- **Credentials in environment variables only.** The tool never reads
  `apps/api/.dev.vars`, never accepts keys as flags, and never writes them
  anywhere. To keep keys out of your shell history, read them without echo:

  ```sh
  read -rs GPL_VERIFY_API_KEY && export GPL_VERIFY_API_KEY   # paste, press Enter (input hidden)
  # ...run the tool...
  unset GPL_VERIFY_API_KEY GPL_VERIFY_WEBHOOK_SECRET
  ```

| Variable | Used for |
|---|---|
| `GPL_VERIFY_API_KEY` | API key or access token (required, except for some replays) |
| `GPL_VERIFY_SITE_ID` | Chargebee site name (required) |
| `GPL_VERIFY_COMPANY_ID` | Whop company id `biz_…` (optional) |
| `GPL_VERIFY_ACCOUNT_ID` | Generic fallback for either account id above |
| `GPL_VERIFY_WEBHOOK_SECRET` | Webhook signing secret, only for `--replay` |

The account id ends up in `ProviderConfig.siteId`, the same way the dashboard's
connect flow (`src/routes/integrations.ts`) passes `providerAccountId`.

Full flag reference:

```sh
pnpm --filter @gopaylocal/api verify:provider --help
```

## What the tool checks

A verify run executes these steps in order. Each reports **PASS**, **FAIL**,
**SKIPPED** (the provider doesn't implement the method, or you didn't ask for
the step) or **BLOCKED** (a step it depends on failed, or you pressed Ctrl-C).

| Step | Calls | Passes when |
|---|---|---|
| `init` | `createProvider(name, config)` | The factory returns a provider. The step also lists which optional methods the provider implements. |
| `list-products` | `listProducts()` | It returns well-formed products (id, name, numeric or null price). SKIPPED if the provider has no `listProducts()`. |
| `create-discount` | `createDiscount()` for 17% (`--percent`) with a throwaway code | It returns a usable id, a code and the requested percent. |
| `list-discounts` | `listDiscounts()` | The new discount is listed under the same id, at the same percent. |
| `checkout-url` | `buildCheckoutUrl({ productId: --product, discountCode, discountId, successUrl })` | It returns an https URL. The tool prints it for a manual test purchase. |
| `provision-webhook` | `provisionWebhook(--webhook-url)` | It returns an endpoint id, and a signing secret unless the provider's webhooks are unsigned (Gumroad). Runs only with `--webhook-url`. |
| `delete-webhook` | `deleteWebhook(id)` | Cleanup. Runs even when an earlier step failed. |
| `delete-discount` | `deleteDiscount(id)` | Cleanup. Runs even when an earlier step failed. |
| `confirm-deleted` | `listDiscounts()` | The discount is gone from the list (checked 3 times over about 4 seconds). If the provider archives instead of deleting, `listDiscounts()` must hide archived items, otherwise `syncProviderCoupons()` keeps treating the coupon as live. |

Throwaway codes follow the production format (`generateCouponCode()` in
`src/lib/coupon-code.ts`) with prefix `VERIFY` and the reserved country
code `ZZ`, for example:
- `VERIFY-ZZ17-K7QX` for most providers
- `VERIFYZZ17K7QX` for Stripe, Paddle, Polar and Creem (`ALNUM_ONLY_PROVIDERS`): letters and digits only
- `GPL_VERIFY-ZZ17-K7QX` on Whop, where the provider adds its own `GPL_` tag

They're easy to spot and delete by hand if a run is ever cut off.

The run ends with a summary table and an exit status:

| Exit | Meaning |
|---|---|
| 0 | Every step passed or was skipped |
| 1 | At least one step failed |
| 2 | Usage or configuration error, or refused by the live-mode guard |
| 130 | Interrupted (Ctrl-C) |

**pnpm reports every non-zero status as 1.** To tell a refusal from a failure,
pass `--json` and read `ok` and `refused` from the report, or run the script with
`node` directly (copy the command from the `verify:provider` entry in
`apps/api/package.json` and run it from `apps/api`). With `--json`, use `pnpm -s`
so pnpm's banner doesn't land in front of the JSON on stdout. Progress goes to
stderr.

## Safety

**Credentials.** Credentials come only from the environment variables above.
Every line the tool prints, including the JSON report and provider error
messages that echo a key, passes through a redactor. The redactor replaces the
API key, account secrets and webhook secrets, plus their URL-encoded and
base64/Basic-auth forms, with a mask such as `sk_test_…4f2a [107 chars]`. The
only exception is `--print-secret`: it prints the newly provisioned webhook
secret once, on stderr, never into the JSON report.

**Live-mode guard.** A run goes ahead without `--allow-live` only when the tool
can positively establish that it targets a test or sandbox environment:

| Provider | How the tool tells test from live | Live host refused during a test run |
|---|---|---|
| Stripe | Key prefix: `sk_test_` / `rk_test_` vs `sk_live_` / `rk_live_` ([docs](https://docs.stripe.com/keys)) | None: test and live share `api.stripe.com`, and the key decides |
| Paddle | `--environment` (default `test` → `sandbox-api.paddle.com`). A `pdl_live_` / `pdl_sdbx_` prefix that contradicts it is refused ([docs](https://developer.paddle.com/api-reference/about/authentication)) | `api.paddle.com` |
| Gumroad | No sandbox: always live, so `--allow-live` is required | n/a |
| Chargebee | `--environment` (default `test`; the provider targets `{site}-test.chargebee.com`) | Any `*.chargebee.com` host not ending in `-test.chargebee.com` |
| Dodo Payments | `--environment` (default `test` → `test.dodopayments.com`). A `dodo_live_` / `dodo_test_` prefix that contradicts it is refused ([docs](https://docs.dodopayments.com/miscellaneous/test-mode-vs-live-mode)) | `live.dodopayments.com` |
| Polar | `--environment` (default `test` → `sandbox-api.polar.sh`) | `api.polar.sh` |
| Whop | `--environment` (default `test` → `sandbox-api.whop.com`) | `api.whop.com` |
| Creem | `--environment` (default `test` → `test-api.creem.io`). A `creem_test_` key with `--environment live` is refused; live keys have no distinct prefix ([test mode](https://docs.creem.io/getting-started/test-mode), [key prefix](https://docs.creem.io/integrations/linkjolt)) | `api.creem.io` |
| WooCommerce | No test mode: always live, so `--allow-live` is required | n/a (the API is the merchant's own store) |

How the guard behaves:
- **Two layers.** First the decision above. Then, during a test run, a network
  guard refuses TLS connections to the live hosts in the right-hand column
  before any DNS lookup. A provider that ignored `environment` would fail loudly
  (a `network-guard` FAIL row) instead of touching live data. Every run prints
  the hosts it contacted.
- **Contradictions are refused** even with `--allow-live`, for example a live key
  with `--environment test`, or a `-test` Chargebee site with
  `--environment live`. They mean you're mistaken about what you're pointing at.
- **Using live credentials deliberately:** `--environment live --allow-live`, or
  just `--allow-live` for Gumroad and Stripe live keys.
- **Unprofiled providers.** A provider that's registered in the factory but has
  no entry in `scripts/verify-provider/profiles.ts` (Creem and WooCommerce, once
  they land) still runs, but always needs `--allow-live`.

**Cleanup.** Cleanup always runs, even after a failed step or an unexpected
error. The first Ctrl-C stops the checks and runs cleanup. A second Ctrl-C
aborts cleanup and prints the commands for whatever is left over. If you want
to look at things in the provider dashboard first:
- `--wait` pauses before cleanup until you press Enter. Use it for the test purchase.
- `--keep` skips cleanup and prints the delete commands.
- Leftovers can be removed later:

  ```sh
  pnpm --filter @gopaylocal/api verify:provider <provider> --delete-discount <id> --delete-webhook <id>
  ```

**Webhook URLs.** `--webhook-url` must be an https URL that exists only for this
test, typically a tunnel to `--capture`. Cleanup deletes the endpoint it
provisioned, and Gumroad's `provisionWebhook()` adopts an existing subscription
with the same URL instead of creating a new one. The tool refuses GoPayLocal
endpoints (`*.gopaylocal.com`, or any `/v1/webhooks/...` path), so a test run
can never delete a real integration's subscription.

**What the tool never does.** It never touches the database, KV or any deployed
worker. The only file it writes is the `--capture` output: a new file (never an
overwrite) with mode 0600.

## Nightly checks

`.github/workflows/provider-checks.yml` runs the checks above for every provider
each night, and on demand:

```sh
gh workflow run provider-checks.yml                      # all providers
gh workflow run provider-checks.yml -f provider=stripe   # one provider
gh workflow run provider-checks.yml -f dry_run=true      # check the settings only, no API calls
```

Each provider is a separate job, and its report (the same PASS / FAIL table)
appears on the run's summary page. A failed night emails whoever last changed
the workflow's schedule.

**Turning a provider on.** Add repository secrets (Settings > Secrets and
variables > Actions). `<PROVIDER>` is `STRIPE`, `PADDLE`, `GUMROAD`,
`CHARGEBEE`, `DODOPAYMENTS`, `POLAR`, `WHOP`, `CREEM` or `WOOCOMMERCE`:

| Secret | Value |
|---|---|
| `VERIFY_<PROVIDER>_API_KEY` | The sandbox API key, as in the provider's section below. Without it the provider is reported as "not set up" and the night still passes |
| `VERIFY_<PROVIDER>_PRODUCT` | The id to build a checkout URL for (what `--product` takes). Optional, except for Gumroad and WooCommerce, where it is required |
| `VERIFY_<PROVIDER>_ACCOUNT_ID` | Chargebee: the site name. WooCommerce: the store URL. Whop: the company id (optional) |

```sh
gh secret set VERIFY_STRIPE_API_KEY      # paste the key when asked; it is not echoed
```

**What it covers.** list-products, create-discount, list-discounts,
checkout-url, delete-discount and confirm-deleted. It does not buy anything
and does not provision a webhook, so "Test purchase with discount",
"Provision webhook" and the two replay columns of the status table still need
a run by hand.

**Keys.** The workflow runs only on its schedule and on manual runs, never for
pull requests, so code from a fork cannot reach the secrets. This repository's
workflow logs are public: the tool masks credentials, but product names and
discount codes from the sandbox account appear in them. For every provider
with a sandbox the tool refuses a live key. Gumroad and WooCommerce have no
sandbox; give those two a key from an account or store that exists only for
testing, never one that sells to real buyers.

GitHub pauses scheduled workflows in a repository with no activity for 60 days;
the Actions page then shows a button to turn them back on.

## Capturing and replaying a webhook

Most providers' delivery logs show the payload, but none of the docs we checked
promise to show the raw request headers, and the signature lives in the headers.
So the tool includes a one-shot receiver that writes the exact headers and raw
body of the first delivery it gets.

You need three terminals and a tunnel. Cloudflare's Quick Tunnels need no
account ("You do not need a Cloudflare account or domain") and are meant for
testing and development
([docs](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/);
[install `cloudflared`](https://developers.cloudflare.com/tunnel/downloads/)).
Any other tunnel works too.

```sh
# Terminal 1: wait for one delivery (writes a NEW file; pick a path outside the repo)
pnpm --filter @gopaylocal/api verify:provider --capture ~/gpl-verify/stripe-delivery.json

# Terminal 2: expose the receiver (default port 8787, which is also wrangler dev's default;
# pass --port to --capture if 8787 is taken)
cloudflared tunnel --url http://localhost:8787
#   → prints a temporary https://<random>.trycloudflare.com URL

# Terminal 3: the verify run, pointed at the tunnel
pnpm --filter @gopaylocal/api verify:provider stripe --product price_... \
  --webhook-url https://<random>.trycloudflare.com/hook --print-secret --wait
```

Then:
1. Note the secret printed under `--print-secret`.
2. Open the checkout URL from terminal 3 and complete a test purchase with the
   provider's test card (see each provider below).
3. Terminal 1 writes the delivery and exits.
4. Press Enter in terminal 3 to clean up. The webhook endpoint is deleted, but
   the captured delivery still verifies offline with the secret you noted.
5. Replay it:

```sh
read -rs GPL_VERIFY_WEBHOOK_SECRET && export GPL_VERIFY_WEBHOOK_SECRET   # the secret from step 1
pnpm --filter @gopaylocal/api verify:provider stripe --replay ~/gpl-verify/stripe-delivery.json \
  --expect-code VERIFY-ZZ17-K7QX
```

The receiver answers `GET` and `HEAD` with 200, records the first
`POST`/`PUT`/`PATCH` (any path), answers it with 200 and exits. The capture file holds the test purchase's payload, which can include
the test customer's email. Delete it when you're done.

A replay file is JSON with exactly the bytes the provider sent:

```json
{ "headers": { "webhook-id": "...", "webhook-timestamp": "...", "webhook-signature": "..." }, "rawBody": "{...}" }
```

`headers` may also be a list of `[name, value]` pairs. `rawBody` must be the raw
string: re-serialised JSON won't verify.

Replay steps:

| Step | Passes when |
|---|---|
| `load-delivery` | The file parses. Shows the signed timestamp when the scheme has one. |
| `verify-webhook` | `verifyWebhook()` accepts the delivery. Every timestamped scheme here (Stripe, Paddle, Standard Webhooks) rejects deliveries older than about 5 minutes. For an older capture the tool also evaluates the signature at the delivery's own timestamp (by pinning the clock) and reports "INVALID now; valid at the delivery's timestamp". That's the expected result for a replay. `--at <unix seconds or ISO time>` picks the instant explicitly. |
| `reject-wrong-secret` | The same delivery is rejected with a one-character-different secret, which proves verification actually checks the secret. SKIPPED for unsigned providers (Gumroad). |
| `parse-redemption` | `parseRedemption()` returns a redemption with an event id, a code or provider id, integer minor-unit amounts and an ISO currency. It prints the parsed object. `--expect-code <code or id>` also checks attribution (case-insensitive). For a delivery that should **not** count, such as an undiscounted purchase, pass `--expect-none`. |

When replaying, the tool constructs the provider with `--environment` (default
`test`), whereas the production webhook route (`src/routes/webhooks.ts`) always
constructs it as `live`. That only matters for Gumroad, whose `parseRedemption()`
calls the provider API. For Gumroad, replay needs `GPL_VERIFY_API_KEY`, and the
live-mode guard applies.

---

## Stripe

**Sandbox.** For new integrations Stripe recommends "general sandboxes" over the
legacy test mode. Create up to five from the
[Sandboxes page](https://dashboard.stripe.com/sandboxes). Each sandbox has its
own keys and account id
([sandboxes](https://docs.stripe.com/sandboxes),
[testing use cases](https://docs.stripe.com/testing-use-cases),
[keys](https://docs.stripe.com/keys)).

**Credentials.** With the sandbox selected, open
[API keys](https://dashboard.stripe.com/apikeys) and copy the secret key
(`sk_test_…`), or create a restricted key (`rk_test_…`)
([keys](https://docs.stripe.com/keys)).
- **Restricted keys** are Stripe's recommendation, but the pages we checked
  don't name the permissions for coupons, promotion codes, products, prices or
  Checkout Sessions. Stripe suggests starting broad in a sandbox and narrowing
  from the 403s in the key's request log
  ([restricted keys](https://docs.stripe.com/keys/restricted-api-keys)).
- **Webhook provisioning** needs "Webhook Endpoints, Event Destinations: Write"
  ([manage endpoints](https://docs.stripe.com/events/manage-webhook-endpoints)).

| Env var | Value |
|---|---|
| `GPL_VERIFY_API_KEY` | `sk_test_…` or `rk_test_…` |

**Prepare.** Create a product with a price in the sandbox.

**Run.**

```sh
pnpm --filter @gopaylocal/api verify:provider stripe --product price_... \
  --webhook-url https://<tunnel>/hook --print-secret --wait
```

`--product` takes a Price id, or a Product id (`prod_…`, which uses its default
price). `list-products` prints Product ids.

**What the provider does** (`src/services/providers/stripe.ts`):

| Method | What it does |
|---|---|
| `createDiscount` | Creates a coupon whose id is the code, plus a promotion code with the same code |
| `listDiscounts` | Lists the coupons tagged `metadata.gopaylocal = "true"` that can still be redeemed (`valid` is not false, so expired and used-up coupons are left out) |
| `buildCheckoutUrl` | Creates a Checkout Session with the coupon applied |
| `provisionWebhook` | Subscribes to `checkout.session.completed` and `checkout.session.async_payment_succeeded`, and returns the endpoint's `whsec_…` secret |
| `deleteDiscount` | Deletes the coupon |

**Test purchase.** Open the printed `checkout.stripe.com` URL. The discount
should already be applied. Pay with `4242 4242 4242 4242`, any future expiry and
any CVC ([testing](https://docs.stripe.com/testing)).

**Webhook capture and replay.** Deliveries carry `Stripe-Signature: t=…,v1=…`,
an HMAC-SHA256 over `t.rawBody` with the endpoint secret, with a default
5-minute tolerance
([webhooks](https://docs.stripe.com/webhooks)). Workbench shows each endpoint's
Event deliveries, but the docs don't say it shows raw headers, so use
`--capture`. Two alternatives:
- `stripe listen --forward-to localhost:8787/hook` prints its **own**
  `whsec_…` secret, different from the dashboard endpoint's. Replay with that one.
- Redeliver a past event from the Dashboard (up to 15 days) or with
  `stripe events resend <event_id> --webhook-endpoint=<endpoint_id>` (up to 30 days)
  ([webhooks](https://docs.stripe.com/webhooks)).

```sh
read -rs GPL_VERIFY_WEBHOOK_SECRET && export GPL_VERIFY_WEBHOOK_SECRET   # the whsec_… from --print-secret
pnpm --filter @gopaylocal/api verify:provider stripe --replay delivery.json --expect-code <code>
```

The other providers' replays below assume `GPL_VERIFY_WEBHOOK_SECRET` is set the
same way, to the secret `--print-secret` showed.

**What a pass looks like.** All of these PASS:
- verify run: `init`, `list-products`, `create-discount`, `list-discounts`,
  `checkout-url`, `provision-webhook`, `delete-webhook`, `delete-discount`,
  `confirm-deleted`
- replay: `load-delivery`, `verify-webhook`, `reject-wrong-secret`,
  `parse-redemption`

The parsed redemption's amounts should match what you paid. For a $100 price
at 17% with no tax that's `chargedAmountCents: 8300`, `taxAmountCents: 0`,
`discountAmountCents: 1700`, `currency: "usd"` (Stripe's lowercase code). If tax was charged,
`chargedAmountCents` includes it and `taxAmountCents` shows how much.

**Only a real run will show:**
- Whether the promotion-code request shape is accepted for the API version the
  SDK pins. Stripe's current reference documents `promotion[coupon]`
  ([promotion codes](https://docs.stripe.com/api/promotion_codes/create)).
- What happens to a promotion code after its coupon is deleted (undocumented).
- That the extra `v0` signature Stripe adds to sandbox deliveries
  ([webhooks](https://docs.stripe.com/webhooks)) is ignored.

### Stripe Managed Payments

Status: **Not yet verified live.** [Managed Payments](https://docs.stripe.com/payments/managed-payments)
(Stripe as merchant of record) is opted into per Checkout Session with
`managed_payments[enabled]=true`
([set up](https://docs.stripe.com/payments/managed-payments/set-up)). Stripe's
list of parameters a managed session rejects does not include `discounts` or
`allow_promotion_codes`
([update-checkout](https://docs.stripe.com/payments/managed-payments/update-checkout#remove-unsupported-parameters)),
but no page says promotion codes are supported. `--managed-payments` answers
three questions against a real test account:

1. Does a promotion code attach to a Managed Payments session?
2. Does it show in the completed-session webhook?
3. What do the tax and currency fields look like?

**Account.** Managed Payments needs a business based in a
[supported location](https://docs.stripe.com/payments/managed-payments/eligibility#supported-business-locations)
(US, CA, most of Europe, AU, HK, JP, SG; not India), the feature activated at
[Settings > Managed Payments](https://dashboard.stripe.com/settings/managed-payments),
and a direct account (not Connect). Use that account's test mode or a sandbox.

**Product.** `--product` is required and must be a Price or Product whose
product has an
[eligible tax code](https://docs.stripe.com/payments/managed-payments/eligibility#eligible-tax-codes),
for example `txcd_10103001` (SaaS, business use).

```sh
# 1. Terminal A: wait for one delivery
pnpm --filter @gopaylocal/api verify:provider --capture ~/gpl-verify/stripe-mp-delivery.json
# 2. Terminal B: probe, then pause before cleanup so you can buy
pnpm --filter @gopaylocal/api verify:provider stripe --managed-payments --product price_... \
  --webhook-url https://<tunnel-host>/hook --print-secret --wait
# 3. Open the "promotion code … pre-applied" URL it prints, enter a French
#    billing address, pay with 4242 4242 4242 4242, then press Enter in terminal B.
# 4. Replay the capture (GPL_VERIFY_WEBHOOK_SECRET set as above)
pnpm --filter @gopaylocal/api verify:provider stripe --replay ~/gpl-verify/stripe-mp-delivery.json \
  --managed-payments --expect-code <code>
```

Every session the probes create uses the customer email
`gopaylocal-verify+location_FR@example.com`, Adaptive Pricing's documented way
to show the page in a country's currency
([testing](https://docs.stripe.com/payments/currencies/localize-prices/adaptive-pricing?payment-ui=stripe-hosted#testing)).
The probes replace `checkout-url`; the other verify steps run as usual.

| Step | Answers | PASS means |
|---|---|---|
| `mp-session` | Can this account and product create a managed session at all (the control) | Stripe created it and echoed `managed_payments.enabled: true`. If it FAILs, the other probes are BLOCKED, since a discount failure would say nothing. The FAIL detail lists the setup requirements above. |
| `mp-promotion-code` | Question 1, as GoPayLocal attaches codes (`discounts[0][promotion_code]`) | Stripe accepted it, `session.discounts` names the promotion code, and `amount_total` is below the control's. A FAIL that says "REJECTED" means pre-applied promotion codes don't work on managed sessions. |
| `mp-coupon` | Question 1, by coupon id (`discounts[0][coupon]`) | Accepted, and `session.discounts` names the coupon |
| `mp-customer-code` | Whether `allow_promotion_codes=true` is accepted | Accepted. Whether the field shows and takes the code is a manual check on the printed URL. |
| `mp-delivery` (replay) | Questions 2 and 3 | The delivery is from a managed session and carries the discount (or none, with `--expect-none`). It prints `managed_payments`, `currency`, `amount_subtotal`, `amount_total`, `total_details`, `presentment_details`, `discounts`, `automatic_tax` and whether tax was added on top of or contained in the prices. |

`parse-redemption` in the same replay should show `taxAmountCents` equal to
`total_details.amount_tax`, and amounts in the price's currency, not
`presentment_details`.

`--dry-run` lists these steps and makes no call.

## Paddle Billing

**Sandbox.** Sign up separately at
[sandbox-vendors.paddle.com/signup](https://sandbox-vendors.paddle.com/signup).
"Sandbox and live accounts have the same features and APIs but separate
datasets, credentials, and dashboards." Website approval isn't required in
sandbox, and the default payment link can be any domain
([sandbox](https://developer.paddle.com/build/tools/sandbox)).

**Credentials.** In the sandbox dashboard, create an API key (Authentication
settings, API keys tab, New API key). It's shown only once
([API keys](https://developer.paddle.com/api-reference/about/api-keys)).
- **Format.** Keys created since 6 May 2025 look like `pdl_sdbx_apikey_…`. Older
  keys have no prefix
  ([authentication](https://developer.paddle.com/api-reference/about/authentication)).
- **Permissions** (`.write` includes `.read`;
  [permissions](https://developer.paddle.com/api-reference/about/permissions)):
  `discount.write`, `product.read`, `price.read`, `transaction.write` (checkout)
  and `notification_setting.write` (webhooks).

| Env var | Value |
|---|---|
| `GPL_VERIFY_API_KEY` | `pdl_sdbx_apikey_…` |

**Prepare.**
1. Create a product with a price.
2. **Set a default payment link:** Paddle > Checkout > Checkout configuration >
   Default payment link. Any domain, including localhost, works in sandbox.
   Paddle can't create transactions without one, and `checkout-url` fails with
   `transaction_default_checkout_url_not_set`
   ([default payment link](https://developer.paddle.com/build/transactions/default-payment-link),
   [error](https://developer.paddle.com/errors/transactions/transaction_default_checkout_url_not_set)).
3. The checkout URL Paddle returns is your default payment link with
   `?_ptxn=txn_…` appended
   ([pass a transaction to checkout](https://developer.paddle.com/build/transactions/pass-transaction-checkout)).
   The page at that link must load **Paddle.js**, initialised with a sandbox
   client-side token, which opens checkout for the `_ptxn` transaction. Without
   it the test purchase can't happen
   ([default payment link](https://developer.paddle.com/build/transactions/default-payment-link)).

**Run.**

```sh
pnpm --filter @gopaylocal/api verify:provider paddle --product pri_... \
  --webhook-url https://<tunnel>/hook --print-secret --wait
```

`--product` takes a Price id, or a Product id (`pro_…`, which uses its first
active price). `list-products` prints Product ids.

**What the provider does** (`paddle.ts`):

| Method | What it does |
|---|---|
| `createDiscount` | Uses a letters-and-digits code (Paddle allows `^[a-zA-Z0-9]{1,32}$`; [create discount](https://developer.paddle.com/api-reference/discounts/create-discount)) |
| `buildCheckoutUrl` | Creates a transaction with the discount id |
| `provisionWebhook` | Creates a notification setting for `transaction.completed` with traffic source `all`, so the simulator can reach it, and returns a `pdl_ntfset_…` secret |
| `deleteDiscount` | Archives the discount. Paddle has no delete ([discounts](https://developer.paddle.com/api-reference/discounts/overview)). `listDiscounts()` lists active discounts only, and also leaves out ones past `expires_at` or at their `usage_limit`, so `confirm-deleted` should still pass. |

**Test purchase.** On your payment-link page, pay with `4242 4242 4242 4242`,
any name and a future expiry. Checkout shows a "Test Mode" watermark
([sandbox](https://developer.paddle.com/build/tools/sandbox)).

**Webhook capture and replay.** Deliveries carry `Paddle-Signature: ts=…;h1=…`,
an HMAC-SHA256 over `ts:rawBody`
([signature verification](https://developer.paddle.com/webhooks/signature-verification)).
- **Simulator.** Paddle > Events > Simulations sends signed sample events to the
  destination
  ([simulator](https://developer.paddle.com/webhooks/simulator/test-webhooks/)).
  A simulated `transaction.completed` won't carry your discount, so replay it
  with `--expect-none` or just check `verify-webhook`.
- **Replay a real delivery** within 90 days via
  `POST /notifications/{id}/replay`
  ([replay](https://developer.paddle.com/api-reference/notifications/replay-notification)).
- **What counts as a redemption.** The provider only counts transactions whose
  `origin` is `web` or `api`.

**What a pass looks like.** Every verify and replay step PASSes, as for Stripe.
The parsed code is the alphanumeric form, for example `VERIFYZZ17K7QX`.

**Only a real run will show:**
- That the create-transaction response carries `checkout.url`. The docs imply it
  but the response schema we read was truncated.
- Which `origin` a checkout-created transaction reports.

## Gumroad

**No sandbox.** Neither Gumroad's API docs nor its help center mention a sandbox
or test mode. The only test mechanism is a seller test purchase
([testing a purchase](https://gumroad.com/help/article/62-testing-a-purchase.html)).
Every call acts on your real store, so the tool:
- requires `--allow-live`
- requires `--product`, and scopes the throwaway offer code to that one product
  instead of creating a `universal` code valid on everything you sell

Prefer a product buyers don't see, and keep runs short. The code exists until
cleanup, or longer with `--wait` or `--keep`.

**Credentials.** On your Gumroad application page, click "Generate access
token" ([API](https://gumroad.com/api)). Scopes:
- `edit_products` for offer codes
- `view_sales` for sale lookups, which Gumroad also requires to subscribe to sales

| Env var | Value |
|---|---|
| `GPL_VERIFY_API_KEY` | The access token |

**Run.**

```sh
pnpm --filter @gopaylocal/api verify:provider gumroad --allow-live --product <product id> \
  --webhook-url https://<tunnel>/hook --wait
```

There's no `--print-secret`, because Gumroad webhooks have no secret.

**What the provider does:**

| Method | What it does |
|---|---|
| `createDiscount` | Creates a `percent` offer code on the product |
| `buildCheckoutUrl` | Returns the product URL with the code as a path segment plus `?wanted=true`. Gumroad documents both `https://username.gumroad.com/{ProductID}/{DiscountCode}` ([URL parameters](https://gumroad.com/help/article/270-url-parameters)) and `?wanted=true` to open the payment form ([direct to payment form](https://gumroad.com/help/article/144-send-customers-directly-to-your-payment-form)). |
| `provisionWebhook` | Creates a `sale` resource subscription, or adopts an existing one with the same URL |

**Test purchase.** Stay logged in as the seller and open the URL. "You will not
be charged for anything you buy from yourself while logged into your account."
Gumroad warns against paying for your own product with a real card, which can
look like fraud
([testing a purchase](https://gumroad.com/help/article/62-testing-a-purchase.html)).

**Webhook capture and replay.** Resource-subscription pings are form-encoded
POSTs that are **not signed**. Pings caused by your own purchase, and test
events, carry `test=true`. `POST /resource_subscriptions/:id/test_event` sends a
test event (Gumroad's [ping](https://gumroad.com/ping) and
[API](https://gumroad.com/api) docs, read from their open-source
[app source](https://github.com/antiwork/gumroad/blob/main/app/javascript/pages/Public/Ping.tsx)).
- `verifyWebhook()` returns true by design. Authenticity comes from the
  unguessable URL plus `parseRedemption()` re-fetching the sale through the
  authenticated API.
- So replay needs no secret, but it does need the token, and therefore
  `--allow-live`:

```sh
pnpm --filter @gopaylocal/api verify:provider gumroad --allow-live --replay delivery.json
```

**What a pass looks like.**
- Verify run: every step PASSes.
- Replay: `verify-webhook` PASSes (by design), `reject-wrong-secret` is SKIPPED
  (unsigned) and `parse-redemption` PASSes with the sale's amounts.

**Only a real run will show:**
- Whether a seller test purchase applies the offer code and fires the `sale`
  resource-subscription ping.
- Whether `GET /sales/:id` returns test sales.
- Whether the combined `/{code}?wanted=true` form works. The docs list each part
  separately.

## Chargebee

**Test site.** Every account has a Test Site ("a sandbox environment where you
can try Chargebee") alongside its Live Site
([sites](https://www.chargebee.com/docs/billing/2.0/getting-started/sites-intro)),
created automatically at sign-up
([getting started](https://apidocs.chargebee.com/docs/api/getting-started)).

**Credentials.** Test and live API keys are distinct. Create one in the test site
under Settings > Configure Chargebee > API Keys and Events > API keys > Add API
Key, choosing a full-access key
([API keys](https://www.chargebee.com/docs/billing/2.0/site-configuration/api_keys)).

| Env var | Value |
|---|---|
| `GPL_VERIFY_API_KEY` | The test site's full-access key |
| `GPL_VERIFY_SITE_ID` | The site name: the `{site}` in `{site}.chargebee.com`. A full URL also works. |

In test mode the provider targets `{site}-test.chargebee.com`, appending `-test`
if your value lacks it. Chargebee's API docs use `acme-test` as the example, but
its sign-up guide shows a site without the suffix, and the docs never say test
sites always end in `-test`
([getting started](https://apidocs.chargebee.com/docs/api/getting-started),
[sign-up](https://www.chargebee.com/docs/billing/2.0/kb/getting-started/chargebee-signup-email-verification-account-claim-process)).
If your test site's host doesn't end in `-test`, the first call fails, and
that's a finding to report.

**Prepare.**
- A Product Catalog 2.0 **plan** item with an item price. The first checkout
  item "must be an `item_price` of item_type `plan`"
  ([checkout](https://apidocs.chargebee.com/docs/api/hosted_pages/create-checkout-for-a-new-subscription)).
- The Test Gateway enabled.
- A free webhook slot: a site allows up to five webhook endpoints
  ([webhook endpoints](https://apidocs.chargebee.com/docs/api/webhook_endpoints)).

**Run.**

```sh
pnpm --filter @gopaylocal/api verify:provider chargebee --product <item price id> \
  --webhook-url https://<tunnel>/hook --print-secret --wait
```

**What the provider does:**

| Method | What it does |
|---|---|
| `listProducts` | Not implemented, so `list-products` is SKIPPED. Take the item price id from the dashboard. |
| `createDiscount` | Uses `coupons/create_for_items` ([create coupon](https://apidocs.chargebee.com/docs/api/coupons/create-a-coupon-for-items)) |
| `buildCheckoutUrl` | Creates a hosted checkout with `coupon_ids` |
| `provisionWebhook` | Creates an endpoint for `payment_succeeded`, protected by HTTP Basic credentials it generates. The secret it returns is `username:password`. |
| `deleteDiscount` | Deletes an unused coupon. A coupon linked to subscriptions or invoices is archived instead ([delete coupon](https://apidocs.chargebee.com/docs/api/coupons/delete-a-coupon)). `listDiscounts()` lists active coupons only. |

**Test purchase.** Use a Test Gateway card such as `4111 1111 1111 1111`. "You
can use any 3/4 digit numbers when prompted for CVV and any valid date in the
future for expiry date"
([test gateway](https://www.chargebee.com/docs/payments/2.0/payment-gateways-and-configuration/chargebee-test-gateway)).

**Webhook capture and replay.** Chargebee doesn't sign webhooks and recommends
protecting the URL with Basic auth
([webhook settings](https://www.chargebee.com/docs/billing/2.0/site-configuration/webhook_settings)).
- **What's checked.** The capture records the `Authorization` header, and
  `verifyWebhook()` compares it with the `username:password` secret. There's no
  timestamp, so there's no replay window.
- **Resend** from Logs > Events
  ([resend](https://www.chargebee.com/docs/billing/2.0/kb/platform/how-do-i-find-failed-webhooks-and-resend-them)).
- **Replay** needs `GPL_VERIFY_SITE_ID` as well, because the constructor requires it:

```sh
pnpm --filter @gopaylocal/api verify:provider chargebee --replay delivery.json
```

`parseRedemption()` counts a subscription invoice only when it's the first one,
plus non-recurring invoices, and only coupon discounts.

**What a pass looks like.** Every step PASSes except `list-products` (SKIPPED).

**Only a real run will show:**
- The `payment_succeeded` payload shape (the event-types docs page returned 404).
- Whether amounts are in minor units.
- The test-site naming question above.

## Dodo Payments

**Test mode.** Toggle the **Live Mode** switch in the dashboard sidebar.
Products, API keys and webhooks belong to the mode they're created in
([test vs live](https://docs.dodopayments.com/miscellaneous/test-mode-vs-live-mode)).

**Credentials.** In test mode, go to Developer > API Keys > Create New Key. The
key is shown once
([API intro](https://docs.dodopayments.com/api-reference/introduction)). "Test
mode API keys start with `dodo_test_`"
([test vs live](https://docs.dodopayments.com/miscellaneous/test-mode-vs-live-mode)).

| Env var | Value |
|---|---|
| `GPL_VERIFY_API_KEY` | `dodo_test_…` |

**Prepare.** Create a product (`pdt_…`) in test mode.

**Run.**

```sh
pnpm --filter @gopaylocal/api verify:provider dodo --product pdt_... \
  --webhook-url https://<tunnel>/hook --print-secret --wait
```

**What the provider does:**

| Method | What it does |
|---|---|
| `createDiscount` | Codes are capped at 16 characters. Dodo uppercases codes and its response describes them as "up to 16 chars" ([create discount](https://docs.dodopayments.com/api-reference/discounts/create-discount)). |
| `buildCheckoutUrl` | Creates a checkout session with `discount_codes` ([checkout sessions](https://docs.dodopayments.com/api-reference/checkout-sessions/create)) |
| `provisionWebhook` | Creates an endpoint filtered to `payment.succeeded`, then fetches its secret from `GET /webhooks/{id}/secret` |
| `deleteDiscount` | Soft-deletes the discount ([delete discount](https://docs.dodopayments.com/api-reference/discounts/delete-discount)) |

**Test purchase.** Pay with `4242 4242 4242 4242`. "For all test cards, use
expiry date 06/32 (or 12/34) and CVV 123"
([testing](https://docs.dodopayments.com/miscellaneous/testing-process)).

**Webhook capture and replay.** Deliveries carry `webhook-id`,
`webhook-timestamp` and `webhook-signature` (Standard Webhooks, signed over
`id.timestamp.rawBody`)
([webhooks](https://docs.dodopayments.com/developer-resources/webhooks)). The
endpoint's Logs tab shows each message's payload and attempts and can Replay
one, but headers aren't documented as shown, so use `--capture`.

```sh
pnpm --filter @gopaylocal/api verify:provider dodo --replay delivery.json --expect-code <code>
```

**What a pass looks like.** Every verify and replay step PASSes.

**Only a real run will show:**
- The `payment.succeeded` body. The docs give no schema, and the provider
  assumes it matches the payment object
  ([payment](https://docs.dodopayments.com/api-reference/payments/get-payments-1.md)).
- Whether soft-deleted discounts disappear from the list.

## Polar

**Sandbox.** Use [sandbox.polar.sh](https://sandbox.polar.sh), with a separate
user and organisation. Tokens are environment-specific: "the access token created
in the production environment can't be used in the sandbox"
([sandbox](https://polar.sh/docs/integrate/sandbox)).

**Credentials.** Create an Organization Access Token in the sandbox org under
Settings > Access Tokens > Create token
([OAT](https://polar.sh/docs/integrate/oat)). Scopes, from the endpoint pages:

| Scope | Needed for |
|---|---|
| `discounts:read`, `discounts:write` | Discounts ([list](https://polar.sh/docs/api-reference/discounts/list), [delete](https://polar.sh/docs/api-reference/discounts/delete)) |
| `checkouts:write` | Checkout ([create session](https://polar.sh/docs/api-reference/checkouts/create-session)) |
| `webhooks:write` | Webhooks ([create endpoint](https://polar.sh/docs/api-reference/webhooks/endpoints/create)) |

| Env var | Value |
|---|---|
| `GPL_VERIFY_API_KEY` | The sandbox organization access token |

**Prepare.** Create a product in the sandbox org and copy its id (a UUID).

**Run.**

```sh
pnpm --filter @gopaylocal/api verify:provider polar --product <product uuid> \
  --webhook-url https://<tunnel>/hook --print-secret --wait
```

**What the provider does:**

| Method | What it does |
|---|---|
| `listProducts` | Not implemented, so `list-products` is SKIPPED |
| `createDiscount` | Codes are letters and digits only, 3 to 256 characters ([create discount](https://polar.sh/docs/api-reference/discounts/create)) |
| `buildCheckoutUrl` | Creates a checkout with `discount_id`. Polar checkouts take a discount by id, not by code. |
| `provisionWebhook` | Creates a `raw`-format endpoint for `order.paid` and returns its secret |

**Test purchase.** Pay with `4242 4242 4242 4242`, any future expiry and any CVC
([sandbox](https://polar.sh/docs/integrate/sandbox)).

**Webhook capture and replay.** Deliveries use Standard Webhooks headers. Which
signing key applies depends on when the secret was generated:
- **On or after 8 September 2026, 00:00 UTC:** Standard Webhooks (`whsec_…`, used as-is).
- **Earlier:** Polar's own HMAC.

The provider accepts both
([delivery](https://polar.sh/docs/integrate/webhooks/delivery.md)). The dashboard
shows past deliveries with their payload and can redeliver, and the Polar CLI
has `polar webhook listen` and `polar webhook trigger`
([endpoints](https://polar.sh/docs/integrate/webhooks/endpoints)).

```sh
pnpm --filter @gopaylocal/api verify:provider polar --replay delivery.json --expect-code <code>
```

**What a pass looks like.** Every step PASSes except `list-products` (SKIPPED).

**Only a real run will show:** that `order.paid` carries an Order object with
`discount_id`, `discount.code` and amounts in cents. The event page has no schema;
this is inferred from the [Order schema](https://polar.sh/docs/api-reference/orders/get).

## Whop

**Sandbox.** Create a sandbox account and keys at
[sandbox.whop.com](https://sandbox.whop.com). Sandbox and production "share no
accounts, keys, products, or webhooks", and the sandbox API is
`https://sandbox-api.whop.com/api/v1`
([sandbox](https://docs.whop.com/developer/guides/sandbox.md)).

**Credentials.** Go to sandbox.whop.com/dashboard/developer > Account API Keys >
Create. Sandbox and production keys look identical
([getting started](https://docs.whop.com/developer/api/getting-started)).
Permissions, from the endpoint pages:

| Permission | Needed for |
|---|---|
| `promo_code:create`, `promo_code:basic:read`, `promo_code:delete` | Promo codes ([create](https://docs.whop.com/api-reference/promo-codes/create-promo-code), [list](https://docs.whop.com/api-reference/promo-codes/list-promo-codes), [delete](https://docs.whop.com/api-reference/promo-codes/delete-promo-code)) |
| `checkout_configuration:create` | Checkout |
| `developer:manage_webhook` | Webhooks ([create](https://docs.whop.com/api-reference/webhooks/create-webhook)) |
| `company:balance:read` | Only if you leave `GPL_VERIFY_COMPANY_ID` unset: the provider then looks the company up with `GET /accounts/me` (this scope comes from Whop's API spec, where that endpoint is marked hidden) |

| Env var | Value |
|---|---|
| `GPL_VERIFY_API_KEY` | The sandbox API key |
| `GPL_VERIFY_COMPANY_ID` | Optional `biz_…` id. Set it to skip the `GET /accounts/me` lookup and the extra scope. |

**Prepare.** Create a product with a plan in the sandbox and copy the plan id
(`plan_…`).

**Run.**

```sh
pnpm --filter @gopaylocal/api verify:provider whop --product plan_... \
  --webhook-url https://<tunnel>/hook --print-secret --wait
```

**What the provider does:**

| Method | What it does |
|---|---|
| `listProducts` | Not implemented, so `list-products` is SKIPPED |
| `createDiscount` | Tags codes with a `GPL_` prefix |
| `buildCheckoutUrl` | Creates a checkout configuration for the plan and appends `?promoCode=<code>` to its `purchase_url`. Only a [Whop blog post](https://whop.com/blog/add-promo-codes/) documents that parameter, not the API reference. |
| `provisionWebhook` | Subscribes to `payment.succeeded` and returns the `ws_…` secret Whop shows only once |
| `deleteDiscount` | Archives the promo code ([delete promo code](https://docs.whop.com/api-reference/promo-codes/delete-promo-code)) |

**Test purchase.** Pay with `4242 4242 4242 4242`, any future expiry, any 3-digit
CVC and any billing address
([sandbox](https://docs.whop.com/developer/guides/sandbox.md)). Check that the
promo code was applied. The sandbox page doesn't cover promo codes.

**Webhook capture and replay.** Whop uses Standard Webhooks. Pass the `ws_…`
secret exactly as given: "Don't strip the prefix, and don't base64-encode it"
([webhooks](https://docs.whop.com/developer/guides/webhooks)). Deliveries are
kept for 30 days and can be read in the dashboard or via
`GET /api/v1/webhooks/{id}/deliveries`. `POST /api/v1/webhooks/{id}/test` sends
a sample event.

```sh
pnpm --filter @gopaylocal/api verify:provider whop --replay delivery.json --expect-code promo_...
```

The pinned payload carries `promo_code_id` rather than the code, so match on the
promo id printed by `create-discount`.

**What a pass looks like.** Every step PASSes except `list-products` (SKIPPED).

**Only a real run will show:**
- **Whether archived promo codes still come back from `GET /promo_codes`.**
  `listDiscounts()` doesn't filter by status, and the delete endpoint archives.
  If they do, `confirm-deleted` FAILs, and that's a real bug for
  `syncProviderCoupons()`.
- Whether `?promoCode=` is honoured on a `purchase_url`.
- The `payment.succeeded` payload shape, which the docs don't publish.

## Creem

**Test mode.** Toggle **Test Mode** at the bottom of the dashboard's left
sidebar. Test and production are "completely isolated", "API keys are not
interchangeable between environments", and the test API is
`https://test-api.creem.io`
([API intro](https://docs.creem.io/api-reference/introduction)).

**Credentials.** In test mode, go to Developers > API Keys and create a key. A
test key starts with `creem_test_`
([LinkJolt guide](https://docs.creem.io/integrations/linkjolt)). A **Full
access** key covers everything. For a restricted key, these are the documented
scope names:

| Scope | Needed for |
|---|---|
| `products:read` | `listProducts`, and `createDiscount` (it names every active product) |
| `discounts:read`, `discounts:write` | Listing, creating and deleting discount codes |
| `webhooks:read`, `webhooks:write` | Creating and deleting the endpoint ([webhooks](https://docs.creem.io/code/webhooks)) |
| Checkout creation | `buildCheckoutUrl`. The docs name no scope for it, so use Full access or check the key dialog. |

| Env var | Value |
|---|---|
| `GPL_VERIFY_API_KEY` | `creem_test_…` |

**Prepare.** Create a product in test mode and copy its id (`prod_…`). The
throwaway code applies to every active product in the store.

**Run.**

```sh
pnpm --filter @gopaylocal/api verify:provider creem --product prod_... \
  --webhook-url https://<tunnel>/hook --print-secret --wait
```

**What the provider does:**

| Method | What it does |
|---|---|
| `listProducts` | Lists active products (`GET /v1/products/search?status=active`) ([search products](https://docs.creem.io/api-reference/endpoint/search-products)) |
| `createDiscount` | Creates a `forever` percentage discount. `applies_to_products` is required, so the code names every active product ([create discount](https://docs.creem.io/api-reference/endpoint/create-discount-code), [migration guide](https://docs.creem.io/getting-started/migrate/lemon-squeezy/technical-guide)) |
| `listDiscounts` | Lists active discounts, 10 per page (the documented default; no maximum is documented) ([search discounts](https://docs.creem.io/api-reference/endpoint/search-discounts)) |
| `buildCheckoutUrl` | Creates a checkout session with `discount_code` ([create checkout](https://docs.creem.io/api-reference/endpoint/create-checkout)) |
| `provisionWebhook` | Creates an `http` endpoint for `checkout.completed` only and returns the secret from the create response ([create webhook](https://docs.creem.io/api-reference/endpoint/create-webhook)) |
| `deleteDiscount` | Deletes the discount permanently (`DELETE /v1/discounts/{id}/delete`) ([delete discount](https://docs.creem.io/api-reference/endpoint/delete-discount-code)) |

**Test purchase.** Pay with `4111 1111 1111 1111`, any future expiry date and
any CVV ([test mode](https://docs.creem.io/getting-started/test-mode)). Check
that the code was applied.

**Webhook capture and replay.** Deliveries carry one header, `creem-signature`:
the hex HMAC-SHA256 of the raw body, keyed with the secret. The scheme has no
timestamp, so a capture verifies at any age
([webhooks](https://docs.creem.io/code/webhooks)). The dashboard can resend an
event (with a new event `id`), and `creem listen` forwards deliveries with the
real signature header.

```sh
pnpm --filter @gopaylocal/api verify:provider creem --replay delivery.json --expect-code <code>
```

**What a pass looks like.** Every verify and replay step PASSes.

**Only a real run will show:**
- Which codes Creem accepts: GoPayLocal sends letters and digits only, such as
  `PPPIN40K7QX` (the run creates `VERIFYZZ17...`); also the maximum length,
  and whether checkout matches codes case-insensitively.
- Whether a `page_size` above 10 is accepted. If it is, raise `PAGE_SIZE` in
  `creem.ts`.
- Whether a fractional `percentage` is accepted.
- The permission a restricted key needs for checkout creation.
- The real `checkout.completed` body for a discounted order: `order.discount`,
  `order.discount_amount`, `order.tax_amount` and `discount.discountCode`, and
  whether `discount_amount` excludes tax on a tax-exclusive product.

## WooCommerce

**No test mode.** The REST API acts on the real store
([REST API](https://developer.woocommerce.com/docs/apis/rest-api/)). If you
have a staging copy of the store on its own https address, point the run at
that. Otherwise the tool:
- requires `--allow-live`
- requires `--product`, and limits the throwaway coupon to that one product
  (`product_ids`) instead of creating a coupon valid on everything in the store

**Requirements.** WooCommerce 3.5+, WordPress 4.4+, pretty permalinks
(Settings > Permalinks: "default permalinks will not work"), and HTTPS. The
store only accepts the key as HTTP Basic auth over HTTPS
([authentication](https://developer.woocommerce.com/docs/apis/rest-api/authentication)).
The checkout link needs WooCommerce 10.0+.

**Credentials.** WooCommerce > Settings > Advanced > REST API > Add key. Pick
an Administrator or Shop Manager as the user (webhooks need
`manage_woocommerce`), set **Permissions** to **Read/Write**, and click
Generate API key. Copy both values; the secret is shown once
([generate keys](https://developer.woocommerce.com/docs/apis/rest-api/#generate-keys)).

| Env var | Value |
|---|---|
| `GPL_VERIFY_API_KEY` | `ck_…:cs_…` (consumer key, a colon, consumer secret) |
| `GPL_VERIFY_STORE_URL` | The store address, e.g. `https://shop.example.com` (or `https://example.com/store` for a subdirectory install) |

**Run.**

```sh
pnpm --filter @gopaylocal/api verify:provider woocommerce --allow-live --product <product id> \
  --webhook-url https://<tunnel>/hook --print-secret --wait
```

**What the provider does:**

| Method | What it does |
|---|---|
| `listProducts` | `GET /wp-json/wc/v3/products?status=publish` and `GET /data/currencies/current` for the store currency ([products](https://developer.woocommerce.com/docs/apis/rest-api/v3/products), [data](https://developer.woocommerce.com/docs/apis/rest-api/v3/data)) |
| `createDiscount` | `POST /coupons`: `discount_type: percent`, `individual_use: true`, meta `gopaylocal=true`, `product_ids` for this run ([coupons](https://developer.woocommerce.com/docs/apis/rest-api/v3/coupons)) |
| `listDiscounts` | `GET /coupons`, 100 per page, keeping published, unexpired, not used-up coupons with the `gopaylocal` meta |
| `buildCheckoutUrl` | Builds `https://<store>/checkout-link/?products=<id>:1&coupon=<code>` with no API call ([sharable checkout URLs](https://woocommerce.com/document/creating-sharable-checkout-urls-in-woocommerce/)) |
| `provisionWebhook` | Two `POST /webhooks`, topics `order.created` and `order.updated`, one secret ([webhooks](https://developer.woocommerce.com/docs/apis/rest-api/v3/webhooks)) |
| `deleteDiscount` | `DELETE /coupons/<id>?force=true` (permanent; without `force` it goes to the trash) |

Requests never follow redirects, time out after 15 seconds, and refuse
responses over 2 MB. A redirect fails the step with the target address if it
is a valid store address (for example `www.`): re-run with that URL.

**Test purchase.** Open the checkout link in a private window, check that the
coupon is applied, and place the order with a gateway that marks it paid. Only
**Processing** and **Completed** orders count; Direct bank transfer and Check
leave orders **On hold** until you change the status in WooCommerce > Orders.

**Webhook capture and replay.** WooCommerce first sends an unsigned ping (body
`webhook_id=<id>`, no `X-WC-Webhook-*` headers) while the webhook is being
created. Name the provider when you capture, with the store URL set, so the
capture skips the ping (it prints "Skipped a setup ping") and keeps waiting for
the order:

```sh
GPL_VERIFY_STORE_URL=https://<store> \
  pnpm --filter @gopaylocal/api verify:provider woocommerce --capture ~/gpl-verify/woo-delivery.json
```

Without the provider name the first delivery is kept, and that is the ping.
Order deliveries carry `X-WC-Webhook-Signature`: base64 HMAC-SHA256 of
the raw body, keyed with the secret, with no timestamp, so a capture verifies at
any age (`generate_signature` in `includes/class-wc-webhook.php`). Deliveries
are queued through Action Scheduler and can arrive a minute or more after the
order.

```sh
GPL_VERIFY_WEBHOOK_SECRET=<secret printed by --print-secret> \
  pnpm --filter @gopaylocal/api verify:provider woocommerce --allow-live --replay ~/gpl-verify/woo-delivery.json --expect-code <code>
```

**What a pass looks like.** Every verify and replay step PASSes. The parsed
code is lower case (the store lower-cases coupon codes).

**Only a real run will show:**
- That the store accepts Basic auth. Some servers drop the `Authorization`
  header; the docs call that a server issue ("Consumer key is missing") and
  offer query-string keys as a workaround, which GoPayLocal never uses.
- That the `gopaylocal` coupon meta and `individual_use` come back as sent, and
  that `_fields` is honoured.
- That `date_expires` sent as `…Z` is stored as that UTC time.
- That both webhooks are created `active` with the `wp_api_v3` payload, and the
  order body signs as described.
- That the checkout link applies the coupon (WooCommerce 10.0+) and the order
  carries it in `coupon_lines` with `discount` excluding tax.
- How the store's security plugins, firewall or CDN treat requests from
  Cloudflare Workers.

---

## Adding a provider

When Creem, WooCommerce or another provider is added to `createProvider()`, the
tool can drive it immediately with `--allow-live`. To give it the safe defaults:

1. Add an entry to `PROVIDER_PROFILES` in `scripts/verify-provider/profiles.ts`:
   - how to tell test from live (key prefix, `environment`, account suffix, or always live)
   - the live API hosts, for the network guard
   - the account-id env var, if the provider needs one
   - what `--product` must be
2. Add a section above with official doc links, and a row to the status table.
3. Run `pnpm test:api`. The tool's tests are in `src/scripts/verify-provider.test.ts`.

## Troubleshooting

- **Exit status 1 from pnpm, but the output says "refused".** pnpm collapses
  every non-zero status to 1. See [What the tool checks](#what-the-tool-checks).
- **`network-guard` FAIL.** During a test run, the provider tried to reach a live
  host. The provider is ignoring `environment`, which is a bug in that provider.
- **`confirm-deleted` FAIL.** The provider "deleted" the discount but still lists
  it, usually because it archives and `listDiscounts()` doesn't filter archived
  items. Fix the provider.
- **`create-discount` notes a different code.** Some providers normalise codes
  (uppercase, a prefix). Production stores whatever the provider returns, so this
  is informational, not a failure.
- **Paddle `transaction_default_checkout_url_not_set`.** Set a default payment link
  ([Paddle](#paddle-billing)).
- **"--webhook-url must not be a GoPayLocal webhook endpoint".** Point it at a
  tunnel to `--capture` instead.
- **A run was killed and left a discount behind.** Its code starts with `VERIFY`
  (on Whop, `GPL_VERIFY`). Delete it with `--delete-discount <id>` or in the
  provider dashboard.
