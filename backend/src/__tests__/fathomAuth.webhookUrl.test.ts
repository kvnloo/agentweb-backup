/**
 * Tests for the Fathom webhook destination-URL builder (ENG-259, PR #2203 P1).
 *
 * When FATHOM_WEBHOOK_SECRET is configured, the OAuth connect flow must register
 * the webhook WITH the shared token in the destination URL — otherwise every
 * legitimate Fathom delivery would be rejected 401 by the authenticated handler.
 */

import { buildFathomWebhookDestinationUrl } from '../routes/fathomAuth';

describe('buildFathomWebhookDestinationUrl', () => {
  const saved = process.env.FATHOM_WEBHOOK_SECRET;

  afterEach(() => {
    if (saved === undefined) delete process.env.FATHOM_WEBHOOK_SECRET;
    else process.env.FATHOM_WEBHOOK_SECRET = saved;
  });

  it('returns the plain webhook URL when no secret is configured', () => {
    delete process.env.FATHOM_WEBHOOK_SECRET;
    expect(buildFathomWebhookDestinationUrl('https://api.agentweb.pro')).toBe(
      'https://api.agentweb.pro/api/webhooks/fathom',
    );
  });

  it('appends the token when a secret is configured (registered deliveries authenticate)', () => {
    process.env.FATHOM_WEBHOOK_SECRET = 'whsec-abc123';
    expect(buildFathomWebhookDestinationUrl('https://api.agentweb.pro')).toBe(
      'https://api.agentweb.pro/api/webhooks/fathom?token=whsec-abc123',
    );
  });

  it('URL-encodes secrets with special characters', () => {
    process.env.FATHOM_WEBHOOK_SECRET = 'a+b/c&d=e';
    expect(buildFathomWebhookDestinationUrl('https://api.agentweb.pro')).toBe(
      `https://api.agentweb.pro/api/webhooks/fathom?token=${encodeURIComponent('a+b/c&d=e')}`,
    );
  });

  it('round-trips: the webhook handler accepts the token exactly as registered', () => {
    // The token the URL carries must decode back to the configured secret —
    // Express query parsing decodes percent-encoding, and the handler compares
    // against process.env.FATHOM_WEBHOOK_SECRET directly.
    process.env.FATHOM_WEBHOOK_SECRET = 'a+b/c&d=e';
    const url = new URL(buildFathomWebhookDestinationUrl('https://api.agentweb.pro'));
    expect(url.searchParams.get('token')).toBe('a+b/c&d=e');
  });
});
