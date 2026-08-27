import { expect, test, type Page } from "@playwright/test";

async function goAndSettle(page: Page, path: string) {
  await page.goto(path);
  await page.waitForLoadState("networkidle");
}

test.describe("keyboard accessibility foundations", () => {
  test("the skip link moves focus to the main application content", async ({ page }) => {
    await goAndSettle(page, "/");

    await page.keyboard.press("Tab");
    const skipLink = page.getByRole("link", { name: "Skip to main content" });
    await expect(skipLink).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#main-content")).toBeFocused();
  });

  test("a modal traps focus, closes with Escape, and restores its trigger", async ({ page }) => {
    await goAndSettle(page, "/traces");

    const trigger = page.getByRole("button", { name: "Save view as queue" });
    test.skip((await trigger.count()) === 0, "save-as-queue is unavailable in this project mode");
    test.skip(await trigger.isDisabled(), "no trace rows are available in this environment");
    await trigger.click();

    const dialog = page.getByRole("dialog", { name: "Save view as queue" });
    await expect(dialog).toBeVisible();
    await expect(page.getByLabel("Queue name")).toBeFocused();

    const create = dialog.getByRole("button", { name: /Create queue/ });
    await create.focus();
    await page.keyboard.press("Tab");
    await expect(dialog.getByRole("button", { name: "Close save queue dialog" })).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
  });
});
