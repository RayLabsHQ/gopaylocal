import { describe, it, expect, beforeEach, vi } from "vitest";
import { createMockKV, createTestBindings } from "../test/helpers";
import { bannerDocForCampaign } from "./banner-doc-test-helpers";
import { resetVpnDatasetCache } from "./vpn-detect.service";
import { VPN_DATASET_KEY, encodeDataset } from "./vpn-dataset";
import { createCountingKV, datasetFrom } from "./vpn-test-helpers";

// End-to-end through the real banner route (KV fast path, no DB): proves the route passes
// request.cf.asn and cf-connecting-ip to the detector, and that VPN detection failures
// never break the banner response.

vi.mock("../../../../packages/banner/dist/banner.js", () => ({ default: "" }));
const { default: bannerScriptRoute } = await import("../routes/banner-script");

const PUBLIC_KEY = "gpl_pk_test_vpn_route";
const ORG_ID = "org_vpn_route";
const API_KEY_ID = "key_vpn_route";

async function sha256Hex(value: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function envWith(vpnData: KVNamespace) {
  const cache = createMockKV();
  await cache.put(`apikey:${await sha256Hex(PUBLIC_KEY)}`, JSON.stringify({ apiKeyId: API_KEY_ID, organizationId: ORG_ID }));
  const config = bannerDocForCampaign({ organizationId: ORG_ID });
  await cache.put(`banner-config:${API_KEY_ID}`, JSON.stringify(config));
  return createTestBindings({ CACHE: cache, VPN_DATA: vpnData });
}

async function requestBanner(env: ReturnType<typeof createTestBindings>, ip: string, asn?: number) {
  const req = new Request(`https://api.test/v1/banner/config/${PUBLIC_KEY}`, { headers: { "cf-connecting-ip": ip } });
  Object.defineProperty(req, "cf", { value: { country: "IN", asOrganization: "Example ISP", asn } });
  const res = await bannerScriptRoute.fetch(req, env);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function seededVpnKv() {
  const { kv, state } = createCountingKV();
  state.store.set(VPN_DATASET_KEY, encodeDataset(datasetFrom({ "vpn/4": ["203.0.113.0/24"], "vpn/6": ["2001:db8:aa::/48"] })));
  return { kv, state };
}

beforeEach(() => {
  resetVpnDatasetCache();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("banner route VPN gate", () => {
  it("a residential visitor not in any list gets the discount", async () => {
    const { kv } = seededVpnKv();
    const { body } = await requestBanner(await envWith(kv), "198.51.100.20", 55836);
    expect(body).toMatchObject({ show: true, discount: 40 });
  });

  it("a cloud ASN is refused with reason vpn_detected", async () => {
    const { kv } = seededVpnKv();
    const { body } = await requestBanner(await envWith(kv), "198.51.100.20", 16509);
    expect(body).toEqual({ show: false, reason: "vpn_detected" });
  });

  it("an IPv4 or IPv6 address in the dataset is refused", async () => {
    const { kv } = seededVpnKv();
    const env = await envWith(kv);
    expect((await requestBanner(env, "203.0.113.7", 55836)).body).toEqual({ show: false, reason: "vpn_detected" });
    expect((await requestBanner(env, "2001:db8:aa:5::1", 55836)).body).toEqual({ show: false, reason: "vpn_detected" });
  });

  it("an iCloud Private Relay egress ASN is not refused by the ASN check", async () => {
    const { kv } = seededVpnKv();
    const { body } = await requestBanner(await envWith(kv), "172.225.1.1", 36183);
    expect(body).toMatchObject({ show: true });
  });

  it("a failing VPN_DATA namespace still returns the banner (fails open, 200)", async () => {
    const { kv, state } = seededVpnKv();
    state.getImpl = () => Promise.reject(new Error("KV unavailable"));
    const { status, body } = await requestBanner(await envWith(kv), "203.0.113.7", 55836);
    expect(status).toBe(200);
    expect(body).toMatchObject({ show: true });
  });
});
