// The hourly retire sweep, tested end-to-end against a mocked activity-api.
//
// MEASURED 2026-10-02 on both nodes: retireNeverSucceededTemplates lists templates with
// `Authorization: Bearer <key>`, activity-api answers 401, and the sweep logs
// "covered 0/0 templates" / "no never-succeeded arms over 0 templates" every hour. A detector
// that reads nothing reports a clean pass. The same function's deprecate call already uses the
// ApiKey scheme, which is the one activity-api accepts.
//
// Fixing the scheme alone would revive the predecessor criterion, the one that retired 21
// working arms (7f3a81f -> 66b95e1). So the criterion is tested here too: retirement must be
// posterior-based — P(success) < 0.05 under Beta(alpha, beta) with alpha + beta >= 30 — and a
// known-working arm must never be retired, whatever its raw counters say.
//
// CONTRACT these tests need from src/index.ts:
//   - `retireNeverSucceededTemplates` is EXPORTED and returns a promise that settles when the
//     sweep is done (it is not exported today, which is part of the red);
//   - the module reads PORT / METABOB_API_KEY / ACTIVITY_API_ENDPOINT / DISCOVERY_ENDPOINT from
//     the environment at import, as it does today.
// Anything else the sweep fetches (for example a policy shape holding the threshold) is answered
// 404 by the mock, so a fix that reads its threshold from a shape falls back to its defaults
// (0.05 and 30) here.
//
// Why a separate file with a DYNAMIC import: importing src/index.ts starts the HTTP server, the
// discovery registration and the sweep timers. Inside the substrate container the live vessel
// holds port 8280, so a static import fails with EADDRINUSE before any test runs. The
// environment and the fetch mock must be in place BEFORE the module loads, so the server binds
// an ephemeral port and no request reaches a real discovery or activity-api.
import { beforeAll, beforeEach, describe, expect, it } from "bun:test";

const KEY = "check-first-test-key";
const API = "http://activity-api.retire-sweep.test";
process.env["PORT"] = "0";
process.env["METABOB_API_KEY"] = KEY;
process.env["ACTIVITY_API_ENDPOINT"] = API;
process.env["DISCOVERY_ENDPOINT"] = "http://discovery.retire-sweep.test";

type Template = {
  id: string;
  retired?: boolean;
  deprecated?: boolean;
  metrics: {
    id: string;
    total_executions?: number;
    successful_executions?: number;
    success_rate?: number;
    thompson_alpha?: number;
    thompson_beta?: number;
  };
};

let templates: Template[] = [];
let listingAuth: Array<string | null> = [];
let retiredIds: string[] = [];

function headerOf(init: RequestInit | undefined, name: string): string | null {
  return new Headers(init?.headers ?? {}).get(name);
}

const mockFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith(`${API}/v2/activities/templates`)) {
    const auth = headerOf(init, "authorization");
    listingAuth.push(auth);
    // Behave like the live activity-api: only the ApiKey scheme is accepted.
    if (auth !== `ApiKey ${KEY}`) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const u = new URL(url);
    const offset = Number(u.searchParams.get("offset") ?? "0");
    const limit = Math.min(Number(u.searchParams.get("limit") ?? "100"), 100);
    return Response.json({ templates: templates.slice(offset, offset + limit), total: templates.length, limit, offset });
  }
  if (url === `${API}/v2/impulses/resolve` && (init?.method ?? "GET").toUpperCase() === "POST") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { impulse?: { pointer?: { type?: string; templateId?: string } } };
    const p = body.impulse?.pointer;
    if (p?.type === "activityTemplate_deprecate" && headerOf(init, "authorization") === `ApiKey ${KEY}`) {
      if (p.templateId) retiredIds.push(p.templateId);
      return Response.json({ success: true });
    }
  }
  return Response.json({ error: "Not found" }, { status: 404 });
};

let sweep: () => Promise<void>;
let shouldRetire: (t: Template, minSamples: number) => boolean;

beforeAll(async () => {
  globalThis.fetch = mockFetch as typeof fetch;
  const mod = (await import("../src/index.js")) as Record<string, unknown>;
  sweep = mod["retireNeverSucceededTemplates"] as () => Promise<void>;
  shouldRetire = mod["shouldRetire"] as (t: Template, minSamples: number) => boolean;
});

beforeEach(() => {
  templates = [];
  listingAuth = [];
  retiredIds = [];
});

const arm = (id: string, m: Omit<Template["metrics"], "id">): Template => ({ id: `activity:${id}`, retired: false, metrics: { id, ...m } });

