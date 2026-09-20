import { expect, test } from "@playwright/test";

test("simulator returns a decision and never hands back a grant", async ({ page }) => {
  await page.goto("/simulator");
  await expect(page.getByRole("heading", { name: "Try a decision without making one." })).toBeVisible();

  // The action the user asked for.
  await page.getByRole("button", { name: "Simulate" }).click();
  const decision = page.locator(".pill").first();
  await expect(decision).toBeVisible({ timeout: 15_000 });
  await expect(decision).toHaveText(/ALLOW|REVIEW|BLOCK/);
  await expect(page.getByText("Simulation only.")).toBeVisible();

  // A different transaction than the one named should not come back the same way.
  await page.getByRole("button", { name: "A different transaction" }).click();
  await page.getByRole("button", { name: "Simulate" }).click();
  await expect(page.locator(".pill").first()).toBeVisible({ timeout: 15_000 });

  // Whatever the outcome, the page must never receive a permit.
  const body = await page.content();
  expect(body).not.toContain("grantId");
  expect(body).not.toMatch(/"token"/);
});
