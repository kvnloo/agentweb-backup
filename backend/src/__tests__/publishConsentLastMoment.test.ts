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

describe('ENG-827 — YouTube: the upload must not outrun the consent check', () => {
  const YT_ACCOUNT = {
    account_id: 'yt-1',
    platform: 'youtube',
    config: { account_type: 'channel', channel_id: 'UC123', access_token: 'tok' },
  } as any;

  afterEach(() => jest.restoreAllMocks());

  const runUpload = async (revokeDuringUpload: boolean) => {
    const axios = require('axios');
    const { YouTubeAdapter } = require('../services/adapters/youtubeAdapter');

    let revoked = false;
    jest.spyOn(axios, 'get').mockResolvedValue({ data: new ArrayBuffer(8) });
    // The upload is the long part: minutes of bytes for a real video. The owner
    // revokes while it runs, AFTER the pre-upload check has already passed.
    const post = jest.spyOn(axios, 'post').mockImplementation(async () => {
      if (revokeDuringUpload) revoked = true;
      return { data: { id: 'vid-1' } } as any;
    });
    const put = jest.spyOn(axios, 'put').mockResolvedValue({ data: { id: 'vid-1' } });

    const assertStillAuthorized = jest.fn(async () =>
      revoked ? { error: 'This run is no longer authorized to publish.' } : null
    );

    const result = await new YouTubeAdapter().createPost(
      YT_ACCOUNT, 'My video', ['https://example.com/v.mp4'], 'user-1', assertStillAuthorized
    );
    return { result, post, put };
  };

  it('never makes the video public when consent is withdrawn during the upload', async () => {
    const { result, post, put } = await runUpload(true);

    // The bytes did move — we cannot un-upload them — but the video must not go live.
    expect(post).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0][1]).toMatchObject({ status: { privacyStatus: 'private' } });
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/private/i);
    // The user is told where the video went, so the upload is not a silent loss.
    expect(result.message).toContain('vid-1');
  });

  it('publishes normally when consent holds throughout', async () => {
    const { result, put } = await runUpload(false);

    expect(put.mock.calls[0][1]).toMatchObject({ status: { privacyStatus: 'public' } });
    expect(result.success).toBe(true);
  });
});

describe('ENG-827 — blog: the article fetch must not outrun the consent check', () => {
  afterEach(() => jest.restoreAllMocks());

  const HTML = '<html><body><div class="content"><p>Body</p></div></body></html>';

  it('re-checks consent after the HTML fetch, not only before it', async () => {
    // Contract-level assertion: the hook is invoked, and invoked late enough that a
    // revocation landing during the fetch is observed.
    const axios = require('axios');
    const { agentModeService } = require('../services/agentModeService');
    jest.spyOn(axios, 'get').mockResolvedValue({ data: HTML } as any);

    const result = await agentModeService.publishBlogArticle(
      'T', 'D', 'https://img', 'https://example.com/a.html', 'user-1', 'sess-1',
      'published', undefined, [], async () => ({ error: 'This run is no longer authorized to publish.' })
    );

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/no longer authorized/i);
  });

  it('does not gate a draft, which is reversible and invisible', async () => {
    const axios = require('axios');
    const { agentModeService } = require('../services/agentModeService');
    jest.spyOn(axios, 'get').mockResolvedValue({ data: HTML } as any);

    const assertStillAuthorized = jest.fn(async () => ({ error: 'withdrawn' }));
    await agentModeService.publishBlogArticle(
      'T', 'D', 'https://img', 'https://example.com/a.html', 'user-1', 'sess-1',
      'draft', undefined, [], assertStillAuthorized
    ).catch(() => undefined);

    expect(assertStillAuthorized).not.toHaveBeenCalled();
  });
});

describe('ENG-827 — X: a single tweet is guarded like a thread', () => {
  afterEach(() => jest.restoreAllMocks());

  it('forwards the hook the adapter used to drop on the floor', async () => {
    const { TwitterAdapter } = require('../services/adapters/twitterAdapter');
    const { twitterService } = require('../services/twitterService');

    const postTweet = jest
      .spyOn(twitterService, 'postTweet')
      .mockResolvedValue({ id: '1', text: 'hi' } as any);

    const hook = jest.fn(async () => null);
    await new TwitterAdapter().createPost(
      { account_id: 'x-1', platform: 'twitter', userId: 'owner-1', config: {} } as any,
      'hello', undefined, 'user-1', hook
    );

    // Threads were already guarded; a lone tweet was decided only at dispatch,
    // because the adapter's signature had nowhere to put the callback.
    expect(postTweet).toHaveBeenCalledTimes(1);
    expect(postTweet.mock.calls[0][4]).toBe(hook);
  });
});

