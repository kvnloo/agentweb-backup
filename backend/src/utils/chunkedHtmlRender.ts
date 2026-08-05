/**
 * Section-wise HTML rendering for large drafts (ENG-873).
 *
 * `create_html_file` renders a content draft into HTML with one LLM call. That
 * call has a hard per-call budget (Bedrock's 5-minute request/stream timeout),
 * and past a certain draft size a single monolithic render is all-or-nothing:
 * a 40-competitor report either finishes inside the budget or the ENTIRE
 * deliverable is lost. Prod bears that out — renders timed out at 45,000 /
 * 42,232 / 37,604 / 31,213 / 25,580 chars and succeeded at 23,010 and below.
 *
 * Above the single-pass ceiling the draft is therefore split into sections,
 * each rendered as an HTML body FRAGMENT in its own call, and the fragments are
 * assembled into one document under a single stylesheet supplied here (not by
 * the model), so sections cannot drift apart visually. Every call is well
 * inside the per-call budget, and a failure is confined to one section instead
 * of taking the whole report down.
 *
 * These helpers are deliberately pure and deterministic: the split preserves
 * every line of the draft, and the assembly step never depends on the model
 * having followed instructions (see extractHtmlFragment).
 */

import { escapeHtml } from './markdownHtmlReport';

const FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";

/**
 * The one stylesheet for an assembled document. Sections are rendered
 * independently, so their look must come from here — element selectors only, so
 * a fragment needs no class vocabulary to be styled correctly.
 */
export const CHUNKED_REPORT_STYLESHEET = `
  body { margin:0; padding:0; background-color:#f4f5f7; font-family:${FONT_STACK}; color:#1f2933; }
  .report { max-width:960px; margin:0 auto; padding:36px 30px; background-color:#ffffff; line-height:1.6; font-size:16px; }
  h1 { font-size:32px; line-height:1.2; margin:0 0 20px; color:#0f172a; }
  h2 { font-size:24px; line-height:1.3; margin:34px 0 14px; color:#0f172a; border-bottom:1px solid #e2e8f0; padding-bottom:8px; }
  h3 { font-size:20px; margin:26px 0 12px; color:#0f172a; }
  h4, h5, h6 { font-size:17px; margin:20px 0 10px; color:#0f172a; }
  p { margin:0 0 14px; }
  ul, ol { margin:0 0 14px; padding-left:24px; }
  li { margin:0 0 6px; }
  a { color:#1d4ed8; }
  blockquote { margin:0 0 16px; padding:10px 16px; border-left:4px solid #cbd5e1; background-color:#f8fafc; color:#334155; }
  hr { border:0; border-top:1px solid #e2e8f0; margin:28px 0; }
  table { width:100%; border-collapse:collapse; margin:0 0 20px; font-size:14px; }
  th { border:1px solid #dbe2ea; padding:9px 11px; background-color:#f1f5f9; text-align:left; font-weight:600; color:#0f172a; }
  td { border:1px solid #dbe2ea; padding:9px 11px; vertical-align:top; }
  code { padding:2px 5px; background-color:#eef2f7; border-radius:4px; font-family:'SFMono-Regular',Consolas,monospace; font-size:0.92em; }
  pre { margin:0 0 16px; padding:14px; background-color:#0f172a; color:#e2e8f0; border-radius:6px; overflow-x:auto; font-size:13px; }
  pre code { background:none; color:inherit; padding:0; }
  img { max-width:100%; height:auto; }
  section { margin:0; }
  @media (max-width:640px) { .report { padding:22px 16px; } table { font-size:13px; } }
`;

/** A heading line (`# ` … `### `) starts a new section. */
const SECTION_HEADING = /^\s{0,3}#{1,3}\s+\S/;
const ANY_HEADING = /^\s{0,3}#{1,6}\s+\S/;

/** Group the draft's lines into sections: a heading plus everything under it. */
function splitIntoSections(draft: string): string[] {
  const sections: string[] = [];
  let current: string[] = [];
  for (const line of draft.split('\n')) {
    if (SECTION_HEADING.test(line) && current.some((l) => l.trim())) {
      sections.push(current.join('\n'));
      current = [];
    }
    current.push(line);
  }
  if (current.some((l) => l.trim())) sections.push(current.join('\n'));
  return sections.map((section) => section.trim()).filter(Boolean);
}

