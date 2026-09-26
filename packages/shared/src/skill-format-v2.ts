import { z } from "zod";
import { EvaluatorIdentitySchema, TypedQuestionSchema } from "./evaluator-execution.js";
import {
  containsLoneUtf16Surrogate,
  containsOwnProtoKey,
  exceedsJsonDepth,
  SkillStatusSchema,
  V2_EVIDENCE_MAX_JSON_DEPTH,
  VerdictLabelSchema
} from "./judge.js";

// skill-format/v2 (Rubrist ADR-0014 section 7, decision 5): the portable export
// of one evaluator version. Unlike evidence, it carries the full definition,
// the execution binding, and a typed question's text, because an export exists
// to move an evaluator; its digests let an importer confirm the identity it
// received. It replaced the informal skill-format/v1.

export const SKILL_FORMAT_V2 = "skill-format/v2" as const;
export const SKILL_FORMAT_V2_EXAMPLES_CAP = 50;
export const SKILL_FORMAT_V2_OWNER_MAX = 200;

const Sha256DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
// Example payloads are arbitrary JSON; their depth is bounded before the
// recursive parse, so an adversarial document fails validation instead of the stack.
export const SKILL_FORMAT_V2_MAX_JSON_DEPTH = V2_EVIDENCE_MAX_JSON_DEPTH;

/** A labelled golden case, with the same redaction as every trace surface. */
export const SkillFormatV2ExampleSchema = z.object({
  id: z.string().min(1).max(200),
  label: VerdictLabelSchema,
  input: z.json(),
  output: z.json(),
  reason: z.string(),
  metadata: z.record(z.string(), z.json()).nullable()
}).strict();
export type SkillFormatV2Example = z.infer<typeof SkillFormatV2ExampleSchema>;

const SkillFormatV2ObjectSchema = z.object({
  formatVersion: z.literal(SKILL_FORMAT_V2),
  name: z.string().min(1).max(200),
  description: z.string().max(20_000),
  owner: z.string().max(SKILL_FORMAT_V2_OWNER_MAX),
  version: z.string().min(1).max(100),
  status: SkillStatusSchema,
  evaluator: z.object({
    identity: EvaluatorIdentitySchema,
    // The question text a typed-question definition holds only as a digest; null for prompted definitions.
    question: TypedQuestionSchema.nullable()
  }).strict().superRefine((evaluator, ctx) => {
    if ((evaluator.identity.definition.kind === "typed-question") !== (evaluator.question !== null)) {
      ctx.addIssue({ code: "custom", path: ["question"], message: "a typed-question evaluator carries its question text, and only it does" });
    }
  }),
  digests: z.object({
    definitionDigest: Sha256DigestSchema,
    skillDigest: Sha256DigestSchema,
    outputContractDigest: Sha256DigestSchema
  }).strict(),
  examples: z.array(SkillFormatV2ExampleSchema).max(SKILL_FORMAT_V2_EXAMPLES_CAP),
  // Honest notes about anything the export could not source; never a fabricated value.
  notes: z.array(z.string().min(1).max(2_000)).max(20)
}).strict();

/**
 * Whether one golden example can travel in a skill-format/v2 document: the
 * document's rules, applied to an example two levels below its root, so an
 * exporter leaves out that example instead of refusing the whole export.
 */
export function isPortableSkillFormatV2Example(example: unknown): boolean {
  return !exceedsJsonDepth(example, SKILL_FORMAT_V2_MAX_JSON_DEPTH - 2) &&
    !containsOwnProtoKey(example) &&
    !containsLoneUtf16Surrogate(example) &&
    SkillFormatV2ExampleSchema.safeParse(example).success;
}

/** The raw document is checked first: no `__proto__` key and no lone surrogate anywhere. */
export const SkillFormatV2Schema = z.unknown().superRefine((raw, ctx) => {
  if (exceedsJsonDepth(raw, SKILL_FORMAT_V2_MAX_JSON_DEPTH)) {
    ctx.addIssue({ code: "custom", message: `skill-format documents must not nest deeper than ${SKILL_FORMAT_V2_MAX_JSON_DEPTH} levels` });
    return;
  }
  if (containsOwnProtoKey(raw)) {
    ctx.addIssue({ code: "custom", message: "skill-format documents must not contain a __proto__ key" });
  }
  if (containsLoneUtf16Surrogate(raw)) {
    ctx.addIssue({ code: "custom", message: "skill-format documents must not contain lone UTF-16 surrogates" });
  }
}).pipe(SkillFormatV2ObjectSchema);
export type SkillFormatV2 = z.infer<typeof SkillFormatV2Schema>;
