// MUST-FAIL on a3aeedca, which failed a resolved:false answer whenever its body is null, ahead of the gate below.
// src/failure-type.ts states the contract in its header: a budget refusal (resolved:false with
// dispatch_budget_exhausted:true) fails, and "Any OTHER resolved:false answer is still a success, unchanged."
// answerOutcome repeats it at the rule: broadening is gated on a measured count of resolved:false answers
// (/health resolved_false_answers; gap any-resolved-false-answer-counts-as-task-success-in-light-dispatch).
// Until that count admits a broader rule, a plain resolved:false answer, null body or not, is not a failure.
// A fix that broadens the rule once the count admits it updates this test with it.
import { expect, test } from "bun:test";
import { answerOutcome } from "../src/failure-type";

test("resolved:false is not a failure until the measured broadening gate admits it", () => {
  const outcome = answerOutcome({ resolved: false, body: null });
  expect(outcome.ok).toBe(true);
  expect(outcome.resolvedFalse).toBe(true);
});
