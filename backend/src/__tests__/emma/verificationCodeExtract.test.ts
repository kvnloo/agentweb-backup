import {
  htmlToText,
  extractVerificationCode,
  extractMagicLink,
} from '../../emma/verificationCodeExtract';

describe('htmlToText', () => {
  it('drops style/script blocks rather than leaking their contents as text', () => {
    const html =
      '<html><head><style>.code{font-size:600px}</style>' +
      '<script>var otp = 111111;</script></head><body><p>Your code is 366990</p></body></html>';
    const text = htmlToText(html);
    expect(text).toContain('366990');
    expect(text).not.toContain('font-size');
    expect(text).not.toContain('111111');
  });

  it('decodes entities and collapses zero-width characters used to obfuscate codes', () => {
    const html = '<p>Code:&nbsp;3&#8203;6&#8203;6&#8203;9&#8203;9&#8203;0</p>';
    expect(htmlToText(html)).toContain('366990');
  });

  it('inserts whitespace at tag boundaries so adjacent cells do not fuse into one number', () => {
    const html = '<td>12</td><td>3456</td>';
    expect(htmlToText(html)).not.toContain('123456');
  });
});

describe('extractVerificationCode — failure and boundary paths', () => {
  it('returns null when the body contains no candidate of the requested length', () => {
    expect(extractVerificationCode('Welcome to RankAI. Nothing to do here.')).toBeNull();
  });

  it('returns null for an empty or non-string body', () => {
    expect(extractVerificationCode('')).toBeNull();
    expect(extractVerificationCode(undefined as any)).toBeNull();
  });

  it('does not take digits out of a longer number (order ids, tracking numbers)', () => {
    expect(extractVerificationCode('Your order 9988776655443 has shipped.')).toBeNull();
  });

  it('does not take a date, time or year as a code', () => {
    expect(
      extractVerificationCode('Sent 2026-07-31 09:00:04 UTC. Expires in 10 minutes.')
    ).toBeNull();
  });

  it('does not take digits embedded in a URL as a code', () => {
    expect(
      extractVerificationCode('Open https://rankai.ai/dashboard/123456/analytics to continue.')
    ).toBeNull();
  });

  it('requires at least one digit in alphanumeric mode so plain words are not codes', () => {
    expect(
      extractVerificationCode('Please VERIFY your login attempt.', { alphanumeric: true })
    ).toBeNull();
  });
});

describe('extractVerificationCode — success paths', () => {
  it('extracts a 6-digit login code from a real-shaped RankAI email body', () => {
    const body =
      '<html><body><h1>Your RankAI Login Code</h1>' +
      '<p>Use this code to sign in:</p><div class="code">366990</div>' +
      '<p>This code expires in 10 minutes. Sent 2026-08-05.</p></body></html>';
    expect(extractVerificationCode(body)).toBe('366990');
  });

  it('prefers the candidate nearest a verification keyword over unrelated numbers', () => {
    const body = 'Invoice 884412 is attached. Your verification code is 512377. Ref 771290.';
    expect(extractVerificationCode(body)).toBe('512377');
  });

  it('joins a code that the sender spaced out for readability', () => {
    expect(extractVerificationCode('Your code is 3 6 6 9 9 0')).toBe('366990');
  });

  it('honours a non-default code length', () => {
    expect(extractVerificationCode('Your code is 4821', { codeLength: 4 })).toBe('4821');
  });

  it('extracts an alphanumeric code when alphanumeric mode is enabled', () => {
    expect(
      extractVerificationCode('Your code is A1B2C3 — do not share it.', { alphanumeric: true })
    ).toBe('A1B2C3');
  });
});

describe('extractMagicLink', () => {
  it('returns null when the body has no links', () => {
    expect(extractMagicLink('Your code is 366990')).toBeNull();
  });

  it('ignores unsubscribe, privacy and support links', () => {
    const body =
      'Sign in trouble? <a href="https://rankai.ai/unsubscribe?token=abc">Unsubscribe</a> ' +
      '<a href="https://rankai.ai/privacy">Privacy</a>';
    expect(extractMagicLink(body)).toBeNull();
  });

  it('extracts the auth callback link and strips trailing markup punctuation', () => {
    const body =
      '<a href="https://rankai.ai/api/auth/callback?token=xyz123&captchaKey=k">Sign in</a>';
    expect(extractMagicLink(body)).toBe('https://rankai.ai/api/auth/callback?token=xyz123&captchaKey=k');
  });

  it('only returns a link on the requested host when allowedHost is given', () => {
    const body =
      'https://tracking.example.com/verify?token=aaa and https://rankai.ai/verify?token=bbb';
    expect(extractMagicLink(body, { allowedHost: 'rankai.ai' })).toBe(
      'https://rankai.ai/verify?token=bbb'
    );
  });

  it('accepts a subdomain of the allowed host', () => {
    const body = 'https://mail.rankai.ai/verify?token=bbb';
    expect(extractMagicLink(body, { allowedHost: 'rankai.ai' })).toBe(
      'https://mail.rankai.ai/verify?token=bbb'
    );
  });

  // The host must be matched as a host, not as a substring of the URL: an
  // attacker controls their own path and query, so "rankai.ai" appears wherever
  // they want it to.
  it('rejects a lookalike host and the allowed host smuggled into a path or query', () => {
    expect(
      extractMagicLink('https://rankai.ai.evil.example.com/verify?token=x', { allowedHost: 'rankai.ai' })
    ).toBeNull();
    expect(
      extractMagicLink('https://evil.example.com/verify?token=x&ref=rankai.ai', { allowedHost: 'rankai.ai' })
    ).toBeNull();
    expect(
      extractMagicLink('https://notrankai.ai/verify?token=x', { allowedHost: 'rankai.ai' })
    ).toBeNull();
  });
});
