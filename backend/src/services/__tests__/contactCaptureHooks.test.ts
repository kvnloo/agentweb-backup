import {
  onUserRegistered,
  onOnboardingStageChanged,
  onPublicFormSubmitted,
  onPublicPageVisited,
  logManualEvent,
  isKnownContactEventType,
  EventsDbLike,
} from '../contactCaptureHooks';
import type { LogEventInput, LogEventResult } from '../contactEventsDb';

function makeStubEventsDb(): {
  fn: jest.Mock;
  calls: LogEventInput[];
  eventsDb: EventsDbLike;
} {
  const calls: LogEventInput[] = [];
  const fn = jest.fn(async (input: LogEventInput): Promise<LogEventResult> => {
    calls.push(input);
    return {
      event: {
        contactId: input.contactId,
        eventTimestamp: input.eventTimestamp || '2026-04-18T00:00:00Z',
        eventId: 'evt_stub_1',
        source: input.source,
        eventType: input.eventType,
        payload: input.payload || {},
        sourceRecordId: input.sourceRecordId,
        createdAt: '2026-04-18T00:00:00Z',
      },
      deduplicated: false,
    };
  });
  return { fn, calls, eventsDb: { logEvent: fn } as EventsDbLike };
}

const silentLogger = { error: jest.fn(), warn: jest.fn() };

beforeEach(() => {
  silentLogger.error.mockClear();
  silentLogger.warn.mockClear();
});

/* -------------------------------------------------------------------------- */
/*  isKnownContactEventType                                                    */
/* -------------------------------------------------------------------------- */

