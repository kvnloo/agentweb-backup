/**
 * Compact, messaging-first brand block for short outreach prompts (ENG-2967).
 *
 * `readBrandGuidelines().formattedContent` is an HTML tool result whose first
 * ~500 characters are a "Brand Guidelines Retrieved" header, brand name,
 * tagline, colors and typography. Prompts that sliced it to 500 chars fed the
 * model hex codes and font names instead of what the sender sells and how they
 * talk. This builds the block from the structured `brandData` instead, keeping
 * only what helps write a message and omitting colors, typography and logos.
 *
 * Pure: no I/O, safe to unit test directly.
 */

import { sliceSafe } from './smartleadSafeText';

export const BRAND_MESSAGING_CONTEXT_MAX_CHARS = 1500;

// Per-field caps so one long field cannot crowd out the rest of the block.
const FIELD_CAPS = {
  brandName: 100,
  tagline: 250,
  valueProposition: 450,
  keyMessages: 450,
  voice: 250,
} as const;
const MAX_KEY_MESSAGES = 5;

function clean(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function cap(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${sliceSafe(text, Math.max(0, max - 1)).replace(/\s+$/, '')}…`;
}

/**
 * Build the block from a `brandData` object (the shape stored on
 * `User.brandGuidelines.brandData`). Returns '' when nothing usable is set.
 */
export function buildBrandMessagingContext(
  brandData: unknown,
  maxChars: number = BRAND_MESSAGING_CONTEXT_MAX_CHARS,
): string {
  if (!brandData || typeof brandData !== 'object') return '';
  const bd = brandData as Record<string, unknown>;

  const lines: string[] = [];
  const brandName = clean(bd.brandName);
  if (brandName) lines.push(`Brand: ${cap(brandName, FIELD_CAPS.brandName)}`);
  const tagline = clean(bd.tagline);
  if (tagline) lines.push(`What we offer: ${cap(tagline, FIELD_CAPS.tagline)}`);
  const valueProposition = clean(bd.valueProposition);
  if (valueProposition) lines.push(`Value proposition: ${cap(valueProposition, FIELD_CAPS.valueProposition)}`);

  const keyMessages = (Array.isArray(bd.keyMessages) ? bd.keyMessages : [])
    .map(clean)
    .filter(Boolean)
    .slice(0, MAX_KEY_MESSAGES);
  if (keyMessages.length > 0) lines.push(`Key messages: ${cap(keyMessages.join('; '), FIELD_CAPS.keyMessages)}`);

  const voice = [clean(bd.toneOfVoice), clean(bd.brandPersonality)].filter(Boolean).join('; ');
  if (voice) lines.push(`Voice/tone: ${cap(voice, FIELD_CAPS.voice)}`);

  return cap(lines.join('\n'), maxChars);
}

/**
 * Same block from a `readBrandGuidelines()` result. The result carries
 * `{ exists, brandData, formattedContent }` — there is no `.content` field, so
 * callers must not read one.
 */
export function brandMessagingContextFromGuidelines(
  guidelines: unknown,
  maxChars: number = BRAND_MESSAGING_CONTEXT_MAX_CHARS,
): string {
  if (!guidelines || typeof guidelines !== 'object') return '';
  const g = guidelines as { exists?: unknown; brandData?: unknown };
  return g.exists ? buildBrandMessagingContext(g.brandData, maxChars) : '';
}
