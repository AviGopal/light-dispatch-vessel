/**
 * light-dispatch-vessel — stateless oneshot dispatcher (port 8230... no, 8280
 * to avoid collision with local-tools-vessel which already uses 8230).
 *
 * Spec: openspec/changes/2026-06-03-pre-lift-bootstrap-and-architecture-aware-loop
 *       Stage 2.B.
 *
 * Purpose: alternative dispatch path that bypasses goal-host's full machinery
 * (state-space services, LLM-reuse, ProxyImpulseBus snapshot, fetch-probe
 * instrumentation). Useful for deterministic multi-task chains where the
 * template is explicit and no LLM-reuse / open-ended-goal logic is needed.
 *
 * Architecture:
 *   - HTTP server on PORT (default 8280); POST /dispatch
 *   - Per-dispatch flow:
 *     1. Fetch template from activity-api by template_id
 *     2. Walk tasks sequentially:
 *        a. Substitute {{var}} placeholders in task.config from variables +
 *           prior task results
 *        b. Find owning vessel for task.resolver via discovery
 *        c. POST to that vessel's resolve endpoint
 *        d. Persist intermediate result to /workspace/light-dispatch/<id>/
 *           task-<n>.json (so memory can drop the body)
 *     3. Assemble trace + POST to activity-api /v2/activities/execution-traces
 *     4. Return trace summary (or 202 + dispatchId for async polling)
 *   - GET /health, GET /executions/:dispatchId
 *
 * No persistent state. No proxy resolver registration. No state-signature
 * compute. No LLM-reuse. Discovery query is per-dispatch (cheap; only the
 * referenced resolvers' vessels need resolving).
 */

