/**
 * Default global directives for the onboarding ad-image prompt (WS1a).
 *
 * These two blocks were hardcoded inside buildSixLayerPromptForVariant — the
 * one part of the image prompt that was NOT runtime-editable (the per-archetype
 * layouts already are, via promptTemplatesService). Extracting them here lets
 * the managed store seed + override them so taste people can tune the global
 * directives without a code deploy, and the learning loop (WS1c) can propose
 * edits. They live in their own module so both the builder and the store can
 * import them without a circular dependency.
 *
 * The strings are the EXACT prior inline text — seeding from these keeps the
 * rendered prompt byte-identical until someone edits the managed row.
 */

/**
 * Layer 6 STYLE SPECIFICATION lead (the static part). The builder appends a
 * dynamic "Format confirmation: <dims> <square|vertical> format." sentence
 * after this, so this constant has no trailing space.
 */
export const DEFAULT_IMAGE_STYLE_SPEC =
  "Photorealistic, premium editorial. Mood: confident, trustworthy. " +
  "What this should NOT look like: stock photography, cluttered collages, generic gradient backgrounds, AI-paragraph text walls rendered on the canvas.";

/**
 * The HARD CONSTRAINTS block (the four bullets that re-state the text-budget
 * rules Gemini tends to ignore without an explicit restatement). Joined with
 * newlines — pushed as a single block, identical to the prior four separate
 * line pushes after the final `lines.join("\n")`.
 */
export const DEFAULT_IMAGE_HARD_CONSTRAINTS = [
  "- Respect the TEXT BUDGET in Layer 4 EXACTLY. Count text elements before rendering. If the budget caps the headline at N words, the headline MUST be ≤ N words.",
  "- Do NOT render any sentence longer than the budget allows. If you need to fit more meaning, cut the sentence — do not over-write.",
  "- Every text element MUST be legible at thumbnail size (the ad will appear in a feed). If a text element wouldn't be legible, drop it rather than shrink it.",
  "- All UI text inside dashboards/screens must be coherent English. If you can't render coherent text at the chosen size, use abstract bars/lines/numbers without text — never lorem-ipsum or hallucinated placeholder strings.",
].join("\n");

/**
 * Runtime-overridable global directives for the image prompt. Both fields are
 * optional; an absent field falls back to the DEFAULT_* constant above so the
 * output is byte-identical to the pre-WS1a prompt.
 */
export interface GlobalImageDirectives {
  styleSpec?: string;
  hardConstraints?: string;
}
