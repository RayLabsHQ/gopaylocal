import { describe, it, expect } from "vitest";
import {
  assignVariant,
  parseProductParam,
  parseVisitorId,
  selectAllServings,
  selectDefaultProductId,
  selectProductServing,
  selectServing,
  visitorKey,
  type SelectableCampaign,
  type SelectableExperiment,
  type SelectionInput,
} from "./banner-selection";

const at = (minutes: number) => new Date(Date.UTC(2026, 10, 1, 0, minutes));

function campaign(id: string, overrides: Partial<SelectableCampaign> = {}): SelectableCampaign {
  return {
    id,
    productId: "P1",
    environment: "live",
    status: "active",
    createdAt: at(0),
    hasBanner: true,
    ...overrides,
  };
}

function experiment(overrides: Partial<SelectableExperiment> = {}): SelectableExperiment {
  return {
    id: "EXP1",
    productId: "P1",
    environment: "live",
    status: "running",
    campaignAId: "A",
    campaignBId: "B",
    trafficSplitB: 50,
    startedAt: at(30),
    ...overrides,
  };
}

const input = (campaigns: SelectableCampaign[], experiments: SelectableExperiment[] = []): SelectionInput => ({
  campaigns,
  experiments,
});

describe("selectProductServing: campaigns", () => {
  it("serves the newest servable campaign of the product", () => {
    const sel = selectProductServing(
      input([campaign("OLD", { createdAt: at(1) }), campaign("NEW", { createdAt: at(5) })]),
      "P1",
    );
    expect(sel).toEqual({ kind: "campaign", campaignId: "NEW" });
  });

  it("breaks a created_at tie by the higher id, so the answer is deterministic", () => {
    const sel = selectProductServing(input([campaign("01A"), campaign("01B")]), "P1");
    expect(sel).toEqual({ kind: "campaign", campaignId: "01B" });
  });

  it("skips campaigns that are not active or have no banner config", () => {
    const sel = selectProductServing(
      input([
        campaign("OLDER", { createdAt: at(1) }),
        campaign("PAUSED", { createdAt: at(9), status: "paused" }),
        campaign("NOBANNER", { createdAt: at(8), hasBanner: false }),
      ]),
      "P1",
    );
    expect(sel).toEqual({ kind: "campaign", campaignId: "OLDER" });
  });

  it("never serves another product's campaign", () => {
    expect(selectProductServing(input([campaign("X", { productId: "P2" })]), "P1")).toBeNull();
  });

  it("considers live before test, even when the test campaign is newer", () => {
    const sel = selectProductServing(
      input([
        campaign("LIVE", { createdAt: at(1) }),
        campaign("TEST", { createdAt: at(9), environment: "test" }),
      ]),
      "P1",
    );
    expect(sel).toEqual({ kind: "campaign", campaignId: "LIVE" });
  });

  it("serves a test campaign when the product has nothing live", () => {
    const sel = selectProductServing(input([campaign("TEST", { environment: "test" })]), "P1");
    expect(sel).toEqual({ kind: "campaign", campaignId: "TEST" });
  });
});

