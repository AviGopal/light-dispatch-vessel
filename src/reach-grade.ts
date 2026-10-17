/**
 * A REACH VERDICT IS POSTED ONLY WHEN IT CARRIES INFORMATION (user ruling 2026-10-17T11:00:25Z, "Honest grading first";
 * gap templates-declare-output-shape-names-no-resolver-emits-so-light-dispatch-grades-every-llm-success-not-reached).
 *
 * light-dispatch used to post reached = success && every declared output shape produced. A template's declared names come
 * from a template-semantic vocabulary and the produced names are what resolvers emit, so they almost never match: on
 * node1 all 212 light-dispatched traces with an LLM task in 24 h (141 of them successes) were graded reached:false, a
 * beta carrying no information. Now:
 *   - a task FAILED                                  -> false (a real failure: beta)
 *   - every declared output shape was produced       -> true  (unchanged)
 *   - otherwise (a success that cannot be judged)    -> null: NO verdict is posted, so the trace stays ungraded, the same
 *     definition activity-api's classifyReach already gives a success with no reach tag.
 */
export function informativeReachVerdict(overallStatus: "success" | "failure", declaredShapes: readonly string[], producedShapes: ReadonlySet<string>): boolean | null {
  if (overallStatus === "failure") return false;
  if (declaredShapes.length > 0 && declaredShapes.every((s) => producedShapes.has(s))) return true;
  return null;
}
