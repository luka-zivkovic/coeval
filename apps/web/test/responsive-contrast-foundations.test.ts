import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const srcRoot = new URL("../src/", import.meta.url);

async function source(path: string): Promise<string> {
  return readFile(new URL(path, srcRoot), "utf8");
}

function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace("#", "");
  return [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16) / 255) as [number, number, number];
}

function luminance(hex: string): number {
  const [red, green, blue] = hexToRgb(hex).map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  );
  return (0.2126 * red) + (0.7152 * green) + (0.0722 * blue);
}

function contrast(foreground: string, background: string): number {
  const light = Math.max(luminance(foreground), luminance(background));
  const dark = Math.min(luminance(foreground), luminance(background));
  return (light + 0.05) / (dark + 0.05);
}

function tokens(block: string): Record<string, string> {
  return Object.fromEntries(
    [...block.matchAll(/--([\w-]+):\s*(#[0-9A-Fa-f]{6})\s*;/g)].map((match) => [match[1], match[2]])
  );
}

async function tsxFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return tsxFiles(path);
    return entry.name.endsWith(".tsx") ? [path] : [];
  }))).flat();
}

describe("responsive and contrast foundations", () => {
  it("keeps compact text tokens above WCAG AA on every solid product surface", async () => {
    const css = await source("styles.css");
    const light = tokens(css.match(/:root\s*{([\s\S]*?)}\s*\.dark/)?.[1] ?? "");
    const dark = tokens(css.match(/\.dark\s*{([\s\S]*?)}\s*\/\* Map/)?.[1] ?? "");

    expect(Object.keys(light).length).toBeGreaterThan(20);
    expect(Object.keys(dark).length).toBeGreaterThan(15);

    for (const [theme, palette] of [["light", light], ["dark", dark]] as const) {
      const surfaces = ["paper", "paper-2", "paper-3", "card-raw", "card-2"];
      for (const text of ["ink-3", "ink-4", "gold"]) {
        for (const surface of surfaces) {
          expect(contrast(palette[text], palette[surface]), `${theme} ${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
        }
      }
      expect(contrast(palette["signal-contrast"], palette.signal), `${theme} signal button`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(palette["ambig-fill"], palette.ink), `${theme} ambiguous fill next to pass`).toBeGreaterThanOrEqual(3);
      expect(contrast(palette["ambig-fill"], palette.signal), `${theme} ambiguous fill next to fail`).toBeGreaterThanOrEqual(3);
    }

    for (const surface of ["signal-tint", "signal-wash", "ambig-bg", "gold-tint"]) {
      for (const text of ["ink-3", "ink-4", "gold"]) {
        expect(contrast(light[text], light[surface]), `light ${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
      }
    }

    expect(css).toContain("--ambig-pattern: repeating-linear-gradient");
  });

  it("provides shared overflow, wrapping, and touch-target contracts", async () => {
    const [table, card, kpi, ref, rowAction, reviewPlayer] = await Promise.all([
      source("components/ui/table.tsx"),
      source("components/ui/card.tsx"),
      source("components/coeval/kpi.tsx"),
      source("components/coeval/ref.tsx"),
      source("components/row-action.tsx"),
      source("components/review-player.tsx")
    ]);

    expect(table).toContain("overflow-x-auto");
    expect(table).toContain("tabIndex={0}");
    expect(card).toContain("flex-wrap");
    expect(card).toContain("max-w-full");
    expect(kpi).toContain("sm:grid-cols-2");
    expect(ref).toContain("min-h-6");
    expect(rowAction).toContain("min-h-6");
    expect(reviewPlayer).toContain('className="group grid size-6');
  });

  it("makes the application shell collapsible without hiding navigation from desktop users", async () => {
    const [root, sidebar, topbar] = await Promise.all([
      source("components/layout/root-layout.tsx"),
      source("components/layout/sidebar.tsx"),
      source("components/layout/topbar.tsx")
    ]);

    expect(root).toContain("grid-cols-1 lg:grid-cols-[232px_minmax(0,1fr)]");
    expect(root).toContain("navigationOpen");
    expect(root).toContain('aria-label="Close workspace navigation"');
    expect(sidebar).toContain('id="workspace-navigation"');
    expect(sidebar).toContain("lg:translate-x-0");
    expect(sidebar).toContain("h-dvh");
    expect(sidebar).toContain("tabIndex={-1}");
    expect(topbar).toContain('aria-controls="workspace-navigation"');
    expect(topbar).toContain("lg:hidden");
    expect(root).toContain('window.matchMedia("(min-width: 1024px)")');
    expect(root).toContain("inert={navigationOpen}");
  });

  it("keeps every application dialog within the viewport and scrollable", async () => {
    const dialogFiles = [
      "components/import-trace-launcher.tsx",
      "components/save-queue-modal.tsx",
      "components/project-create.tsx",
      "screens/integrations.tsx",
      "screens/reliability.tsx",
      "screens/datasets.tsx",
      "screens/settings.tsx",
      "screens/review-queues.tsx",
      "screens/trace-test-builder.tsx"
    ];

    for (const path of dialogFiles) {
      const contents = await source(path);
      expect(contents, path).toContain("overflow-y-auto");
      expect(contents, path).toContain("max-h-[calc(100dvh-2rem)]");
    }
  });

  it("does not use decorative mute tokens as text or undefined ink tokens", async () => {
    const files = await tsxFiles(new URL(".", srcRoot).pathname);
    const contents = (await Promise.all(files.map((path) => readFile(path, "utf8")))).join("\n");
    expect(contents).not.toContain("text-ink-mute");
    expect(contents).not.toContain("text-ink-1");
  });
});
