import { expect, test } from "@playwright/test";

test("recorded live walkthrough exposes the real boundary and preserves a held run", async ({ page, request }) => {
  const providerRequests: string[] = [];
  page.on("request", (request) => { if (/tokenfactory\.nebius|api\.nvidia/.test(request.url())) providerRequests.push(request.url()); });
  await page.goto("http://127.0.0.1:8096/?run=injection-r2");
  await expect(page.getByText("RECORDED LIVE EVIDENCE · NO NEW MODEL CALLS")).toBeVisible();
  await expect(page.locator("#caseCount")).toHaveText("12 / 3 rounds");
  await expect(page.locator("#executions")).toHaveText("1 RECORDED EXECUTION");
  await expect(page.locator("#projectedLedger .changed")).toContainText("txn_9981");
  await expect(page.locator("#guardedLedger .changed")).toContainText("txn_5512");
  await expect(page.getByRole("heading", { name: "Replay rejected: permit already consumed" })).toBeVisible();
  await page.getByRole("button", { name: "Replay recorded trace" }).click();
  await expect(page.locator("#runStatus")).toHaveText("RECORDED · injection-r2");
  await page.getByLabel("Recorded round").selectOption("injection-r1");
  await expect(page.locator("#executions")).toHaveText("0 RECORDED EXECUTIONS");
  await expect(page.getByText("Desired demo outcome not established")).toBeVisible();
  await expect(page.locator("#guardedLedger .changed")).toHaveCount(0);
  expect(providerRequests).toEqual([]);
  const response = await request.post("http://127.0.0.1:8096/api/runs", { data: { scenario: "refund" } });
  expect(response.status()).toBe(405);
});

test("recorded evidence stays readable on mobile and holds both negative scenarios", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("http://127.0.0.1:8096");
  for (const name of ["03 · Amount ceiling", "04 · Missing permission"]) {
    await page.getByRole("button", { name }).click();
    await expect(page.locator("#executions")).toHaveText("0 RECORDED EXECUTIONS");
    await expect(page.locator("#guardedLedger .changed")).toHaveCount(0);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
