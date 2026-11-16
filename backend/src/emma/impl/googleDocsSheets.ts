/**
 * ENG-2103 (F2) — Google Docs/Sheets tool cluster, extracted from
 * `AgentModeService`.
 *
 * Moved verbatim (behavior byte-identical) from `AgentModeService.prototype.*`:
 * createGoogleDoc, updateGoogleDoc, createGoogleSheet, updateGoogleSheet.
 * Fourth domain cluster after books/whitepapers, GTM plans, and Google Drive —
 * the "Google Docs/Sheets" half of the "Google Workspace" candidate deferred
 * from the Google Drive round, now tractable because that round already
 * promoted `getGoogleDriveOAuthClient`/`driveErrorCode`/`driveThrottleRefusal`
 * to `emma/impl/shared/*` with `AgentModeService`'s own copies delegating —
 * this cluster reuses those directly, no new work needed for them.
 *
 * New shared-helper finding from this round: the markdown-to-HTML/Docs-API
 * conversion pipeline (~600 lines: DEFAULT_STYLE_OPTIONS, inlineToHtml,
 * markdownToHtml, parseInlineRuns, lexMarkdown, buildDocBlocks,
 * markdownToDocsRequests) turned out to be used ONLY by these 4 methods
 * (grepped the whole class — zero other callers), so it moved here entirely
 * rather than needing its own shared module. Its five HTML-escaping primitives
 * (escapeHtml, unescapeHtml, deepEscapeHtmlValues, escapeRegExp,
 * collectRawToEscapedMap), however, ARE also used by
 * `AgentModeService.prototype.createHtmlFromTemplate` (a different,
 * not-yet-extracted "HTML/landing pages" cluster) — promoted to
 * `emma/impl/shared/htmlEscaping.ts` instead, same treatment as the Drive
 * helpers before them.
 *
 * `extractGoogleFileId` is used only by these 4 methods (verified by grep) —
 * moved here directly, no shared module needed, and deleted from the class
 * (zero test references, genuinely dead there after the move).
 *
 * `AgentModeService.prototype.<name>` now delegates to these functions for the
 * 4 tool methods (not `extractGoogleFileId`, which is deleted).
 * `__tests__/agentModeService.googleDrive.test.ts` (the same 3413-line suite
 * that covers the Google Drive cluster) calls `service.<method>(...)` directly
 * on a real instance for all 4, plus tests `markdownToDocsRequests` directly
 * via `AgentModeService.markdownToDocsRequests.bind(AgentModeService)` — a real
 * caller beyond `emma/tools.ts`, so the 4 class methods AND the
 * `markdownToDocsRequests` static delegate could not simply be deleted.
 * `markdownToHtml`, `extractGoogleFileId`, and the rest of the pipeline have no
 * test references and no other callers, so they were deleted from the class
 * rather than kept as delegating stubs.
 *
 * No metering/LLM calls exist anywhere in this cluster (grepped for
 * llmService, generateJSONContent, callLLM, meterUserUsage, currentRunFunding,
 * usageContext — zero matches), so there is nothing for the RunFunding/
 * billingUserId audit (F1 rounds 3-5's bug class) to find here.
 */
import { escapeHtml } from './shared/htmlEscaping';
import { getGoogleDriveOAuthClient } from './shared/googleDriveAccess';
import { driveErrorCode, driveThrottleRefusal } from './shared/googleDriveErrors';

