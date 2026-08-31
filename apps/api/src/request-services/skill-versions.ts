import type { EvaluatorExecutionContext } from "@coeval/shared";
import {
  AmbiguousProjectSkillError,
  NoCurrentSkillError,
  type CoevalRepository
} from "../repository.js";

export interface SkillVersionAuthorization {
  context: EvaluatorExecutionContext;
  resourceKind: string;
  resourceId: string;
}

export type ResolvedSkillVersion = { id: string } | { invalid: string };

export type ResolveSkillVersionId = (
  projectId: string,
  requested: string | undefined,
  authorization?: SkillVersionAuthorization
) => Promise<ResolvedSkillVersion>;

const DEFAULT_AUTHORIZATION: SkillVersionAuthorization = {
  context: "implicit_production",
  resourceKind: "api_route",
  resourceId: "current"
};

// This is the single request-time evaluator authorization path. Explicit ids
// are resolved inside the project before callers import or persist work, so a
// typo or cross-project id cannot become a late FK/item failure. Route modules
// may choose a version differently, but they must all converge here before
// judging or creating a provider-spending run.
export function createSkillVersionResolver(repository: CoevalRepository): ResolveSkillVersionId {
  return async (projectId, requested, authorization = DEFAULT_AUTHORIZATION) => {
    let resolvedId: string;
    if (requested) {
      const version = await repository.getSkillVersion(projectId, requested);
      if (!version) return { invalid: `Unknown skillVersionId for this project: ${requested}` };
      resolvedId = version.id;
    } else {
      try {
        const skill = await repository.getCurrentSkill(projectId);
        resolvedId = skill.currentVersion.id;
      } catch (error) {
        if (error instanceof AmbiguousProjectSkillError) {
          return { invalid: "This project has multiple criteria; provide skillVersionId explicitly." };
        }
        if (!(error instanceof NoCurrentSkillError)) throw error;
        return { invalid: "No active skill version. Define one before judging." };
      }
    }

    try {
      await repository.authorizeSkillVersionExecution({
        projectId,
        skillVersionId: resolvedId,
        context: authorization.context,
        resourceKind: authorization.resourceKind,
        resourceId: authorization.resourceId,
        idempotencyKey: `route-auth:${authorization.context}:${authorization.resourceKind}:${authorization.resourceId}:${resolvedId}`
      });
    } catch (error) {
      return {
        invalid: error instanceof Error
          ? error.message
          : "Evaluator version is not authorized for this operation."
      };
    }
    return { id: resolvedId };
  };
}
