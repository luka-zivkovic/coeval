export class AnalysisMutationCoordinator {
  private readonly keys = new Map<string, string>();
  private readonly active = new Set<string>();

  constructor(private readonly createKey: () => string) {}

  begin(signature: string): string | null {
    if (this.active.has(signature)) return null;
    const key = this.keys.get(signature) ?? this.createKey();
    this.keys.set(signature, key);
    this.active.add(signature);
    return key;
  }

  finish(signature: string, outcome: "success" | "definitive_failure" | "ambiguous_failure"): void {
    this.active.delete(signature);
    if (outcome !== "ambiguous_failure") this.keys.delete(signature);
  }

  get busy(): boolean {
    return this.active.size > 0;
  }
}
