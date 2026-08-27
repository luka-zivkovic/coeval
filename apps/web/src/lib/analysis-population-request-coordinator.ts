export interface AnalysisPopulationRequestToken {
  populationId: string;
  populationGeneration: number;
}

export interface AnalysisPopulationContentToken extends AnalysisPopulationRequestToken {
  contentGeneration: number;
}

export interface AnalysisPopulationPageToken extends AnalysisPopulationRequestToken {
  key: string;
}

/**
 * Coordinates one Analyze screen instance without cancelling immutable reads.
 * Late responses are harmless: only tokens for the current population and the
 * latest explicit content click are allowed to commit.
 */
export class AnalysisPopulationRequestCoordinator {
  private populationId: string | null = null;
  private populationGeneration = 0;
  private contentGeneration = 0;
  private readonly pageLoads = new Set<string>();

  selectPopulation(populationId: string): AnalysisPopulationRequestToken {
    this.populationId = populationId;
    this.populationGeneration += 1;
    this.contentGeneration += 1;
    return { populationId, populationGeneration: this.populationGeneration };
  }

  isPopulationCurrent(token: AnalysisPopulationRequestToken): boolean {
    return token.populationId === this.populationId
      && token.populationGeneration === this.populationGeneration;
  }

  beginContent(populationId: string): AnalysisPopulationContentToken | null {
    if (populationId !== this.populationId) return null;
    this.contentGeneration += 1;
    return {
      populationId,
      populationGeneration: this.populationGeneration,
      contentGeneration: this.contentGeneration
    };
  }

  isContentCurrent(token: AnalysisPopulationContentToken): boolean {
    return this.isPopulationCurrent(token)
      && token.contentGeneration === this.contentGeneration;
  }

  beginPage(kind: string, cursor: string): AnalysisPopulationPageToken | null {
    if (!this.populationId) return null;
    const key = `${this.populationId}:${this.populationGeneration}:${kind}:${cursor}`;
    if (this.pageLoads.has(key)) return null;
    this.pageLoads.add(key);
    return {
      populationId: this.populationId,
      populationGeneration: this.populationGeneration,
      key
    };
  }

  finishPage(token: AnalysisPopulationPageToken): void {
    this.pageLoads.delete(token.key);
  }
}
