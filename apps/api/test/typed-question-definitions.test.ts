import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CreateSkillVersionInputSchema,
  MinimumVerdictOutputSchema,
  SkillVersionSchema,
  TypedQuestionOutputSchema,
  type ExecutionBinding,
  type SkillFormatV2,
  type SkillVersion
} from "@rubrist/shared";
import { createApp } from "../src/app.js";
import {
  evaluatorDefinitionDigest,
  evaluatorIdentityFor,
  evaluatorOutputContractDigestV2,
  skillDigestV2
} from "../src/lib/evaluator-identity.js";
import { verifySkillFormatV2 } from "../src/lib/skill-format-v2.js";
import { DemoRepository } from "../src/repository.js";
import { MOCK_BINDING, bindingInput } from "./fixtures/execution-binding.js";

// A typed-question evaluator version (ADR-0014 section 5) holds a question and
// a decision threshold instead of a rubric and prompt. The portable
// skill-format/v2 vector is the reference: a saved version with its question,
// threshold, and binding names exactly that vector's evaluator.

const FIXTURE = JSON.parse(readFileSync(
  new URL("../../../contracts/fixtures/skill-format-v2.typed-question.json", import.meta.url),
  "utf8"
)) as SkillFormatV2;
const QUESTION = FIXTURE.evaluator.question!;
const JEV = FIXTURE.evaluator.identity.executionBinding as ExecutionBinding;
const THRESHOLD = 0.62;

const TYPED_INPUT = { typedQuestion: QUESTION, decisionThreshold: THRESHOLD, executionBinding: bindingInput(JEV) };
const PROMPTED_INPUT = { rubricMarkdown: "Pass grounded answers.", prompt: "Judge {{rubric_markdown}}.", executionBinding: bindingInput(MOCK_BINDING) };

const PROJECT_ID = "proj_langsmith_support";
const VERSION_ID = "skillv_1_2_0";

/** The demo's current version, rewritten as the vector's typed-question evaluator. */
async function typedVersion(): Promise<SkillVersion> {
  const prompted = (await new DemoRepository().getSkillVersion(PROJECT_ID, VERSION_ID))!;
  return {
    ...prompted,
    rubricMarkdown: null,
    prompt: null,
    typedQuestion: structuredClone(QUESTION),
    decisionThreshold: THRESHOLD,
    executionBinding: structuredClone(JEV),
    customEndpointUrl: null,
    outputSchema: TypedQuestionOutputSchema,
    verdictKind: "binary",
    scalarRange: null,
    categoricalChoiceScores: null
  };
}

describe("typed-question version input", () => {
  it("takes a question and threshold in place of a rubric and prompt, with a fixed output contract", () => {
    const typed = CreateSkillVersionInputSchema.parse(TYPED_INPUT);
    expect(typed).toMatchObject({ typedQuestion: QUESTION, decisionThreshold: THRESHOLD, verdictKind: "binary", outputSchema: TypedQuestionOutputSchema });
    expect(typed.rubricMarkdown).toBeUndefined();
    expect(typed.prompt).toBeUndefined();
    expect(CreateSkillVersionInputSchema.parse(PROMPTED_INPUT).outputSchema).toEqual(MinimumVerdictOutputSchema);
  });

  it("parses its own output again, so a client that parses before sending isn't refused", () => {
    const typed = CreateSkillVersionInputSchema.parse(TYPED_INPUT);
    expect(CreateSkillVersionInputSchema.parse(typed)).toEqual(typed);
    // The fixed contract may come back with its keys in any order.
    const { properties, ...rest } = TypedQuestionOutputSchema;
    expect(CreateSkillVersionInputSchema.safeParse({ ...TYPED_INPUT, outputSchema: { properties, ...rest } }).success).toBe(true);
    const prompted = CreateSkillVersionInputSchema.parse(PROMPTED_INPUT);
    expect(CreateSkillVersionInputSchema.parse(prompted)).toEqual(prompted);
  });

  it("refuses a version that mixes the two definition kinds or leaves out what its kind needs, naming the field", () => {
    const { typedQuestion: _question, ...noQuestion } = TYPED_INPUT;
    const { decisionThreshold: _threshold, ...noThreshold } = TYPED_INPUT;
    const { rubricMarkdown: _rubric, ...noRubric } = PROMPTED_INPUT;
    const { prompt: _prompt, ...noPrompt } = PROMPTED_INPUT;
    const nul = (text: string) => `${text}\u0000`;
    const refused: Array<[string, unknown, string | null]> = [
      ["typed without a question", noQuestion, "typedQuestion"],
      ["typed without a threshold", noThreshold, "decisionThreshold"],
      ["typed at threshold 0", { ...TYPED_INPUT, decisionThreshold: 0 }, "decisionThreshold"],
      ["typed at threshold 1", { ...TYPED_INPUT, decisionThreshold: 1 }, "decisionThreshold"],
      ["typed with a rubric", { ...TYPED_INPUT, rubricMarkdown: "r" }, "rubricMarkdown"],
      ["typed with a prompt", { ...TYPED_INPUT, prompt: "p" }, "prompt"],
      ["typed and scalar", { ...TYPED_INPUT, verdictKind: "scalar", scalarRange: [0, 1] }, "verdictKind"],
      ["typed with another output schema", { ...TYPED_INPUT, outputSchema: MinimumVerdictOutputSchema }, "outputSchema"],
      ["typed with an empty criterion", { ...TYPED_INPUT, typedQuestion: { ...QUESTION, criteria: { ...QUESTION.criteria, false: "" } } }, "typedQuestion"],
      ["typed with a NUL in its question", { ...TYPED_INPUT, typedQuestion: { ...QUESTION, instructions: nul(QUESTION.instructions) } }, null],
      ["prompted with a question", { ...PROMPTED_INPUT, typedQuestion: QUESTION }, "typedQuestion"],
      ["prompted with a threshold", { ...PROMPTED_INPUT, decisionThreshold: THRESHOLD }, "decisionThreshold"],
      ["prompted without a rubric", noRubric, "rubricMarkdown"],
      ["prompted without a prompt", noPrompt, "prompt"],
      ["prompted with a NUL in its rubric", { ...PROMPTED_INPUT, rubricMarkdown: nul("Pass.") }, null]
    ];
    for (const [name, input, field] of refused) {
      const result = CreateSkillVersionInputSchema.safeParse(input);
      expect(result.success, name).toBe(false);
      const paths = result.error!.issues.map((issue) => issue.path[0] ?? null);
      expect(paths, name).toContain(field);
    }
  });
});

