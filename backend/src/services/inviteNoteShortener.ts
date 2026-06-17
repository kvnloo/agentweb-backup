/**
 * Capped LLM re-generation for over-limit LinkedIn invite-note DRAFTS.
 *
 * Layer 1 of invite-note length control is asking the model to write short up front;
 * the deterministic LinkedInOutreachService.trimInviteMessage() is the hard fallback.
 * This helper sits between them on the DRAFT paths only: when a drafted note still
 * exceeds the account's char limit, we ask the model to rewrite it shorter, up to a
 * bounded number of attempts. The caller MUST still run trimInviteMessage() afterwards
 * as the guarantee — re-generation is best-effort and cannot reliably count characters.
 *
 * This is intentionally NOT used on the agent inline send path: that path threw and
 * looped on over-limit notes in a real session, so it stays pure deterministic trim.
 */

/** Extract the note text from a Gemini JSON-ish response, tolerating markdown fences. */
function extractContent(raw: string): string {
  if (!raw) return '';
  let cleaned = raw.replace(/```json\s*/g, '').replace(/\s*```/g, '').trim();
  // Complete a response truncated mid-JSON (ends with a quote but no closing brace).
  if (cleaned.includes('"content"') && !cleaned.endsWith('}')) {
    if (!cleaned.endsWith('"')) cleaned += '"';
    cleaned += '}';
  }
  const braceStart = cleaned.indexOf('{');
  const braceEnd = cleaned.lastIndexOf('}');
  if (braceStart !== -1 && braceEnd > braceStart) {
    try {
      const parsed = JSON.parse(cleaned.slice(braceStart, braceEnd + 1));
      let val = String(parsed.content ?? '');
      // Gemini sometimes double-encodes: the value is itself JSON like {"content":"..."}.
      if (val.startsWith('{') && val.includes('"content"')) {
        try { val = String(JSON.parse(val).content ?? val); } catch { /* keep val */ }
      }
      return val;
    } catch {
      // Fall through to quote extraction.
    }
  }
  const tag = cleaned.indexOf('"content"');
  if (tag !== -1) {
    const firstQ = cleaned.indexOf('"', tag + 10);
    const lastQ = cleaned.lastIndexOf('"');
    if (firstQ !== -1 && lastQ > firstQ) {
      return cleaned.slice(firstQ + 1, lastQ).replace(/\\"/g, '"');
    }
  }
  return '';
}

/**
 * Ask the model to rewrite an over-limit invite note under `limit` characters, retrying
 * up to `attempts` times. Returns the shortest valid candidate seen (the original note if
 * nothing better was produced). Never throws — a model error returns the best-so-far.
 * The caller is responsible for the final hard trim.
 */
export async function shortenInviteNoteToLimit(
  geminiClient: any,
  note: string,
  limit: number,
  attempts: number = 2,
): Promise<string> {
  let best = note;
  if (best.length <= limit) return best;

  for (let i = 0; i < attempts && best.length > limit; i++) {
    const prompt = `Rewrite this LinkedIn connection request note so it is UNDER ${limit} characters total. Keep the meaning, the recipient's first name, and a natural one-human-to-another tone. Do NOT start with Hi or Hello, no call to action, no emojis. Tighten wording and drop the least important detail rather than truncating mid-sentence.

Reply with ONLY valid JSON: {"content": "the shorter note"}

Note to shorten:
${best}`;
    try {
      const completion = await geminiClient.chat.completions.create({
        model: 'gemini-3.5-flash',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.4,
        max_tokens: 2048,
      });
      const candidate = extractContent(completion?.choices?.[0]?.message?.content || '');
      // Only accept a candidate that actually moves us forward (shorter than best).
      if (candidate && candidate.length < best.length) best = candidate;
    } catch {
      break; // network/model error — keep best-so-far, let the caller trim.
    }
  }

  return best;
}
