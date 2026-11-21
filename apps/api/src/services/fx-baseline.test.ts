import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COUNTRY_CURRENCY, fxRateOf, localPricing, usableFxRates, type FxRatesDoc } from "@gopaylocal/shared/currency";
import { FX_RATES_KEY, FX_STATUS_KEY, refreshFxRates, type FxRefreshStatus, type FxSources } from "./fx-refresh.service";
import { createCountingKV, fetchFrom } from "./vpn-test-helpers";

// Security review M2 / L1: exchange-rate validation keeps a per-currency
// baseline (the last cross-checked rate) that survives holds, so no sequence of
// runs can get a bad rate served:
//  - the second source agrees: accepted, and the baseline moves;
//  - no second opinion, baseline exists: accepted only within 15% of the
//    baseline, which does not move;
//  - no second opinion, no baseline: not served (unless the fallback is "off");
//  - a held currency serves its baseline while that is under 96 hours old;
//  - count checks apply to what would be written; the other source is tried,
//    then the previous document is kept untouched.
// Assertions read what a visitor would be shown (usableFxRates + fxRateOf, the
// banner endpoint's read path), on every run of each sequence.

const PRIMARY = "https://primary.example/usd.json";
const FALLBACK = "https://fallback.example/rates";
const BOTH: FxSources = { primary: [PRIMARY], fallback: FALLBACK };
const SINGLE: FxSources = { primary: [PRIMARY], fallback: null };

const KNOWN: Record<string, number> = {
  USD: 1, INR: 93.32614706, BRL: 5.77828238, NGN: 1350.55082508, PKR: 276.41190323,
  BDT: 124.78644117, EGP: 53.73934758, VND: 25687.00391491, IDR: 18263.97004598,
  TRY: 50.43278606, ARS: 1552.2114862, EUR: 0.91080569, GBP: 0.75809074,
  JPY: 159.29003817, MXN: 18.45420564, ZAR: 16.96902142, KWD: 0.31163423,
};
const ALL = [...new Set(["USD", ...Object.values(COUNTRY_CURRENCY)])].sort();
function allRates(over: Record<string, number | undefined> = {}): Record<string, number> {
  const out: Record<string, number> = {};
  ALL.forEach((c, i) => (out[c] = KNOWN[c] ?? 1 + i * 3.7));
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete out[k];
    else out[k] = v;
  }
  return out;
}
const scaled = (f: number, rates = allRates()) =>
  Object.fromEntries(Object.entries(rates).map(([k, v]) => [k, k === "USD" ? 1 : v * f]));
const fawaz = (date: string, r: Record<string, number>) =>
  JSON.stringify({ date, usd: Object.fromEntries(Object.entries(r).map(([k, v]) => [k.toLowerCase(), v])) });
const frank = (date: string, r: Record<string, number>) => JSON.stringify({ base: "USD", date, rates: r });

const day = (n: number) => `2026-11-${String(n).padStart(2, "0")}`;
const runAt = (n: number) => Date.parse(`${day(n)}T07:00:00Z`);
const readAt = (n: number) => Date.parse(`${day(n)}T12:00:00Z`);

type Feed = Record<string, number> | "down";
async function run(kv: KVNamespace, n: number, primary: Feed, fallback: Feed, sources: FxSources = BOTH) {
  const bodies: Record<string, string | { status: number }> = {};
  bodies[PRIMARY] = primary === "down" ? { status: 503 } : fawaz(day(n), primary);
  bodies[FALLBACK] = fallback === "down" ? { status: 503 } : frank(day(n), fallback);
  return refreshFxRates(kv, { now: runAt(n), sources, fetchImpl: fetchFrom(bodies) });
}

