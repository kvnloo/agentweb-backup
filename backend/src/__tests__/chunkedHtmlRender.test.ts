import {
  splitDraftIntoRenderChunks,
  extractHtmlFragment,
  assembleChunkedHtmlDocument,
} from '../utils/chunkedHtmlRender';

describe('chunkedHtmlRender (ENG-873)', () => {
  describe('splitDraftIntoRenderChunks', () => {
    it('returns a single chunk when the draft already fits', () => {
      const draft = '# Title\n\nA short paragraph.';
      expect(splitDraftIntoRenderChunks(draft, 1000)).toEqual([draft]);
    });

    it('splits at top-level heading boundaries', () => {
      const section = (n: number) => `## Competitor ${n}\n\n${'x'.repeat(200)}`;
      const draft = [section(1), section(2), section(3)].join('\n\n');
      const chunks = splitDraftIntoRenderChunks(draft, 260);
      expect(chunks).toHaveLength(3);
      expect(chunks[0]).toContain('## Competitor 1');
      expect(chunks[1]).toContain('## Competitor 2');
      expect(chunks[2]).toContain('## Competitor 3');
      // Each heading stays attached to its own body — never orphaned.
      expect(chunks[0]).not.toContain('## Competitor 2');
    });

    it('packs consecutive small sections into one chunk', () => {
      const draft = ['## A\n\naaa', '## B\n\nbbb', '## C\n\nccc'].join('\n\n');
      const chunks = splitDraftIntoRenderChunks(draft, 100);
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toContain('## A');
      expect(chunks[0]).toContain('## C');
    });

    it('splits an oversized single section on paragraph boundaries', () => {
      const para = `${'y'.repeat(100)}`;
      const draft = `## Only section\n\n${para}\n\n${para}\n\n${para}`;
      const chunks = splitDraftIntoRenderChunks(draft, 150);
      expect(chunks.length).toBeGreaterThan(1);
      chunks.forEach((chunk) => expect(chunk).not.toMatch(/^\s*$/));
    });

    it('never splits inside a line, even when one paragraph exceeds the limit', () => {
      const giant = 'z'.repeat(500);
      const chunks = splitDraftIntoRenderChunks(`## S\n\n${giant}`, 100);
      expect(chunks.some((chunk) => chunk.includes(giant))).toBe(true);
    });

    it('preserves every content line across the chunks', () => {
      const draft = [
        '# Report',
        '',
        'Intro line.',
        '',
        '## One',
        '',
        '| a | b |',
        '| --- | --- |',
        '| 1 | 2 |',
        '',
        '## Two',
        '',
        '- bullet one',
        '- bullet two',
      ].join('\n');
      const chunks = splitDraftIntoRenderChunks(draft, 40);
      const rejoined = chunks.join('\n').split('\n').map((l) => l.trim()).filter(Boolean);
      const original = draft.split('\n').map((l) => l.trim()).filter(Boolean);
      expect(rejoined).toEqual(original);
    });

    it('keeps a fenced code block whole despite the blank lines inside it', () => {
      const fence = ['```js', 'const a = 1;', '', 'const b = 2;', '```'].join('\n');
      const draft = `## Only section\n\n${'w'.repeat(120)}\n\n${fence}`;
      const chunks = splitDraftIntoRenderChunks(draft, 130);
      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.some((chunk) => chunk.includes(fence))).toBe(true);
    });

    it('does not treat a hash line inside a fence as a section heading', () => {
      const draft = [
        '# Report', '', 'Intro.', '',
        '```bash', '# not a heading', 'run --all', '```', '',
        `${'q'.repeat(120)}`,
      ].join('\n');
      const chunks = splitDraftIntoRenderChunks(draft, 90);
      const fenced = chunks.find((chunk) => chunk.includes('```bash'));
      expect(fenced).toContain('# not a heading');
      expect(fenced).toContain('run --all');
      expect(fenced).toContain('```bash');
    });

    it('normalises CRLF line endings', () => {
      const chunks = splitDraftIntoRenderChunks('## A\r\n\r\nbody\r\n', 1000);
      expect(chunks[0]).not.toContain('\r');
    });

    it('falls back to one chunk for a non-positive limit', () => {
      expect(splitDraftIntoRenderChunks('## A\n\nbody', 0)).toEqual(['## A\n\nbody']);
    });

    it('returns an empty list for an empty draft', () => {
      expect(splitDraftIntoRenderChunks('   ', 100)).toEqual([]);
      expect(splitDraftIntoRenderChunks(undefined as unknown as string, 100)).toEqual([]);
    });
  });

  describe('extractHtmlFragment', () => {
    it('returns a body fragment unchanged', () => {
      expect(extractHtmlFragment('<h2>Hi</h2>\n<p>There</p>')).toBe('<h2>Hi</h2>\n<p>There</p>');
    });

    it('unwraps a full document down to its body', () => {
      const doc = `<!DOCTYPE html><html><head><title>T</title></head><body class="x"><h2>Section</h2></body></html>`;
      expect(extractHtmlFragment(doc)).toBe('<h2>Section</h2>');
    });

    it('strips a doctype/head wrapper even without a body element', () => {
      const doc = '<!DOCTYPE html>\n<html lang="en">\n<head><title>T</title></head>\n<h2>S</h2>\n</html>';
      const fragment = extractHtmlFragment(doc);
      expect(fragment).toBe('<h2>S</h2>');
      expect(fragment).not.toContain('<html');
    });

    it('unwraps a fenced code block', () => {
      expect(extractHtmlFragment('```html\n<p>Body</p>\n```')).toBe('<p>Body</p>');
      expect(extractHtmlFragment('```\n<p>Body</p>\n```')).toBe('<p>Body</p>');
    });

    it('removes script and style blocks so sections cannot fight each other', () => {
      const fragment = extractHtmlFragment(
        '<style>h2{color:red}</style><h2>S</h2><script>alert(1)</script><p>P</p>',
      );
      expect(fragment).toBe('<h2>S</h2><p>P</p>');
      expect(fragment).not.toMatch(/<script|<style/i);
    });

    it('removes a script tag with attributes and a self-closing script src', () => {
      const fragment = extractHtmlFragment(
        '<p>A</p><script src="https://cdn.example.com/x.js"></script><script type="text/javascript">x()</script><p>B</p>',
      );
      expect(fragment).toBe('<p>A</p><p>B</p>');
    });

    it('returns an empty string for empty or non-string output', () => {
      expect(extractHtmlFragment('')).toBe('');
      expect(extractHtmlFragment(undefined as unknown as string)).toBe('');
    });

    describe('sanitisation', () => {
      it('strips event handlers but keeps the element', () => {
        const fragment = extractHtmlFragment(
          '<p onclick="steal()">Text</p><img src="https://x.test/a.png" onerror="alert(1)" alt="A">',
        );
        expect(fragment).toBe('<p>Text</p><img src="https://x.test/a.png" alt="A" />');
        expect(fragment).not.toMatch(/onclick|onerror/i);
      });

      it('drops executable URLs, including entity-encoded ones, keeping the link text', () => {
        expect(extractHtmlFragment('<a href="javascript:alert(1)">Click</a>')).toBe('<a>Click</a>');
        expect(extractHtmlFragment('<a href="java&#115;cript:alert(1)">Click</a>')).toBe('<a>Click</a>');
        expect(extractHtmlFragment('<a href="JaVaScRiPt&colon;alert(1)">Click</a>')).toBe('<a>Click</a>');
        expect(extractHtmlFragment('<a href="&#x6a;avascript:alert(1)">Click</a>')).toBe('<a>Click</a>');
        expect(extractHtmlFragment('<a href="  jav\tascript:alert(1)">Click</a>')).toBe('<a>Click</a>');
        expect(extractHtmlFragment('<a href="data:text/html;base64,PHNjcmlwdD4=">Click</a>')).toBe('<a>Click</a>');
      });

      it('keeps ordinary links and relative or anchor URLs', () => {
        expect(extractHtmlFragment('<a href="https://x.test/p" target="_blank" rel="noopener">X</a>'))
          .toBe('<a href="https://x.test/p" target="_blank" rel="noopener">X</a>');
        expect(extractHtmlFragment('<a href="mailto:a@b.test">Mail</a>')).toBe('<a href="mailto:a@b.test">Mail</a>');
        expect(extractHtmlFragment('<a href="#s2">Jump</a>')).toBe('<a href="#s2">Jump</a>');
      });

      it('removes active elements together with their content', () => {
        expect(extractHtmlFragment('<p>A</p><iframe src="https://evil.test"></iframe><p>B</p>'))
          .toBe('<p>A</p><p>B</p>');
        expect(extractHtmlFragment('<svg><script>alert(1)</script></svg><p>B</p>')).toBe('<p>B</p>');
        expect(extractHtmlFragment('<p>A</p><object data="x.swf"></object><form><input name="a"></form>'))
          .toBe('<p>A</p>');
      });

      it('drops class, id and style attributes so sections cannot restyle the report', () => {
        expect(extractHtmlFragment('<div class="card" id="c1" style="position:fixed">Body</div>'))
          .toBe('<div>Body</div>');
      });

      it('unwraps an unknown element, keeping its text', () => {
        expect(extractHtmlFragment('<marquee>Still readable</marquee>')).toBe('Still readable');
      });

      it('preserves report structure — tables, headings and QuickChart images', () => {
        const fragment = extractHtmlFragment(
          '<h2>Comparison</h2><table><thead><tr><th scope="col">Name</th></tr></thead>' +
          '<tbody><tr><td colspan="2">Acme</td></tr></tbody></table>' +
          '<img src="https://quickchart.io/chart?v=2.9.4&amp;c=%7B%22type%22%3A%22bar%22%7D" alt="Chart" width="600">',
        );
        expect(fragment).toContain('<th scope="col">Name</th>');
        expect(fragment).toContain('<td colspan="2">Acme</td>');
        // The chart URL must not be double-encoded, or the image 404s.
        expect(fragment).toContain('c=%7B%22type%22%3A%22bar%22%7D');
        expect(fragment).not.toContain('&amp;amp;');
      });

      it('escapes a bare ampersand in an attribute without touching real entities', () => {
        expect(extractHtmlFragment('<a href="https://x.test/?a=1&b=2&amp;c=3">L</a>'))
          .toBe('<a href="https://x.test/?a=1&amp;b=2&amp;c=3">L</a>');
      });

      it('is not fooled by a > inside an attribute value', () => {
        expect(extractHtmlFragment('<a href="https://x.test/?q=a>b" onclick="x()">L</a>'))
          .toBe('<a href="https://x.test/?q=a&gt;b">L</a>');
      });

      it('removes comments and stray markup declarations', () => {
        expect(extractHtmlFragment('<!-- <script>alert(1)</script> --><p>A</p>')).toBe('<p>A</p>');
        expect(extractHtmlFragment('<!DOCTYPE html><p>A</p>')).toBe('<p>A</p>');
        // An unterminated comment drops only its marker; the rest is sanitised.
        expect(extractHtmlFragment('<p>A</p><!-- oops <img src=x onerror=alert(1)>'))
          .toBe('<p>A</p> oops <img src="x" />');
      });

      it('escapes a bare < so an unparsed tag cannot be reassembled by the browser', () => {
        // Without escaping, the `<` inside alt= would break tag matching and let
        // the whole element through as raw text — which the browser would then
        // parse, handler and all.
        expect(extractHtmlFragment('<img src=x alt="<" onerror=alert(1)>'))
          .toBe('<img src="x" alt="&lt;" />');
        expect(extractHtmlFragment('<<img src=x onerror=alert(1)>'))
          .toBe('&lt;<img src="x" />');
        expect(extractHtmlFragment('<![CDATA[<img src=x onerror=alert(1)>]]>'))
          .toBe('&lt;![CDATA[<img src="x" />]]>');
      });

      it('stays linear on adversarial fragments', () => {
        // Every shape here was quadratic in an earlier draft of this sanitiser
        // (1.7s–4s on 60K chars), and the render path hands it drafts that big —
        // a stall here blocks the whole single-threaded backend.
        const adversarial = [
          '<a<b<c '.repeat(8000),
          '<script '.repeat(8000),
          '<!--'.repeat(15000),
          '<!'.repeat(30000),
          '<?'.repeat(30000),
          '<![CDATA['.repeat(6000),
          '<a href="x '.repeat(6000),
          `<img ${'a'.repeat(60000)}`,
        ];
        const started = Date.now();
        adversarial.forEach((input) => expect(typeof extractHtmlFragment(input)).toBe('string'));
        expect(Date.now() - started).toBeLessThan(5000);
      });
    });
  });

  describe('assembleChunkedHtmlDocument', () => {
    it('produces one self-contained document from the fragments in order', () => {
      const html = assembleChunkedHtmlDocument('Q3 Report', ['<h2>One</h2>', '<h2>Two</h2>']);
      expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
      expect(html).toContain('<title>Q3 Report</title>');
      expect(html).toContain('<style>');
      expect(html.indexOf('<h2>One</h2>')).toBeLessThan(html.indexOf('<h2>Two</h2>'));
      expect(html.trimEnd().endsWith('</html>')).toBe(true);
    });

    it('escapes the title', () => {
      const html = assembleChunkedHtmlDocument('<script>x</script>', ['<p>a</p>']);
      expect(html).toContain('&lt;script&gt;');
      expect(html).not.toContain('<title><script>');
    });

    it('falls back to a default title when none is given', () => {
      expect(assembleChunkedHtmlDocument('   ', ['<p>a</p>'])).toContain('<title>Report</title>');
    });

    it('tolerates missing title and fragment values', () => {
      const html = assembleChunkedHtmlDocument(
        undefined as unknown as string,
        [undefined as unknown as string, '<p>a</p>'],
      );
      expect(html).toContain('<title>Report</title>');
      expect(html).toContain('<p>a</p>');
    });

    it('drops empty fragments', () => {
      const html = assembleChunkedHtmlDocument('T', ['<p>a</p>', '   ', '']);
      expect(html.match(/<p>a<\/p>/g)).toHaveLength(1);
    });
  });
});
