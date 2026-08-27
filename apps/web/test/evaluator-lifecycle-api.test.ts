import { afterEach,describe,expect,it,vi } from "vitest";
import { fetchAllEvaluatorLifecycles, fetchEvaluatorLifecycles } from "../src/lib/evaluator-lifecycle-api.js";

function json(value:unknown,status=200):Response {
  return new Response(JSON.stringify(value),{status,headers:{"content-type":"application/json"}});
}

describe("evaluator lifecycle web API",()=>{
  afterEach(()=>vi.unstubAllGlobals());

  it("preserves the exact project role and no-store session boundary",async()=>{
    const fetchMock=vi.fn(async()=>json({
      page:{items:[],nextCursor:null,totalCount:"0"},
      projectRole:"owner"
    }));
    vi.stubGlobal("localStorage",{getItem:vi.fn(()=>"project_1")});
    vi.stubGlobal("fetch",fetchMock);
    await expect(fetchEvaluatorLifecycles()).resolves.toEqual({
      page:{items:[],nextCursor:null,totalCount:"0"},projectRole:"owner"
    });
    const init=fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.credentials).toBe("include");
    expect(new Headers(init.headers).get("x-coeval-project")).toBe("project_1");
  });

  it("fails closed when the server omits actor authority",async()=>{
    vi.stubGlobal("fetch",vi.fn(async()=>json({
      page:{items:[],nextCursor:null,totalCount:"0"}
    })));
    await expect(fetchEvaluatorLifecycles()).rejects.toThrow("exact project role");
  });

  it("follows the bounded opaque cursor until the lifecycle history is complete",async()=>{
    const fetchMock=vi.fn()
      .mockResolvedValueOnce(json({page:{items:[],nextCursor:"cursor-2",totalCount:"0"},projectRole:"member"}))
      .mockResolvedValueOnce(json({page:{items:[],nextCursor:null,totalCount:"0"},projectRole:"member"}));
    vi.stubGlobal("fetch",fetchMock);
    await expect(fetchAllEvaluatorLifecycles()).resolves.toEqual({
      items:[],totalCount:"0",projectRole:"member"
    });
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("cursor=cursor-2");
  });
});
