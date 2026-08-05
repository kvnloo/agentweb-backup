/**
 * Deterministic markdown -> self-contained HTML document rendering (ENG-873).
 *
 * `create_html_file` normally turns a content draft into HTML with a single
 * monolithic LLM call. That call has a hard per-call budget (Bedrock's 5-minute
 * request/stream timeout), and a large report draft — e.g. a 40-competitor
 * intelligence report, ~45K chars — cannot finish inside it. The render then
 * fails on every attempt, and before this module it took the entire deliverable
 * down with it: a scheduled run completed 100% of its research and ended with no
 * report at all.
 *
 * This renderer is the graceful-degradation path. It uses no LLM, no network and
 * has no size ceiling, so the requested HTML output can always be produced from
 * whatever draft the model already wrote. It deliberately supports a small,
 * predictable subset of markdown (headings, GFM tables, lists, blockquotes,
 * rules, fenced code, and inline emphasis/code/links); anything it does not
 * recognise degrades to escaped text rather than throwing.
 *
 * `marked` is not usable here: it is ESM-only, and the backend's Jest setup maps
 * it to a pass-through stub, so a fallback built on it would be untestable and
 * would emit raw markdown in tests while doing something else in production.
 */

const FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";

// Styles are inline on every element (no <style> block) so the output renders
// consistently as a document AND survives the style stripping that email clients
// apply — create_html_file serves both document and email drafts.
const STYLE = {
  body: `margin:0;padding:0;background-color:#f4f5f7;font-family:${FONT_STACK};color:#1f2933;`,
  container:
    'max-width:900px;margin:0 auto;padding:32px 28px;background-color:#ffffff;line-height:1.6;font-size:16px;',
  h: [
    'font-size:30px;margin:0 0 18px;line-height:1.25;color:#0f172a;font-weight:700;',
    'font-size:24px;margin:32px 0 14px;line-height:1.3;color:#0f172a;font-weight:700;',
    'font-size:20px;margin:26px 0 12px;line-height:1.35;color:#0f172a;font-weight:600;',
    'font-size:18px;margin:22px 0 10px;color:#0f172a;font-weight:600;',
    'font-size:16px;margin:20px 0 8px;color:#0f172a;font-weight:600;',
    'font-size:15px;margin:18px 0 8px;color:#334155;font-weight:600;',
  ],
  p: 'margin:0 0 14px;',
  ul: 'margin:0 0 14px;padding-left:24px;',
  li: 'margin:0 0 6px;',
  quote:
    'margin:0 0 16px;padding:10px 16px;border-left:4px solid #cbd5e1;background-color:#f8fafc;color:#334155;',
  hr: 'border:0;border-top:1px solid #e2e8f0;margin:26px 0;',
  pre:
    'margin:0 0 16px;padding:14px;background-color:#0f172a;color:#e2e8f0;border-radius:6px;overflow-x:auto;font-size:13px;',
  code:
    "padding:2px 5px;background-color:#eef2f7;border-radius:4px;font-family:'SFMono-Regular',Consolas,monospace;font-size:0.92em;",
  table:
    'width:100%;border-collapse:collapse;margin:0 0 18px;font-size:14px;',
  th:
    'border:1px solid #dbe2ea;padding:8px 10px;background-color:#f1f5f9;text-align:left;font-weight:600;color:#0f172a;',
  td: 'border:1px solid #dbe2ea;padding:8px 10px;vertical-align:top;',
  a: 'color:#1d4ed8;',
};

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Render the inline span syntax of one line: code spans, links, bold, italic and
 * strikethrough. Code spans are split out first so markdown syntax inside them
 * stays literal.
 */
