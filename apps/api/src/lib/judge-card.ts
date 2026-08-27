import {
  KAPPA_MIN_SHARED_CASES,
  type JudgeCard,
  type JudgeCardAuditEntry,
  type KappaSummary,
  type ProjectSettings,
  type RegressionRunResult,
  type SelfConsistencyReport,
  type Skill,
  type SkillVersion
} from "@coeval/shared";

// assemble the Judge Card from RECORDED data only. Every absent signal
// becomes an explicit null/empty plus a basis note — the card never implies
// evidence that doesn't exist, and never computes a composite score.
export function buildJudgeCard(input: {
  generatedAt: string;
  project: ProjectSettings;
  skill: Skill;
  version: SkillVersion;
  goldenSetSize: number;
  regression: RegressionRunResult | null;
  calibration: KappaSummary;
  selfConsistency: SelfConsistencyReport;
  audit: JudgeCardAuditEntry[];
}): JudgeCard {
  const basis: string[] = [];

  // κ pairs for THIS version: the judge rater id is `judge:<versionId>`.
  const judgeRater = `judge:${input.version.id}`;
  const undefinedJudgeHumanPairs = (input.calibration.undefinedPairs ?? []).filter(
    (pair) => pair.reviewerA === judgeRater || pair.reviewerB === judgeRater
  );
  const judgeHumanKappa = input.calibration.pairs
    .filter((pair) => pair.reviewerA === judgeRater || pair.reviewerB === judgeRater)
    .map((pair) => ({
      humanRater: pair.reviewerA === judgeRater ? pair.reviewerB : pair.reviewerA,
      kappa: pair.kappa,
      interpretation: pair.interpretation,
      cases: pair.cases
    }));
  if (judgeHumanKappa.length === 0) {
    basis.push(undefinedJudgeHumanPairs.length > 0
      ? `judge-human κ: undefined for ${undefinedJudgeHumanPairs.length} reviewer pair(s) because expected agreement is 1; raw agreement is not converted to favorable κ.`
      : "judge-human κ: no human verdicts overlap this version yet — κ lights up as reviewers record verdicts or promote golden cases."
    );
  }

  const selfConsistency = input.selfConsistency.comparedCases > 0
    ? {
        comparedCases: input.selfConsistency.comparedCases,
        consistentCases: input.selfConsistency.consistentCases,
        meanAgreement: input.selfConsistency.meanAgreement
      }
    : null;
  if (!selfConsistency) {
    basis.push(
      "self-consistency: no case has been judged twice by this version — repeat runs (force:true or re-runs) populate it."
    );
  }

  if (!input.regression) {
    basis.push("regression: no recorded gate run for this version (predates the gate, or the run was not persisted).");
  } else if (input.regression.compared === 0) {
    basis.push(input.regression.status === "error"
      ? `regression: gate execution failed${input.regression.error ? ` — ${input.regression.error}` : "."}`
      : "regression: the golden set was empty when this version shipped — the gate was advisory only.");
  }
  if (input.goldenSetSize === 0) {
    basis.push("golden set: currently empty — agreement and the gate are advisory until cases are promoted.");
  }
  if (input.regression && input.regression.status !== "error" && input.regression.compared !== input.goldenSetSize) {
    basis.push(
      `golden set has changed since this version's gate run: agreement reflects the ${input.regression.compared} case(s) compared at ship time, while the CURRENT set holds ${input.goldenSetSize}.`
    );
  }
  if (input.audit.length === 0) {
    basis.push("audit: no sign-off/override audit entries recorded for this version.");
  }
  if (input.version.rubricProvenance === "agent-drafted") {
    basis.push("rubric provenance: agent-drafted scaffold — human adjudication is still required before treating the judge as trusted.");
  }
  basis.push("This card reports recorded evidence only; it is not a composite score and consistency is not correctness.");

  return {
    generatedAt: input.generatedAt,
    project: { id: input.project.projectId, name: input.project.name },
    skill: { id: input.skill.id, name: input.skill.name, ownerName: input.skill.ownerName },
    version: {
      id: input.version.id,
      version: input.version.version,
      status: input.version.status,
      verdictKind: input.version.verdictKind,
      rubricProvenance: input.version.rubricProvenance,
      createdAt: input.version.createdAt,
      approvedAt: input.version.approvedAt
    },
    modelBinding: input.version.modelBinding,
    goldenSet: {
      size: input.goldenSetSize,
      agreement: input.version.goldenSetAgreement,
      tooStrict: input.version.tooStrictCount,
      tooLenient: input.version.tooLenientCount,
      ambiguous: input.version.ambiguousCount
    },
    regression: input.regression
      ? {
          status: input.regression.status,
          compared: input.regression.compared,
          regressed: input.regression.regressed,
          improved: input.regression.improved,
          flipped: input.regression.flipped,
          overrideReason: input.regression.overrideReason ?? null,
          error: input.regression.error ?? null,
          createdAt: input.regression.createdAt
        }
      : null,
    judgeHumanKappa,
    selfConsistency,
    audit: input.audit,
    basis
  };
}