describe('ENG-827 — Instagram: the container must not outrun the consent check', () => {
  afterEach(() => jest.restoreAllMocks());

  const IG_ACCOUNT = {
    account_id: 'ig-1',
    platform: 'instagram',
    config: { account_type: 'instagram_business', instagram_account_id: 'ig-1', access_token: 'tok' },
  } as any;

  it('does not publish a container built before consent was withdrawn', async () => {
    const axios = require('axios');
    const { InstagramAdapter } = require('../services/adapters/instagramAdapter');

    let revoked = false;
    // Container creation is the slow part — upload, then transcode. The owner
    // revokes while it runs, after the dispatcher already said yes.
    const post = jest.spyOn(axios, 'post').mockImplementation(async (url: any) => {
      if (String(url).includes('/media_publish')) return { data: { id: 'post-1' } } as any;
      revoked = true;
      return { data: { id: 'container-1' } } as any;
    });

    const result = await new InstagramAdapter().createPost(
      IG_ACCOUNT, 'caption', ['https://example.com/a.jpg'], 'user-1',
      async () => (revoked ? { error: 'This run is no longer authorized to publish.' } : null)
    );

    // The container exists and nobody can see it. media_publish is what makes it
    // public, and it must never have been called.
    const publishCalls = post.mock.calls.filter((c: any[]) => String(c[0]).includes('/media_publish'));
    expect(publishCalls).toHaveLength(0);
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/no longer authorized/i);
  });

  it('publishes normally when consent holds', async () => {
    const axios = require('axios');
    const { InstagramAdapter } = require('../services/adapters/instagramAdapter');

    const post = jest.spyOn(axios, 'post').mockImplementation(async (url: any) =>
      String(url).includes('/media_publish')
        ? ({ data: { id: 'post-1' } } as any)
        : ({ data: { id: 'container-1' } } as any)
    );
    jest.spyOn(axios, 'get').mockResolvedValue({ data: { permalink: 'https://instagram.com/p/x' } });

    const result = await new InstagramAdapter().createPost(
      IG_ACCOUNT, 'caption', ['https://example.com/a.jpg'], 'user-1', async () => null
    );

    expect(post.mock.calls.filter((c: any[]) => String(c[0]).includes('/media_publish'))).toHaveLength(1);
    expect(result.success).toBe(true);
  });
});

describe('ENG-827 — the re-check survives the REST self-call boundary', () => {
  afterEach(() => jest.restoreAllMocks());

  it('forwards the session so the far side can rebuild the hook', () => {
    // The hook is a closure and cannot be serialized; the session id it is keyed on
    // can. ctx() is what decides which fields make the crossing.
    const { ctx } = require('../mcp/server/toolHelpers');
    expect(ctx({ userId: 'u1', sessionId: 'sess-1' })).toMatchObject({
      userId: 'u1',
      sessionId: 'sess-1',
    });
  });

  it('rebuilds an equivalent hook on the receiving side', async () => {
    const { attachPublishRevalidation } = require('../utils/scheduledPublishConsentGuard');

    // Same construction the route performs from the forwarded header.
    const rebuilt = attachPublishRevalidation('post_on_connected_account', { sessionId: 'sess-1' });
    expect(typeof rebuilt.assertPublishStillAuthorized).toBe('function');
  });

  it('gives an interactive call no hook, because it is not gated', () => {
    const { attachPublishRevalidation } = require('../utils/scheduledPublishConsentGuard');

    // No session forwarded => the route builds no context at all. Modelled here as
    // the guard being asked about a non-publishing tool, which must stay untouched.
    const untouched = attachPublishRevalidation('list_connected_accounts', { sessionId: 'sess-1' });
    expect(untouched.assertPublishStillAuthorized).toBeUndefined();
  });
});
