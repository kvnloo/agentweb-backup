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
 * This check runs on EVERY dashboard/table-shaped prompt, even one that already
 * contains a concrete-looking $/% value — an earlier version skipped the check
 * whenever a number was already present, reasoning that meant real data had been
 * supplied. Live re-verification disproved that: Emma can (and did) invent a
 * plausible-looking figure directly into the prompt herself (a "progress bar
 * indicator at 75%" with no sourced progress data behind it), which is the exact
 * fabrication this guard exists to catch, not evidence the prompt is safe. A
 * legitimately-sourced real number in a dashboard-shaped prompt will cost one
 * extra describe_image call and produce a warning Emma can disregard — a false
 * positive is a much cheaper mistake than silently shipping invented data.
 */

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/** Dashboard/table/metrics-shaped UI language that invites the model to invent values. */
const DATA_SHAPE_RE =
  /\b(dashboard|status\s+tracker|metrics?\s+(?:preview|panel|card)|kpi|stat(?:s|istic)?\s*(?:card|panel|preview|block)|progress\s+(?:bar|preview)|data[- ]?table|infographic|scorecard|analytics\s+(?:card|panel|dashboard)|comparison\s+table)\b/i;

/**
 * Does this generate_image prompt describe a dashboard/table/metrics-shaped layout?
 * If so, the actual output needs a post-generation check — either the image model
 * invents numbers the prompt never specified, or Emma invented one directly in the
 * prompt (e.g. a progress-bar percentage with no real source), and both look
 * identical to the model that has to render them.
 */
export function promptRisksFabricatedMetrics(prompt: string): boolean {
  if (!isNonEmptyString(prompt)) return false;
  return DATA_SHAPE_RE.test(prompt);
}

/** Phrases a vision description uses to explicitly report no numeric content found. */
const NO_NUMBERS_FOUND_RE =
  /\bno\s+(?:specific\s+)?numbers?\b|\bno\s+numeric\b|\bnone\s+(?:found|present|visible)\b|\bwithout\s+any\s+numbers?\b/i;

/**
 * Given the vision model's answer to the fabricated-metrics check, does it report
 * actual numeric content (which means the check fired for real, not that the vision
 * model itself declined to find anything)?
 */
export function describeImageReportsFabricatedMetrics(description: string): boolean {
  if (!isNonEmptyString(description)) return false;
  if (NO_NUMBERS_FOUND_RE.test(description)) return false;
  return /\d/.test(description);
}

export const FABRICATED_METRICS_CHECK_PROMPT =
  'Does this image contain any specific numbers, percentages, dollar amounts, or other numeric metric VALUES ' +
  '(not just labels or headings)? List exactly what you see, or say "no numbers found" if there are none.';

/** Warning appended to the generate_image tool result so Emma discloses instead of shipping fake data silently. */
export const FABRICATED_METRICS_WARNING =
  'DATA RELIABILITY CHECK: this image renders specific numbers/metrics that were never verified as real — either ' +
  'the image model invented them, or they were an illustrative/placeholder value written into the prompt without ' +
  'an actual data source (known limitation, ENG-1027). Do NOT present these figures to the user as real data. ' +
  'Either disclose in your response that any numbers shown are illustrative placeholders, or regenerate once with ' +
  'an explicit instruction to leave those values blank/placeholder ("--").';
