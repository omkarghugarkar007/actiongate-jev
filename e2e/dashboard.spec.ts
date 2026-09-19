import { expect, test } from "@playwright/test";
test("dashboard renders authorization and provider-cost overview", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Agent actions, under control." })).toBeVisible();
  await expect(page.getByText("Provider spend")).toBeVisible();
  await expect(page.getByText("Recent decisions")).toBeVisible();
});
