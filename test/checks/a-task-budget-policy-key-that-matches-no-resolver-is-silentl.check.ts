import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as mod from "../../src/task-budget";

const NOTE = "[task-budget] policy key matches no resolver";
const AT = { resolver: "llm_completion_dispatch", shape: "llm_completion_dispatch" };
const MS = Math.min(Number(mod.TASK_BUDGET_POLICY_MAX_MS), Math.max(Number(mod.TASK_BUDGET_POLICY_MIN_MS), 600000));

let dir = "";
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), "tbp-dead-key-")); });
afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

async function run(policy: unknown, name: string): Promise<{ ms: number; source: string; logs: string[] }> {
  const path = join(dir, name);
  if (policy !== undefined) await writeFile(path, JSON.stringify(policy));
  const logs: string[] = [];
  const out = await mod.taskBudgetAtUse(undefined, undefined, AT, { path, log: (m: string) => { logs.push(m); } });
  return { ms: out.ms, source: String(out.source), logs };
}

describe("taskBudgetPolicy key that matches no dispatched resolver", () => {
  test("dead resolver key: default budget is kept and the ignored key is noted", async () => {
    const dead = await run({ resolvers: { no_such_resolver: 600000 } }, "dead.json");
    expect(dead.ms).toBe(Number(mod.TASK_BUDGET_FLOOR_MS));
    expect(dead.source).toBe("default");
    expect(dead.logs.some((m) => m.includes(NOTE) && m.includes("no_such_resolver"))).toBe(true);
  });

  test("control: matching keys and an absent policy log no such note; budgets unchanged", async () => {
    const hit = await run({ resolvers: { llm_completion_dispatch: MS } }, "live.json");
    expect(hit.logs.some((m) => m.includes(NOTE))).toBe(false);
    expect(hit.ms).toBe(MS);
    expect(hit.source).toBe("policy:resolver:llm_completion_dispatch");

    const none = await run(undefined, "absent.json");
    expect(none.logs.length).toBe(0);
    expect(none.ms).toBe(Number(mod.TASK_BUDGET_FLOOR_MS));
    expect(none.source).toBe("default");
  });
});
