import { ActivationStage as S, emitActivation, activationProgress, buildActivationReport, activationCsv, observeActivationWrite, type ActivationDeps, type ActivationUser } from '../services/zomaActivationEvents';
const NOW = Date.parse('2026-11-09T12:00:00Z');
const user: ActivationUser = { userId: 'u1', email: 'u@example.com', createdAt: '2026-11-08T23:59:00Z' };
const event = (timestamp = '2026-11-08T10:00:00Z') => ({ userId: 'u1', timestamp });
const deps = (over: Partial<ActivationDeps> = {}): ActivationDeps => ({ enabled: () => true, getUser: jest.fn().mockResolvedValue(user), writeFirst: jest.fn().mockResolvedValue(true), now: () => NOW, ...over });

describe('ENG-2880 durable activation emitter', () => {
  it.each(Object.values(S))('writes typed %s with user and timestamp', async stage => {
    const d = deps();
    expect(await emitActivation('u1', stage, 'provider_rejected', d)).toBe(true);
    expect(d.writeFirst).toHaveBeenCalledWith(user, stage, { userId: 'u1', timestamp: '2026-11-09T12:00:00.000Z', ...(stage === S.AdLaunchFailed ? { error_category: 'provider_rejected' } : {}) });
  });
  it('dark mode makes no lookup or write', async () => {
    const d = deps({ enabled: () => false });
    expect(await emitActivation('u1', S.SignedUp, undefined, d)).toBe(false);
    expect(d.getUser).not.toHaveBeenCalled();
  });
  it('already observed stage avoids duplicate write cost; conditional guard still covers stale reads', async () => {
    const d = deps({ getUser: jest.fn().mockResolvedValue({ ...user, zomaActivationEvents: { signed_up: event() } }) });
    expect(await emitActivation('u1', S.SignedUp, undefined, d)).toBe(false);
    expect(d.writeFirst).not.toHaveBeenCalled();
  });
  it('conditional duplicate does not report a new event', async () => {
    expect(await emitActivation('u1', S.SignedUp, undefined, deps({ writeFirst: jest.fn().mockResolvedValue(false) }))).toBe(false);
  });
  it('missing user and category cannot persist an event', async () => {
    const d = deps({ getUser: jest.fn().mockResolvedValue(undefined) });
    expect(await emitActivation('missing', S.SignedUp, undefined, d)).toBe(false);
    expect(await emitActivation('u1', S.AdLaunchFailed, undefined, d)).toBe(false);
    expect(d.writeFirst).not.toHaveBeenCalled();
  });
  it('outage is swallowed, without provider payload logging', async () => {
    const log = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await emitActivation('u1', S.SignedUp, undefined, deps({ writeFirst: jest.fn().mockRejectedValue(new Error('secret')) }))).toBe(false);
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret');
    log.mockRestore();
  });
  it.each(['2026-11-09T00:00:00Z', 'invalid', '2026-11-10T00:00:00Z'])('no return on same/future/unknown signup day %s', async createdAt => {
    const d = deps({ getUser: jest.fn().mockResolvedValue({ ...user, createdAt }) });
    expect(await emitActivation('u1', S.ReturnedLaterDay, undefined, d)).toBe(false);
    expect(d.writeFirst).not.toHaveBeenCalled();
  });
});

describe('ENG-2880 progress semantics', () => {
  it('signup alone is stuck after threshold but never activated', () => {
    expect(activationProgress({ ...user, zomaActivationEvents: { signed_up: event() } }, NOW)).toMatchObject({ furthestStage: S.SignedUp, activated: false, stuck: true, stuckStage: S.SignedUp });
  });
  it('missing instrumentation is unknown, not an inferred signup or activation', () => {
    expect(activationProgress(user, NOW)).toMatchObject({ events: {}, furthestStage: null, activated: false, stuck: false });
  });
  it('failure and retention do not advance progress or reset stuck clock', () => {
    const report = buildActivationReport([{ ...user, zomaActivationEvents: { ad_creation_started: event(), ad_launch_failed: { ...event('2026-11-09T11:00:00Z'), error_category: 'provider_rejected' }, returned_later_day: event('2026-11-09T11:00:00Z') } }], NOW);
    expect(report.rows[0]).toMatchObject({ furthestStage: S.AdCreationStarted, activated: false, stuck: true, launchErrorCategory: 'provider_rejected' });
    expect(report.stuckByStage.ad_creation_started).toEqual(['u1']);
  });
  it('furthest stage is semantic, not latest callback; publication is terminal', () => {
    const r = activationProgress({ ...user, zomaActivationEvents: { signed_up: event('2026-11-09T11:00:00Z'), ad_published: event() } }, NOW);
    expect(r).toMatchObject({ furthestStage: S.AdPublished, activated: true, stuck: false });
  });
  it('rejects foreign identity and invalid event timestamps', () => {
    expect(activationProgress({ ...user, zomaActivationEvents: { ad_published: { ...event(), userId: 'other' }, signed_up: event('broken') } }, NOW).events).toEqual({});
  });
  it('CSV contains every stage timestamp and escapes quotes, newlines and formula cells', () => {
    const csv = activationCsv([activationProgress({ ...user, email: '=formula,"\n', zomaActivationEvents: { signed_up: event() } }, NOW)]);
    expect(csv).toContain('"returned_later_day"');
    expect(csv).toContain('"\'=formula,""\n"');
    expect(csv).toContain('2026-11-08T10:00:00Z');
  });
});