function extractGoogleFileId(urlOrId: string): string {
  const match = urlOrId.match(/\/d\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : urlOrId.trim();
}

// ── Markdown → HTML (for Google Drive HTML import) ───────────────────────

const DEFAULT_STYLE_OPTIONS = {
  primaryColor: '#1a73e8',
  fontFamily: 'Arial, sans-serif',
  fontSize: 14,
  lineHeight: 1.7,
  compact: false,
};

/** Convert inline markdown to HTML string. */
function inlineToHtml(text: string): string {
  let result = '';
  let remaining = text;
  while (remaining.length > 0) {
    let m = remaining.match(/^\*{3}(.+?)\*{3}/s) ?? remaining.match(/^_{3}(.+?)_{3}/s);
    if (m) { result += `<strong><em>${escapeHtml(m[1])}</em></strong>`; remaining = remaining.slice(m[0].length); continue; }
    m = remaining.match(/^\*{2}(.+?)\*{2}/s) ?? remaining.match(/^_{2}(.+?)_{2}/s);
    if (m) { result += `<strong>${escapeHtml(m[1])}</strong>`; remaining = remaining.slice(m[0].length); continue; }
    m = remaining.match(/^\*([^*\n]+?)\*/s) ?? remaining.match(/^_([^_\n]+?)_/s);
    if (m) { result += `<em>${escapeHtml(m[1])}</em>`; remaining = remaining.slice(m[0].length); continue; }
    m = remaining.match(/^`([^`\n]+)`/s);
    if (m) { result += `<code style="background-color:#f1f3f4;padding:1px 5px;border-radius:3px;font-family:Courier New,monospace;font-size:90%;text-decoration:none">${escapeHtml(m[1])}</code>`; remaining = remaining.slice(m[0].length); continue; }
    m = remaining.match(/^\[([^\]]+)\]\(([^)]+)\)/);
    if (m) { result += `<a href="${escapeHtml(m[2])}">${escapeHtml(m[1])}</a>`; remaining = remaining.slice(m[0].length); continue; }
    // Inline style span for a single word/phrase — [text]{color=blue}, [text]{underline},
    // [text]{color=yellow;font=Verdana;italic;underline}, etc. The attribute-string charset is
    // restricted to letters/digits/#/=/;/space — no quotes, parens, or angle brackets can ever
    // appear, so a malformed/hostile value can never break out of the style attribute. Each
    // ';'-separated segment is checked against a fixed whitelist (color, font, bold, italic,
    // underline); unrecognized segments are silently ignored rather than rejecting the whole
    // span. If nothing recognized survives, this doesn't match at all — falls through to plain
    // escaped text below, preserving the original literal text (including the brackets).
    m = remaining.match(/^\[([^\]]+)\]\{([a-zA-Z0-9#=; ]+)\}/);
    if (m) {
      const decls: string[] = [];
      for (const rawSeg of m[2].split(';')) {
        const seg = rawSeg.trim();
        if (!seg) continue;
        if (seg === 'underline') { decls.push('text-decoration:underline'); continue; }
        if (seg === 'italic') { decls.push('font-style:italic'); continue; }
        if (seg === 'bold') { decls.push('font-weight:700'); continue; }
        let am = seg.match(/^color=(#[0-9a-fA-F]{3,8}|[a-zA-Z]+)$/);
        if (am) { decls.push(`color:${am[1]}`); continue; }
        am = seg.match(/^font=([a-zA-Z ]+)$/);
        if (am) { decls.push(`font-family:${am[1]}`); continue; }
        // Unrecognized attribute name/value — ignore silently, do not fail the whole span.
      }
      if (decls.length > 0) {
        result += `<span style="${decls.join(';')}">${escapeHtml(m[1])}</span>`;
        remaining = remaining.slice(m[0].length);
        continue;
      }
      // Nothing recognized — fall through to ordinary text below (do not consume the match).
    }
    m = remaining.match(/^<[^>]+>/);
    if (m) { remaining = remaining.slice(m[0].length); continue; }
    result += escapeHtml(remaining[0]);
    remaining = remaining.slice(1);
  }
  return result;
}

/** Convert markdown to an HTML string for Google Drive HTML import.
 *  style='plain'  → bare semantic HTML; Google Docs applies its own default styling (default)
 *  style='styled' → inline CSS with colors, table headers, and spacing derived from styleOptions
 */
export function markdownToHtml(
  markdown: string,
  style: 'plain' | 'styled' = 'plain',
  styleOptions: {
    primaryColor?: string;
    fontFamily?: string;
    fontSize?: number;
    lineHeight?: number;
    compact?: boolean;
  } = {},
): string {
  if (!markdown?.trim()) return '';
  const tokens = lexMarkdown(markdown);
  const styled = style === 'styled';

  // Resolve options with defaults
  const d = DEFAULT_STYLE_OPTIONS;
  const pc  = styleOptions.primaryColor ?? d.primaryColor;
  const ff  = styleOptions.fontFamily   ?? d.fontFamily;
  const fs  = styleOptions.fontSize     ?? d.fontSize;
  const lh  = styleOptions.lineHeight   ?? d.lineHeight;
  const compact = styleOptions.compact  ?? d.compact;

  // Proportional heading sizes
  const h1fs = Math.round(fs * 1.86);
  const h2fs = Math.round(fs * 1.29);
  const h3fs = fs;

  // Cell padding
  const thPad = compact ? '5px 8px' : '8px 12px';
  const tdPad = compact ? '4px 8px' : '6px 12px';

  // Style tokens — empty strings when plain so attrs are omitted cleanly
  const bodyAttr   = styled ? ` style="font-family:${ff};font-size:${fs}px;color:#202124;line-height:${lh}"` : '';
  const hStyles: Record<number, string> = styled ? {
    1: ` style="font-size:${h1fs}px;font-weight:700;color:${pc};margin-top:12px;margin-bottom:4px;text-decoration:none"`,
    2: ` style="font-size:${h2fs}px;font-weight:600;color:${pc};margin-top:18px;margin-bottom:6px;text-decoration:none"`,
    3: ` style="font-size:${h3fs}px;font-weight:700;color:#3c4043;margin-top:14px;margin-bottom:4px;text-decoration:none"`,
  } : {};
  const pAttr      = styled ? ` style="margin:6px 0;line-height:${lh}"` : '';
  const ulAttr     = styled ? ` style="margin:6px 0;padding-left:22px;line-height:${lh}"` : '';
  const liAttr     = styled ? ' style="margin:3px 0"' : '';
  const bqAttr     = styled ? ` style="border-left:3px solid ${pc};margin:12px 0;padding:6px 14px;background-color:#f8f9fa;color:#5f6368;font-style:italic"` : '';
  const preAttr    = styled ? ` style="background-color:#f8f9fa;border:1px solid #e8eaed;border-radius:4px;padding:14px;margin:10px 0;font-family:Courier New,monospace;font-size:${Math.round(fs * 0.93)}px;overflow-x:auto"` : '';
  const codeAttr   = styled ? ` style="font-family:Courier New,monospace;font-size:${Math.round(fs * 0.93)}px"` : '';
  const tableAttr  = styled ? ` style="border-collapse:collapse;width:100%;margin:10px 0;font-size:${fs}px"` : '';
  const thAttr     = styled ? ` style="padding:${thPad};text-align:left;background-color:${pc};color:#ffffff;font-weight:600;white-space:nowrap"` : '';
  const hrAttr     = styled ? ' style="border:none;border-top:1px solid #d1d5db;margin:16px 0"' : '';

  const tdStyle = (ri: number) => styled
    ? ` style="padding:${tdPad};border-bottom:1px solid #e8eaed;vertical-align:top;background-color:${ri % 2 === 0 ? '#ffffff' : '#f8f9fa'}"`
    : '';

  const parts: string[] = [
    '<!DOCTYPE html>',
    '<html>',
    '<head><meta charset="utf-8"></head>',
    `<body${bodyAttr}>`,
  ];

  for (const tok of tokens) {
    switch (tok.type) {
      case 'heading': {
        const level = Math.min(tok.depth ?? 1, 6);
        const hAttr = hStyles[level] ?? (styled ? ' style="font-weight:700"' : '');
        parts.push(`<h${level}${hAttr}>${inlineToHtml(tok.text ?? '')}</h${level}>`);
        break;
      }
      case 'paragraph':
        parts.push(`<p${pAttr}>${inlineToHtml(tok.text ?? '')}</p>`);
        break;
      case 'list': {
        const tag = tok.ordered ? 'ol' : 'ul';
        parts.push(`<${tag}${ulAttr}>`);
        for (const item of tok.items ?? []) {
          parts.push(`<li${liAttr}>${inlineToHtml(item.text)}`);
          if (item.nestedItems?.length) {
            const ntag = item.nestedItems[0].ordered ? 'ol' : 'ul';
            parts.push(`<${ntag}${ulAttr}>`);
            for (const n of item.nestedItems) {
              parts.push(`<li${liAttr}>${inlineToHtml(n.text)}</li>`);
            }
            parts.push(`</${ntag}>`);
          }
          parts.push(`</li>`);
        }
        parts.push(`</${tag}>`);
        break;
      }
      case 'blockquote':
        parts.push(`<blockquote${bqAttr}><p style="margin:0">${inlineToHtml(tok.text ?? '')}</p></blockquote>`);
        break;
      case 'code': {
        const codeHtml = (tok.codeLines ?? []).map(l => escapeHtml(l)).join('\n');
        parts.push(`<pre${preAttr}><code${codeAttr}>${codeHtml}</code></pre>`);
        break;
      }
      case 'table': {
        parts.push(`<table${tableAttr}>`);
        if (tok.headerCells?.length) {
          parts.push('<thead><tr>');
          for (const cell of tok.headerCells) {
            parts.push(`<th${thAttr}>${inlineToHtml(cell)}</th>`);
          }
          parts.push('</tr></thead>');
        }
        if (tok.dataRows?.length) {
          parts.push('<tbody>');
          tok.dataRows.forEach((row, ri) => {
            parts.push(`<tr>`);
            for (const cell of row) {
              parts.push(`<td${tdStyle(ri)}>${inlineToHtml(cell)}</td>`);
            }
            parts.push('</tr>');
          });
          parts.push('</tbody>');
        }
        parts.push('</table>');
        break;
      }
      case 'hr':
        parts.push(`<hr${hrAttr}>`);
        break;
      case 'space':
        break;
    }
  }

  parts.push('</body></html>');
  return parts.join('\n');
}

// ── Markdown → Google Docs API batchUpdate requests ──────────────────────
// Kept for updateGoogleDoc (batchUpdate on existing docs).
// Self-contained tokenizer (no external dep) handles Emma's markdown output.

/** Parse inline markdown into styled runs. Handles bold, italic, code, links. */
function parseInlineRuns(text: string): Array<{ text: string; bold: boolean; italic: boolean; monospace: boolean; url?: string }> {
  type Run = { text: string; bold: boolean; italic: boolean; monospace: boolean; url?: string };
  const runs: Run[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    // Bold+italic: ***text*** or ___text___
    let m = remaining.match(/^\*{3}(.+?)\*{3}/s) ?? remaining.match(/^_{3}(.+?)_{3}/s);
    if (m) {
      runs.push({ text: m[1], bold: true, italic: true, monospace: false });
      remaining = remaining.slice(m[0].length);
      continue;
    }
    // Bold: **text** or __text__
    m = remaining.match(/^\*{2}(.+?)\*{2}/s) ?? remaining.match(/^_{2}(.+?)_{2}/s);
    if (m) {
      runs.push({ text: m[1], bold: true, italic: false, monospace: false });
      remaining = remaining.slice(m[0].length);
      continue;
    }
    // Italic: *text* or _text_  (single, not preceded by same char)
    m = remaining.match(/^\*([^*\n]+?)\*/s) ?? remaining.match(/^_([^_\n]+?)_/s);
    if (m) {
      runs.push({ text: m[1], bold: false, italic: true, monospace: false });
      remaining = remaining.slice(m[0].length);
      continue;
    }
    // Inline code: `text`
    m = remaining.match(/^`([^`\n]+)`/s);
    if (m) {
      runs.push({ text: m[1], bold: false, italic: false, monospace: true });
      remaining = remaining.slice(m[0].length);
      continue;
    }
    // Link: [text](url) — emit as clickable hyperlink run
    m = remaining.match(/^\[([^\]]+)\]\(([^)]+)\)/);
    if (m) {
      runs.push({ text: m[1], bold: false, italic: false, monospace: false, url: m[2] });
      remaining = remaining.slice(m[0].length);
      continue;
    }
    // Strip HTML tags
    m = remaining.match(/^<[^>]+>/);
    if (m) { remaining = remaining.slice(m[0].length); continue; }

    // Regular character — accumulate into last run if same style
    const last = runs[runs.length - 1];
    if (last && !last.bold && !last.italic && !last.monospace) {
      last.text += remaining[0];
    } else {
      runs.push({ text: remaining[0], bold: false, italic: false, monospace: false });
    }
    remaining = remaining.slice(1);
  }

  return runs.filter(r => r.text.length > 0);
}

