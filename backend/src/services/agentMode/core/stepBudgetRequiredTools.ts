/**
 * ENG-3147: a scheduled report run (Meta_Ads_Perf_Report_Autonomous) spent its whole
 * step budget gathering metrics and hit the iteration limit without ever calling its
 * required deliverable tools (list_html_templates, create_html_from_template). The
 * generic step-budget reminder only said "wrap up soon", so the model wrapped up with
 * a text summary and the run failed validation.
 *
 * When the budget is running low, name the schedule's required tools that have not
 * been called yet this turn so the model reserves its remaining steps for them.
 */

/** Required tool names not yet present in this turn's tool calls (order kept, deduped). */
export function uncalledRequiredTools(
  requiredToolNames: readonly string[] | null | undefined,
  toolCalls: ReadonlyArray<{ name?: unknown }> | null | undefined,
): string[] {
  if (!Array.isArray(requiredToolNames) || requiredToolNames.length === 0) return [];
  const called = new Set<string>();
  for (const call of toolCalls ?? []) {
    if (call && typeof call.name === 'string') called.add(call.name);
  }
  const out: string[] = [];
  for (const name of requiredToolNames) {
    if (typeof name !== 'string' || !name || called.has(name) || out.includes(name)) continue;
    out.push(name);
  }
  return out;
}

/**
 * Suffix for the step-budget reminder, or '' when nothing required is outstanding.
 * Worded conditionally because a required tool may have run in an earlier turn of the
 * same session, which this turn cannot see.
 */
export function requiredToolsBudgetNote(uncalled: readonly string[]): string {
  if (uncalled.length === 0) return '';
  return (
    ` This scheduled run must still call: ${uncalled.join(', ')} (unless already completed earlier in this session).` +
    ' Stop gathering more data now and spend the remaining steps on those calls before your final response.'
  );
}
