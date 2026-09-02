/**
 * Post-generation backstop for generate_image's data-fabrication limitation (ENG-1027).
 *
 * The tool-description guidance (backend/src/emma/tools.ts) tells Emma not to ask
 * generate_image for unknown metrics, and to explicitly instruct blank placeholders
 * when a prompt describes a dashboard/table-shaped layout. That guidance is
 * instruction-following-dependent — nothing stops the underlying image model from
 * inventing numbers anyway, including in prompts that never asked for real data at
 * all (a generic "status tracker" or "metrics preview" UI element is enough; live
 * ENG-1027 verification reproduced this with gemini-3.1-flash-image spontaneously
 * filling in Reach/CTR/Spend figures nobody requested). This module is the
 * enforcement layer: decide when a generated prompt is at risk, and interpret the
 * describe_image vision check run against the actual output afterward.
 *
 * This check runs on every dashboard/table-shaped prompt EXCEPT one Emma has
 * explicitly declared uses only verified real values (the `metrics_verified` tool
 * argument — see generate_image's inputSchema). An earlier version instead guessed
 * from the prompt text (skipping whenever a $/% value was already present), which
 * both missed a real bug (Emma invented "progress bar indicator at 75%" directly in
 * the prompt with no sourced data, and the presence of that number is exactly what
 * let the old heuristic skip the one case it needed to catch) AND risked the
 * opposite mistake: a customer with completely accurate, tool-sourced figures could
 * get told their real numbers "were never verified as real". An explicit boolean
 * Emma has to actively assert is a real forcing function in a way a text guess
 * never is — she can still be wrong, but she has to make a deliberate, auditable
 * claim rather than the system inferring one from prompt shape.
 */

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * Dashboard/table/metrics-shaped UI language that invites the model to invent
 * values. Bare "metrics"/"chart"/"spreadsheet" are intentionally unqualified — all
 * three are low-ambiguity signals in an image-generation prompt (unlike "table",
 * which is also ordinary furniture, so it stays qualified to avoid flagging
 * something like "a laptop on a kitchen table"). This must cover the exact
 * categories the tool description warns about — "a table, chart, or list of
 * metrics" — a fresh independent review of this PR (round 3) found the original
 * regex missed bare "chart", bare "table"/"metrics" phrasing, and percent-complete
 * phrasing that doesn't say "progress bar" verbatim (e.g. "45% complete", "a
 * completion percentage"). Live-replaying the EXACT original bug-reporting prompt
 * post-merge (round 4 — the real customer brief for a "budget-review spreadsheet"
 * image, verbatim) found one more: "spreadsheet" itself was never covered, so the
 * literal scenario that reported ENG-1027 still slipped past the backstop even
 * after all of the above — the fabricated-numbers failure reproduced live in
 * production with no warning, because the prompt said "spreadsheet", not "table".
 */
const DATA_SHAPE_RE =
  /\b(dashboard|status\s+tracker|chart|spreadsheet|metrics?|kpi|stat(?:s|istic)?\s*(?:card|panel|preview|block)|progress\s+(?:bar|preview|ring|indicator|wheel)|completion\s+percentage|percent(?:age)?\s+complete|%\s*complete\b|data[- ]?table|table\s+(?:of|showing|listing|comparing|with)|infographic|scorecard|analytics\s+(?:card|panel|dashboard)|comparison\s+table)\b/i;

/**
 * Does this generate_image prompt describe a dashboard/table/metrics-shaped layout
 * that needs a post-generation check? `metricsVerified` is Emma's own explicit
 * declaration (generate_image's `metrics_verified` argument) that every value in
 * the prompt came from a real tool result this turn — when true, skip the check
 * rather than risk a false "unverified" warning on data that IS real.
 */
export function promptRisksFabricatedMetrics(prompt: string, metricsVerified?: boolean): boolean {
  if (metricsVerified === true) return false;
  if (!isNonEmptyString(prompt)) return false;
  return DATA_SHAPE_RE.test(prompt);
}

/**
 * Preferred response format for the vision check — a single structured line is far
 * more reliable to parse than free prose, whose phrasing varies enough across
 * vision-model responses that a prose-matching regex risks both false positives and
 * false negatives at scale.
 */
export const FABRICATED_METRICS_CHECK_PROMPT =
  'Look at this image and identify any specific numbers, percentages, or dollar amounts shown as data VALUES ' +
  '(not labels, not headings, not decorative text). Respond with EXACTLY one line and nothing else, in this ' +
  'format: "NUMBERS_FOUND: <comma-separated list of the exact values you see>" — for example ' +
  '"NUMBERS_FOUND: 75%, $1,240, 30.00%". If there are no such values, respond "NUMBERS_FOUND: NONE".';

const NUMBERS_FOUND_LINE_RE = /NUMBERS_FOUND:\s*(.+)/i;

/** Fallback prose parsing, used only if the vision model doesn't follow the structured format above. */
const NO_NUMBERS_FOUND_RE =
  /\bno\s+(?:specific\s+)?numbers?\b|\bno\s+numeric\b|\bnone\s+(?:found|present|visible)\b|\bwithout\s+any\s+numbers?\b/i;

/**
 * Given the vision model's answer to the fabricated-metrics check, does it report
 * actual numeric content? Prefers the structured "NUMBERS_FOUND:" line; falls back
 * to prose heuristics only when the model didn't follow that format — and the
 * fallback fails toward FLAGGING (treating an unparseable response as needing
 * disclosure) rather than toward silence, since a missed warning ships fabricated
 * data while an extra one just costs a disregardable caution.
 */
export function describeImageReportsFabricatedMetrics(description: string): boolean {
  if (!isNonEmptyString(description)) return false;
  const structured = description.match(NUMBERS_FOUND_LINE_RE);
  if (structured) {
    const value = structured[1].trim();
    return value.length > 0 && !/^none\b/i.test(value);
  }
  if (NO_NUMBERS_FOUND_RE.test(description)) return false;
  return /\d/.test(description);
}

/** Warning appended to the generate_image tool result so Emma discloses instead of shipping fake data silently. */
export const FABRICATED_METRICS_WARNING =
  'DATA RELIABILITY CHECK: this image renders specific numbers/metrics that were never verified as real — either ' +
  'the image model invented them, or they were an illustrative/placeholder value written into the prompt without ' +
  'an actual data source (known limitation, ENG-1027). Do NOT present these figures to the user as real data. ' +
  'Either disclose in your response that any numbers shown are illustrative placeholders, or regenerate once with ' +
  'an explicit instruction to leave those values blank/placeholder ("--"). If these values ARE real and sourced ' +
  'from a tool result, disregard this warning — call generate_image again with metrics_verified=true next time to ' +
  'skip this check.';

/**
 * ENG-294 already bounds describe_image itself to 90s so a hung vision model fails
 * fast rather than stalling the whole agent turn. This backstop is an ADDED,
 * best-effort check the user never explicitly asked for — 90s of turn budget per
 * triggered image is too expensive for an optional safety net, so it gets its own
 * tighter bound. A timeout here is non-fatal: the caller skips the warning and
 * generate_image still returns its normal successful result.
 */
export const FABRICATED_METRICS_CHECK_TIMEOUT_MS = 20000;