/** Lex markdown into block tokens. Handles all common block types. */
function lexMarkdown(markdown: string): Array<{
  type: 'heading' | 'paragraph' | 'list' | 'blockquote' | 'code' | 'table' | 'hr' | 'space';
  depth?: number;
  text?: string;
  ordered?: boolean;
  items?: Array<{ text: string; nestedItems?: Array<{ text: string; ordered: boolean }> }>;
  codeLines?: string[];
  headerCells?: string[];
  dataRows?: string[][];
}> {
  type Block = ReturnType<typeof lexMarkdown>[number];
  const blocks: Block[] = [];
  const lines = markdown.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Code fence (``` or ~~~)
    if (/^(`{3,}|~{3,})/.test(trimmed)) {
      const fence = trimmed.match(/^(`{3,}|~{3,})/)![1];
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence)) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      blocks.push({ type: 'code', codeLines });
      continue;
    }

    // Indented code block (4 spaces or tab)
    if (/^(    |\t)/.test(line) && trimmed) {
      const codeLines: string[] = [];
      while (i < lines.length && (/^(    |\t)/.test(lines[i]) || !lines[i].trim())) {
        codeLines.push(lines[i].replace(/^(    |\t)/, ''));
        i++;
      }
      blocks.push({ type: 'code', codeLines: codeLines.filter(l => l.trim()) });
      continue;
    }

    // Blank line
    if (!trimmed) {
      blocks.push({ type: 'space' });
      i++;
      continue;
    }

    // HR: --- or *** or ___
    if (/^(-{3,}|_{3,}|\*{3,})\s*$/.test(trimmed)) {
      blocks.push({ type: 'hr' });
      i++;
      continue;
    }

    // Heading
    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+?)(?:\s+#+\s*)?$/);
    if (headingMatch) {
      blocks.push({ type: 'heading', depth: headingMatch[1].length, text: headingMatch[2].trim() });
      i++;
      continue;
    }

    // Blockquote
    if (trimmed.startsWith('>')) {
      const bqLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        bqLines.push(lines[i].replace(/^[ \t]*>\s?/, ''));
        i++;
      }
      blocks.push({ type: 'blockquote', text: bqLines.join(' ').trim() });
      continue;
    }

    // List (unordered: - * +, or ordered: 1.)
    const ulStart = /^[-*+]\s+/.test(trimmed);
    const olStart = /^\d+[.)]\s+/.test(trimmed);
    if (ulStart || olStart) {
      const ordered = olStart;
      const items: Array<{ text: string; nestedItems?: Array<{ text: string; ordered: boolean }> }> = [];

      while (i < lines.length) {
        const cur = lines[i];
        const curTrimmed = cur.trim();
        if (!curTrimmed) { i++; break; } // blank line ends list

        // Nested item (2+ spaces indent)
        const nestedUL = cur.match(/^ {2,}[-*+]\s+(.+)/);
        const nestedOL = cur.match(/^ {2,}\d+[.)]\s+(.+)/);
        if ((nestedUL ?? nestedOL) && items.length > 0) {
          const nestedText = (nestedUL ?? nestedOL)![1];
          const last = items[items.length - 1];
          last.nestedItems = last.nestedItems ?? [];
          last.nestedItems.push({ text: nestedText, ordered: !!nestedOL });
          i++;
          continue;
        }

        // Top-level item
        const ulItem = curTrimmed.match(/^[-*+]\s+(.+)/);
        const olItem = curTrimmed.match(/^\d+[.)]\s+(.+)/);
        if (ulItem ?? olItem) {
          items.push({ text: (ulItem ?? olItem)![1] });
          i++;
          continue;
        }

        // Continuation line (indented, no marker)
        if (cur.startsWith('  ') && items.length > 0) {
          items[items.length - 1].text += ' ' + curTrimmed;
          i++;
          continue;
        }

        break;
      }

      if (items.length) blocks.push({ type: 'list', ordered, items });
      continue;
    }

    // Table: header row contains | and next non-blank line is separator (|---|)
    if (trimmed.includes('|')) {
      const nextLine = lines[i + 1]?.trim() ?? '';
      if (/^\|?[-|: ]+\|[-|: ]+\|?$/.test(nextLine) || /^[-|: ]+\|[-|: ]+/.test(nextLine)) {
        const headerCells = trimmed.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
        i += 2; // skip header + separator
        const dataRows: string[][] = [];
        while (i < lines.length && lines[i].trim().includes('|') && lines[i].trim()) {
          const cells = lines[i].trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
          dataRows.push(cells);
          i++;
        }
        blocks.push({ type: 'table', headerCells, dataRows });
        continue;
      }
    }

    // Paragraph (collect until blank line or block-level element)
    const paraLines: string[] = [];
    while (i < lines.length) {
      const cur = lines[i];
      const curTrimmed = cur.trim();
      if (!curTrimmed) break;
      if (/^#{1,6}\s/.test(curTrimmed)) break;
      if (/^(-{3,}|_{3,}|\*{3,})\s*$/.test(curTrimmed)) break;
      if (/^[-*+]\s/.test(curTrimmed) || /^\d+[.)]\s/.test(curTrimmed)) break;
      if (curTrimmed.startsWith('>')) break;
      if (/^(`{3,}|~{3,})/.test(curTrimmed)) break;
      if (/^(    |\t)/.test(cur)) break;
      paraLines.push(curTrimmed);
      i++;
    }
    if (paraLines.length) {
      blocks.push({ type: 'paragraph', text: paraLines.join(' ') });
    }
  }

  return blocks;
}

