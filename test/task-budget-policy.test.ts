// THE SHAPED BUDGET POLICY: the floor under max(advertised, floor) is read at use time from taskBudgetPolicy (an entry per
// resolver, per shape, or a default_ms), never only from an in-process constant. Absent → the built-in 186 s, unchanged;
// malformed → the built-in default plus a logged refusal, never a crash; a template's own timeout_ms still wins.
// Every test points the reader at a TEMP policies dir, never the live super-repo clone's.
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { budgetAbortLine, errorCode, readTaskBudgetPolicy, resolveWithConnectRetry, taskBudget, taskBudgetAtUse, taskSignal, TASK_BUDGET_FLOOR_MS } from "../src/task-budget.js";

const dir = mkdtempSync(join(tmpdir(), "ld-task-budget-policy-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const policyFile = (body: string): string => { const p = join(dir, `taskBudgetPolicy-${++n}.json`); writeFileSync(p, body); return p; };
const absent = (): string => join(dir, `absent-${++n}.json`);
const X = { resolver: "development-vessel:llm_author_resolver", shape: "llm_author_resolver" };

describe("taskBudgetPolicy: the floor is a shaped policy read at use time", () => {
  it("[MUST-FAIL] a policy entry for resolver X raises X's budget above 186000, and the trace source names the entry", async () => {
    const path = policyFile(JSON.stringify({ resolvers: { [X.resolver]: 420_000 } }));
    const b = await taskBudgetAtUse(undefined, 10_000, X, { path });
    expect(b.ms).toBe(420_000);
    expect(b.ms).toBeGreaterThan(186_000);
    expect(b.source).toBe(`policy:resolver:${X.resolver}`);
    // another resolver is untouched by X's entry
    expect(await taskBudgetAtUse(undefined, 10_000, { resolver: "other:thing", shape: "thing" }, { path })).toEqual({ ms: TASK_BUDGET_FLOOR_MS, source: "default" });
  });

  it("[MUST-FAIL] a shape entry and the policy default_ms apply in that order after the resolver entry", async () => {
    const path = policyFile(JSON.stringify({ default_ms: 200_000, shapes: { llm_author_resolver: 300_000 }, reason: "test" }));
    expect(await taskBudgetAtUse(undefined, undefined, X, { path })).toEqual({ ms: 300_000, source: "policy:shape:llm_author_resolver" });
    expect(await taskBudgetAtUse(undefined, undefined, { resolver: "a:b", shape: "b" }, { path })).toEqual({ ms: 200_000, source: "policy:default_ms" });
  });

  it("[CONTROL] absent policy → 186000 from the built-in default, nothing logged", async () => {
    const logs: string[] = [];
    const b = await taskBudgetAtUse(undefined, undefined, X, { path: absent(), log: (m) => logs.push(m) });
    expect(b).toEqual({ ms: 186_000, source: "default" });
    expect(logs).toEqual([]);
  });

  it("[MUST-FAIL] a malformed policy → the built-in default plus a logged refusal, never a throw", async () => {
    for (const body of ["{not json", JSON.stringify({ resolvers: { [X.resolver]: "lots" } }), JSON.stringify({ default_msx: 300_000 }), JSON.stringify([1]), JSON.stringify({ shapes: { s: 10 } })]) {
      const logs: string[] = [];
      const b = await taskBudgetAtUse(undefined, undefined, X, { path: policyFile(body), log: (m) => logs.push(m) });
      expect(b).toEqual({ ms: TASK_BUDGET_FLOOR_MS, source: "default" });
      expect(logs.length).toBe(1);
      expect(logs[0]).toContain("taskBudgetPolicy refused");
    }
    expect((await readTaskBudgetPolicy(policyFile("{not json"))).state).toBe("refused");
  });

  it("[CONTROL] the task's own timeout_ms still wins over the policy and the advertisement", async () => {
    const path = policyFile(JSON.stringify({ default_ms: 900_000, resolvers: { [X.resolver]: 600_000 } }));
    expect(await taskBudgetAtUse(20_000, 300_000, X, { path })).toEqual({ ms: 20_000, source: "task" });
    expect(await taskBudgetAtUse(700_000, 10_000, X, { path })).toEqual({ ms: 700_000, source: "task" });
  });

  it("[CONTROL] max(advertised, floor) is kept: an advertisement above the policy floor is used and recorded as advertised", async () => {
    const path = policyFile(JSON.stringify({ resolvers: { [X.resolver]: 200_000 } }));
    expect(await taskBudgetAtUse(undefined, 500_000, X, { path })).toEqual({ ms: 500_000, source: "advertised" });
    expect(taskBudget(undefined, 500_000, null)).toEqual({ ms: 500_000, source: "advertised" });
    expect(taskBudget(undefined, 10_000, null)).toEqual({ ms: TASK_BUDGET_FLOOR_MS, source: "default" });
  });
});

// A budget cut was visible only in the trace (error "The operation timed out.", no journal line). Every cut now logs ONE
// greppable line naming resolver, template, task, budget_ms, source and elapsed_ms; a task inside its budget logs none.
async function fetchOutcome(url: string, signal: AbortSignal) {
  try { const r = await Bun.fetch(url, { method: "POST", body: "{}", signal }); await r.text(); return { ok: r.ok }; }
  catch (err) { const code = errorCode(err); return { ok: false, error: (err as Error).message, ...(code ? { code } : {}) }; }
}
describe("a budget abort leaves one journal line", () => {
  const f = { resolver: "development-vessel:llm_author_resolver", template: "tpl-1", task: "draft", budget_ms: 300, source: "policy:resolver:development-vessel:llm_author_resolver" as const, elapsed_ms: 0 };
  it("[MUST-FAIL] a task cut at its budget yields exactly the [task-budget] abort line with every field", async () => {
    const srv = Bun.serve({ port: 0, async fetch() { await Bun.sleep(1500); return new Response("{}"); } });
    try {
      const t0 = Date.now();
      const { last } = await resolveWithConnectRetry(() => fetchOutcome(`http://127.0.0.1:${srv.port}/`, taskSignal(300)), { sleep: async () => {} });
      const line = budgetAbortLine(last.code, { ...f, elapsed_ms: Date.now() - t0 });
      expect(line).not.toBeNull();
      expect(line!).toMatch(/^\[task-budget\] abort resolver=development-vessel:llm_author_resolver template=tpl-1 task=draft budget_ms=300 source=policy:resolver:development-vessel:llm_author_resolver elapsed_ms=\d+$/);
    } finally { srv.stop(true); }
  });
  it("[CONTROL] a task that finishes inside its budget, or fails otherwise, yields no line", async () => {
    const srv = Bun.serve({ port: 0, fetch: () => new Response("{}") });
    try {
      const { last } = await resolveWithConnectRetry(() => fetchOutcome(`http://127.0.0.1:${srv.port}/`, taskSignal(5_000)), { sleep: async () => {} });
      expect(last.ok).toBe(true);
      expect(budgetAbortLine(last.code, f)).toBeNull();
    } finally { srv.stop(true); }
    expect(budgetAbortLine("ConnectionRefused", f)).toBeNull();
    expect(budgetAbortLine(undefined, f)).toBeNull();
  });
  it("[WIRING] the dispatch loop logs the abort line with the task's resolver, template, task, budget and source", () => {
    const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    expect(src).toContain("const abortLine = budgetAbortLine(resolved.code, { resolver: task.resolver, template: templateId, task: task.id, budget_ms: budgetMs, source: budgetSource, elapsed_ms: Date.now() - tTask0 });");
    expect(src).toContain("if (abortLine) console.warn(abortLine);");
  });
});

// The user-approved body (proposed for <live super-repo clone>/policies/taskBudgetPolicy.json), verbatim.
const APPROVED_BODY = '{"resolvers": {"llm_completion_dispatch": 600000, "scan_vessel_arrivals": 600000}, "reason": "user ruling: slow LLM and arrival-scan tasks get 600 s; every other resolver keeps the 186 s default"}';
describe("the approved taskBudgetPolicy body", () => {
  it("[MUST-FAIL] parses, raises llm_completion_dispatch and scan_vessel_arrivals to 600000 (bare or namespaced), and leaves every other resolver at 186000", async () => {
    const path = policyFile(APPROVED_BODY);
    const logs: string[] = [];
    const read = await readTaskBudgetPolicy(path);
    expect(read.state).toBe("policy");
    for (const r of ["llm_completion_dispatch", "llm-resolver-vessel:llm_completion_dispatch", "scan_vessel_arrivals", "development-vessel:scan_vessel_arrivals"]) {
      const bare = r.slice(r.indexOf(":") + 1);
      const b = await taskBudgetAtUse(undefined, 10_000, { resolver: r, shape: bare }, { path, log: (m) => logs.push(m) });
      expect(b).toEqual({ ms: 600_000, source: `policy:resolver:${bare}` });
    }
    for (const r of ["llm_author_resolver", "development-vessel:goal_reach_tick", "apply_proposal_as_patch", "x:llm_completion_dispatch_v2"]) {
      const b = await taskBudgetAtUse(undefined, 10_000, { resolver: r, shape: r.slice(r.indexOf(":") + 1) }, { path, log: (m) => logs.push(m) });
      expect(b).toEqual({ ms: 186_000, source: "default" });
    }
    expect(logs).toEqual([]);
  });
});
