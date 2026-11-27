/**
 * ENG-2840: plain text of an HTML report, for the reports search (the "searchable text" backfill in routes/tasks.ts).
 *
 * The backfill used regular expressions (`<style[^>]*>[\s\S]*?<\/style>`, `<[^>]+>`) whose run time grows with the square of the input on
 * hostile HTML (many "<" or "<style" with no closing ">"): about 16 s of a blocked event loop for 200 KB. A signed-in user can place such
 * a file in their own reports and then open the reports page. This version does the same work in time linear in the input:
 *   - `<style ...>...</style>` and `<script ...>...</script>` blocks are removed with forward `indexOf` scans (an unclosed block is left
 *     in place, as the old pattern left it);
 *   - any other tag is removed with `<[^<>]*>`, which stops at the next "<" instead of scanning to the end;
 *   - whitespace is collapsed and the text is cut to `maxLength`.
 */

/** ASCII-only lower case: keeps every index of the original string (a full toLowerCase can change the length of some characters). */
function asciiLower(text: string): string {
  return text.replace(/[A-Z]+/g, (run) => run.toLowerCase());
}

function removeBlocks(html: string, tag: 'style' | 'script'): string {
  const lower = asciiLower(html);
  const open = `<${tag}`;
  const close = `</${tag}>`;
  let out = '';
  let from = 0;
  for (;;) {
    const start = lower.indexOf(open, from);
    if (start < 0) break;
    const openEnd = lower.indexOf('>', start + open.length);
    if (openEnd < 0) break;
    const end = lower.indexOf(close, openEnd + 1);
    if (end < 0) break;
    out += `${html.slice(from, start)} `;
    from = end + close.length;
  }
  return out + html.slice(from);
}

export function htmlToSearchableText(html: string, maxLength: number): string {
  return removeBlocks(removeBlocks(html, 'style'), 'script')
    .replace(/<[^<>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}
