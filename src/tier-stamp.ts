/**
 * THE TIER STAMPED ON A DISPATCHED TASK IS THE ONE ITS RESOLVER DECLARED (user ruling 2026-10-17T10:22:59Z, "Full
 * declared-tier fix"; gap resolvers-do-not-declare-their-tier-in-registration-so-tier-is-inferred-from-a-name-list).
 *
 * light-dispatch stamped resolver_tier "deterministic" on every task, so activity-api's M4 tier-restricted skip dropped
 * every light-dispatched trace from the bandit update, including the LLM ones (llm_completion_dispatch, 213 of 12,527
 * tasks in 24 h). A vessel now declares each resolver's tier in its registration `resolvers[]`, and discovery echoes it
 * on the shape's capability row as `resolver_tier`. The task is stamped with THAT. A resolver whose vessel has not
 * declared keeps today's "deterministic" stamp exactly, so nothing undeclared changes behaviour. That fallback is
 * removed once undeclared stamps for what this vessel dispatches reach ~0 (/health tier_stamps): the lift condition.
 */
export type ResolverTier = "deterministic" | "pattern" | "llm";
const TIERS: ReadonlySet<string> = new Set(["deterministic", "pattern", "llm"]);

/** The tier a capability row declares; only a known value counts (anything else is undeclared). */
export function rowTier(v: unknown): ResolverTier | null {
  return typeof v === "string" && TIERS.has(v) ? (v as ResolverTier) : null;
}

/** Declared tier per resolver as discovery answered it (cached beside the endpoint); null = undeclared. */
const declared = new Map<string, ResolverTier | null>();
export function noteDeclaredTier(resolver: string, tier: ResolverTier | null): void { declared.set(resolver, tier); }

const stamps = { declared: 0, undeclared: 0, undeclaredByResolver: new Map<string, number>() };
/** The tier to stamp on a task record: the resolver's declared tier, else "deterministic" (today's stamp, unchanged). */
export function stampTierFor(resolver: string): ResolverTier {
  const t = declared.get(resolver) ?? null;
  if (t) { stamps.declared++; return t; }
  stamps.undeclared++;
  stamps.undeclaredByResolver.set(resolver, (stamps.undeclaredByResolver.get(resolver) ?? 0) + 1);
  return "deterministic";
}
/** Declared vs fallback stamps since start, with the undeclared resolvers by count (the lift condition reads this). */
export function tierStampSummary(): { declared: number; undeclared: number; undeclared_resolvers: Array<{ resolver: string; count: number }> } {
  const undeclared_resolvers = [...stamps.undeclaredByResolver].map(([resolver, count]) => ({ resolver, count })).sort((a, b) => b.count - a.count).slice(0, 25);
  return { declared: stamps.declared, undeclared: stamps.undeclared, undeclared_resolvers };
}
/** Test seam: forget declarations and counts. */
export function __resetTierStampsForTests(): void { declared.clear(); stamps.declared = 0; stamps.undeclared = 0; stamps.undeclaredByResolver.clear(); }
