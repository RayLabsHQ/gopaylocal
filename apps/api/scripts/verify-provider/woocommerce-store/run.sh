#!/usr/bin/env bash
# End-to-end check of the WooCommerce integration against a real WooCommerce
# store, with no account and no credentials: the store is started here, in
# Docker, and removed at the end. Run by .github/workflows/woocommerce-store.yml.
#
# What it does, with the same provider code the API runs:
#   1. the standard checks: list products, create a coupon, read it back,
#      build the checkout link, delete the coupon, confirm it is gone
#   2. a purchase: create a coupon and the two webhooks, open the checkout
#      link as a visitor, check the cart holds the product with the coupon
#      applied, place the order, receive the store's webhook, and run it
#      through verifyWebhook() and parseRedemption()
#   3. clean-up through the tool's own delete commands
#
# Needs: Docker with Compose, Node (see .nvmrc), curl, jq, openssl, port 443
# free, and store.example.com + hook.example.com pointing at 127.0.0.1:
#   echo "127.0.0.1 store.example.com hook.example.com" | sudo tee -a /etc/hosts
# Both are reserved documentation names with no public address.
#
# Writes a Markdown report to $GITHUB_STEP_SUMMARY when that is set.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_DIR="$(cd "$HERE/../../.." && pwd)"
STORE_HOST="store.example.com"
HOOK_HOST="hook.example.com"
STORE_URL="https://$STORE_HOST"
HOOK_URL="https://$HOOK_HOST/hook"
CAPTURE_PORT=8787

WORK="$(mktemp -d)"
export WOO_CERT_DIR="$WORK/certs"
CERT="$WOO_CERT_DIR/cert.pem"
export NODE_EXTRA_CA_CERTS="$CERT"
SUMMARY="${GITHUB_STEP_SUMMARY:-/dev/null}"

ROWS=()
VERSIONS=""
CAPTURE_PID=""
CURRENT="starting"

compose() { docker compose -f "$HERE/compose.yml" "$@"; }
wp() { compose run --rm -T cli wp "$@"; }
node_ts() {
  (cd "$API_DIR" && node --disable-warning=ExperimentalWarning \
    --import ./scripts/verify-provider/register-ts-resolve.mjs "$@")
}
tool() { node_ts scripts/verify-provider.ts "$@"; }
store_curl() { curl -sS --max-time 60 --cacert "$CERT" -b "$WORK/cookies" -c "$WORK/cookies" "$@"; }
step() { CURRENT="$1"; printf '\n== %s\n' "$1"; }
pass() { ROWS+=("| $CURRENT | PASS | ${1:-} |"); printf 'PASS  %s  %s\n' "$CURRENT" "${1:-}"; }
# Print a log without the webhook signing secret (the line after its label).
show_log() { awk '/webhook signing secret/ { print; getline; print "  (hidden)"; next } { print }' "$1"; }

finish() {
  local status=$?
  set +e
  [ -n "$CAPTURE_PID" ] && kill "$CAPTURE_PID" 2>/dev/null
  {
    if [ "$status" -eq 0 ]; then
      echo "### WooCommerce store, end to end: passed"
    else
      echo "### WooCommerce store, end to end: FAILED at \"$CURRENT\""
    fi
    echo
    [ -n "$VERSIONS" ] && { echo "$VERSIONS"; echo; }
    if [ "${#ROWS[@]}" -gt 0 ]; then
      echo "| Step | Result | Detail |"
      echo "|---|---|---|"
      printf '%s\n' "${ROWS[@]}"
    fi
    [ "$status" -ne 0 ] && echo "| $CURRENT | FAIL | see the job log |"
    echo
  } >>"$SUMMARY"
  if [ "$status" -ne 0 ]; then
    printf '\nFAILED at: %s\n' "$CURRENT"
    echo "--- last lines from the store ---"
    compose logs --no-color --tail 40 wordpress proxy 2>&1
  fi
  compose down --volumes --remove-orphans >/dev/null 2>&1
  rm -rf "$WORK"
  exit "$status"
}
trap finish EXIT

die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# ── 0. Preconditions ────────────────────────────────────────────────────────
step "preconditions"
for bin in docker node curl jq openssl; do
  command -v "$bin" >/dev/null || die "$bin is not installed"
done
for host in "$STORE_HOST" "$HOOK_HOST"; do
  addr="$(node -e 'require("node:dns").lookup(process.argv[1], (e, a) => console.log(e ? "" : a))' "$host")"
  [ "$addr" = "127.0.0.1" ] || die "$host resolves to '${addr:-nothing}', not 127.0.0.1 (see the header of this file)"
done

mkdir -p "$WOO_CERT_DIR"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 2 \
  -keyout "$WOO_CERT_DIR/key.pem" -out "$CERT" -subj "/CN=GoPayLocal store check" \
  -addext "subjectAltName=DNS:$STORE_HOST,DNS:$HOOK_HOST" 2>/dev/null
chmod 644 "$WOO_CERT_DIR/key.pem"

