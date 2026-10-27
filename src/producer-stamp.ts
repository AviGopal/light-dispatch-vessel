/**
 * EVERY DISPATCHED TASK NAMES THE EXECUTION THAT PRODUCED IT (findings agf_hrgaf1yd89kr / agf_zuaa6xsh4b28, "detectors
 * scored by consumption").
 *
 * A detector tick runs here and files gaps from inside its resolver, but the resolver never learned which execution it
 * was: only an llm_completion_dispatch task was stamped (with `execution_id`, for the plane's request rows). So a gap
 * row a tick filed carried at most a detector NAME, and nothing downstream could credit or charge the execution and
 * template that produced it when the gap was closed, rejected or expired.
 *
 * Every task pointer now carries `producer_execution_id` and `producer_template_id`. They are their own names on
 * purpose: `execution_id` is already an INPUT to resolvers that read a trace by id (development-vessel's
 * execution_trace reads `p.execution_id`), so stamping it would change what those tasks read. The dispatcher is the
 * only party that knows the producing execution, so its stamp replaces any value a template config carries for these
 * two fields: a template cannot name another execution as its producer. Resolvers that do not read them ignore them.
 */
export const PRODUCER_EXECUTION_FIELD = "producer_execution_id";
export const PRODUCER_TEMPLATE_FIELD = "producer_template_id";

/** Stamp the producing execution and template on a task's resolved config (in place; returned for chaining). */
export function stampProducer(config: Record<string, unknown>, ids: { executionId: string; templateId: string }): Record<string, unknown> {
  if (ids.executionId) config[PRODUCER_EXECUTION_FIELD] = ids.executionId;
  if (ids.templateId) config[PRODUCER_TEMPLATE_FIELD] = ids.templateId;
  return config;
}
