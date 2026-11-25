import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { ulid } from "ulid";
import type { AppEnv } from "../bindings";
import { createDb } from "../db";
import { parityGroups, countryParityMappings } from "../db/schema";
import {
  createParityGroupSchema,
  updateParityGroupSchema,
  setCountriesSchema,
} from "@gopaylocal/shared/validation";
import { DEFAULT_PARITY_TIERS } from "@gopaylocal/shared/parity";
import { pushBannerConfigForOrg } from "../services/banner-cache.service";
import { markCountryPricesDue } from "../services/campaign-country-prices.service";
import { requirePermission } from "../middleware/permissions";
import { errorSummary, logBannerPushFailure } from "../lib/log";

const app = new Hono<AppEnv>();

// Parity groups are ORG-WIDE: every campaign in the org prices from them. So
// mutations need parityGroups.manage (owner or admin). A plain member (and in particular a
// product-scoped member, who may only manage campaigns for their granted
// products) could otherwise change the discounts on every product in the org.
// Reading them stays open to all members.

// List all parity groups with their countries
app.get("/v1/teams/:orgId/parity-groups", requirePermission("parityGroups.view"), async (c) => {
  const orgId = c.req.param("orgId");
  const db = createDb(c.env);

  try {
    const groups = await db
      .select()
      .from(parityGroups)
      .where(eq(parityGroups.organizationId, orgId))
      .orderBy(parityGroups.sortOrder);

    // Fetch countries for each group
    const groupsWithCountries = await Promise.all(
      groups.map(async (group) => {
        const mappings = await db
          .select({ countryCode: countryParityMappings.countryCode })
          .from(countryParityMappings)
          .where(eq(countryParityMappings.parityGroupId, group.id));

        return {
          ...group,
          countries: mappings.map((m) => m.countryCode),
        };
      }),
    );

    return c.json({ data: groupsWithCountries });
  } catch (err) {
    console.error("parity-groups: failed to fetch parity groups", { error: errorSummary(err) });
    return c.json({ error: "Failed to fetch parity groups" }, 500);
  }
});

// Create parity group
app.post("/v1/teams/:orgId/parity-groups", requirePermission("parityGroups.manage"), async (c) => {
  const orgId = c.req.param("orgId");
  const db = createDb(c.env);

  try {
    const body = await c.req.json();
    const parsed = createParityGroupSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
    }

    const id = ulid();
    const [group] = await db
      .insert(parityGroups)
      .values({
        id,
        organizationId: orgId,
        name: parsed.data.name,
        discountPercent: parsed.data.discountPercent,
        sortOrder: parsed.data.sortOrder,
        createdAt: new Date(),
      })
      .returning();

    c.executionCtx.waitUntil(
      pushBannerConfigForOrg(db, c.env.CACHE, orgId, c.env).catch(logBannerPushFailure(orgId)),
    );
    // Discounts changed: the country prices Dodo charges are due again.
    c.executionCtx.waitUntil(markCountryPricesDue(db, orgId));

    return c.json({ data: { ...group, countries: [] } }, 201);
  } catch (err) {
    console.error("parity-groups: failed to create parity group", { error: errorSummary(err) });
    return c.json({ error: "Failed to create parity group" }, 500);
  }
});

// Update parity group
app.patch("/v1/teams/:orgId/parity-groups/:id", requirePermission("parityGroups.manage"), async (c) => {
  const orgId = c.req.param("orgId");
  const groupId = c.req.param("id");
  const db = createDb(c.env);

  try {
    const body = await c.req.json();
    const parsed = updateParityGroupSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
    }

    const result = await db
      .update(parityGroups)
      .set(parsed.data)
      .where(and(eq(parityGroups.id, groupId), eq(parityGroups.organizationId, orgId)))
      .returning();

    const group = result[0];
    if (!group) {
      return c.json({ error: "Parity group not found" }, 404);
    }

    c.executionCtx.waitUntil(
      pushBannerConfigForOrg(db, c.env.CACHE, orgId, c.env).catch(logBannerPushFailure(orgId)),
    );
    // Discounts changed: the country prices Dodo charges are due again.
    c.executionCtx.waitUntil(markCountryPricesDue(db, orgId));

    return c.json({ data: group });
  } catch (err) {
    console.error("parity-groups: failed to update parity group", { error: errorSummary(err) });
    return c.json({ error: "Failed to update parity group" }, 500);
  }
});

