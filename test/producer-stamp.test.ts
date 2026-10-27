// Findings agf_hrgaf1yd89kr / agf_zuaa6xsh4b28 ("detectors scored by consumption"): a dispatched task never learned
// which execution and template it ran under (only llm_completion_dispatch got `execution_id`), so a gap a detector tick
// filed could not be credited back to it. MUST-FAIL on the parent: src/producer-stamp.ts does not exist and the dispatch
// loop stamps nothing on a non-LLM task.
// Fixture values come from a 5-word draw (draw-words.sh 2026-10-27T05:47:27Z: dress comic covenant diffusive quill).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PRODUCER_EXECUTION_FIELD, PRODUCER_TEMPLATE_FIELD, stampProducer } from "../src/producer-stamp";

const SRC = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf8");
const IDS = { executionId: "exec_quillcovenan", templateId: "development-vessel:detect-diffusive-comic-dress" };

describe("every dispatched task names its producing execution and template", () => {
  test("[MUST-FAIL] a non-LLM detector task's pointer carries producer_execution_id and producer_template_id", () => {
    const config: Record<string, unknown> = { minPicks: 1, note: "covenant quill" };
    stampProducer(config, IDS);
    expect(config[PRODUCER_EXECUTION_FIELD]).toBe("exec_quillcovenan");
    expect(config[PRODUCER_TEMPLATE_FIELD]).toBe("development-vessel:detect-diffusive-comic-dress");
    expect(config["minPicks"]).toBe(1);
  });

  test("[MUST-FAIL] the dispatch loop stamps every task before it is resolved", () => {
    const stamp = SRC.indexOf("stampProducer(config, { executionId, templateId });");
    const send = SRC.indexOf("await resolveTaskWithRetry(endpoint, pointerType, config, budgetMs);");
    expect(stamp).toBeGreaterThan(0);
    expect(send).toBeGreaterThan(stamp);
    // Not inside the LLM-only branch: the stamp is its own statement.
    expect(SRC).toContain('if (pointerType === "llm_completion_dispatch" && config["execution_id"] === undefined) config["execution_id"] = executionId;\n');
  });

  test("[CONTROL] the stamp never sets or changes execution_id, which some resolvers read as an input", () => {
    const own: Record<string, unknown> = { execution_id: "exec_dresscomic01" };
    stampProducer(own, IDS);
    expect(own["execution_id"]).toBe("exec_dresscomic01");
    const none: Record<string, unknown> = {};
    stampProducer(none, IDS);
    expect("execution_id" in none).toBe(false);
  });

  test("[CONTROL] a template cannot name another execution as its producer: the dispatcher's stamp wins", () => {
    const forged: Record<string, unknown> = { producer_execution_id: "exec_someoneelse", producer_template_id: "other" };
    stampProducer(forged, IDS);
    expect(forged[PRODUCER_EXECUTION_FIELD]).toBe("exec_quillcovenan");
    expect(forged[PRODUCER_TEMPLATE_FIELD]).toBe("development-vessel:detect-diffusive-comic-dress");
  });

  test("[CONTROL] an empty id stamps nothing rather than an empty producer", () => {
    const c: Record<string, unknown> = {};
    stampProducer(c, { executionId: "", templateId: "" });
    expect(c).toEqual({});
  });
});
