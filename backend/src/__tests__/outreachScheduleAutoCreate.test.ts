// ENG-1723 / ENG-1609 AC #10 — auto-create the outreach schedule at onboarding.
//
// This creates a LIVE schedule that sends real connection requests from a real
// person's LinkedIn account with no chat interaction. A wrong predicate means
// unrequested outreach under someone's own name. Hence: default-off flag, a
// dry-run that works regardless of it, and a named reason on every path.

import {
  OUTREACH_AUTO_CREATE_FLAG,
  SUPPORTED_FREQUENCIES,
  DEFAULT_DAILY_CONNECTION_TARGET,
  isOutreachAutoCreateEnabled,
  evaluateAutoCreateTrigger,
  resolveTierOutreachCapable,
  autoCreateOutreachSchedule,
  type AutoCreateDeps,
} from '../services/agentMode/outreachScheduleAutoCreate';

const eligible = {
  flagEnabled: true,
  dryRun: false,
  hasLinkedInAccount: true,
  leadListId: 'list-1',
  tierOutreachCapable: true as boolean | null,
  templateId: 'tpl-1',
  existingScheduleId: null as string | null,
};

describe('the flag (AC #2)', () => {
  const OLD = process.env[OUTREACH_AUTO_CREATE_FLAG];
  afterEach(() => {
    if (OLD === undefined) delete process.env[OUTREACH_AUTO_CREATE_FLAG];
    else process.env[OUTREACH_AUTO_CREATE_FLAG] = OLD;
  });

  it('is off unless set to exactly the string "true"', () => {
    delete process.env[OUTREACH_AUTO_CREATE_FLAG];
    expect(isOutreachAutoCreateEnabled()).toBe(false);
    ['', 'false', 'TRUE', '1', 'yes'].forEach((v) => {
      process.env[OUTREACH_AUTO_CREATE_FLAG] = v;
      expect(isOutreachAutoCreateEnabled()).toBe(false);
    });
    process.env[OUTREACH_AUTO_CREATE_FLAG] = 'true';
    expect(isOutreachAutoCreateEnabled()).toBe(true);
  });
});

describe('evaluateAutoCreateTrigger (AC #5: never a silent no-op)', () => {
  it('creates when every predicate holds', () => {
    expect(evaluateAutoCreateTrigger(eligible)).toEqual({
      create: true, reason: 'eligible', detail: 'All preconditions met.',
    });
  });

  it('reports flag_disabled when everything else is ready', () => {
    const d = evaluateAutoCreateTrigger({ ...eligible, flagEnabled: false });
    expect(d).toMatchObject({ create: false, reason: 'flag_disabled' });
    expect(d.detail).toContain(OUTREACH_AUTO_CREATE_FLAG);
  });

  it('AC #3: a dry run passes the flag gate but nothing else', () => {
    expect(evaluateAutoCreateTrigger({ ...eligible, flagEnabled: false, dryRun: true }).create).toBe(true);
    // A dry run still respects every real predicate — it proves the trigger, it
    // does not bypass it.
    expect(evaluateAutoCreateTrigger({ ...eligible, flagEnabled: false, dryRun: true, hasLinkedInAccount: false }))
      .toMatchObject({ create: false, reason: 'no_linkedin_account' });
  });

  it('names each missing predicate distinctly', () => {
    expect(evaluateAutoCreateTrigger({ ...eligible, hasLinkedInAccount: false }))
      .toMatchObject({ reason: 'no_linkedin_account', create: false });
    expect(evaluateAutoCreateTrigger({ ...eligible, leadListId: null }))
      .toMatchObject({ reason: 'no_icp', create: false });
    expect(evaluateAutoCreateTrigger({ ...eligible, tierOutreachCapable: false }))
      .toMatchObject({ reason: 'tier_not_outreach_capable', create: false });
    expect(evaluateAutoCreateTrigger({ ...eligible, templateId: null }))
      .toMatchObject({ reason: 'template_missing', create: false });
    // Every one carries a usable explanation, not just a code.
    [
      { ...eligible, hasLinkedInAccount: false },
      { ...eligible, leadListId: null },
      { ...eligible, tierOutreachCapable: false },
      { ...eligible, templateId: null },
    ].forEach((input) => {
      expect(evaluateAutoCreateTrigger(input).detail.length).toBeGreaterThan(20);
    });
  });

  it('FAILS CLOSED on an unresolved entitlement rather than assuming either way', () => {
    // isSubscriptionFeatureEnabled returns null when the admin setting cannot be
    // read. Background jobs elsewhere may retry on null; this one creates live
    // outreach, so it refuses and says so.
    const d = evaluateAutoCreateTrigger({ ...eligible, tierOutreachCapable: null });
    expect(d).toMatchObject({ create: false, reason: 'tier_unresolved' });
    expect(d.detail).toContain('Refusing rather than assuming');
  });

  it('AC #4: an existing schedule short-circuits before any other reason', () => {
    // Reported first even when other predicates are also missing — "already done"
    // is the only reason that means nothing is wrong.
    const d = evaluateAutoCreateTrigger({
      ...eligible, existingScheduleId: 'sched-9', hasLinkedInAccount: false, leadListId: null,
    });
    expect(d).toMatchObject({ create: false, reason: 'already_exists' });
    expect(d.detail).toContain('sched-9');
  });
});

