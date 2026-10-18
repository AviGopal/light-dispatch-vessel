// A budget refusal is a failed task typed budget_exhausted from its structured field (gaps
// a-budget-refusal-is-graded-cascading-so-it-moves-no-posterior-and-budget-exhausted-is-never-assigned and
// light-dispatch-records-an-llm-resolver-budget-refusal-as-a-successful-task). development-
// vessel's llm_completion_dispatch refuses an over-allowance task with a structuredError whose body says
// failure_mode:"dispatch_budget_exhausted"; its detail says "refused", which the prose regex does not match, so the run
// was typed cascading ({0,0} in activity-api's computeDeltas) and the budget_exhausted class was never assigned.
// llm-resolver's own refusal is { resolved:false, shape:"llmCompletion", dispatch_budget_exhausted:true }, which
// resolveTask read as a SUCCESS (only success=false and a structuredError failed a task).
// MUST-FAIL on the parent (369df5d): src/failure-type.ts does not exist, resolveTask passes that refusal as ok, and
// index.ts types the run by the regex alone. Every OTHER resolved:false answer stays a success exactly as at the parent;
// /health resolved_false_answers counts them (by resolver) as the baseline for any broadening.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { __resetResolvedFalseForTests, answerOutcome, budgetRefusalOf, countResolvedFalse, dispatchFailureType, resolvedFalseSummary } from "../src/failure-type";

const SRC = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf8");

// The prose llm-resolver puts on its refusal (dispatch-budget.ts), carried through as the structuredError detail.
const REFUSED_DETAIL =
  "dispatch input-token budget spent: the input tokens this dispatch has already sent across its turns and calls, plus " +
  "this request, would exceed its 400000-token allowance (llmModelPolicy.max_input_tokens_per_dispatch); refused before " +
  "the provider call, no fallback";
// What development-vessel's llm_completion_dispatch answers (llm-completion-dispatch.ts budgetRefusalOf).
const LLM_BUDGET_REFUSAL = {
  shape: "structuredError",
  body: {
    resolver: "llm_completion_dispatch",
    detail: REFUSED_DETAIL,
    failure_mode: "dispatch_budget_exhausted",
    dispatch_budget: { dispatch_id: "d-1", used_input_tokens: 399_000, estimate_input_tokens: 2_000, cap_input_tokens: 400_000 },
  },
};
// What llm-resolver answers when called directly (dispatch-budget.ts dispatchBudgetRefusal).
const RESOLVER_BUDGET_REFUSAL = {
  resolved: false, shape: "llmCompletion", dispatch_budget_exhausted: true,
  dispatch_budget: { dispatch_id: "d-1", used_input_tokens: 399_000, estimate_input_tokens: 2_000, cap_input_tokens: 400_000, policy_field: "llmModelPolicy.max_input_tokens_per_dispatch" },
  error: REFUSED_DETAIL,
};
// resolveTask's handling of a parsed JSON answer at the parent (369df5d src/index.ts), verbatim, for equality controls.
const parentOutcome = (p: Record<string, unknown>) => {
  if (p["success"] === false) {
    return { ok: false, error: typeof p["error"] === "string" ? p["error"] : "resolver returned success=false" };
  }
  const shape = typeof p["shape"] === "string" ? p["shape"] : undefined;
  if (shape === "structuredError") {
    const detail = (p["body"] as Record<string, unknown> | undefined)?.["detail"] ?? "structuredError";
    return { ok: false, shape, error: String(detail).slice(0, 200) };
  }
  return { ok: true, body: p["body"] ?? p, shape };
};
const typeOf = (answer: unknown, reason: string) => dispatchFailureType(reason, budgetRefusalOf(answer));
/** The trace type of a run whose only task got this answer, as runDispatch computes it. */
const runTypeOf = (answer: Record<string, unknown>) => {
  const o = answerOutcome(answer);
  return o.ok ? null : dispatchFailureType(String(o.error ?? "unknown dispatch failure"), o.refusal);
};

