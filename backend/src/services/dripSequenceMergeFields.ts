/**
 * ENG-2535 (child of ENG-2167): pure merge-field renderer for drip emails.
 *
 * Substitutes `{{field}}` and `{{field|fallback}}` tokens in subject/html/text from a
 * contact record. No I/O, persistence, or sending — the caller decides whether to send.
 *
 * - html output HTML-escapes substituted values (template markup itself is untouched).
 * - subject strips CR/LF from the final string to prevent header injection.
 * - unknown tokens and known-but-blank fields without a fallback are reported in
 *   `missingFields`; in `strict` mode the render fails instead of producing output.
 */

export interface DripTemplate {
  subject: string;
  html?: string;
  text?: string;
}

export type DripContact = Record<string, string | number | null | undefined>;

export interface RenderDripTemplateOptions {
  /** Fail instead of rendering when any field is unknown or missing without fallback. */
  mode?: 'lenient' | 'strict';
  /** Fields recognised as merge fields. Defaults to DEFAULT_DRIP_MERGE_FIELDS. */
  knownFields?: readonly string[];
}

export interface RenderedDripTemplate {
  subject: string;
  html?: string;
  text?: string;
}

export type RenderDripTemplateResult =
  | { ok: true; rendered: RenderedDripTemplate; missingFields: string[] }
  | { ok: false; error: 'missing_merge_fields'; missingFields: string[] };

export const DEFAULT_DRIP_MERGE_FIELDS: readonly string[] = [
  'first_name',
  'last_name',
  'full_name',
  'email',
  'company',
  'title',
  'phone',
  'city',
  'state',
  'country',
  'website',
];

const TOKEN_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:\|([^}]*))?\}\}/g;

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

function contactValue(contact: DripContact, field: string): string {
  const raw = contact[field];
  if (raw === null || raw === undefined) return '';
  return String(raw).trim();
}

function renderPart(
  source: string,
  contact: DripContact,
  known: ReadonlySet<string>,
  escape: boolean,
  missing: Set<string>,
): string {
  return source.replace(TOKEN_RE, (match, field: string, fallback: string | undefined) => {
    const hasFallback = fallback !== undefined;
    const value = known.has(field) ? contactValue(contact, field) : '';
    if (!known.has(field)) {
      // Unknown token: always reported; leave it visible unless a fallback was given.
      missing.add(field);
      if (!hasFallback) return match;
    }
    const resolved = value !== '' ? value : hasFallback ? fallback.trim() : '';
    if (resolved === '' && !hasFallback && known.has(field)) missing.add(field);
    return escape ? escapeHtml(resolved) : resolved;
  });
}

export function renderDripTemplate(
  template: DripTemplate,
  contact: DripContact,
  opts: RenderDripTemplateOptions = {},
): RenderDripTemplateResult {
  const known = new Set(opts.knownFields ?? DEFAULT_DRIP_MERGE_FIELDS);
  const missing = new Set<string>();

  const subject = renderPart(template.subject, contact, known, false, missing)
    .replace(/[\r\n]+/g, ' ')
    .trim();
  const rendered: RenderedDripTemplate = { subject };
  if (template.html !== undefined) {
    rendered.html = renderPart(template.html, contact, known, true, missing);
  }
  if (template.text !== undefined) {
    rendered.text = renderPart(template.text, contact, known, false, missing);
  }

  const missingFields = [...missing].sort();
  if (opts.mode === 'strict' && missingFields.length > 0) {
    return { ok: false, error: 'missing_merge_fields', missingFields };
  }
  return { ok: true, rendered, missingFields };
}
