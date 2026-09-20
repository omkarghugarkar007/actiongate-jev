import { expect, test } from "@playwright/test";

test("dashboard renders the evidence loop and the audit trail", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Agent actions, under control." })).toBeVisible();
  await expect(page.getByText("Provider spend")).toBeVisible();

  // The evidence loop is what earns a second visit: blocking is invisible when
  // nothing goes wrong, so the refusal list is the part an operator acts on.
  await expect(page.getByRole("heading", { name: "Why actions were refused" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Refusal rate by risk class" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Recent decisions" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Try a decision →" })).toHaveAttribute("href", "/simulator");
});

test("dashboard degrades honestly with no decisions rather than showing nothing", async ({ page }) => {
  await page.goto("/");
  // Either real rows, or an explanation of how to create some. Never a blank panel.
  const rows = page.locator(".row:not(.headings)");
  const empty = page.locator(".empty").first();
  await expect(async () => {
    const hasRows = (await rows.count()) > 0;
    const hasGuidance = (await empty.count()) > 0 && /refused|decisions/i.test((await empty.textContent()) ?? "");
    expect(hasRows || hasGuidance).toBe(true);
  }).toPass({ timeout: 20_000 });
});