describe('isKnownContactEventType', () => {
  it('accepts every new activity-timeline event type', () => {
    expect(isKnownContactEventType('form.submitted')).toBe(true);
    expect(isKnownContactEventType('page.visited')).toBe(true);
    expect(isKnownContactEventType('user.registered')).toBe(true);
    expect(isKnownContactEventType('onboarding.stage_changed')).toBe(true);
    expect(isKnownContactEventType('attribution.first_touch')).toBe(true);
    expect(isKnownContactEventType('manual.note')).toBe(true);
  });

  it('still accepts existing CRM event types', () => {
    expect(isKnownContactEventType('contact.created')).toBe(true);
    expect(isKnownContactEventType('payment.subscribed')).toBe(true);
    expect(isKnownContactEventType('engagement.emma_session')).toBe(true);
  });

  it('rejects unknown types, null, undefined, and non-strings', () => {
    expect(isKnownContactEventType('not.a.real.type')).toBe(false);
    expect(isKnownContactEventType(null)).toBe(false);
    expect(isKnownContactEventType(undefined)).toBe(false);
    expect(isKnownContactEventType(42)).toBe(false);
    expect(isKnownContactEventType('')).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*  onUserRegistered                                                           */
/* -------------------------------------------------------------------------- */

describe('onUserRegistered', () => {
  it('logs a user.registered event for a new user', async () => {
    const { fn, calls, eventsDb } = makeStubEventsDb();

    await onUserRegistered(
      {
        userId: 'u_abc',
        email: 'Jane@Example.com',
        displayName: 'Jane Doe',
        signupSource: 'password',
        createdAt: '2026-04-18T12:00:00Z',
      },
      { eventsDb, logger: silentLogger }
    );

    expect(fn).toHaveBeenCalledTimes(1);
    expect(calls[0].contactId).toBe('jane@example.com'); // lowercased
    expect(calls[0].source).toBe('signup');
    expect(calls[0].eventType).toBe('user.registered');
    expect(calls[0].sourceRecordId).toBe('user-registered-u_abc');
    expect(calls[0].payload).toMatchObject({
      userId: 'u_abc',
      displayName: 'Jane Doe',
      signupSource: 'password',
      registeredAt: '2026-04-18T12:00:00Z',
    });
  });

  it('uses the same sourceRecordId on replay (idempotent)', async () => {
    const { calls, eventsDb } = makeStubEventsDb();
    await onUserRegistered({ userId: 'u1', email: 'a@b.com' }, { eventsDb, logger: silentLogger });
    await onUserRegistered({ userId: 'u1', email: 'a@b.com' }, { eventsDb, logger: silentLogger });
    expect(calls[0].sourceRecordId).toBe(calls[1].sourceRecordId);
    expect(calls[0].sourceRecordId).toBe('user-registered-u1');
  });

  it('no-ops when email or userId is missing', async () => {
    const { fn, eventsDb } = makeStubEventsDb();
    await onUserRegistered({ userId: '', email: 'a@b.com' }, { eventsDb, logger: silentLogger });
    await onUserRegistered({ userId: 'u1', email: '' }, { eventsDb, logger: silentLogger });
    expect(fn).not.toHaveBeenCalled();
    expect(silentLogger.warn).toHaveBeenCalledTimes(2);
  });

  it('skips logging when hasMatchingLead returns false', async () => {
    const { fn, eventsDb } = makeStubEventsDb();
    const hasMatchingLead = jest.fn().mockResolvedValue(false);

    const result = await onUserRegistered(
      { userId: 'u1', email: 'nope@example.com' },
      { eventsDb, logger: silentLogger, hasMatchingLead }
    );

    expect(result).toBeNull();
    expect(fn).not.toHaveBeenCalled();
    expect(hasMatchingLead).toHaveBeenCalledWith('nope@example.com');
  });

  it('logs when hasMatchingLead returns true', async () => {
    const { fn, eventsDb } = makeStubEventsDb();
    const hasMatchingLead = jest.fn().mockResolvedValue(true);

    await onUserRegistered(
      { userId: 'u1', email: 'yes@example.com' },
      { eventsDb, logger: silentLogger, hasMatchingLead }
    );

    expect(fn).toHaveBeenCalledTimes(1);
    expect(hasMatchingLead).toHaveBeenCalledWith('yes@example.com');
  });

  it('swallows errors so caller is never broken', async () => {
    const eventsDb: EventsDbLike = {
      logEvent: jest.fn().mockRejectedValue(new Error('boom')),
    };
    const result = await onUserRegistered(
      { userId: 'u1', email: 'a@b.com' },
      { eventsDb, logger: silentLogger }
    );
    expect(result).toBeNull();
    expect(silentLogger.error).toHaveBeenCalledTimes(1);
  });
});

/* -------------------------------------------------------------------------- */
/*  onOnboardingStageChanged                                                   */
/* -------------------------------------------------------------------------- */

describe('onOnboardingStageChanged', () => {
  it('logs a stage transition with from/to in payload', async () => {
    const { calls, eventsDb } = makeStubEventsDb();

    await onOnboardingStageChanged(
      {
        userId: 'u_1',
        email: 'a@b.com',
        fromStage: 'new',
        toStage: 'onboarding',
        triggeredByEvent: 'goal_selected',
        changedAt: '2026-04-18T10:00:00Z',
      },
      { eventsDb, logger: silentLogger }
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].eventType).toBe('onboarding.stage_changed');
    expect(calls[0].contactId).toBe('a@b.com');
    expect(calls[0].payload).toMatchObject({
      userId: 'u_1',
      fromStage: 'new',
      toStage: 'onboarding',
      triggeredByEvent: 'goal_selected',
    });
    expect(calls[0].eventTimestamp).toBe('2026-04-18T10:00:00Z');
    // sourceRecordId should encode the transition so each one is unique
    expect(calls[0].sourceRecordId).toContain('u_1');
    expect(calls[0].sourceRecordId).toContain('onboarding');
  });

  it('no-ops when fromStage === toStage (not a real change)', async () => {
    const { fn, eventsDb } = makeStubEventsDb();
    const result = await onOnboardingStageChanged(
      { userId: 'u1', email: 'a@b.com', fromStage: 'active', toStage: 'active' },
      { eventsDb, logger: silentLogger }
    );
    expect(result).toBeNull();
    expect(fn).not.toHaveBeenCalled();
  });

  it('accepts null fromStage (first-time stage assignment)', async () => {
    const { calls, eventsDb } = makeStubEventsDb();
    await onOnboardingStageChanged(
      { userId: 'u1', email: 'a@b.com', fromStage: null, toStage: 'new' },
      { eventsDb, logger: silentLogger }
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].payload?.fromStage).toBeNull();
    expect(calls[0].payload?.toStage).toBe('new');
  });

  it('skips when hasMatchingLead returns false', async () => {
    const { fn, eventsDb } = makeStubEventsDb();
    const result = await onOnboardingStageChanged(
      { userId: 'u1', email: 'a@b.com', fromStage: 'new', toStage: 'active' },
      { eventsDb, logger: silentLogger, hasMatchingLead: async () => false }
    );
    expect(result).toBeNull();
    expect(fn).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/*  onPublicFormSubmitted                                                      */
/* -------------------------------------------------------------------------- */

describe('onPublicFormSubmitted', () => {
  it('logs a form.submitted event with lead_form source', async () => {
    const { calls, eventsDb } = makeStubEventsDb();
    await onPublicFormSubmitted(
      {
        email: 'visitor@example.com',
        sourceRecordId: 'form-lead-magnet-submission-123',
        formName: 'lead-magnet',
        payload: { slug: 'seo-audit', referrer: 'linkedin' },
      },
      { eventsDb, logger: silentLogger }
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].source).toBe('lead_form');
    expect(calls[0].eventType).toBe('form.submitted');
    expect(calls[0].sourceRecordId).toBe('form-lead-magnet-submission-123');
    expect(calls[0].payload).toMatchObject({
      formName: 'lead-magnet',
      slug: 'seo-audit',
      referrer: 'linkedin',
    });
  });

  it('no-ops when email or sourceRecordId is missing', async () => {
    const { fn, eventsDb } = makeStubEventsDb();
    await onPublicFormSubmitted({ email: '', sourceRecordId: 'x' }, { eventsDb, logger: silentLogger });
    await onPublicFormSubmitted({ email: 'a@b.com', sourceRecordId: '' }, { eventsDb, logger: silentLogger });
    expect(fn).not.toHaveBeenCalled();
    expect(silentLogger.warn).toHaveBeenCalledTimes(2);
  });
});

/* -------------------------------------------------------------------------- */
/*  onPublicPageVisited                                                        */
/* -------------------------------------------------------------------------- */

describe('onPublicPageVisited', () => {
  it('logs a page.visited engagement event', async () => {
    const { calls, eventsDb } = makeStubEventsDb();
    await onPublicPageVisited(
      {
        email: 'v@example.com',
        sourceRecordId: 'page-visit-abc',
        url: 'https://agentweb.pro/pricing',
        referrer: 'https://google.com',
      },
      { eventsDb, logger: silentLogger }
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].source).toBe('engagement');
    expect(calls[0].eventType).toBe('page.visited');
    expect(calls[0].payload).toMatchObject({
      url: 'https://agentweb.pro/pricing',
      referrer: 'https://google.com',
    });
  });
});

/* -------------------------------------------------------------------------- */
/*  logManualEvent                                                             */
/* -------------------------------------------------------------------------- */

describe('logManualEvent', () => {
  it('logs a manual.note event with the caller-provided summary', async () => {
    const { calls, eventsDb } = makeStubEventsDb();
    await logManualEvent(
      {
        contactId: 'Jane@Acme.com',
        eventType: 'manual.note',
        summary: 'Left voicemail, asked about enterprise pricing',
        details: { duration: 35 },
        loggedByUserId: 'u_harsha',
      },
      { eventsDb, logger: silentLogger }
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].contactId).toBe('jane@acme.com');
    expect(calls[0].source).toBe('manual');
    expect(calls[0].eventType).toBe('manual.note');
    expect(calls[0].payload?.summary).toBe('Left voicemail, asked about enterprise pricing');
    expect(calls[0].payload?.loggedByUserId).toBe('u_harsha');
    expect((calls[0].payload as any).details).toEqual({ duration: 35 });
    // auto-generated sourceRecordId
    expect(calls[0].sourceRecordId).toMatch(/^manual-u_harsha-\d+-/);
  });

  it('preserves a caller-provided sourceRecordId for idempotency', async () => {
    const { calls, eventsDb } = makeStubEventsDb();
    await logManualEvent(
      {
        contactId: 'a@b.com',
        eventType: 'meeting.attended',
        summary: 'Discovery call',
        sourceRecordId: 'meeting-fathom-xyz',
      },
      { eventsDb, logger: silentLogger }
    );
    expect(calls[0].sourceRecordId).toBe('meeting-fathom-xyz');
  });

  it('trims summary before persisting', async () => {
    const { calls, eventsDb } = makeStubEventsDb();
    await logManualEvent(
      {
        contactId: 'a@b.com',
        eventType: 'manual.note',
        summary: '   hello world   ',
      },
      { eventsDb, logger: silentLogger }
    );
    expect(calls[0].payload?.summary).toBe('hello world');
  });

  it.each([
    ['empty contactId', { contactId: '', eventType: 'manual.note' as const, summary: 'x' }],
    ['empty summary', { contactId: 'a@b.com', eventType: 'manual.note' as const, summary: '   ' }],
    ['missing eventType', { contactId: 'a@b.com', eventType: '' as any, summary: 'x' }],
  ])('no-ops on %s', async (_label, input) => {
    const { fn, eventsDb } = makeStubEventsDb();
    const result = await logManualEvent(input as any, { eventsDb, logger: silentLogger });
    expect(result).toBeNull();
    expect(fn).not.toHaveBeenCalled();
  });

  it('swallows errors from the events db', async () => {
    const eventsDb: EventsDbLike = { logEvent: jest.fn().mockRejectedValue(new Error('ddb down')) };
    const result = await logManualEvent(
      { contactId: 'a@b.com', eventType: 'manual.note', summary: 'hi' },
      { eventsDb, logger: silentLogger }
    );
    expect(result).toBeNull();
    expect(silentLogger.error).toHaveBeenCalledTimes(1);
  });
});