/** Split one oversized section into paragraph-sized pieces. Never splits a line. */
function splitIntoParagraphs(section: string): string[] {
  return section
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

/**
 * Split a draft into render chunks of at most `maxChars`, cutting only at
 * section then paragraph boundaries — never inside a line, so a table row, list
 * item or fenced block is never torn in half. A single paragraph longer than the
 * limit is emitted whole rather than damaged.
 *
 * Every non-blank line of the draft appears exactly once across the chunks, in
 * the original order: the split must never lose content, since the point of the
 * exercise is that completed research survives.
 */
export function splitDraftIntoRenderChunks(draft: string, maxChars: number): string[] {
  const normalised = String(draft ?? '').replace(/\r\n/g, '\n').trim();
  if (!normalised) return [];
  if (!Number.isFinite(maxChars) || maxChars < 1 || normalised.length <= maxChars) {
    return [normalised];
  }

  // Sections that already fit stay atomic; oversized ones drop to paragraphs.
  const pieces: string[] = [];
  for (const section of splitIntoSections(normalised)) {
    if (section.length <= maxChars) pieces.push(section);
    else pieces.push(...splitIntoParagraphs(section));
  }

  const chunks: string[][] = [];
  let current: string[] = [];
  let currentLength = 0;
  for (const piece of pieces) {
    const added = current.length === 0 ? piece.length : currentLength + 2 + piece.length;
    if (current.length > 0 && added > maxChars) {
      chunks.push(current);
      current = [];
      currentLength = 0;
    }
    current.push(piece);
    currentLength = current.length === 1 ? piece.length : currentLength + 2 + piece.length;
  }
  if (current.length > 0) chunks.push(current);

  // A chunk must never end on a bare heading: that heading belongs with the
  // content it introduces, or the next section would be rendered with no idea
  // what it is about. Moving it forward can push a chunk slightly over the
  // limit, which is fine — the limit has margin under the real per-call budget.
  for (let i = 0; i < chunks.length - 1; i++) {
    const chunk = chunks[i];
    while (chunk.length > 1 && ANY_HEADING.test(chunk[chunk.length - 1]) &&
           chunk[chunk.length - 1].split('\n').length === 1) {
      chunks[i + 1].unshift(chunk.pop() as string);
    }
  }

  return chunks.filter((chunk) => chunk.length > 0).map((chunk) => chunk.join('\n\n'));
}

/**
 * Reduce whatever the model returned for one section to a body fragment.
 *
 * The prompt asks for a fragment, but the assembly must not depend on that: a
 * model that returns a whole document, wraps it in a code fence, or emits its
 * own <style>/<script> would otherwise produce a broken or self-conflicting
 * page. Stripping style/script also keeps one section from restyling — or
 * scripting — the rest of the report.
 */
export function extractHtmlFragment(modelOutput: string): string {
  let html = String(modelOutput ?? '').trim();
  if (!html) return '';

  // ```html … ``` fence
  const fenced = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/.exec(html);
  if (fenced) html = fenced[1].trim();

  const body = /<body[^>]*>([\s\S]*?)<\/body\s*>/i.exec(html);
  if (body) {
    html = body[1];
  } else {
    html = html
      .replace(/<!DOCTYPE[^>]*>/gi, '')
      .replace(/<\/?html[^>]*>/gi, '')
      .replace(/<head[^>]*>[\s\S]*?<\/head\s*>/gi, '');
  }

  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '')
    .trim();
}

/** Assemble rendered section fragments into one self-contained document. */
export function assembleChunkedHtmlDocument(title: string, fragments: string[]): string {
  const safeTitle = escapeHtml(String(title ?? '').trim() || 'Report');
  const body = fragments
    .map((fragment) => String(fragment ?? '').trim())
    .filter(Boolean)
    .join('\n');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${safeTitle}</title>
<style>${CHUNKED_REPORT_STYLESHEET}</style>
</head>
<body>
<div class="report">
${body}
</div>
</body>
</html>`;
}
