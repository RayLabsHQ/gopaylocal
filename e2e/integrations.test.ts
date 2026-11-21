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
    const card = page.getByRole("heading", { name: "Dodo Payments", exact: true }).locator("..");
    await card.getByRole("button", { name: "Connect", exact: true }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Connect Dodo Payments")).toBeVisible();
    await expect(dialog.getByText(/saved for\s+test\s+mode/)).toBeVisible();
    await dialog.getByLabel("API Key").fill(DODO_TEST_API_KEY!);
    await dialog.getByRole("button", { name: "Connect", exact: true }).click();

    await expect(dialog).toBeHidden({ timeout: 15_000 });
    await expect(page.getByText("Dodo Payments connected")).toBeVisible();
    await expect(card.getByRole("button", { name: "Connected", exact: true })).toBeVisible();
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

    await card.getByRole("button", { name: "Test", exact: true }).click();
    await expect(page.getByText("Dodo Payments verified")).toBeVisible({ timeout: 15_000 });
  });
});