describe('resolveTierOutreachCapable (predicate c)', () => {
  const deps = (scheduled: boolean | null, allowed: string[] | null) => ({
    scheduledChatsEnabled: jest.fn(async () => scheduled),
    allowedConnectedAccounts: jest.fn(async () => allowed as string[]),
  });

  it('requires BOTH scheduled chats and a permitted unipile platform', async () => {
    expect(await resolveTierOutreachCapable('u', deps(true, ['unipile', 'gmail']))).toBe(true);
    expect(await resolveTierOutreachCapable('u', deps(true, ['*']))).toBe(true);
    expect(await resolveTierOutreachCapable('u', deps(true, ['gmail']))).toBe(false);
    expect(await resolveTierOutreachCapable('u', deps(false, ['*']))).toBe(false);
  });

  it('propagates null — an unresolved entitlement is never collapsed to false', async () => {
    // false means "denied"; null means "we do not know". Collapsing them would
    // hide a broken admin setting behind a legitimate-looking denial.
    expect(await resolveTierOutreachCapable('u', deps(null, ['*']))).toBeNull();
    expect(await resolveTierOutreachCapable('u', deps(true, null))).toBeNull();
  });

  it('does not even ask about platforms when scheduled chats are denied', async () => {
    const d = deps(false, ['*']);
    await resolveTierOutreachCapable('u', d);
    expect(d.allowedConnectedAccounts).not.toHaveBeenCalled();
  });
});

