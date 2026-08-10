/**
 * ENG-827 — the consent re-check must sit at the LAST moment, which is the HTTP
 * request itself, not the entry to the function that eventually makes it.
 *
 * Each case here is a window Greptile found still open after the earlier rounds: real
 * work — a headless-browser link preview, a token refresh — running between the check
 * and the irreversible write, on a consent decision read before that work began.
 *
 * The assertions are deliberately about the SIDE EFFECT (was the platform written to?)
 * rather than about return shapes, because that is the only thing that cannot be
 * undone.
 */

import { PublishConsentWithdrawn, isPublishConsentWithdrawn } from '../utils/publishConsentWithdrawn';

const WITHDRAWN = { success: false as const, error: 'This run is no longer authorized to publish.' };

describe('ENG-827 — publish-consent withdrawal sentinel', () => {
  it('survives being thrown across module boundaries', () => {
    // instanceof would fail if jest handed two copies of the class to two modules,
    // and a false negative here turns a deliberate stop into a reported crash.
    const err = new PublishConsentWithdrawn('nope');
    expect(isPublishConsentWithdrawn(err)).toBe(true);
    expect(isPublishConsentWithdrawn(JSON.parse(JSON.stringify({ ...err, isPublishConsentWithdrawn: true })))).toBe(true);
  });

  it('does not mistake an ordinary platform error for a withdrawal', () => {
    expect(isPublishConsentWithdrawn(new Error('LinkedIn rate limit exceeded'))).toBe(false);
    expect(isPublishConsentWithdrawn(null)).toBe(false);
    expect(isPublishConsentWithdrawn(undefined)).toBe(false);
    expect(isPublishConsentWithdrawn('withdrawn')).toBe(false);
  });
});

describe('ENG-827 — LinkedIn: the link preview must not outrun the consent check', () => {
  const ORIGINAL_ENV = process.env.LINKEDIN_CLIENT_ID;

  beforeAll(() => {
    process.env.LINKEDIN_CLIENT_ID = process.env.LINKEDIN_CLIENT_ID || 'test-client';
  });
  afterAll(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.LINKEDIN_CLIENT_ID;
    else process.env.LINKEDIN_CLIENT_ID = ORIGINAL_ENV;
  });

  it('abandons the post when consent is withdrawn while the preview is built', async () => {
    const { linkedInService } = require('../services/linkedInService');

    const post = jest.fn().mockResolvedValue({ headers: { 'x-restli-id': 'urn:li:share:1' }, data: {} });
    (linkedInService as any).client = { post };

    // Stand in for the OG discovery: slow, and the owner revokes while it runs.
    let revoked = false;
    jest.spyOn(linkedInService as any, 'fetchOgMetadata').mockImplementation(async () => {
      revoked = true;
      return { title: 'A title' };
    });

    await expect(
      linkedInService.createPost(
        'token', 'urn:li:person:1', 'Read this https://example.com/post', undefined,
        async () => (revoked ? WITHDRAWN : null),
      ),
    ).rejects.toMatchObject({ isPublishConsentWithdrawn: true });

    // The only assertion that matters: LinkedIn was never asked to publish.
    expect(post).not.toHaveBeenCalled();
  });

  it('still publishes when consent holds', async () => {
    const { linkedInService } = require('../services/linkedInService');

    const post = jest.fn().mockResolvedValue({ headers: { 'x-restli-id': 'urn:li:share:2' }, data: {} });
    (linkedInService as any).client = { post };
    jest.spyOn(linkedInService as any, 'fetchOgMetadata').mockResolvedValue({ title: 'A title' });

    const urn = await linkedInService.createPost(
      'token', 'urn:li:person:1', 'Read this https://example.com/post', undefined,
      async () => null,
    );

    expect(post).toHaveBeenCalledTimes(1);
    expect(urn).toBe('urn:li:share:2');
  });

  it('publishes unchanged when no hook is passed at all (interactive use)', async () => {
    const { linkedInService } = require('../services/linkedInService');

    const post = jest.fn().mockResolvedValue({ headers: { 'x-restli-id': 'urn:li:share:3' }, data: {} });
    (linkedInService as any).client = { post };
    jest.spyOn(linkedInService as any, 'fetchOgMetadata').mockResolvedValue({ title: 'A title' });

    await linkedInService.createPost('token', 'urn:li:person:1', 'Read this https://example.com/post');
    expect(post).toHaveBeenCalledTimes(1);
  });
});
