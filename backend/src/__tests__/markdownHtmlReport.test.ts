import { renderMarkdownReportDocument } from '../utils/markdownHtmlReport';

// ENG-873: create_html_file renders a content draft into HTML with a single
// monolithic LLM call that has a hard per-call timeout. On a large report draft
// that call fails deterministically, and the whole deliverable used to be lost
// with it. This renderer is the graceful-degradation path: no LLM, no network,
// no size ceiling — so the requested HTML output is always produced.
describe('renderMarkdownReportDocument', () => {
  describe('invalid / edge inputs', () => {
    it('still produces a complete HTML document for an empty draft', () => {
      const html = renderMarkdownReportDocument('Empty Report', '');
      expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
      expect(html).toContain('</html>');
      expect(html).toContain('Empty Report');
    });

    it('does not throw on a non-string draft and escapes the title', () => {
      const html = renderMarkdownReportDocument('A & B <script>', undefined as any);
      expect(html).toContain('<title>A &amp; B &lt;script&gt;</title>');
      expect(html).not.toContain('<script>');
    });

    it('escapes raw HTML in the draft instead of emitting it as markup', () => {
      const html = renderMarkdownReportDocument(
        'Escaping',
        'Danger: <script>alert(1)</script> & "quotes"',
      );
      expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).toContain('&amp;');
    });

    it('falls back to a generic title when none is supplied', () => {
      const html = renderMarkdownReportDocument('   ', 'Body text');
      expect(html).toContain('<title>Report</title>');
    });

    it('rejects a non-http(s) link target rather than emitting it as an href', () => {
      const html = renderMarkdownReportDocument('Links', 'See [click me](javascript:alert(1)) now');
      expect(html).not.toContain('javascript:');
      expect(html).toContain('click me');
    });
  });

  describe('markdown rendering', () => {
    it('renders headings, paragraphs, lists, emphasis and links', () => {
      const html = renderMarkdownReportDocument(
        'Competitor Report',
        [
          '# Competitor Report',
          '',
          'Tracking **40** competitors this month.',
          '',
          '## Alerts',
          '',
          '- Edifecs acquired',
          '- Predoc raised a Series A',
          '',
          '1. First',
          '2. Second',
          '',
          '> Watch the retrieval segment.',
          '',
          '---',
          '',
          'Source: [Crunchbase](https://www.crunchbase.com/a?b=1&c=2)',
        ].join('\n'),
      );

      expect(html).toContain('<h1');
      expect(html).toContain('Competitor Report');
      expect(html).toContain('<h2');
      expect(html).toContain('<strong>40</strong>');
      expect(html).toContain('<ul');
      expect(html).toContain('<li');
      expect(html).toContain('Edifecs acquired');
      expect(html).toContain('<ol');
      expect(html).toContain('<blockquote');
      expect(html).toContain('<hr');
      // `&` is escaped in the attribute — the correct HTML encoding for a query string.
      expect(html).toContain('href="https://www.crunchbase.com/a?b=1&amp;c=2"');
    });

    it('renders GFM tables as real table markup', () => {
      const html = renderMarkdownReportDocument(
        'Table',
        ['| Company | Funding |', '|---------|---------|', '| Predoc | $30M |', '| Edifecs | n/a |'].join('\n'),
      );

      expect(html).toContain('<table');
      expect(html).toContain('<th');
      expect(html).toContain('Company');
      expect(html).toContain('<td');
      expect(html).toContain('$30M');
      // The separator row must not leak into the body as a data row.
      expect(html).not.toContain('---------');
    });

    it('does not stall on a long pipe-and-dash line that is not a separator', () => {
      // Scraped tables produce long near-miss separator lines. Matching one with
      // a backtracking regex took ~100s on a 10K-char line and blocked the event
      // loop, so the always-works fallback could hang the backend.
      const nearMiss = `|${'---|'.repeat(3000)}+`;
      const start = Date.now();
      const html = renderMarkdownReportDocument('Scraped', ['| Company | Funding |', nearMiss].join('\n'));
      expect(Date.now() - start).toBeLessThan(1000);
      // The near-miss line is not a separator, so no table is opened.
      expect(html).not.toContain('<table');
    });

    it('keeps wrapped paragraph lines together and ends the paragraph at the next block', () => {
      // Real drafts run blocks together without blank separator lines, so a
      // paragraph must stop at whatever block starts next.
      const html = renderMarkdownReportDocument(
        'Blocks',
        [
          'First line of the intro',
          'second line of the intro',
          '## Section',
          'Lead-in sentence',
          '| Company | Funding |',
          '|---|---|',
          '| Predoc | $30M |',
          'After the table',
          '- bullet',
          '> quoted',
          '---',
          '```',
          'code',
          '```',
        ].join('\n'),
      );

      expect(html).toContain('First line of the intro<br />second line of the intro');
      expect(html).toContain('<h2');
      expect(html).toContain('<p style="margin:0 0 14px;">Lead-in sentence</p>');
      expect(html).toContain('<table');
      expect(html).toContain('After the table');
      expect(html).toContain('<li');
      expect(html).toContain('<blockquote');
      expect(html).toContain('<hr');
      expect(html).toContain('<pre');
    });

    it('renders fenced code blocks literally', () => {
      const html = renderMarkdownReportDocument('Code', ['```', 'const a = 1 < 2;', '```'].join('\n'));
      expect(html).toContain('<pre');
      expect(html).toContain('const a = 1 &lt; 2;');
    });

    it('leaves markdown syntax inside inline code untouched', () => {
      const html = renderMarkdownReportDocument('Inline', 'Use `**not bold**` here');
      expect(html).toContain('<code');
      expect(html).toContain('**not bold**');
    });
  });

  describe('large payloads (the ENG-873 case)', () => {
    it('renders a draft far larger than the single-pass LLM render ceiling', () => {
      const rows = Array.from({ length: 40 }, (_, i) => `| Competitor ${i + 1} | $${i}M | ${i * 3} staff |`);
      const draft = [
        '# Monthly Competitor Intelligence Report',
        '',
        '| Company | Funding | Headcount |',
        '|---|---|---|',
        ...rows,
        '',
        'x'.repeat(80000),
      ].join('\n');

      const html = renderMarkdownReportDocument('Monthly Competitor Intelligence Report', draft);

      expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
      expect(html).toContain('Competitor 40');
      expect(html.length).toBeGreaterThan(80000);
    });
  });
});