// Dead under every criterion: 0 successes in 139 runs, posterior mean 1/41 ~ 0.024, alpha+beta 41.
const DEAD = () => arm("dead-arm", { total_executions: 139, successful_executions: 0, success_rate: 0, thompson_alpha: 1, thompson_beta: 40 });

describe("retire sweep lists templates with the scheme activity-api accepts", () => {
  it("THE BREAK: the template listing is sent with the ApiKey scheme, not Bearer", async () => {
    templates = [DEAD()];
    expect(typeof sweep).toBe("function");
    await sweep();
    expect(listingAuth.length).toBeGreaterThan(0);
    expect(listingAuth.every((a) => a === `ApiKey ${KEY}`)).toBe(true);
    expect(listingAuth.some((a) => (a ?? "").startsWith("Bearer"))).toBe(false);
  });

  it("a never-succeeded arm with a low posterior over enough evidence is retired through the sweep", async () => {
    templates = [DEAD()];
    expect(typeof sweep).toBe("function");
    await sweep();
    expect(retiredIds).toEqual(["dead-arm"]);
  });
});

describe("retire sweep criterion is posterior-based: P(success) < 0.05 under Beta(alpha,beta) with alpha+beta at least 30", () => {
  it("an arm with alpha+beta < 30 is never retired, even with zero recorded successes", async () => {
    // 25 runs >= the old min-samples of 10, so the count rule retires it; the posterior has only
    // 21 pseudo-observations, too few to judge.
    templates = [DEAD(), arm("thin-evidence-arm", { total_executions: 25, successful_executions: 0, success_rate: 0, thompson_alpha: 1, thompson_beta: 20 })];
    expect(typeof sweep).toBe("function");
    await sweep();
    expect(retiredIds).toContain("dead-arm");
    expect(retiredIds).not.toContain("thin-evidence-arm");
  });

  it("an arm with a decent posterior is never retired, even when its success counter reads zero", async () => {
    // Posterior mean 8/40 = 0.2, alpha+beta 40. The raw counter is a derived field that has
    // lied before (66b95e1); the posterior is what selection actually uses.
    templates = [DEAD(), arm("decent-posterior-arm", { total_executions: 40, successful_executions: 0, success_rate: 0, thompson_alpha: 8, thompson_beta: 32 })];
    expect(typeof sweep).toBe("function");
    await sweep();
    expect(retiredIds).toContain("dead-arm");
    expect(retiredIds).not.toContain("decent-posterior-arm");
  });

  it("MUST-KEEP: a known-working arm (alpha=20, beta=10) is never retired, even with a zero success counter", async () => {
    templates = [DEAD(), arm("known-working-arm", { total_executions: 100, successful_executions: 0, success_rate: 0, thompson_alpha: 20, thompson_beta: 10 })];
    expect(typeof sweep).toBe("function");
    await sweep();
    expect(retiredIds).toContain("dead-arm");
    expect(retiredIds).not.toContain("known-working-arm");
  });

  // Controls through the exported pure rule: green today, and must stay green after the fix.
  it("control: shouldRetire keeps a known-working arm whose counters agree (alpha=20, beta=10, 19 of 28 succeeded)", () => {
    expect(shouldRetire(arm("working-arm-consistent", { total_executions: 28, successful_executions: 19, success_rate: 19 / 28, thompson_alpha: 20, thompson_beta: 10 }), 10)).toBe(false);
  });

  it("control: shouldRetire keeps an already-retired arm, so a sweep is idempotent", () => {
    expect(shouldRetire({ ...DEAD(), retired: true }, 10)).toBe(false);
  });

  it("control: shouldRetire still retires an arm dead under every criterion (0 of 139, alpha=1, beta=40)", () => {
    expect(shouldRetire(DEAD(), 10)).toBe(true);
  });
});

