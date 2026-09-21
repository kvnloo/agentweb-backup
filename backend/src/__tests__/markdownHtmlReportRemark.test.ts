import {
  renderMarkdownReportDocumentAsync,
  applyInlineReportStyles,
} from '../utils/markdownHtmlReport';

// ENG-873: the fallback document is rendered with the same remark pipeline the
// blog publisher uses (remark + GFM + sanitising remark-html), because it copes
// with markdown the hand-rolled renderer flattens (nested lists, reference
// links, entities). remark 15 is ESM-only, so it is loaded with a dynamic
// import at call time and mocked here; if that import fails — or the pipeline
// throws — the renderer MUST still return a complete document, since its whole
// job is that completed research is never lost.
const mockRemarkState: { fail: boolean; failWithString: boolean; html: string } = {
  fail: false,
  failWithString: false,
  html: '',
};

jest.mock('remark', () => ({
  __esModule: true,
  remark: () => {
    // eslint-disable-next-line no-throw-literal
    if (mockRemarkState.failWithString) throw 'remark exploded';
    if (mockRemarkState.fail) throw new Error('Cannot use import statement outside a module');
    const processor: any = {
      use: () => processor,
      processSync: () => ({ toString: () => mockRemarkState.html }),
    };
    return processor;
  },
}));
jest.mock('remark-gfm', () => ({ __esModule: true, default: () => undefined }));
jest.mock('remark-breaks', () => ({ __esModule: true, default: () => undefined }));
jest.mock('remark-html', () => ({ __esModule: true, default: () => undefined }));

describe('renderMarkdownReportDocumentAsync (ENG-873)', () => {
  beforeEach(() => {
    mockRemarkState.fail = false;
    mockRemarkState.failWithString = false;
    mockRemarkState.html = '';
  });

  describe('failure paths', () => {
    it('falls back to the deterministic renderer when the remark import fails', async () => {
      mockRemarkState.fail = true;
      const html = await renderMarkdownReportDocumentAsync('Report', '# Heading\n\nBody text.');
      expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
      expect(html).toContain('Heading');
      expect(html).toContain('Body text.');
    });

    it('falls back when the pipeline returns nothing usable', async () => {
      mockRemarkState.html = '   ';
      const html = await renderMarkdownReportDocumentAsync('Report', '## Section\n\nKept.');
      expect(html).toContain('Kept.');
      expect(html).toContain('</html>');
    });

    it('falls back when the pipeline throws a non-Error value', async () => {
      mockRemarkState.failWithString = true;
      const warn = jest.spyOn(console, 'warn').mockImplementation();

      const html = await renderMarkdownReportDocumentAsync('Report', '## S\n\nKept.');

      expect(html).toContain('Kept.');
      expect(warn).toHaveBeenCalledWith(expect.any(String), 'remark exploded');
      warn.mockRestore();
    });

    it('still produces a document for an empty draft', async () => {
      mockRemarkState.html = '';
      const html = await renderMarkdownReportDocumentAsync('Empty', '');
      expect(html).toContain('<title>Empty</title>');
      expect(html).toContain('</html>');
    });

    it('does not throw on non-string inputs', async () => {
      mockRemarkState.fail = true;
      const html = await renderMarkdownReportDocumentAsync(
        undefined as any,
        undefined as any,
      );
      expect(html).toContain('<title>Report</title>');
    });
  });

  describe('rendered output', () => {
    it('uses the remark output and wraps it in a complete document', async () => {
      mockRemarkState.html = '<h1>Q3</h1>\n<ul>\n<li>top\n<ul>\n<li>nested</li>\n</ul>\n</li>\n</ul>';
      const html = await renderMarkdownReportDocumentAsync('Q3 Report', '# Q3\n\n- top\n  - nested');
      expect(html).toContain('<title>Q3 Report</title>');
      // Nested lists are exactly what the hand-rolled fallback flattens.
      expect(html).toMatch(/<ul[^>]*>[\s\S]*<ul[^>]*>[\s\S]*nested/);
      expect(html.trimEnd().endsWith('</html>')).toBe(true);
    });

    it('escapes the title even on the remark path', async () => {
      mockRemarkState.html = '<p>ok</p>';
      const html = await renderMarkdownReportDocumentAsync('A & B <script>', 'ok');
      expect(html).toContain('<title>A &amp; B &lt;script&gt;</title>');
      expect(html).not.toContain('<title>A & B <script>');
    });

    it('inlines styles on the rendered markup so email clients keep the design', async () => {
      mockRemarkState.html = '<h2>S</h2>\n<p>Body</p>\n<table><thead><tr><th>A</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>';
      const html = await renderMarkdownReportDocumentAsync('Styled', 'x');
      expect(html).toMatch(/<h2 style="[^"]+">S<\/h2>/);
      expect(html).toMatch(/<p style="[^"]+">Body<\/p>/);
      expect(html).toMatch(/<table style="[^"]+"/);
      expect(html).toMatch(/<th style="[^"]+"/);
      expect(html).toMatch(/<td style="[^"]+"/);
    });
  });
});

describe('applyInlineReportStyles', () => {
  it('adds a style attribute to known block and inline tags', () => {
    const styled = applyInlineReportStyles('<h1>T</h1><p>P</p><ul><li>i</li></ul><blockquote>q</blockquote><hr>');
    expect(styled).toMatch(/<h1 style="/);
    expect(styled).toMatch(/<p style="/);
    expect(styled).toMatch(/<ul style="/);
    expect(styled).toMatch(/<li style="/);
    expect(styled).toMatch(/<blockquote style="/);
    expect(styled).toMatch(/<hr style="/);
  });

  it('keeps existing attributes and never double-styles', () => {
    const styled = applyInlineReportStyles('<a href="https://x.com">x</a><p style="color:red">P</p>');
    expect(styled).toContain('href="https://x.com"');
    expect(styled).toMatch(/<a href="https:\/\/x\.com" style="/);
    expect(styled).toContain('<p style="color:red">P</p>');
    expect(styled.match(/<p style=/g)).toHaveLength(1);
  });

  it('does not give a code block inside <pre> the inline-code chip styling', () => {
    const styled = applyInlineReportStyles('<pre><code>const x = 1;</code></pre>');
    const codeStyle = /<code style="([^"]*)"/.exec(styled);
    expect(codeStyle).not.toBeNull();
    expect(codeStyle![1]).not.toContain('background-color:#eef2f7');
  });

  it('leaves an already-styled <pre><code> block untouched', () => {
    const already = '<pre style="color:red"><code>x</code></pre>';
    expect(applyInlineReportStyles(already)).toContain('<pre style="color:red">');
    const codeStyled = '<pre><code style="color:blue">x</code></pre>';
    expect(applyInlineReportStyles(codeStyled)).toContain('<code style="color:blue">');
  });

  it('leaves unknown tags and plain text alone', () => {
    expect(applyInlineReportStyles('<section>text</section>')).toBe('<section>text</section>');
    expect(applyInlineReportStyles('')).toBe('');
    expect(applyInlineReportStyles(undefined as any)).toBe('');
  });
});
