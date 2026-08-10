/**
 * PURE guard for a final turn that "answers" with serialization residue (ENG-1054).
 *
 * The core loop's only failed-synthesis check was `!content` (see core/termination.ts,
 * ladder step 3). That covers a turn that emitted NOTHING, but not a turn that emitted
 * structural JSON debris — observed in production as a closing assistant message whose
 * entire content was the two characters `}]`. Being non-empty, it satisfied the
 * `final_response` branch: the loop broke, the debris was persisted and shown to the
 * user, and every remaining deliverable of a 215-message run was lost. Worse, the run
 * had already applied money-affecting changes (paused ad campaigns), so the user was
 * left unable to tell what had executed — with a real risk of re-running it.
 *
 * Two pieces, both pure so they are cheap to test and cannot themselves fail a run:
 *   - `isUnusableSynthesis` — is this "answer" actually just serialization residue?
 *   - `buildExecutedActionsFallback` — a truthful recap built from the tool-call
 *     ledger, so a synthesis failure can never erase the record of what ran.
 */

/**
 * Residue is short by nature — it is the tail of a structure the model failed to
 * finish emitting. Anything longer is far likelier to be real (if odd) output, so
 * the guard stays deliberately narrow rather than risk discarding a genuine answer.
 */
const MAX_RESIDUE_LENGTH = 40;

/**
 * Only JSON structural punctuation and whitespace. Deliberately NOT a general
 * "no letters" test: `...`, `—` and emoji-only replies are meaningful, and must
 * never be thrown away.
 */
const STRUCTURAL_ONLY = /^[\s{}[\],:"']+$/;

/**
 * True when `content` is non-empty but carries no answer at all — just leftover
 * JSON structure such as `}]`, `},{` or `"}`.
 *
 * Empty/whitespace content returns FALSE on purpose: that case already has its own
 * bounded handling in the termination ladder, and this guard must not change it.
 */
export function isUnusableSynthesis(content: unknown): boolean {
  if (typeof content !== 'string') return false;
  const trimmed = content.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.length > MAX_RESIDUE_LENGTH) return false;
  return STRUCTURAL_ONLY.test(trimmed);
}

/** The subset of a loop tool-call ledger entry this module reads. */
export interface ExecutedToolCall {
  name?: string;
  /** the loop sets an `error` key on a ledger entry whose tool threw */
  error?: unknown;
}

/**
 * Render a truthful recap of what the run actually executed, for use when the model
 * could not produce a written synthesis. It reports only tool names and outcome
 * counts — never invented results — so it cannot manufacture a false success.
 */
export function buildExecutedActionsFallback(toolCalls: ExecutedToolCall[]): string {
  const counts = new Map<string, { ok: number; failed: number }>();
  for (const call of toolCalls || []) {
    const name = call && typeof call.name === 'string' ? call.name.trim() : '';
    if (!name) continue;
    const entry = counts.get(name) || { ok: 0, failed: 0 };
    if (call && 'error' in call) entry.failed++;
    else entry.ok++;
    counts.set(name, entry);
  }

  const preamble =
    'I ran into a problem writing up my final response for this turn, so the summary below is built directly from the actions I actually ran.';

  if (counts.size === 0) {
    return `${preamble}\n\nNo actions were taken, so nothing has changed. Please send your request again and I'll pick it back up.`;
  }

  const lines: string[] = [];
  for (const [name, { ok, failed }] of counts) {
    const parts: string[] = [];
    if (ok > 0) parts.push(`${ok} succeeded`);
    if (failed > 0) parts.push(`${failed} failed`);
    lines.push(`- ${name} — ${parts.join(', ')}`);
  }

  return [
    preamble,
    '',
    lines.join('\n'),
    '',
    "These actions have already been applied — please don't re-run them. Ask me to summarize what I just did and I'll write up the details.",
  ].join('\n');
}
