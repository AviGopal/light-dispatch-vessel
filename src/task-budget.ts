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
 *     resolve_timeout_ms (discovery echoes it), never below the floor the shaped policy `taskBudgetPolicy` names for
 *     the task (its resolver's entry, else its shape's, else the policy's default_ms), whose built-in default is the
 *     OLD RETRY ENVELOPE (3 x 60 s + 2 s + 4 s backoff = 186 s). Measured before this fix: 66 tasks a day (llm_author_resolver, vessel_arrival_scan, goal_reach_tick,
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

import { readFile } from "node:fs/promises";

/**
 * The old retry envelope (three 60 s attempts with 2 s and 4 s backoff), so no task is cut sooner than before. It is the
 * BUILT-IN DEFAULT of the shaped policy `taskBudgetPolicy`, used when that policy is absent, refused, or names no floor
 * for the task. Under max(advertised, floor) an advertisement can only RAISE a budget, never lower it.
 */
export const TASK_BUDGET_FLOOR_MS = 3 * 60_000 + 2_000 + 4_000;

const positive = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;

/**
 * THE SHAPED BUDGET POLICY, read at use time from `<live super-repo clone>/policies/taskBudgetPolicy.json` (the fleet's
 * shaped-policy location). A flat JSON object, every field optional, validated fail-closed:
 *   default_ms  int in [MIN, MAX]      the floor for any task no entry names
 *   resolvers   { <resolver>: int in [MIN, MAX] }   the floor for tasks naming that resolver, matched as the template writes
 *               it ("vessel:shape") first, then by its bare name (namespace stripped), so a bare key covers both spellings
 *   shapes      { <bare shape>: int in [MIN, MAX] }      the floor for tasks resolving that shape (namespace stripped)
 *   reason, note                       free text for the record, never read as behaviour
 * Any other key, or any field out of range, refuses the WHOLE policy (a typo must not silently keep a default).
 */
export const TASK_BUDGET_POLICY_PATH = "/workspace/git/super-repo/policies/taskBudgetPolicy.json";
export const TASK_BUDGET_POLICY_MIN_MS = 1_000;
export const TASK_BUDGET_POLICY_MAX_MS = 3_600_000;
const POLICY_MAX_ENTRIES = 200;
const POLICY_KEYS = new Set(["default_ms", "resolvers", "shapes", "reason", "note"]);

export type TaskBudgetPolicy = { default_ms?: number; resolvers: Record<string, number>; shapes: Record<string, number> };
/** Which rule set the applied budget: the task, the advertisement, a policy entry, or the built-in default. */
export type BudgetSource = "task" | "advertised" | "default" | `policy:${string}`;

const msOk = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= TASK_BUDGET_POLICY_MIN_MS && v <= TASK_BUDGET_POLICY_MAX_MS;

function entriesOk(v: unknown, field: string): { ok: true; map: Record<string, number> } | { ok: false; why: string } {
  if (!v || typeof v !== "object" || Array.isArray(v)) return { ok: false, why: `"${field}" is not an object` };
  const map: Record<string, number> = {};
  const keys = Object.keys(v);
  if (keys.length > POLICY_MAX_ENTRIES) return { ok: false, why: `"${field}" has more than ${POLICY_MAX_ENTRIES} entries` };
  for (const k of keys) {
    const ms = (v as Record<string, unknown>)[k];
    if (k.length === 0 || k.length > 128 || !msOk(ms)) return { ok: false, why: `"${field}.${k}" is not an integer ms in [${TASK_BUDGET_POLICY_MIN_MS}, ${TASK_BUDGET_POLICY_MAX_MS}]` };
    map[k] = ms;
  }
  return { ok: true, map };
}

/** Validates a parsed taskBudgetPolicy, failing closed (see above). */
export function validateTaskBudgetPolicy(raw: unknown): { ok: true; policy: TaskBudgetPolicy } | { ok: false; why: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, why: "policy is not an object" };
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!POLICY_KEYS.has(k)) return { ok: false, why: `unknown policy key "${k}"` };
  const policy: TaskBudgetPolicy = { resolvers: {}, shapes: {} };
  if (Object.hasOwn(o, "default_ms")) {
    if (!msOk(o["default_ms"])) return { ok: false, why: `"default_ms" is not an integer ms in [${TASK_BUDGET_POLICY_MIN_MS}, ${TASK_BUDGET_POLICY_MAX_MS}]` };
    policy.default_ms = o["default_ms"];
  }
  for (const field of ["resolvers", "shapes"] as const) {
    if (!Object.hasOwn(o, field)) continue;
    const e = entriesOk(o[field], field);
    if (!e.ok) return e;
    policy[field] = e.map;
  }
  return { ok: true, policy };
}

export type TaskBudgetPolicyRead = { state: "absent" } | { state: "refused"; why: string } | { state: "policy"; policy: TaskBudgetPolicy };

