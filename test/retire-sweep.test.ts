// The retirement rule, tested without HTTP.
//
// Measured 2026-08-05 over a 100-template window: 22 arms with >=10 executions and a success
// rate of exactly 0, together 889 executions and not one success. The top four were all
// `substrateGap_write` arms (143/143, 143/143, 140/140, 137/137) — they declare inputShapes:[]
// and thread no pointer args, so the resolver is always called with an empty payload and the arm
// cannot succeed however often it is sampled. Such an arm is not neutral: it splits selection
// traffic with producers that work.
//
// The tests that matter are the ones pinning what is KEPT. A rule that retires on missing or
// thin data would turn a metrics outage into fleet-wide arm destruction.
import { describe, expect, it } from "bun:test";
import { shouldRetire } from "../src/index.js";

const T = (metrics: Record<string, unknown> | undefined, retired = false) => ({ retired, metrics: metrics as never });

describe("shouldRetire", () => {
  it("retires an arm with enough samples and no successes", () => {
    expect(shouldRetire(T({ total_executions: 137, success_rate: 0 }), 10)).toBe(true);
  });

  it("KEEPS an arm that has ever succeeded, however rarely", () => {
    expect(shouldRetire(T({ total_executions: 500, success_rate: 0.002 }), 10)).toBe(false);
  });

  it("KEEPS an arm that is merely new — too few samples to have shown a success", () => {
    expect(shouldRetire(T({ total_executions: 9, success_rate: 0 }), 10)).toBe(false);
  });

  // Fail safe. A metrics outage must not read as "every arm is dead".
  it("KEEPS an arm whose metrics are missing or malformed", () => {
    expect(shouldRetire(T(undefined), 10)).toBe(false);
    expect(shouldRetire(T({}), 10)).toBe(false);
    expect(shouldRetire(T({ total_executions: 100 }), 10)).toBe(false);          // no success_rate
    expect(shouldRetire(T({ success_rate: 0 }), 10)).toBe(false);                // no execution count
  });

  it("KEEPS an already-RETIRED arm, so a sweep is idempotent", () => {
    expect(shouldRetire(T({ total_executions: 137, success_rate: 0 }, true), 10)).toBe(false);
  });

  // `retired` is the operative flag; `deprecated` is only the label. An arm marked deprecated
  // but NOT retired is still in the candidate pool, so the sweep must still act on it —
  // guarding on `deprecated` would have abandoned precisely the arms that needed retiring.
  it("still retires an arm that is deprecated but NOT retired", () => {
    expect(shouldRetire({ deprecated: true, retired: false, metrics: { total_executions: 137, success_rate: 0 } as never }, 10)).toBe(true);
  });
});