describe("a saved typed-question version", () => {
  it("holds exactly one definition kind", async () => {
    const typed = await typedVersion();
    expect(SkillVersionSchema.safeParse(typed).success).toBe(true);
    const refused: Array<[string, Partial<SkillVersion>]> = [
      ["a rubric beside the question", { rubricMarkdown: "r" }],
      ["a prompt beside the question", { prompt: "p" }],
      ["no question", { typedQuestion: null }],
      ["no threshold", { decisionThreshold: null }],
      ["another output contract", { outputSchema: MinimumVerdictOutputSchema }],
      ["a question on a prompted binding", { executionBinding: structuredClone(MOCK_BINDING), rubricMarkdown: "r", prompt: "p" }]
    ];
    for (const [name, change] of refused) {
      expect(SkillVersionSchema.safeParse({ ...typed, ...change }).success, name).toBe(false);
    }
  });

  it("names the portable vector's evaluator, digests included", async () => {
    const identity = evaluatorIdentityFor(await typedVersion());
    expect(identity).toEqual(FIXTURE.evaluator.identity);
    expect({
      definitionDigest: evaluatorDefinitionDigest(identity.definition),
      skillDigest: skillDigestV2(identity),
      outputContractDigest: evaluatorOutputContractDigestV2(identity.definition)
    }).toEqual(FIXTURE.digests);
    // The threshold is identity: another threshold is another evaluator.
    expect(skillDigestV2(evaluatorIdentityFor({ ...await typedVersion(), decisionThreshold: 0.5 }))).not.toBe(FIXTURE.digests.skillDigest);
  });

  it("has no identity when its question and its protocol disagree", async () => {
    const typed = await typedVersion();
    expect(() => evaluatorIdentityFor({ ...typed, typedQuestion: null })).toThrow(/exactly when it runs typed-question\/v1/);
    expect(() => evaluatorIdentityFor({ ...typed, executionBinding: structuredClone(MOCK_BINDING), rubricMarkdown: "r", prompt: "p" }))
      .toThrow(/exactly when it runs typed-question\/v1/);
  });

  it("exports as skill-format/v2 with its question text, which an importer checks against the digest", async () => {
    const typed = await typedVersion();
    class TypedRepository extends DemoRepository {
      override async getSkillVersion(projectId: string, versionId: string): Promise<SkillVersion | null> {
        return versionId === VERSION_ID ? typed : super.getSkillVersion(projectId, versionId);
      }
    }
    const response = await createApp(new TypedRepository()).request(`/api/skills/skill_support_quality/versions/${VERSION_ID}/skill-format`);
    expect(response.status).toBe(200);
    const doc = verifySkillFormatV2(await response.json(), { skillDigest: FIXTURE.digests.skillDigest });
    expect(doc.evaluator).toEqual(FIXTURE.evaluator);
    expect(doc.digests).toEqual(FIXTURE.digests);
  });

  it("is created through the version route and names the portable vector's evaluator", async () => {
    const repository = new DemoRepository();
    const response = await createApp(repository).request("/api/skills/skill_support_quality/versions", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(TYPED_INPUT)
    });
    expect(response.status).toBeLessThan(300);
    const { version } = await response.json() as { version: SkillVersion };
    expect(version).toMatchObject({
      rubricMarkdown: null, prompt: null, typedQuestion: QUESTION, decisionThreshold: THRESHOLD,
      executionBinding: JEV, outputSchema: TypedQuestionOutputSchema, verdictKind: "binary"
    });
    const stored = (await repository.getSkillVersion(PROJECT_ID, version.id))!;
    expect(evaluatorIdentityFor(stored)).toEqual(FIXTURE.evaluator.identity);
  });

  it("is refused with a rubric beside its question, on either route", async () => {
    const app = createApp(new DemoRepository());
    const post = (path: string, body: unknown) => app.request(path, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
    });
    const mixed = { ...TYPED_INPUT, rubricMarkdown: "Pass grounded answers." };
    const responses = [
      await post("/api/skills/skill_support_quality/versions", mixed),
      await post("/api/skills/skill_support_quality/onboarding-check", {
        idempotencyKey: "typed-onboarding",
        criterion: { name: "Refund policy", definition: "Every refund the agent offers is allowed by the policy." },
        evaluator: mixed
      })
    ];
    for (const response of responses) expect(response.status).toBe(400);
  });
});