import { mkdir, writeFile, readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

const PORT = Number(process.env["PORT"] ?? 8280);

/**
 * Check 2b parity — fence-tolerant JSON-artifact validity test, ported verbatim
 * from ias-executor-ts engine.ts `isParseableJsonArtifact`. light-dispatch
 * delegates fs_write over HTTP (to local-tools-vessel), so the engine's
 * write-time convergent-validity guard never runs on this dispatch path; this
 * inline copy lets light-dispatch refuse the same ghost-success (a `.json`
 * artifact whose bytes don't parse — e.g. raw fenced LLM text interpolated into
 * a JSON string slot). Fence-tolerant so intentionally-fenced `-report.json`
 * writes the pipeline already accepts do NOT regress. Kept as an inline copy
 * rather than a dependency because light-dispatch does not vendor the engine
 * (mirrors the existing "goal-host parity aliases" duplication pattern).
 */
function isParseableJsonArtifact(raw: string): boolean {
  if (typeof raw !== "string" || raw.trim().length === 0) return false;
  try { JSON.parse(raw); return true; } catch { /* fall through to fence-tolerant path */ }
  const s = raw.replace(/^\s*```(?:json)?\n?/i, "").trimStart();
  const startObj = s.indexOf("{");
  const startArr = s.indexOf("[");
  const candidates: Array<[number, string, string]> = [];
  if (startObj >= 0) candidates.push([startObj, "{", "}"]);
  if (startArr >= 0) candidates.push([startArr, "[", "]"]);
  candidates.sort((a, b) => a[0] - b[0]);
  for (const [start, open, close] of candidates) {
    let depth = 0, inStr = false, escape = false;
    for (let i = start; i < s.length; i++) {
      const ch = s[i]!;
      if (escape) { escape = false; continue; }
      if (inStr) {
        if (ch === "\\") { escape = true; continue; }
        if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) {
          try { JSON.parse(s.slice(start, i + 1)); return true; } catch { break; }
        }
      }
    }
  }
  return false;
}
const VESSEL_ID = process.env["LIGHT_DISPATCH_VESSEL_ID"] ?? "light-dispatch-vessel";
const ACTIVITY_API = process.env["ACTIVITY_API_ENDPOINT"] ?? "http://127.0.0.1:8080";
const DISCOVERY = process.env["DISCOVERY_ENDPOINT"] ?? "http://127.0.0.1:8100";
const API_KEY = process.env["METABOB_API_KEY"] ?? "";
const VERSION = "0.1.0";
const WORKDIR_ROOT = process.env["LIGHT_DISPATCH_WORKDIR"] ?? "/workspace/light-dispatch";

// Artifact retention. Per-dispatch task-*.json artifacts are ephemeral debug
// state — the durable record is the SurrealDB trace. Left uncleaned they
// accumulated to 68k+ dirs / 146k+ files on the /workspace bind-mount
// (2026-06-14), exhausting the Docker-Desktop file-sharing layer's fd table and
// wedging /workspace with EMFILE (which crawled the whole substrate loop). This
// sweep caps retention so the leak cannot recur.
const ARTIFACT_TTL_MS = parseInt(process.env["LIGHT_DISPATCH_ARTIFACT_TTL_MS"] ?? "1800000", 10); // 30 min
async function pruneOldArtifacts(): Promise<void> {
  try {
    const entries = await readdir(WORKDIR_ROOT, { withFileTypes: true });
    const cutoff = Date.now() - ARTIFACT_TTL_MS;
    let pruned = 0;
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const full = join(WORKDIR_ROOT, e.name);
      try {
        const st = await stat(full);
        if (st.mtimeMs < cutoff) { await rm(full, { recursive: true, force: true }); pruned++; }
      } catch { /* entry vanished mid-sweep — fine */ }
    }
    if (pruned > 0) console.log(`[light-dispatch] pruned ${pruned} expired artifact dirs (>${ARTIFACT_TTL_MS}ms)`);
  } catch { /* WORKDIR_ROOT missing or unreadable — fine */ }
}
// Sweep on startup (after a short delay so boot I/O settles) and every 10 min.
setTimeout(() => { void pruneOldArtifacts(); }, 60_000);
setInterval(() => { void pruneOldArtifacts(); }, 600_000);

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface Template {
  id: string;
  name?: string;
  description?: string;
  output_shapes?: string[];
  tasks: Array<{
    id: string;
    description?: string;
    resolver: string;
    config?: Record<string, unknown>;
    output_shape?: string;
    validation?: { requiredPatterns?: string[] };
  }>;
}

interface TaskResult {
  taskId: string;
  resolver: string;
  status: "success" | "failure";
  duration_ms: number;
  shape?: string;
  error?: string;
  /** raw body returned from resolving vessel — only kept long enough to persist + extract referenced fields. */
  body?: unknown;
}

interface DispatchOutcome {
  dispatchId: string;
  executionId: string;
  templateId: string;
  status: "success" | "failure";
  startedAt: string;
  duration_ms: number;
  taskCount: number;
  successCount: number;
  failureCount: number;
  output_shapes: string[];
  /**
   * Information yield of this dispatch — the discriminator the boredom selector
   * needs to grade reward by *learning produced*, not mere completion.
   *  - "productive": the tick emitted real findings (a gap, an emission, a
   *    non-empty findings collection) — full reward.
   *  - "idle": the tick completed cleanly but produced nothing new
   *    (e.g. an audit whose `gaps_emitted=0`, a queue drain of `{"gaps":[],"total":0}`)
   *    — reduced reward, so UCB stops spending equal budget on detectors that
   *    are currently finding nothing.
   *  - "error": the chain failed — zero reward (unchanged from prior behaviour).
   */
  information_yield: "productive" | "idle" | "error";
  /** Count of findings/emissions detected across all task bodies (0 for idle). */
  findings_count: number;
  /**
   * Stable per-finding identity hashes (sorted, deduped) across all task bodies.
   * Lets the boredom selector grade *novelty* — a `productive` tick that re-emits
   * only findings it has emitted before has zero new information yield and should
   * decay toward IDLE_REWARD rather than earn full reward forever. (2026-06-14:
   * next recursion of V28 — reward information *gain*, not information *presence*.)
   */
  finding_hashes: string[];
  /**
   * V31 (2026-06-14): cost-weighted LLM tokens consumed by this dispatch
   * (input + 5×output). The second cost dimension the boredom selector folds into
   * value-of-information-per-cost. 0 for deterministic detector ticks (no LLM).
   */
  cost_tokens: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

// Findings-bearing array keys the substrate's detectors actually emit (anchored
// on real report bodies 2026-06-14: capabilityGapReport `gaps`, audit
// `cluster_summaries`/`emissions`, substrateGap resolve `gaps`, drafter
// `drafts`/`scenarios`, etc.). Empty arrays (`"gaps":[]`) correctly score 0.
const FINDINGS_ARRAY_KEYS = new Set([
  "gaps", "emissions", "cluster_summaries", "findings", "anomalies", "drafts",
  "scenarios", "candidates", "mismatches", "violations", "drifts", "issues",
  "problems", "proposals", "promoted", "orphans", "novel", "unlearned",
  "uncovered", "recommendations", "missing",
]);
// Explicit numeric yield counters detectors self-report.
const FINDINGS_COUNT_KEYS = new Set([
  "gaps_emitted", "gapsemitted", "emitted", "findings_count", "findingscount",
  "anomalies_found", "drafted", "promoted_count",
]);

/**
 * Walk a resolved task body (depth-bounded) and count the findings it reports.
 * Counts non-empty findings arrays by length and explicit `*_emitted`/count
 * fields by value. Skips string fields (avoids double-counting `bodyText` JSON
 * blobs whose parsed form is already present as `bodyJson`). Pure read; never throws.
 */
function extractFindingsCount(node: unknown, depth = 0): number {
  if (depth > 5 || node == null || typeof node !== "object") return 0;
  let total = 0;
  if (Array.isArray(node)) {
    for (const el of node) total += extractFindingsCount(el, depth + 1);
    return total;
  }
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    const key = k.toLowerCase();
    if (Array.isArray(v) && FINDINGS_ARRAY_KEYS.has(key)) {
      total += v.length;
    } else if (typeof v === "number" && FINDINGS_COUNT_KEYS.has(key) && v > 0) {
      total += v;
    } else if (v && typeof v === "object") {
      total += extractFindingsCount(v, depth + 1);
    }
  }
  return total;
}

/** Short stable hash (FNV-1a, 32-bit, hex) for finding-identity fingerprints. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Derive a stable identity for one finding object. Prefer an explicit id-ish
 * field (the thing that makes two findings "the same finding"); fall back to a
 * bounded JSON projection. Mirrors extractFindingIdentities' element handling.
 */
const FINDING_ID_KEYS = ["id", "gap_id", "gapid", "scenario_id", "template_id",
  "templateid", "key", "type", "category", "summary", "title", "name", "path", "shape"];
/**
 * Strip volatile tokens so the same logical finding hashes identically across
 * runs. Detectors routinely embed `Date.now()` / ISO datetimes in gap ids
 * (e.g. `responsibility-${vessel}-${p}-${Date.now()}`), which would make every
 * re-emission of the same gap look novel and defeat novelty grading. Removes
 * 10/13-digit epoch stamps, ISO datetimes, and bare YYYY-MM-DD dates.
 */
function stripVolatile(s: string): string {
  return s
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.\-Z]+/g, "T")        // ISO datetime
    .replace(/\d{4}-\d{2}-\d{2}/g, "D")                    // bare date
    .replace(/\d{13}/g, "M")                               // epoch millis
    .replace(/\d{10}/g, "S");                              // epoch seconds
}
function findingIdentity(el: unknown): string {
  if (el == null) return "null";
  if (typeof el !== "object") return stripVolatile(String(el)).slice(0, 160);
  const o = el as Record<string, unknown>;
  const parts: string[] = [];
  for (const k of FINDING_ID_KEYS) {
    const v = o[k];
    if (typeof v === "string" || typeof v === "number") parts.push(`${k}=${v}`);
  }
  if (parts.length > 0) return stripVolatile(parts.join("|")).slice(0, 240);
  // No id-ish field: fall back to a stable, bounded JSON projection.
  try { return stripVolatile(JSON.stringify(el)).slice(0, 240); } catch { return "unhashable"; }
}

/**
 * Walk a resolved task body and collect a STABLE IDENTITY per finding (not just
 * a count). Two runs of the same detector that surface the same findings yield
 * the same identity set — which is how the boredom selector tells genuine
 * discovery (novel hashes) from redundant re-emission (all hashes already seen).
 * Mirrors extractFindingsCount's traversal exactly. Pure read; never throws.
 */
function extractFindingIdentities(node: unknown, out: string[], depth = 0): void {
  if (depth > 5 || node == null || typeof node !== "object" || out.length > 200) return;
  if (Array.isArray(node)) {
    for (const el of node) extractFindingIdentities(el, out, depth + 1);
    return;
  }
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    const key = k.toLowerCase();
    if (Array.isArray(v) && FINDINGS_ARRAY_KEYS.has(key)) {
      for (const el of v) out.push(fnv1a(`${key}:${findingIdentity(el)}`));
    } else if (typeof v === "number" && FINDINGS_COUNT_KEYS.has(key) && v > 0) {
      // A bare counter has no per-item identity; fold key+value so a stable
      // count reads as redundant and a changed count reads as novel.
      out.push(fnv1a(`${key}#${v}`));
    } else if (v && typeof v === "object") {
      extractFindingIdentities(v, out, depth + 1);
    }
  }
}

