// SLOW (~11 s). A /dispatch whose tasks run past 10 s must still answer: the per-task budget
// (task-budget.ts) is the only bound, not the HTTP server. Measured on the gate's bun: a Bun.serve
// handler that takes 11 s is NOT cut by the default idleTimeout (a pending response is not idle), so
// light-dispatch needs no server option. This pins that runtime fact: a bun upgrade that starts
// cutting slow handlers fails here instead of silently truncating every long dispatch.
import { describe, expect, it } from "bun:test";

describe("the runtime does not cut a dispatch longer than the 10 s idle timeout", () => {
  it("[PIN] an 11 s handler under the default server options answers 200", async () => {
    const s = Bun.serve({ port: 0, async fetch() { await Bun.sleep(11_000); return new Response("done"); } });
    try {
      const r = await fetch(`http://127.0.0.1:${s.port}/dispatch`, { method: "POST", body: "{}" });
      expect(`${r.status}:${await r.text()}`).toBe("200:done");
    } finally { s.stop(true); }
  }, 20_000);
});
