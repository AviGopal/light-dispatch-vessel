// THE ABORT BUDGET: a slow task is aborted ONCE at its own budget and never re-sent; only a request
// that provably never reached the resolver (a connect error, by code) is retried. Measured before
// this: a fixed 60 s abort whatever the resolver advertised, and a message regex that matched
// "aborted"/"timed out", so a slow llm_completion_dispatch was re-sent up to three times, while Bun's
// connection-refused error (code ConnectionRefused) matched nothing and was never retried.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { errorCode, isConnectError, resolveWithConnectRetry, taskBudgetMs, taskSignal, TASK_BUDGET_FLOOR_MS } from "../src/task-budget.js";

const noSleep = async () => {};
const deadPort = async (): Promise<number> => { const s = Bun.serve({ port: 0, fetch: () => new Response("x") }); const p = s.port!; s.stop(true); return p; };
async function fetchOutcome(url: string, signal: AbortSignal) {
  // Bun.fetch, not the global: another test file in the same process may replace globalThis.fetch and never restore it
  // (measured: retire-sweep-auth.test.ts), and this must be Bun's REAL error.
  try { const r = await Bun.fetch(url, { method: "POST", body: "{}", signal }); await r.text(); return { ok: r.ok }; }
  catch (err) { const code = errorCode(err); return { ok: false, error: (err as Error).message, ...(code ? { code } : {}) }; }
}

describe("taskBudgetMs: the task's timeout_ms, else the advertised resolve_timeout_ms, floor = the old 186 s envelope", () => {
  it("[MUST-FAIL] a resolver advertising 300 s gets 300 s (was a fixed 60 s per attempt)", () => {
    expect(taskBudgetMs(undefined, 300_000)).toBe(300_000);
  });
  it("[MUST-KEEP] nothing is cut sooner than the old retry envelope (3 x 60 s + 2 s + 4 s): a task that used to succeed on attempt 3 still fits", () => {
    expect(TASK_BUDGET_FLOOR_MS).toBe(186_000);
    expect(taskBudgetMs(undefined, 180_000)).toBe(186_000);
  });
  it("[MUST-FAIL] a template's own timeout_ms wins, below or above the advertised one", () => {
    expect(taskBudgetMs(300_000, 60_000)).toBe(300_000);
    expect(taskBudgetMs(20_000, 180_000)).toBe(20_000);
  });
  it("[CONTROL] nothing stated, or an advertisement under the floor (a blanket 10 s), is the old envelope", () => {
    expect(taskBudgetMs(undefined, undefined)).toBe(TASK_BUDGET_FLOOR_MS);
    expect(taskBudgetMs(undefined, 10_000)).toBe(TASK_BUDGET_FLOOR_MS);
    expect(taskBudgetMs(0, "x")).toBe(TASK_BUDGET_FLOOR_MS);
  });
});

describe("the retry rule: by error code, connect errors only", () => {
  it("[MUST-FAIL] a task aborted at its budget is attempted ONCE (the old regex re-sent it on 'aborted')", async () => {
    const srv = Bun.serve({ port: 0, async fetch() { await Bun.sleep(1500); return new Response("{}"); } });
    let sent = 0;
    try {
      const { last, attempts } = await resolveWithConnectRetry(() => { sent++; return fetchOutcome(`http://127.0.0.1:${srv.port}/`, taskSignal(300)); }, { sleep: noSleep });
      expect(last.ok).toBe(false);
      expect(isConnectError(last.code)).toBe(false);
      expect(sent).toBe(1);
      expect(attempts.length).toBe(1);
    } finally { srv.stop(true); }
  });

  it("[MUST-FAIL] a refused connection (Bun's real error, code ConnectionRefused) is retried, every attempt recorded", async () => {
    const port = await deadPort();
    const { last, attempts } = await resolveWithConnectRetry(() => fetchOutcome(`http://127.0.0.1:${port}/`, taskSignal(5_000)), { sleep: noSleep });
    expect(isConnectError(last.code)).toBe(true);
    expect(attempts.map((a) => a.n)).toEqual([1, 2, 3]);
    expect(attempts.every((a) => a.ok === false && isConnectError(a.code))).toBe(true);
    // each attempt carries its own start time, so a retry's duplicate request is countable from the trace alone
    const starts = attempts.map((a) => Date.parse(a.started_at));
    expect(starts.every((t) => Number.isFinite(t))).toBe(true);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
  });

  it("[CONTROL] a refused connection that recovers succeeds on the next attempt", async () => {
    let n = 0;
    const { last, attempts } = await resolveWithConnectRetry(async () => (++n === 1 ? { ok: false, error: "Unable to connect", code: "ConnectionRefused" } : { ok: true }), { sleep: noSleep });
    expect(last.ok).toBe(true);
    expect(attempts.length).toBe(2);
  });

  it("[HELD-OUT] an HTTP error or a resolver's own failure is not retried; neither is a reset mid-request", async () => {
    for (const o of [{ ok: false, error: "HTTP 500: boom" }, { ok: false, error: "resolver returned success=false" }, { ok: false, error: "socket closed", code: "ECONNRESET" }]) {
      let n = 0;
      const { attempts } = await resolveWithConnectRetry(async () => { n++; return o; }, { sleep: noSleep });
      expect(n).toBe(1);
      expect(attempts.length).toBe(1);
    }
  });

  it("[MUST-FAIL] the caller's signal aborts the task and stops the retry", async () => {
    const srv = Bun.serve({ port: 0, async fetch() { await Bun.sleep(3000); return new Response("{}"); } });
    const outer = new AbortController();
    try {
      setTimeout(() => outer.abort(), 200);
      const t0 = Date.now();
      const { last, attempts } = await resolveWithConnectRetry(() => fetchOutcome(`http://127.0.0.1:${srv.port}/`, taskSignal(60_000, outer.signal)), { sleep: noSleep, signal: outer.signal });
      expect(last.ok).toBe(false);
      expect(Date.now() - t0).toBeLessThan(2500);
      expect(attempts.length).toBe(1);
    } finally { srv.stop(true); }
  });
});

describe("[WIRING] index.ts uses the budget, the code rule, the caller's signal, and records attempts", () => {
  const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  it("no message regex decides a retry; the fixed 60 s resolve abort is gone", () => {
    expect(src).not.toContain("TRANSIENT_ERROR_RE");
    expect(src).not.toContain("setTimeout(() => ctrl.abort(), 60_000)");
  });
  it("the budget comes from the task and the advertised timeout; the caller's connection does NOT cancel the dispatch", () => {
    expect(src).toContain("const budgetMs = taskBudgetMs(task.timeout_ms, advertisedTimeoutMs.get(endpoint));");
    expect(src).toContain("if (typeof vessel.resolve_timeout_ms === \"number\") advertisedTimeoutMs.set(full, vessel.resolve_timeout_ms);");
    // HELD-OUT: a fire-and-forget caller (dispatch-latest-auto-draft: 30 s client timeout) still gets its trace landed.
    expect(src).not.toContain("req.signal");
    expect(src).toContain("await resolveTaskWithRetry(endpoint, pointerType, config, budgetMs);");
  });
  it("the trace carries attempts, the budget and llm_requests; LLM configs carry the execution id", () => {
    expect(src).toContain("budget_ms: budgetMs,\n      attempts,");
    expect(src).toContain("llm_requests: llmRequests,");
    expect(src).toContain('if (pointerType === "llm_completion_dispatch" && config["execution_id"] === undefined) config["execution_id"] = executionId;');
  });
});
