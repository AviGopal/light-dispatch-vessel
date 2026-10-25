import { test, expect } from 'bun:test';
import * as mod from "../../src/failure-type";

test("any resolved:false answer counts as task success", () => {
  // A resolved:false answer that is not a budget refusal should be a failure.
  const sample = { resolved: false, body: null };
  const outcome = mod.answerOutcome(sample);
  // The defect is that outcome.ok is true, but we expect false.
  expect(outcome.ok).toBe(false);
});