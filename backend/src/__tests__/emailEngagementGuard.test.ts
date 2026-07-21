/**
 * Unit tests for the email engagement guard (ENG-325).
 *
 * Behavioural contract, from the issue's "Done when" + "What NOT to do":
 *   - A corporate link scanner / email-security prefetch must NOT count as engagement.
 *   - Gmail's GoogleImageProxy open MUST still count as engagement (real human).
 *   - No standalone "engagement under N seconds = bot" cutoff — only positive machine
 *     evidence (scanner UA / pre-send timing) suppresses; everything ambiguous stays human.
 */

import {
  parseResendTimestamp,
  isKnownScannerUserAgent,
  extractEngagementSignals,
  classifyEngagementEvent,
  KNOWN_SCANNER_UA_PATTERNS,
  SCANNER_MAX_GAP_MS_WITHOUT_UA,
} from '../utils/emailEngagementGuard';

const SEND = '2026-07-14 14:51:51.523456+00'; // Resend send-time format (space, µs, bare +00)
const SEND_MS = Date.UTC(2026, 6, 14, 14, 51, 51, 523);

// Build an email.opened / email.clicked event as stored in AW-EmailEvents.
function makeEvent(opts: {
  type?: 'email.opened' | 'email.clicked';
  sentAt?: string | null;
  engagedAt?: string | null;
  userAgent?: string | null;
}) {
  const type = opts.type ?? 'email.opened';
  const key = type === 'email.clicked' ? 'click' : 'open';
  const detail: any = {};
  if (opts.userAgent !== undefined && opts.userAgent !== null) detail.userAgent = opts.userAgent;
  if (opts.engagedAt) detail.timestamp = opts.engagedAt;
  return {
    eventType: type,
    createdAt: opts.engagedAt ?? undefined,
    data: {
      ...(opts.sentAt !== null ? { created_at: opts.sentAt ?? SEND } : {}),
      [key]: detail,
    },
  };
}

describe('parseResendTimestamp', () => {
  it('parses Resend send-time format (space-separated, microseconds, bare +00)', () => {
    expect(parseResendTimestamp('2026-07-14 14:51:51.523456+00')).toBe(SEND_MS);
  });

  it('parses ISO-with-T and Z', () => {
    expect(parseResendTimestamp('2026-07-14T14:51:51.523Z')).toBe(SEND_MS);
  });

  it('parses a +0000 four-digit offset', () => {
    expect(parseResendTimestamp('2026-07-14 14:51:51.523456+0000')).toBe(SEND_MS);
  });

  it('parses with no fractional seconds', () => {
    expect(parseResendTimestamp('2026-07-14 14:51:51+00')).toBe(Date.UTC(2026, 6, 14, 14, 51, 51, 0));
  });

  it('returns null for missing/blank/garbage input', () => {
    expect(parseResendTimestamp(undefined)).toBeNull();
    expect(parseResendTimestamp(null)).toBeNull();
    expect(parseResendTimestamp('')).toBeNull();
    expect(parseResendTimestamp('   ')).toBeNull();
    expect(parseResendTimestamp('not-a-date')).toBeNull();
  });
});

describe('isKnownScannerUserAgent', () => {
  it.each([
    'Proofpoint URL Defense',
    'Barracuda Sentinel',
    'Mimecast Link Protect',
    'Microsoft-ATP link scanner',
    'SafeLinks/1.0',
    'SkypeUriPreview Preview/1.0',
    'Symantec MessageLabs scanner',
    'Cisco IronPort scanner',
    'FortiMail',
  ])('flags named corporate scanner UA: %s', (ua) => {
    expect(isKnownScannerUserAgent(ua)).toBe(true);
  });

  it('does NOT flag Gmail GoogleImageProxy (a real human open)', () => {
    expect(
      isKnownScannerUserAgent('Mozilla/5.0 (Windows NT 5.0 (via ggpht.com GoogleImageProxy)'),
    ).toBe(false);
  });

  it('does NOT flag ordinary browsers or Apple Mail', () => {
    expect(
      isKnownScannerUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
      ),
    ).toBe(false);
    expect(isKnownScannerUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleMail/16.0')).toBe(false);
  });

  it('does NOT flag empty/missing UA', () => {
    expect(isKnownScannerUserAgent('')).toBe(false);
    expect(isKnownScannerUserAgent(undefined)).toBe(false);
    expect(isKnownScannerUserAgent(null)).toBe(false);
  });

  it('exposes a non-empty pattern list', () => {
    expect(KNOWN_SCANNER_UA_PATTERNS.length).toBeGreaterThan(0);
  });
});

