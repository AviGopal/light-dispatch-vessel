// The tier stamped on a dispatched task is the one its resolver DECLARED (discovery's capability row `resolver_tier`),
// and an undeclared resolver keeps today's "deterministic" stamp exactly (user ruling 2026-10-17T10:22:59Z; qa design
// approval 10:2xZ). MUST-FAIL on the parent (c181f97): src/tier-stamp.ts does not exist and every task record stamps the
// literal "deterministic".
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { __resetTierStampsForTests, noteDeclaredTier, rowTier, stampTierFor, tierStampSummary } from "../src/tier-stamp";

const SRC = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf8");

describe("the task stamp is the declared tier of the resolver that ran", () => {
  beforeEach(() => __resetTierStampsForTests());

  test("[MUST-FAIL] a resolver declared llm is stamped llm (llm_completion_dispatch learns)", () => {
    noteDeclaredTier("llm_completion_dispatch", rowTier("llm"));
    expect(stampTierFor("llm_completion_dispatch")).toBe("llm");
    noteDeclaredTier("someScan", rowTier("deterministic"));
    expect(stampTierFor("someScan")).toBe("deterministic");
    expect(tierStampSummary()).toMatchObject({ declared: 2, undeclared: 0 });
  });

  test("[CONTROL] an undeclared resolver keeps exactly today's stamp, and is counted as undeclared", () => {
    noteDeclaredTier("signature_cluster_scan", rowTier(undefined));
    expect(stampTierFor("signature_cluster_scan")).toBe("deterministic");
    expect(stampTierFor("never_looked_up")).toBe("deterministic");
    expect(stampTierFor("signature_cluster_scan")).toBe("deterministic");
    const s = tierStampSummary();
    expect(s).toMatchObject({ declared: 0, undeclared: 3 });
    expect(s.undeclared_resolvers[0]).toEqual({ resolver: "signature_cluster_scan", count: 2 });
  });

  test("[CONTROL] an unknown tier value on the row is undeclared, never trusted", () => {
    expect(rowTier("quantum")).toBeNull();
    expect(rowTier(7)).toBeNull();
    noteDeclaredTier("x", rowTier("quantum"));
    expect(stampTierFor("x")).toBe("deterministic");
  });

  test("[WIRING] both task records stamp through stampTierFor, the lookup reads the row's resolver_tier, /health reports the counts", () => {
    expect(SRC).not.toMatch(/resolver_tier:\s*"deterministic"/);
    expect(SRC.match(/resolver_tier: stampTierFor\(task\.resolver\),/g)?.length).toBe(2);
    expect(SRC).toContain("return { endpoint: full, tier: rowTier(vessel.resolver_tier) };");
    expect(SRC).toContain("noteDeclaredTier(resolverShape, found.tier);");
    expect(SRC).toContain("tier_stamps: tierStampSummary(),");
  });
});
