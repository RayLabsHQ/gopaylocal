import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { createSqlRecorder, type SqlRecorder } from "./sql-recorder-test-helpers";
import {
  API_KEY_SCOPE,
  allowedCampaignIdsFor,
  allowedProductIdsFor,
  canAccessProduct,
  getAllowedCampaignIds,
  getAllowedProductIds,
  getMemberProductScope,
  scopeOf,
  setMemberProductScope,
} from "./product-access";

// Explicit member product access: all products, or a listed set where an
// empty set means none. No database: the recorder builds the real Drizzle SQL
// and answers with canned rows.

const ORG = "org_a";

describe("a secret API key's scope (scopeOf, allowedProductIdsFor, allowedCampaignIdsFor)", () => {
  /** Runs `fn` inside a request whose context holds a key, or a member. */
  async function inRequest<T>(
    who: { apiKey: true } | { userId: string; role: string },
    fn: (c: Parameters<typeof scopeOf>[0]) => Promise<T> | T,
  ): Promise<T> {
    let out: T | undefined;
    const app = new Hono<AppEnv>();
    app.get("/", async (c) => {
      if ("apiKey" in who) {
        c.set("apiKey", {
          id: "key_1",
          name: "CI",
          keyPrefix: "gpl_sk_01234567...",
          createdAt: new Date(0),
          organizationId: ORG,
          organizationName: "Org",
        });
      } else {
        c.set("user", { id: who.userId });
        c.set("memberRole", who.role);
      }
      out = await fn(c);
      return c.text("ok");
    });
    await app.request("/");
    return out as T;
  }

  it("a key has every product and campaign, without a query and without a user", async () => {
    const r: SqlRecorder = createSqlRecorder();
    expect(await inRequest({ apiKey: true }, (c) => scopeOf(c))).toEqual({ userId: "", role: API_KEY_SCOPE });
    expect(await inRequest({ apiKey: true }, (c) => allowedProductIdsFor(c, r.db, ORG))).toBeNull();
    expect(await inRequest({ apiKey: true }, (c) => allowedCampaignIdsFor(c, r.db, ORG))).toBeNull();
    expect(r.queries).toEqual([]);
  });

  it("a member is resolved exactly as before (their user id and role)", async () => {
    expect(await inRequest({ userId: "u1", role: "member" }, (c) => scopeOf(c))).toEqual({ userId: "u1", role: "member" });
    const r = createSqlRecorder([[{ memberId: "m1", allProducts: false, productId: "p1" }]]);
    const allowed = await inRequest({ userId: "u1", role: "member" }, (c) => allowedProductIdsFor(c, r.db, ORG));
    expect(allowed).toEqual(new Set(["p1"]));
    expect(r.queries[0]!.params).toContain("u1");
  });

  it("the key scope is not a workspace role name", () => {
    expect(["owner", "admin", "member"]).not.toContain(API_KEY_SCOPE);
  });
});

describe("getAllowedProductIds", () => {
  it("owners and admins see every product without a query", async () => {
    for (const role of ["owner", "admin", "admin,member"]) {
      const r = createSqlRecorder();
      expect(await getAllowedProductIds(r.db, ORG, "u1", role)).toBeNull();
      expect(r.queries).toEqual([]);
    }
  });

  it("an unknown or missing role gets nothing, without a query", async () => {
    for (const role of ["billing", undefined, ""]) {
      const r = createSqlRecorder();
      expect(await getAllowedProductIds(r.db, ORG, "u1", role)).toEqual(new Set());
      expect(r.queries).toEqual([]);
    }
  });

  it("reads membership, scope and grants in one org-scoped query keyed by member id", async () => {
    const r = createSqlRecorder([[{ memberId: "m1", allProducts: null, productId: null }]]);
    await getAllowedProductIds(r.db, ORG, "u1", "member");
    expect(r.queries).toHaveLength(1);
    expect(r.queries[0]!.sql).toBe(
      'select "member"."id", "member_product_scopes"."all_products", "member_product_access"."product_id" from "member" ' +
        'left join "member_product_scopes" on "member_product_scopes"."member_id" = "member"."id" ' +
        'left join "member_product_access" on ("member_product_access"."member_id" = "member"."id" and "member_product_access"."organization_id" = $1) ' +
        'where ("member"."organizationId" = $2 and "member"."userId" = $3)',
    );
    expect(r.queries[0]!.params).toEqual([ORG, ORG, "u1"]);
  });

  it("a member with no scope row has the default: all products", async () => {
    const r = createSqlRecorder([[{ memberId: "m1", allProducts: null, productId: null }]]);
    expect(await getAllowedProductIds(r.db, ORG, "u1", "member")).toBeNull();
  });

  it("a member scoped to all products sees all, whatever stale grants exist", async () => {
    const r = createSqlRecorder([[{ memberId: "m1", allProducts: true, productId: null }]]);
    expect(await getAllowedProductIds(r.db, ORG, "u1", "member")).toBeNull();
  });

  it("a member with a listed scope sees exactly the listed products", async () => {
    const r = createSqlRecorder([
      [
        { memberId: "m1", allProducts: false, productId: "p1" },
        { memberId: "m1", allProducts: false, productId: "p2" },
      ],
    ]);
    expect(await getAllowedProductIds(r.db, ORG, "u1", "member")).toEqual(new Set(["p1", "p2"]));
  });

  it("an EMPTY listed scope means no products, never all", async () => {
    const r = createSqlRecorder([[{ memberId: "m1", allProducts: false, productId: null }]]);
    const allowed = await getAllowedProductIds(r.db, ORG, "u1", "member");
    expect(allowed).toEqual(new Set());
    expect(canAccessProduct(allowed, "p1")).toBe(false);
  });

  it("no membership row means nothing", async () => {
    const r = createSqlRecorder([[]]);
    expect(await getAllowedProductIds(r.db, ORG, "u1", "member")).toEqual(new Set());
  });

  it("ignores rows of a second membership row for the same person", async () => {
    const r = createSqlRecorder([
      [
        { memberId: "m1", allProducts: false, productId: "p1" },
        { memberId: "m2", allProducts: true, productId: "p9" },
      ],
    ]);
    expect(await getAllowedProductIds(r.db, ORG, "u1", "member")).toEqual(new Set(["p1"]));
  });
});