describe('extractEngagementSignals', () => {
  it('reads gap and UA from an open event', () => {
    const ev = makeEvent({
      type: 'email.opened',
      sentAt: SEND,
      engagedAt: '2026-07-14T14:52:20.000Z', // 28.5s after send
      userAgent: 'Mozilla/5.0 (Windows NT 5.0 (via ggpht.com GoogleImageProxy)',
    });
    const sig = extractEngagementSignals(ev);
    expect(sig.userAgent).toContain('GoogleImageProxy');
    expect(sig.gapMs).toBe(Date.UTC(2026, 6, 14, 14, 52, 20, 0) - SEND_MS);
  });

  it('reads UA from the click sub-object for click events', () => {
    const ev = makeEvent({ type: 'email.clicked', userAgent: 'Proofpoint', engagedAt: '2026-07-14T14:52:20.000Z' });
    expect(extractEngagementSignals(ev).userAgent).toBe('Proofpoint');
  });

  it('falls back to webhook createdAt when the detail timestamp is absent', () => {
    const ev = { eventType: 'email.opened', createdAt: '2026-07-14T14:52:00.000Z', data: { created_at: SEND, open: {} } };
    const sig = extractEngagementSignals(ev);
    expect(sig.gapMs).toBe(Date.UTC(2026, 6, 14, 14, 52, 0, 0) - SEND_MS);
  });

  it('returns gapMs=null when send time is unparseable', () => {
    const ev = makeEvent({ engagedAt: '2026-07-14T14:52:20.000Z', sentAt: null, userAgent: 'x' });
    expect(extractEngagementSignals(ev).gapMs).toBeNull();
  });
});

describe('classifyEngagementEvent', () => {
  // ---- HUMAN events must NOT be flagged as scanners ----

  it('treats a Gmail GoogleImageProxy open ~28s after send as a real human', () => {
    const ev = makeEvent({
      type: 'email.opened',
      sentAt: SEND,
      engagedAt: '2026-07-14T14:52:20.000Z',
      userAgent: 'Mozilla/5.0 (Windows NT 5.0 (via ggpht.com GoogleImageProxy)',
    });
    expect(classifyEngagementEvent(ev).isScanner).toBe(false);
  });

  it('treats the fastest observed real click (18.7s, browser UA) as a real human', () => {
    const ev = makeEvent({
      type: 'email.clicked',
      sentAt: SEND,
      engagedAt: '2026-07-14T14:52:10.223Z', // 18.7s after send
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126 Safari/537.36',
    });
    expect(classifyEngagementEvent(ev).isScanner).toBe(false);
  });

  it('treats an open with a browser UA and unparseable send time as a real human (fail open)', () => {
    const ev = makeEvent({
      type: 'email.opened',
      sentAt: null,
      engagedAt: '2026-07-14T14:52:20.000Z',
      userAgent: 'Mozilla/5.0 Chrome/126',
    });
    expect(classifyEngagementEvent(ev).isScanner).toBe(false);
  });

  // ---- SCANNER events MUST be flagged ----

  it('flags a known scanner UA regardless of timing (reason=known-scanner-ua)', () => {
    const ev = makeEvent({
      type: 'email.clicked',
      sentAt: SEND,
      engagedAt: '2026-07-14T14:55:00.000Z', // even a "slow" scan
      userAgent: 'Mimecast Link Protect',
    });
    const v = classifyEngagementEvent(ev);
    expect(v.isScanner).toBe(true);
    expect(v.reason).toBe('known-scanner-ua');
  });

  it('flags a pre-send open (engaged before it was sent) as prefetch', () => {
    const ev = makeEvent({
      type: 'email.opened',
      sentAt: SEND,
      engagedAt: '2026-07-14T14:51:50.000Z', // 1.5s BEFORE send
      userAgent: 'someProxy/1.0',
    });
    const v = classifyEngagementEvent(ev);
    expect(v.isScanner).toBe(true);
    expect(v.reason).toBe('prefetch');
    expect(v.gapMs).toBeLessThan(0);
  });

  it('flags an open exactly at send time as prefetch (gap 0)', () => {
    const ev = makeEvent({ type: 'email.opened', sentAt: SEND, engagedAt: '2026-07-14T14:51:51.523Z', userAgent: 'x' });
    const v = classifyEngagementEvent(ev);
    expect(v.isScanner).toBe(true);
    expect(v.reason).toBe('prefetch');
  });

  it('flags a sub-second engagement with NO user agent as sub-second-no-ua', () => {
    const ev = {
      eventType: 'email.opened',
      createdAt: '2026-07-14T14:51:52.000Z', // 0.477s after send
      data: { created_at: SEND, open: {} }, // no userAgent
    };
    const v = classifyEngagementEvent(ev);
    expect(v.isScanner).toBe(true);
    expect(v.reason).toBe('sub-second-no-ua');
    expect(v.gapMs).toBeLessThan(SCANNER_MAX_GAP_MS_WITHOUT_UA);
  });

  it('does NOT flag a sub-second engagement that carries a real browser UA (needs no-UA too)', () => {
    const ev = makeEvent({
      type: 'email.opened',
      sentAt: SEND,
      engagedAt: '2026-07-14T14:51:52.000Z', // 0.477s after send
      userAgent: 'Mozilla/5.0 Chrome/126',
    });
    // Sub-second alone must never suppress — the data does not support a bare time cutoff.
    expect(classifyEngagementEvent(ev).isScanner).toBe(false);
  });
});
