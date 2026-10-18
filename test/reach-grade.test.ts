// A reach verdict is posted only when it carries information (user ruling 2026-10-17T11:00:25Z, "Honest grading
// first"). Measured before: every one of 212 light-dispatched LLM traces in 24 h was graded reached:false, 141 of them
// successes whose declared output names no resolver emits. MUST-FAIL on the parent (c181f97): reach-grade.ts does not
// exist, and a success that produced none of its declared shapes is posted as reached:false (a beta).
//
// Graded per task, any-of across a task's declared alternatives (user ruling 2026-10-18T04:23:17Z, gap
// light-dispatch-grades-reach-as-every-declared-shape-produced). MUST-FAIL on the parent (410e0f8): the grader takes the
// template's UNION of declared shapes and requires all of them, so a task declaring two alternatives is never met and one
// task's output meets another's declaration; and a resolver answering its declared shape on an error path is graded true.
// The parent's grader has the (status, declaredShapes, producedShapes) signature, so the per-task cases below fail there
// by a TypeError; each comment records what its union all-of computes for the same shapes.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// A namespace import: on the parent the new export is undefined and each test fails by its own name.
import * as RG from "../src/reach-grade";

const SRC = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf8");
type T = { declared: string[]; produced?: string; errored?: boolean };
const grade = (status: "success" | "failure", tasks: T[]) =>
  (RG.informativeReachVerdict as unknown as (s: "success" | "failure", t: T[]) => boolean | null)(status, tasks);
const reportsError = (answer: unknown) => (RG as unknown as { answerReportsError: (a: unknown) => boolean }).answerReportsError(answer);

describe("light-dispatch grades a run only when the verdict carries information", () => {
  test("[MUST-FAIL] a success that produced none of its declared names is UNGRADED (no verdict), never a beta", () => {
    expect(grade("success", [{ declared: ["resolverAuthorDraft", "activityTemplateProposal"], produced: "llmTextCompletion" }, { declared: [], produced: "fileWriteResult" }])).toBeNull();
    expect(grade("success", [{ declared: ["substrateGap"], produced: "llmTextCompletion" }])).toBeNull();
  });
  test("[MUST-FAIL] a success with NO declared outputs is ungraded too", () => {
    expect(grade("success", [{ declared: [], produced: "llmTextCompletion" }])).toBeNull();
  });
  test("[CONTROL] a task failure is a real failure (beta), whatever was declared or produced", () => {
    expect(grade("failure", [{ declared: ["a"], produced: "a" }])).toBe(false);
    expect(grade("failure", [])).toBe(false);
    // a genuine failure in a multi-task run is still a beta, even with the other task met
    expect(grade("failure", [{ declared: ["mitosisStaged", "structuredError"], produced: "mitosisStaged" }, { declared: ["conceptUsageRecorded"] }])).toBe(false);
  });
  test("[CONTROL] every declared output produced, on a clean single-task answer, is reached (alpha), as before", () => {
    const clean = { shape: "commandResult", body: { exitCode: 0, stdout: "ok", stderr: "", error: null, errors: [] } };
    expect(reportsError(clean)).toBe(false);
    expect(reportsError({ shape: "conceptUsageRecorded", body: { skipped: true, recorded: false, reason: "no-op" } })).toBe(false);
    expect(grade("success", [{ declared: ["commandResult"], produced: "commandResult", errored: reportsError(clean) }])).toBe(true);
  });
});

describe("light-dispatch grades each task against its own declared alternatives", () => {
  test("[MUST-FAIL] a 2-task run: A produced one of its two alternatives and B its declared shape -> reached:true", () => {
    // parent union all-of: {mitosisStaged, structuredError, conceptUsageRecorded} is never all produced -> null (ungraded)
    expect(grade("success", [
      { declared: ["mitosisStaged", "structuredError"], produced: "mitosisStaged" },
      { declared: ["conceptUsageRecorded"], produced: "conceptUsageRecorded" },
    ])).toBe(true);
    // a one-task template declaring two alternatives (the parent could never meet it either)
    expect(grade("success", [{ declared: ["substrateGap", "gateSaturationReport"], produced: "gateSaturationReport" }])).toBe(true);
  });
  test("[MUST-FAIL] a 2-task run where one task produced none of its alternatives is NOT reached", () => {
    // parent union all-of: {x, y} is all produced (A's y, B's x) -> true, crediting A with B's output
    const v = grade("success", [{ declared: ["x"], produced: "y" }, { declared: ["x", "y"], produced: "x" }]);
    expect(v).not.toBe(true);
    expect(v).toBeNull(); // a success with an unmet declared name stays ungraded (e6a0a80), not a beta
  });
  test("[MUST-FAIL] a single-task resolver that errored but returned its declared shape -> null (no verdict)", () => {
    // what git_commit answers on a failed commit, and llm-resolver on a failed completion
    const failedCommit = { shape: "commandResult", body: { exitCode: 1, stdout: "", stderr: "fatal: nothing to commit" } };
    const failedCompletion = { resolved: false, shape: "llmCompletion", error: "all providers failed" };
    expect(reportsError(failedCommit)).toBe(true);
    expect(reportsError(failedCompletion)).toBe(true);
    expect(reportsError({ shape: "x", body: { failure_mode: "upstream_down" } })).toBe(true);
    expect(reportsError({ shape: "x", error: "boom", body: { ok: 1 } })).toBe(true);
    // parent union all-of: {commandResult} produced -> true
    expect(grade("success", [{ declared: ["commandResult"], produced: "commandResult", errored: reportsError(failedCommit) }])).toBeNull();
    expect(grade("success", [{ declared: ["llmCompletion"], produced: "llmCompletion", errored: reportsError(failedCompletion) }])).toBeNull();
  });
  test("[WIRING] the grader is the one definition, per task, and NO verdict is posted when it says null", () => {
    expect(SRC).toContain("const reachVerdict = informativeReachVerdict(overallStatus, gradedTasks);");
    expect(SRC).toContain("if (reachVerdict !== null) try {");
    expect(SRC).toContain("produced: r?.status === \"success\" ? r.shape : undefined,");
    expect(SRC).toContain("if (parsed && typeof parsed === \"object\" && answerReportsError(parsed)) return { ...answerOutcome(parsed as Record<string, unknown>), errored: true };");
    expect(SRC).not.toMatch(/const reachVerdict = overallStatus === "success" && declaredShapes\.length > 0/);
    expect(SRC).not.toMatch(/informativeReachVerdict\(overallStatus, declaredShapes, producedShapes\)/);
  });
});