/** What the policy file says right now. Absent is not an error; unreadable, unparseable or invalid is a refusal. */
export async function readTaskBudgetPolicy(path: string = TASK_BUDGET_POLICY_PATH): Promise<TaskBudgetPolicyRead> {
  let text: string;
  try {
    text = await readFile(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { state: "absent" };
    return { state: "refused", why: `unreadable: ${(err as Error).message}` };
  }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { state: "refused", why: "not valid JSON" }; }
  const v = validateTaskBudgetPolicy(raw);
  return v.ok ? { state: "policy", policy: v.policy } : { state: "refused", why: v.why };
}

/**
 * The abort budget for one task and the rule that set it: the task's timeout_ms; else max(advertised, floor), where the
 * floor is the policy's entry for the task's resolver, else for its shape, else the policy's default_ms, else the
 * built-in default.
 */
export function taskBudget(
  taskTimeoutMs: unknown,
  advertisedMs: unknown,
  policy: TaskBudgetPolicy | null,
  at: { resolver?: string; shape?: string } = {},
): { ms: number; source: BudgetSource } {
  const own = positive(taskTimeoutMs);
  if (own !== undefined) return { ms: own, source: "task" };
  let floor: { ms: number; source: BudgetSource } = { ms: TASK_BUDGET_FLOOR_MS, source: "default" };
  if (policy) {
    const colon = at.resolver?.indexOf(":") ?? -1;
    const rKey = [at.resolver, colon > 0 ? at.resolver!.slice(colon + 1) : undefined].find((k) => k !== undefined && Object.hasOwn(policy.resolvers, k));
    const r = rKey !== undefined ? policy.resolvers[rKey] : undefined;
    const s = at.shape !== undefined && Object.hasOwn(policy.shapes, at.shape) ? policy.shapes[at.shape] : undefined;
    if (r !== undefined) floor = { ms: r, source: `policy:resolver:${rKey}` };
    else if (s !== undefined) floor = { ms: s, source: `policy:shape:${at.shape}` };
    else if (policy.default_ms !== undefined) floor = { ms: policy.default_ms, source: "policy:default_ms" };
  }
  const adv = positive(advertisedMs);
  return adv !== undefined && adv > floor.ms ? { ms: adv, source: "advertised" } : floor;
}

/** The abort budget for one task with no policy: the task's timeout_ms, else max(advertised, the old envelope). */
export function taskBudgetMs(taskTimeoutMs: unknown, advertisedMs: unknown): number {
  return taskBudget(taskTimeoutMs, advertisedMs, null).ms;
}

const refusalsLogged = new Set<string>();

/**
 * The budget at use time: reads taskBudgetPolicy (unless the task states its own timeout_ms), and on a refused policy
 * applies the built-in default and logs the refusal once per distinct reason. Never throws.
 */
export async function taskBudgetAtUse(
  taskTimeoutMs: unknown,
  advertisedMs: unknown,
  at: { resolver?: string; shape?: string },
  opts: { path?: string; log?: (msg: string) => void } = {},
): Promise<{ ms: number; source: BudgetSource }> {
  if (positive(taskTimeoutMs) !== undefined) return taskBudget(taskTimeoutMs, advertisedMs, null, at);
  const path = opts.path ?? TASK_BUDGET_POLICY_PATH;
  let read: TaskBudgetPolicyRead;
  try { read = await readTaskBudgetPolicy(path); } catch (err) { read = { state: "refused", why: (err as Error).message }; }
  if (read.state === "refused") {
    const key = `${path}\u0000${read.why}`;
    if (!refusalsLogged.has(key)) {
      refusalsLogged.add(key);
      (opts.log ?? ((m: string) => console.warn(m)))(`[light-dispatch-vessel] taskBudgetPolicy refused (${path}): ${read.why}; the built-in default floor ${TASK_BUDGET_FLOOR_MS} ms applies`);
    }
  }
  return taskBudget(taskTimeoutMs, advertisedMs, read.state === "policy" ? read.policy : null, at);
}

/**
 * A budget cut leaves one journal line, so it is visible outside the trace. The task's own signal is its budget alone
 * (taskSignal: the /dispatch caller's connection is not composed in), so a TimeoutError on a task IS the budget firing.
 */
export const isBudgetAbort = (code: string | undefined): boolean => code === "TimeoutError";
export type BudgetAbort = { resolver: string; template: string; task: string; budget_ms: number; source: BudgetSource; elapsed_ms: number };
/** The `[task-budget] abort` line for a task whose budget fired, else null (it finished, or failed otherwise). */
export function budgetAbortLine(code: string | undefined, f: BudgetAbort): string | null {
  if (!isBudgetAbort(code)) return null;
  return `[task-budget] abort resolver=${f.resolver} template=${f.template} task=${f.task} budget_ms=${f.budget_ms} source=${f.source} elapsed_ms=${f.elapsed_ms}`;
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