// neutralize every user-controlled string before it enters the card
// markdown. The card is served as text/markdown AND (M4 C2) rendered/exported
// in the browser, so a crafted skill/model/override/rater value must not
// inject markdown links/images, code spans, emphasis, raw HTML, or newlines
// that forge or break card lines. Newlines collapse to a space (values are
// inline within a bullet/heading); the injection-relevant punctuation is
// backslash-escaped (CommonMark treats `\<` etc. as literal). Purely cosmetic
// chars (`.`, `-`, `+`) are left readable — they're not inline vectors.
// (`~` is escaped too: GFM strikethrough, which a browser renderer may honor.)
function esc(value: string): string {
  return value
    .replace(/[\r\n]+/g, " ")
    .replace(/[\\`*_[\]()#!|<>~]/g, (ch) => `\\${ch}`);
}

// Paste-able markdown rendering. Counts, never bare percentages.
export function renderJudgeCardMarkdown(card: JudgeCard): string {
  const lines: string[] = [];
  lines.push(`# Judge Card — ${esc(card.skill.name)} ${card.version.version}`);
  lines.push("");
  lines.push(`Project **${esc(card.project.name)}** · skill owner ${esc(card.skill.ownerName)} · generated ${card.generatedAt}`);
  lines.push("");
  lines.push(`- **Version**: ${card.version.version} (\`${card.version.id}\`) · status **${card.version.status}** · verdict kind ${card.version.verdictKind}`);
  lines.push(`- **Approved**: ${card.version.approvedAt ?? "not approved"}`);
  lines.push(`- **Rubric provenance**: ${card.version.rubricProvenance}`);
  lines.push(`- **Requested model**: ${esc(card.modelBinding.provider)}/${esc(card.modelBinding.modelId)} · catalog identity ${esc(card.modelBinding.modelVersion)} · temp ${card.modelBinding.temperature}`);
  const agreement = card.goldenSet.agreement === null
    ? "no comparable golden cases"
    : card.regression
      ? `recorded ratio ${card.goldenSet.agreement.toFixed(2)} over the ${card.regression.compared} case(s) compared at ship`
      : `recorded ratio ${card.goldenSet.agreement.toFixed(2)} (ship-time denominator not recorded)`;
  lines.push(`- **Golden set**: ${card.goldenSet.size} active case(s) now · agreement ${agreement} · directions ${card.goldenSet.tooStrict} strict / ${card.goldenSet.tooLenient} lenient / ${card.goldenSet.ambiguous} ambiguous`);
  if (card.regression) {
    lines.push(
      `- **Regression gate**: ${card.regression.status} · ${card.regression.compared} compared, ${card.regression.regressed} regressed, ${card.regression.improved} improved, ${card.regression.flipped} flipped` +
      (card.regression.overrideReason ? ` · override: "${esc(card.regression.overrideReason)}"` : "")
      + (card.regression.error ? ` · error: "${esc(card.regression.error)}"` : "")
    );
  } else {
    lines.push("- **Regression gate**: no recorded run");
  }
  if (card.judgeHumanKappa.length > 0) {
    for (const pair of card.judgeHumanKappa) {
      // Same minimum-sample gate as every in-app κ surface. The exportable
      // card is the paste-able trust document — it must never print a
      // precise "κ 1.00 (almost perfect) · 1 case(s)" the app itself would
      // withhold as insufficient evidence.
      if (pair.cases < KAPPA_MIN_SHARED_CASES) {
        lines.push(
          `- **Judge–human κ** vs ${esc(pair.humanRater)}: gathering evidence · ${pair.cases}/${KAPPA_MIN_SHARED_CASES} shared case(s) (κ withheld below the minimum sample)`
        );
        continue;
      }
      lines.push(`- **Judge–human κ** vs ${esc(pair.humanRater)}: ${pair.kappa.toFixed(2)} (${pair.interpretation.replace("_", " ")}) over ${pair.cases} case(s)`);
    }
  } else {
    lines.push("- **Judge–human κ**: none recorded yet");
  }
  lines.push(
    card.selfConsistency
      ? `- **Self-consistency**: ${card.selfConsistency.consistentCases}/${card.selfConsistency.comparedCases} probed case(s) fully consistent` +
        (card.selfConsistency.meanAgreement !== null ? ` · mean per-case agreement ${card.selfConsistency.meanAgreement.toFixed(2)}` : "")
      : "- **Self-consistency**: not probed yet"
  );
  if (card.audit.length > 0) {
    lines.push(`- **Audit**: ${card.audit.map((entry) => `${esc(entry.action)} (${entry.createdAt})`).join(" · ")}`);
  }
  lines.push("");
  lines.push("## Basis");
  for (const note of card.basis) lines.push(`- ${note}`);
  return lines.join("\n") + "\n";
}
