// CONTROL for the gap any-resolved-false-answer-counts-as-task-success-in-light-dispatch. Its check
// (test/checks/, out of suite) asserts only that one resolved:false answer fails, so a change that fails every
// answer, or only the one input the check builds, would also pass it. This holds the other side in the suite:
// a resolved:true answer stays a success and keeps its body. Green at the parent and with any correct fix.
import { expect, test } from "bun:test";
import { answerOutcome } from "../src/failure-type";

test("control: a resolved:true answer stays a success and keeps its body", () => {
  const outcome = answerOutcome({ resolved: true, body: { answer: 42 } });
  expect(outcome.ok).toBe(true);
  expect(outcome.body).toEqual({ answer: 42 });
});
