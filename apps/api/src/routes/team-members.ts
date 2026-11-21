import { Hono } from "hono";
import { eq, and, desc, inArray } from "drizzle-orm";
import { ulid } from "ulid";
import type { AppEnv } from "../bindings";
import { createDb } from "../db";
import {
  members,
  users,
  invitations,
  memberProductAccess,
  memberProductScopes,
  products,
  organizations,
  sessions,
  subscriptions,
  apiKeys,
  integrations,
  campaigns,
  experiments,
  coupons,
  parityGroups,
  analyticsRollups,
  apiUsageDaily,
  organizationLimitOverrides,
} from "../db/schema";
import { resolveRole } from "@gopaylocal/shared/permissions";
import { requirePermission } from "../middleware/permissions";
import { removeApiKeyFromKV } from "../services/banner-cache.service";
import { removeIntegrationWebhooks } from "../services/integration-webhooks.service";
import { errorSummary, pgErrorCode } from "../lib/log";
import { getMemberProductScope, setMemberProductScope, type ProductScope } from "../lib/product-access";
import { checkBillingAllowsWorkspaceDelete } from "../lib/workspace-billing";

const app = new Hono<AppEnv>();

app.get("/v1/teams/:orgId/members", requirePermission("team.view"), async (c) => {
  const orgId = c.req.param("orgId");
  const db = createDb(c.env);

  try {
    const rows = await db
      .select({
        id: members.id,
        role: members.role,
        userId: members.userId,
        name: users.name,
        email: users.email,
        image: users.image,
        createdAt: members.createdAt,
      })
      .from(members)
      .innerJoin(users, eq(users.id, members.userId))
      .where(eq(members.organizationId, orgId));

    return c.json({ data: rows });
  } catch (err) {
    console.error("team: failed to fetch team members", { error: errorSummary(err) });
    return c.json({ error: "Failed to fetch team members" }, 500);
  }
});

// Invitation ids are invitation links, so only roles that can invite see
// them (Better Auth 1.7 applies the same rule to its own list endpoint).
app.get("/v1/teams/:orgId/invitations", requirePermission("team.viewInvitations"), async (c) => {
  const orgId = c.req.param("orgId");
  const db = createDb(c.env);

  try {
    const rows = await db
      .select({
        id: invitations.id,
        email: invitations.email,
        role: invitations.role,
        status: invitations.status,
        inviterId: invitations.inviterId,
        expiresAt: invitations.expiresAt,
        createdAt: invitations.createdAt,
      })
      .from(invitations)
      .where(eq(invitations.organizationId, orgId))
      .orderBy(desc(invitations.createdAt));

    return c.json({ data: rows });
  } catch (err) {
    console.error("team: failed to fetch invitations", { error: errorSummary(err) });
    return c.json({ error: "Failed to fetch invitations" }, 500);
  }
});

// ── Member product access ───────────────────────────────────────────────────
// A member's scope is explicit: all products, or a listed set where an empty
// list means no products (lib/product-access.ts). Owners and admins always
// work on every product, so only role=member can be scoped.

/** The target's membership in this org, or null. */
async function findMembership(db: ReturnType<typeof createDb>, orgId: string, userId: string) {
  const [row] = await db
    .select({ id: members.id, role: members.role })
    .from(members)
    .where(and(eq(members.organizationId, orgId), eq(members.userId, userId)))
    .limit(1);
  return row ?? null;
}

/**
 * Body of PUT .../product-access: `{ "allProducts": true }`, or
 * `{ "productIds": [...] }` (optionally with `"allProducts": false`), where an
 * empty list means no products.
 */
export function parseProductScopeBody(body: unknown): ProductScope | { error: string } {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Body must be { allProducts: true } or { productIds: [...] }" };
  }
  const { allProducts, productIds } = body as { allProducts?: unknown; productIds?: unknown };
  if (allProducts !== undefined && typeof allProducts !== "boolean") {
    return { error: "allProducts must be true or false" };
  }
  if (allProducts === true) {
    if (productIds !== undefined && !(Array.isArray(productIds) && productIds.length === 0)) {
      return { error: "Send productIds only when allProducts is false" };
    }
    return { allProducts: true };
  }
  if (!Array.isArray(productIds) || productIds.some((p) => typeof p !== "string" || p.length === 0)) {
    return { error: "productIds must be an array of product ids (an empty array means no products)" };
  }
  return { allProducts: false, productIds: [...new Set(productIds as string[])] };
}

