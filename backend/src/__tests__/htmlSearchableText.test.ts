import { htmlToSearchableText } from '../utils/htmlSearchableText';

/** The backfill's previous regular expressions (ENG-2840 replaced them because their run time is quadratic on hostile input). */
function oldPipeline(html: string, max: number): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

describe('htmlToSearchableText (ENG-2840)', () => {
  it.each([
    ['a plain report', '<html><body><h1>Sales Report Q1</h1><p>Revenue increased by 20%.</p></body></html>'],
    ['styles and scripts', '<html><head><STYLE type="text/css">h1{color:red}</STYLE><script>var a = "<b>";</script></head><body><p>Hello <b>world</b></p><Script src="x.js"></Script></body></html>'],
    ['several blocks and attributes', '<style>a{}</style><div class="x" data-y=\'1\'>One</div><style media="print">b{}</style><span>Two</span>'],
    ['entities and line breaks', '<p>A &amp; B</p>\n\n<p>C\t D</p>'],
  ])('gives the same text as before for %s', (_label, html) => {
    expect(htmlToSearchableText(html, 3000)).toBe(oldPipeline(html, 3000));
  });

  it('cuts the text to the limit', () => {
    expect(htmlToSearchableText(`<p>${'x'.repeat(5000)}</p>`, 3000)).toHaveLength(3000);
  });

  it('leaves an unclosed style block in place (its tag is still removed), as before', () => {
    expect(htmlToSearchableText('<p>Text</p><style>a{color:red}', 3000)).toBe('Text a{color:red}');
  });

  it('keeps indexes right after characters whose lower case is longer', () => {
    expect(htmlToSearchableText('<p>İstanbul</p><style>x{}</style><p>after</p>', 3000)).toBe('İstanbul after');
  });

  it.each([
    ['many "<" with no ">"', '<'.repeat(1_000_000)],
    ['many "<style" with no ">"', '<style'.repeat(200_000)],
    ['many "<style>" with no closing tag', '<style>'.repeat(150_000)],
    ['many "<script>" with no closing tag', '<script>x'.repeat(100_000)],
  ])('runs in linear time on hostile input: %s', (_label, html) => {
    const started = Date.now();
    htmlToSearchableText(html, 3000);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
