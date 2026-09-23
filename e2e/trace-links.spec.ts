import { test, expect } from "@playwright/test";

// Read-only checks for the inbound Ironside deep link (/links/trace). They
// need no seeded data: an unsupported source and a trace id that can never be
// imported exercise the two non-redirect outcomes.

test.describe("trace deep links", () => {
  test("an unsupported source shows the friendly invalid-link page", async ({ page }) => {
    await page.goto("/links/trace?source=datadog&project=p&trace=t");
    await expect(page.getByText("Rubrist can't open this link.")).toBeVisible();
    await expect(page.getByText("400 · unsupported link source")).toBeVisible();
  });

  test("an unknown Ironside trace explains that it has not been imported yet", async ({ page }) => {
    await page.goto("/links/trace?source=ironside&project=e2e_no_such_project&trace=e2e_no_such_trace");
    await expect(page.getByText("This trace hasn't been imported into Rubrist yet.")).toBeVisible();
    await expect(page.getByText("None of your Rubrist projects is connected to Ironside project")).toBeVisible();
  });
});
