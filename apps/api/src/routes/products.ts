import { Hono } from "hono";
import { eq, and, inArray, or, notExists, sql } from "drizzle-orm";
import { ulid } from "ulid";
import type { AppEnv } from "../bindings";
import { createDb } from "../db";
import { campaigns, products } from "../db/schema";
import { errorSummary, logBannerPushFailure, pgErrorCode } from "../lib/log";
import {
  basePriceProblem,
  createProductSchema,
  updateProductSchema,
} from "@gopaylocal/shared/validation";
import { getProductLimitInfo } from "../lib/limits";
import { allowedProductIdsFor } from "../lib/product-access";
import { requirePermission } from "../middleware/permissions";
import { pushBannerConfigForOrg } from "../services/banner-cache.service";

// Products. Owners and admins manage the catalog (create, delete); members
// view and edit the products in their product access (lib/product-access.ts).

const app = new Hono<AppEnv>();

// List products for organization
app.get("/v1/teams/:orgId/products", requirePermission("products.view"), async (c) => {
  const orgId = c.req.param("orgId");
  const db = createDb(c.env);

  try {
    const env = c.req.query("environment") as "live" | "test" | undefined;
    const conditions = [eq(products.organizationId, orgId)];
    if (env) conditions.push(eq(products.environment, env));

    // Members see their product access (null = all; an empty set lists nothing).
    const allowed = await allowedProductIdsFor(c, db, orgId);
    if (allowed) conditions.push(inArray(products.id, Array.from(allowed)));

    const result = await db
      .select()
      .from(products)
      .where(and(...conditions));

    return c.json({ data: result });
  } catch (err) {
    console.error("products: failed to fetch products", { error: errorSummary(err) });
    return c.json({ error: "Failed to fetch products" }, 500);
  }
});

