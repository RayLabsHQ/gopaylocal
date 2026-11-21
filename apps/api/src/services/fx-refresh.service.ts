import { FX_DOC_VERSION, FX_MAX_AGE_HOURS, SUPPORTED_CURRENCIES, fxDateFresh, fxDateMs, fxRatePlausible, type FxRatesDoc } from "@gopaylocal/shared/currency";
import { createFetchText, type FetchText } from "./vpn-dataset";

/**
 * Exchange-rate refresh: downloads USD-based mid-market rates, validates them and
 * stores one document in KV (`fx:rates`) for the banner endpoint's local prices.
 * The request path never fetches a feed; it only reads that document.
 *
 * Sources (all free, no API key):
 *  - Primary: fawazahmed0/exchange-api, CC0 1.0
 *    (https://github.com/fawazahmed0/exchange-api). The dated jsDelivr file for
 *    today, then yesterday (jsDelivr caches the `@latest` alias for up to 7 days),
 *    then the project's Cloudflare Pages mirror, which its README asks clients
 *    to fall back to.
 *  - Fallback and cross-check: Frankfurter v2 blended rates
 *    (https://frankfurter.dev, MIT code; "Blended rates are Frankfurter's own
 *    calculation and free to use"). Every run compares the two.
 *  Self-hosters can point FX_RATES_URL / FX_RATES_FALLBACK_URL at their own feed
 *  (for example a self-hosted Frankfurter) or set either to "off".
 *
 * Per currency, every run (validateFxFeed), with the source's rate p, the other
 * source's rate f and the baseline b (the last cross-checked rate, kept in the
 * document and never erased by a hold):
 *  - f agrees with p (within 5%; within 2% for a move over 15% from b): p is
 *    accepted and becomes b. This is how a genuine big move gets through.
 *  - no f, b exists: p is accepted only within 15% of b, and b does not move,
 *    so without a second source nothing drifts more than 15% from the last
 *    cross-checked value.
 *  - no f, no b: not served this run. With FX_RATES_FALLBACK_URL="off" (the
 *    operator chose one source) p is accepted and b follows each accepted rate.
 *  - f disagrees with p: held.
 * A held currency is served at its baseline while that is under
 * FX_MAX_AGE_HOURS old, then left out: visitors in it get the exact price in the
 * merchant's currency until a later run accepts it again.
 *
 * Bad data never replaces good data: a source is rejected if it fails the feed
 * checks, if more than FX_MASS_SWING_COUNT currencies moved over 15% from their
 * baselines unconfirmed, or if fewer than FX_MIN_CURRENCIES rates would be
 * written. Then the other source is tried, and if that fails too the previous
 * document stays untouched until it ages out.
 *
 * Schedule: MUST match an entry in wrangler.toml `[triggers] crons` (checked by
 * fx-refresh.service.test.ts). Budget per run: at most 4 fetches, 1 KV read and
 * 2 KV writes (document + status), a few ms of CPU for ~20 KB of JSON; 4 runs a
 * day, against Workers Paid's cron limits.
 */
export const FX_REFRESH_CRON = "40 */6 * * *";

export const FX_RATES_KEY = "fx:rates";
export const FX_STATUS_KEY = "fx:status";

export const FX_PRIMARY_URLS = [
  "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@{date}/v1/currencies/usd.json",
  "https://latest.currency-api.pages.dev/v1/currencies/usd.json",
];
export const FX_FALLBACK_URL = "https://api.frankfurter.dev/v2/rates?base=usd";

