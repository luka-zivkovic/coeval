import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RubristBrand } from "../src/components/rubrist-brand.js";

describe("Rubrist brand mark", () => {
  it("renders the approved mark as a decorative image beside the product name", () => {
    const html = renderToStaticMarkup(createElement(RubristBrand));

    expect(html).toContain('src="/brand/rubrist-app-icon.png"');
    expect(html).toContain('alt=""');
    expect(html).toContain("rubrist");
  });

  it("uses the approved mark for browser and home-screen icons", () => {
    const document = readFileSync(new URL("../index.html", import.meta.url), "utf8");

    expect(document).toContain('rel="icon" type="image/png" href="/brand/rubrist-app-icon.png"');
    expect(document).toContain('rel="apple-touch-icon" href="/brand/rubrist-app-icon.png"');
  });
});