export function renderInlineMarkdown(raw: string): string {
  return raw
    .split(/(`[^`]+`)/g)
    .map((part) => {
      if (part.length > 1 && part.startsWith('`') && part.endsWith('`')) {
        return `<code style="${STYLE.code}">${escapeHtml(part.slice(1, -1))}</code>`;
      }
      let out = escapeHtml(part);
      out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_match, text: string, href: string) => {
        // Only http(s)/mailto targets become links — a draft is model-written
        // content, so javascript:/data: URLs must never reach an href.
        if (!/^(https?:\/\/|mailto:)/i.test(href)) return text;
        // `href` is already HTML-escaped (so a query string reads `a=1&amp;b=2`,
        // which is the correct attribute encoding — browsers decode it back).
        return `<a href="${href}" style="${STYLE.a}">${text}</a>`;
      });
      out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
      out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>');
      return out;
    })
    .join('');
}

/** Split one GFM table row into trimmed cells. */
function splitTableRow(row: string): string[] {
  let trimmed = row.trim();
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
  if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1);
  return trimmed.split('|').map((cell) => cell.trim());
}

/** One separator cell: `---`, `:--`, `--:` or `:-:`. */
const separatorCell = /^:?-+:?$/;

/**
 * Recognise a GFM table separator row (`|---|:--:|`).
 *
 * Checked cell by cell rather than with one regex over the whole line: a single
 * pattern needs overlapping quantifiers over the same character class, which
 * backtracks catastrophically on a near-miss line (a long run of pipes and
 * dashes with one stray character) and blocks the event loop. Scraped tables
 * produce exactly that shape, and this renderer is the always-works fallback.
 */
const isTableSeparator = (line: string): boolean => {
  if (!line.includes('|')) return false;
  let sawCell = false;
  for (const cell of line.split('|')) {
    const trimmed = cell.trim();
    if (!trimmed) continue;
    if (!separatorCell.test(trimmed)) return false;
    sawCell = true;
  }
  return sawCell;
};

/** Convert a markdown draft into HTML body markup. */
export function renderMarkdownBody(draft: string): string {
  const lines = String(draft ?? '').replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i++;
      continue;
    }

    // Fenced code block
    if (/^\s*```/.test(line)) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        code.push(lines[i]);
        i++;
      }
      i++; // consume the closing fence (or run off the end on an unclosed block)
      out.push(`<pre style="${STYLE.pre}"><code>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }

    // Table: a row of cells followed by a |---|---| separator
    if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const header = splitTableRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(splitTableRow(lines[i]));
        i++;
      }
      const headHtml = header
        .map((cell) => `<th style="${STYLE.th}">${renderInlineMarkdown(cell)}</th>`)
        .join('');
      const bodyHtml = rows
        .map(
          (row) =>
            `<tr>${row
              .map((cell) => `<td style="${STYLE.td}">${renderInlineMarkdown(cell)}</td>`)
              .join('')}</tr>`,
        )
        .join('');
      out.push(
        `<table style="${STYLE.table}"><thead><tr>${headHtml}</tr></thead><tbody>${bodyHtml}</tbody></table>`,
      );
      continue;
    }

    // Heading
    const heading = /^(#{1,6})\s+(.*)$/.exec(line.trim());
    if (heading) {
      const level = heading[1].length;
      out.push(
        `<h${level} style="${STYLE.h[level - 1]}">${renderInlineMarkdown(heading[2].trim())}</h${level}>`,
      );
      i++;
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      out.push(`<hr style="${STYLE.hr}" />`);
      i++;
      continue;
    }

    // Lists (nesting is flattened — the fallback favours never failing over fidelity)
    const listItem = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/;
    if (listItem.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length && listItem.test(lines[i])) {
        items.push(listItem.exec(lines[i])![1]);
        i++;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(
        `<${tag} style="${STYLE.ul}">${items
          .map((item) => `<li style="${STYLE.li}">${renderInlineMarkdown(item)}</li>`)
          .join('')}</${tag}>`,
      );
      continue;
    }

    // Blockquote
    if (/^\s*>\s?/.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quoted.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      out.push(
        `<blockquote style="${STYLE.quote}">${renderInlineMarkdown(quoted.join(' '))}</blockquote>`,
      );
      continue;
    }

    // Paragraph: consecutive non-blank lines that start no other block
    const paragraph: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\s*```/.test(lines[i]) &&
      !/^(#{1,6})\s+/.test(lines[i].trim()) &&
      !/^(-{3,}|\*{3,}|_{3,})$/.test(lines[i].trim()) &&
      !listItem.test(lines[i]) &&
      !/^\s*>\s?/.test(lines[i]) &&
      !(lines[i].includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1]))
    ) {
      paragraph.push(lines[i].trim());
      i++;
    }
    // Render per line, then join — joining first would let escapeHtml eat the <br />.
    const paragraphHtml = paragraph.map((text) => renderInlineMarkdown(text)).join('<br />');
    out.push(`<p style="${STYLE.p}">${paragraphHtml}</p>`);
  }

  return out.join('\n');
}