// ── STRENGTHENED (class, not examples) ───────────────────────────────────────────────────────
// The four arms above — (1,40) retire; (1,20), (8,32), (20,10) keep — are passed by a patch as
// narrow as `alpha === 1 && alpha + beta >= 30`. The rule is a property of the whole (alpha, beta)
// plane, so it is checked here over a grid, through the exported pure `shouldRetire` (it does not
// depend on the sweep being exported), with every success counter reading ZERO and
// total_executions far above the min-samples gate — the case where the old count rule and the
// posterior rule disagree.
//
// REFERENCE RULE: retire iff alpha + beta >= 30 AND the posterior predictive probability of
// success, alpha / (alpha + beta), is below 0.05. Derivation: it is the only reading of
// "P(success) < 0.05 under Beta(alpha, beta)" consistent with the existing arms. A credible-bound
// reading (posterior mean + 2 sd < 0.05, or P(p < 0.05) >= 0.95) KEEPS the dead arm (1,40)
// (mean + 2 sd ~ 0.072; P(p < 0.05) ~ 0.87), which the tests above require to be retired.
// Grid points whose mean is exactly 0.05 are skipped so strict-vs-inclusive is not tested.
//
// MUST-KEEP (folded in from step-3): no arm whose posterior mean is at least 0.05 is retired,
// whatever its counter reads — (20,10) is one point of that class, not the class.
// CONTROLS keep the over-broad repair out: every arm the reference retires must still be retired
// (a never-retire rule fails), and the retired / no-metrics fail-safes hold.
const RETIRE_POSTERIOR = 0.05;
const RETIRE_MIN_EVIDENCE = 30;
const refRetire = (a: number, b: number): boolean => a + b >= RETIRE_MIN_EVIDENCE && a / (a + b) < RETIRE_POSTERIOR;

const ALPHAS = [1, 2, 3, 4, 5, 6, 8, 10, 15, 20];
const BETAS = [5, 10, 15, 19, 20, 25, 28, 29, 30, 35, 38, 40, 50, 57, 60, 80, 100, 150, 200];
const GRID: Array<{ a: number; b: number }> = [];
for (const a of ALPHAS) for (const b of BETAS) if (Math.abs(a / (a + b) - RETIRE_POSTERIOR) > 1e-9) GRID.push({ a, b });

const zeroCounterArm = (a: number, b: number): Template =>
  arm(`grid-${a}-${b}`, { total_executions: a + b + 100, successful_executions: 0, success_rate: 0, thompson_alpha: a, thompson_beta: b });

function disagreements(points: Array<{ a: number; b: number }>): string[] {
  return points
    .filter(({ a, b }) => shouldRetire(zeroCounterArm(a, b), 10) !== refRetire(a, b))
    .map(({ a, b }) => `(alpha=${a}, beta=${b}) expected ${refRetire(a, b) ? "retire" : "keep"}`);
}

describe("retire criterion over the (alpha, beta) plane: retire iff alpha+beta >= 30 and alpha/(alpha+beta) < 0.05", () => {
  it("MUST-FAIL (class): over the grid, with a zero success counter, shouldRetire agrees with the posterior reference rule", () => {
    expect(typeof shouldRetire).toBe("function");
    expect(disagreements(GRID)).toEqual([]);
  });

  it("MUST-KEEP (class): no arm whose posterior mean is at least 0.05 is retired, whatever its success counter reads", () => {
    expect(typeof shouldRetire).toBe("function");
    expect(disagreements(GRID.filter(({ a, b }) => a / (a + b) >= RETIRE_POSTERIOR))).toEqual([]);
  });

  it("MUST-FAIL (boundary): evidence 29 is kept and 30 retired at a low mean; (2,60) retired; (3,40) kept", () => {
    expect(typeof shouldRetire).toBe("function");
    const verdict = (a: number, b: number) => (shouldRetire(zeroCounterArm(a, b), 10) ? "retire" : "keep");
    expect({ "1,28": verdict(1, 28), "1,29": verdict(1, 29), "2,60": verdict(2, 60), "3,40": verdict(3, 40), "20,10": verdict(20, 10) })
      .toEqual({ "1,28": "keep", "1,29": "retire", "2,60": "retire", "3,40": "keep", "20,10": "keep" });
  });

  it("CONTROL (class): every grid arm the reference rule retires is retired (a never-retire rule fails)", () => {
    expect(typeof shouldRetire).toBe("function");
    expect(disagreements(GRID.filter(({ a, b }) => refRetire(a, b)))).toEqual([]);
  });

  it("CONTROL: fail-safes hold over the grid — an already-retired arm and an arm with no metrics are never retired", () => {
    expect(typeof shouldRetire).toBe("function");
    expect(GRID.filter(({ a, b }) => shouldRetire({ ...zeroCounterArm(a, b), retired: true }, 10))).toEqual([]);
    expect(shouldRetire({ id: "activity:no-metrics", retired: false }, 10)).toBe(false);
    expect(shouldRetire({ id: "activity:empty-metrics", retired: false, metrics: { id: "empty-metrics" } } as Template, 10)).toBe(false);
  });
});
