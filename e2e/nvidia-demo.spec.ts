import { expect, test } from "@playwright/test";

test("refund lab explains a seeded attack, safe correction, execution and replay", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("http://127.0.0.1:8095");
  await expect(page.getByText("OFFLINE · SCRIPTED FIXTURES")).toBeVisible();
  await page.getByRole("button", { name: "Run offline scenario" }).click();
  await expect(page.locator("#state")).toHaveText("COMPLETE");
  await expect(page.locator("#executions")).toHaveText("1 EXECUTION");
  await expect(page.getByRole("heading", { name: "BLOCK: ActionGate decision" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "ALLOW: ActionGate decision" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Replay rejected: permit already consumed" })).toBeVisible();
  const refunded = page.locator(".payment.refunded");
  await expect(refunded).toHaveCount(1);
  await expect(refunded).toContainText("txn_5512");
  expect(await page.locator("#feed").innerText()).not.toContain('"token"');
  expect(errors).toEqual([]);
});

test("policy and missing intent holds leave the sandbox unchanged on mobile", async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("http://127.0.0.1:8095");
  for (const name of ["03 · Above the limit", "04 · Missing permission"]) {
    await page.getByRole("button", { name }).click();
    await page.getByRole("button", { name: "Run offline scenario" }).click();
    await expect(page.locator("#state")).toHaveText("COMPLETE");
    await expect(page.locator("#executions")).toHaveText("0 EXECUTIONS");
    await expect(page.locator(".payment.refunded")).toHaveCount(0);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const extra = await request.post("http://127.0.0.1:8095/api/runs", { data: { scenario: "refund", tenantId: "attacker" } });
  expect(extra.status()).toBe(400);
  const crossOrigin = await request.post("http://127.0.0.1:8095/api/runs", { data: { scenario: "refund" }, headers: { origin: "https://attacker.example" } });
  expect(crossOrigin.status()).toBe(403);
});
