import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COUNTRY_CURRENCY, type FxRatesDoc } from "@gopaylocal/shared/currency";
import {
  DEFAULT_FX_SOURCES,
  FX_FALLBACK_URL,
  FX_MIN_CURRENCIES,
  FX_PRIMARY_URLS,
  FX_RATES_KEY,
  FX_REFRESH_CRON,
  FX_STATUS_KEY,
  expandFxUrls,
  fxDisabled,
  fxSourcesFromEnv,
  parseFxFeed,
  refreshFxRates,
  validateFxFeed,
  type FxBaseline,
  type FxRefreshStatus,
  type ParsedFeed,
} from "./fx-refresh.service";
import { createCountingKV, fetchFrom } from "./vpn-test-helpers";

// 2026-11-19T12:00:00Z
const NOW = Date.parse("2026-11-19T12:00:00Z");
const TODAY = "2026-11-19";
const YESTERDAY = "2026-11-18";
const JSDELIVR_TODAY = `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${TODAY}/v1/currencies/usd.json`;
const JSDELIVR_YESTERDAY = `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${YESTERDAY}/v1/currencies/usd.json`;
const PAGES = "https://latest.currency-api.pages.dev/v1/currencies/usd.json";

// Real values for the currencies the tests look at (fawazahmed0, 2026-11-18);
// every other allowlisted currency gets a plausible made-up rate.
const KNOWN: Record<string, number> = {
  USD: 1, INR: 93.32614706, BRL: 5.77828238, NGN: 1350.55082508, PKR: 276.41190323,
  BDT: 124.78644117, EGP: 53.73934758, VND: 25687.00391491, IDR: 18263.97004598,
  TRY: 50.43278606, ARS: 1552.2114862, EUR: 0.91080569, GBP: 0.75809074,
  JPY: 159.29003817, MXN: 18.45420564, ZAR: 16.96902142, KWD: 0.31163423,
};
const ALL = [...new Set(["USD", ...Object.values(COUNTRY_CURRENCY)])].sort();

function allRates(overrides: Record<string, number | undefined> = {}): Record<string, number> {
  const out: Record<string, number> = {};
  ALL.forEach((code, i) => {
    out[code] = KNOWN[code] ?? 1 + i * 3.7;
  });
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete out[k];
    else out[k] = v;
  }
  return out;
}

/** fawazahmed0 shape, with crypto, metals and a defunct code mixed in like the real file. */
function fawazBody(date: string, rates: Record<string, number> = allRates()): string {
  const usd: Record<string, number> = { btc: 0.0000155, xau: 0.00031, dem: 1.78 };
  for (const [k, v] of Object.entries(rates)) usd[k.toLowerCase()] = v;
  return JSON.stringify({ date, usd });
}

/** Frankfurter v2 shape: one row per quote, dates per row. */
function frankfurterBody(date: string, rates: Record<string, number> = allRates(), dateOf: (code: string) => string = () => date): string {
  return JSON.stringify(Object.entries(rates).map(([quote, rate]) => ({ date: dateOf(quote), base: "USD", quote, rate })));
}

function feed(asOf: string, rates: Record<string, number> = allRates()): ParsedFeed {
  return { asOf, rates };
}

function prevDoc(asOf: string, rates: Record<string, number> = allRates(), extra: Partial<FxRatesDoc> = {}): FxRatesDoc {
  return { v: 1, base: "USD", asOf, fetchedAt: `${asOf}T06:40:00.000Z`, source: "primary", rates, held: [], ...extra };
}

/** Every non-USD rate as a baseline dated `asOf`. */
function baselineOf(asOf: string, rates: Record<string, number> = allRates()): FxBaseline {
  const out: FxBaseline = {};
  for (const [code, rate] of Object.entries(rates)) if (code !== "USD") out[code] = { rate, asOf };
  return out;
}