# ── 1. The store ────────────────────────────────────────────────────────────
step "start WordPress"
compose up -d --quiet-pull db wordpress proxy
for _ in $(seq 1 60); do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:8080/wp-admin/install.php || true)"
  [ "$code" = "200" ] && break
  sleep 2
done
[ "$code" = "200" ] || die "WordPress did not start (last status: $code)"

step "install WordPress and WooCommerce"
wp core install --url="$STORE_URL" --title="GoPayLocal store check" --admin_user=admin \
  --admin_password="$(openssl rand -hex 16)" --admin_email=admin@example.com --skip-email
# The REST API needs pretty permalinks; the image's .htaccess already rewrites.
wp rewrite structure '/%postname%/'
wp plugin install woocommerce --activate
compose exec -T wordpress sh -c \
  'mkdir -p wp-content/mu-plugins && cat > wp-content/mu-plugins/gopaylocal-check.php' <"$HERE/gopaylocal-check.php"
wp eval-file /gopaylocal-check/store-setup.php | tail -n 1 >"$WORK/store.json"
PRODUCT_ID="$(jq -er '.product_id' "$WORK/store.json")"
API_KEY="$(jq -er '.consumer_key + ":" + .consumer_secret' "$WORK/store.json")"
echo "::add-mask::$(jq -er '.consumer_secret' "$WORK/store.json")"
VERSIONS="WordPress $(jq -er '.wordpress' "$WORK/store.json"), WooCommerce $(jq -er '.woocommerce' "$WORK/store.json"), over HTTPS at $STORE_URL (a throwaway store inside the job)."
echo "$VERSIONS"

code="$(store_curl -o /dev/null -w '%{http_code}' "$STORE_URL/wp-json/wc/v3/")"
[ "$code" = "200" ] || die "the store's REST API answered $code at $STORE_URL/wp-json/wc/v3/"
pass "product $PRODUCT_ID, Read/Write API key"

export GPL_VERIFY_API_KEY="$API_KEY"
export GPL_VERIFY_STORE_URL="$STORE_URL"

# ── 2. The standard checks ──────────────────────────────────────────────────
step "standard checks (create, list, checkout link, delete, confirm)"
VERIFY_PROVIDER=woocommerce VERIFY_PRODUCT="$PRODUCT_ID" VERIFY_REAL_ACCOUNT=true \
  node_ts scripts/verify-provider/ci.ts
pass "table above"

# ── 3. A purchase ───────────────────────────────────────────────────────────
step "start the webhook receiver"
tool woocommerce --capture "$WORK/delivery.json" --port "$CAPTURE_PORT" 2>"$WORK/capture.log" &
CAPTURE_PID=$!
for _ in $(seq 1 30); do
  curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$CAPTURE_PORT/" && break
  sleep 1
done
code="$(store_curl -o /dev/null -w '%{http_code}' "https://$HOOK_HOST/")"
[ "$code" = "200" ] || die "the webhook receiver is not reachable over HTTPS (status $code)"
pass "$HOOK_URL"

step "create the coupon and the webhooks"
if ! tool woocommerce --allow-live --product "$PRODUCT_ID" --webhook-url "$HOOK_URL" \
  --print-secret --keep --json >"$WORK/report.json" 2>"$WORK/report.log"; then
  show_log "$WORK/report.log"
  jq -r '.steps[] | "\(.status)\t\(.name)\t\(.detail)"' "$WORK/report.json" 2>/dev/null || true
  die "the checks failed"
fi
show_log "$WORK/report.log"
CODE="$(jq -er '.artifacts.discount.code' "$WORK/report.json")"
DISCOUNT_ID="$(jq -er '.artifacts.discount.providerDiscountId' "$WORK/report.json")"
WEBHOOK_ID="$(jq -er '.artifacts.webhook.endpointId' "$WORK/report.json")"
CHECKOUT_URL="$(jq -er '.artifacts.checkoutUrl' "$WORK/report.json")"
WEBHOOK_SECRET="$(awk '/webhook signing secret/ { getline; gsub(/^[ \t]+|[ \t\r]+$/, ""); print; exit }' "$WORK/report.log")"
[ -n "$WEBHOOK_SECRET" ] || die "the tool did not print the webhook signing secret"
echo "::add-mask::$WEBHOOK_SECRET"
pass "coupon $CODE (id $DISCOUNT_ID), webhooks $WEBHOOK_ID"

step "open the checkout link as a visitor"
echo "$CHECKOUT_URL"
code="$(store_curl -L -o "$WORK/checkout.html" -w '%{http_code}' "$CHECKOUT_URL")"
[ "$code" = "200" ] || die "the checkout link answered $code"
store_curl -D "$WORK/cart.headers" -o "$WORK/cart.json" "$STORE_URL/wp-json/wc/store/v1/cart"
jq '{items: [.items[] | {id, quantity}], coupons: [.coupons[].code], totals: (.totals | {total_items, total_discount, total_price, currency_code})}' "$WORK/cart.json"
jq -e --argjson id "$PRODUCT_ID" '[.items[] | select(.id == $id and .quantity == 1)] | length == 1' "$WORK/cart.json" >/dev/null \
  || die "the cart does not hold exactly one of product $PRODUCT_ID"