describe("selectProductServing: experiments", () => {
  const arms = [campaign("A", { createdAt: at(1) }), campaign("B", { createdAt: at(2) })];

  it("a running experiment with both arms servable wins over a newer plain campaign", () => {
    const sel = selectProductServing(
      input([...arms, campaign("NEWEST", { createdAt: at(50) })], [experiment()]),
      "P1",
    );
    expect(sel).toEqual({
      kind: "experiment",
      experimentId: "EXP1",
      campaignAId: "A",
      campaignBId: "B",
      trafficSplitB: 50,
    });
  });

  it("ignores ended experiments", () => {
    const sel = selectProductServing(input(arms, [experiment({ status: "ended" })]), "P1");
    expect(sel).toEqual({ kind: "campaign", campaignId: "B" });
  });

  it("one arm not servable: the healthy arm is served to everyone as a plain campaign", () => {
    const pausedA = [campaign("A", { status: "paused" }), campaign("B")];
    expect(selectProductServing(input(pausedA, [experiment()]), "P1")).toEqual({
      kind: "campaign",
      campaignId: "B",
    });
    const deletedB = [campaign("A"), campaign("OTHER", { createdAt: at(99) })];
    expect(selectProductServing(input(deletedB, [experiment()]), "P1")).toEqual({
      kind: "campaign",
      campaignId: "A",
    });
  });

  it("neither arm servable: the experiment is ignored and normal selection applies", () => {
    const sel = selectProductServing(
      input(
        [campaign("A", { status: "paused" }), campaign("B", { hasBanner: false }), campaign("C")],
        [experiment()],
      ),
      "P1",
    );
    expect(sel).toEqual({ kind: "campaign", campaignId: "C" });
  });

  it("an arm from another product or environment is not servable for the experiment", () => {
    const wrongProduct = [campaign("A"), campaign("B", { productId: "P2" })];
    expect(selectProductServing(input(wrongProduct, [experiment()]), "P1")).toEqual({
      kind: "campaign",
      campaignId: "A",
    });
    const wrongEnv = [campaign("A"), campaign("B", { environment: "test" })];
    expect(selectProductServing(input(wrongEnv, [experiment()]), "P1")).toEqual({
      kind: "campaign",
      campaignId: "A",
    });
  });

  it("a live campaign beats a test experiment on the same product", () => {
    const sel = selectProductServing(
      input(
        [
          campaign("LIVE"),
          campaign("A", { environment: "test" }),
          campaign("B", { environment: "test" }),
        ],
        [experiment({ environment: "test" })],
      ),
      "P1",
    );
    expect(sel).toEqual({ kind: "campaign", campaignId: "LIVE" });
  });

  it("clamps a stored split outside 1-99", () => {
    const zero = selectProductServing(input(arms, [experiment({ trafficSplitB: 0 })]), "P1");
    const hundred = selectProductServing(input(arms, [experiment({ trafficSplitB: 100 })]), "P1");
    expect(zero).toMatchObject({ trafficSplitB: 1 });
    expect(hundred).toMatchObject({ trafficSplitB: 99 });
  });
});

describe("default product (no `product` in the request)", () => {
  it("single product: exactly the newest active campaign, as before", () => {
    const data = input([campaign("C1", { createdAt: at(1) }), campaign("C2", { createdAt: at(2) })]);
    expect(selectServing(data, null)).toEqual({ kind: "campaign", campaignId: "C2" });
  });

  it("several products: the product of the newest servable live campaign", () => {
    const data = input([
      campaign("P1C", { productId: "P1", createdAt: at(1) }),
      campaign("P2C", { productId: "P2", createdAt: at(2) }),
      campaign("P3TEST", { productId: "P3", createdAt: at(3), environment: "test" }),
    ]);
    expect(selectDefaultProductId(data)).toBe("P2");
    expect(selectServing(data, null)).toEqual({ kind: "campaign", campaignId: "P2C" });
  });

  it("falls back to test campaigns only when nothing live is servable", () => {
    const data = input([campaign("T", { productId: "P9", environment: "test" })]);
    expect(selectDefaultProductId(data)).toBe("P9");
  });

  it("the default product's experiment applies", () => {
    const data = input([campaign("A"), campaign("B")], [experiment()]);
    expect(selectServing(data, null)).toMatchObject({ kind: "experiment", experimentId: "EXP1" });
  });

  it("nothing servable: null", () => {
    expect(selectServing(input([campaign("X", { status: "paused" })]), null)).toBeNull();
  });
});