/** A stored document with cross-checked baselines, as a previous run writes it. */
function prevDocWithBaseline(asOf: string, rates: Record<string, number> = allRates()): FxRatesDoc {
  return prevDoc(asOf, rates, { baseline: baselineOf(asOf, rates), heldAsOf: {} });
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseFxFeed", () => {
  it("reads the fawazahmed0 shape, upper-casing codes", () => {
    const r = parseFxFeed(fawazBody(YESTERDAY));
    expect(typeof r).toBe("object");
    const p = r as ParsedFeed;
    expect(p.asOf).toBe(YESTERDAY);
    expect(p.rates.INR).toBe(93.32614706);
    expect(p.rates.USD).toBe(1);
    expect(p.rates.BTC).toBe(0.0000155); // filtered later, by validation
  });

  it("reads the Frankfurter v2 row shape, dated by the newest row", () => {
    const body = frankfurterBody(TODAY, allRates(), (c) => (c === "INR" ? YESTERDAY : TODAY));
    const p = parseFxFeed(body) as ParsedFeed;
    expect(p.asOf).toBe(TODAY);
    expect(p.rates.INR).toBe(93.32614706);
  });

  it("drops Frankfurter rows older than the freshness window", () => {
    const body = frankfurterBody(TODAY, allRates(), (c) => (c === "INR" ? "2026-11-10" : TODAY));
    const p = parseFxFeed(body) as ParsedFeed;
    expect(p.rates.INR).toBeUndefined();
    expect(p.rates.BRL).toBe(5.77828238);
  });

  it("reads the {base, date, rates} shape and adds USD", () => {
    const p = parseFxFeed(JSON.stringify({ base: "USD", date: YESTERDAY, rates: { INR: 93.3, EUR: 0.91 } })) as ParsedFeed;
    expect(p).toEqual({ asOf: YESTERDAY, rates: { INR: 93.3, EUR: 0.91, USD: 1 } });
  });

  it.each([
    ["a EUR-based fawazahmed0 file", JSON.stringify({ date: YESTERDAY, eur: { usd: 1.09 } }), "base is EUR, not USD"],
    ["a EUR-based rates file", JSON.stringify({ base: "EUR", date: YESTERDAY, rates: { USD: 1.09 } }), "base is EUR, not USD"],
    ["EUR-based Frankfurter rows", JSON.stringify([{ date: TODAY, base: "EUR", quote: "USD", rate: 1.09 }]), "base is EUR, not USD"],
    ["a USD rate other than 1", JSON.stringify({ date: YESTERDAY, usd: { usd: 1.2, inr: 93 } }), "USD rate is 1.2, not 1"],
    ["HTML", "<html>busy</html>", "not JSON"],
    ["a missing date", JSON.stringify({ usd: { inr: 93 } }), "missing or malformed date"],
    ["an empty row list", "[]", "no rows"],
  ])("rejects %s", (_name, body, reason) => {
    expect(parseFxFeed(body)).toBe(reason);
  });
});

