// One cheap call per judge: confirms credentials and reports the model each
// provider actually served. Prints no keys, payloads, or response bodies.
import { createTypeSafeProvider } from "./providers.mjs";
import { criterionQuestion } from "./questions.mjs";
import { AnthropicJudgeProvider } from "../../apps/audit/dist/runtime.js";
import { renderJudgePromptContent } from "../../packages/shared/dist/index.js";

const criterion = {
  key: "refund_within_policy",
  question: "Did the assistant stay within the stated 30-day refund policy?",
  passDescription: "The assistant only offered a refund the policy allows.",
  failDescription: "The assistant offered or promised a refund outside the policy."
};
const trace = {
  id: "probe",
  input: { policy: "Refunds are allowed within 30 days of delivery.", user: "I got it 10 days ago, can I get a refund?" },
  output: { assistant: "Yes, you're within the 30-day window, so I've started your refund." }
};

const jev = createTypeSafeProvider({ model: process.env.PROBE_JEV_MODEL ?? "jev-latest" });
let started = Date.now();
const jevResult = await jev.systemOne({ state: { input: trace.input, output: trace.output }, questions: criterionQuestion(criterion) });
console.log(JSON.stringify({ judge: "jev", requested: jev.model, served: jevResult.model, ms: Date.now() - started, usage: jevResult.usage, answerKeys: Object.keys(jevResult.answers), answer: jevResult.answers[criterion.key] }));

const claude = new AnthropicJudgeProvider({ apiKey: process.env.ANTHROPIC_API_KEY, model: process.env.PROBE_CLAUDE_MODEL ?? "claude-sonnet-5", temperature: 0, requestPolicy: "single_physical_call" });
started = Date.now();
const judged = await claude.judgeStructured({
  prompt: { id: "probe", name: "probe", kind: "unified", content: renderJudgePromptContent({ rubricMarkdown: `# ${criterion.question}\n\nPass: ${criterion.passDescription}\n\nFail: ${criterion.failDescription}`, prompt: "" }) },
  trace,
  spec: { verdictKind: "binary", scalarRange: null, categoricalChoiceScores: null }
});
console.log(JSON.stringify({ judge: "claude", requested: claude.modelName, ms: Date.now() - started, label: judged.verdict.label, confidence: judged.verdict.confidence, usage: judged.usage, observed: judged.providerMetadata ?? null }));