describe('autoCreateOutreachSchedule', () => {
  const OLD = process.env[OUTREACH_AUTO_CREATE_FLAG];
  const TEMPLATE = {
    templateId: 'tpl-1',
    name: 'Daily LinkedIn Connection + Outreach Agent',
    description: 'Sources prospects and sends invites.',
    startingMessage: 'Target {{icp_description}} at {{daily_connection_target}} with {{message_template}} into {{lead_list_id}}.',
    variables: [
      { name: 'icp_description', description: 'x', type: 'long_text' },
      { name: 'daily_connection_target', description: 'x', type: 'text' },
      { name: 'message_template', description: 'x', type: 'long_text' },
      { name: 'lead_list_id', description: 'x', type: 'text' },
    ],
    requiredFunctionCalls: ['linkedin_outreach'],
    functionCallMinCalls: { linkedin_outreach: 1 },
    suggestedFrequency: 'daily',
  };

  const makeDeps = (over: Partial<AutoCreateDeps> = {}): AutoCreateDeps => ({
    listOwnUnipileAccountIds: jest.fn(async () => ['acc-1']),
    scheduledChatsEnabled: jest.fn(async () => true),
    allowedConnectedAccounts: jest.fn(async () => ['*']),
    findTemplate: jest.fn(async () => TEMPLATE),
    findExistingSchedule: jest.fn(async () => null),
    createSchedule: jest.fn(async () => undefined),
    countTemplateUse: jest.fn(async () => undefined),
    now: () => new Date('2026-09-07T12:00:00.000Z'),
    newId: () => 'sched-new',
    ...over,
  });

  afterEach(() => {
    if (OLD === undefined) delete process.env[OUTREACH_AUTO_CREATE_FLAG];
    else process.env[OUTREACH_AUTO_CREATE_FLAG] = OLD;
  });

  const run = (over: Partial<AutoCreateDeps> = {}, extra: any = {}) =>
    autoCreateOutreachSchedule({
      userId: 'user-1', leadListId: 'list-1', icpDescription: 'Heads of Clinical Ops',
      deps: makeDeps(over), ...extra,
    });

  it('AC #2: with the flag off it writes nothing and says why', async () => {
    delete process.env[OUTREACH_AUTO_CREATE_FLAG];
    const deps = makeDeps();

    const result = await autoCreateOutreachSchedule({
      userId: 'user-1', leadListId: 'list-1', deps,
    });

    expect(result).toMatchObject({ outcome: 'skipped', reason: 'flag_disabled' });
    expect(deps.createSchedule).not.toHaveBeenCalled();
  });

  it('AC #3: dry run reports customer, template, list and target — and writes nothing', async () => {
    delete process.env[OUTREACH_AUTO_CREATE_FLAG];
    const deps = makeDeps();

    const result = await autoCreateOutreachSchedule({
      userId: 'user-1', leadListId: 'list-1', icpDescription: 'Heads of Clinical Ops',
      dryRun: true, deps,
    });

    expect(result.outcome).toBe('dry_run');
    expect(result.plan).toEqual({
      userId: 'user-1',
      templateId: 'tpl-1',
      templateName: 'Daily LinkedIn Connection + Outreach Agent',
      leadListId: 'list-1',
      icpDescription: 'Heads of Clinical Ops',
      dailyConnectionTarget: DEFAULT_DAILY_CONNECTION_TARGET,
      frequency: 'daily',
    });
    expect(result.detail).toContain('Nothing was written');
    expect(deps.createSchedule).not.toHaveBeenCalled();
  });

  it('AC #1: with the flag on and every predicate met, creates a live schedule', async () => {
    process.env[OUTREACH_AUTO_CREATE_FLAG] = 'true';
    const deps = makeDeps();

    const result = await autoCreateOutreachSchedule({
      userId: 'user-1', leadListId: 'list-1', icpDescription: 'Heads of Clinical Ops', deps,
    });

    expect(result).toMatchObject({ outcome: 'created', scheduleId: 'sched-new' });
    const created = (deps.createSchedule as jest.Mock).mock.calls[0][0];
    expect(created).toMatchObject({
      userId: 'user-1',
      frequency: 'daily',
      // AC #6: an ordinary active schedule — visible, editable, pausable.
      status: 'active',
      type: 'scheduled_chat',
      requiredFunctionCalls: ['linkedin_outreach'],
      functionCallMinCalls: { linkedin_outreach: 1 },
      variableRequestStatus: 'provided',
      autoCreatedFromTemplateId: 'tpl-1',
    });
    expect(deps.countTemplateUse).toHaveBeenCalledWith('tpl-1');
  });

  // Found in production 2026-09-09: the row was written perfectly and the schedule
  // still never ran. `runScheduledChats` accepts prefilled variables only through
  // `prefilledWithoutRequest` = `!variableRequestSentAt && variableValuesUpdatedAt`,
  // so an absent timestamp fails the gate despite `variableRequestStatus: 'provided'`
  // and every value being present. The schedule then emails its owner asking for the
  // ICP they just supplied at onboarding, advances nextRunTime a day, and repeats
  // forever. Checking the written row is NOT the same as checking it runs.
  it('stamps variableValuesUpdatedAt, without which the schedule never runs', async () => {
    process.env[OUTREACH_AUTO_CREATE_FLAG] = 'true';
    const deps = makeDeps();
    await autoCreateOutreachSchedule({
      userId: 'user-1', leadListId: 'list-1', icpDescription: 'Heads of Clinical Ops', deps,
    });

    const created = (deps.createSchedule as jest.Mock).mock.calls[0][0];
    expect(typeof created.variableValuesUpdatedAt).toBe('string');
    expect(created.variableValuesUpdatedAt).not.toBe('');
    expect(Number.isNaN(Date.parse(created.variableValuesUpdatedAt))).toBe(false);
    // The gate also requires that no variable request was ever sent for a prefilled
    // schedule, so this path must not set that marker.
    expect(created.variableRequestSentAt).toBeUndefined();
  });

  it('fills EVERY template variable — a blank one hard-fails the first run', async () => {
    process.env[OUTREACH_AUTO_CREATE_FLAG] = 'true';
    const deps = makeDeps();
    await autoCreateOutreachSchedule({
      userId: 'user-1', leadListId: 'list-1', icpDescription: 'Heads of Clinical Ops', deps,
    });

    const created = (deps.createSchedule as jest.Mock).mock.calls[0][0];
    expect(created.variableValues).toEqual({
      icp_description: 'Heads of Clinical Ops',
      daily_connection_target: '10',
      message_template: 'default',
      lead_list_id: 'list-1',
    });
    // Nothing left unsubstituted in the copied prompt.
    const unfilled = (created.startingMessage.match(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g) || [])
      .filter((ph: string) => !created.variableValues[ph.replace(/[{}\s]/g, '')]);
    expect(unfilled).toEqual([]);
  });

  it('substitutes a usable ICP description when onboarding captured none', async () => {
    process.env[OUTREACH_AUTO_CREATE_FLAG] = 'true';
    const deps = makeDeps();
    await autoCreateOutreachSchedule({ userId: 'user-1', leadListId: 'list-1', icpDescription: '   ', deps });

    const created = (deps.createSchedule as jest.Mock).mock.calls[0][0];
    expect(created.variableValues.icp_description).toBe('the audience captured during onboarding');
  });

  // CodeRabbit on PR #2802: calculateNextRunTime silently falls back to DAILY for
  // an unknown cadence, and to a ONE-day interval for every_n_days with no
  // interval — so the account would send more often than the template asked for,
  // unattended, and the persisted row would claim a cadence nobody honours.
  it('carries every_n_days through to the schedule AND to the next-run calculation', async () => {
    process.env[OUTREACH_AUTO_CREATE_FLAG] = 'true';
    const deps = makeDeps({
      findTemplate: jest.fn(async () => ({ ...TEMPLATE, suggestedFrequency: 'every_n_days', frequencyIntervalDays: 3 })),
    });

    const result = await autoCreateOutreachSchedule({ userId: 'user-1', leadListId: 'list-1', deps });

    expect(result.outcome).toBe('created');
    expect(result.plan).toMatchObject({ frequency: 'every_n_days', frequencyIntervalDays: 3 });
    const created = (deps.createSchedule as jest.Mock).mock.calls[0][0];
    expect(created.frequency).toBe('every_n_days');
    expect(created.frequencyIntervalDays).toBe(3);
  });

  it('refuses every_n_days with no usable interval rather than running daily', async () => {
    process.env[OUTREACH_AUTO_CREATE_FLAG] = 'true';
    for (const bad of [undefined, 0, -2, 1.5, 'three']) {
      const deps = makeDeps({
        findTemplate: jest.fn(async () => ({ ...TEMPLATE, suggestedFrequency: 'every_n_days', frequencyIntervalDays: bad as any })),
      });
      const result = await autoCreateOutreachSchedule({ userId: 'user-1', leadListId: 'list-1', deps });
      expect(result).toMatchObject({ outcome: 'skipped', reason: 'template_cadence_invalid' });
      expect(deps.createSchedule).not.toHaveBeenCalled();
    }
  });

  it('refuses a cadence the scheduler does not understand', async () => {
    process.env[OUTREACH_AUTO_CREATE_FLAG] = 'true';
    const deps = makeDeps({
      findTemplate: jest.fn(async () => ({ ...TEMPLATE, suggestedFrequency: 'fortnightly' })),
    });
    const result = await autoCreateOutreachSchedule({ userId: 'user-1', leadListId: 'list-1', deps });
    expect(result).toMatchObject({ outcome: 'skipped', reason: 'template_cadence_invalid' });
    expect(deps.createSchedule).not.toHaveBeenCalled();
  });

  it('accepts every supported cadence, and omits the interval for the others', async () => {
    process.env[OUTREACH_AUTO_CREATE_FLAG] = 'true';
    for (const f of SUPPORTED_FREQUENCIES) {
      const deps = makeDeps({
        findTemplate: jest.fn(async () => ({ ...TEMPLATE, suggestedFrequency: f, frequencyIntervalDays: 2 })),
      });
      const result = await autoCreateOutreachSchedule({ userId: 'user-1', leadListId: 'list-1', deps });
      expect(result.outcome).toBe('created');
      const created = (deps.createSchedule as jest.Mock).mock.calls[0][0];
      expect(created.frequencyIntervalDays).toBe(f === 'every_n_days' ? 2 : undefined);
    }
  });

  it('AC #4: never creates a second schedule for the same customer', async () => {
    process.env[OUTREACH_AUTO_CREATE_FLAG] = 'true';
    const deps = makeDeps({ findExistingSchedule: jest.fn(async () => 'sched-existing') });

    const result = await autoCreateOutreachSchedule({ userId: 'user-1', leadListId: 'list-1', deps });

    expect(result).toMatchObject({ outcome: 'skipped', reason: 'already_exists' });
    expect(deps.createSchedule).not.toHaveBeenCalled();
  });

  it('AC #5: refuses with the right reason for each missing predicate', async () => {
    process.env[OUTREACH_AUTO_CREATE_FLAG] = 'true';

    expect(await run({ listOwnUnipileAccountIds: jest.fn(async () => []) }))
      .toMatchObject({ outcome: 'skipped', reason: 'no_linkedin_account' });
    expect(await autoCreateOutreachSchedule({ userId: 'u', leadListId: null, deps: makeDeps() }))
      .toMatchObject({ outcome: 'skipped', reason: 'no_icp' });
    expect(await run({ scheduledChatsEnabled: jest.fn(async () => false) }))
      .toMatchObject({ outcome: 'skipped', reason: 'tier_not_outreach_capable' });
    expect(await run({ scheduledChatsEnabled: jest.fn(async () => null) }))
      .toMatchObject({ outcome: 'skipped', reason: 'tier_unresolved' });
    expect(await run({ findTemplate: jest.fn(async () => null) }))
      .toMatchObject({ outcome: 'skipped', reason: 'template_missing' });
  });

  it('a thrown dependency degrades to a refusal, never to an unguarded create', async () => {
    process.env[OUTREACH_AUTO_CREATE_FLAG] = 'true';

    expect(await run({ listOwnUnipileAccountIds: jest.fn(async () => { throw new Error('db down'); }) }))
      .toMatchObject({ outcome: 'skipped', reason: 'no_linkedin_account' });
    // An entitlement lookup that throws must not read as "permitted".
    expect(await run({ scheduledChatsEnabled: jest.fn(async () => { throw new Error('settings down'); }) }))
      .toMatchObject({ outcome: 'skipped', reason: 'tier_unresolved' });
    expect(await run({ findTemplate: jest.fn(async () => { throw new Error('dynamo down'); }) }))
      .toMatchObject({ outcome: 'skipped', reason: 'template_missing' });
  });

  it('does not let a usage-count failure undo a completed creation', async () => {
    process.env[OUTREACH_AUTO_CREATE_FLAG] = 'true';
    const deps = makeDeps({ countTemplateUse: jest.fn(async () => { throw new Error('nope'); }) });

    const result = await autoCreateOutreachSchedule({ userId: 'user-1', leadListId: 'list-1', deps });

    expect(result.outcome).toBe('created');
  });
});