describe("validateFxFeed", () => {
  const ok = (r: ReturnType<typeof validateFxFeed>) => {
    if (!r.ok) throw new Error(`expected ok, got: ${r.reason}`);
    return r;
  };
  const check = (f: ParsedFeed, o: { baseline?: FxBaseline; against?: ParsedFeed | null; single?: boolean } = {}) =>
    validateFxFeed(f, { baseline: o.baseline ?? {}, check: o.against ?? null, singleSource: o.single ?? false, now: NOW });

  it("keeps only the currencies a visitor can be shown (no crypto, metals or defunct codes)", () => {
    const parsed = parseFxFeed(fawazBody(YESTERDAY)) as ParsedFeed;
    const r = ok(check(parsed, { against: parsed }));
    expect(Object.keys(r.rates).sort()).toEqual(ALL);
    expect(r.rates.BTC).toBeUndefined();
    expect(r.held).toEqual([]);
    expect(Object.keys(r.baseline).sort()).toEqual(ALL.filter((c) => c !== "USD"));
  });

  it("holds single implausible values: left out without a baseline, served at a fresh one", () => {
    const bad = feed(YESTERDAY, allRates({ KES: -1, PHP: Number.NaN, IRR: 2e7 }));
    const cold = ok(check(bad, { against: feed(YESTERDAY) }));
    expect(cold.held).toEqual(["IRR", "KES", "PHP"]);
    expect(cold.leftOut).toEqual(["IRR", "KES", "PHP"]);
    expect(cold.rates.KES).toBeUndefined();

    const warm = ok(check(bad, { against: feed(YESTERDAY), baseline: baselineOf("2026-11-17") }));
    expect(warm.leftOut).toEqual([]);
    expect(warm.rates.KES).toBe(allRates().KES);
    expect(warm.heldAsOf).toEqual({ IRR: "2026-11-17", KES: "2026-11-17", PHP: "2026-11-17" });
  });

  it("rejects a feed missing a required currency", () => {
    const r = check(feed(YESTERDAY, allRates({ NGN: undefined })), { against: feed(YESTERDAY) });
    expect(r).toEqual({ ok: false, reason: "required currencies missing or invalid: NGN" });
  });

  it("checks the required set on the feed: a required currency the sources disagree on is left out alone", () => {
    const r = ok(check(feed(YESTERDAY, allRates({ INR: 140 })), { against: feed(YESTERDAY) }));
    expect(r.held).toEqual(["INR"]);
    expect(r.leftOut).toEqual(["INR"]);
    expect(r.rates.INR).toBeUndefined();
    expect(r.rates.EUR).toBe(0.91080569);
  });

  it("rejects a result with too few currencies", () => {
    const few: Record<string, number> = {};
    for (const code of Object.keys(KNOWN)) few[code] = KNOWN[code]!;
    const r = check(feed(YESTERDAY, few), { against: feed(YESTERDAY, few) });
    expect(r).toEqual({ ok: false, reason: `only ${Object.keys(KNOWN).length} currencies would be served (minimum ${FX_MIN_CURRENCIES})` });
  });

  it("counts what would be written: a full feed nothing confirms is rejected", () => {
    const r = check(feed(YESTERDAY));
    expect(r).toEqual({ ok: false, reason: `only 1 currencies would be served (minimum ${FX_MIN_CURRENCIES})` });
  });

  it("rejects a feed dated more than a day ahead", () => {
    const r = check(feed("2026-11-21"), { against: feed("2026-11-21") });
    expect(r).toEqual({ ok: false, reason: "date 2026-11-21 is in the future" });
  });

  it("rejects a feed where more than 10 currencies moved over 15% from their baselines unconfirmed", () => {
    const moved: Record<string, number> = {};
    for (const code of ALL.filter((c) => c !== "USD").slice(0, 11)) moved[code] = allRates()[code]! * 1.2;
    const r = check(feed(TODAY, allRates(moved)), { baseline: baselineOf(YESTERDAY) });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/^11 currencies moved more than 15% from their baselines unconfirmed/);
  });

  it("with a single configured source, many big moves are held one by one instead (nothing to switch to)", () => {
    const moved: Record<string, number> = {};
    const codes = ALL.filter((c) => c !== "USD").slice(0, 11);
    for (const code of codes) moved[code] = allRates()[code]! * 1.2;
    const r = ok(check(feed(TODAY, allRates(moved)), { baseline: baselineOf(YESTERDAY), single: true }));
    expect(r.held).toEqual(codes);
    expect(r.rates[codes[0]!]).toBe(allRates()[codes[0]!]);
  });

  it("holds a single big move the second source does not confirm, serving the baseline", () => {
    const r = ok(check(feed(TODAY, allRates({ NGN: 2000 })), { baseline: baselineOf(YESTERDAY) }));
    expect(r.held).toEqual(["NGN"]);
    expect(r.rates.NGN).toBe(KNOWN.NGN);
    expect(r.heldAsOf).toEqual({ NGN: YESTERDAY });
    expect(r.baseline.NGN).toEqual({ rate: KNOWN.NGN, asOf: YESTERDAY });
  });

  it("keeps a big move the second source confirms within 2%, and moves the baseline", () => {
    const r = ok(check(feed(TODAY, allRates({ NGN: 2000 })), { baseline: baselineOf(YESTERDAY), against: feed(TODAY, allRates({ NGN: 2010 })) }));
    expect(r.held).toEqual([]);
    expect(r.rates.NGN).toBe(2000);
    expect(r.baseline.NGN).toEqual({ rate: 2000, asOf: TODAY });
  });

  it("holds a currency the two sources disagree on by more than 5%", () => {
    const r = ok(check(feed(TODAY, allRates({ SYP: 13000 })), { against: feed(TODAY, allRates({ SYP: 13000 * 106 })) }));
    expect(r.disagreed).toEqual(["SYP"]);
    expect(r.held).toEqual(["SYP"]);
    expect(r.leftOut).toEqual(["SYP"]);
  });

  it("without a second source, accepts a rate within 15% of the baseline but leaves the baseline where it was", () => {
    const r = ok(check(feed(TODAY, allRates({ INR: KNOWN.INR! * 1.1 })), { baseline: baselineOf(YESTERDAY) }));
    expect(r.rates.INR).toBe(KNOWN.INR! * 1.1);
    expect(r.baseline.INR).toEqual({ rate: KNOWN.INR, asOf: YESTERDAY });
  });

  it("compares with the baseline however old it is; a held currency with a stale baseline is left out", () => {
    const r = ok(check(feed(TODAY, allRates({ INR: KNOWN.INR! * 1.3 })), { baseline: baselineOf("2026-11-01") }));
    expect(r.held).toEqual(["INR"]);
    expect(r.leftOut).toEqual(["INR"]);
    expect(r.rates.INR).toBeUndefined();
  });

  it("with a single configured source and no baseline, accepts the rate and makes it the baseline", () => {
    const r = ok(check(feed(TODAY), { single: true }));
    expect(r.held).toEqual([]);
    expect(r.baseline.INR).toEqual({ rate: KNOWN.INR, asOf: TODAY });
  });

  it("with a single configured source, the baseline follows each accepted rate", () => {
    const r = ok(check(feed(TODAY, allRates({ INR: KNOWN.INR! * 1.1 })), { baseline: baselineOf(YESTERDAY), single: true }));
    expect(r.baseline.INR).toEqual({ rate: KNOWN.INR! * 1.1, asOf: TODAY });
  });
});