jq -e --arg code "$CODE" '[.coupons[].code | ascii_downcase] | index($code | ascii_downcase) != null' "$WORK/cart.json" >/dev/null \
  || die "the coupon $CODE was not applied to the cart"
jq -e '(.totals.total_discount | tonumber) > 0 and (.totals.total_price | tonumber) < (.totals.total_items | tonumber)' "$WORK/cart.json" >/dev/null \
  || die "the cart total does not show a discount"
pass "cart: $(jq -r '"\(.totals.total_items) → \(.totals.total_price) \(.totals.currency_code) (minor units), coupon \(.coupons[0].code)"' "$WORK/cart.json")"

step "place the order (Cash on delivery)"
NONCE="$(awk 'tolower($1) == "nonce:" { gsub(/\r/, ""); print $2 }' "$WORK/cart.headers" | tail -n 1)"
[ -n "$NONCE" ] || die "the store did not send a Store API nonce"
cat >"$WORK/checkout.json" <<'JSON'
{
  "billing_address": {
    "first_name": "Test", "last_name": "Buyer", "company": "",
    "address_1": "1 Test Street", "address_2": "", "city": "San Francisco",
    "state": "CA", "postcode": "94103", "country": "US",
    "email": "buyer@example.com", "phone": "5555550100"
  },
  "shipping_address": {
    "first_name": "Test", "last_name": "Buyer", "company": "",
    "address_1": "1 Test Street", "address_2": "", "city": "San Francisco",
    "state": "CA", "postcode": "94103", "country": "US", "phone": "5555550100"
  },
  "payment_method": "cod",
  "payment_data": []
}
JSON
code="$(store_curl -o "$WORK/order.json" -w '%{http_code}' -X POST -H "Nonce: $NONCE" \
  -H 'Content-Type: application/json' --data @"$WORK/checkout.json" "$STORE_URL/wp-json/wc/store/v1/checkout")"
jq '{order_id, status, payment_result: (.payment_result // null), code: (.code // null), message: (.message // null)}' "$WORK/order.json" || cat "$WORK/order.json"
[ "$code" = "200" ] || die "checkout answered $code"
ORDER_ID="$(jq -er '.order_id' "$WORK/order.json")"
ORDER_STATUS="$(jq -er '.status' "$WORK/order.json")"
[ "$ORDER_STATUS" = "processing" ] || die "order $ORDER_ID is '$ORDER_STATUS', expected 'processing'"
pass "order $ORDER_ID, $ORDER_STATUS"

step "receive the store's webhook"
# WooCommerce queues deliveries in Action Scheduler; run the queue until one arrives.
for _ in $(seq 1 30); do
  [ -s "$WORK/delivery.json" ] && break
  wp action-scheduler run >/dev/null 2>&1 || true
  sleep 2
done
cat "$WORK/capture.log"
[ -s "$WORK/delivery.json" ] || die "no webhook arrived"
wait "$CAPTURE_PID" || die "the webhook receiver failed"
CAPTURE_PID=""
jq -r '.headers | to_entries[] | select(.key | test("^x-wc-webhook-(topic|resource|event|source|id|delivery-id)$"; "i")) | "\(.key): \(.value)"' "$WORK/delivery.json"
jq -r '.rawBody | fromjson | {id, status, total, discount_total, coupon_lines: [.coupon_lines[] | {code, discount}]}' "$WORK/delivery.json"
TOPIC="$(jq -r '.headers | to_entries[] | select(.key | ascii_downcase == "x-wc-webhook-topic") | .value' "$WORK/delivery.json")"
pass "topic ${TOPIC:-unknown}"

step "replay it through verifyWebhook() and parseRedemption()"
GPL_VERIFY_WEBHOOK_SECRET="$WEBHOOK_SECRET" tool woocommerce --allow-live \
  --replay "$WORK/delivery.json" --expect-code "$CODE"
pass "signature valid, redemption parsed with code $CODE"

step "a wrong secret must be rejected"
if GPL_VERIFY_WEBHOOK_SECRET="not-the-secret" tool woocommerce --allow-live \
  --replay "$WORK/delivery.json" --expect-code "$CODE" >"$WORK/wrong.log" 2>&1; then
  cat "$WORK/wrong.log"
  die "the delivery verified with the wrong secret"
fi
pass "rejected"

# ── 4. Clean-up, through the tool ───────────────────────────────────────────
step "delete the webhooks and the coupon"
tool woocommerce --allow-live --delete-webhook "$WEBHOOK_ID"
tool woocommerce --allow-live --delete-discount "$DISCOUNT_ID"
left="$(store_curl -u "$API_KEY" "$STORE_URL/wp-json/wc/v3/webhooks?per_page=100" | jq 'length')"
[ "$left" = "0" ] || die "$left webhook(s) are still in the store"
code="$(store_curl -u "$API_KEY" -o /dev/null -w '%{http_code}' "$STORE_URL/wp-json/wc/v3/coupons/$DISCOUNT_ID")"
[ "$code" = "404" ] || die "the coupon is still in the store (status $code)"
pass "none left"

CURRENT="done"
echo
echo "All WooCommerce store checks passed."
