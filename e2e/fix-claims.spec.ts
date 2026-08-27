import { test, expect, type Page } from "@playwright/test";

// Read-only invariant checks for fix-claims confirmed by past E2E sims
// (see tools/sim/RUNBOOK.md). They assume a seeded environment — a sim has
// already pushed traces, reviewed cases, and promoted golden entries — and
// skip themselves when the data they assert about doesn't exist. Mutating
// claims (Accept records the judge's label, promote-conflict 409, gate 503
// without credentials) are covered by API-level tests in apps/api/test.

async function bodyText(page: Page): Promise<string> {
  return page.evaluate(() => document.body.innerText);
}

// The shell renders its chrome before the project context loads, so a snapshot
// taken at first paint sees zeroed counts and empty lists. Settle on
// networkidle before asserting — acceptable for a harness that targets a
// local dev stack.
async function goAndSettle(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await page.waitForLoadState("networkidle");
}

test.describe("traces page", () => {
  test("renders without 'Invalid verdicts query' and the ambiguous filter matches its own distribution", async ({ page }) => {
    await goAndSettle(page, "/traces");
    await expect(page.getByText("Verdict rows", { exact: true })).toBeVisible();

    const before = await bodyText(page);
    expect(before).not.toMatch(/invalid verdicts query/i);

    const distribution = before.match(/(\d+)%\s+ambiguous\s+·\s+(\d+)/i) ?? before.match(/ambiguous\s+·\s+(\d+)/i);
    const ambiguousCount = Number(distribution?.[distribution.length - 1] ?? 0);
    test.skip(ambiguousCount === 0, "no ambiguous verdicts in this environment");

    await page.getByRole("button", { name: "Ambiguous", exact: true }).click();
    await expect(async () => {
      const after = await bodyText(page);
      const matchingRows = after.match(/verdict rows\s*(\d+)/i);
      expect(Number(matchingRows?.[1])).toBe(ambiguousCount);
    }).toPass({ timeout: 10_000 });
  });
});

test.describe("version governance", () => {
  test("the production skill card never shows a gate-blocked version", async ({ page }) => {
    await goAndSettle(page, "/");
    await expect(page.getByText("Skill in production")).toBeVisible();
    // Scope to the card: from its title to its trailing CTA.
    const text = await bodyText(page);
    const card = text.slice(text.indexOf("Skill in production"), text.indexOf("Open skill") + 10);
    expect(card).toMatch(/v\d+\.\d+\.\d+/i);
    expect(card).not.toMatch(/regressing|deprecated/i);
  });

  test("version history renders a status per version", async ({ page }) => {
    await goAndSettle(page, "/skill/versions");
    await expect(page.getByText(/skill versions/i).first()).toBeVisible();
    const text = await bodyText(page);
    const versions = text.match(/v\d+\.\d+\.\d+/g) ?? [];
    test.skip(versions.length === 0, "no versions yet");
    expect(text).toMatch(/approved|draft|regressing/i);
  });
});

test.describe("exceptions and case pages", () => {
  test("ambiguous exceptions render as Ambiguous, in the queue and on the case page", async ({ page }) => {
    await goAndSettle(page, "/exceptions");
    await expect(page.getByText(/exception queue/i)).toBeVisible();

    const ambiguousChip = page.getByRole("cell", { name: "Ambiguous", exact: true }).first();
    test.skip(!(await ambiguousChip.isVisible().catch(() => false)), "no ambiguous exceptions queued");

    await ambiguousChip.click();
    await expect(page).toHaveURL(/\/cases\//);
    await expect(page.getByText("What the skill said")).toBeVisible();
    const text = await bodyText(page);
    const panel = text.slice(text.indexOf("What the skill said"));
    // The fix-claim: an ambiguous verdict must not render as Fail.
    expect(panel).toMatch(/ambiguous/i);
    expect(panel.slice(0, 200)).not.toMatch(/\bfail\b/i);
  });
});

test.describe("reliability trust surfaces", () => {
  test("tiles are self-explanatory and reviewers show by name, not UUID", async ({ page }) => {
    await goAndSettle(page, "/reliability");
    await expect(page.getByText(/reviewer agreement/i)).toBeVisible();

    const text = await bodyText(page);
    // κ is either a real number with overlap context, or an honest refusal.
    expect(text).toMatch(/not enough overlap|\d+ shared cases/i);
    // Disagreement tile spells out its denominator.
    expect(text).toMatch(/\d+ of \d+ reviewed cases disagree/i);
    // No raw identifiers where people belong.
    expect(text).not.toMatch(/user_[0-9a-f]{8}/i);
  });
});

test.describe("golden set", () => {
  test("entries are immutable with named provenance", async ({ page }) => {
    await goAndSettle(page, "/golden");
    const text = await bodyText(page);
    test.skip(!/promoted by/i.test(text), "no golden entries yet");
    expect(text).toMatch(/immutable/i);
    // "promoted by <display name>" — not a user UUID.
    const promoter = text.match(/promoted by ([^\n·]+)/i)?.[1] ?? "";
    expect(promoter).not.toMatch(/user_[0-9a-f]/i);
  });
});

test.describe("datasets", () => {
  test("screen lists datasets and the eval-run history", async ({ page }) => {
    await goAndSettle(page, "/datasets");
    await expect(page.getByText(/eval runs/i).first()).toBeVisible();
    const text = await bodyText(page);
    // Either real datasets (with their run affordance) or the empty state —
    // never a crash or a blank panel.
    expect(text).toMatch(/run eval|no datasets yet/i);
  });
});
