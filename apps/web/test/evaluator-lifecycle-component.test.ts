import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe,expect,it,vi } from "vitest";
import { EvaluatorLifecyclePanel } from "../src/components/evaluator-lifecycle-panel.js";

vi.mock("@/components/ui/button",()=>({Button:({children,...props}:{children?:unknown})=>createElement("button",props,children as never)}));
vi.mock("@/components/ui/card",()=>({
  Card:({children,...props}:{children?:unknown})=>createElement("section",props,children as never),
  CardContent:({children,...props}:{children?:unknown})=>createElement("div",props,children as never),
  CardHeader:({children,...props}:{children?:unknown})=>createElement("header",props,children as never),
  CardTitle:({children,...props}:{children?:unknown})=>createElement("h2",props,children as never)
}));
vi.mock("@/components/ui/input",()=>({Input:(props:Record<string,unknown>)=>createElement("input",props)}));
vi.mock("@/components/ui/textarea",()=>({Textarea:(props:Record<string,unknown>)=>createElement("textarea",props)}));
vi.mock("@/lib/api",()=>({fetchDatasetRevision:vi.fn(),fetchSkillVersionRegression:vi.fn()}));
vi.mock("@/lib/binary-calibration-api",()=>({fetchBinaryCalibrationRuns:vi.fn()}));
vi.mock("@/lib/evaluator-lifecycle-api",()=>({
  activateEvaluator:vi.fn(),createEvaluatorCandidate:vi.fn(),fetchAllEvaluatorLifecycles:vi.fn(),
  lifecycleIdempotencyKey:vi.fn((kind:string)=>`test-${kind}`),retireEvaluator:vi.fn()
}));

describe("evaluator lifecycle UI",()=>{
  it("states the candidate/activation boundary without making approval claims",()=>{
    const html=renderToStaticMarkup(createElement(EvaluatorLifecyclePanel,{
      criterionId:"criterion_1",
      criterionVersionId:"criterion_version_1",
      criterionName:"Correctness",
      batches:[]
    }));
    expect(html).toContain("candidate may run only in exact development, regression, and calibration contexts");
    expect(html).toContain("require an explicit owner activation");
    expect(html).not.toMatch(/automatically approved|trusted evaluator|passed calibration/i);
  });
});