/** Convert block tokens → DocBlocks with inline runs and style metadata. */
function buildDocBlocks(tokens: ReturnType<typeof lexMarkdown>): Array<{
  text: string;
  runs: Array<{ text: string; bold: boolean; italic: boolean; monospace: boolean; url?: string }>;
  namedStyleType?: string;
  isBullet?: boolean;
  isOrderedBullet?: boolean;
  bulletNestLevel?: number;
  isBlockquote?: boolean;
  isCode?: boolean;
  isBlank?: boolean;
}> {
  type DocBlock = ReturnType<typeof buildDocBlocks>[number];
  const blocks: DocBlock[] = [];

  for (const tok of tokens) {
    switch (tok.type) {
      case 'heading': {
        const level = Math.min(tok.depth ?? 1, 3);
        const runs = parseInlineRuns(tok.text ?? '');
        blocks.push({ text: runs.map(r => r.text).join(''), runs, namedStyleType: `HEADING_${level}` });
        break;
      }
      case 'paragraph': {
        const runs = parseInlineRuns(tok.text ?? '');
        blocks.push({ text: runs.map(r => r.text).join(''), runs });
        break;
      }
      case 'list': {
        for (const item of tok.items ?? []) {
          const runs = parseInlineRuns(item.text);
          blocks.push({
            text: runs.map(r => r.text).join(''),
            runs,
            isBullet: !tok.ordered,
            isOrderedBullet: !!tok.ordered,
            bulletNestLevel: 0,
          });
          for (const nested of item.nestedItems ?? []) {
            const nRuns = parseInlineRuns(nested.text);
            blocks.push({
              text: nRuns.map(r => r.text).join(''),
              runs: nRuns,
              isBullet: !nested.ordered,
              isOrderedBullet: nested.ordered,
              bulletNestLevel: 1,
            });
          }
        }
        break;
      }
      case 'blockquote': {
        const runs = parseInlineRuns(tok.text ?? '');
        if (runs.length) blocks.push({ text: runs.map(r => r.text).join(''), runs, isBlockquote: true });
        break;
      }
      case 'code': {
        for (const codeLine of tok.codeLines ?? []) {
          blocks.push({
            text: codeLine,
            runs: [{ text: codeLine, bold: false, italic: false, monospace: true }],
            isCode: true,
          });
        }
        break;
      }
      case 'table': {
        type Run = { text: string; bold: boolean; italic: boolean; monospace: boolean; url?: string };
        const sep: Run = { text: ' | ', bold: false, italic: false, monospace: false };
        if (tok.headerCells?.length) {
          const headerRuns: Run[] = [];
          tok.headerCells.forEach((cell, ci) => {
            if (ci > 0) headerRuns.push({ ...sep, bold: true });
            parseInlineRuns(cell).forEach(r => headerRuns.push({ ...r, bold: true }));
          });
          blocks.push({ text: headerRuns.map(r => r.text).join(''), runs: headerRuns });
        }
        for (const row of tok.dataRows ?? []) {
          const rowRuns: Run[] = [];
          row.forEach((cell, ci) => {
            if (ci > 0) rowRuns.push(sep);
            rowRuns.push(...parseInlineRuns(cell));
          });
          blocks.push({ text: rowRuns.map(r => r.text).join(''), runs: rowRuns });
        }
        break;
      }
      case 'hr': {
        const hrText = '─────────────────────────────────────────';
        blocks.push({ text: hrText, runs: [{ text: hrText, bold: false, italic: false, monospace: false }] });
        break;
      }
      case 'space':
        blocks.push({ text: '', runs: [], isBlank: true });
        break;
    }
  }

  return blocks;
}

