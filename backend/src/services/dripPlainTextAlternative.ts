/**
 * ENG-2564 (ENG-2167 Phase 1 slice): pure HTML -> text/plain alternative for
 * drip and one-off emails. Multipart messages with a plain-text part score
 * better with spam filters and render in text-only clients.
 *
 * Pure — no I/O. Not yet wired into the send path.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

const BLOCK_TAGS = 'p|div|h[1-6]|li|tr|ul|ol|table|blockquote|section|article|header|footer';
const PARA = '\u0000P\u0000';

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
      const ch = String.fromCodePoint(code);
      return ch === '\u00a0' ? ' ' : ch;
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named ?? match;
  });
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, '');
}

function renderLink(attrs: string, inner: string): string {
  const text = decodeEntities(stripTags(inner)).replace(/\s+/g, ' ').trim();
  const hrefMatch = /\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
  const href = decodeEntities((hrefMatch?.[2] ?? hrefMatch?.[3] ?? hrefMatch?.[4] ?? '').trim());
  if (!href || /^(mailto:|#|javascript:)/i.test(href)) return text;
  if (!text || text === href) return href;
  return `${text} (${href})`;
}

export function htmlToPlainText(html: string): string {
  if (typeof html !== 'string' || html.trim().length === 0) return '';

  let s = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    // Source whitespace is insignificant in HTML; collapse before structure.
    .replace(/\s+/g, ' ')
    .replace(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi, (_m, attrs: string, inner: string) =>
      // Protect rendered link text from the tag stripper below.
      renderLink(attrs, inner).replace(/</g, '\u0001').replace(/>/g, '\u0002').replace(/&/g, '\u0003'),
    )
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(new RegExp(`</?(?:${BLOCK_TAGS})\\b[^>]*>`, 'gi'), PARA);

  s = stripTags(s).split('\u0001').join('<').split('\u0002').join('>');
  s = decodeEntities(s).split('\u0003').join('&');

  const lines = s
    .split(PARA)
    .join('\n\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim());

  // Consecutive list items should stay on adjacent lines.
  const out: string[] = [];
  for (const line of lines) {
    if (line === '') {
      if (out.length > 0 && out[out.length - 1] !== '') out.push('');
      continue;
    }
    if (line.startsWith('- ') && out.length >= 2 && out[out.length - 1] === '' && out[out.length - 2].startsWith('- ')) {
      out.pop();
    }
    out.push(line);
  }
  return out.join('\n').trim();
}
