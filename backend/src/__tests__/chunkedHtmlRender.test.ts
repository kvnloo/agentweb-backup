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