/**
 * Convert markdown to Google Docs API batchUpdate requests.
 * Returns [] when content is blank (caller can skip batchUpdate).
 */
export function markdownToDocsRequests(markdown: string, insertIndex = 1): any[] {
  if (!markdown?.trim()) return [];

  const rawBlocks = buildDocBlocks(lexMarkdown(markdown));

  // Strip leading/trailing blank lines
  while (rawBlocks.length && rawBlocks[0].isBlank) rawBlocks.shift();
  while (rawBlocks.length && rawBlocks[rawBlocks.length - 1].isBlank) rawBlocks.pop();

  if (rawBlocks.length === 0) return [];

  type Meta = { startIndex: number; endIndex: number; block: (typeof rawBlocks)[number] };
  const blockMeta: Meta[] = [];
  let pos = insertIndex;
  let fullText = '';

  for (const block of rawBlocks) {
    const lineText = block.text + '\n';
    blockMeta.push({ startIndex: pos, endIndex: pos + lineText.length, block });
    fullText += lineText;
    pos += lineText.length;
  }

  const requests: any[] = [];

  // 1. Single insertText for all content
  requests.push({ insertText: { location: { index: insertIndex }, text: fullText } });

  // 2. Heading paragraph styles
  for (const { startIndex, endIndex, block } of blockMeta) {
    if (block.namedStyleType) {
      requests.push({
        updateParagraphStyle: {
          range: { startIndex, endIndex },
          paragraphStyle: { namedStyleType: block.namedStyleType },
          fields: 'namedStyleType',
        },
      });
    }
  }

  // 3. Blockquote: indent + italic
  for (const { startIndex, endIndex, block } of blockMeta) {
    if (!block.isBlockquote) continue;
    requests.push({
      updateParagraphStyle: {
        range: { startIndex, endIndex },
        paragraphStyle: { indentStart: { magnitude: 36, unit: 'PT' } },
        fields: 'indentStart',
      },
    });
    requests.push({
      updateTextStyle: {
        range: { startIndex, endIndex: endIndex - 1 },
        textStyle: { italic: true },
        fields: 'italic',
      },
    });
  }

  // 4. Code block: Courier New per non-empty line
  for (const { startIndex, endIndex, block } of blockMeta) {
    if (!block.isCode) continue;
    if (startIndex < endIndex - 1) {
      requests.push({
        updateTextStyle: {
          range: { startIndex, endIndex: endIndex - 1 },
          textStyle: { weightedFontFamily: { fontFamily: 'Courier New', weight: 400 } },
          fields: 'weightedFontFamily',
        },
      });
    }
  }

  // 5. Inline text styles (bold, italic, monospace) per run
  for (const { startIndex, block } of blockMeta) {
    if (block.isBlockquote || block.isCode || block.isBlank) continue;
    let offset = startIndex;
    for (const run of block.runs) {
      const runStart = offset;
      const runEnd = offset + run.text.length;
      offset = runEnd;
      if (runStart >= runEnd) continue;
      const textStyle: any = {};
      const fields: string[] = [];
      if (run.bold) { textStyle.bold = true; fields.push('bold'); }
      if (run.italic) { textStyle.italic = true; fields.push('italic'); }
      if (run.monospace) {
        textStyle.weightedFontFamily = { fontFamily: 'Courier New', weight: 400 };
        fields.push('weightedFontFamily');
      }
      if ((run as any).url) {
        textStyle.link = { url: (run as any).url };
        fields.push('link');
      }
      if (!fields.length) continue;
      requests.push({
        updateTextStyle: {
          range: { startIndex: runStart, endIndex: runEnd },
          textStyle,
          fields: fields.join(','),
        },
      });
    }
  }

  // 6. Bullet/numbered lists — group consecutive bullet blocks
  {
    let i = 0;
    while (i < blockMeta.length) {
      const { block: b } = blockMeta[i];
      if (!b.isBullet && !b.isOrderedBullet) { i++; continue; }
      const isOrdered = !!b.isOrderedBullet;
      let j = i;
      while (
        j + 1 < blockMeta.length &&
        (blockMeta[j + 1].block.isBullet || blockMeta[j + 1].block.isOrderedBullet)
      ) j++;

      requests.push({
        createParagraphBullets: {
          range: { startIndex: blockMeta[i].startIndex, endIndex: blockMeta[j].endIndex - 1 },
          bulletPreset: isOrdered ? 'NUMBERED_DECIMAL_ALPHA_ROMAN_SEQUENCE' : 'BULLET_DISC_CIRCLE_SQUARE',
        },
      });

      // Indent nested items visually
      for (let k = i; k <= j; k++) {
        if ((blockMeta[k].block.bulletNestLevel ?? 0) > 0) {
          requests.push({
            updateParagraphStyle: {
              range: { startIndex: blockMeta[k].startIndex, endIndex: blockMeta[k].endIndex },
              paragraphStyle: {
                indentStart: { magnitude: 36, unit: 'PT' },
                indentFirstLine: { magnitude: 36, unit: 'PT' },
              },
              fields: 'indentStart,indentFirstLine',
            },
          });
        }
      }

      i = j + 1;
    }
  }

  return requests;
}

