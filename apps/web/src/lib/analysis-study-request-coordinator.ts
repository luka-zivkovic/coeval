export interface AnalysisStudySelectionToken {
  studyId: string;
  studyGeneration: number;
}

export interface AnalysisStudyItemToken extends AnalysisStudySelectionToken {
  studyItemId: string;
  itemGeneration: number;
}

export interface AnalysisStudyContentToken extends AnalysisStudyItemToken {
  contentGeneration: number;
}

export class AnalysisStudyRequestCoordinator {
  private studyId: string | null = null;
  private studyGeneration = 0;
  private studyItemId: string | null = null;
  private itemGeneration = 0;
  private contentGeneration = 0;
  private readonly pages = new Set<string>();

  selectStudy(studyId: string): AnalysisStudySelectionToken {
    this.studyId = studyId;
    this.studyGeneration += 1;
    this.studyItemId = null;
    this.itemGeneration += 1;
    this.contentGeneration += 1;
    this.pages.clear();
    return { studyId, studyGeneration: this.studyGeneration };
  }

  currentStudy(): AnalysisStudySelectionToken | null {
    return this.studyId === null ? null : {
      studyId: this.studyId,
      studyGeneration: this.studyGeneration
    };
  }

  isStudyCurrent(token: AnalysisStudySelectionToken): boolean {
    return token.studyId === this.studyId && token.studyGeneration === this.studyGeneration;
  }

  selectItem(studyId: string, studyItemId: string): AnalysisStudyItemToken | null {
    const study = this.currentStudy();
    if (!study || study.studyId !== studyId) return null;
    this.studyItemId = studyItemId;
    this.itemGeneration += 1;
    this.contentGeneration += 1;
    return { ...study, studyItemId, itemGeneration: this.itemGeneration };
  }

  currentItem(): AnalysisStudyItemToken | null {
    const study = this.currentStudy();
    return !study || this.studyItemId === null ? null : {
      ...study,
      studyItemId: this.studyItemId,
      itemGeneration: this.itemGeneration
    };
  }

  isItemCurrent(token: AnalysisStudyItemToken): boolean {
    return this.isStudyCurrent(token) && token.studyItemId === this.studyItemId &&
      token.itemGeneration === this.itemGeneration;
  }

  beginContent(studyId: string, studyItemId: string): AnalysisStudyContentToken | null {
    const item = this.currentItem();
    if (!item || item.studyId !== studyId || item.studyItemId !== studyItemId) return null;
    this.contentGeneration += 1;
    return { ...item, contentGeneration: this.contentGeneration };
  }

  isContentCurrent(token: AnalysisStudyContentToken): boolean {
    return this.isItemCurrent(token) && token.contentGeneration === this.contentGeneration;
  }

  beginPage(studyId: string, cursor: string): AnalysisStudySelectionToken | null {
    const study = this.currentStudy();
    if (!study || study.studyId !== studyId) return null;
    const key = `${study.studyGeneration}\u0000${cursor}`;
    if (this.pages.has(key)) return null;
    this.pages.add(key);
    return study;
  }

  finishPage(token: AnalysisStudySelectionToken, cursor: string): void {
    this.pages.delete(`${token.studyGeneration}\u0000${cursor}`);
  }
}