// Create product (owner and admin: a member adding products would widen their
// own product access, which only the owner sets).
app.post("/v1/teams/:orgId/products", requirePermission("products.create"), async (c) => {
  const orgId = c.req.param("orgId");
  const db = createDb(c.env);

  try {
    const body = await c.req.json();
    const parsed = createProductSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
    }

    const limitInfo = await getProductLimitInfo(db, orgId, c.env);
    if (limitInfo.remaining <= 0) {
      return c.json({
        error: "Product limit reached",
        plan: limitInfo.plan,
        maxProducts: limitInfo.maxProducts,
        currentCount: limitInfo.currentCount,
      }, 403);
    }

    const id = ulid();
    const now = new Date();

    const [product] = await db
      .insert(products)
      .values({
        id,
        organizationId: orgId,
        name: parsed.data.name,
        url: parsed.data.url,
        currency: parsed.data.currency,
        basePrice: parsed.data.basePrice,
        environment: parsed.data.environment ?? "live",
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    return c.json({ data: product }, 201);
  } catch (err) {
    console.error("products: failed to create product", { error: errorSummary(err) });
    return c.json({ error: "Failed to create product" }, 500);
  }
});

// Get single product
app.get("/v1/teams/:orgId/products/:id", requirePermission("products.view"), async (c) => {
  const orgId = c.req.param("orgId");
  const productId = c.req.param("id");
  const db = createDb(c.env);

  try {
    const allowed = await allowedProductIdsFor(c, db, orgId);
    if (allowed && !allowed.has(productId)) {
      return c.json({ error: "Product not found" }, 404);
    }

    const result = await db
      .select()
      .from(products)
      .where(and(eq(products.id, productId), eq(products.organizationId, orgId)))
      .limit(1);

    const product = result[0];
    if (!product) {
      return c.json({ error: "Product not found" }, 404);
    }

    return c.json({ data: product });
  } catch (err) {
    console.error("products: failed to fetch product", { error: errorSummary(err) });
    return c.json({ error: "Failed to fetch product" }, 500);
  }
});

// Update product
app.patch("/v1/teams/:orgId/products/:id", requirePermission("products.update"), async (c) => {
  const orgId = c.req.param("orgId");
  const productId = c.req.param("id");
  const db = createDb(c.env);

  try {
    const body = await c.req.json();
    const parsed = updateProductSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
    }

    const allowed = await allowedProductIdsFor(c, db, orgId);
    if (allowed && !allowed.has(productId)) {
      return c.json({ error: "Product not found" }, 404);
    }

    // The price must stay a valid amount in the product's currency. A patch with
    // both is checked by the schema; one with only one of them is checked here
    // against the stored other.
    const { basePrice: newPrice, currency: newCurrency } = parsed.data;
    if ((newPrice === undefined) !== (newCurrency === undefined)) {
      const [current] = await db
        .select({ basePrice: products.basePrice, currency: products.currency })
        .from(products)
        .where(and(eq(products.id, productId), eq(products.organizationId, orgId)))
        .limit(1);
      if (!current) return c.json({ error: "Product not found" }, 404);
      const problem = basePriceProblem(newPrice ?? current.basePrice, newCurrency ?? current.currency);
      if (problem) {
        return c.json({ error: "Validation failed", details: { formErrors: [], fieldErrors: { basePrice: [problem] } } }, 400);
      }
    }

    // Changing the environment would strand the product's campaigns (and their
    // coupons and A/B tests) in the old one, so it is allowed only while the
    // product has no campaigns. Checked in the same statement as the write, so
    // no separate read can go stale; setting the current environment again is fine.
    const newEnvironment = parsed.data.environment;
    const target = and(eq(products.id, productId), eq(products.organizationId, orgId));
    const result = await db
      .update(products)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(
        newEnvironment === undefined
          ? target
          : and(
              target,
              or(
                eq(products.environment, newEnvironment),
                notExists(db.select({ one: sql`1` }).from(campaigns).where(eq(campaigns.productId, products.id))),
              ),
            ),
      )
      .returning();

    const product = result[0];
    if (!product) {
      if (newEnvironment !== undefined) {
        const [exists] = await db.select({ id: products.id }).from(products).where(target).limit(1);
        if (exists) {
          return c.json(
            {
              error: "Move or delete this product's campaigns before changing its environment.",
              code: "product_has_campaigns",
            },
            409,
          );
        }
      }
      return c.json({ error: "Product not found" }, 404);
    }

    // The banner document carries each campaign's product price and currency
    // (local prices): rebuild it like every other change that affects the banner.
    c.executionCtx.waitUntil(
      pushBannerConfigForOrg(db, c.env.CACHE, orgId, c.env).catch(logBannerPushFailure(orgId)),
    );

    return c.json({ data: product });
  } catch (err) {
    console.error("products: failed to update product", { error: errorSummary(err) });
    return c.json({ error: "Failed to update product" }, 500);
  }
});

// Delete product (owner and admin). Members' grants for it cascade away; a
// member whose listed products shrink to none sees none, never all (product
// access is explicit, lib/product-access.ts).
app.delete("/v1/teams/:orgId/products/:id", requirePermission("products.delete"), async (c) => {
  const orgId = c.req.param("orgId");
  const productId = c.req.param("id");
  const db = createDb(c.env);

  try {
    const result = await db
      .delete(products)
      .where(and(eq(products.id, productId), eq(products.organizationId, orgId)))
      .returning({ id: products.id });
    if (result.length === 0) {
      return c.json({ error: "Product not found" }, 404);
    }

    c.executionCtx.waitUntil(
      pushBannerConfigForOrg(db, c.env.CACHE, orgId, c.env).catch(logBannerPushFailure(orgId)),
    );

    return c.json({ success: true });
  } catch (err) {
    // campaigns.product_id has no ON DELETE CASCADE: a product that still has
    // campaigns cannot be deleted. Say so instead of a bare 500. (Ended A/B
    // tests on it cascade away with the product.)
    if (pgErrorCode(err) === "23503") {
      return c.json(
        { error: "Delete this product's campaigns before deleting it.", code: "product_in_use" },
        409,
      );
    }
    console.error("products: delete failed", { orgId, productId, error: errorSummary(err) });
    return c.json({ error: "Failed to delete product" }, 500);
  }
});

export default app;