export async function createGoogleDoc(title: string, content: string, userId: string, folderId?: string, shareWithEmails?: string[], style: 'plain' | 'styled' = 'plain', styleOptions?: { primaryColor?: string; fontFamily?: string; fontSize?: number; lineHeight?: number; compact?: boolean }): Promise<any> {
  // ENG-1277: lazy load — see emma/impl/shared/googleDriveAccess.ts's getGoogleDriveClient for why.
  const { google } = await import('googleapis');
  let docId: string | undefined;
  let drive: any;
  try {
    const auth = await getGoogleDriveOAuthClient(userId);
    drive = google.drive({ version: 'v3', auth });

    const htmlBody = content ? markdownToHtml(content, style, styleOptions) : undefined;
    const createResp = await drive.files.create({
      requestBody: {
        name: title,
        mimeType: 'application/vnd.google-apps.document',
        ...(folderId ? { parents: [folderId] } : {}),
      },
      ...(htmlBody ? { media: { mimeType: 'text/html', body: htmlBody } } : {}),
      fields: 'id,name,webViewLink',
    });
    docId = createResp.data.id!;
    const docUrl = createResp.data.webViewLink || `https://docs.google.com/document/d/${docId}/edit`;

    const emailsToShare = [...new Set(shareWithEmails || [])];
    for (const email of emailsToShare) {
      try {
        await drive.permissions.create({
          fileId: docId,
          sendNotificationEmail: true,
          requestBody: { type: 'user', role: 'writer', emailAddress: email },
        });
      } catch (permErr) {
        console.log(`AgentMode: Could not share Doc ${docId} with ${email}:`, permErr);
      }
    }

    return {
      success: true,
      message: emailsToShare.length ? `Created Google Doc "${title}" and shared with ${emailsToShare.join(', ')}` : `Created Google Doc "${title}"`,
      doc_id: docId,
      url: docUrl,
      title,
    };
  } catch (error: any) {
    console.error('AgentMode: Error creating Google Doc:', error);
    /*
     * ENG-1300 (from main) wanted `code` carried onto the result so a clean 401/403/404
     * classifies as auth/not_found rather than the generic fallback — the `, code }`
     * returns below are its half of that change and are kept.
     *
     * `driveErrorCode` rather than `err?.code || err?.status`: gaxios can surface the
     * status as a STRING, and every comparison below is strict, so '403' matched no
     * branch and fell through to the generic message — losing the very classification
     * ENG-1300 was adding. Same binding, normalised once.
     */
    const code = driveErrorCode(error);
    const throttled = driveThrottleRefusal(error);
    if (throttled) return throttled;
    // ENG-1539: a 401 / invalid_grant / missing connection is an expired or absent Drive
    // authorization, NOT a folder-access problem — the old branch told a root-Drive call with no
    // folder_id to "try without a folder_id", a fix that cannot work. Classify it first.
    if (isDriveAuthExpired(error, code)) {
      return {
        success: false,
        error_type: 'auth_expired',
        message: 'Google Drive authorization has expired or is not connected. Reconnect Google Drive in Settings → Connected Accounts, then retry.',
        code,
      };
    }
    if (code === 403) {
      return folderId
        ? { success: false, error_type: 'permission', message: 'Cannot create Doc in that folder — Emma does not have access to it. Try without a folder_id to create in root Drive.', code }
        : { success: false, error_type: 'permission', message: 'Google Drive refused to create the Doc (permission denied). Reconnect Google Drive with Docs access in Settings → Connected Accounts.', code };
    }
    if (code === 404 && folderId) {
      return { success: false, error_type: 'not_found', message: 'Folder not found. Check the folder ID or omit it to create in root Drive.', code };
    }
    if (code !== undefined && code >= 400 && code < 500) {
      return { success: false, error_type: 'validation', message: `Google Drive rejected the Doc request (${code}): ${error instanceof Error ? error.message : 'invalid request'}`, code };
    }
    return { success: false, error_type: code !== undefined ? 'api' : 'internal', message: `Failed to create Google Doc: ${error instanceof Error ? error.message : 'Unknown error'}`, code };
  }
}