const auth = (): Record<string, string> =>
  API_KEY ? { Authorization: `ApiKey ${API_KEY}` } : {};

/**
 * Interpolate {{var}} and {{taskId_field}} placeholders. Mirrors the surface
 * area of goal-host's interpolateProxyValue (variables + prior task field
 * references via underscore — e.g. {{fetch_traces_text}} resolves to the
 * `text` field of the task whose id is `fetch_traces`).
 */
function resolvePath(
  path: string,
  variables: Record<string, unknown>,
  priorResults: Map<string, TaskResult>,
  sortedIds: string[],
): { found: boolean; value?: unknown } {
  if (path in variables) {
    return { found: true, value: variables[path] };
  }
  for (const taskId of sortedIds) {
    if (path === taskId) {
      const r = priorResults.get(taskId);
      if (r?.body !== undefined) return { found: true, value: r.body };
      return { found: false };
    }
    if (path.startsWith(taskId + "_")) {
      const field = path.slice(taskId.length + 1);
      const r = priorResults.get(taskId);
      if (r?.body && typeof r.body === "object") {
        const fld = field.split(".").reduce<unknown>(
          (acc, k) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[k] : undefined),
          r.body,
        );
        if (fld !== undefined) return { found: true, value: fld };
      }
      // goal-host parity aliases (ias-executor-ts engine.ts ~line 408-437):
      // when a downstream task references {{<taskId>_text}} / _content /
      // _valueJson but the body has no such field, fall back to the canonical
      // body content. This keeps templates portable between dispatchers —
      // goal-host populates these as accumulated-variable aliases of the first
      // output impulse's content; light-dispatch reads from the resolver's
      // body and must synthesize the same aliases or templates authored for
      // one dispatcher silently break the other. Fix anchors:
      //   concept_K-NGhlSQ3grT (mitosis cutover chain post-fix state)
      //   concept_jhOVI4a8DfMD (substrate durable gap closure verified)
      //   concept_Orn4yVaJYD24 (operator audit becomes tick template)
      if (r?.body !== undefined) {
        if (field === "content" || field === "text" || field === "valueJson") {
          // For shapes like json_extracted_value the canonical scalar lives
          // under body.value; for others (e.g. vesselMitosisEvaluation) the
          // body itself IS the content object. Prefer body.value when present,
          // else the whole body — mirroring goal-host's special-case unwrap
          // for json_extracted_value plus its default pass-through.
          if (r.body && typeof r.body === "object" && ("value" in (r.body as Record<string, unknown>) || "text" in (r.body as Record<string, unknown>))) {
            return { found: true, value: "value" in (r.body as Record<string, unknown>) ? (r.body as Record<string, unknown>)["value"] : (r.body as Record<string, unknown>)["text"] };
          }
          return { found: true, value: r.body };
        }
      }
      return { found: false };
    }
  }
  const segs = path.split(/[._]/);
  let cur: unknown = variables;
  for (const seg of segs) {
    if (cur && typeof cur === "object" && seg in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[seg];
    } else {
      return { found: false };
    }
  }
  if (cur === undefined || cur === null) return { found: false };
  return { found: true, value: cur };
}

