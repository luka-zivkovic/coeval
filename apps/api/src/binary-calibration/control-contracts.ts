import { z } from "zod";

const BINARY_CALIBRATION_ID_MAX_LENGTH = 240;
export const BINARY_CALIBRATION_CONTROL_BODY_BYTES = 32 * 1024;

const ControlIdSchema = z.string().trim().min(1).max(BINARY_CALIBRATION_ID_MAX_LENGTH);

/**
 * The public launch request is deliberately smaller than the repository input.
 * Provider identity and data-handling policy are resolved from the pinned
 * evaluator server-side and cannot be asserted by a browser or API client.
 */
export const CreateBinaryCalibrationRunRequestSchema = z.object({
  datasetRevisionId: ControlIdSchema,
  skillVersionId: ControlIdSchema,
  positiveClass: z.enum(["pass", "fail"]),
  trialPlan: z.object({
    kind: z.literal("single"),
    trialsPerItem: z.literal(1)
  }).strict(),
  suiteBinding: z.object({
    manifestId: ControlIdSchema,
    memberPosition: z.number().int().min(0).max(99)
  }).strict().nullable().default(null),
  idempotencyKey: z.string().trim().min(1).max(200)
}).strict();

export type CreateBinaryCalibrationRunRequest = z.infer<
  typeof CreateBinaryCalibrationRunRequestSchema
>;

export const BINARY_CALIBRATION_STATUS_CONTRACT =
  "coeval/binary-calibration-artifact-status/v1" as const;

