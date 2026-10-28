import { describe, test, expect } from "bun:test";
const __origServe = (Bun as any).serve;
(Bun as any).serve = (opts: any) => ({
  port: opts?.port ?? 0,
  hostname: opts?.hostname ?? "localhost",
  stop() {},
});
const mod = await import("../../src/index");
(Bun as any).serve = __origServe;

// The TemplateMetrics and Template shapes are inferred from their usage in src/index.ts
// as they are not exported types. This is for type-checking this test file.
interface TemplateMetrics {
  id?: string;
  total_executions?: number;
  successful_executions?: number;
  thompson_alpha?: number;
  thompson_beta?: number;
}

interface Template {
  deprecated?: boolean;
  retired?: boolean;
  metrics?: TemplateMetrics;
}

describe("shouldRetire retirement logic", () => {
  const minSamplesForRetirement = 30;

  test("MUST-FAIL: should NOT retire a template with <30 samples, even if it has 0 successes", () => {
    const templateWithFewSamples: Template = {
      metrics: {
        total_executions: 25,
        successful_executions: 0,
        // With a standard Beta(1,1) prior, after 25 failures (0 successes),
        // the posterior would be Beta(1, 26).
        thompson_alpha: 1,
        thompson_beta: 26,
      },
    };

    // The bug: current logic retires if successful_executions is 0 and total_executions >= minSamples.
    // The correct logic should also require high confidence (e.g., alpha+beta >= 30).
    // Here, alpha+beta = 1+26=27, which is < 30, so it should NOT be retired.
    // The current implementation will return true for shouldRetire(templateWithFewSamples, 20), causing this test to fail.
    expect(mod.shouldRetire(templateWithFewSamples, 20)).toBe(false);
  });

  test("CONTROL: should retire a template with 0 successes and sufficient samples (>= 30)", () => {
    const templateToRetire: Template = {
      metrics: {
        total_executions: 50,
        successful_executions: 0,
        thompson_alpha: 1,
        thompson_beta: 51,
      },
    };
    
    // This template should be retired under both old and new logic.
    // Old logic: 50 >= 30 and 0 successes -> retire.
    // New logic: alpha+beta = 52 >= 30, and mean = 1/52 < 0.05 -> retire.
    expect(mod.shouldRetire(templateToRetire, minSamplesForRetirement)).toBe(true);
  });

  test("CONTROL: should not retire a template that has succeeded", () => {
    const successfulTemplate: Template = {
      metrics: {
        total_executions: 100,
        successful_executions: 5,
      },
    };
    // This should not be retired under any logic because successful_executions > 0.
    expect(mod.shouldRetire(successfulTemplate, minSamplesForRetirement)).toBe(false);
  });

  test("CONTROL: should not retire a template with insufficient samples", () => {
    const newTemplate: Template = {
      metrics: {
        total_executions: 5,
        successful_executions: 0,
      },
    };
    // Should not be retired because total_executions < minSamples.
    expect(mod.shouldRetire(newTemplate, minSamplesForRetirement)).toBe(false);
  });

  test("CONTROL: should not retire an already retired template", () => {
    const retiredTemplate: Template = {
      retired: true,
      metrics: {
        total_executions: 100,
        successful_executions: 0,
      },
    };
    expect(mod.shouldRetire(retiredTemplate, minSamplesForRetirement)).toBe(false);
  });
});