function interpolate(
  value: unknown,
  variables: Record<string, unknown>,
  priorResults: Map<string, TaskResult>,
  knownTaskIds: string[] = [],
): unknown {
  if (typeof value === "string") {
    // Pre-sort taskIds longest-first so multi-underscore IDs (e.g. `split_sections`)
    // are matched before any shorter prefix.
    const sortedIds = [...knownTaskIds].sort((a, b) => b.length - a.length);

    // Whole-string substitution: if the value is EXACTLY {{path}} (single
    // placeholder with no surrounding text), substitute the underlying value
    // verbatim — objects stay objects, arrays stay arrays. Mirrors goal-host's
    // interpolateProxyValue behavior. Without this, json_path_extract
    // results get JSON-stringified and downstream resolvers fail their
    // typeof-object checks (e.g. vessel_mitosis_cutover.evaluation_evidence).
    const exactMatch = /^\{\{([\w]+(?:[._][\w]+)*)\}\}$/.exec(value);
    if (exactMatch) {
      const resolved = resolvePath(exactMatch[1]!, variables, priorResults, sortedIds);
      if (resolved.found) return resolved.value;
      return value;
    }

    return value.replace(/\{\{([\w]+(?:[._][\w]+)*)\}\}/g, (match, path: string) => {
      // Delegate to resolvePath so the goal-host parity aliases (_text /
      // _content / _valueJson fallback to body.value or whole-body) also
      // fire inside partial-string substitutions like
      // "/vessels/{{extract_vessel_name_content}}". Without this, embedded
      // {{<taskId>_content}} placeholders silently left the literal placeholder
      // in the string for json_extracted_value results (whose body has no
      // `content` field), and the downstream resolver received a path like
      // "/vessels/{{extract_vessel_name_content}}" — broken static_check_base
      // _root → INSUFFICIENT_DATA verdict instead of FAVORABLE.
      const resolved = resolvePath(path, variables, priorResults, sortedIds);
      if (resolved.found) {
        const v = resolved.value;
        return typeof v === "string" ? v : JSON.stringify(v);
      }
      return match;
    });
  }
  if (Array.isArray(value)) return value.map((v) => interpolate(v, variables, priorResults, knownTaskIds));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = interpolate(v, variables, priorResults, knownTaskIds);
    }
    return out;
  }
  return value;
}

/**
 * Find a vessel that advertises the given resolver/shape via discovery.
 * Cached per-process for the lifetime of this dispatch (no proxy registration).
 */
const vesselCache = new Map<string, string>();
async function findVesselEndpointFor(resolverShape: string): Promise<string | null> {
  if (vesselCache.has(resolverShape)) return vesselCache.get(resolverShape)!;
  // Try bare shape AND namespace-stripped form. Many templates reference
  // `vesselname:shape` while discovery indexes by the bare shape name.
  const candidates = [resolverShape];
  const colon = resolverShape.indexOf(":");
  if (colon > 0) candidates.push(resolverShape.slice(colon + 1));
  for (const candidate of candidates) {
    const found = await lookupShape(candidate);
    if (found) {
      vesselCache.set(resolverShape, found);
      return found;
    }
  }
  return null;
}

