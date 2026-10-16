/**
 * THE PER-TASK ABORT BUDGET AND THE RETRY RULE (light-dispatch abort-budget fix).
 *
 * Measured: every resolve was aborted at a fixed 60 s whatever the resolver advertised, and the
 * retry matched the error MESSAGE against /aborted|timed out|.../, so a slow LLM task that hit the
 * budget was aborted and RE-SENT up to three times (three paid requests, one trace row), while
 * Bun's connection-refused error (code "ConnectionRefused", message "Unable to connect...") matched
 * nothing and was never retried.
 *
 * The rule here:
 *   - budget: the task's own timeout_ms when the template states one; else the resolver's advertised
 *     resolve_timeout_ms (discovery echoes it), never below the OLD RETRY ENVELOPE (3 x 60 s + 2 s + 4 s backoff =
 *     186 s). Measured before this fix: 66 tasks a day (llm_author_resolver, vessel_arrival_scan, goal_reach_tick,
 *     apply_proposal_as_patch) succeeded only on attempt 2 or 3, i.e. inside that envelope; a single 60 s attempt
 *     would turn every one of them into a failure. Nothing that finished within the old envelope is cut sooner; what
 *     changes is that the slow task runs ONCE instead of being re-sent. Development-vessel advertises one blanket 10 s
 *     for every shape (its own gap), so the floor carries until per-shape budgets are advertised;
 *   - retry ONLY when the request provably never reached the resolver: a connect error, by CODE.
 *     An abort or a timeout is not retried (the work may be running and costing on the other side);
 *   - an optional outer signal composes with the budget (taskSignal); the /dispatch route does NOT pass the caller's
 *     connection, because fire-and-forget callers stop waiting on purpose and expect the dispatch to land its trace;
 *   - every attempt is recorded, so the trace shows how many requests a task really made.
 */

/**
 * The old retry envelope (three 60 s attempts with 2 s and 4 s backoff), so no task is cut sooner than before.
 * NAMED DEBT (G1: an in-process constant, accepted only because it PRESERVES old behaviour; it is not tuned). While it
 * stands, max(advertised, floor) means a shaped advertisement can only RAISE a budget, never lower it. LIFT CONDITION:
 * development-vessel advertises per-shape resolve_timeout_ms (gap dv-advertises-one-10s-resolve-timeout-for-every-shape);
 * then the advertised budget is used as-is and this floor is removed.
 */
export const TASK_BUDGET_FLOOR_MS = 3 * 60_000 + 2_000 + 4_000;

const positive = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;

/** The abort budget for one task: the task's timeout_ms, else max(advertised, the old envelope). */
export function taskBudgetMs(taskTimeoutMs: unknown, advertisedMs: unknown): number {
  return positive(taskTimeoutMs) ?? Math.max(positive(advertisedMs) ?? 0, TASK_BUDGET_FLOOR_MS);
}

/** The error's code (Node: err.code; Bun fetch: err.code; wrapped: err.cause.code), else its name. */
export function errorCode(err: unknown): string | undefined {
  if (!err || typeof err !== "object") return undefined;
  const e = err as { code?: unknown; name?: unknown; cause?: { code?: unknown } };
  if (typeof e.code === "string" && e.code) return e.code;
  if (e.cause && typeof e.cause.code === "string" && e.cause.code) return e.cause.code;
  return typeof e.name === "string" && e.name && e.name !== "Error" ? e.name : undefined;
}

/** Codes meaning the connection was never established, so the request never reached the resolver. */
const CONNECT_ERROR_CODES = new Set(["ECONNREFUSED", "ConnectionRefused", "FailedToOpenSocket"]);
export const isConnectError = (code: string | undefined): boolean => !!code && CONNECT_ERROR_CODES.has(code);

/** One task's abort signal: its budget, and the caller's signal when there is one. */
export function taskSignal(budgetMs: number, outer?: AbortSignal): AbortSignal {
  const t = AbortSignal.timeout(budgetMs);
  return outer ? AbortSignal.any([t, outer]) : t;
}

export type Attempt = { n: number; started_at: string; duration_ms: number; ok: boolean; error?: string; code?: string };
type Outcome = { ok: boolean; error?: string; code?: string };

/** Run `once` and retry it only on a connect error, up to `max` attempts, recording each. */
export async function resolveWithConnectRetry<R extends Outcome>(
  once: (n: number) => Promise<R>,
  opts: { max?: number; sleep?: (ms: number) => Promise<void>; signal?: AbortSignal } = {},
): Promise<{ last: R; attempts: Attempt[] }> {
  const max = opts.max ?? 3;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const attempts: Attempt[] = [];
  let last!: R;
  for (let n = 1; n <= max; n++) {
    const t0 = Date.now();
    last = await once(n);
    attempts.push({ n, started_at: new Date(t0).toISOString(), duration_ms: Date.now() - t0, ok: last.ok, ...(last.error ? { error: last.error.slice(0, 200) } : {}), ...(last.code ? { code: last.code } : {}) });
    if (last.ok || !isConnectError(last.code) || opts.signal?.aborted || n === max) break;
    await sleep(2000 * n);
  }
  return { last, attempts };
}
