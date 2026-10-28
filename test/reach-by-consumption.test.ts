// A TICK THAT FILES GAPS IS NOT REACHED BECAUSE IT RAN (findings agf_hrgaf1yd89kr / agf_zuaa6xsh4b28, "detectors scored by
// consumption"; step (1)). A detector tick (a template declaring substrateGap among its outputs) was graded reached on
// ~every successful run, so its posterior said "it ran" and every row was retention-protected as graded evidence. Its
// successful run now posts no verdict; development-vessel's gap outcome credit grades the producer from what its gaps led to.
// MUST-FAIL on the parent: reachDecidedByConsumption does not exist and the run-end verdict is posted for every template.
// Fixture words from a 5-word draw (draw-words.sh 2026-10-27T06:13:54Z: charred fruit january ambush frigidly).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { informativeReachVerdict, reachDecidedByConsumption } from "../src/reach-grade";

const SRC = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf8");
/** The run-end verdict exactly as the dispatch loop computes it. */
const runEndVerdict = (status: "success" | "failure", templateOutputs: string[], tasks: Parameters<typeof informativeReachVerdict>[1]) =>
  status === "success" && reachDecidedByConsumption(templateOutputs) ? null : informativeReachVerdict(status, tasks);

const DETECTOR_OUTPUTS = ["charredFruitReport", "substrateGap"];
const producedAll = [{ declared: ["charredFruitReport"], produced: "charredFruitReport" }];

describe("a gap-filing tick is graded by what its gaps led to, not because it ran", () => {
  test("[MUST-FAIL] a successful detector tick that produced everything it declared posts NO reached verdict", () => {
    expect(reachDecidedByConsumption(DETECTOR_OUTPUTS)).toBe(true);
    // Before: informativeReachVerdict alone says true here, and alpha followed for running.
    expect(informativeReachVerdict("success", producedAll)).toBe(true);
    expect(runEndVerdict("success", DETECTOR_OUTPUTS, producedAll)).toBeNull();
  });

  test("[MUST-FAIL] the dispatch loop asks the template's declared outputs before posting the run-end verdict", () => {
    expect(SRC).toContain("const reachByConsumption = reachDecidedByConsumption(tpl.output_shapes);");
    expect(SRC).toContain('if (reachVerdict !== null && overallStatus === "success" && reachByConsumption) console.log(');
    expect(SRC).toContain("else if (reachVerdict !== null) try {");
    expect(SRC).toContain('...(reachByConsumption && overallStatus === "success" ? { reach_decided_by: "consumption" } : {}),');
  });

  test("[CONTROL] a failed detector tick is still graded false (a crash is its own failure)", () => {
    expect(runEndVerdict("failure", DETECTOR_OUTPUTS, producedAll)).toBe(false);
  });

  test("[CONTROL] a template that files no gaps is graded at run end exactly as before", () => {
    const outs = ["januaryAmbushReport"];
    expect(reachDecidedByConsumption(outs)).toBe(false);
    expect(runEndVerdict("success", outs, [{ declared: ["januaryAmbushReport"], produced: "januaryAmbushReport" }])).toBe(true);
    expect(runEndVerdict("failure", outs, [])).toBe(false);
    expect(runEndVerdict("success", outs, [{ declared: ["januaryAmbushReport"], produced: "frigidlyOther" }])).toBeNull();
  });

  test("[CONTROL] no declared outputs (an older template row) is not a detector", () => {
    expect(reachDecidedByConsumption(undefined)).toBe(false);
    expect(reachDecidedByConsumption([])).toBe(false);
  });
});