async function lookupShape(resolverShape: string): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(`${DISCOVERY}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth() },
      body: JSON.stringify({ pointer: { type: "vesselCapability", shape: resolverShape } }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      try { await res.body?.cancel(); } catch { /* swallow */ }
      return null;
    }
    const data = await res.json() as { content?: { vessels?: Array<{ endpoint?: string; resolve_endpoint?: string }> } };
    try { await res.body?.cancel(); } catch { /* swallow */ }
    const vessel = data.content?.vessels?.[0];
    if (vessel) {
      const path = vessel.resolve_endpoint ?? "/v2/impulses/resolve";
      const base = vessel.endpoint ?? "";
      const full = path.startsWith("http") ? path : `${base.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
      return full;
    }
    return null;
  } catch {
    return null;
  }
}

async function fetchTemplate(templateId: string): Promise<Template | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(`${ACTIVITY_API}/v2/activities/templates/${encodeURIComponent(templateId)}`, {
      headers: auth(),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      try { await res.body?.cancel(); } catch { /* swallow */ }
      return null;
    }
    const data = await res.json() as Template | { template?: Template };
    try { await res.body?.cancel(); } catch { /* swallow */ }
    const tpl = (data as { template?: Template }).template ?? (data as Template);
    if (!tpl || !Array.isArray(tpl.tasks)) return null;
    return tpl;
  } catch {
    return null;
  }
}

