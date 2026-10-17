// A reach verdict is posted only when it carries information (user ruling 2026-10-17T11:00:25Z, "Honest grading
// first"). Measured before: every one of 212 light-dispatched LLM traces in 24 h was graded reached:false, 141 of them
// successes whose declared output names no resolver emits. MUST-FAIL on the parent (c181f97): reach-grade.ts does not
// exist, and a success that produced none of its declared shapes is posted as reached:false (a beta).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { informativeReachVerdict } from "../src/reach-grade";

const SRC = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf8");

describe("light-dispatch grades a run only when the verdict carries information", () => {
  test("[MUST-FAIL] a success that produced none of its declared names is UNGRADED (no verdict), never a beta", () => {
    expect(informativeReachVerdict("success", ["resolverAuthorDraft", "activityTemplateProposal"], new Set(["llmTextCompletion", "fileWriteResult"]))).toBeNull();
    expect(informativeReachVerdict("success", ["substrateGap"], new Set(["llmTextCompletion"]))).toBeNull();
  });
  test("[MUST-FAIL] a success with NO declared outputs is ungraded too", () => {
    expect(informativeReachVerdict("success", [], new Set(["llmTextCompletion"]))).toBeNull();
  });
  test("[CONTROL] a task failure is a real failure (beta), whatever was declared or produced", () => {
    expect(informativeReachVerdict("failure", ["a"], new Set(["a"]))).toBe(false);
    expect(informativeReachVerdict("failure", [], new Set())).toBe(false);
  });
  test("[CONTROL] every declared output produced is reached (alpha), as before", () => {
    expect(informativeReachVerdict("success", ["a", "b"], new Set(["a", "b", "c"]))).toBe(true);
  });
  test("[WIRING] the grader is the one definition, and NO verdict is posted when it says null", () => {
    expect(SRC).toContain("const reachVerdict = informativeReachVerdict(overallStatus, declaredShapes, producedShapes);");
    expect(SRC).toContain("if (reachVerdict !== null) try {");
    expect(SRC).not.toMatch(/const reachVerdict = overallStatus === "success" && declaredShapes\.length > 0/);
  });
});
