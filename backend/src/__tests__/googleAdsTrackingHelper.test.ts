/**
 * ENG-1328 AC3 — the Google Ads conversion leg of the platform-owned helper.
 *
 * This helper is not library code we call; it is SOURCE emitted into the customer's
 * repo as `lib/agentweb-track.ts`. So these tests assert on the emitted text, and one
 * of them compiles it, because a template-literal slip here ships a repo that does not
 * build — and the failure would surface as a broken customer site, not a red test.
 */
import * as ts from 'typescript';
import { buildTrackingHelper } from '../services/v0Service';

const helper = buildTrackingHelper();

describe('buildTrackingHelper — emitted source is valid', () => {
  it('compiles as TypeScript with no syntactic diagnostics', () => {
    // The helper is built inside a template literal, so an unescaped ${...} or a stray
    // backtick would silently corrupt it. Parsing is the only honest check.
    const sf = ts.createSourceFile('agentweb-track.ts', helper, ts.ScriptTarget.ES2020, true);
    expect((sf as any).parseDiagnostics ?? []).toHaveLength(0);
  });

  it('did not interpolate anything away — no bare ${ } survived into the output', () => {
    expect(helper).not.toContain('undefined/');
    expect(helper).not.toMatch(/\$\{\s*\}/);
  });
});

describe('buildTrackingHelper — Google Ads conversion (AC3)', () => {
  it('accepts googleAds as both halves of send_to, not a pre-joined string', () => {
    // A single string would let a caller pass "AW-123" with no label, which fires a
    // conversion that matches no conversion action.
    expect(helper).toContain('googleAds?: { conversionId: string; conversionLabel: string }');
  });

  it('fires a conversion event built from both halves', () => {
    expect(helper).toContain("window.gtag('event', 'conversion'");
    expect(helper).toContain("send_to: opts.googleAds.conversionId + '/' + opts.googleAds.conversionLabel");
  });

  it('carries transaction_id: eventId so an offline import cannot double-count', () => {
    // ENG-1325 uploads the same value as order_id; Google dedups the pair.
    expect(helper).toContain('transaction_id: opts.eventId');
  });

  it('guards on gtag actually existing, so a missing base tag cannot hang the submit', () => {
    // The ENG-1182 shape exactly: the conversion call was correct, window.gtag was not
    // defined. Without this guard the await below would never settle.
    expect(helper).toContain('typeof window.gtag === "function"');
  });

  it('waits on event_callback rather than a blind sleep', () => {
    expect(helper).toContain('event_callback');
  });

  it('still resolves when gtag never calls back', () => {
    // An ad blocker swallows the callback. Without the timer the visitor is stranded on
    // a page that already submitted.
    expect(helper).toContain('setTimeout(done, 1000)');
    expect(helper).toContain('clearTimeout(timer)');
  });

  it('does nothing at all when googleAds is absent — no fallback conversion', () => {
    expect(helper).toContain('if (opts.googleAds && opts.googleAds.conversionId && opts.googleAds.conversionLabel)');
  });

  it('fires the conversion BEFORE the bridge-out redirect tears the page down', () => {
    const conversionAt = helper.indexOf("window.gtag('event', 'conversion'");
    const bridgeAt = helper.indexOf('if (opts.bridgeOutUrl)');
    expect(conversionAt).toBeGreaterThan(-1);
    expect(bridgeAt).toBeGreaterThan(-1);
    expect(conversionAt).toBeLessThan(bridgeAt);
  });

  it('keeps the Meta leg intact and ordered ahead of it', () => {
    // Regression guard: the two legs share one helper precisely so they cannot race.
    const metaAt = helper.indexOf("window.fbq('track', 'Lead'");
    const conversionAt = helper.indexOf("window.gtag('event', 'conversion'");
    expect(metaAt).toBeGreaterThan(-1);
    expect(metaAt).toBeLessThan(conversionAt);
  });

  it('still tells v0 not to hand-author the calls, now naming gtag too', () => {
    expect(helper).toContain('DO NOT hand-author');
    expect(helper).toContain('gtag()');
  });
});
