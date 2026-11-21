/**
 * ENG-3163: the guards behind POST /api/agent-mode/ishare/:shareId/email-report.
 *
 * The endpoint stays public so a landing page can email a lead their own report.
 * What must not be possible any more: a report link that is not ours, markup
 * breaking out of the link, several or malformed recipients, and unlimited sends.
 */
import {
  ISHARE_EMAIL_REPORT_MAX_PER_IP_PER_HOUR,
  ISHARE_EMAIL_REPORT_MAX_PER_RECIPIENT_PER_HOUR,
  ISHARE_EMAIL_REPORT_MAX_PER_SHARE_PER_HOUR,
  buildReportEmail,
  checkEmailReportAllowed,
  normalizeRecipient,
  resetEmailReportLimiter,
  resolveReportUrl,
} from '../utils/ishareEmailReport';

describe('normalizeRecipient', () => {
  it('accepts one plain address and trims it', () => {
    expect(normalizeRecipient('  lead@example.com ')).toBe('lead@example.com');
    expect(normalizeRecipient('first.last+tag@sub.example.co.uk')).toBe('first.last+tag@sub.example.co.uk');
  });

  it.each([
    ['empty', ''],
    ['spaces only', '   '],
    ['no at sign', 'lead.example.com'],
    ['no dot in domain', 'lead@example'],
    ['two addresses, comma', 'a@example.com,b@example.com'],
    ['two addresses, semicolon', 'a@example.com;b@example.com'],
    ['two addresses, space', 'a@example.com b@example.com'],
    ['display name', 'Boss <boss@example.com>'],
    ['quoted name', '"Boss"@example.com'],
    ['newline header injection', 'a@example.com\r\nBcc: victim@example.com'],
    ['backslash', 'a\\b@example.com'],
    ['not a string (array)', ['a@example.com'] as unknown as string],
    ['not a string (object)', { a: 1 } as unknown as string],
    ['too long', `${'a'.repeat(250)}@example.com`],
  ])('rejects %s', (_label, value) => {
    expect(normalizeRecipient(value)).toBeNull();
  });
});

describe('resolveReportUrl', () => {
  const prodEnv = {} as NodeJS.ProcessEnv;

  it.each([
    'https://agentweb.pro/report/abc',
    'https://app.agentweb.pro/ishare/s1?conversable=tok',
    'https://genius.agentweb.pro/r?x=1#frag',
    'https://landing.agentwebforms.com/results/42',
    'https://hireemma.ai/report',
    'https://www.hireemma.ai/report',
  ])('accepts %s', (url) => {
    expect(resolveReportUrl(url, prodEnv)).toBe(new URL(url).href);
  });

  it.each([
    ['another site', 'https://evil.example.com/login'],
    ['suffix lookalike', 'https://agentweb.pro.evil.com/x'],
    ['prefix lookalike', 'https://evilagentweb.pro/x'],
    ['hyphen lookalike', 'https://agentweb.pro-login.com/x'],
    ['userinfo trick', 'https://agentweb.pro@evil.com/x'],
    ['userinfo on a good host', 'https://user:pw@agentweb.pro/x'],
    ['agentwebforms.com apex (not trusted)', 'https://agentwebforms.com/x'],
    ['plain http on a prod host', 'http://agentweb.pro/x'],
    ['javascript scheme', 'javascript:alert(1)'],
    ['data scheme', 'data:text/html,<script>alert(1)</script>'],
    ['relative path', '/report/abc'],
    ['empty', ''],
    ['not a string', 42 as unknown as string],
    ['too long', `https://agentweb.pro/${'a'.repeat(2100)}`],
  ])('rejects %s', (_label, url) => {
    expect(resolveReportUrl(url, prodEnv)).toBeNull();
  });

  it('trusts the portal origins this environment is configured with, and only those', () => {
    const env = {
      CUSTOMER_FRONTEND_URL: 'http://203.0.113.9:5174',
      FRONTEND_URL: 'https://partner.staging.example.org',
    } as unknown as NodeJS.ProcessEnv;
    expect(resolveReportUrl('http://203.0.113.9:5174/ishare/s1', env)).toBe('http://203.0.113.9:5174/ishare/s1');
    expect(resolveReportUrl('https://partner.staging.example.org/x', env)).toBe('https://partner.staging.example.org/x');
    expect(resolveReportUrl('http://203.0.113.9:9999/ishare/s1', env)).toBeNull();
    expect(resolveReportUrl('http://203.0.113.10:5174/ishare/s1', env)).toBeNull();
  });

  it('ignores a malformed configured origin instead of widening trust', () => {
    const env = { CUSTOMER_FRONTEND_URL: 'not a url' } as unknown as NodeJS.ProcessEnv;
    expect(resolveReportUrl('https://evil.example.com/x', env)).toBeNull();
  });

  it('percent-encodes characters that could break out of an href', () => {
    const out = resolveReportUrl('https://app.agentweb.pro/r?x="><img src=x onerror=alert(1)>', prodEnv);
    expect(out).not.toBeNull();
    expect(out).not.toContain('"');
    expect(out).not.toContain('<');
    expect(out).not.toContain('>');
  });
});

