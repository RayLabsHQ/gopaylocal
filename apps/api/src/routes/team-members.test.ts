import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTestBindings, createTestClient, mountRoutes } from "../test/helpers";
import { createSqlRecorder, type SqlRecorder } from "../lib/sql-recorder-test-helpers";

// Team routes under the permission table: who may see invitations and product
// access, the explicit product-access body, and workspace delete. No database:
// createDb() returns a recorder with canned rows. No provider or Dodo calls:
// webhook removal is mocked at the service, Dodo at fetch.

const state = vi.hoisted(() => ({ recorder: null as unknown as SqlRecorder }));
vi.mock("../db", () => ({ createDb: () => state.recorder.db }));
const webhookRemovals = vi.hoisted(
  () => [] as Array<{ integration: unknown; transactionsAtCall: string[] }>,
);
vi.mock("../services/integration-webhooks.service", () => ({
  removeIntegrationWebhooks: async (_env: unknown, integration: unknown) => {
    webhookRemovals.push({ integration, transactionsAtCall: [...state.recorder.transactions] });
    return { removed: ["live", "test"], failed: [] };
  },
}));

const { default: teamRoute, parseProductScopeBody } = await import("./team-members");

const ORG = "org_a";
const access = (userId = "u_member") => `/v1/teams/${ORG}/members/${userId}/product-access`;
const clientAs = (role: "owner" | "admin" | "member") => createTestClient(mountRoutes(teamRoute, { userId: `u_${role}`, role }));

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  webhookRemovals.length = 0;
});
afterEach(() => vi.restoreAllMocks());

describe("parseProductScopeBody", () => {
  it.each([
    [{ allProducts: true }, { allProducts: true }],
    [{ allProducts: true, productIds: [] }, { allProducts: true }],
    [{ productIds: ["p1", "p2", "p1"] }, { allProducts: false, productIds: ["p1", "p2"] }],
    [{ allProducts: false, productIds: [] }, { allProducts: false, productIds: [] }],
    [{ productIds: [] }, { allProducts: false, productIds: [] }],
  ])("%j -> %j", (body, scope) => {
    expect(parseProductScopeBody(body)).toEqual(scope);
  });

  it.each([
    null,
    [],
    "all",
    {},
    { allProducts: "yes" },
    { allProducts: true, productIds: ["p1"] },
    { productIds: "p1" },
    { productIds: [1] },
    { productIds: [""] },
  ])("refuses %j", (body) => {
    expect(parseProductScopeBody(body)).toHaveProperty("error");
  });
});

describe("who may see what", () => {
  it("only the owner sees invitations (their ids are invitation links)", async () => {
    for (const role of ["admin", "member"] as const) {
      state.recorder = createSqlRecorder();
      const res = await clientAs(role).request(`/v1/teams/${ORG}/invitations`);
      expect({ role, status: res.status }).toEqual({ role, status: 403 });
      expect(state.recorder.queries).toEqual([]);
    }
    state.recorder = createSqlRecorder([[]]);
    expect((await clientAs("owner").request(`/v1/teams/${ORG}/invitations`)).status).toBe(200);
  });

  it("everyone sees the member list", async () => {
    for (const role of ["owner", "admin", "member"] as const) {
      state.recorder = createSqlRecorder([[]]);
      expect((await clientAs(role).request(`/v1/teams/${ORG}/members`)).status).toBe(200);
    }
  });

  it("a member cannot read anyone's product access; an admin can", async () => {
    state.recorder = createSqlRecorder();
    expect((await clientAs("member").request(access())).status).toBe(403);

    state.recorder = createSqlRecorder([[{ id: "m1", role: "member" }], [{ allProducts: false, productId: "p1" }]]);
    const res = await clientAs("admin").request(access());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { allProducts: false, productIds: ["p1"] } });
  });

  it("only the owner changes product access", async () => {
    for (const role of ["admin", "member"] as const) {
      state.recorder = createSqlRecorder();
      const res = await clientAs(role).request(access(), { method: "PUT", json: { allProducts: true } });
      expect({ role, status: res.status }).toEqual({ role, status: 403 });
      expect(state.recorder.queries).toEqual([]);
    }
  });

  it("only the owner deletes the workspace", async () => {
    for (const role of ["admin", "member"] as const) {
      state.recorder = createSqlRecorder();
      const res = await clientAs(role).request(`/v1/teams/${ORG}`, { method: "DELETE" });
      expect({ role, status: res.status }).toEqual({ role, status: 403 });
      expect(state.recorder.queries).toEqual([]);
    }
  });
});