async function resolveTask(
  endpoint: string,
  resolverShape: string,
  config: Record<string, unknown>,
): Promise<{ ok: boolean; body?: unknown; shape?: string; error?: string }> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60_000);
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth() },
      body: JSON.stringify({
        impulse: { pointer: { type: resolverShape, ...config } },
      }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const text = await res.text();
    try { await res.body?.cancel(); } catch { /* swallow */ }
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    if (parsed && typeof parsed === "object") {
      const p = parsed as Record<string, unknown>;
      if (p["success"] === false) {
        return { ok: false, error: typeof p["error"] === "string" ? p["error"] : "resolver returned success=false" };
      }
      const shape = typeof p["shape"] === "string" ? p["shape"] : undefined;
      if (shape === "structuredError") {
        const detail = (p["body"] as Record<string, unknown> | undefined)?.["detail"] ?? "structuredError";
        return { ok: false, shape, error: String(detail).slice(0, 200) };
      }
      return { ok: true, body: p["body"] ?? parsed, shape };
    }
    return { ok: true, body: parsed };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

async function postTrace(trace: Record<string, unknown>): Promise<void> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    const res = await fetch(`${ACTIVITY_API}/v2/activities/execution-traces`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth() },
      body: JSON.stringify(trace),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    try { await res.body?.cancel(); } catch { /* swallow */ }
    if (!res.ok) console.warn(`[light-dispatch-vessel] trace POST HTTP ${res.status}`);
  } catch (err) {
    console.warn(`[light-dispatch-vessel] trace POST failed: ${(err as Error).message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Dispatch orchestrator
// ─────────────────────────────────────────────────────────────────────────────

async function runDispatch(
  templateId: string,
  variables: Record<string, unknown>,
  extraTags: string[] = [],
  parentExecutionId?: string,
  compositionChain: string[] = [],
  stateSignatureHash?: string,
): Promise<DispatchOutcome> {
  const dispatchId = crypto.randomUUID();
  const executionId = `exec_${dispatchId.slice(0, 12)}`;
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const workDir = join(WORKDIR_ROOT, dispatchId);
  try { await mkdir(workDir, { recursive: true }); } catch { /* tolerate */ }

  const tpl = await fetchTemplate(templateId);
  if (!tpl) {
    const trace = {
      execution_id: executionId,
      template_id: templateId,
      activity_id: templateId,
      activity_variant_id: templateId,
      status: "failed" as const,
      started_at: startedAt,
      duration_ms: Date.now() - t0,
      tasks: [],
      tags: [
        `dispatcher_used:light-dispatch`,
        ...extraTags,
      ],
      metadata: {
        dispatcher_used: "light-dispatch",
        dispatch_id: dispatchId,
        failure_reason: "template_not_found",
        ...(stateSignatureHash ? { state_signature_hash: stateSignatureHash } : {}),
      },
      parent_execution_id: parentExecutionId,
      composition_chain: compositionChain,
    };
    await postTrace(trace);
    return {
      dispatchId, executionId, templateId,
      status: "failure", startedAt,
      duration_ms: Date.now() - t0,
      finding_hashes: [],
      cost_tokens: 0,
      taskCount: 0, successCount: 0, failureCount: 0,
      output_shapes: [],
      information_yield: "error",
      findings_count: 0,
    };
  }

  const priorResults = new Map<string, TaskResult>();
  const taskRecords: Array<Record<string, unknown>> = [];
  let successCount = 0;
  let failureCount = 0;
  // V31 (2026-06-14): accumulate the second cost dimension — cost-weighted LLM
  // tokens (input + 5×output approximates the output/input price asymmetry without
  // committing to an absolute $ rate). LLM tasks surface usage via the
  // llm_completion_dispatch body; deterministic tasks carry none → contribute 0.
  // Makes the boredom cost model a vector {wall_ms, tokens} so the selector ranks
  // efficiency across ALL measured cost parameters, not just wall-clock.
  let costTokens = 0;
  const outputShapesProduced: string[] = [];
  const knownTaskIds = tpl.tasks.map((t) => t.id);

  for (let i = 0; i < tpl.tasks.length; i++) {
    const task = tpl.tasks[i]!;
    const tTask0 = Date.now();
    const rawConfig = (task.config ?? {}) as Record<string, unknown>;
    const config = interpolate({ ...variables, ...rawConfig }, variables, priorResults, knownTaskIds) as Record<string, unknown>;
    const endpoint = await findVesselEndpointFor(task.resolver);
    // Strip namespace prefix for the actual pointer type sent to the vessel —
    // the vessel resolves on the bare shape name.
    const colonIdx = task.resolver.indexOf(":");
    const pointerType = colonIdx > 0 ? task.resolver.slice(colonIdx + 1) : task.resolver;
    if (!endpoint) {
      const r: TaskResult = {
        taskId: task.id,
        resolver: task.resolver,
        status: "failure",
        duration_ms: Date.now() - tTask0,
        error: `no vessel advertises resolver ${task.resolver}`,
      };
      priorResults.set(task.id, r);
      failureCount++;
      taskRecords.push({
        id: task.id,
        resolver_id: task.resolver,
        resolver_tier: "deterministic",
        success: false,
        duration_ms: r.duration_ms,
        error: r.error,
        input_impulse_ids: [],
        output_impulse_ids: [],
      });
      // Persist
      try {
        await writeFile(join(workDir, `task-${i}-${task.id}.json`), JSON.stringify(r, null, 2));
      } catch { /* swallow */ }
      // Fail fast; downstream tasks usually depend on this one.
      break;
    }
    const resolved = await resolveTask(endpoint, pointerType, config);
    const reqPatterns = task.validation?.requiredPatterns;
    if (resolved.ok && Array.isArray(reqPatterns) && reqPatterns.length > 0) {
      const bodyStr = typeof resolved.body === "string" ? resolved.body : JSON.stringify(resolved.body ?? "");
      const missing = reqPatterns.filter((p) => !bodyStr.includes(p));
      if (missing.length > 0) {
        resolved.ok = false;
        resolved.error = `validation[requiredPatterns]: task output missing required pattern(s): ${missing.join(", ")}`;
      }
    }
    // Check 2b parity (ias-executor-ts engine.ts convergent-validity). fs_write
    // is delegated over HTTP, so the engine guard never sees this write — verify
    // here that a workspace-scoped `.json` artifact actually parses. Reading the
    // just-written file back also subsumes the existence check for .json targets.
    // A failure flips the task to failure with the same error the engine emits,
    // so the chain halts and the trace records a real failure (β-penalty) rather
    // than a ghost-success.
    if (resolved.ok && pointerType === "fs_write") {
      const wpath = typeof config["path"] === "string" ? (config["path"] as string) : "";
      if (wpath.startsWith("/workspace/") && wpath.endsWith(".json") && !wpath.includes("{{")) {
        let okJson = false;
        try { okJson = isParseableJsonArtifact(await readFile(wpath, "utf-8")); } catch { okJson = false; }
        if (!okJson) {
          resolved.ok = false;
          resolved.error =
            `convergent_validity[json_artifact]: fs_write reported success but ${wpath} ` +
            `does not contain parseable JSON (even after fence-stripping) — likely raw ` +
            `text interpolated into a JSON string slot.`;
        }
      }
    }
    const r: TaskResult = {
      taskId: task.id,
      resolver: task.resolver,
      status: resolved.ok ? "success" : "failure",
      duration_ms: Date.now() - tTask0,
      shape: resolved.shape,
      error: resolved.error,
      body: resolved.body,
    };
    priorResults.set(task.id, r);
    // V31: harvest LLM token usage surfaced in the task body (llm_completion_dispatch
    // returns { text, model, usage:{input_tokens, output_tokens} }). Cost-weighted.
    if (resolved.body && typeof resolved.body === "object") {
      const ub = resolved.body as Record<string, unknown>;
      const usage = ub["usage"] && typeof ub["usage"] === "object" ? (ub["usage"] as Record<string, unknown>) : undefined;
      if (usage) {
        const it = typeof usage["input_tokens"] === "number" ? (usage["input_tokens"] as number) : 0;
        const ot = typeof usage["output_tokens"] === "number" ? (usage["output_tokens"] as number) : 0;
        costTokens += it + 5 * ot;
      }
    }
    if (r.status === "success") {
      successCount++;
      if (r.shape) outputShapesProduced.push(r.shape);
    } else {
      failureCount++;
    }
    taskRecords.push({
      id: task.id,
      resolver_id: task.resolver,
      resolver_tier: "deterministic",
      success: r.status === "success",
      duration_ms: r.duration_ms,
      ...(r.error ? { error: r.error } : {}),
      input_impulse_ids: [],
      output_impulse_ids: r.shape ? [`impulse:${task.id}`] : [],
    });
    // Persist + drop body reference for memory hygiene
    try {
      await writeFile(join(workDir, `task-${i}-${task.id}.json`), JSON.stringify(r, null, 2));
    } catch { /* swallow */ }
    if (r.status === "failure") break; // chain halts on first failure
  }

  const overallStatus: "success" | "failure" = failureCount === 0 ? "success" : "failure";
  const duration = Date.now() - t0;
  // Information yield: scan every task body for findings the detector reported.
  // A clean completion that produced no findings is "idle" (reduced reward),
  // which is what lets the boredom UCB selector stop spending equal budget on
  // detectors currently finding nothing. (2026-06-14: closes the reward-
  // saturation that pinned 86% of selections at mean=1.0.)
  let findingsCount = 0;
  const findingHashSet = new Set<string>();
  for (const r of priorResults.values()) {
    if (r.status === "success" && r.body != null) {
      findingsCount += extractFindingsCount(r.body);
      const ids: string[] = [];
      extractFindingIdentities(r.body, ids);
      for (const h of ids) findingHashSet.add(h);
    }
  }
  const findingHashes = Array.from(findingHashSet).sort();
  const informationYield: "productive" | "idle" | "error" =
    overallStatus !== "success" ? "error" : findingsCount > 0 ? "productive" : "idle";
  // activity-api's POST /v2/activities/execution-traces derives `success` via
  // `body.status === 'completed' || body.success === true` (see
  // metabob-activity-api/src/routes/execution-traces.ts:1561). Send BOTH the
  // explicit success bool AND status:"completed" on the success path so the
  // downstream row's success/status fields match light-dispatch's own view of
  // the trace. (Bootstrap 3.)
  const failedTask = taskRecords.find((t) => t["success"] === false);
        const failedTaskError = failedTask
          ? `${String(failedTask["id"])}: ${String(failedTask["error"] ?? "unknown error")}`.slice(0, 500)
          : undefined;
        const trace = {
    execution_id: executionId,
    template_id: templateId,
    activity_id: templateId,
    activity_variant_id: templateId,
    status: overallStatus === "success" ? ("completed" as const) : ("failed" as const),
    success: overallStatus === "success",
    started_at: startedAt,
    duration_ms: duration,
    tasks: taskRecords,
    tags: [
      `dispatcher_used:light-dispatch`,
      ...(stateSignatureHash ? [`state_signature:${stateSignatureHash}`] : []),
      ...extraTags,
    ],
    metadata: {
      dispatcher_used: "light-dispatch",
      dispatch_id: dispatchId,
      task_count: tpl.tasks.length,
      success_count: successCount,
      failure_count: failureCount,
      information_yield: informationYield,
      findings_count: findingsCount,
      finding_hashes: findingHashes,
      cost_tokens: costTokens,
      ...(stateSignatureHash ? { state_signature_hash: stateSignatureHash } : {}),
    },
    parent_execution_id: parentExecutionId,
    composition_chain: compositionChain,
    output_impulse_shapes: Array.from(new Set(outputShapesProduced)),
          ...(failedTask ? { error_message: failedTaskError, failed_task_id: String(failedTask["id"]) } : {}),
  };
  await postTrace(trace);

  return {
    dispatchId, executionId, templateId,
    status: overallStatus, startedAt, duration_ms: duration,
    taskCount: tpl.tasks.length,
    successCount, failureCount,
    output_shapes: Array.from(new Set(outputShapesProduced)),
    information_yield: informationYield,
    findings_count: findingsCount,
    finding_hashes: findingHashes,
    cost_tokens: costTokens,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP server
// ─────────────────────────────────────────────────────────────────────────────

const SHAPES = ["light_dispatch_execution"];

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/health") {
      return Response.json({
        status: "healthy",
        vesselId: VESSEL_ID,
        vesselName: "Light Dispatch Vessel",
        version: VERSION,
        shapes: SHAPES,
        rss_mb: +(process.memoryUsage().rss / 1024 / 1024).toFixed(1),
      });
    }

    if (req.method === "GET" && url.pathname === "/shapes") {
      return Response.json({ shapes: SHAPES });
    }

    if (req.method === "POST" && url.pathname === "/dispatch") {
      let body: Record<string, unknown>;
      try {
        const parsed = await req.json();
        if (typeof parsed !== "object" || parsed === null) throw new Error("body must be an object");
        body = parsed as Record<string, unknown>;
      } catch (err) {
        return Response.json({ error: (err as Error).message }, { status: 400 });
      }
      const templateId =
        (typeof body["template_id"] === "string" && body["template_id"]) ||
        (typeof body["targetTemplateId"] === "string" && body["targetTemplateId"]) ||
        undefined;
      if (!templateId) {
        return Response.json({ error: "template_id (or targetTemplateId) required" }, { status: 400 });
      }
      const variables = (typeof body["variables"] === "object" && body["variables"] !== null)
        ? body["variables"] as Record<string, unknown>
        : {};
      const tags = Array.isArray(body["tags"]) ? (body["tags"] as string[]) : [];
      const parentExecutionId = typeof body["parent_execution_id"] === "string"
        ? body["parent_execution_id"] : undefined;
      const compositionChain = Array.isArray(body["composition_chain"])
        ? (body["composition_chain"] as string[]) : [];
      const stateSignatureHash = typeof body["state_signature_hash"] === "string"
        ? body["state_signature_hash"] as string : undefined;
      try {
        const outcome = await runDispatch(templateId, variables, tags, parentExecutionId, compositionChain, stateSignatureHash);
        return Response.json(outcome, { status: outcome.status === "success" ? 200 : 207 });
      } catch (err) {
        return Response.json({ error: (err as Error).message }, { status: 500 });
      }
    }

    return Response.json({ error: "not found" }, { status: 404 });
  },
});

console.log(
  `[light-dispatch-vessel] listening on http://127.0.0.1:${server.port} ` +
    `| activity-api: ${ACTIVITY_API} | discovery: ${DISCOVERY}`,
);

// ─────────────────────────────────────────────────────────────────────────────
// Discovery registration + heartbeat loop (best-effort; non-fatal)
// ─────────────────────────────────────────────────────────────────────────────

async function registerWithDiscovery(): Promise<boolean> {
  try {
    const res = await fetch(`${DISCOVERY}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth() },
      body: JSON.stringify({
        vesselId: VESSEL_ID,
        vesselName: "Light Dispatch Vessel",
        version: VERSION,
        shapes: SHAPES,
        endpoint: `http://127.0.0.1:${PORT}`,
        resolve_endpoint: "/dispatch",
        resolve_request_format: "pointer",
        auth_scheme: "ApiKey",
        resolve_timeout_ms: 60_000,
        systemVessel: true,
      }),
    });
    try { await res.body?.cancel(); } catch { /* swallow */ }
    return res.ok;
  } catch {
    return false;
  }
}