/** Every one of these must be present and valid, or the feed is rejected. */
export const FX_REQUIRED = [
  "USD", "EUR", "GBP", "JPY", "INR", "BRL", "NGN", "PKR",
  "BDT", "EGP", "VND", "IDR", "TRY", "ARS", "MXN", "ZAR",
] as const;
/** At least this many allowlisted currencies, or the feed is rejected. */
export const FX_MIN_CURRENCIES = 120;
/** Absolute bounds for a rate (units per USD); defined in shared, where the read side applies them too. */
export { FX_MAX_RATE, FX_MIN_RATE } from "@gopaylocal/shared/currency";
/** A move from the baseline beyond this needs the second source's confirmation. */
export const FX_SWING_LIMIT = 0.15;
/** How close the second source must be to confirm a big move. */
export const FX_SWING_CONFIRM = 0.02;
/** More than this many unconfirmed big moves at once means a broken feed. */
export const FX_MASS_SWING_COUNT = 10;
/** Sources further apart than this on a currency: hold it. */
export const FX_SOURCE_DISAGREEMENT = 0.05;

const MAX_BYTES = 256 * 1024;
const FETCH_TIMEOUT_MS = 30_000;
const DAY_MS = 86_400_000;

/** The currencies a visitor can be shown, and products can be priced in: USD plus every country's current currency. */
const ALLOWLIST: ReadonlySet<string> = SUPPORTED_CURRENCIES;

export interface FxSources {
  /** Tried in order until one parses; `{date}` expands to today, then yesterday (UTC). null: local pricing off. */
  primary: string[] | null;
  /** Cross-check and fallback; null: neither. */
  fallback: string | null;
}

export const DEFAULT_FX_SOURCES: FxSources = { primary: FX_PRIMARY_URLS, fallback: FX_FALLBACK_URL };

/** Sources from the Worker vars FX_RATES_URL / FX_RATES_FALLBACK_URL (unset: the defaults; "off": disabled). */
export function fxSourcesFromEnv(env: { FX_RATES_URL?: string; FX_RATES_FALLBACK_URL?: string }): FxSources {
  const primaryVar = env.FX_RATES_URL?.trim();
  const fallbackVar = env.FX_RATES_FALLBACK_URL?.trim();
  return {
    primary: !primaryVar ? FX_PRIMARY_URLS : primaryVar.toLowerCase() === "off" ? null : [primaryVar],
    fallback: !fallbackVar ? FX_FALLBACK_URL : fallbackVar.toLowerCase() === "off" ? null : fallbackVar,
  };
}

/** True when the deployment has switched local pricing off (FX_RATES_URL="off"). */
export function fxDisabled(env: { FX_RATES_URL?: string }): boolean {
  return env.FX_RATES_URL?.trim().toLowerCase() === "off";
}

// ── Parsing ─────────────────────────────────────────────────────────────────

export interface ParsedFeed {
  asOf: string;
  /** Upper-case code -> units per USD, USD included as 1. Unfiltered. */
  rates: Record<string, number>;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function upperRates(source: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [code, value] of Object.entries(source)) {
    if (typeof value === "number" && /^[A-Za-z]{3}$/.test(code)) out[code.toUpperCase()] = value;
  }
  return out;
}

function withUsd(rates: Record<string, number>): Record<string, number> | string {
  if (rates.USD === undefined) return { ...rates, USD: 1 };
  return Math.abs(rates.USD - 1) <= 1e-9 ? { ...rates, USD: 1 } : `USD rate is ${rates.USD}, not 1`;
}

/**
 * Parse a USD-based feed in any of the three accepted shapes:
 *  - fawazahmed0: {"date": "YYYY-MM-DD", "usd": {"inr": 93.3, ...}}
 *  - Frankfurter v2: [{"date", "base": "USD", "quote", "rate"}, ...]
 *  - Frankfurter v1 and most hand-made files: {"base": "USD", "date", "rates": {...}}
 * Returns an error string for anything else, including a non-USD base.
 */
