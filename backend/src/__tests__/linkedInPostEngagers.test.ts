// ENG-2739 — linkedin_outreach action 'list-post-engagers': the commenters on a
// LinkedIn post, as warm-lead candidates for the ENG-1609 engagement-mining step.

jest.mock('../services/db', () => ({ crmDb: {} }));
jest.mock('../services/resendService', () => ({ resendService: { sendEmail: jest.fn() } }));
jest.mock('../services/gmailService', () => ({ gmailService: { sendEmail: jest.fn() } }));

import { linkedInOutreachService } from '../services/linkedInOutreachService';
import { linkedinOutreach } from '../emma/impl/linkedin';

const ACCOUNT = 'acc-own-1';
const callLLM = jest.fn() as any;

const comment = (id: string | null, over: any = {}, details: any = {}) => ({
  object: 'Comment',
  id: `c-${id}`,
  text: `comment by ${id}`,
  date: '2026-10-28T10:00:00.000Z',
  reaction_counter: 0,
  reply_counter: 0,
  author: `Name ${id}`,
  author_details: {
    id,
    headline: `Headline ${id}`,
    profile_url: `https://www.linkedin.com/in/${id}`,
    network_distance: 'SECOND_DEGREE',
    ...details,
  },
  ...over,
});

describe('LinkedInOutreachService.listPostComments (AC #1, #4)', () => {
  let client: { users: { getPost: jest.Mock; getAllPostComments: jest.Mock } };

  beforeEach(() => {
    client = {
      users: {
        getPost: jest.fn().mockResolvedValue({ social_id: 'urn:li:ugcPost:999' }),
        getAllPostComments: jest.fn().mockResolvedValue({ object: 'CommentList', items: [comment('a')], cursor: 'next-1', total_items: 1 }),
      },
    };
    jest.spyOn(linkedInOutreachService, 'getClient').mockResolvedValue(client as any);
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  it('uses a urn:li:activity URN directly as the social id, passing cursor and limit', async () => {
    const res = await linkedInOutreachService.listPostComments('urn:li:activity:7332661864792854528', ACCOUNT, { cursor: 'cur', limit: 25 });
    expect(client.users.getPost).not.toHaveBeenCalled();
    expect(client.users.getAllPostComments).toHaveBeenCalledWith({
      account_id: ACCOUNT, post_id: 'urn:li:activity:7332661864792854528', cursor: 'cur', limit: 25,
    });
    expect(res).toMatchObject({ socialId: 'urn:li:activity:7332661864792854528', cursor: 'next-1' });
    expect(res.items).toHaveLength(1);
  });

  it('extracts the URN from a /feed/update/ URL (including URL-encoded)', async () => {
    await linkedInOutreachService.listPostComments('https://www.linkedin.com/feed/update/urn%3Ali%3Aactivity%3A123/', ACCOUNT);
    expect(client.users.getPost).not.toHaveBeenCalled();
    expect(client.users.getAllPostComments).toHaveBeenCalledWith({ account_id: ACCOUNT, post_id: 'urn:li:activity:123' });
  });

  it('resolves a /posts/ share URL through getPost to its authoritative social id', async () => {
    await linkedInOutreachService.listPostComments(
      'https://www.linkedin.com/posts/jane-doe_ai-gtm-activity-7332661864792854528-AbCd?utm_source=share',
      ACCOUNT,
    );
    expect(client.users.getPost).toHaveBeenCalledWith({ account_id: ACCOUNT, post_id: '7332661864792854528' });
    expect(client.users.getAllPostComments).toHaveBeenCalledWith({ account_id: ACCOUNT, post_id: 'urn:li:ugcPost:999' });
  });

  it('routes Unipile errors through handleError (structured, classified)', async () => {
    const sdkError: any = new Error('UnsuccessfulRequestError');
    sdkError.body = { status: 404, title: 'Post not found' };
    client.users.getAllPostComments.mockRejectedValue(sdkError);
    await expect(linkedInOutreachService.listPostComments('urn:li:activity:1', ACCOUNT)).rejects.toMatchObject({
      message: 'Post not found',
      structuredError: expect.objectContaining({ classification: 'NOT_FOUND', status: 404 }),
    });
  });

  it('fails clearly on input that holds no post id, without calling Unipile', async () => {
    await expect(linkedInOutreachService.listPostComments('https://www.linkedin.com/in/someone', ACCOUNT))
      .rejects.toThrow(/Could not read a LinkedIn post id/);
    expect(client.users.getAllPostComments).not.toHaveBeenCalled();
  });
});

describe("linkedinOutreach action 'list-post-engagers' (AC #1-#4)", () => {
  let listPostComments: jest.SpyInstance;

  beforeEach(() => {
    jest.spyOn(linkedInOutreachService, 'probeAccountSession').mockResolvedValue('connected');
    jest.spyOn(linkedInOutreachService, 'listUserOwnedUnipileAccountIds').mockResolvedValue([ACCOUNT]);
    jest.spyOn(linkedInOutreachService, 'resolveAccountIdWithSource').mockResolvedValue({ accountId: ACCOUNT, usedSharedAccount: false } as any);
    listPostComments = jest.spyOn(linkedInOutreachService, 'listPostComments');
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  it("resolves the user's account when none is passed and forwards post_id/cursor/limit", async () => {
    listPostComments.mockResolvedValue({ socialId: 'urn:li:activity:1', items: [], cursor: null });
    const res = await linkedinOutreach(callLLM, 'user-1', {
      action: 'list-post-engagers', post_id: 'urn:li:activity:1', cursor: 'cur-2', limit: 500,
    });
    expect(linkedInOutreachService.resolveAccountIdWithSource).toHaveBeenCalledWith('user-1');
    // limit is clamped to Unipile's page maximum
    expect(listPostComments).toHaveBeenCalledWith('urn:li:activity:1', ACCOUNT, { cursor: 'cur-2', limit: 100 });
    expect(res.success).toBe(true);
    expect(res.data).toMatchObject({ post_id: 'urn:li:activity:1', items: [], cursor: null, usedSharedAccount: false });
  });

  it('returns one row per distinct commenter with name/headline/url/provider id/snippet and the cursor', async () => {
    const long = 'x'.repeat(500);
    listPostComments.mockResolvedValue({
      socialId: 'urn:li:activity:1',
      cursor: 'next-page',
      items: [comment('a', { text: long }), comment('b'), comment('a', { text: 'second comment by a' })],
    });
    const res = await linkedinOutreach(callLLM, 'user-1', { action: 'list-post-engagers', post_id: 'urn:li:activity:1', account_id: ACCOUNT });

    expect(res.success).toBe(true);
    expect(res.data.cursor).toBe('next-page');
    expect(res.data.items.map((r: any) => r.provider_id)).toEqual(['a', 'b']);
    expect(res.data.items[0]).toEqual({
      name: 'Name a',
      headline: 'Headline a',
      profile_url: 'https://www.linkedin.com/in/a',
      provider_id: 'a',
      comment_snippet: expect.any(String),
    });
    expect(res.data.items[0].comment_snippet.length).toBeLessThanOrEqual(200);
    expect(res.data.items[1].comment_snippet).toBe('comment by b');
  });

  it('drops anonymized / out-of-network authors and reports the count (ENG-1198 pattern)', async () => {
    listPostComments.mockResolvedValue({
      socialId: 'urn:li:activity:1',
      cursor: null,
      items: [
        comment('real'),
        comment('anon', {}, { profile_url: 'https://www.linkedin.com/in/undefined' }),
        comment('oon', {}, { network_distance: 'OUT_OF_NETWORK' }),
        comment('nourl', {}, { profile_url: null }),
        comment(null, { author: 'LinkedIn Member' }),
      ],
    });
    const res = await linkedinOutreach(callLLM, 'user-1', { action: 'list-post-engagers', post_id: 'urn:li:activity:1', account_id: ACCOUNT });
    expect(res.data.items.map((r: any) => r.provider_id)).toEqual(['real']);
    expect(res.data.anonymizedSkipped).toBe(4);
  });

  it('fails clearly when post_id is missing, without calling Unipile', async () => {
    const res = await linkedinOutreach(callLLM, 'user-1', { action: 'list-post-engagers', account_id: ACCOUNT });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/post_id is required for list-post-engagers/);
    expect(listPostComments).not.toHaveBeenCalled();
  });

  it('reports a missing post_id before resolving any account', async () => {
    const res = await linkedinOutreach(callLLM, 'user-1', { action: 'list-post-engagers' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/post_id is required for list-post-engagers/);
    expect(listPostComments).not.toHaveBeenCalled();
  });

  it('surfaces a Unipile error from the service as a failed result', async () => {
    const err: any = new Error('Post not found');
    err.structuredError = { classification: 'NOT_FOUND', status: 404, message: 'Post not found' };
    listPostComments.mockRejectedValue(err);
    const res = await linkedinOutreach(callLLM, 'user-1', { action: 'list-post-engagers', post_id: 'urn:li:activity:1', account_id: ACCOUNT });
    expect(res.success).toBe(false);
    expect(JSON.stringify(res)).toMatch(/Post not found/);
  });
});

