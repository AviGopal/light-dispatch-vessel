/**
 * A BUDGET REFUSAL IS A FAILED TASK TYPED BY ITS STRUCTURED FIELD, NOT ITS PROSE (gaps
 * a-budget-refusal-is-graded-cascading-so-it-moves-no-posterior-and-budget-exhausted-is-never-assigned and
 * light-dispatch-records-an-llm-resolver-budget-refusal-as-a-successful-task).
 *
 * light-dispatch typed a failed run by a regex over the failed task's error text. The budget refusals say "refused" /
 * "spend envelope", which the regex does not match, so they were typed `cascading` — activity-api's computeDeltas maps
 * that to {0,0}, and its `budget_exhausted` class (half a beta) was assigned by no producer. A refusal names itself:
 *   - llm-resolver: `{ resolved: false, dispatch_budget_exhausted: true }` (the dispatch's input-token allowance is
 *     spent). An answer with resolved:false was read as a SUCCESS, so this refusal was a successful task; it now fails.
 *     Any OTHER resolved:false answer is still a success, unchanged.
 *   - development-vessel llm_completion_dispatch: a structuredError with `failure_mode: "dispatch_budget_exhausted"`
 *   - development-vessel apply_proposal_as_patch: a structuredError with `reason: "budget_exhausted"` (the fleet spend
 *     envelope is exhausted)
 * Only those values map; a paused envelope (`budget_paused`) is not exhaustion, and every other `failure_mode` a
 * structuredError carries is left to the prose rule exactly as before.
 */
export type DispatchFailureType = "budget_exhausted" | "verifier_negative" | "cascading";

/** "budget_exhausted" when a resolver's answer is a budget refusal, else undefined. */
export function budgetRefusalOf(answer: unknown): "budget_exhausted" | undefined {
  if (!answer || typeof answer !== "object") return undefined;
  const a = answer as Record<string, unknown>;
  if (a["dispatch_budget_exhausted"] === true) return "budget_exhausted";
  if (a["shape"] !== "structuredError") return undefined;
  const body = a["body"];
  if (!body || typeof body !== "object") return undefined;
  const b = body as Record<string, unknown>;
  return b["failure_mode"] === "dispatch_budget_exhausted" || b["reason"] === "budget_exhausted" ? "budget_exhausted" : undefined;
}

/** `resolvedFalse`: the answer said resolved:false (observation only; counted by countResolvedFalse, changes nothing). */
export type AnswerOutcome = { ok: boolean; body?: unknown; shape?: string; error?: string; refusal?: "budget_exhausted"; resolvedFalse?: true };

/** One task's outcome from its resolver's JSON answer: success=false, a structuredError and a budget refusal fail. */
export function answerOutcome(p: Record<string, unknown>): AnswerOutcome {
  const refusal = budgetRefusalOf(p);
  const r = { ...(refusal ? { refusal } : {}), ...(p["resolved"] === false ? { resolvedFalse: true as const } : {}) };
  if (p["success"] === false) {
    return { ok: false, error: typeof p["error"] === "string" ? p["error"] : "resolver returned success=false", ...r };
  }
  const shape = typeof p["shape"] === "string" ? p["shape"] : undefined;
  if (shape === "structuredError") {
    const detail = (p["body"] as Record<string, unknown> | undefined)?.["detail"] ?? "structuredError";
    return { ok: false, shape, error: String(detail).slice(0, 200), ...r };
  }
  // Only llm-resolver's budget refusal fails here. Every other resolved:false answer stays a success exactly as before:
  // broadening is gated on a measured count of them (/health resolved_false_answers; gap
  // any-resolved-false-answer-counts-as-task-success-in-light-dispatch).
  if (p["resolved"] === false && p["dispatch_budget_exhausted"] === true) {
    return { ok: false, shape, error: (typeof p["error"] === "string" ? p["error"] : "dispatch budget exhausted").slice(0, 200), ...r };
  }
  return { ok: true, body: p["body"] ?? p, shape, ...r };
}

const resolvedFalse = { total: 0, budgetRefusals: 0, byResolver: new Map<string, number>() };
/** Count one task whose resolver answered resolved:false, by resolver_id (the baseline for broadening the failure rule). */
export function countResolvedFalse(resolver: string, outcome: { resolvedFalse?: true; refusal?: "budget_exhausted" }): void {
  if (!outcome.resolvedFalse) return;
  resolvedFalse.total++;
  if (outcome.refusal) resolvedFalse.budgetRefusals++;
  resolvedFalse.byResolver.set(resolver, (resolvedFalse.byResolver.get(resolver) ?? 0) + 1);
}
/** resolved:false answers since start, how many were budget refusals (failed), and the resolvers by count. */
export function resolvedFalseSummary(): { total: number; budget_refusals: number; resolvers: Array<{ resolver: string; count: number }> } {
  const resolvers = [...resolvedFalse.byResolver].map(([resolver, count]) => ({ resolver, count })).sort((a, b) => b.count - a.count).slice(0, 25);
  return { total: resolvedFalse.total, budget_refusals: resolvedFalse.budgetRefusals, resolvers };
}
/** Test seam: forget the counts. */
export function __resetResolvedFalseForTests(): void { resolvedFalse.total = 0; resolvedFalse.budgetRefusals = 0; resolvedFalse.byResolver.clear(); }

/** The trace's failure_mode.type: a structured budget refusal first, else today's rule over the error text. */
export function dispatchFailureType(reason: string, refusal: "budget_exhausted" | undefined): DispatchFailureType {
  if (refusal === "budget_exhausted") return "budget_exhausted";
  return /convergent_validity|structuredError|validation|verifier|rejected/i.test(reason) ? "verifier_negative" : "cascading";
}