const storedDoc = (state: { store: Map<string, string | Uint8Array> }) => {
  const v = state.store.get(FX_RATES_KEY);
  return typeof v === "string" ? (JSON.parse(v) as FxRatesDoc) : null;
};
/** The rate a visitor is converted with at `at`, as the banner endpoint reads it; null: exact price. */
function served(state: { store: Map<string, string | Uint8Array> }, code: string, at: number): number | null {
  const usable = usableFxRates(storedDoc(state), at);
  return usable ? fxRateOf(usable, code) : null;
}
const within15 = (rate: number, truth: number) => Math.abs(rate / truth - 1) <= 0.15 + 1e-9;

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("M2: a bad rate is never served on any later run", () => {
  it("NGN 100x too low with the fallback down: held, served at its baseline while fresh, then left out; never the bad value (11 runs)", async () => {
    const { kv, state } = createCountingKV();
    expect((await run(kv, 8, allRates(), allRates())).written).toBe(true); // cross-checked baseline
    const bad = allRates({ NGN: 13.5055 });
    for (let n = 9; n <= 19; n++) {
      await run(kv, n, bad, "down");
      const ngn = served(state, "NGN", readAt(n));
      expect({ n, ok: ngn === null || within15(ngn, KNOWN.NGN!) }).toEqual({ n, ok: true });
      const p = localPricing({ basePrice: 100, baseCurrency: "USD", discountPercent: 50, country: "NG", strategy: "round_x9", fx: storedDoc(state), now: readAt(n) });
      expect({ n, low: p!.currencyCode === "NGN" && p!.localPrice < 50 * KNOWN.NGN! * 0.85 }).toEqual({ n, low: false });
    }
    // Served at its (fresh) baseline the day after, left out once that is over 96 hours old.
    // (Re-run the first two days on a fresh store to look at them.)
    const fresh = createCountingKV();
    await run(fresh.kv, 8, allRates(), allRates());
    await run(fresh.kv, 9, bad, "down");
    expect(served(fresh.state, "NGN", readAt(9))).toBe(KNOWN.NGN);
    expect(served(fresh.state, "INR", readAt(9))).toBe(KNOWN.INR);
    expect(served(state, "NGN", readAt(19))).toBeNull();
  });

  it("a first run with the fallback down serves nothing from an inverted feed (10 runs)", async () => {
    const { kv, state } = createCountingKV();
    const inverted = allRates({ INR: 1 / 93.326, NGN: 1 / 1350.55, BRL: 1 / 5.778 });
    for (let n = 9; n <= 18; n++) {
      await run(kv, n, inverted, "down");
      for (const code of ["INR", "NGN", "BRL"]) {
        const r = served(state, code, readAt(n));
        expect({ n, code, ok: r === null || within15(r, KNOWN[code]!) }).toEqual({ n, code, ok: true });
      }
      const p = localPricing({ basePrice: 100, baseCurrency: "USD", discountPercent: 50, country: "IN", strategy: "none", fx: storedDoc(state), now: readAt(n) });
      expect(p!.currencyCode).toBe("USD"); // the exact, same-currency price
    }
  });

  it("drift just under 15% per run with the fallback down never moves a served rate more than 15% from the cross-checked one (10 runs)", async () => {
    const { kv, state } = createCountingKV();
    await run(kv, 8, allRates(), allRates());
    let rates = allRates();
    for (let n = 9; n <= 18; n++) {
      rates = scaled(0.851, rates);
      await run(kv, n, rates, "down");
      for (const code of ["INR", "NGN", "EUR"]) {
        const r = served(state, code, readAt(n));
        expect({ n, code, ok: r === null || within15(r, KNOWN[code]!) }).toEqual({ n, code, ok: true });
      }
    }
  });
});

describe("genuine moves and the single-source option", () => {
  it("a 40% move the fallback confirms is accepted on the first run, and becomes the baseline", async () => {
    const { kv, state } = createCountingKV();
    await run(kv, 8, allRates(), allRates());
    const moved = KNOWN.NGN! * 1.4;
    const status = await run(kv, 9, allRates({ NGN: moved }), allRates({ NGN: moved * 1.005 }));
    expect(status.written).toBe(true);
    expect(status.held).not.toContain("NGN");
    expect(served(state, "NGN", readAt(9))).toBe(moved);
    expect(storedDoc(state)!.baseline!.NGN).toEqual({ rate: moved, asOf: day(9) });
  });

  it('FX_RATES_FALLBACK_URL="off": a first run is accepted; a later 40% jump is held and stays held (10 runs)', async () => {
    const { kv, state } = createCountingKV();
    expect((await run(kv, 8, allRates(), "down", SINGLE)).written).toBe(true);
    expect(served(state, "INR", readAt(8))).toBe(KNOWN.INR);
    const jumped = allRates({ INR: KNOWN.INR! * 1.4 });
    for (let n = 9; n <= 18; n++) {
      const status = await run(kv, n, jumped, "down", SINGLE);
      expect({ n, held: status.held.includes("INR") }).toEqual({ n, held: true });
      const r = served(state, "INR", readAt(n));
      expect({ n, ok: r === null || r === KNOWN.INR }).toEqual({ n, ok: true });
      expect(served(state, "EUR", readAt(n))).toBe(KNOWN.EUR); // the others keep converting
    }
    expect(served(state, "INR", readAt(18))).toBeNull(); // the day-8 baseline has aged out
  });

  it('with "off", the baseline follows each accepted value (nothing to cross-check against)', async () => {
    const { kv, state } = createCountingKV();
    await run(kv, 8, allRates(), "down", SINGLE);
    await run(kv, 9, allRates({ INR: KNOWN.INR! * 1.1 }), "down", SINGLE);
    expect(storedDoc(state)!.baseline!.INR).toEqual({ rate: KNOWN.INR! * 1.1, asOf: day(9) });
  });
});

