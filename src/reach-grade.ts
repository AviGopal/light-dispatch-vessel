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
 *
 * GRADED PER TASK, ANY-OF ACROSS A TASK'S ALTERNATIVES (user ruling 2026-10-18T04:23:17Z, gap
 * light-dispatch-grades-reach-as-every-declared-shape-produced). A task's `outputShapes` are ALTERNATIVES — a resolver
 * answers one shape (["mitosisStaged", "structuredError"], ["substrateGap", "<x>Report"]). An all-of over the template's
 * union of them could never be met by a one-task template that declares two, and across tasks it credited one task with
 * another's output. A task that declares outputs is met when the one shape it produced is one of them; the run is true
 * only when every such task is met.
 *
 * A DECLARED SHAPE ON AN ERROR PATH IS NOT EVIDENCE. Some resolvers answer their declared shape on every path, errors
 * included (a commandResult with a nonzero exitCode, an answer saying resolved:false). The signal is the run's own
 * answer, not a name list: when the resolver said it did not work and still returned a shape, the shape match is shown,
 * for this run, to carry no information about success, so that task is unjudgeable and the run is null. Null withholds
 * a verdict, so a marker that fires on a clean answer costs a grading, never a wrong beta.
 */
export interface GradedTask {
  /** the task's declared output shapes: alternatives, any one of which meets it. Empty → the task is not judged. */
  declared: readonly string[];
  /** the one shape the task's resolver answered, when it succeeded. */
  produced?: string;
  /** the resolver's answer reported an error while it still returned a shape (answerReportsError). */
  errored?: boolean;
}

export function informativeReachVerdict(overallStatus: "success" | "failure", tasks: readonly GradedTask[]): boolean | null {
  if (overallStatus === "failure") return false;
  const judged = tasks.filter((t) => t.declared.length > 0);
  if (judged.length === 0) return null;
  if (judged.every((t) => !t.errored && t.produced !== undefined && t.declared.includes(t.produced))) return true;
  return null;
}

/**
 * The answer reports an error in a field the resolver wrote itself: resolved:false, success:false, a non-empty `error`,
 * a `failure_mode`, or a nonzero `exitCode`/`exit_code` — on the answer or its `body`. `skipped: true` is a no-op, not an
 * error, and is not a marker.
 */
export function answerReportsError(answer: unknown): boolean {
  if (!answer || typeof answer !== "object") return false;
  const a = answer as Record<string, unknown>;
  if (a["resolved"] === false) return true;
  const levels = [a, a["body"]].filter((l): l is Record<string, unknown> => !!l && typeof l === "object");
  return levels.some((l) =>
    l["success"] === false ||
    (typeof l["error"] === "string" && l["error"].length > 0) ||
    (l["failure_mode"] !== undefined && l["failure_mode"] !== null) ||
    (typeof l["exitCode"] === "number" && l["exitCode"] !== 0) ||
    (typeof l["exit_code"] === "number" && l["exit_code"] !== 0));
}