describe("a budget refusal is typed by its structured field, never its prose", () => {
  test("[MUST-FAIL] an LLM task refused for its dispatch budget is budget_exhausted (was cascading)", () => {
    expect(budgetRefusalOf(LLM_BUDGET_REFUSAL)).toBe("budget_exhausted");
    expect(typeOf(LLM_BUDGET_REFUSAL, REFUSED_DETAIL)).toBe("budget_exhausted");
    // The same prose with no structured verdict is cascading: the text alone cannot carry it.
    expect(dispatchFailureType(REFUSED_DETAIL, undefined)).toBe("cascading");
  });

  test("[MUST-FAIL] a spend-envelope refusal (reason budget_exhausted) is budget_exhausted", () => {
    const envelope = { shape: "structuredError", body: { resolver: "apply_proposal_as_patch", detail: "spend envelope: exhausted", reason: "budget_exhausted" } };
    expect(typeOf(envelope, "spend envelope: exhausted")).toBe("budget_exhausted");
  });

  test("[MUST-FAIL] the structured field wins over prose the regex would read as a verifier failure", () => {
    expect(typeOf(LLM_BUDGET_REFUSAL, "budget refusal rejected the call")).toBe("budget_exhausted");
  });

  test("[MUST-FAIL] llm-resolver's own budget refusal is a FAILED task typed budget_exhausted (was a success)", () => {
    const o = answerOutcome(RESOLVER_BUDGET_REFUSAL);
    expect(o.ok).toBe(false);
    expect(o.refusal).toBe("budget_exhausted");
    expect(o.shape).toBe("llmCompletion");
    expect(o.error).toStartWith("dispatch input-token budget spent");
    expect(runTypeOf(RESOLVER_BUDGET_REFUSAL)).toBe("budget_exhausted");
    expect(parentOutcome(RESOLVER_BUDGET_REFUSAL).ok).toBe(true); // what the parent recorded
  });

  test("[MUST-FAIL] development-vessel's structuredError refusal is failed and budget_exhausted through the same path", () => {
    expect(answerOutcome(LLM_BUDGET_REFUSAL)).toMatchObject({ ok: false, shape: "structuredError", refusal: "budget_exhausted" });
    expect(runTypeOf(LLM_BUDGET_REFUSAL)).toBe("budget_exhausted");
  });

  test("[CONTROL] a normal llmCompletion answer stays a success", () => {
    const answer = { resolved: true, shape: "llmCompletion", body: { text: "ok", model: "m", usage: { input_tokens: 10, output_tokens: 2 } } };
    expect(answerOutcome(answer)).toEqual({ ok: true, body: answer.body, shape: "llmCompletion" });
    const bare = { shape: "llmCompletion", text: "ok" };
    expect(answerOutcome(bare)).toEqual({ ok: true, body: bare, shape: "llmCompletion" });
  });

  test("[CONTROL] resolved:false WITHOUT the budget flag is a success, exactly as on the parent", () => {
    const answers: Array<Record<string, unknown>> = [
      { resolved: false, shape: "llmCompletion", error: "all providers failed" },
      { resolved: false, shape: "llmArmOutcomeWriteResult", error: "body must include model as a string and reached as a boolean" },
      { resolved: false, shape: "x", body: { found: false } },
      { resolved: false },
      { resolved: false, dispatch_budget_exhausted: false, shape: "llmCompletion" },
    ];
    __resetResolvedFalseForTests();
    for (const a of answers) {
      const o = answerOutcome(a);
      const { resolvedFalse, ...outcome } = o;
      expect(resolvedFalse).toBe(true); // observed, and only observed
      expect(outcome).toEqual(parentOutcome(a));
      expect(o.ok).toBe(true);
      expect(runTypeOf(a)).toBeNull();
      countResolvedFalse("dev:some_resolver", o);
    }
    expect(answerOutcome(answers[2]!)).toEqual({ ok: true, body: { found: false }, shape: "x", resolvedFalse: true });
    expect(resolvedFalseSummary()).toEqual({ total: 5, budget_refusals: 0, resolvers: [{ resolver: "dev:some_resolver", count: 5 }] });
  });

  test("[CONTROL] the resolved:false counter counts by resolver, separates budget refusals, and ignores every other answer", () => {
    __resetResolvedFalseForTests();
    countResolvedFalse("llm:llmCompletion", answerOutcome(RESOLVER_BUDGET_REFUSAL));
    countResolvedFalse("a:x", answerOutcome({ resolved: false, shape: "x" }));
    countResolvedFalse("a:x", answerOutcome({ resolved: false, shape: "x" }));
    countResolvedFalse("a:x", answerOutcome({ resolved: true, shape: "x" }));
    countResolvedFalse("a:x", answerOutcome({ shape: "x" }));
    countResolvedFalse("a:x", answerOutcome(LLM_BUDGET_REFUSAL));
    countResolvedFalse("a:x", { ok: false });
    expect(resolvedFalseSummary()).toEqual({
      total: 3, budget_refusals: 1,
      resolvers: [{ resolver: "a:x", count: 2 }, { resolver: "llm:llmCompletion", count: 1 }],
    });
  });

  test("[CONTROL] success=false and a structuredError fail exactly as before", () => {
    expect(answerOutcome({ success: false, error: "boom" })).toEqual({ ok: false, error: "boom" });
    expect(answerOutcome({ success: false })).toEqual({ ok: false, error: "resolver returned success=false" });
    expect(answerOutcome({ shape: "structuredError", body: { detail: "x".repeat(300) } })).toEqual({ ok: false, shape: "structuredError", error: "x".repeat(200) });
    expect(answerOutcome({ shape: "structuredError" })).toEqual({ ok: false, shape: "structuredError", error: "structuredError" });
    for (const a of [{ success: false, error: "boom" }, { shape: "structuredError", body: { detail: "d", failure_mode: "cascading" } }, { resolved: true, shape: "llmCompletion", body: { text: "t" } }]) {
      expect(answerOutcome(a)).toEqual(parentOutcome(a));
    }
  });

  test("[CONTROL] a genuine cascade stays cascading", () => {
    const upstream = { shape: "structuredError", body: { resolver: "llm_completion_dispatch", detail: "all endpoints failed", failure_mode: "cascading" } };
    expect(typeOf(upstream, "all endpoints failed")).toBe("cascading");
    expect(typeOf(undefined, "HTTP 502: bad gateway")).toBe("cascading");
    expect(typeOf(undefined, "fetch failed")).toBe("cascading");
  });

  test("[CONTROL] other failure types are unchanged", () => {
    expect(typeOf(undefined, "convergent_validity[json_artifact]: fs_write reported success but ...")).toBe("verifier_negative");
    expect(typeOf(undefined, "validation[requiredPatterns]: task output missing required pattern(s): x")).toBe("verifier_negative");
    const verifier = { shape: "structuredError", body: { detail: "LLM vessel returned error", failure_mode: "verifier_negative" } };
    expect(typeOf(verifier, "LLM vessel returned error")).toBe("cascading"); // prose rule, exactly as before
    const malformed = { shape: "structuredError", body: { detail: "missing prompt", failure_mode: "malformed_request" } };
    expect(typeOf(malformed, "missing prompt")).toBe("cascading");
  });

  test("[CONTROL] a paused envelope is not exhaustion, and a non-structuredError answer names no refusal", () => {
    expect(budgetRefusalOf({ shape: "structuredError", body: { detail: "spend envelope: paused", reason: "budget_paused" } })).toBeUndefined();
    expect(budgetRefusalOf({ shape: "llmCompletion", body: { failure_mode: "dispatch_budget_exhausted" } })).toBeUndefined();
    expect(budgetRefusalOf(null)).toBeUndefined();
    expect(budgetRefusalOf("structuredError")).toBeUndefined();
  });

  test("[WIRING] resolveTask reads every JSON answer through answerOutcome, and the trace type comes from the one classifier", () => {
    expect(SRC).toContain("if (parsed && typeof parsed === \"object\") return answerOutcome(parsed as Record<string, unknown>);");
    expect(SRC).not.toContain('if (p["success"] === false) {');
    expect(SRC).toContain('const failureType = dispatchFailureType(failureReason, failedTask ? priorResults.get(String(failedTask["id"]))?.refusal : undefined);');
    expect(SRC).not.toContain('? "verifier_negative" : "cascading";');
    expect(SRC).toContain("countResolvedFalse(task.resolver, resolved);");
    expect(SRC).toContain("resolved_false_answers: resolvedFalseSummary(),");
  });
});