export function parseFxFeed(text: string): ParsedFeed | string {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return "not JSON";
  }

  if (Array.isArray(json)) {
    const rows: Record<string, { rate: number; date: string }> = {};
    let latest = "";
    for (const row of json) {
      if (!isRecord(row)) continue;
      const { date, base, quote, rate } = row;
      if (typeof date !== "string" || !DATE_RE.test(date) || typeof quote !== "string" || typeof rate !== "number") continue;
      if (typeof base !== "string" || base.toUpperCase() !== "USD") return `base is ${String(base)}, not USD`;
      const code = quote.toUpperCase();
      if (!/^[A-Z]{3}$/.test(code)) continue;
      const prev = rows[code];
      if (!prev || date > prev.date) rows[code] = { rate, date };
      if (date > latest) latest = date;
    }
    if (!latest) return "no rows";
    // Rows can carry different dates (each source publishes on its own
    // schedule). The document is dated by the newest row; a row older than the
    // freshness window relative to it is dropped.
    const oldest = fxDateMs(latest) - FX_MAX_AGE_HOURS * 3_600_000;
    const rates: Record<string, number> = {};
    for (const [code, { rate, date }] of Object.entries(rows)) {
      if (fxDateMs(date) >= oldest) rates[code] = rate;
    }
    const checked = withUsd(rates);
    return typeof checked === "string" ? checked : { asOf: latest, rates: checked };
  }

  if (!isRecord(json)) return "unrecognised format";
  const date = json.date;
  if (typeof date !== "string" || !DATE_RE.test(date)) return "missing or malformed date";

  if (isRecord(json.rates)) {
    if (typeof json.base !== "string" || json.base.toUpperCase() !== "USD") return `base is ${String(json.base)}, not USD`;
    const checked = withUsd(upperRates(json.rates));
    return typeof checked === "string" ? checked : { asOf: date, rates: checked };
  }
  if (isRecord(json.usd)) {
    const checked = withUsd(upperRates(json.usd));
    return typeof checked === "string" ? checked : { asOf: date, rates: checked };
  }
  const otherBase = Object.keys(json).find((k) => k !== "date" && isRecord(json[k]));
  return otherBase ? `base is ${otherBase.toUpperCase()}, not USD` : "unrecognised format";
}

// ── Validation ──────────────────────────────────────────────────────────────

/** Per code, the last cross-checked (or, single-source, accepted) rate and its date. */
export type FxBaseline = Record<string, { rate: number; asOf: string }>;

export type FxValidation =
  | {
      ok: true;
      asOf: string;
      /** What would be written: accepted rates plus held codes at a fresh baseline. */
      rates: Record<string, number>;
      /** Codes not accepted from this feed (served at their baseline, or left out). */
      held: string[];
      /** Held codes served at their baseline -> its date. */
      heldAsOf: Record<string, string>;
      /** Held codes with no fresh baseline: not served. */
      leftOut: string[];
      /** Codes the two sources disagree on by more than FX_SOURCE_DISAGREEMENT. */
      disagreed: string[];
      /** The baseline to store with this result. */
      baseline: FxBaseline;
    }
  | { ok: false; reason: string };

const relDiff = (a: number, b: number): number => Math.abs(a / b - 1);
const plausible = (v: number | undefined): v is number => fxRatePlausible(v);

/**
 * Required currencies are checked on the source feed (present and plausible),
 * not on what would be written: a long, legitimate disagreement on one required
 * currency (official and parallel rates) must leave only that currency out, not
 * switch every currency off. The count check applies to what would be written.
 */
const REQUIRED_CHECKED_ON = "feed" as "feed" | "written";

/**
 * Validate one parsed feed against the stored baselines and (when available)
 * the other source. Feed-level failures reject the source; doubtful single
 * currencies are held (see the module comment for the per-currency rules).
 */
