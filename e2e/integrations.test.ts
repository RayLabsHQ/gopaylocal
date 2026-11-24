import { test, expect } from "./fixtures";

/**
 * Connects Dodo Payments with a real Dodo TEST-MODE API key. This talks to
 * Dodo's test API over the network, so it only runs when DODO_TEST_API_KEY is
 * exported in your shell (a test-mode key from your own Dodo dashboard; never
 * a live key, and never copied out of apps/api/.dev.vars). Otherwise skipped.
 *
 * Each test gets a fresh account and organization (see fixtures.ts), so
 * nothing is connected at the start.
 */
const DODO_TEST_API_KEY = process.env.DODO_TEST_API_KEY;

test.describe("Integrations — Dodo Payments (test mode)", () => {
  test.skip(!DODO_TEST_API_KEY, "set DODO_TEST_API_KEY (a Dodo test-mode key) to run");

  test.beforeEach(async ({ page }) => {
    // The dashboard's Live/Test switch persists in localStorage; start in Test
    // so the key is stored as test-mode credentials.
    await page.addInitScript(() => localStorage.setItem("gopaylocal_env", "test"));
  });

  async function connectDodo(page: import("@playwright/test").Page) {
    await page.getByRole("button", { name: "Connect Dodo Payments" }).click();

    const panel = page.getByRole("dialog", { name: "Connect Dodo Payments" });
    await expect(panel.getByText(/Saved for test campaigns/)).toBeVisible();
    await panel.getByLabel("API key").fill(DODO_TEST_API_KEY!);
    await panel.getByRole("button", { name: "Verify and connect" }).click();

    // The API checks the key with Dodo before saving it.
    await expect(panel.getByText("Key accepted")).toBeVisible({ timeout: 20_000 });
    await panel.getByRole("button", { name: "Done" }).click();
    await expect(panel).toBeHidden();

    const card = page.getByRole("article", { name: "Dodo Payments" });
    await expect(card.getByRole("button", { name: "Test connection" })).toBeVisible();
    return card;
  }

  test("connect with a test API key", async ({ page, teamId }) => {
    expect(teamId).toBeTruthy();
    await page.goto("/dashboard/integrations");
    await connectDodo(page);
  });

  test("test the connection after connecting", async ({ page, teamId }) => {
    expect(teamId).toBeTruthy();
    await page.goto("/dashboard/integrations");
    const card = await connectDodo(page);

    await card.getByRole("button", { name: "Test connection" }).click();
    await expect(page.getByText("Dodo Payments test key works")).toBeVisible({ timeout: 15_000 });
  });
});