describe("PUT .../product-access (owner)", () => {
  it("answers 404 for someone who is not a member of this org", async () => {
    state.recorder = createSqlRecorder([[]]);
    const res = await clientAs("owner").request(access("u_outsider"), { method: "PUT", json: { productIds: [] } });
    expect(res.status).toBe(404);
  });

  it("refuses to scope an owner or admin", async () => {
    state.recorder = createSqlRecorder([[{ id: "m_admin", role: "admin" }]]);
    const res = await clientAs("owner").request(access("u_admin"), { method: "PUT", json: { productIds: [] } });
    expect(res.status).toBe(400);
    expect(state.recorder.queries.some((q) => q.sql.startsWith("insert"))).toBe(false);
  });

  it("refuses product ids from another org", async () => {
    state.recorder = createSqlRecorder([[{ id: "m1", role: "member" }], [{ id: "p_mine" }]]);
    const res = await clientAs("owner").request(access(), { method: "PUT", json: { productIds: ["p_mine", "p_theirs"] } });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ unknown: ["p_theirs"] });
  });

  it("stores an empty list as 'no products' (it used to mean all)", async () => {
    state.recorder = createSqlRecorder([[{ id: "m1", role: "member" }]]);
    const res = await clientAs("owner").request(access(), { method: "PUT", json: { productIds: [] } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { allProducts: false, productIds: [] } });
    expect(state.recorder.transactions).toEqual(["commit"]);
    const upsert = state.recorder.queries.find((q) => q.sql.startsWith('insert into "member_product_scopes"'));
    expect(upsert!.params.slice(0, 3)).toEqual(["m1", ORG, false]);
  });

  it("stores all products explicitly", async () => {
    state.recorder = createSqlRecorder([[{ id: "m1", role: "member" }]]);
    const res = await clientAs("owner").request(access(), { method: "PUT", json: { allProducts: true } });
    expect(await res.json()).toEqual({ data: { allProducts: true, productIds: [] } });
  });

  it("answers 409 when the member is removed between the check and the write (FK 23503)", async () => {
    const fk = Object.assign(new Error("Failed query"), {
      query: 'insert into "member_product_scopes" ...',
      params: [],
      cause: Object.assign(new Error("violates foreign key constraint"), { code: "23503" }),
    });
    state.recorder = createSqlRecorder([[{ id: "m1", role: "member" }], fk]);
    const res = await clientAs("owner").request(access(), { method: "PUT", json: { allProducts: true } });
    expect(res.status).toBe(409);
  });
});