/** ENG-1539: true when a Drive failure means the user's Drive authorization is expired/absent. */
function isDriveAuthExpired(error: any, code: number | undefined): boolean {
  if (code === 401) return true;
  const oauthErr = error?.response?.data?.error;
  if (oauthErr === 'invalid_grant' || oauthErr === 'invalid_token') return true;
  const msg = error instanceof Error ? error.message : String(error ?? '');
  return /invalid_grant|google drive not connected|no refresh token/i.test(msg);
}

export async function updateGoogleDoc(fileIdOrUrl: string, content: string, userId: string, style: 'plain' | 'styled' = 'plain', styleOptions?: { primaryColor?: string; fontFamily?: string; fontSize?: number; lineHeight?: number; compact?: boolean }): Promise<any> {
  // ENG-1277: lazy load — see emma/impl/shared/googleDriveAccess.ts's getGoogleDriveClient for why.
  const { google } = await import('googleapis');
  try {
    const auth = await getGoogleDriveOAuthClient(userId);
    const drive = google.drive({ version: 'v3', auth });
    const fileId = extractGoogleFileId(fileIdOrUrl);

    if (content) {
      const htmlBody = markdownToHtml(content, style, styleOptions);
      await drive.files.update({
        fileId,
        media: { mimeType: 'text/html', body: htmlBody },
      });
    }

    return {
      success: true,
      message: `Updated Google Doc (id: ${fileId})`,
      doc_id: fileId,
      url: `https://docs.google.com/document/d/${fileId}/edit`,
    };
  } catch (error: any) {
    console.error('AgentMode: Error updating Google Doc:', error);
    /*
     * ENG-1300 (from main) wanted `code` carried onto the result so a clean 401/403/404
     * classifies as auth/not_found rather than the generic fallback — the `, code }`
     * returns below are its half of that change and are kept.
     *
     * `driveErrorCode` rather than `err?.code || err?.status`: gaxios can surface the
     * status as a STRING, and every comparison below is strict, so '403' matched no
     * branch and fell through to the generic message — losing the very classification
     * ENG-1300 was adding. Same binding, normalised once.
     */
    const code = driveErrorCode(error);
    const throttled = driveThrottleRefusal(error);
    if (throttled) return throttled;
    if (code === 403 || code === 401) {
      return { success: false, message: 'Cannot update this Google Doc — you may not have edit access to it, or it may have been deleted.', code };
    }
    if (code === 404) {
      return { success: false, message: 'Google Doc not found. Check the URL or ID and try again.', code };
    }
    return { success: false, message: `Failed to update Google Doc: ${error instanceof Error ? error.message : 'Unknown error'}`, code };
  }
}