// Read a member's product access.
app.get(
  "/v1/teams/:orgId/members/:userId/product-access",
  requirePermission("team.viewProductAccess"),
  async (c) => {
    const orgId = c.req.param("orgId");
    const userId = c.req.param("userId");
    const db = createDb(c.env);

    try {
      const target = await findMembership(db, orgId, userId);
      if (!target) return c.json({ error: "Not a member of this organization" }, 404);
      // Owners and admins are never scoped; report what applies to them.
      const scope: ProductScope =
        resolveRole(target.role) === "member"
          ? await getMemberProductScope(db, orgId, target.id)
          : { allProducts: true };
      return c.json({ data: { allProducts: scope.allProducts, productIds: scope.allProducts ? [] : scope.productIds } });
    } catch (err) {
      console.error("team: failed to fetch product access", { error: errorSummary(err) });
      return c.json({ error: "Failed to fetch product access" }, 500);
    }
  },
);

// Replace a member's product access.
app.put(
  "/v1/teams/:orgId/members/:userId/product-access",
  requirePermission("team.manageProductAccess"),
  async (c) => {
    const orgId = c.req.param("orgId");
    const userId = c.req.param("userId");
    const db = createDb(c.env);

    try {
      const parsed = parseProductScopeBody(await c.req.json().catch(() => null));
      if ("error" in parsed) return c.json({ error: parsed.error }, 400);

      const target = await findMembership(db, orgId, userId);
      if (!target) return c.json({ error: "Not a member of this organization" }, 404);

      // Rejected rather than stored: a scope on an owner or admin does nothing
      // and would surprise everyone if they were later made a member.
      if (resolveRole(target.role) !== "member") {
        return c.json(
          { error: "Owners and admins have full access and cannot be product-scoped" },
          400,
        );
      }

      // Every product id must belong to this org (no cross-tenant grants).
      if (!parsed.allProducts && parsed.productIds.length > 0) {
        const owned = await db
          .select({ id: products.id })
          .from(products)
          .where(and(eq(products.organizationId, orgId), inArray(products.id, parsed.productIds)));
        const ownedSet = new Set(owned.map((r) => r.id));
        const unknown = parsed.productIds.filter((p) => !ownedSet.has(p));
        if (unknown.length > 0) {
          return c.json({ error: "Unknown productId(s) for this organization", unknown }, 400);
        }
      }

      await db.transaction((tx) =>
        setMemberProductScope(tx, { orgId, memberId: target.id, userId, scope: parsed, newId: ulid }),
      );

      return c.json({
        data: { allProducts: parsed.allProducts, productIds: parsed.allProducts ? [] : parsed.productIds },
      });
    } catch (err) {
      // The member (or a product) was deleted between the checks and the write.
      if (pgErrorCode(err) === "23503") {
        return c.json({ error: "That member or product no longer exists" }, 409);
      }
      console.error("team: failed to update product access", { error: errorSummary(err) });
      return c.json({ error: "Failed to update product access" }, 500);
    }
  },
);

/**
 * DELETE /v1/teams/:orgId — permanently delete a workspace (workspace.delete: owner only).
 *
 * No organizationId column carries a foreign key to the organization table, so
 * the cascade must be explicit. Order matters: coupons reference campaigns,
 * and campaigns reference products, without ON DELETE CASCADE. Experiments
 * (which would cascade with their product), banner_configs (→campaigns) and
 * country_parity_mappings (→parity_groups) cascade on their own; experiments
 * are still deleted by org explicitly, and member scopes and grants cascade
 * from member too.
 *
 * Refused (409/502, nothing deleted) while a Dodo subscription would keep
 * charging the deleted workspace (lib/workspace-billing.ts). Provider webhooks
 * (live and test) and KV cache entries are torn down best-effort off the
 * response path, after the database delete committed; provider-side coupon
 * codes are intentionally left untouched.
 */
