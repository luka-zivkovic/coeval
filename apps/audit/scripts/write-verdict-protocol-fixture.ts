import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  compareVerdictProtocolMaterial,
  renderVerdictProtocolMaterial,
  verdictProtocolFixtureText
} from "../test/verdict-protocol-fixture.js";

// Records new verdict protocol material in test/fixtures/verdict-protocols-v1.json.
// A released entry never changes (Rubrist ADR-0014 section 3): if rendering
// would change or drop one, this refuses unless --unreleased is given, which
// is only for material not yet merged. A released change is a new protocol
// version, which adds entries instead.
const fixtureUrl = new URL("../test/fixtures/verdict-protocols-v1.json", import.meta.url);
const rendered = renderVerdictProtocolMaterial();
const recorded = existsSync(fixtureUrl)
  ? (JSON.parse(readFileSync(fixtureUrl, "utf8")) as { protocols: Record<string, Record<string, unknown>> }).protocols
  : {};
const { added, changed, removed } = compareVerdictProtocolMaterial(recorded, rendered);
if ((changed.length > 0 || removed.length > 0) && !process.argv.includes("--unreleased")) {
  console.error("Released verdict protocol material would change. Add a new protocol version instead.");
  for (const key of changed) console.error(`  changed: ${key}`);
  for (const key of removed) console.error(`  removed: ${key}`);
  process.exit(1);
}
writeFileSync(fixtureUrl, verdictProtocolFixtureText(rendered));
console.log(`verdict protocol fixture: ${added.length} added, ${changed.length} changed, ${removed.length} removed`);