describe('ENG-2880 real write-result boundary', () => {
  const create = { entity_type: 'AD', action: 'CREATE' };
  const launch = { entity_type: 'AD', action: 'UPDATE', params: { status: 'ACTIVE' }, confirm: true };
  const run = async (args: any, result: any) => {
    const emit = jest.fn().mockResolvedValue(true);
    const execute = jest.fn().mockResolvedValue(result);
    expect(await observeActivationWrite('u1', args, execute, emit)).toBe(result);
    expect(execute).toHaveBeenCalledTimes(1);
    return emit;
  };
  it('a stalled activation sink cannot hold the confirmed write result hostage', async () => {
    const result = { success: true, verification: 'CONFIRMED', status: 'PAUSED', id: 'ad1' };
    const emit = jest.fn(() => new Promise<boolean>(() => {}));
    const execute = jest.fn().mockResolvedValue(result);
    await expect(observeActivationWrite('u1', create, execute, emit as any, 20)).resolves.toBe(result);
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('a throwing activation sink never fails the write', async () => {
    const result = { success: true, verification: 'CONFIRMED', status: 'PAUSED', id: 'ad1' };
    await expect(observeActivationWrite('u1', create, async () => result, jest.fn().mockRejectedValue(new Error('ddb')) as any, 20)).resolves.toBe(result);
  });
  it('preview starts creation but does not complete or activate', async () => {
    const emit = await run(create, { status: 'PREVIEW' });
    expect(emit.mock.calls).toEqual([['u1', S.AdCreationStarted]]);
  });
  it('confirmed PAUSED creation completes creation, not publication', async () => {
    const emit = await run(create, { success: true, verification: 'CONFIRMED', status: 'PAUSED' });
    expect(emit.mock.calls).toEqual([['u1', S.AdCreationStarted], ['u1', S.AdCreationCompleted]]);
  });
  it.each(['PREVIEW', 'PREVIEW_MISMATCH', 'NO_CHANGE', 'NEEDS_NEW_PREVIEW'])('launch %s is neither submitted nor published', async status => {
    expect((await run(launch, { status })).mock.calls).toEqual([]);
  });
  it('confirmed configured ACTIVE with pending review is submitted, never published', async () => {
    const emit = await run(launch, { success: true, verification: 'CONFIRMED', status: 'ACTIVE', effective_status: 'PENDING_REVIEW' });
    expect(emit.mock.calls).toEqual([['u1', S.AdSubmitted]]);
  });
  it('only provider-confirmed effective ACTIVE publishes', async () => {
    const emit = await run(launch, { success: true, verification: 'CONFIRMED', effective_status: 'ACTIVE' });
    expect(emit.mock.calls).toEqual([['u1', S.AdSubmitted], ['u1', S.AdPublished]]);
  });
  it.each([['MISMATCH', 'verification_mismatch'], ['UNCONFIRMED', 'verification_unavailable']])('%s is a categorized failure, not publication', async (verification, category) => {
    expect((await run(launch, { verification, success: false })).mock.calls).toEqual([['u1', S.AdSubmitted], ['u1', S.AdLaunchFailed, category]]);
  });
  it('provider rejection is categorized', async () => {
    expect((await run(launch, { status: 'FAILED', success: false })).mock.calls).toEqual([['u1', S.AdLaunchFailed, 'provider_rejected']]);
  });
  it('throw preserves the business error and records no raw error text', async () => {
    const emit = jest.fn().mockResolvedValue(true);
    const error = new Error('provider secret');
    await expect(observeActivationWrite('u1', launch, async () => { throw error; }, emit)).rejects.toBe(error);
    expect(emit.mock.calls).toEqual([['u1', S.AdLaunchFailed, 'upstream_error']]);
  });
  it('campaign and ad set activation never claim an ad published', async () => {
    expect((await run({ ...launch, entity_type: 'CAMPAIGN' }, { success: true, verification: 'CONFIRMED', effective_status: 'ACTIVE' })).mock.calls).toEqual([]);
  });
});