export function validateFxFeed(
  feed: ParsedFeed,
  opts: {
    baseline: FxBaseline;
    /** The other source's feed to cross-check with; null: none this run. */
    check: ParsedFeed | null;
    /** FX_RATES_FALLBACK_URL="off": the operator chose a single source. */
    singleSource: boolean;
    now: number;
  },
): FxValidation {
  const asOfMs = fxDateMs(feed.asOf);
  if (!Number.isFinite(asOfMs)) return { ok: false, reason: `malformed date ${feed.asOf}` };
  if (asOfMs > opts.now + DAY_MS) return { ok: false, reason: `date ${feed.asOf} is in the future` };
  if (feed.rates.USD !== 1) return { ok: false, reason: "USD rate is not 1" };
  if (REQUIRED_CHECKED_ON === "feed") {
    const missing = FX_REQUIRED.filter((c) => !plausible(feed.rates[c]));
    if (missing.length > 0) return { ok: false, reason: `required currencies missing or invalid: ${missing.join(", ")}` };
  }

  const second = opts.check?.rates ?? {};
  const accepted: Record<string, number> = { USD: 1 };
  const baseline: FxBaseline = { ...opts.baseline };
  const held = new Set<string>();
  const disagreed: string[] = [];
  const unconfirmedSwings: string[] = [];

  for (const code of ALLOWLIST) {
    if (code === "USD") continue;
    const p = feed.rates[code];
    const f = second[code];
    const b = opts.baseline[code];
    const bRate = b && plausible(b.rate) ? b.rate : undefined;
    if (!plausible(p)) {
      if (p !== undefined || bRate !== undefined) held.add(code);
      continue;
    }
    const swing = bRate !== undefined && relDiff(p, bRate) > FX_SWING_LIMIT;
    if (plausible(f)) {
      const apart = relDiff(p, f);
      if (apart <= (swing ? FX_SWING_CONFIRM : FX_SOURCE_DISAGREEMENT)) {
        accepted[code] = p;
        baseline[code] = { rate: p, asOf: feed.asOf };
      } else {
        held.add(code);
        if (apart > FX_SOURCE_DISAGREEMENT) disagreed.push(code);
        if (swing) unconfirmedSwings.push(code);
      }
      continue;
    }
    // No second opinion on this currency this run.
    if (bRate === undefined) {
      if (opts.singleSource) {
        accepted[code] = p;
        baseline[code] = { rate: p, asOf: feed.asOf };
      } else {
        held.add(code);
      }
      continue;
    }
    if (swing) {
      held.add(code);
      unconfirmedSwings.push(code);
      continue;
    }
    accepted[code] = p;
    if (opts.singleSource) baseline[code] = { rate: p, asOf: feed.asOf };
  }

  // Many unconfirmed big moves at once: a broken feed. Rejecting it lets the
  // other source be tried. With a single configured source there is nothing to
  // switch to, so the per-currency holds apply instead.
  if (!opts.singleSource && unconfirmedSwings.length > FX_MASS_SWING_COUNT) {
    return {
      ok: false,
      reason: `${unconfirmedSwings.length} currencies moved more than ${Math.round(FX_SWING_LIMIT * 100)}% from their baselines unconfirmed (${unconfirmedSwings.sort().slice(0, 12).join(", ")}): broken feed`,
    };
  }

  // Held codes: served at a fresh baseline, else left out.
  const rates: Record<string, number> = { ...accepted };
  const heldAsOf: Record<string, string> = {};
  const leftOut: string[] = [];
  for (const code of [...held].sort()) {
    const b = opts.baseline[code];
    if (b && plausible(b.rate) && fxDateFresh(b.asOf, opts.now)) {
      rates[code] = b.rate;
      heldAsOf[code] = b.asOf;
    } else {
      leftOut.push(code);
    }
  }

  // Checked on what would actually be written.
  if (REQUIRED_CHECKED_ON === "written") {
    const missing = FX_REQUIRED.filter((c) => rates[c] === undefined);
    if (missing.length > 0) return { ok: false, reason: `required currencies would not be served: ${missing.join(", ")}` };
  }
  const count = Object.keys(rates).length;
  if (count < FX_MIN_CURRENCIES) {
    return { ok: false, reason: `only ${count} currencies would be served (minimum ${FX_MIN_CURRENCIES})` };
  }

  return { ok: true, asOf: feed.asOf, rates, held: [...held].sort(), heldAsOf, leftOut, disagreed: disagreed.sort(), baseline };
}

// ── Refresh ─────────────────────────────────────────────────────────────────

export interface FxSourceReport {
  role: "primary" | "fallback";
  url: string;
  ok: boolean;
  status?: number;
  asOf?: string;
  reason?: string;
}

