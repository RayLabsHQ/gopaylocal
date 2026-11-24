import { describe, expect, it } from "vitest";
import { applyCountryPrices, type CountryPriceRow, type DodoReply, type DodoRequest, type DodoRule } from "./dodo-country-prices";

const row = (country: string, currency: string, minorAmount: number): CountryPriceRow => ({
  country,
  countryName: country,
  discount: 50,
  charge: { currency, amount: minorAmount / 100, minorAmount, local: currency !== "USD" },
});

/** A Dodo that keeps one product's rules in memory and logs every call. */
function fakeDodo(opts: { pricingMode?: string | null; rules?: DodoRule[]; refuse?: (method: string, path: string) => boolean } = {}) {
  let rules = [...(opts.rules ?? [])];
  let pricingMode = "pricingMode" in opts ? (opts.pricingMode ?? null) : "by_country";
  let nextId = 1;
  const calls: string[] = [];
  const reply = (status: number, body: unknown = null): DodoReply => ({ ok: status < 300, status, body });
  const request: DodoRequest = async (method, path, body) => {
    calls.push(`${method} ${path}`);
    if (opts.refuse?.(method, path)) return reply(403, { message: "INSUFFICIENT_PERMISSION" });
    const b = (body ?? {}) as Record<string, unknown>;
    if (path === "/products/pdt_1" && method === "GET") return reply(200, { product_id: "pdt_1", pricing_mode: pricingMode });
    if (path === "/products/pdt_1" && method === "PATCH") {
      pricingMode = String(b.pricing_mode);
      return reply(200);
    }
    if (path === "/products/pdt_1/localized-prices" && method === "GET") return reply(200, { items: rules });
    if (path === "/products/pdt_1/localized-prices" && method === "POST") {
      const rule = { id: `lp_new${nextId++}`, country_code: String(b.country_code), currency: String(b.currency), amount: Number(b.amount) };
      rules.push(rule);
      return reply(200, rule);
    }
    const id = decodeURIComponent(path.split("/").pop()!);
    if (method === "PATCH") {
      rules = rules.map((r) => (r.id === id ? { ...r, amount: Number(b.amount) } : r));
      return reply(200);
    }
    if (method === "DELETE") {
      rules = rules.filter((r) => r.id !== id);
      return reply(200);
    }
    return reply(404);
  };
  return { request, calls, rules: () => rules, pricingMode: () => pricingMode };
}

describe("applyCountryPrices", () => {
  it("switches the product to per-country prices, then creates, updates, replaces and archives rules", async () => {
    const dodo = fakeDodo({
      pricingMode: null,
      rules: [
        { id: "lp_in", country_code: "IN", currency: "INR", amount: 53900 },
        { id: "lp_br", country_code: "BR", currency: "USD", amount: 900 },
        { id: "lp_de", country_code: "DE", currency: "EUR", amount: 1599 },
      ],
    });
    const out = await applyCountryPrices(dodo.request, "pdt_1", [row("IN", "INR", 52900), row("BR", "BRL", 4900), row("MX", "MXN", 18900)], {
      budget: 35,
      label: "the product",
    });
    expect(out).toMatchObject({ ok: true, result: { created: 1, updated: 2, archived: 1, failures: [], remaining: 0 } });
    expect(dodo.pricingMode()).toBe("by_country");
    expect(dodo.rules().map((r) => `${r.country_code} ${r.currency} ${r.amount}`).sort()).toEqual(["BR BRL 4900", "IN INR 52900", "MX MXN 18900"]);
    if (out.ok) expect(out.result.rulesAfter.map((r) => r.country_code).sort()).toEqual(["BR", "IN", "MX"]);
  });

  it("stops at the call budget and reports what is left", async () => {
    const dodo = fakeDodo();
    const rows = ["AR", "BD", "EG", "IN", "NG"].map((c) => row(c, "USD", 570));
    // GET product + GET rules = 2 calls, so a budget of 4 leaves room for 2 creates.
    const out = await applyCountryPrices(dodo.request, "pdt_1", rows, { budget: 4, label: "the product" });
    expect(out).toMatchObject({ ok: true, result: { created: 2, remaining: 3 } });
    expect(dodo.calls).toHaveLength(4);
  });

  it("names the product and Dodo's answer when a read is refused", async () => {
    const dodo = fakeDodo({ refuse: (method, path) => method === "GET" && path === "/products/pdt_1" });
    const out = await applyCountryPrices(dodo.request, "pdt_1", [row("IN", "INR", 52900)], { budget: 35, label: "the Pro product" });
    expect(out).toEqual({ ok: false, problem: "Couldn't read the Pro product. Dodo answered 403: INSUFFICIENT_PERMISSION", status: 403 });
  });

  it("removes only the rules mayArchive allows, and leaves the rest exactly as they are", async () => {
    const dodo = fakeDodo({
      rules: [
        { id: "lp_ours", country_code: "IN", currency: "INR", amount: 52900 },
        { id: "lp_theirs", country_code: "DE", currency: "EUR", amount: 1599 },
        { id: "lp_currency", country_code: null, currency: "GBP", amount: 1299 },
      ],
    });
    // A removal: no rows wanted, only India is GoPayLocal's.
    const out = await applyCountryPrices(dodo.request, "pdt_1", [], {
      budget: 35,
      label: "the product",
      mayArchive: (rule) => rule.country_code === "IN",
      ensureByCountry: false,
    });
    expect(out).toMatchObject({ ok: true, result: { archived: 1, remaining: 0 } });
    expect(dodo.rules().map((r) => r.id).sort()).toEqual(["lp_currency", "lp_theirs"]);
    expect(dodo.calls).not.toContain("PATCH /products/pdt_1");
  });

  it("writes nothing, and doesn't call beforeWrite, when checkRules refuses", async () => {
    const dodo = fakeDodo({ pricingMode: null, rules: [{ id: "lp_theirs", country_code: "DE", currency: "EUR", amount: 1599 }] });
    let wrote = false;
    const out = await applyCountryPrices(dodo.request, "pdt_1", [row("IN", "INR", 52900)], {
      budget: 35,
      label: "the product",
      checkRules: (rules) => (rules.length ? "has rules of its own" : null),
      beforeWrite: async () => {
        wrote = true;
      },
    });
    expect(out).toEqual({ ok: false, problem: "has rules of its own" });
    expect(wrote).toBe(false);
    expect(dodo.calls).toEqual(["GET /products/pdt_1", "GET /products/pdt_1/localized-prices"]);
    expect(dodo.pricingMode()).toBeNull();
  });

  it("records a refused write per country and keeps going", async () => {
    const dodo = fakeDodo({ refuse: (method) => method === "POST" });
    const out = await applyCountryPrices(dodo.request, "pdt_1", [row("IN", "INR", 52900), row("BR", "BRL", 4900)], {
      budget: 35,
      label: "the product",
    });
    expect(out).toMatchObject({ ok: true, result: { created: 0, remaining: 0 } });
    if (out.ok) {
      expect(out.result.failures.map((f) => f.country)).toEqual(["IN", "BR"]);
      expect(out.result.rulesAfter).toEqual([]);
    }
  });
});
