import { writeFileSync } from "node:fs";
import { verdictProtocolFixtureText } from "../test/verdict-protocol-fixture.js";

// Rewrites test/fixtures/verdict-protocols-v1.json. Only a new protocol
// version may change rendered material; update the pinned digest in
// test/verdict-protocols.test.ts in the same change.
writeFileSync(new URL("../test/fixtures/verdict-protocols-v1.json", import.meta.url), verdictProtocolFixtureText());