describe("selectServing with a product", () => {
  const data = input([
    campaign("P1C", { productId: "P1", createdAt: at(1) }),
    campaign("P2C", { productId: "P2", createdAt: at(2) }),
  ]);

  it("two products each get their own campaign", () => {
    expect(selectServing(data, "P1")).toEqual({ kind: "campaign", campaignId: "P1C" });
    expect(selectServing(data, "P2")).toEqual({ kind: "campaign", campaignId: "P2C" });
  });

  it("an unknown or malformed product gets nothing, never another product's campaign", () => {
    expect(selectServing(data, "NOPE")).toBeNull();
    expect(selectServing(data, parseProductParam("bad id!"))).toBeNull();
  });

  it("selectAllServings maps every product and agrees with selectServing", () => {
    const withExp = input(
      [...data.campaigns, campaign("A", { productId: "P3" }), campaign("B", { productId: "P3" })],
      [experiment({ productId: "P3" })],
    );
    const all = selectAllServings(withExp);
    for (const id of ["P1", "P2", "P3"]) {
      expect(all.products[id]).toEqual(selectServing(withExp, id));
    }
    expect(all.defaultProductId).toBe(selectDefaultProductId(withExp));
  });
});

describe("request parameters", () => {
  it("vid: 16-64 chars of [A-Za-z0-9_-], anything else ignored", () => {
    expect(parseVisitorId("abcdefghij012345")).toBe("abcdefghij012345");
    expect(parseVisitorId("a".repeat(64))).toBe("a".repeat(64));
    expect(parseVisitorId("short")).toBeNull();
    expect(parseVisitorId("a".repeat(65))).toBeNull();
    expect(parseVisitorId("has space in it!!")).toBeNull();
    expect(parseVisitorId(undefined)).toBeNull();
  });

  it("product: empty is absent; a malformed id matches nothing", () => {
    expect(parseProductParam(undefined)).toBeNull();
    expect(parseProductParam("")).toBeNull();
    expect(parseProductParam("01JABCDEF")).toBe("01JABCDEF");
    expect(parseProductParam("../x")).toBe("");
    expect(parseProductParam("x".repeat(65))).toBe("");
  });

  it("visitor key: the vid when given, else IP and user agent", () => {
    expect(visitorKey("abcdefghij012345", "1.2.3.4", "UA")).toBe("v:abcdefghij012345");
    expect(visitorKey(null, "1.2.3.4", "UA")).toBe("ipua:1.2.3.4\nUA");
  });
});

describe("assignVariant", () => {
  const ids = Array.from({ length: 4000 }, (_, i) => `visitor-${String(i).padStart(10, "0")}`);

  it("is stable for the same experiment and visitor", async () => {
    for (const id of ids.slice(0, 50)) {
      const first = await assignVariant("EXP1", `v:${id}`, 50);
      expect(await assignVariant("EXP1", `v:${id}`, 50)).toBe(first);
    }
  });

  it("splits close to traffic_split_b over many visitors", async () => {
    for (const split of [50, 20, 90]) {
      let b = 0;
      for (const id of ids) if ((await assignVariant("EXP1", `v:${id}`, split)) === "b") b++;
      const share = (b / ids.length) * 100;
      // 4000 samples: 3 standard deviations is at most ~2.4 points.
      expect(Math.abs(share - split)).toBeLessThan(3);
    }
  });

  it("assignments for different experiments are independent", async () => {
    let same = 0;
    for (const id of ids.slice(0, 2000)) {
      if ((await assignVariant("EXP1", `v:${id}`, 50)) === (await assignVariant("EXP2", `v:${id}`, 50))) same++;
    }
    expect(Math.abs(same / 2000 - 0.5)).toBeLessThan(0.05);
  });

  it("the IP + user-agent fallback is sticky and differs by visitor", async () => {
    const k1 = visitorKey(null, "198.51.100.7", "Mozilla/5.0 A");
    expect(await assignVariant("EXP1", k1, 50)).toBe(await assignVariant("EXP1", k1, 50));
    const variants = new Set<string>();
    for (let i = 0; i < 64; i++) {
      variants.add(await assignVariant("EXP1", visitorKey(null, `198.51.100.${i}`, "UA"), 50));
    }
    expect(variants).toEqual(new Set(["a", "b"]));
  });
});
