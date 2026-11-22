import {
  HARD_DAILY_CEILING,
  JITTER_MAX_MS,
  JITTER_MIN_MS,
  classifyEngagementWrite,
  decideAutoApprove,
  effectiveDailyCap,
} from '../linkedInEngagementAutoApprove';

const ON = { LINKEDIN_SUPPORT_AUTO_APPROVE_ENABLED: 'true' } as NodeJS.ProcessEnv;
const like = { action: 'react', tier: 'support' };
const optedIn = { support_like: { autoApprove: true, dailyCap: 3 }, support_comment: { autoApprove: true } };

describe('ENG-707 engagement auto-approve', () => {
  it('flag off = current behaviour: always gated, even when opted in', () => {
    expect(decideAutoApprove(like, optedIn, {}, { env: {} as NodeJS.ProcessEnv })).toEqual({ autoApprove: false, reason: 'flag_off' });
    expect(decideAutoApprove(like, optedIn, {}, { env: { LINKEDIN_SUPPORT_AUTO_APPROVE_ENABLED: '1' } as any }).autoApprove).toBe(false);
  });

  it('non-finite usage fails closed as cap exhausted', () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(decideAutoApprove(like, optedIn, { support_like: bad }, { env: ON })).toMatchObject({ autoApprove: false, reason: 'cap_exhausted' });
    }
  });

  it('defaults OFF per user: no settings / no explicit opt-in keeps the gate', () => {
    expect(decideAutoApprove(like, undefined, {}, { env: ON })).toMatchObject({ autoApprove: false, reason: 'not_opted_in' });
    expect(decideAutoApprove(like, { support_like: {} }, {}, { env: ON })).toMatchObject({ reason: 'not_opted_in' });
  });

  it('opted-in support like is auto-approved with jittered delay', () => {
    const d = decideAutoApprove(like, optedIn, { support_like: 1 }, { env: ON, random: () => 0.5 });
    expect(d).toMatchObject({ autoApprove: true, actionClass: 'support_like', remainingAfter: 1 });
    if (d.autoApprove) {
      expect(d.delayMs).toBeGreaterThanOrEqual(JITTER_MIN_MS);
      expect(d.delayMs).toBeLessThanOrEqual(JITTER_MAX_MS);
    }
  });

  it('cap exhaustion falls back to the gate', () => {
    expect(decideAutoApprove(like, optedIn, { support_like: 3 }, { env: ON })).toMatchObject({ autoApprove: false, reason: 'cap_exhausted' });
  });

  it('user cap is clamped to the hard server-side ceiling', () => {
    expect(effectiveDailyCap('support_like', { autoApprove: true, dailyCap: 10_000 })).toBe(HARD_DAILY_CEILING.support_like);
    expect(effectiveDailyCap('support_comment', { autoApprove: true, dailyCap: -5 })).toBe(0);
    const d = decideAutoApprove(like, { support_like: { autoApprove: true, dailyCap: 10_000 } }, { support_like: HARD_DAILY_CEILING.support_like }, { env: ON });
    expect(d).toMatchObject({ reason: 'cap_exhausted' });
  });

  it.each([
    [{ action: 'comment', tier: 'sme', commentText: 'Great point' }],
    [{ action: 'comment', tier: 'support', commentText: 'x'.repeat(500) }],
    [{ action: 'comment', tier: 'support', commentText: 'Congrats!', parentCommentUrn: 'urn:li:comment:1' }],
    [{ action: 'send-invite', tier: 'support' }],
    [{ action: 'send-message', tier: 'support' }],
    [{ action: 'send_inmail', tier: 'support' }],
    [{ action: 'repost', tier: 'support' }],
    [{ action: 'react' }],
  ])('non-eligible write stays gated even when everything is opted in: %j', (write) => {
    expect(classifyEngagementWrite(write)).toBeNull();
    expect(decideAutoApprove(write, optedIn, {}, { env: ON })).toMatchObject({ autoApprove: false, reason: 'not_eligible' });
  });

  it('short support comment is eligible with default cap', () => {
    const d = decideAutoApprove({ action: 'comment', tier: 'SUPPORT', commentText: 'This is sharp.' }, optedIn, {}, { env: ON, random: () => 0 });
    expect(d).toMatchObject({ autoApprove: true, actionClass: 'support_comment', delayMs: JITTER_MIN_MS });
  });
});
