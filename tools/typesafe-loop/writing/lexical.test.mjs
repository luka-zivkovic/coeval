import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { aiTellVocabulary, botScaffolding, dashConnectives, decorativeBold, labelText, missingContractions, proseOnly } from "./lexical.mjs";

describe("lexical rules", () => {
  it("ignores code, links and html when looking for prose tells", () => {
    const text = "Run `leverage --delve` then see [docs](https://x.y/leverage). ```\nutilize()\n```";
    assert.equal(aiTellVocabulary(text).length, 0);
    assert.ok(!proseOnly(text).includes("https://"));
  });
  it("finds dashes, tells, scaffolding and decorative bold", () => {
    assert.equal(dashConnectives("We shipped it — finally – and it works.").length, 2);
    assert.deepEqual(aiTellVocabulary("We leverage a robust paradigm to delve deeper.").map((h) => h.match.toLowerCase()), ["leverage", "robust", "paradigm", "delve"]);
    assert.equal(botScaffolding("Furthermore, in conclusion, let's dive in.").length, 3);
    assert.equal(decorativeBold("- **Fast.** It is fast.\n- **Safe.** It is safe.\n- **Cheap.** It is cheap.").length, 3);
    assert.equal(decorativeBold("- **Fast.** yes\n- plain\n- plain\n- plain").length, 0);
  });
  it("flags missing contractions only in long prose", () => {
    const long = Array(70).fill("The system does not fail.").join(" ");
    assert.equal(missingContractions(long).length, 1);
    assert.equal(missingContractions(`${long} It's fine.`).length, 0);
    assert.equal(missingContractions("Short text without contractions.").length, 0);
  });
  it("labels every rule pass or fail", () => {
    const { labels, violationCount } = labelText("We don't delve. Plain text here.");
    assert.equal(labels.ai_tell_vocabulary, "fail");
    assert.equal(labels.dash_connective, "pass");
    assert.equal(violationCount, 1);
  });
});
