import { useRef, useState } from "react";
import { AnalysisMutationCoordinator } from "@/lib/analysis-mutation-coordinator";
import { analysisMutationFailureKind } from "@/lib/analysis-promotion-ui";

export function useIdempotentAction(): {
  busy: boolean;
  run<T>(signature: string, operation: (idempotencyKey: string) => Promise<T>): Promise<T>;
} {
  const coordinator = useRef<AnalysisMutationCoordinator | null>(null);
  if (!coordinator.current) coordinator.current = new AnalysisMutationCoordinator(() => key("analysis-action"));
  const [busy, setBusy] = useState(false);
  return {
    busy,
    run: async <T,>(signature: string, operation: (idempotencyKey: string) => Promise<T>) => {
      const idempotencyKey = coordinator.current!.begin(signature);
      if (!idempotencyKey) throw new Error("This governed mutation is already in flight");
      setBusy(true);
      try {
        const result = await operation(idempotencyKey);
        coordinator.current!.finish(signature, "success");
        return result;
      } catch (cause) {
        coordinator.current!.finish(signature, analysisMutationFailureKind(cause));
        throw cause;
      } finally {
        setBusy(coordinator.current!.busy);
      }
    }
  };
}

function key(prefix: string): string { return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`; }
export function message(cause: unknown): string { return cause instanceof Error ? cause.message : "Governed analysis request failed"; }
