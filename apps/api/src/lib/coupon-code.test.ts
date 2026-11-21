import { describe, it, expect } from "vitest";
import { DEAL_SLUG_MAX_LENGTH, generateDealCode } from "./coupon-code";

/** Random bytes that always pick the same suffix character. */
const zeros = (n: number) => new Uint8Array(n);

describe("generateDealCode", () => {
  it("is the deal's name, its percentage, a separator and four random characters", () => {
    const code = generateDealCode("Black Friday", 40, "chargebee");
    expect(code).toMatch(/^BLACKFRIDAY40-[A-Z2-9]{4}$/);
  });

  it("has no separator for providers that only take letters and digits", () => {
    for (const provider of ["stripe", "paddle", "polar", "creem"]) {
      expect(generateDealCode("Black Friday", 40, provider)).toMatch(/^BLACKFRIDAY40[A-Z2-9]{4}$/);
    }
  });

  it("cuts the name to fit a provider's length limit (Dodo: 16 characters)", () => {
    const code = generateDealCode("Black Friday", 40, "dodopayments");
    expect(code).toMatch(/^BLACKFRID40-[A-Z2-9]{4}$/);
    expect(code.length).toBeLessThanOrEqual(16);
    expect(generateDealCode("Black Friday", 100, "dodopayments").length).toBeLessThanOrEqual(16);
  });

  it(`uses at most ${DEAL_SLUG_MAX_LENGTH} characters of the name`, () => {
    const code = generateDealCode("End of Financial Year Clearance", 15, "gumroad");
    expect(code).toMatch(/^ENDOFFINANCI15-[A-Z2-9]{4}$/);
  });

  it("drops accents and anything that is not a letter or a digit", () => {
    expect(generateDealCode("Fête d'été 2027!", 20, "stripe")).toMatch(/^FETEDETE202720[A-Z2-9]{4}$/);
  });

  it("a name without letters or digits becomes DEAL", () => {
    expect(generateDealCode("🎄🎁", 25, "stripe")).toMatch(/^DEAL25[A-Z2-9]{4}$/);
    expect(generateDealCode("节日", 25)).toMatch(/^DEAL25-[A-Z2-9]{4}$/);
  });

  it("rounds a fractional percentage", () => {
    expect(generateDealCode("Sale", 12.6, "stripe")).toMatch(/^SALE13[A-Z2-9]{4}$/);
  });

  it("two codes for the same deal differ (the suffix is random), and the suffix source can be injected", () => {
    const codes = new Set(Array.from({ length: 40 }, () => generateDealCode("Sale", 10, "stripe")));
    expect(codes.size).toBeGreaterThan(30);
    expect(generateDealCode("Sale", 10, "stripe", zeros)).toBe(generateDealCode("Sale", 10, "stripe", zeros));
  });
});
