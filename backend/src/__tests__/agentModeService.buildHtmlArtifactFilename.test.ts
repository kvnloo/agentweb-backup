/**
 * ENG-1685 — Kraftersland/Helen reported "Download failed" on an HTML report
 * artifact whose displayed filename was visibly truncated mid-word:
 * `..._Weekly_Performance_Repor.html` (missing the final "t"). Root cause:
 * `title.replace(...).substring(0, 50)` cut the sanitized title at a fixed,
 * undocumented 50-char boundary with no regard for word breaks.
 *
 * buildHtmlArtifactFilename replaces that inline pattern at all three real
 * call sites in agentModeService.ts (create_html_file passthrough, the
 * rendered-HTML upload path, and the markdown-fallback upload path).
 */
// ENG-2103 (F2): buildHtmlArtifactFilename's body moved to
// emma/impl/htmlCreation.ts (the createHtmlFile/createHtmlTemplate cluster);
// import it from there instead of agentModeService.ts.
import { buildHtmlArtifactFilename } from '../emma/impl/htmlCreation';

describe('buildHtmlArtifactFilename (ENG-1685)', () => {
  it('reproduces the reported title without truncating the final word', () => {
    const title = 'Kraftersland — Google Ads Weekly Performance Report (Aug 24–30, 2026)';
    const filename = buildHtmlArtifactFilename(title, 1788189057547);
    expect(filename).toBe(
      'html_1788189057547_Kraftersland___Google_Ads_Weekly_Performance_Report__Aug_24_30__2026_.html',
    );
    // The specific, previously-reported symptom: the word "Report" must never
    // be cut to "Repor".
    expect(filename).not.toMatch(/Repor\.html$/);
    expect(filename).toContain('Performance_Report');
  });

  it('still produces a deterministic, sanitized, non-empty filename for a short title', () => {
    expect(buildHtmlArtifactFilename('Q1 Plan', 1000)).toBe('html_1000_Q1_Plan.html');
  });

  it('handles an empty/undefined title without throwing', () => {
    expect(buildHtmlArtifactFilename('', 1000)).toBe('html_1000_.html');
  });

  it('still caps extremely long titles (bounded, not unbounded)', () => {
    const longTitle = 'A'.repeat(500);
    const filename = buildHtmlArtifactFilename(longTitle, 1000);
    // html_ (5) + timestamp (4) + _ (1) + up to 150 sanitized chars + .html (5)
    expect(filename.length).toBeLessThanOrEqual(5 + 4 + 1 + 150 + 5);
    expect(filename.startsWith('html_1000_AAAA')).toBe(true);
  });

  it('defaults the timestamp to Date.now() when omitted', () => {
    const before = Date.now();
    const filename = buildHtmlArtifactFilename('Test');
    const after = Date.now();
    const match = filename.match(/^html_(\d+)_Test\.html$/);
    expect(match).not.toBeNull();
    const stamped = Number(match![1]);
    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(stamped).toBeLessThanOrEqual(after);
  });
});
