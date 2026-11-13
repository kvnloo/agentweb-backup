import {
  buildDraftRequest,
  createSocialPlannerDraft,
  isGhlSocialPlannerEnabled,
  GhlSocialPlannerError,
  type GhlHttpRequest,
  type GhlHttpResponse,
} from '../services/gohighlevel/socialPlannerClient';

const base = {
  locationId: 'loc_123',
  accountIds: ['acct_fb_1', 'acct_ig_2'],
  text: 'Fall promo is live',
  mediaUrls: ['https://cdn.example.com/a.png'],
};

function fake(res: GhlHttpResponse | Error) {
  const calls: GhlHttpRequest[] = [];
  const transport = async (req: GhlHttpRequest) => {
    calls.push(req);
    if (res instanceof Error) throw res;
    return res;
  };
  return { calls, transport };
}

const ok: GhlHttpResponse = { status: 201, body: { success: true, results: { post: { _id: 'post_9', status: 'draft' } } } };

async function kindOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'none';
  } catch (e) {
    expect(e).toBeInstanceOf(GhlSocialPlannerError);
    return (e as GhlSocialPlannerError).kind;
  }
}

describe('ENG-2941 GHL Social Planner draft client', () => {
  it('flag defaults off', () => {
    expect(isGhlSocialPlannerEnabled(undefined)).toBe(false);
    expect(isGhlSocialPlannerEnabled('1')).toBe(false);
    expect(isGhlSocialPlannerEnabled('true')).toBe(true);
  });

  it('creates a draft with the documented v2 request shape', async () => {
    const { calls, transport } = fake(ok);
    const out = await createSocialPlannerDraft(transport, 'tok', { ...base, scheduleAt: '2026-12-01T10:00:00Z' });
    expect(out).toEqual({ postId: 'post_9', status: 'draft', raw: ok.body });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://services.leadconnectorhq.com/social-media-posting/loc_123/posts');
    expect(calls[0].headers.Authorization).toBe('Bearer tok');
    expect(calls[0].headers.Version).toBe('2021-07-28');
    expect(JSON.parse(calls[0].body)).toEqual({
      accountIds: ['acct_fb_1', 'acct_ig_2'],
      summary: 'Fall promo is live',
      media: [{ url: 'https://cdn.example.com/a.png', type: 'image/png' }],
      status: 'draft',
      type: 'post',
      scheduleDate: '2026-12-01T10:00:00.000Z',
    });
  });

  it.each(['published', 'scheduled', 'PUBLISHED'])('refuses non-draft status %s without calling the transport', async (status) => {
    const { calls, transport } = fake(ok);
    expect(await kindOf(createSocialPlannerDraft(transport, 'tok', { ...base, status }))).toBe('publish_refused');
    expect(calls).toHaveLength(0);
  });

  it('fails if GHL reports a non-draft status back', async () => {
    const { transport } = fake({ status: 201, body: { results: { post: { _id: 'p', status: 'published' } } } });
    expect(await kindOf(createSocialPlannerDraft(transport, 'tok', base))).toBe('unexpected');
  });

  it.each([
    [{ mediaUrls: ['http://cdn.example.com/a.png'] }],
    [{ mediaUrls: ['not a url'] }],
    [{ accountIds: [] }],
    [{ text: '   ' }],
    [{ text: 'x'.repeat(3001) }],
    [{ locationId: '../evil' }],
    [{ scheduleAt: 'tomorrow' }],
    [{ scheduleAt: '2027-02-30T10:00:00Z' }],
    [{ scheduleAt: '2027-02-01' }],
    [{ mediaUrls: ['https://cdn.example.com/a.webp'] }],
  ])('rejects invalid input %j before sending', async (patch) => {
    const { calls, transport } = fake(ok);
    expect(await kindOf(createSocialPlannerDraft(transport, 'tok', { ...base, ...patch } as any))).toBe('validation_input');
    expect(calls).toHaveLength(0);
  });

  it('refuses with no access token', async () => {
    const { calls, transport } = fake(ok);
    expect(await kindOf(createSocialPlannerDraft(transport, '', base))).toBe('auth');
    expect(calls).toHaveLength(0);
  });

  it.each([
    [401, 'auth', false],
    [403, 'auth', false],
    [422, 'validation', false],
    [400, 'validation', false],
    [429, 'rate_limited', true],
    [500, 'retryable', true],
    [503, 'retryable', true],
    [404, 'unexpected', false],
  ])('maps HTTP %i to %s', async (status, kind, retryable) => {
    const { transport } = fake({ status, body: { message: 'nope' }, headers: { 'retry-after': '30' } });
    try {
      await createSocialPlannerDraft(transport, 'tok', base);
      throw new Error('expected throw');
    } catch (e) {
      const err = e as GhlSocialPlannerError;
      expect(err.kind).toBe(kind);
      expect(err.status).toBe(status);
      expect(err.retryable).toBe(retryable);
      if (status === 429) expect(err.retryAfterSeconds).toBe(30);
    }
  });

  it('reads id and status from the same top-level post object', async () => {
    const { transport } = fake({ status: 201, body: { _id: 'p1', status: 'published' } });
    expect(await kindOf(createSocialPlannerDraft(transport, 'tok', base))).toBe('unexpected');
  });

  it('maps mov/webm to their documented media types', () => {
    const req = buildDraftRequest({ ...base, mediaUrls: ['https://c.example.com/a.mov', 'https://c.example.com/b.webm'] }, 'tok');
    expect(JSON.parse(req.body).media.map((m: any) => m.type)).toEqual(['video/mov', 'video/webm']);
  });

  it('treats a transport throw as retryable', async () => {
    const { transport } = fake(new Error('ECONNRESET'));
    expect(await kindOf(createSocialPlannerDraft(transport, 'tok', base))).toBe('retryable');
  });

  it('fails when the 2xx body has no post id', async () => {
    const { transport } = fake({ status: 200, body: { success: true } });
    expect(await kindOf(createSocialPlannerDraft(transport, 'tok', base))).toBe('unexpected');
  });
});