describe('buildReportEmail', () => {
  it('puts the link in the button and the plain-text body', () => {
    const email = buildReportEmail('https://app.agentweb.pro/ishare/s1?conversable=tok');
    expect(email.subject).toBe('Your AI Report is Ready — AgentWeb');
    expect(email.text).toBe('Your report is ready! View it here: https://app.agentweb.pro/ishare/s1?conversable=tok');
    expect(email.html).toContain('<a href="https://app.agentweb.pro/ishare/s1?conversable=tok"');
    expect(email.html).toContain('View Your Report');
    expect(email.html).toContain('https://app.agentweb.pro/register');
  });

  it('escapes the link even if one slips past validation', () => {
    const email = buildReportEmail('https://app.agentweb.pro/x" onmouseover="alert(1)');
    expect(email.html).not.toContain('" onmouseover="alert(1)');
    expect(email.html).toContain('&quot; onmouseover=&quot;alert(1)');
    const email2 = buildReportEmail('https://app.agentweb.pro/x?a=1&b=<b>');
    expect(email2.html).toContain('a=1&amp;b=&lt;b&gt;');
  });
});

describe('checkEmailReportAllowed', () => {
  const HOUR = 60 * 60 * 1000;
  let now: number;

  beforeEach(() => {
    resetEmailReportLimiter();
    now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now);
  });

  afterEach(() => {
    resetEmailReportLimiter();
    jest.restoreAllMocks();
  });

  it('allows the first sends and blocks the one over the per-link cap', () => {
    for (let i = 0; i < ISHARE_EMAIL_REPORT_MAX_PER_SHARE_PER_HOUR; i++) {
      expect(checkEmailReportAllowed({ shareId: 's1', recipient: `lead${i}@example.com`, ip: '198.51.100.1' }).allowed).toBe(true);
    }
    const blocked = checkEmailReportAllowed({ shareId: 's1', recipient: 'another@example.com', ip: '198.51.100.1' });
    expect(blocked.allowed).toBe(false);
    if (!blocked.allowed) {
      expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
      expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(3600);
    }
  });

  it('keeps links independent of each other', () => {
    for (let i = 0; i < ISHARE_EMAIL_REPORT_MAX_PER_SHARE_PER_HOUR; i++) {
      checkEmailReportAllowed({ shareId: 's1', recipient: `lead${i}@example.com`, ip: '198.51.100.1' });
    }
    expect(checkEmailReportAllowed({ shareId: 's2', recipient: 'fresh@example.com', ip: '198.51.100.1' }).allowed).toBe(true);
  });

  it('caps one address across many links, ignoring letter case', () => {
    for (let i = 0; i < ISHARE_EMAIL_REPORT_MAX_PER_RECIPIENT_PER_HOUR; i++) {
      expect(checkEmailReportAllowed({ shareId: `link-${i}`, recipient: 'Victim@Example.com', ip: `198.51.100.${i + 1}` }).allowed).toBe(true);
    }
    expect(checkEmailReportAllowed({ shareId: 'link-new', recipient: 'victim@example.com', ip: '198.51.100.99' }).allowed).toBe(false);
  });

  it('caps one source across many links and addresses', () => {
    for (let i = 0; i < ISHARE_EMAIL_REPORT_MAX_PER_IP_PER_HOUR; i++) {
      expect(checkEmailReportAllowed({ shareId: `link-${i}`, recipient: `lead${i}@example.com`, ip: '203.0.113.7' }).allowed).toBe(true);
    }
    expect(checkEmailReportAllowed({ shareId: 'link-x', recipient: 'x@example.com', ip: '203.0.113.7' }).allowed).toBe(false);
    expect(checkEmailReportAllowed({ shareId: 'link-y', recipient: 'y@example.com', ip: '203.0.113.8' }).allowed).toBe(true);
  });

  it('frees a blocked link after the hour', () => {
    for (let i = 0; i < ISHARE_EMAIL_REPORT_MAX_PER_SHARE_PER_HOUR; i++) {
      checkEmailReportAllowed({ shareId: 's1', recipient: `lead${i}@example.com`, ip: '198.51.100.1' });
    }
    expect(checkEmailReportAllowed({ shareId: 's1', recipient: 'later@example.com', ip: '198.51.100.1' }).allowed).toBe(false);

    jest.spyOn(Date, 'now').mockReturnValue(now + 30 * 60 * 1000);
    expect(checkEmailReportAllowed({ shareId: 's1', recipient: 'later@example.com', ip: '198.51.100.1' }).allowed).toBe(false);

    jest.spyOn(Date, 'now').mockReturnValue(now + HOUR + 1000);
    expect(checkEmailReportAllowed({ shareId: 's1', recipient: 'later@example.com', ip: '198.51.100.1' }).allowed).toBe(true);
  });

  it('does not count a refused attempt against the other keys', () => {
    for (let i = 0; i < ISHARE_EMAIL_REPORT_MAX_PER_SHARE_PER_HOUR; i++) {
      checkEmailReportAllowed({ shareId: 's1', recipient: `lead${i}@example.com`, ip: '198.51.100.1' });
    }
    // Blocked on the link first, so the address and the IP are not charged for it.
    for (let i = 0; i < 20; i++) {
      expect(checkEmailReportAllowed({ shareId: 's1', recipient: 'untouched@example.com', ip: '198.51.100.1' }).allowed).toBe(false);
    }
    expect(checkEmailReportAllowed({ shareId: 's9', recipient: 'untouched@example.com', ip: '198.51.100.1' }).allowed).toBe(true);
  });
});