describe("DELETE /v1/teams/:orgId (owner)", () => {
  const SUBSCRIPTION_SQL =
    'select "status", "dodo_sub_id" from "subscriptions" where "subscriptions"."organization_id" = $1 limit $2';
  const INTEGRATION = {
    id: "int_1",
    provider: "stripe",
    providerAccountId: null,
    testProviderAccountId: null,
    liveAccessTokenEnc: "enc_live",
    testAccessTokenEnc: "enc_test",
    webhookEndpointId: "we_live",
    webhookSecretEnc: "sec_live",
    testWebhookEndpointId: "we_test",
    testWebhookSecretEnc: "sec_test",
  };
  const deleteWorkspace = (bindings = createTestBindings()) =>
    createTestClient(mountRoutes(teamRoute, { userId: "u_owner", role: "owner" }), bindings).request(`/v1/teams/${ORG}`, {
      method: "DELETE",
    });
  const dodoSays = (body: unknown, status = 200) =>
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(body), { status }));

  it("removes every integration's provider webhooks, both environments, after the delete commits", async () => {
    const second = { ...INTEGRATION, id: "int_2", provider: "paddle" };
    // subscription, api keys, integrations, campaigns; the transaction's statements get [].
    state.recorder = createSqlRecorder([[], [], [INTEGRATION, second], []]);

    const res = await deleteWorkspace();

    expect(res.status).toBe(200);
    expect(state.recorder.transactions).toEqual(["commit"]);
    expect(webhookRemovals.map((r) => r.integration)).toEqual([INTEGRATION, second]);
    expect(webhookRemovals.every((r) => r.transactionsAtCall.includes("commit"))).toBe(true);
    // The integrations read carries both environments' webhook and credential columns.
    const read = state.recorder.queries.find((q) => q.sql.includes('from "integrations"'))!;
    for (const column of ["test_webhook_endpoint_id", "test_access_token_enc", "test_provider_account_id", "webhook_endpoint_id"]) {
      expect(read.sql).toContain(`"${column}"`);
    }
  });

  it("leaves provider webhooks alone when the database delete fails", async () => {
    state.recorder = createSqlRecorder([[], [], [INTEGRATION], [], new Error("connection lost")]);

    const res = await deleteWorkspace();

    expect(res.status).toBe(500);
    expect(state.recorder.transactions).toEqual(["rollback"]);
    expect(webhookRemovals).toEqual([]);
  });

  it("refuses (409) while the Dodo subscription is set to renew, and deletes nothing", async () => {
    state.recorder = createSqlRecorder([[{ status: "active", dodoSubId: "sub_1" }]]);
    const fetchSpy = dodoSays({ status: "active", cancel_at_next_billing_date: false, next_billing_date: "2026-12-19T00:00:00Z" });

    const res = await deleteWorkspace();

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("subscription_renews");
    expect(body.error).toContain("Manage Billing");
    expect(fetchSpy.mock.calls[0]![0]).toBe("https://live.dodopayments.com/subscriptions/sub_1");
    expect(state.recorder.queries).toEqual([{ sql: SUBSCRIPTION_SQL, params: [ORG, 1] }]);
    expect(state.recorder.transactions).toEqual([]);
    expect(webhookRemovals).toEqual([]);
  });

  it("refuses (502) when Dodo cannot confirm the subscription won't renew, and deletes nothing", async () => {
    state.recorder = createSqlRecorder([[{ status: "active", dodoSubId: "sub_1" }]]);
    dodoSays({ message: "internal error" }, 500);

    const res = await deleteWorkspace();

    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe("billing_check_failed");
    expect(state.recorder.transactions).toEqual([]);
  });

  it("goes ahead once the subscription is set to end at the period end, and deletes its row", async () => {
    state.recorder = createSqlRecorder([[{ status: "active", dodoSubId: "sub_1" }], [], [], []]);
    dodoSays({ status: "active", cancel_at_next_billing_date: true });

    const res = await deleteWorkspace();

    expect(res.status).toBe(200);
    expect(state.recorder.transactions).toEqual(["commit"]);
    expect(state.recorder.queries.some((q) => q.sql.startsWith('delete from "subscriptions"'))).toBe(true);
  });

  it("self-hosted: no billing, so it deletes without asking Dodo", async () => {
    state.recorder = createSqlRecorder([[{ status: "active", dodoSubId: "sub_1" }], [], [], []]);
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const res = await deleteWorkspace(createTestBindings({ SELF_HOSTED: "true" }));

    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(state.recorder.transactions).toEqual(["commit"]);
  });
});