describe("refreshFxRates", () => {
  const stored = (state: { store: Map<string, string | Uint8Array> }) => {
    const v = state.store.get(FX_RATES_KEY);
    return typeof v === "string" ? (JSON.parse(v) as FxRatesDoc) : null;
  };
  const savedStatus = (state: { store: Map<string, string | Uint8Array> }) =>
    JSON.parse(state.store.get(FX_STATUS_KEY) as string) as FxRefreshStatus;

  it("first run: today's dated file is missing, so yesterday's is used; writes the document and a status (2 KV writes)", async () => {
    const { kv, state } = createCountingKV();
    const status = await refreshFxRates(kv, {
      now: NOW,
      fetchImpl: fetchFrom({
        [JSDELIVR_YESTERDAY]: fawazBody(YESTERDAY),
        [FX_FALLBACK_URL]: frankfurterBody(TODAY),
      }),
    });
    expect(status).toMatchObject({ written: true, asOf: YESTERDAY, source: "primary", held: [], leftOut: [] });
    expect(state.writes).toEqual([FX_RATES_KEY, FX_STATUS_KEY]);
    const doc = stored(state)!;
    expect(doc).toMatchObject({ v: 1, base: "USD", asOf: YESTERDAY, source: "primary", fetchedAt: new Date(NOW).toISOString(), held: [], heldAsOf: {} });
    expect(doc.rates.INR).toBe(93.32614706);
    expect(doc.baseline!.INR).toEqual({ rate: 93.32614706, asOf: YESTERDAY });
    expect(doc.rates.BTC).toBeUndefined();
    expect(status.sources.map((s) => [s.url, s.ok])).toEqual([
      [JSDELIVR_TODAY, false],
      [JSDELIVR_YESTERDAY, true],
      [FX_FALLBACK_URL, true],
    ]);
    expect(savedStatus(state)).toEqual(status);
  });

  it("falls back to the Pages mirror when jsDelivr fails", async () => {
    const { kv, state } = createCountingKV();
    const status = await refreshFxRates(kv, {
      now: NOW,
      fetchImpl: fetchFrom({ [JSDELIVR_TODAY]: new Error("network"), [PAGES]: fawazBody(YESTERDAY), [FX_FALLBACK_URL]: frankfurterBody(YESTERDAY) }),
    });
    expect(status).toMatchObject({ written: true, source: "primary" });
    expect(stored(state)!.asOf).toBe(YESTERDAY);
  });

  it("uses Frankfurter, checked against the baselines, when every primary URL fails", async () => {
    const { kv, state } = createCountingKV();
    state.store.set(FX_RATES_KEY, JSON.stringify(prevDocWithBaseline("2026-11-17")));
    const status = await refreshFxRates(kv, { now: NOW, fetchImpl: fetchFrom({ [FX_FALLBACK_URL]: frankfurterBody(TODAY) }) });
    expect(status).toMatchObject({ written: true, source: "fallback", asOf: TODAY });
    expect(stored(state)!.source).toBe("fallback");
  });

  it("first run with only Frankfurter reachable writes nothing (nothing to check it against)", async () => {
    const { kv, state } = createCountingKV();
    const status = await refreshFxRates(kv, { now: NOW, fetchImpl: fetchFrom({ [FX_FALLBACK_URL]: frankfurterBody(TODAY) }) });
    expect(status).toMatchObject({ written: false });
    expect(status.reason).toMatch(/^fallback rejected: only 1 currencies would be served/);
    expect(stored(state)).toBeNull();
  });

  it("uses Frankfurter when the primary feed fails validation", async () => {
    const { kv, state } = createCountingKV();
    state.store.set(FX_RATES_KEY, JSON.stringify(prevDocWithBaseline("2026-11-17")));
    const status = await refreshFxRates(kv, {
      now: NOW,
      fetchImpl: fetchFrom({
        [JSDELIVR_TODAY]: fawazBody(TODAY, allRates({ INR: undefined })),
        [FX_FALLBACK_URL]: frankfurterBody(TODAY),
      }),
    });
    expect(status).toMatchObject({ written: true, source: "fallback" });
  });

  it("holds a currency the sources disagree on", async () => {
    const { kv, state } = createCountingKV();
    const status = await refreshFxRates(kv, {
      now: NOW,
      fetchImpl: fetchFrom({
        [JSDELIVR_TODAY]: fawazBody(TODAY, allRates({ KPW: 900 })),
        [FX_FALLBACK_URL]: frankfurterBody(TODAY, allRates({ KPW: 6231 })),
      }),
    });
    expect(status).toMatchObject({ written: true, held: ["KPW"], leftOut: ["KPW"], disagreed: ["KPW"] });
    expect(stored(state)!.rates.KPW).toBeUndefined();
    expect(stored(state)!.held).toEqual(["KPW"]);
  });

  it("when everything fails, writes only the status and keeps the previous document", async () => {
    const { kv, state } = createCountingKV();
    const previous = prevDoc("2026-11-17");
    state.store.set(FX_RATES_KEY, JSON.stringify(previous));
    const status = await refreshFxRates(kv, { now: NOW, fetchImpl: fetchFrom({}) });
    expect(status).toMatchObject({ written: false, asOf: "2026-11-17", reason: "no source could be fetched; previous rates kept" });
    expect(state.writes).toEqual([FX_STATUS_KEY]);
    expect(stored(state)).toEqual(previous);
  });

  it("does not write rates that are not newer than the stored ones", async () => {
    const { kv, state } = createCountingKV();
    state.store.set(FX_RATES_KEY, JSON.stringify(prevDocWithBaseline(YESTERDAY)));
    const status = await refreshFxRates(kv, { now: NOW, fetchImpl: fetchFrom({ [JSDELIVR_YESTERDAY]: fawazBody(YESTERDAY) }) });
    expect(status).toMatchObject({ written: false, reason: `rates dated ${YESTERDAY} are not newer than the stored ${YESTERDAY}` });
    expect(state.writes).toEqual([FX_STATUS_KEY]);
  });

  it("skips the run without writing when the stored document cannot be read", async () => {
    const { kv, state } = createCountingKV();
    state.getImpl = async () => {
      throw new Error("KV unavailable");
    };
    const fetchImpl = vi.fn(fetchFrom({ [JSDELIVR_TODAY]: fawazBody(TODAY) }));
    const status = await refreshFxRates(kv, { now: NOW, fetchImpl });
    expect(status).toMatchObject({ written: false, reason: "could not read existing rates" });
    expect(state.writes).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rebuilds from scratch when the stored document is malformed", async () => {
    const { kv, state } = createCountingKV();
    state.store.set(FX_RATES_KEY, JSON.stringify({ v: 99 }));
    const status = await refreshFxRates(kv, { now: NOW, fetchImpl: fetchFrom({ [JSDELIVR_TODAY]: fawazBody(TODAY), [FX_FALLBACK_URL]: frankfurterBody(TODAY) }) });
    expect(status).toMatchObject({ written: true, asOf: TODAY });
  });

  it("rejects an oversized body", async () => {
    const { kv } = createCountingKV();
    const huge = JSON.stringify({ date: TODAY, usd: { inr: 93 }, pad: "x".repeat(300 * 1024) });
    const status = await refreshFxRates(kv, { now: NOW, fetchImpl: fetchFrom({ [JSDELIVR_TODAY]: huge }), sources: { primary: [FX_PRIMARY_URLS[0]!], fallback: null } });
    expect(status.written).toBe(false);
    expect(status.sources[0]).toMatchObject({ ok: false, reason: "body exceeds 262144 bytes" });
  });

  it("does nothing at all when local pricing is off", async () => {
    const { kv, state } = createCountingKV();
    const fetchImpl = vi.fn(fetchFrom({}));
    const status = await refreshFxRates(kv, { now: NOW, fetchImpl, sources: { primary: null, fallback: null } });
    expect(status).toMatchObject({ written: false, reason: "local pricing is off (FX_RATES_URL=off)" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(state.reads).toBe(0);
    expect(state.writes).toEqual([]);
  });

  it("uses a custom feed with {date} and no fallback", async () => {
    const { kv, state } = createCountingKV();
    const custom = "https://rates.example.com/{date}.json";
    const status = await refreshFxRates(kv, {
      now: NOW,
      sources: { primary: [custom], fallback: null },
      fetchImpl: fetchFrom({ "https://rates.example.com/2026-11-19.json": JSON.stringify({ base: "USD", date: TODAY, rates: allRates() }) }),
    });
    expect(status).toMatchObject({ written: true, source: "primary", asOf: TODAY });
    expect(stored(state)!.rates.EUR).toBe(0.91080569);
  });

  it("throws when the document write fails, so the cron run shows as failed", async () => {
    const { kv, state } = createCountingKV();
    state.failWrites = true;
    await expect(
      refreshFxRates(kv, { now: NOW, fetchImpl: fetchFrom({ [JSDELIVR_TODAY]: fawazBody(TODAY), [FX_FALLBACK_URL]: frankfurterBody(TODAY) }) }),
    ).rejects.toThrow("KV write failed");
  });
});

describe("FX configuration", () => {
  it("defaults to the built-in sources", () => {
    expect(fxSourcesFromEnv({})).toEqual(DEFAULT_FX_SOURCES);
    expect(fxSourcesFromEnv({ FX_RATES_URL: " ", FX_RATES_FALLBACK_URL: "" })).toEqual(DEFAULT_FX_SOURCES);
  });

  it("takes custom URLs and 'off'", () => {
    expect(fxSourcesFromEnv({ FX_RATES_URL: "https://x/{date}.json", FX_RATES_FALLBACK_URL: "OFF" })).toEqual({
      primary: ["https://x/{date}.json"],
      fallback: null,
    });
    expect(fxSourcesFromEnv({ FX_RATES_URL: "off" }).primary).toBeNull();
    expect(fxDisabled({ FX_RATES_URL: " Off " })).toBe(true);
    expect(fxDisabled({})).toBe(false);
  });

  it("expands {date} to today then yesterday (UTC)", () => {
    expect(expandFxUrls([FX_PRIMARY_URLS[0]!, PAGES], NOW)).toEqual([JSDELIVR_TODAY, JSDELIVR_YESTERDAY, PAGES]);
  });

  it("wrangler.toml and wrangler.example.toml schedule FX_REFRESH_CRON", () => {
    for (const file of ["../../wrangler.toml", "../../wrangler.example.toml"]) {
      const toml = readFileSync(new URL(file, import.meta.url), "utf8");
      const crons = toml.match(/^\s*crons\s*=\s*\[([^\]]*)\]/m)?.[1] ?? "";
      expect([file, crons.includes(`"${FX_REFRESH_CRON}"`)]).toEqual([file, true]);
    }
  });
});