export async function createGoogleSheet(title: string, data: string[][], userId: string, folderId?: string, shareWithEmails?: string[]): Promise<any> {
  // ENG-1277: lazy load — see emma/impl/shared/googleDriveAccess.ts's getGoogleDriveClient for why.
  const { google } = await import('googleapis');
  let sheetId: string | undefined;
  let drive: any;
  try {
    const auth = await getGoogleDriveOAuthClient(userId);
    drive = google.drive({ version: 'v3', auth });
    const sheets = google.sheets({ version: 'v4', auth });

    const createResp = await drive.files.create({
      requestBody: {
        name: title,
        mimeType: 'application/vnd.google-apps.spreadsheet',
        ...(folderId ? { parents: [folderId] } : {}),
      },
      fields: 'id,name,webViewLink',
    });
    sheetId = createResp.data.id!;
    const sheetUrl = createResp.data.webViewLink || `https://docs.google.com/spreadsheets/d/${sheetId}/edit`;

    if (data && data.length > 0) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: 'Sheet1!A1',
        valueInputOption: 'RAW',
        requestBody: { values: data },
      });
    }

    const emailsToShare = [...new Set(shareWithEmails || [])];
    for (const email of emailsToShare) {
      try {
        await drive.permissions.create({
          fileId: sheetId,
          sendNotificationEmail: true,
          requestBody: { type: 'user', role: 'writer', emailAddress: email },
        });
      } catch (permErr) {
        console.log(`AgentMode: Could not share Sheet ${sheetId} with ${email}:`, permErr);
      }
    }

    return {
      success: true,
      message: emailsToShare.length ? `Created Google Sheet "${title}" and shared with ${emailsToShare.join(', ')}` : `Created Google Sheet "${title}"`,
      sheet_id: sheetId,
      url: sheetUrl,
      title,
    };
  } catch (error: any) {
    if (sheetId && drive) {
      try { await drive.files.delete({ fileId: sheetId }); } catch {}
    }
    console.error('AgentMode: Error creating Google Sheet:', error);
    /*
     * ENG-1300 (from main) wanted `code` carried onto the result so a clean 401/403/404
     * classifies as auth/not_found rather than the generic fallback — the `, code }`
     * returns below are its half of that change and are kept.
     *
     * `driveErrorCode` rather than `err?.code || err?.status`: gaxios can surface the
     * status as a STRING, and every comparison below is strict, so '403' matched no
     * branch and fell through to the generic message — losing the very classification
     * ENG-1300 was adding. Same binding, normalised once.
     */
    const code = driveErrorCode(error);
    const throttled = driveThrottleRefusal(error);
    if (throttled) return throttled;
    if (code === 403 || code === 401) {
      return { success: false, message: 'Cannot create Sheet in that folder — Emma does not have access to it. Try without a folder_id to create in root Drive.', code };
    }
    if (code === 404) {
      return { success: false, message: 'Folder not found. Check the folder ID or omit it to create in root Drive.', code };
    }
    return { success: false, message: `Failed to create Google Sheet: ${error instanceof Error ? error.message : 'Unknown error'}`, code };
  }
}

export async function updateGoogleSheet(fileIdOrUrl: string, range: string, data: string[][], userId: string): Promise<any> {
  // ENG-1277: lazy load — see emma/impl/shared/googleDriveAccess.ts's getGoogleDriveClient for why.
  const { google } = await import('googleapis');
  try {
    const auth = await getGoogleDriveOAuthClient(userId);
    const sheets = google.sheets({ version: 'v4', auth });
    const fileId = extractGoogleFileId(fileIdOrUrl);

    await sheets.spreadsheets.values.update({
      spreadsheetId: fileId,
      range,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: data },
    });

    return {
      success: true,
      message: `Updated Google Sheet (id: ${fileId}) range ${range}`,
      sheet_id: fileId,
      url: `https://docs.google.com/spreadsheets/d/${fileId}/edit`,
      range,
      rows_written: data.length,
    };
  } catch (error: any) {
    console.error('AgentMode: Error updating Google Sheet:', error);
    /*
     * ENG-1300 (from main) wanted `code` carried onto the result so a clean 401/403/404
     * classifies as auth/not_found rather than the generic fallback — the `, code }`
     * returns below are its half of that change and are kept.
     *
     * `driveErrorCode` rather than `err?.code || err?.status`: gaxios can surface the
     * status as a STRING, and every comparison below is strict, so '403' matched no
     * branch and fell through to the generic message — losing the very classification
     * ENG-1300 was adding. Same binding, normalised once.
     */
    const code = driveErrorCode(error);
    const throttled = driveThrottleRefusal(error);
    if (throttled) return throttled;
    if (code === 403 || code === 401) {
      return { success: false, message: 'Cannot update this Google Sheet — it was not created by Emma. Emma can only edit Sheets she created.', code };
    }
    if (code === 404) {
      return { success: false, message: 'Google Sheet not found. Check the URL or ID and try again.', code };
    }
    return { success: false, message: `Failed to update Google Sheet: ${error instanceof Error ? error.message : 'Unknown error'}`, code };
  }
}
