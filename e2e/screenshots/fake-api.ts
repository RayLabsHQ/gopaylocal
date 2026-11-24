import type { Page, Route } from "@playwright/test";
import * as demo from "./demo-data.ts";

/**
 * Answers the dashboard's API requests inside the browser, from demo-data.ts.
 * The dashboard is pointed at API_ORIGIN, a `.invalid` host that cannot
 * resolve, so a request this file doesn't handle fails instead of reaching a
 * real server. Every other outside request is blocked too, except the
 * dashboard's Google Fonts.
 */
export const API_ORIGIN = "http://api.demo.invalid";

export type Scenario = {
  integrations: Array<Record<string, unknown>>;
  /** What POST /integrations answers. */
  connect?: { status: number; body: unknown };
};

export async function useFakeApi(page: Page, scenario: Scenario, unhandled: Set<string>) {
  // Connecting adds the new integration to later lists, as the API would.
  const state = { integrations: [...scenario.integrations] };

  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === API_ORIGIN) return answer(route, url, state, scenario, unhandled);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    const fonts = url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com";
    return local || fonts ? route.continue() : route.abort("blockedbyclient");
  });
}

async function answer(
  route: Route,
  url: URL,
  state: { integrations: Array<Record<string, unknown>> },
  scenario: Scenario,
  unhandled: Set<string>,
) {
  const request = route.request();
  const origin = request.headers()["origin"] ?? "*";
  const cors = {
    "access-control-allow-origin": origin,
    "access-control-allow-credentials": "true",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
  };
  const json = (body: unknown, status = 200) =>
    route.fulfill({ status, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify(body) });

  if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });

  const team = `/v1/teams/${demo.ORG_ID}`;
  const path = url.pathname;
  const method = request.method();

  if (path === "/api/auth/get-session") return json(demo.session);
  if (path === "/api/auth/organization/list") return json(demo.organizations);
  if (path === "/api/auth/organization/set-active") return json(demo.organizations[0]);
  if (path === `${team}/members`) return json({ data: demo.members });
  if (path === `${team}/billing/usage`) return json({ data: demo.usage });
  if (path === `${team}/campaigns` && method === "GET") return json({ data: demo.campaigns });
  if (path === `${team}/products` && method === "GET") return json({ data: demo.products });
  if (path === `${team}/integrations` && method === "GET") return json({ data: state.integrations });
  if (path === `${team}/integrations` && method === "POST" && scenario.connect) {
    const { status, body } = scenario.connect;
    if (status < 300) {
      const { webhookSetup: _, ...row } = body as Record<string, unknown>;
      state.integrations = [...state.integrations.filter((i) => i.provider !== row.provider), row];
    }
    return json(status < 300 ? { data: body } : body, status);
  }

  unhandled.add(`${method} ${path}`);
  return json(method === "GET" ? { data: [] } : { error: "Not part of the demo" }, method === "GET" ? 200 : 501);
}
