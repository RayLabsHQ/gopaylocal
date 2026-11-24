// Takes the dashboard screenshots used in the docs and the README, from
// made-up data (demo-data.ts). Only the dashboard's Vite dev server runs: no
// API, no database, no account. Every API request is answered in the browser
// (fake-api.ts).
//
//   pnpm screenshots                  # every shot, into e2e/screenshots/out
//   pnpm screenshots -- --out <dir>   # somewhere else
//   pnpm screenshots -- --only connect
//
// Prints which API requests the demo data didn't cover; a shot that needs one
// should get it added to fake-api.ts.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "@playwright/test";
import * as demo from "./demo-data.ts";
import { API_ORIGIN, useFakeApi, type Scenario } from "./fake-api.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

type Shot = {
  name: string;
  path: string;
  viewport: { width: number; height: number };
  env?: "live" | "test";
  scenario: Scenario;
  /** Runs after the page has loaded; leaves the page as it should be captured. */
  steps?: (page: Page) => Promise<void>;
};

// The dashboard scrolls inside its content area, not the window, so a
// full-page capture can't reach below the fold: tall shots use a tall viewport.
const laptop = { width: 1440, height: 900 };
const phone = { width: 390, height: 844 };
const connected: Scenario = { integrations: [demo.dodo, demo.gumroad] };

async function openStripe(page: Page) {
  await page.getByRole("button", { name: "Connect Stripe" }).click();
  await page.getByRole("dialog", { name: "Connect Stripe" }).waitFor();
}

async function submitKey(page: Page) {
  await openStripe(page);
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Restricted key").fill("rk_live_DEMO");
  await dialog.getByRole("button", { name: "Verify and connect" }).click();
}

const SHOTS: Shot[] = [
  { name: "integrations", path: "/dashboard/integrations", viewport: { width: 1440, height: 1320 }, scenario: connected },
  { name: "integrations-empty", path: "/dashboard/integrations", viewport: { width: 1440, height: 1080 }, scenario: { integrations: [] } },
  {
    name: "integrations-manage-menu",
    path: "/dashboard/integrations",
    viewport: laptop,
    scenario: connected,
    steps: async (page) => {
      await page.getByRole("button", { name: "Manage Dodo Payments" }).click();
    },
  },
  { name: "connect-stripe", path: "/dashboard/integrations", viewport: { width: 1440, height: 800 }, scenario: connected, steps: openStripe },
  { name: "connect-stripe-phone", path: "/dashboard/integrations", viewport: phone, scenario: connected, steps: openStripe },
  {
    name: "connect-stripe-done",
    path: "/dashboard/integrations",
    viewport: { width: 1440, height: 800 },
    scenario: { ...connected, connect: { status: 201, body: demo.stripeConnected("live", "active") } },
    steps: async (page) => {
      await submitKey(page);
      await page.getByText("Stripe is connected").waitFor();
    },
  },
  {
    name: "connect-stripe-tracking-failed",
    path: "/dashboard/integrations",
    viewport: { width: 1440, height: 800 },
    scenario: { ...connected, connect: { status: 201, body: demo.stripeConnected("live", "failed") } },
    steps: async (page) => {
      await submitKey(page);
      await page.getByText("with one problem").waitFor();
    },
  },
  {
    name: "connect-stripe-rejected",
    path: "/dashboard/integrations",
    viewport: { width: 1440, height: 800 },
    scenario: {
      ...connected,
      connect: {
        status: 400,
        body: { code: "key_rejected", error: "The key was rejected: this key doesn't have the permissions the request needs." },
      },
    },
    steps: async (page) => {
      await submitKey(page);
      await page.getByRole("alert").waitFor();
    },
  },
];

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port"))));
    });
  });
}

async function startDashboard(port: number): Promise<ChildProcess> {
  const child = spawn("pnpm", ["exec", "vite", "--port", String(port), "--strictPort", "--host", "127.0.0.1"], {
    cwd: path.join(root, "apps/dashboard"),
    // Only what Vite needs: the dashboard is pointed at the fake API.
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", VITE_API_URL: API_ORIGIN },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`the dashboard dev server exited with ${child.exitCode}`);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return child;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  child.kill();
  throw new Error("the dashboard dev server didn't start within 60 s");
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const outDir = path.resolve(flag("--out") ?? path.join(root, "e2e/screenshots/out"));
  const only = flag("--only");
  const shots = only ? SHOTS.filter((s) => s.name.includes(only)) : SHOTS;
  await mkdir(outDir, { recursive: true });

  const port = await freePort();
  const server = await startDashboard(port);
  // Playwright's own Chromium (`pnpm exec playwright install chromium`), else
  // an installed Google Chrome.
  const browser = await chromium.launch().catch(() => {
    console.log("Playwright's Chromium isn't installed; using Google Chrome");
    return chromium.launch({ channel: "chrome" });
  });
  const unhandled = new Set<string>();
  try {
    for (const shot of shots) {
      const context = await browser.newContext({ viewport: shot.viewport, deviceScaleFactor: 2, colorScheme: "dark" });
      const page = await context.newPage();
      await page.addInitScript((env) => localStorage.setItem("gopaylocal_env", env), shot.env ?? "live");
      await useFakeApi(page, shot.scenario, unhandled);
      await page.goto(`http://127.0.0.1:${port}${shot.path}`);
      await page.getByRole("heading", { level: 1 }).first().waitFor();
      await page.waitForLoadState("networkidle");
      await shot.steps?.(page);
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(250);
      await page.screenshot({ path: path.join(outDir, `${shot.name}.png`) });
      console.log(`saved ${shot.name}.png`);
      await context.close();
    }
  } finally {
    await browser.close();
    server.kill();
  }
  if (unhandled.size > 0) console.log(`not in the demo data:\n  ${[...unhandled].sort().join("\n  ")}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
