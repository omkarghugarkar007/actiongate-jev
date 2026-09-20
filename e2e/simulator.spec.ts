import { expect, test } from "@playwright/test";

test("simulator decides and never hands back a grant", async ({ page }) => {
  await page.goto("/simulator");
  await expect(page.getByRole("heading", { name: "Try a decision." })).toBeVisible();

  const simulate = async (preset?: string) => {
    if (preset) await page.getByRole("button", { name: preset }).click();
    await page.getByRole("button", { name: "Simulate" }).click();
    await expect(page.locator(".verdict .pill")).toBeVisible({ timeout: 30_000 });
    return (await page.locator(".verdict .pill").textContent())?.trim();
  };

  // The action the user asked for.
  expect(await simulate()).toMatch(/ALLOW|REVIEW|BLOCK/);
  await expect(page.getByText("no grant issued")).toBeVisible();
  await expect(page.locator(".reasons .row:not(.headings)").first()).toBeVisible();

  // A transaction the user never named.
  expect(await simulate("A different transaction")).toMatch(/ALLOW|REVIEW|BLOCK/);

  // Whatever the outcome, the page must never receive a permit.
  const body = await page.content();
  expect(body).not.toContain("grantId");
  expect(body).not.toMatch(/"token"/);
});