app.delete("/v1/teams/:orgId", requirePermission("workspace.delete"), async (c) => {
  const orgId = c.req.param("orgId");
  const db = createDb(c.env);

  try {
    const [subscription] = await db
      .select({ status: subscriptions.status, dodoSubId: subscriptions.dodoSubId })
      .from(subscriptions)
      .where(eq(subscriptions.organizationId, orgId))
      .limit(1);
    const billing = await checkBillingAllowsWorkspaceDelete(c.env, subscription ?? null, orgId);
    if (!billing.ok) return c.json(billing.body, billing.status);

    const orgApiKeys = await db
      .select({ id: apiKeys.id, keyHash: apiKeys.keyHash })
      .from(apiKeys)
      .where(eq(apiKeys.organizationId, orgId));

    const orgIntegrations = await db
      .select({
        id: integrations.id,
        provider: integrations.provider,
        providerAccountId: integrations.providerAccountId,
        testProviderAccountId: integrations.testProviderAccountId,
        liveAccessTokenEnc: integrations.liveAccessTokenEnc,
        testAccessTokenEnc: integrations.testAccessTokenEnc,
        webhookEndpointId: integrations.webhookEndpointId,
        webhookSecretEnc: integrations.webhookSecretEnc,
        testWebhookEndpointId: integrations.testWebhookEndpointId,
        testWebhookSecretEnc: integrations.testWebhookSecretEnc,
      })
      .from(integrations)
      .where(eq(integrations.organizationId, orgId));

    const campaignIds = (
      await db
        .select({ id: campaigns.id })
        .from(campaigns)
        .where(eq(campaigns.organizationId, orgId))
    ).map((r) => r.id);
    const integrationIds = orgIntegrations.map((r) => r.id);

    await db.transaction(async (tx) => {
      await tx.delete(analyticsRollups).where(eq(analyticsRollups.organizationId, orgId));
      await tx.delete(apiUsageDaily).where(eq(apiUsageDaily.organizationId, orgId));
      if (campaignIds.length) {
        await tx.delete(coupons).where(inArray(coupons.campaignId, campaignIds));
      }
      if (integrationIds.length) {
        await tx.delete(coupons).where(inArray(coupons.integrationId, integrationIds));
      }
      await tx.delete(memberProductAccess).where(eq(memberProductAccess.organizationId, orgId));
      await tx.delete(memberProductScopes).where(eq(memberProductScopes.organizationId, orgId));
      await tx.delete(experiments).where(eq(experiments.organizationId, orgId));
      await tx.delete(campaigns).where(eq(campaigns.organizationId, orgId));
      await tx.delete(products).where(eq(products.organizationId, orgId));
      await tx.delete(parityGroups).where(eq(parityGroups.organizationId, orgId));
      await tx.delete(apiKeys).where(eq(apiKeys.organizationId, orgId));
      await tx.delete(integrations).where(eq(integrations.organizationId, orgId));
      await tx.delete(organizationLimitOverrides).where(eq(organizationLimitOverrides.organizationId, orgId));
      await tx.delete(subscriptions).where(eq(subscriptions.organizationId, orgId));
      await tx.delete(invitations).where(eq(invitations.organizationId, orgId));
      await tx.delete(members).where(eq(members.organizationId, orgId));
      await tx
        .update(sessions)
        .set({ activeOrganizationId: null })
        .where(eq(sessions.activeOrganizationId, orgId));
      await tx.delete(organizations).where(eq(organizations.id, orgId));
    });

    c.executionCtx.waitUntil(
      (async () => {
        // The KV key mapping has no TTL and the banner/events fast paths trust
        // it without the DB: if this delete fails, the deleted workspace's
        // public key keeps resolving. Keep going, but log every failure.
        const logKv = (action: string, apiKeyId: string) => (err: unknown) => {
          console.error(`team: workspace delete left KV ${action}`, {
            orgId,
            apiKeyId,
            error: errorSummary(err),
          });
        };
        for (const key of orgApiKeys) {
          await removeApiKeyFromKV(c.env.CACHE, key.keyHash).catch(logKv("key mapping", key.id));
          await c.env.CACHE.delete(`banner-config:${key.id}`).catch(logKv("banner config", key.id));
        }
        // Each environment's endpoint with that environment's credentials.
        // Never throws; every failure is logged there. An orphaned endpoint
        // 404s on delivery and the provider disables it on its own.
        for (const integ of orgIntegrations) {
          await removeIntegrationWebhooks(c.env, integ);
        }
      })(),
    );

    return c.json({ success: true });
  } catch (err) {
    console.error("team: failed to delete workspace", { error: errorSummary(err) });
    return c.json({ error: "Failed to delete workspace" }, 500);
  }
});

export default app;
