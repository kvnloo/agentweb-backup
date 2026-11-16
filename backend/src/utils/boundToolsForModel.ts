/**
 * ENG-2824: bound a tool list to a model's `maxTools` without dropping the tools a run
 * is REQUIRED to call.
 *
 * callLLM used to keep `tools.slice(0, limit)`. A scheduled run on gemini-3.8-flash
 * (maxTools 128) offered 160-204 tools per call, so whatever sat past position 128 was
 * silently never declared to the model. `slack_send_message` sits late in the
 * foundation list, so the Phoenix schedule — which requires it — saw no Slack tool,
 * spent its whole press budget searching for one, and failed validation ("send press
 * budget exhausted with a send requirement still unmet").
 *
 * Contract: when the list fits, it is returned unchanged. When it does not, every
 * priority tool present is kept first (up to the limit), the remaining slots are filled
 * with non-priority tools in their original order, and the result preserves the
 * original relative order of the kept tools.
 */
export function boundToolsForModel<T>(
  tools: T[],
  limit: number,
  priorityToolNames: Iterable<string> | undefined,
  nameOf: (tool: T) => string | undefined = defaultToolName as (tool: T) => string | undefined,
): T[] {
  const cap = Math.max(0, Math.floor(limit));
  if (tools.length <= cap) return tools;
  const priority = new Set(priorityToolNames ?? []);
  if (priority.size === 0) return tools.slice(0, cap);

  const keep = new Set<number>();
  tools.forEach((tool, index) => {
    const name = nameOf(tool);
    if (keep.size < cap && name !== undefined && priority.has(name)) keep.add(index);
  });
  for (let index = 0; index < tools.length && keep.size < cap; index++) keep.add(index);
  return tools.filter((_, index) => keep.has(index));
}

function defaultToolName(tool: any): string | undefined {
  const name = tool?.function?.name ?? tool?.name;
  return typeof name === 'string' ? name : undefined;
}