describe("getAllowedCampaignIds", () => {
  it("an empty scope resolves to no campaigns without a campaign query", async () => {
    const r = createSqlRecorder([[{ memberId: "m1", allProducts: false, productId: null }]]);
    expect(await getAllowedCampaignIds(r.db, ORG, "u1", "member")).toEqual(new Set());
    expect(r.queries).toHaveLength(1);
  });
});

describe("getMemberProductScope", () => {
  it("no scope row is all products", async () => {
    const r = createSqlRecorder([[]]);
    expect(await getMemberProductScope(r.db, ORG, "m1")).toEqual({ allProducts: true });
  });

  it("a listed scope returns its grants, or an empty list", async () => {
    let r = createSqlRecorder([[{ allProducts: false, productId: "p1" }, { allProducts: false, productId: "p2" }]]);
    expect(await getMemberProductScope(r.db, ORG, "m1")).toEqual({ allProducts: false, productIds: ["p1", "p2"] });
    r = createSqlRecorder([[{ allProducts: false, productId: null }]]);
    expect(await getMemberProductScope(r.db, ORG, "m1")).toEqual({ allProducts: false, productIds: [] });
  });
});

describe("setMemberProductScope", () => {
  const ids = () => {
    let n = 0;
    return () => `g${++n}`;
  };

  it("upserts the scope row, clears the person's grants and writes the listed ones with member_id", async () => {
    const r = createSqlRecorder();
    await setMemberProductScope(r.db, {
      orgId: ORG,
      memberId: "m1",
      userId: "u1",
      scope: { allProducts: false, productIds: ["p1", "p2"] },
      newId: ids(),
    });
    expect(r.queries.map((q) => q.sql.split(" ").slice(0, 3).join(" "))).toEqual([
      'insert into "member_product_scopes"',
      'delete from "member_product_access"',
      'insert into "member_product_access"',
    ]);
    expect(r.queries[0]!.sql).toContain('on conflict ("member_id") do update set "all_products" = $');
    expect(r.queries[0]!.params.slice(0, 3)).toEqual(["m1", ORG, false]);
    expect(r.queries[1]!.params).toEqual([ORG, "u1"]);
    expect(r.queries[2]!.params).toEqual(expect.arrayContaining(["g1", "g2", "m1", "p1", "p2", "u1", ORG]));
  });

  it("an empty listed scope writes the scope row and no grants", async () => {
    const r = createSqlRecorder();
    await setMemberProductScope(r.db, { orgId: ORG, memberId: "m1", userId: "u1", scope: { allProducts: false, productIds: [] }, newId: ids() });
    expect(r.queries).toHaveLength(2);
    expect(r.queries[0]!.params.slice(0, 3)).toEqual(["m1", ORG, false]);
  });

  it("all products writes all_products=true and drops the grants", async () => {
    const r = createSqlRecorder();
    await setMemberProductScope(r.db, { orgId: ORG, memberId: "m1", userId: "u1", scope: { allProducts: true }, newId: ids() });
    expect(r.queries).toHaveLength(2);
    expect(r.queries[0]!.params.slice(0, 3)).toEqual(["m1", ORG, true]);
    expect(r.queries[1]!.sql).toMatch(/^delete from "member_product_access"/);
  });
});
