import { test as setup, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";

const STATE_PATH = "e2e/.auth/state.json";

// Signs in through the real login form (itself one of the fix-claims: login
// must work with no env workarounds) and saves the session for the specs.
setup("sign in", async ({ page }) => {
  const email = process.env.SIM_EMAIL;
  const password = process.env.SIM_PASSWORD;
  if (!email || !password) throw new Error("Set SIM_EMAIL and SIM_PASSWORD to run the fix-claims suite");

  await page.goto("/");
  // Either an existing session (sidebar visible) or the login form.
  const loginForm = page.getByText("Log in to Coeval");
  const sidebar = page.getByText("Workspace", { exact: true });
  await expect(loginForm.or(sidebar).first()).toBeVisible({ timeout: 10_000 });

  if (await loginForm.isVisible()) {
    await page.getByPlaceholder("email@example.com").fill(email);
    await page.getByPlaceholder("Password").fill(password);
    await page.getByRole("button", { name: "Log in" }).click();
  }
  await expect(page.getByText(email)).toBeVisible({ timeout: 10_000 });

  mkdirSync("e2e/.auth", { recursive: true });
  await page.context().storageState({ path: STATE_PATH });
});