export interface FxRefreshStatus {
  ranAt: string;
  written: boolean;
  reason: string;
  /** asOf of the document now in KV (new or previous); null if none. */
  asOf: string | null;
  source: "primary" | "fallback" | null;
  /** Codes not accepted from the feed this run (served at their baseline, or left out). */
  held: string[];
  /** Held codes with no fresh baseline: visitors in them get exact prices. */
  leftOut: string[];
  disagreed: string[];
  sources: FxSourceReport[];
}

async function writeStatus(kv: KVNamespace, status: FxRefreshStatus): Promise<void> {
  try {
    await kv.put(FX_STATUS_KEY, JSON.stringify(status));
  } catch (err) {
    console.warn("fx-refresh: could not write status record", err);
  }
}

function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** `{date}` URLs become today's then yesterday's (UTC) URL; others stay as they are. */
export function expandFxUrls(urls: string[], now: number): string[] {
  const out: string[] = [];
  for (const url of urls) {
    if (url.includes("{date}")) {
      out.push(url.replaceAll("{date}", utcDate(now)), url.replaceAll("{date}", utcDate(now - DAY_MS)));
    } else {
      out.push(url);
    }
  }
  return out;
}

async function fetchFeed(
  fetchText: FetchText,
  role: FxSourceReport["role"],
  url: string,
  reports: FxSourceReport[],
): Promise<ParsedFeed | null> {
  try {
    const { status, text } = await fetchText(url, MAX_BYTES);
    if (status < 200 || status >= 300) {
      reports.push({ role, url, ok: false, status, reason: `HTTP ${status}` });
      return null;
    }
    const parsed = parseFxFeed(text);
    if (typeof parsed === "string") {
      reports.push({ role, url, ok: false, status, reason: parsed });
      return null;
    }
    reports.push({ role, url, ok: true, status, asOf: parsed.asOf });
    return parsed;
  } catch (err) {
    reports.push({ role, url, ok: false, reason: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

function readPreviousDoc(value: unknown): FxRatesDoc | null {
  if (!isRecord(value) || value.v !== FX_DOC_VERSION || typeof value.asOf !== "string" || !isRecord(value.rates)) return null;
  return value as unknown as FxRatesDoc;
}

/**
 * The stored baselines, entry by entry (a malformed entry is dropped). A document
 * from before baselines existed has none: every currency then needs the second
 * source's confirmation (or a single configured source) before it is served.
 */
function readBaseline(doc: FxRatesDoc | null): FxBaseline {
  const out: FxBaseline = {};
  const raw = doc?.baseline;
  if (!isRecord(raw)) return out;
  for (const [code, entry] of Object.entries(raw)) {
    if (isRecord(entry) && plausible(entry.rate as number) && typeof entry.asOf === "string" && DATE_RE.test(entry.asOf)) {
      out[code] = { rate: entry.rate as number, asOf: entry.asOf };
    }
  }
  return out;
}

/**
 * One refresh run. Never throws for upstream problems; a failed KV write of the
 * document does throw, so the cron invocation shows as failed.
 */
export async function refreshFxRates(
  kv: KVNamespace,
  opts: { fetchImpl?: typeof fetch; now?: number; sources?: FxSources } = {},
): Promise<FxRefreshStatus> {
  const now = opts.now ?? Date.now();
  const ranAt = new Date(now).toISOString();
  const sources = opts.sources ?? DEFAULT_FX_SOURCES;
  const base = { ranAt, held: [] as string[], leftOut: [] as string[], disagreed: [] as string[], sources: [] as FxSourceReport[] };

  if (!sources.primary) {
    return { ...base, written: false, reason: "local pricing is off (FX_RATES_URL=off)", asOf: null, source: null };
  }

  let previous: FxRatesDoc | null;
  try {
    previous = readPreviousDoc(await kv.get(FX_RATES_KEY, "json"));
  } catch (err) {
    // Without the current document there are no baselines to check against: do not write.
    console.error("fx-refresh: could not read the existing rates; skipping this run", err);
    return { ...base, written: false, reason: "could not read existing rates", asOf: null, source: null };
  }

  const fetchText = createFetchText(opts.fetchImpl ?? fetch, FETCH_TIMEOUT_MS);
  const reports: FxSourceReport[] = [];
  let primary: ParsedFeed | null = null;
  for (const url of expandFxUrls(sources.primary, now)) {
    primary = await fetchFeed(fetchText, "primary", url, reports);
    if (primary) break;
  }
  let secondary: ParsedFeed | null = null;
  if (sources.fallback) {
    for (const url of expandFxUrls([sources.fallback], now)) {
      secondary = await fetchFeed(fetchText, "fallback", url, reports);
      if (secondary) break;
    }
  }

  const baseline = readBaseline(previous);
  const singleSource = sources.fallback === null;
  let chosen: { result: Extract<FxValidation, { ok: true }>; source: "primary" | "fallback" } | null = null;
  const rejections: string[] = [];
  if (primary) {
    const v = validateFxFeed(primary, { baseline, check: secondary, singleSource, now });
    if (v.ok) chosen = { result: v, source: "primary" };
    else rejections.push(`primary rejected: ${v.reason}`);
  }
  if (!chosen && secondary) {
    // The primary failed or is unreachable, so it is not trusted to cross-check:
    // the fallback's rates stand alone against the baselines.
    const v = validateFxFeed(secondary, { baseline, check: null, singleSource: false, now });
    if (v.ok) chosen = { result: v, source: "fallback" };
    else rejections.push(`fallback rejected: ${v.reason}`);
  }
  for (const r of reports) if (!r.ok) console.warn(`fx-refresh: ${r.role} ${r.url}: ${r.reason}`);

  if (!chosen) {
    const reason = rejections.length > 0 ? rejections.join("; ") : "no source could be fetched";
    const status: FxRefreshStatus = { ...base, sources: reports, written: false, reason: `${reason}; previous rates kept`, asOf: previous?.asOf ?? null, source: previous?.source ?? null };
    console.error(`fx-refresh: ${status.reason}`);
    await writeStatus(kv, status);
    return status;
  }

  const { result, source } = chosen;
  if (result.held.length > 0) {
    // One line per run, codes only.
    console.warn(
      `fx-refresh: held ${result.held.join(", ")}` +
        (result.leftOut.length > 0 ? `; left out (exact prices) ${result.leftOut.join(", ")}` : "; all served at their baselines"),
    );
  }
  if (previous && result.asOf <= previous.asOf) {
    const status: FxRefreshStatus = {
      ...base,
      sources: reports,
      written: false,
      reason: `rates dated ${result.asOf} are not newer than the stored ${previous.asOf}`,
      asOf: previous.asOf,
      source: previous.source,
      held: result.held,
      leftOut: result.leftOut,
      disagreed: result.disagreed,
    };
    console.log(`fx-refresh: ${status.reason}`);
    await writeStatus(kv, status);
    return status;
  }

  const doc: FxRatesDoc = {
    v: FX_DOC_VERSION,
    base: "USD",
    asOf: result.asOf,
    fetchedAt: ranAt,
    source,
    rates: result.rates,
    held: result.held,
    heldAsOf: result.heldAsOf,
    baseline: result.baseline,
  };
  await kv.put(FX_RATES_KEY, JSON.stringify(doc));
  const status: FxRefreshStatus = {
    ...base,
    sources: reports,
    written: true,
    reason: `wrote ${Object.keys(result.rates).length} rates dated ${result.asOf} from the ${source} source${result.held.length ? `; held ${result.held.join(", ")}` : ""}${result.leftOut.length ? `; left out ${result.leftOut.join(", ")}` : ""}`,
    asOf: result.asOf,
    source,
    held: result.held,
    leftOut: result.leftOut,
    disagreed: result.disagreed,
  };
  console.log(`fx-refresh: ${status.reason}`);
  await writeStatus(kv, status);
  return status;
}
