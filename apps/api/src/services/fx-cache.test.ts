import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadFxRates, parseExcludedCurrencies, resetFxCacheForTests } from "./fx-cache";
import { FX_RATES_KEY } from "./fx-refresh.service";
import { createCountingKV } from "./vpn-test-helpers";

const NOW = Date.parse("2026-11-19T12:00:00Z");
const DOC = { v: 1, base: "USD", asOf: "2026-11-18", fetchedAt: "x", source: "primary", rates: { USD: 1, INR: 93.3 }, held: [] };

beforeEach(() => {
  resetFxCacheForTests();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("loadFxRates", () => {
  it("reads KV once and serves the memoised document for 10 minutes", async () => {
    const { kv, state } = createCountingKV();
    state.store.set(FX_RATES_KEY, JSON.stringify(DOC));
    expect(await loadFxRates(kv, NOW)).toEqual(DOC);
    expect(await loadFxRates(kv, NOW + 9 * 60_000)).toEqual(DOC);
    expect(state.reads).toBe(1);
    await loadFxRates(kv, NOW + 10 * 60_000);
    expect(state.reads).toBe(2);
  });

  it("asks KV for its edge cache", async () => {
    const get = vi.fn(async () => DOC);
    await loadFxRates({ get } as unknown as KVNamespace, NOW);
    expect(get).toHaveBeenCalledWith(FX_RATES_KEY, { type: "json", cacheTtl: 300 });
  });

  it("returns null when there is no document", async () => {
    const { kv } = createCountingKV();
    expect(await loadFxRates(kv, NOW)).toBeNull();
  });

  it("returns null on a KV error and retries after 30 seconds, never throwing", async () => {
    const { kv, state } = createCountingKV();
    state.getImpl = async () => {
      throw new Error("KV down");
    };
    expect(await loadFxRates(kv, NOW)).toBeNull();
    expect(await loadFxRates(kv, NOW + 29_000)).toBeNull();
    expect(state.reads).toBe(1);
    state.getImpl = null;
    state.store.set(FX_RATES_KEY, JSON.stringify(DOC));
    expect(await loadFxRates(kv, NOW + 30_000)).toEqual(DOC);
  });
});

describe("parseExcludedCurrencies", () => {
  it("parses a comma-separated list, ignoring malformed entries", () => {
    expect([...parseExcludedCurrencies(" ars, VES ,, x, usdt")].sort()).toEqual(["ARS", "VES"]);
    expect(parseExcludedCurrencies(undefined).size).toBe(0);
  });
});