async function heartbeatWithDiscovery(): Promise<boolean> {
  try {
    const res = await fetch(`${DISCOVERY}/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth() },
      body: JSON.stringify({ vesselId: VESSEL_ID }),
    });
    try { await res.body?.cancel(); } catch { /* swallow */ }
    return res.ok;
  } catch {
    return false;
  }
}

(async () => {
  const ok = await registerWithDiscovery();
  if (ok) console.log(`[light-dispatch-vessel] registered with discovery at ${DISCOVERY}`);
  else console.warn(`[light-dispatch-vessel] discovery registration failed (will retry via heartbeat loop)`);
})();

// Heartbeat every 60s; auto re-register on heartbeat 404.
setInterval(async () => {
  const ok = await heartbeatWithDiscovery();
  if (!ok) {
    const reregistered = await registerWithDiscovery();
    if (reregistered) console.log(`[light-dispatch-vessel] re-registered after heartbeat miss`);
  }
}, 60_000).unref();

// ─────────────────────────────────────────────────────────────────────────────
// Bun.gc periodic tick (matches local-tools-vessel pattern; bounds RSS under
// Bun 1.3.14 heap-arena retention).
// ─────────────────────────────────────────────────────────────────────────────

const GC_INTERVAL_MS = parseInt(process.env["LIGHT_DISPATCH_GC_INTERVAL_MS"] ?? "30000", 10);
interface BunGlobal { Bun?: { gc?: (force: boolean) => number } }
const bunGlobal = globalThis as unknown as BunGlobal;
setInterval(() => {
  const gc = bunGlobal.Bun?.gc;
  if (typeof gc === "function") {
    try {
      const freed = gc(true);
      const rssMB = (process.memoryUsage().rss / 1024 / 1024).toFixed(1);
      console.log(`[gc-tick] vessel=light-dispatch-vessel freed=${freed}B rss_after=${rssMB}MB`);
    } catch (err) {
      console.warn(`[gc-tick] Bun.gc failed: ${(err as Error).message}`);
    }
  }
}, GC_INTERVAL_MS).unref();

// Graceful shutdown
const shutdown = (signal: string): void => {
  console.log(`[light-dispatch-vessel] received ${signal}, shutting down...`);
  try { server.stop(true); } catch { /* swallow */ }
  process.exit(0);
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
