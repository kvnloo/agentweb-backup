/**
 * ENG-2535 (ENG-2167 slice): pure drip-email merge-field renderer.
 *
 * Substitutes `{{field}}` / `{{field|fallback}}` tokens in a drip step's
 * subject/html/text from a contact record. Pure: no persistence, no Resend
 * calls. Not yet wired into dripSequenceWorker (follow-up).
 */

export interface DripTemplate {
  subject: string;
  html: string;
  text: string;
}

export type DripContactFields = Record<string, string | number | null | undefined>;

export interface RenderOptions {
  /** `strict` blocks rendering when any token resolves to nothing. Default `lenient`. */
  mode?: 'lenient' | 'strict';
}

export type RenderResult =
  | ({ ok: true; missingFields: string[] } & DripTemplate)
  | { ok: false; error: 'missing_merge_fields'; missingFields: string[] };

const TOKEN = /\{\{\s*([A-Za-z0-9_.-]+)\s*(?:\|([^}]*))?\}\}/g;

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

function lookup(contact: DripContactFields, field: string): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(contact, field)) return undefined;
  const v = contact[field];
  if (v === null || v === undefined) return undefined;
  const s = String(v);
  return s.trim() === '' ? undefined : s;
}

export function renderDripTemplate(
  template: DripTemplate,
  contact: DripContactFields,
  opts: RenderOptions = {},
): RenderResult {
  const missing: string[] = [];

  const render = (src: string, escape: boolean): string =>
    src.replace(TOKEN, (_m, field: string, fallback: string | undefined) => {
      const value = lookup(contact, field) ?? (fallback !== undefined ? fallback.trim() : undefined);
      if (value === undefined) {
        if (!missing.includes(field)) missing.push(field);
        return '';
      }
      return escape ? escapeHtml(value) : value;
    });

  const subject = render(template.subject, false).replace(/[\r\n]+/g, ' ');
  const html = render(template.html, true);
  const text = render(template.text, false);

  if (opts.mode === 'strict' && missing.length > 0) {
    return { ok: false, error: 'missing_merge_fields', missingFields: missing };
  }
  return { ok: true, subject, html, text, missingFields: missing };
}
