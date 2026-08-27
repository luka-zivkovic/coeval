import { expect, test, type Page } from "@playwright/test";

const routes = [
  "/",
  "/traces",
  "/exceptions",
  "/reliability",
  "/human-truth",
  "/analyze",
  "/skill",
  "/skill/versions",
  "/criteria",
  "/golden",
  "/datasets",
  "/integrations",
  "/settings",
  "/review-queues",
  "/governed-review/tasks"
];

async function goAndSettle(page: Page, path: string) {
  await page.goto(path);
  await page.waitForLoadState("networkidle");
}

test.describe("responsive and contrast foundations", () => {
  for (const viewport of [
    { width: 360, height: 640 },
    { width: 430, height: 932 },
    { width: 768, height: 1024 },
    { width: 1024, height: 768 },
    { width: 1440, height: 900 }
  ]) {
    test(`main flows avoid document overflow at ${viewport.width}x${viewport.height}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      for (const route of routes) {
        await goAndSettle(page, route);
        const dimensions = await page.evaluate(() => ({
          clientWidth: document.scrollingElement?.clientWidth ?? 0,
          scrollWidth: document.scrollingElement?.scrollWidth ?? 0
        }));
        expect(dimensions.scrollWidth, `${route} at ${viewport.width}px`).toBeLessThanOrEqual(dimensions.clientWidth + 1);
      }
    });
  }

  for (const viewport of [
    { width: 360, height: 640 },
    { width: 1440, height: 900 }
  ]) {
    test(`dark theme main flows avoid document overflow at ${viewport.width}x${viewport.height}`, async ({ page }) => {
      await page.addInitScript(() => window.localStorage.setItem("theme", "dark"));
      await page.setViewportSize(viewport);
      for (const route of routes) {
        await goAndSettle(page, route);
        await expect(page.locator("html")).toHaveClass(/dark/);
        const dimensions = await page.evaluate(() => ({
          clientWidth: document.scrollingElement?.clientWidth ?? 0,
          scrollWidth: document.scrollingElement?.scrollWidth ?? 0
        }));
        expect(dimensions.scrollWidth, `${route} dark at ${viewport.width}px`).toBeLessThanOrEqual(dimensions.clientWidth + 1);
      }
    });
  }

  test("tablet navigation opens, closes on Escape, and restores focus", async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await goAndSettle(page, "/");

    const trigger = page.getByRole("button", { name: "Open workspace navigation" });
    await expect(trigger).toBeVisible();
    await trigger.click();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    const sidebar = page.getByRole("complementary", { name: "Workspace sidebar" });
    await expect(sidebar).toBeVisible();
    await expect(sidebar).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(sidebar.getByRole("button").first()).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect(trigger).toBeFocused();
  });

  test("desktop navigation stays persistent", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await goAndSettle(page, "/");
    await expect(page.getByRole("complementary", { name: "Workspace sidebar" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Open workspace navigation" })).toBeHidden();
  });

  test("a short mobile viewport can scroll a fixture-independent dialog to its primary action", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 640 });
    await goAndSettle(page, "/");
    await page.getByRole("button", { name: "Open workspace navigation" }).click();
    const sidebar = page.getByRole("complementary", { name: "Workspace sidebar" });
    await sidebar.getByRole("button", { name: /Switch project/ }).click();
    await sidebar.getByRole("button", { name: /New project/ }).click();

    const dialog = page.getByRole("dialog", { name: "Start another evaluation" });
    const panel = dialog.locator(":scope > div").first();
    const box = await panel.boundingBox();
    expect(box?.width ?? 999).toBeLessThanOrEqual(328);
    expect(box?.height ?? 999).toBeLessThanOrEqual(608);
    await dialog.getByRole("button", { name: "Create" }).scrollIntoViewIfNeeded();
    await expect(dialog.getByRole("button", { name: "Create" })).toBeVisible();
  });
});