/** Wrap rendered body markup in the report's document shell. */
function wrapReportDocument(title: string, body: string): string {
  const safeTitle = escapeHtml(String(title ?? '').trim() || 'Report');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${safeTitle}</title>
</head>
<body style="${STYLE.body}">
<div style="${STYLE.container}">
${body}
</div>
</body>
</html>`;
}

/**
 * Render a draft into a complete, self-contained HTML document. Never throws and
 * never rejects a draft for being too large — that is the whole point: it is the
 * path that guarantees completed work is still delivered when the styled render
 * cannot run.
 */
export function renderMarkdownReportDocument(title: string, draft: string): string {
  return wrapReportDocument(title, renderMarkdownBody(draft as string));
}

/** Per-tag inline styles for markup produced by the remark pipeline. */
const TAG_STYLE: Record<string, string> = {
  h1: STYLE.h[0], h2: STYLE.h[1], h3: STYLE.h[2],
  h4: STYLE.h[3], h5: STYLE.h[4], h6: STYLE.h[5],
  p: STYLE.p, ul: STYLE.ul, ol: STYLE.ul, li: STYLE.li,
  blockquote: STYLE.quote, hr: STYLE.hr, pre: STYLE.pre, code: STYLE.code,
  table: STYLE.table, th: STYLE.th, td: STYLE.td, a: STYLE.a,
};

// A <code> inside <pre> must not get the inline-code chip (light chip on the
// dark code block); it is styled first so the general pass skips it.
const PRE_CODE_STYLE = "font-family:'SFMono-Regular',Consolas,monospace;";

/**
 * Add the report's inline styles to remark's (sanitised, attribute-free)
 * markup. Styles are inline rather than in a <style> block for the same reason
 * the hand-rolled renderer inlines them: create_html_file also produces email
 * drafts, and email clients strip <style>. Tags that already carry a style
 * attribute are left exactly as they are.
 */
export function applyInlineReportStyles(html: string): string {
  return String(html ?? '')
    .replace(
      /<pre([^>]*)>(\s*)<code([^>]*)>/gi,
      (match, preAttrs: string, gap: string, codeAttrs: string) =>
        /\sstyle\s*=/i.test(preAttrs) || /\sstyle\s*=/i.test(codeAttrs)
          ? match
          : `<pre${preAttrs} style="${STYLE.pre}">${gap}<code${codeAttrs} style="${PRE_CODE_STYLE}">`,
    )
    .replace(
      /<(h[1-6]|p|ul|ol|li|blockquote|hr|pre|code|table|th|td|a)((?:\s[^>]*)?)(\/?)>/gi,
      (match, tag: string, attrs: string, selfClose: string) => {
        if (/\sstyle\s*=/i.test(attrs)) return match;
        // Every tag the pattern matches has an entry in TAG_STYLE.
        return `<${tag}${attrs} style="${TAG_STYLE[tag.toLowerCase()]}"${selfClose}>`;
      },
    );
}

/**
 * Render a draft into a complete HTML document using the same remark pipeline
 * the blog publisher uses (remark + GFM + line breaks + SANITISING remark-html
 * — unlike the blog path, untrusted markup in a model-written draft must never
 * execute). It handles markdown the hand-rolled renderer only approximates:
 * nested lists, reference links, entities, setext headings.
 *
 * remark 15 is ESM-only, so it is imported dynamically at call time. If that
 * import fails — or the pipeline throws, or yields nothing — this falls back to
 * the synchronous hand-rolled renderer above. Both paths are guaranteed to
 * return a complete document: this function exists precisely so that a failure
 * at the formatting layer can never discard completed work.
 */
export async function renderMarkdownReportDocumentAsync(
  title: string,
  draft: string,
): Promise<string> {
  const source = String(draft ?? '');
  try {
    const { remark } = await import('remark');
    const remarkHtml = (await import('remark-html')).default;
    const remarkGfm = (await import('remark-gfm')).default;
    const remarkBreaks = (await import('remark-breaks')).default;

    const rendered = remark()
      .use(remarkGfm)
      .use(remarkBreaks)
      .use(remarkHtml)
      .processSync(source)
      .toString();

    if (rendered.trim()) {
      return wrapReportDocument(title, applyInlineReportStyles(rendered));
    }
  } catch (error) {
    console.warn(
      'markdownHtmlReport: remark render unavailable, using the built-in renderer:',
      error instanceof Error ? error.message : error,
    );
  }
  return renderMarkdownReportDocument(title, source);
}
