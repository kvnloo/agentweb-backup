import { htmlToPlainText } from '../dripPlainTextAlternative';

describe('htmlToPlainText (ENG-2564)', () => {
  it('returns empty string for empty / whitespace / non-string input', () => {
    expect(htmlToPlainText('')).toBe('');
    expect(htmlToPlainText('   \n\t ')).toBe('');
    expect(htmlToPlainText(undefined as unknown as string)).toBe('');
  });

  it('strips tags, script/style/head content and comments', () => {
    const html =
      '<html><head><title>T</title><style>p{color:red}</style></head>' +
      '<body><!-- hidden --><script>alert(1)</script><span>Hello <b>world</b></span></body></html>';
    expect(htmlToPlainText(html)).toBe('Hello world');
  });

  it('converts <br> to newlines and block elements to paragraph breaks', () => {
    expect(htmlToPlainText('<p>One<br>Two<br/>Three</p><p>Four</p><h2>Five</h2><div>Six</div>')).toBe(
      'One\nTwo\nThree\n\nFour\n\nFive\n\nSix',
    );
  });

  it('prefixes list items with "- "', () => {
    expect(htmlToPlainText('<p>Intro</p><ul><li>A</li><li>B</li></ul>')).toBe('Intro\n\n- A\n- B');
  });

  it('renders links as text (href), collapsing when text equals href', () => {
    expect(htmlToPlainText('<a href="https://x.io/demo">Book a demo</a>')).toBe('Book a demo (https://x.io/demo)');
    expect(htmlToPlainText('<a href="https://x.io">https://x.io</a>')).toBe('https://x.io');
  });

  it('renders mailto/#/javascript links as text only', () => {
    expect(htmlToPlainText('<a href="mailto:a@b.co">Email us</a>')).toBe('Email us');
    expect(htmlToPlainText('<a href="#top">Top</a>')).toBe('Top');
    expect(htmlToPlainText('<a href="javascript:alert(1)">Click</a>')).toBe('Click');
  });

  it('decodes common named and numeric entities', () => {
    expect(htmlToPlainText('<p>A &amp; B &lt;c&gt; &quot;d&quot; &#39;e&#39; f&nbsp;g &#65;&#x42;</p>')).toBe(
      'A & B <c> "d" \'e\' f g AB',
    );
  });

  it('does not double-decode escaped entities', () => {
    expect(htmlToPlainText('&amp;lt;')).toBe('&lt;');
    expect(htmlToPlainText('<a href="https://x.io?a=1&amp;b=2">Q &amp;lt; R</a>')).toBe(
      'Q &lt; R (https://x.io?a=1&b=2)',
    );
  });

  it('collapses whitespace, trims lines and allows at most one blank line', () => {
    const html = '<p>  lots    of\n   space  </p>\n\n\n<div></div><div></div><p>next</p>';
    expect(htmlToPlainText(html)).toBe('lots of space\n\nnext');
  });

  it('handles table rows as line breaks', () => {
    expect(htmlToPlainText('<table><tr><td>a</td></tr><tr><td>b</td></tr></table>')).toBe('a\n\nb');
  });
});
