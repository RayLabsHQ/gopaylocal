/**
 * Banner selection: which campaign (or running A/B experiment) answers a
 * banner config request for a product. Pure functions only, so the KV cache
 * builder (banner-cache.service.ts) and the database fallback in
 * routes/banner-script.ts run the SAME rule on the same inputs and cannot
 * disagree.
 *
 * Rule (documented in apps/docs api/banner.mdx):
 *  - A campaign is servable when its status is "active" and it has a banner
 *    config row.
 *  - For one product, the "live" environment is considered before "test".
 *    Within an environment a running experiment wins over plain campaigns;
 *    otherwise the newest servable campaign (created_at desc, then id desc).
 *  - An experiment arm is servable under the campaign rule and must belong to
 *    the experiment's product and environment. Both arms servable: the
 *    experiment applies. One arm: that arm's campaign is served to everyone as
 *    a plain campaign. Neither: the experiment is ignored.
 *  - No `product` in the request: the default product is the product of the
 *    newest servable campaign in the organization, live campaigns first.
 */

export type BannerEnvironment = "live" | "test";

/** What answers requests for one product. */
export type ProductServing =
  | { kind: "campaign"; campaignId: string }
  | {
      kind: "experiment";
      experimentId: string;
      campaignAId: string;
      campaignBId: string;
      /** Percent of visitors sent to arm B (1-99). */
      trafficSplitB: number;
    };

export interface SelectableCampaign {
  id: string;
  productId: string;
  environment: string;
  status: string;
  createdAt: Date;
  /** Whether a banner_configs row exists for the campaign. */
  hasBanner: boolean;
}

export interface SelectableExperiment {
  id: string;
  productId: string;
  environment: string;
  status: string;
  campaignAId: string;
  campaignBId: string;
  trafficSplitB: number;
  startedAt: Date;
}

export interface SelectionInput {
  campaigns: SelectableCampaign[];
  experiments: SelectableExperiment[];
}

/** Environments in the order they are considered. */
const ENVIRONMENT_ORDER: readonly BannerEnvironment[] = ["live", "test"];

function environmentOf(value: string): BannerEnvironment {
  return value === "test" ? "test" : "live";
}

export function isServableCampaign(c: SelectableCampaign): boolean {
  return c.status === "active" && c.hasBanner;
}

/** Newest first: created_at desc, then id desc (ids are ULIDs). Deterministic. */
function newerFirst(a: { at: Date; id: string }, b: { at: Date; id: string }): number {
  const diff = b.at.getTime() - a.at.getTime();
  if (diff !== 0) return diff;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

function newestCampaign(list: SelectableCampaign[]): SelectableCampaign | undefined {
  return [...list].sort((a, b) =>
    newerFirst({ at: a.createdAt, id: a.id }, { at: b.createdAt, id: b.id }),
  )[0];
}

/** Clamp a stored split to 1-99 so a bad row can never send everyone to one arm. */
function clampSplit(split: number): number {
  const n = Math.round(Number(split));
  if (!Number.isFinite(n)) return 50;
  return Math.min(99, Math.max(1, n));
}

/**
 * What serves `productId`, or null when nothing is servable for it.
 */
export function selectProductServing(
  input: SelectionInput,
  productId: string,
): ProductServing | null {
  const byId = new Map(input.campaigns.map((c) => [c.id, c]));

  for (const env of ENVIRONMENT_ORDER) {
    const armOk = (campaignId: string) => {
      const c = byId.get(campaignId);
      return !!c && isServableCampaign(c) && c.productId === productId && environmentOf(c.environment) === env;
    };

    const running = input.experiments
      .filter(
        (e) =>
          e.status === "running" && e.productId === productId && environmentOf(e.environment) === env,
      )
      .sort((a, b) => newerFirst({ at: a.startedAt, id: a.id }, { at: b.startedAt, id: b.id }));

    for (const exp of running) {
      const aOk = armOk(exp.campaignAId);
      const bOk = armOk(exp.campaignBId);
      if (aOk && bOk) {
        return {
          kind: "experiment",
          experimentId: exp.id,
          campaignAId: exp.campaignAId,
          campaignBId: exp.campaignBId,
          trafficSplitB: clampSplit(exp.trafficSplitB),
        };
      }
      if (aOk) return { kind: "campaign", campaignId: exp.campaignAId };
      if (bOk) return { kind: "campaign", campaignId: exp.campaignBId };
      // Neither arm servable: this experiment does not apply.
    }

    const newest = newestCampaign(
      input.campaigns.filter(
        (c) => isServableCampaign(c) && c.productId === productId && environmentOf(c.environment) === env,
      ),
    );
    if (newest) return { kind: "campaign", campaignId: newest.id };
  }
  return null;
}

/**
 * The product a request without `product` is answered for: the product of the
 * newest servable campaign in the organization, live campaigns first.
 */
export function selectDefaultProductId(input: SelectionInput): string | null {
  for (const env of ENVIRONMENT_ORDER) {
    const newest = newestCampaign(
      input.campaigns.filter((c) => isServableCampaign(c) && environmentOf(c.environment) === env),
    );
    if (newest) return newest.productId;
  }
  return null;
}

/** Selection for a request: `productId` from the request, or null when absent. */
export function selectServing(
  input: SelectionInput,
  productId: string | null,
): ProductServing | null {
  const target = productId ?? selectDefaultProductId(input);
  return target ? selectProductServing(input, target) : null;
}

/** Every product with something servable, plus the default product. */
export function selectAllServings(input: SelectionInput): {
  products: Record<string, ProductServing>;
  defaultProductId: string | null;
} {
  const productIds = new Set<string>([
    ...input.campaigns.map((c) => c.productId),
    ...input.experiments.map((e) => e.productId),
  ]);
  const products: Record<string, ProductServing> = {};
  for (const id of [...productIds].sort()) {
    const serving = selectProductServing(input, id);
    if (serving) products[id] = serving;
  }
  return { products, defaultProductId: selectDefaultProductId(input) };
}

// ── Request parameters ──────────────────────────────────────────────────────

const VISITOR_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const PRODUCT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** C2 `vid`: 16-64 chars of [A-Za-z0-9_-]; anything else is ignored. */
export function parseVisitorId(raw: string | undefined | null): string | null {
  return raw && VISITOR_ID_RE.test(raw) ? raw : null;
}

/**
 * C2 `product`. Returns:
 *  - null when absent or empty (default-product rule applies);
 *  - the id when it has a plausible shape;
 *  - "" (matches no product) for anything else, so a malformed id gets the
 *    normal "no banner" answer instead of the default product's campaign.
 */
export function parseProductParam(raw: string | undefined | null): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  return PRODUCT_ID_RE.test(raw) ? raw : "";
}

/**
 * The key that keeps a visitor in one arm: the client's visitor id when valid,
 * else IP + user agent. Only ever hashed, never stored.
 */
export function visitorKey(vid: string | null, ip: string, userAgent: string): string {
  return vid ? `v:${vid}` : `ipua:${ip}\n${userAgent}`;
}

/**
 * Sticky arm assignment: SHA-256(experimentId + "\n" + visitorKey), first four
 * bytes as a big-endian uint32, bucket = value % 100; bucket < trafficSplitB
 * is arm B. (2^32 % 100 = 96, so the modulo bias is about 2e-8: negligible.)
 */
export async function assignVariant(
  experimentId: string,
  key: string,
  trafficSplitB: number,
): Promise<"a" | "b"> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${experimentId}\n${key}`),
  );
  const bucket = new DataView(digest).getUint32(0, false) % 100;
  return bucket < clampSplit(trafficSplitB) ? "b" : "a";
}