describe("L1 and failed runs", () => {
  it("a primary 10% off everywhere with a correct fallback never replaces a good document with a near-empty one", async () => {
    // A good document written before baselines existed (no baseline field).
    const { kv, state } = createCountingKV();
    const old = { v: 1, base: "USD", asOf: day(18), fetchedAt: "x", source: "primary", rates: allRates(), held: [] };
    state.store.set(FX_RATES_KEY, JSON.stringify(old));
    const status = await run(kv, 19, scaled(1.1), allRates());
    expect(status.written).toBe(false);
    expect(JSON.parse(state.store.get(FX_RATES_KEY) as string)).toEqual(old);
  });

  it("with baselines, the same bad primary serves the cross-checked rates, never a near-empty document", async () => {
    const { kv, state } = createCountingKV();
    await run(kv, 18, allRates(), allRates());
    await run(kv, 19, scaled(1.1), allRates());
    expect(Object.keys(storedDoc(state)!.rates).length).toBeGreaterThan(100);
    expect(served(state, "INR", readAt(19))).toBe(KNOWN.INR);
  });

  it("the previous document survives untouched when both sources fail validation", async () => {
    const { kv, state } = createCountingKV();
    await run(kv, 18, allRates(), allRates());
    const before = state.store.get(FX_RATES_KEY);
    const status = await run(kv, 19, allRates({ INR: undefined }), allRates({ INR: undefined }));
    expect(status).toMatchObject({ written: false });
    expect(status.reason).toMatch(/previous rates kept$/);
    expect(state.store.get(FX_RATES_KEY)).toBe(before);
  });

  it("names held and left-out currencies in one warning and in fx:status", async () => {
    // NGN: an unconfirmed big move, held at its fresh baseline. SYP: the sources
    // disagree and it has no baseline (day 18 had no SYP), so it is left out.
    const warn = vi.mocked(console.warn);
    const fresh = createCountingKV();
    await run(fresh.kv, 18, allRates({ SYP: undefined }), allRates({ SYP: undefined }));
    warn.mockClear();
    const status = await run(fresh.kv, 19, allRates({ NGN: 2000, SYP: 13000 }), allRates({ NGN: 1351, SYP: 13000 * 106 }));
    expect(status.held).toEqual(["NGN", "SYP"]);
    expect(status.leftOut).toEqual(["SYP"]);
    const saved = JSON.parse(fresh.state.store.get(FX_STATUS_KEY) as string) as FxRefreshStatus;
    expect(saved.held).toEqual(["NGN", "SYP"]);
    expect(saved.leftOut).toEqual(["SYP"]);
    const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("held"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("NGN");
    expect(lines[0]).toContain("SYP");
    expect(lines[0]).not.toMatch(/\d{3,}/); // codes only, no rates
  });
});

describe("the read side", () => {
  it("a left-out currency gets the exact, same-currency price", async () => {
    const { kv, state } = createCountingKV();
    await run(kv, 18, allRates({ SYP: undefined }), allRates({ SYP: undefined }));
    await run(kv, 19, allRates({ SYP: 13000 }), allRates({ SYP: 13000 * 106 }));
    const p = localPricing({ basePrice: 19, baseCurrency: "USD", discountPercent: 30, country: "SY", strategy: "round_x9", fx: storedDoc(state), now: readAt(19) });
    expect(p).toMatchObject({ currencyCode: "USD", fxRate: 1, localPrice: 13.3, localOriginalPrice: 19 });
    expect(p).not.toHaveProperty("fxAsOf");
  });

  it("a held currency's baseline stops being served once it is over 96 hours old, even if no new document is written", async () => {
    const { kv, state } = createCountingKV();
    await run(kv, 8, allRates(), allRates());
    await run(kv, 9, allRates({ NGN: 13.5 }), "down"); // NGN held at its day-8 baseline
    expect(served(state, "NGN", readAt(9))).toBe(KNOWN.NGN);
    // No later run writes; the document itself is still fresh on day 12 (asOf day 9).
    expect(served(state, "INR", Date.parse(`${day(12)}T12:00:00Z`))).toBe(KNOWN.INR);
    expect(served(state, "NGN", Date.parse(`${day(12)}T12:00:00Z`))).toBeNull();
  });
});

describe("required currencies (approved rule 4: required set on the feed, count on what is written)", () => {
  it("a required currency held beyond 96 hours is left out alone; the rest is still written and served", async () => {
    const { kv, state } = createCountingKV();
    await run(kv, 8, allRates(), allRates());
    // From day 9 the sources disagree on INR (a required currency) for six days.
    for (let n = 9; n <= 14; n++) {
      const status = await run(kv, n, allRates({ INR: 140 }), allRates());
      expect({ n, written: status.written, held: status.held }).toEqual({ n, written: true, held: ["INR"] });
      expect(served(state, "EUR", readAt(n))).toBe(KNOWN.EUR);
      expect(served(state, "NGN", readAt(n))).toBe(KNOWN.NGN);
    }
    // The day-8 baseline is over 96 hours old from day 13: INR is left out, the document is not.
    const last = JSON.parse(state.store.get(FX_STATUS_KEY) as string) as FxRefreshStatus;
    expect(last.leftOut).toEqual(["INR"]);
    expect(storedDoc(state)!.asOf).toBe(day(14));
    expect(served(state, "INR", readAt(14))).toBeNull();
    const p = localPricing({ basePrice: 19, baseCurrency: "USD", discountPercent: 40, country: "IN", strategy: "none", fx: storedDoc(state), now: readAt(14) });
    expect(p).toMatchObject({ currencyCode: "USD", fxRate: 1 });
    const br = localPricing({ basePrice: 19, baseCurrency: "USD", discountPercent: 40, country: "BR", strategy: "none", fx: storedDoc(state), now: readAt(14) });
    expect(br).toMatchObject({ currencyCode: "BRL", fxAsOf: day(14) });
  });
});

describe("price-maths review F1-F3", () => {
  it("F1: NGN x10 is held on day 1 and not served as 13,505.5 on day 2 (fallback down)", async () => {
    const { kv, state } = createCountingKV();
    await run(kv, 17, allRates(), allRates());
    const x10 = allRates({ NGN: 13505.5082508 });
    for (let n = 18; n <= 27; n++) {
      await run(kv, n, x10, "down");
      expect({ n, ngn: served(state, "NGN", readAt(n)) }).not.toEqual({ n, ngn: 13505.5082508 });
    }
  });

  it('F1 with FX_RATES_FALLBACK_URL="off": the same x10 is never served either', async () => {
    const { kv, state } = createCountingKV();
    await run(kv, 17, allRates(), "down", SINGLE);
    for (let n = 18; n <= 27; n++) {
      await run(kv, n, allRates({ NGN: 13505.5082508 }), "down", SINGLE);
      expect({ n, ngn: served(state, "NGN", readAt(n)) }).not.toEqual({ n, ngn: 13505.5082508 });
    }
  });

  it("F2: a primary 10% high everywhere over a stored document serves no 10%-high rate", async () => {
    const { kv, state } = createCountingKV();
    await run(kv, 17, allRates(), allRates());
    await run(kv, 18, scaled(1.1), allRates());
    for (const code of ["INR", "NGN", "EUR", "JPY"]) expect(served(state, code, readAt(18))).toBe(KNOWN[code]);
  });

  it("F3: a first run with the fallback down cannot accept INR x100", async () => {
    const { kv, state } = createCountingKV();
    const status = await run(kv, 19, allRates({ INR: KNOWN.INR! * 100 }), "down");
    expect(status.written).toBe(false);
    expect(served(state, "INR", readAt(19))).toBeNull();
  });

  it("F3: a previous document more than 7 days older cannot let INR x100 through (fallback down)", async () => {
    const { kv, state } = createCountingKV();
    await run(kv, 1, allRates(), allRates());
    for (let n = 10; n <= 19; n++) {
      await run(kv, n, allRates({ INR: KNOWN.INR! * 100 }), "down");
      expect({ n, inr: served(state, "INR", readAt(n)) }).toEqual({ n, inr: null });
    }
  });

  it("F3: a rate of 1e-9 is refused by the refresh and by the read side", async () => {
    const { kv, state } = createCountingKV();
    const status = await run(kv, 19, allRates({ CHF: 1e-9 }), allRates({ CHF: 1e-9 }));
    expect(status.held).toContain("CHF");
    expect(storedDoc(state)!.rates.CHF).toBeUndefined();
    // A stored document carrying one (written by anything else) is not converted with either.
    const doc = { ...storedDoc(state)!, rates: { ...storedDoc(state)!.rates, CHF: 1e-9, IRR: 2e7 } };
    expect(fxRateOf(doc, "CHF")).toBeNull();
    expect(fxRateOf(doc, "IRR")).toBeNull();
    expect(fxRateOf(doc, "KWD")).toBe(KNOWN.KWD);
    const p = localPricing({ basePrice: 19, baseCurrency: "USD", discountPercent: 40, country: "CH", strategy: "none", fx: doc, now: readAt(19) });
    expect(p).toMatchObject({ currencyCode: "USD", fxRate: 1 });
  });
});