// Delete parity group
app.delete("/v1/teams/:orgId/parity-groups/:id", requirePermission("parityGroups.manage"), async (c) => {
  const orgId = c.req.param("orgId");
  const groupId = c.req.param("id");
  const db = createDb(c.env);

  try {
    const result = await db
      .delete(parityGroups)
      .where(and(eq(parityGroups.id, groupId), eq(parityGroups.organizationId, orgId)))
      .returning();

    if (result.length === 0) {
      return c.json({ error: "Parity group not found" }, 404);
    }

    c.executionCtx.waitUntil(
      pushBannerConfigForOrg(db, c.env.CACHE, orgId, c.env).catch(logBannerPushFailure(orgId)),
    );
    // Discounts changed: the country prices Dodo charges are due again.
    c.executionCtx.waitUntil(markCountryPricesDue(db, orgId));

    return c.json({ success: true });
  } catch (err) {
    console.error("parity-groups: failed to delete parity group", { error: errorSummary(err) });
    return c.json({ error: "Failed to delete parity group" }, 500);
  }
});

// Set countries for a parity group (replaces all existing)
app.put("/v1/teams/:orgId/parity-groups/:id/countries", requirePermission("parityGroups.manage"), async (c) => {
  const orgId = c.req.param("orgId");
  const groupId = c.req.param("id");
  const db = createDb(c.env);

  try {
    const body = await c.req.json();
    const parsed = setCountriesSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
    }

    // Verify the group belongs to this org
    const group = await db
      .select()
      .from(parityGroups)
      .where(and(eq(parityGroups.id, groupId), eq(parityGroups.organizationId, orgId)))
      .limit(1)
      .then((rows) => rows[0]);

    if (!group) {
      return c.json({ error: "Parity group not found" }, 404);
    }

    // Country codes are matched against request.cf.country (uppercase ISO
    // alpha-2): store them uppercase and once each, or a lowercase entry
    // silently never matches a visitor.
    const countries = [...new Set(parsed.data.countries.map((cc) => cc.toUpperCase()))];

    // Replace the mappings atomically: a failed insert must not leave the
    // group with no countries (every visitor in it would lose the discount).
    // The group was verified as this org's above, and a group never changes
    // org, so mappings are reached by its id.
    await db.transaction(async (tx) => {
      await tx
        .delete(countryParityMappings)
        .where(eq(countryParityMappings.parityGroupId, groupId));
      if (countries.length > 0) {
        await tx.insert(countryParityMappings).values(
          countries.map((countryCode) => ({
            id: ulid(),
            parityGroupId: groupId,
            countryCode,
          })),
        );
      }
    });

    c.executionCtx.waitUntil(
      pushBannerConfigForOrg(db, c.env.CACHE, orgId, c.env).catch(logBannerPushFailure(orgId)),
    );
    // Discounts changed: the country prices Dodo charges are due again.
    c.executionCtx.waitUntil(markCountryPricesDue(db, orgId));

    return c.json({ data: { ...group, countries } });
  } catch (err) {
    console.error("parity-groups: failed to set countries", { error: errorSummary(err) });
    return c.json({ error: "Failed to set countries" }, 500);
  }
});

// Seed default parity tiers from shared package
app.post("/v1/teams/:orgId/parity-groups/seed-defaults", requirePermission("parityGroups.manage"), async (c) => {
  const orgId = c.req.param("orgId");
  const db = createDb(c.env);

  try {
    // Check if the org already has parity groups
    const existing = await db
      .select()
      .from(parityGroups)
      .where(eq(parityGroups.organizationId, orgId))
      .limit(1);

    if (existing.length > 0) {
      return c.json({ error: "Organization already has parity groups. Delete them first to re-seed." }, 409);
    }

    // All tiers or none: a half-seeded org would be stuck, since the check
    // above refuses to re-seed once any group exists.
    const createdGroups = await db.transaction(async (tx) => {
      const created = [];
      for (const tier of DEFAULT_PARITY_TIERS) {
        const groupId = ulid();
        const now = new Date();

        const [group] = await tx
          .insert(parityGroups)
          .values({
            id: groupId,
            organizationId: orgId,
            name: tier.name,
            discountPercent: tier.discountPercent,
            sortOrder: tier.sortOrder,
            createdAt: now,
          })
          .returning();

        // Insert country mappings
        if (tier.countries.length > 0) {
          await tx.insert(countryParityMappings).values(
            tier.countries.map((countryCode) => ({
              id: ulid(),
              parityGroupId: groupId,
              countryCode,
            })),
          );
        }

        created.push({ ...group, countries: tier.countries });
      }
      return created;
    });

    c.executionCtx.waitUntil(
      pushBannerConfigForOrg(db, c.env.CACHE, orgId, c.env).catch(logBannerPushFailure(orgId)),
    );
    // Discounts changed: the country prices Dodo charges are due again.
    c.executionCtx.waitUntil(markCountryPricesDue(db, orgId));

    return c.json({ data: createdGroups }, 201);
  } catch (err) {
    console.error("parity-groups: failed to seed default parity groups", { error: errorSummary(err) });
    return c.json({ error: "Failed to seed default parity groups" }, 500);
  }
});

export default app;
