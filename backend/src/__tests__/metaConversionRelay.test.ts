/**
 * ENG-926 §C — CRM → Meta event relay.
 *
 * The card's missing return path: today conversion data flows Meta → us and stops at
 * `Lead`. Nothing tells Meta what became of the lead, so Meta optimizes toward form
 * fills rather than revenue. This relays `qualified` and closed-won back.
 *
 * Two properties matter more than the mapping itself and are tested hardest here:
 *   1. fire-once — a lead going won → lost → won must not double-count a Purchase,
 *      which is the exact failure §E's dedup contract exists to prevent;
 *   2. never fail-closed — a missing pixel, a missing dealValue or a Meta-side error
 *      must never break the lead write that already succeeded. Failing closed here
 *      IS the original RankAI silent-undercounting bug.
 */

import {
  mapStatusToMetaEvent,
  buildRelayEventId,
  buildFbcFromFirstTouch,
  buildConversionValue,
  isConversionRelayEnabled,
  resolveEventName,
  relayLeadStatusEvent,
  RelayDeps,
} from '../services/metaConversionRelay';

const LEAD_STATUS_CONFIG = [
  { value: 'new', label: 'New', color: 'gray', type: 'active' as const },
  { value: 'qualified', label: 'Qualified', color: 'indigo', type: 'active' as const },
  { value: 'won', label: 'Won', color: 'green', type: 'won' as const },
  { value: 'lost', label: 'Lost', color: 'red', type: 'lost' as const },
];

/** Opted in — the relay is default-off, so every send-path test needs an owner who has
 *  actually switched it on. That the DEFAULT is off is asserted separately below. */
const OWNER = {
  email: 'owner@example.com',
  connected_accounts: [
    {
      platform: 'meta',
      account_id: 'acct1',
      config: { account_type: 'ad_account', access_token: 'tok', crmConversionRelayEnabled: true },
    },
  ],
};

function makeDeps(overrides: Partial<RelayDeps> = {}): RelayDeps {
  return {
    getUserById: jest.fn().mockResolvedValue(OWNER),
    resolvePixel: jest.fn().mockResolvedValue({ pixelId: 'px1', accountId: 'acct1' }),
    getCredentials: jest
      .fn()
      .mockResolvedValue({ accountId: 'acct1', accessToken: 'tok', accountName: 'Acct', currency: 'USD' }),
    sendEvent: jest.fn().mockResolvedValue({ success: true, fbtraceId: 'trace1' }),
    recordSent: jest.fn().mockResolvedValue(undefined),
    clearPending: jest.fn().mockResolvedValue(undefined),
    shouldAttemptSend: jest.fn().mockReturnValue(true),
    isAccountPaused: jest.fn().mockReturnValue(false),
    ...overrides,
  };
}

function makeLead(overrides: Record<string, any> = {}) {
  return {
    leadId: 'lead-1',
    listId: 'list-1',
    email: 'buyer@example.com',
    firstName: 'Jane',
    lastName: 'Doe',
    status: 'won',
    dealValue: 5000,
    dealCurrency: 'USD',
    ...overrides,
  };
}

const ctx = (overrides: Record<string, any> = {}) => ({
  listId: 'list-1',
  userId: 'user-1',
  lead: makeLead(),
  previousStatus: 'new',
  statusConfig: LEAD_STATUS_CONFIG,
  ...overrides,
});

describe('mapStatusToMetaEvent', () => {
  it('maps a won-type status to Purchase as a value event', () => {
    expect(mapStatusToMetaEvent(LEAD_STATUS_CONFIG, 'won')).toEqual({
      conversionKind: 'won',
      isValueEvent: true,
    });
  });

  it('maps qualified to the custom QualifiedLead event, not a standard Meta event', () => {
    // Deliberately custom: Meta has no standard event that honestly means MQL, and
    // reusing SubmitApplication would pollute a name Meta's models hold priors on.
    expect(mapStatusToMetaEvent(LEAD_STATUS_CONFIG, 'qualified')).toEqual({
      conversionKind: 'qualified',
      isValueEvent: false,
    });
  });

  it('maps a RENAMED status whose type is won — customers rename statuses', () => {
    const renamed = [
      { value: 'deal_closed', label: 'Deal Closed!', color: 'green', type: 'won' as const },
    ];
    expect(mapStatusToMetaEvent(renamed, 'deal_closed')).toEqual({
      conversionKind: 'won',
      isValueEvent: true,
    });
  });

  it('returns null for statuses that are not a conversion (new, contacted, lost, churned)', () => {
    expect(mapStatusToMetaEvent(LEAD_STATUS_CONFIG, 'new')).toBeNull();
    expect(mapStatusToMetaEvent(LEAD_STATUS_CONFIG, 'lost')).toBeNull();
  });

  it('falls back to the platform default status config when a list has none', () => {
    expect(mapStatusToMetaEvent(undefined, 'won')).toEqual({
      conversionKind: 'won',
      isValueEvent: true,
    });
  });

  it('returns null for an unknown status rather than guessing', () => {
    expect(mapStatusToMetaEvent(LEAD_STATUS_CONFIG, 'not_a_real_status')).toBeNull();
  });
});

describe('buildRelayEventId', () => {
  it('is deterministic for the same lead and event', () => {
    expect(buildRelayEventId('lead-1', 'Purchase')).toBe(buildRelayEventId('lead-1', 'Purchase'));
  });

  it('differs across leads and across events', () => {
    expect(buildRelayEventId('lead-1', 'Purchase')).not.toBe(buildRelayEventId('lead-2', 'Purchase'));
    expect(buildRelayEventId('lead-1', 'won')).not.toBe(buildRelayEventId('lead-1', 'qualified'));
  });

  it('carries NO timestamp — a timestamped id would defeat Meta-side dedup on a retry', () => {
    const first = buildRelayEventId('lead-1', 'Purchase');
    const second = buildRelayEventId('lead-1', 'Purchase');
    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('buildFbcFromFirstTouch', () => {
  // fbc arrives as a browser cookie at capture time and is never persisted, so weeks later
  // when the deal closes the only surviving click signal is the stored fbclid. Meta's fbc
  // is a documented deterministic encoding of it, so it can be rebuilt rather than lost.
  it('rebuilds fbc from a stored fbclid using the touch timestamp', () => {
    expect(
      buildFbcFromFirstTouch({
        timestamp: '2026-08-01T00:00:00.000Z',
        clickIds: { fbclid: 'abc123' },
      }),
    ).toBe(`fb.1.${Date.parse('2026-08-01T00:00:00.000Z')}.abc123`);
  });

  it('returns undefined with no fbclid — an organic lead has no click to invent', () => {
    expect(buildFbcFromFirstTouch({ timestamp: '2026-08-01T00:00:00.000Z' })).toBeUndefined();
    expect(buildFbcFromFirstTouch({ clickIds: { gclid: 'g1' } })).toBeUndefined();
    expect(buildFbcFromFirstTouch(undefined)).toBeUndefined();
  });

  it('falls back to now when the stored timestamp is unparseable, rather than emitting NaN', () => {
    const fbc = buildFbcFromFirstTouch({ timestamp: 'not-a-date', clickIds: { fbclid: 'abc123' } });
    expect(fbc).toMatch(/^fb\.1\.\d+\.abc123$/);
    expect(fbc).not.toContain('NaN');
  });
});


describe('isConversionRelayEnabled — off unless someone said yes', () => {
  const optedIn = (flag: any) => ({
    connected_accounts: [
      { platform: 'meta', account_id: 'a', config: { account_type: 'ad_account', crmConversionRelayEnabled: flag } },
    ],
  });

  afterEach(() => {
    delete process.env.META_CONVERSION_RELAY_ENABLED;
  });

  it('is OFF for an account that has never been asked', () => {
    // The whole point: merging this must not start sending a single customer's deal values
    // to Meta without them opting in.
    expect(isConversionRelayEnabled({ connected_accounts: [] })).toBe(false);
    expect(isConversionRelayEnabled(optedIn(undefined))).toBe(false);
    expect(isConversionRelayEnabled(undefined)).toBe(false);
  });

  it('is OFF for a truthy-but-not-true value rather than coercing', () => {
    expect(isConversionRelayEnabled(optedIn('yes'))).toBe(false);
    expect(isConversionRelayEnabled(optedIn(1))).toBe(false);
  });

  it('is ON for an explicit per-account opt-in', () => {
    expect(isConversionRelayEnabled(optedIn(true))).toBe(true);
  });

  it('is ON under the environment override, for test environments', () => {
    process.env.META_CONVERSION_RELAY_ENABLED = 'true';
    expect(isConversionRelayEnabled({ connected_accounts: [] })).toBe(true);
  });

  it('ignores the opt-in on a non-ad-account connection', () => {
    expect(
      isConversionRelayEnabled({
        connected_accounts: [
          { platform: 'meta', config: { account_type: 'page', crmConversionRelayEnabled: true } },
        ],
      }),
    ).toBe(false);
  });
});

describe('buildConversionValue — never guess a denomination', () => {
  it('sends value + currency when the lead states its currency', () => {
    expect(buildConversionValue({ dealValue: 5000, dealCurrency: 'usd' })).toEqual({
      value: 5000,
      currency: 'USD',
    });
  });

  it('sends NO value when the currency is missing — a wrong denomination is worse than none', () => {
    // A 5,000 USD deal reported against an INR ad account is ~80x off, and Meta accepts it
    // silently. Omitting the value keeps the conversion useful and keeps the number honest.
    expect(buildConversionValue({ dealValue: 5000 })).toBeUndefined();
    expect(buildConversionValue({ dealValue: 5000, dealCurrency: '' })).toBeUndefined();
  });

  it('rejects a malformed currency rather than passing it through', () => {
    expect(buildConversionValue({ dealValue: 5000, dealCurrency: 'dollars' })).toBeUndefined();
    expect(buildConversionValue({ dealValue: 5000, dealCurrency: 'US' })).toBeUndefined();
  });

  it('sends nothing when there is no value at all', () => {
    expect(buildConversionValue({ dealCurrency: 'USD' })).toBeUndefined();
    expect(buildConversionValue({ dealValue: Number.NaN, dealCurrency: 'USD' })).toBeUndefined();
  });

  it('keeps a genuine zero — 0 is an amount, not an absence', () => {
    expect(buildConversionValue({ dealValue: 0, dealCurrency: 'USD' })).toEqual({
      value: 0,
      currency: 'USD',
    });
  });
});


describe('resolveEventName — Purchase only when we can state the value', () => {
  it('is Purchase for a won deal with a stated value', () => {
    expect(resolveEventName('won', true)).toBe('Purchase');
  });

  it('is a custom event for a won deal with no stateable value', () => {
    // Not a cosmetic choice: Meta rejects a currency-less Purchase, so this is the
    // difference between recording the conversion and losing it.
    expect(resolveEventName('won', false)).toBe('CRMWonDeal');
  });

  it('is QualifiedLead regardless of value', () => {
    expect(resolveEventName('qualified', false)).toBe('QualifiedLead');
    expect(resolveEventName('qualified', true)).toBe('QualifiedLead');
  });
});

describe('fire-once is keyed on the conversion, not the event name', () => {
  it('does not re-fire a won deal as Purchase after it went out as CRMWonDeal', async () => {
    // Otherwise filling in a currency later would double-count one deal under two names.
    const deps = makeDeps();
    const result = await relayLeadStatusEvent(
      ctx({ lead: makeLead({ metaConversionsSent: ['won'], dealCurrency: 'USD' }) }),
      deps,
    );

    expect(result).toMatchObject({ skipped: true });
    expect(deps.sendEvent).not.toHaveBeenCalled();
  });
});

describe('relayLeadStatusEvent — sending', () => {
  it('reconstructs fbc from the lead first touch and sends the landing URL', async () => {
    const deps = makeDeps();
    await relayLeadStatusEvent(
      ctx({
        lead: makeLead({
          firstTouch: {
            timestamp: '2026-08-01T00:00:00.000Z',
            clickIds: { fbclid: 'abc123' },
            landingUrl: 'https://example.com/lp?utm_source=facebook',
          },
        }),
      }),
      deps,
    );

    const event = (deps.sendEvent as jest.Mock).mock.calls[0][2];
    expect(event.fbc).toBe(`fb.1.${Date.parse('2026-08-01T00:00:00.000Z')}.abc123`);
    expect(event.sourceUrl).toBe('https://example.com/lp?utm_source=facebook');
  });

  it('sends the persisted fbp so a conversion weeks later still matches', async () => {
    const deps = makeDeps();
    await relayLeadStatusEvent(ctx({ lead: makeLead({ metaFbp: 'fb.1.1754000000000.987654321' }) }), deps);

    const event = (deps.sendEvent as jest.Mock).mock.calls[0][2];
    expect(event.fbp).toBe('fb.1.1754000000000.987654321');
  });

  it('omits fbp entirely for a lead captured before it was persisted', async () => {
    const deps = makeDeps();
    await relayLeadStatusEvent(ctx(), deps);

    const event = (deps.sendEvent as jest.Mock).mock.calls[0][2];
    expect(event.fbp).toBeUndefined();
  });

  it('declares action_source as system_generated, not website', async () => {
    // A CRM status change is not a browser event. Meta validates this field — a bogus value
    // is rejected outright — so claiming 'website' is a factual misstatement about where
    // the conversion happened, not a harmless default.
    const deps = makeDeps();
    await relayLeadStatusEvent(ctx(), deps);

    const event = (deps.sendEvent as jest.Mock).mock.calls[0][2];
    expect(event.actionSource).toBe('system_generated');
  });

  it('sends a CUSTOM event, not Purchase, when the value cannot be stated', async () => {
    // Meta rejects a Purchase with no currency outright ("Missing Currency for Purchase
    // Event", verified against Graph v25), so omitting the value while keeping the name
    // would lose the conversion entirely rather than merely lose its amount.
    const deps = makeDeps();
    const result = await relayLeadStatusEvent(
      ctx({ lead: makeLead({ dealValue: 5000, dealCurrency: undefined }) }),
      deps,
    );

    expect(result).toMatchObject({ sent: true, eventName: 'CRMWonDeal' });
    const event = (deps.sendEvent as jest.Mock).mock.calls[0][2];
    expect(event.customData).toBeUndefined();
  });

  it('sends Purchase with value and currency from the lead record', async () => {
    const deps = makeDeps();
    const result = await relayLeadStatusEvent(ctx(), deps);

    expect(result).toMatchObject({ sent: true, eventName: 'Purchase' });
    const [pixelId, accessToken, event] = (deps.sendEvent as jest.Mock).mock.calls[0];
    expect(pixelId).toBe('px1');
    expect(accessToken).toBe('tok');
    expect(event.eventName).toBe('Purchase');
    expect(event.customData).toEqual({ value: 5000, currency: 'USD' });
  });

  it('uses the deal currency verbatim, never the ad account currency', async () => {
    const deps = makeDeps({
      getCredentials: jest
        .fn()
        .mockResolvedValue({ accountId: 'acct1', accessToken: 'tok', accountName: 'Acct', currency: 'INR' }),
    });
    await relayLeadStatusEvent(ctx({ lead: makeLead({ dealCurrency: 'EUR' }) }), deps);

    const event = (deps.sendEvent as jest.Mock).mock.calls[0][2];
    expect(event.customData.currency).toBe('EUR');
  });

  it('skips entirely when the account has not opted in', async () => {
    const deps = makeDeps({
      getUserById: jest.fn().mockResolvedValue({ email: 'x@y.com', connected_accounts: [] }),
    });

    const result = await relayLeadStatusEvent(ctx(), deps);
    expect(result).toMatchObject({ skipped: true });
    expect(deps.sendEvent).not.toHaveBeenCalled();
    expect(deps.resolvePixel).not.toHaveBeenCalled();
  });

  it('sends QualifiedLead with no custom_data at all', async () => {
    const deps = makeDeps();
    const result = await relayLeadStatusEvent(
      ctx({ lead: makeLead({ status: 'qualified' }) }),
      deps,
    );

    expect(result).toMatchObject({ sent: true, eventName: 'QualifiedLead' });
    const event = (deps.sendEvent as jest.Mock).mock.calls[0][2];
    expect(event.customData).toBeUndefined();
  });

  it('sends even when the lead carries no fbc/fbp — email alone still matches', async () => {
    const deps = makeDeps();
    const result = await relayLeadStatusEvent(ctx(), deps);
    expect(result).toMatchObject({ sent: true });
  });

  it('records the event on the lead so it can never fire twice', async () => {
    const deps = makeDeps();
    await relayLeadStatusEvent(ctx(), deps);
    expect(deps.recordSent).toHaveBeenCalledWith('list-1', 'lead-1', 'won');
  });
});

describe('relayLeadStatusEvent — fire-once', () => {
  it('does not re-send when the event is already in metaConversionsSent', async () => {
    const deps = makeDeps();
    const result = await relayLeadStatusEvent(
      ctx({ lead: makeLead({ metaConversionsSent: ['won'] }) }),
      deps,
    );

    expect(result).toMatchObject({ skipped: true });
    expect(deps.sendEvent).not.toHaveBeenCalled();
  });

  it('won → lost → won fires Purchase exactly once', async () => {
    const deps = makeDeps();
    const sent: string[] = [];
    // recordSent takes ONE event name (the atomic append), not the whole array — spreading
    // a string here previously pushed individual characters and quietly broke the fixture.
    (deps.recordSent as jest.Mock).mockImplementation(async (_l, _i, name: string) => {
      sent.push(name);
    });

    await relayLeadStatusEvent(ctx({ lead: makeLead(), previousStatus: 'new' }), deps);
    await relayLeadStatusEvent(
      ctx({ lead: makeLead({ status: 'lost', metaConversionsSent: [...sent] }), previousStatus: 'won' }),
      deps,
    );
    await relayLeadStatusEvent(
      ctx({ lead: makeLead({ status: 'won', metaConversionsSent: [...sent] }), previousStatus: 'lost' }),
      deps,
    );

    const purchases = (deps.sendEvent as jest.Mock).mock.calls.filter(
      (c) => c[2].eventName === 'Purchase',
    );
    expect(purchases).toHaveLength(1);
  });

  it('allows QualifiedLead and Purchase on the same lead — different events, both real', async () => {
    const deps = makeDeps();
    const result = await relayLeadStatusEvent(
      ctx({ lead: makeLead({ status: 'won', metaConversionsSent: ['qualified'] }) }),
      deps,
    );
    expect(result).toMatchObject({ sent: true, eventName: 'Purchase' });
  });
});

describe('relayLeadStatusEvent — skips (expected, never errors)', () => {
  it('skips a lead who opted out (contactStatus unsubscribed)', async () => {
    const deps = makeDeps();
    const result = await relayLeadStatusEvent(
      ctx({ lead: makeLead({ contactStatus: 'unsubscribed' }) }),
      deps,
    );

    expect(result).toMatchObject({ skipped: true });
    expect(deps.sendEvent).not.toHaveBeenCalled();
  });

  it('skips a do-not-contact lead', async () => {
    const deps = makeDeps();
    const result = await relayLeadStatusEvent(
      ctx({ lead: makeLead({ contactStatus: 'do-not-contact' }) }),
      deps,
    );

    expect(result).toMatchObject({ skipped: true });
    expect(deps.sendEvent).not.toHaveBeenCalled();
  });

  it('skips when the status change is not a conversion transition', async () => {
    const deps = makeDeps();
    const result = await relayLeadStatusEvent(
      ctx({ lead: makeLead({ status: 'contacted' }), previousStatus: 'new' }),
      deps,
    );

    expect(result).toMatchObject({ skipped: true });
    expect(deps.sendEvent).not.toHaveBeenCalled();
  });

  it('marks a TRANSIENT resolution failure retryable — a Graph 5xx must not drop the conversion', async () => {
    // resolveMetaPixelWithDefault never throws, so a credential-refresh or Graph failure
    // arrives looking identical to "this account has no pixel". Treating both as terminal
    // is how the conversion this whole card exists to protect gets dropped anyway.
    const deps = makeDeps({
      resolvePixel: jest
        .fn()
        .mockResolvedValue({ unresolved: true, reason: 'Graph API error 500', transient: true }),
    });

    const result = await relayLeadStatusEvent(ctx(), deps);
    expect(result).toMatchObject({ skipped: true, retryable: true });
  });

  it('marks a STRUCTURAL resolution failure terminal — five retries cannot conjure a pixel', async () => {
    const deps = makeDeps({
      resolvePixel: jest
        .fn()
        .mockResolvedValue({ unresolved: true, reason: 'No Meta ad account connected', transient: false }),
    });

    const result = await relayLeadStatusEvent(ctx(), deps);
    expect(result).toMatchObject({ skipped: true, retryable: false });
  });

  it('treats an unresolved result with no transient flag as terminal, not retryable', async () => {
    const deps = makeDeps({
      resolvePixel: jest.fn().mockResolvedValue({ unresolved: true, reason: 'legacy caller' }),
    });

    const result = await relayLeadStatusEvent(ctx(), deps);
    expect(result).toMatchObject({ skipped: true, retryable: false });
  });

  it('skips when the pixel is unresolved — the lead write must still stand', async () => {
    const deps = makeDeps({
      resolvePixel: jest.fn().mockResolvedValue({ unresolved: true, reason: 'No Meta ad account connected' }),
    });

    const result = await relayLeadStatusEvent(ctx(), deps);
    expect(result).toMatchObject({ skipped: true });
    expect(deps.sendEvent).not.toHaveBeenCalled();
  });

  it('skips the automated smoke-test lead so real ad accounts are never polluted', async () => {
    const deps = makeDeps();
    const result = await relayLeadStatusEvent(
      ctx({ lead: makeLead({ email: 'smoke-test+1755200000000@agentweb.pro' }) }),
      deps,
    );

    expect(result).toMatchObject({ skipped: true });
    expect(deps.sendEvent).not.toHaveBeenCalled();
  });

  it('skips when the per-list send budget is exhausted', async () => {
    const deps = makeDeps({ shouldAttemptSend: jest.fn().mockReturnValue(false) });
    const result = await relayLeadStatusEvent(ctx(), deps);

    expect(result).toMatchObject({ skipped: true });
    expect(deps.sendEvent).not.toHaveBeenCalled();
  });

  it('skips when the ad account is paused by Meta-reported throttling', async () => {
    const deps = makeDeps({ isAccountPaused: jest.fn().mockReturnValue(true) });
    const result = await relayLeadStatusEvent(ctx(), deps);

    expect(result).toMatchObject({ skipped: true });
    expect(deps.sendEvent).not.toHaveBeenCalled();
  });

  it('skips when the owner no longer exists', async () => {
    const deps = makeDeps({ getUserById: jest.fn().mockResolvedValue(null) });
    const result = await relayLeadStatusEvent(ctx(), deps);

    expect(result).toMatchObject({ skipped: true });
    expect(deps.sendEvent).not.toHaveBeenCalled();
  });

  it('does NOT record a send when it skipped', async () => {
    const deps = makeDeps({ shouldAttemptSend: jest.fn().mockReturnValue(false) });
    await relayLeadStatusEvent(ctx(), deps);
    expect(deps.recordSent).not.toHaveBeenCalled();
  });
});

describe('relayLeadStatusEvent — a suppressed conversion is never silent', () => {
  // Found in live testing: the opt-out case produced no log line at all, which is
  // indistinguishable from the relay never having run. On a card that exists because a
  // tracking failure was "silent by construction", a silently-suppressed Purchase is the
  // same shape of bug.
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => logSpy.mockRestore());

  const skipLines = () =>
    logSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('skipped'));

  it('logs when an opted-out lead suppresses a real conversion', async () => {
    await relayLeadStatusEvent(ctx({ lead: makeLead({ contactStatus: 'unsubscribed' }) }), makeDeps());

    expect(skipLines()).toHaveLength(1);
    expect(skipLines()[0]).toContain('opted out');
    expect(skipLines()[0]).toContain('lead-1');
  });

  it('logs when a fire-once skip suppresses a real conversion', async () => {
    await relayLeadStatusEvent(
      ctx({ lead: makeLead({ metaConversionsSent: ['won'] }) }),
      makeDeps(),
    );

    expect(skipLines()[0]).toContain('already sent');
  });

  it('logs when the pixel is unresolved', async () => {
    const deps = makeDeps({
      resolvePixel: jest.fn().mockResolvedValue({ unresolved: true, reason: 'No Meta ad account connected' }),
    });
    await relayLeadStatusEvent(ctx(), deps);

    expect(skipLines()[0]).toContain('pixel unresolved');
  });

  it('stays QUIET for a status that was never a conversion — every lead moving new to contacted would be noise', async () => {
    await relayLeadStatusEvent(
      ctx({ lead: makeLead({ status: 'contacted' }), previousStatus: 'new' }),
      makeDeps(),
    );

    expect(skipLines()).toHaveLength(0);
  });
});

describe('relayLeadStatusEvent — a settled conversion releases its marker', () => {
  // Otherwise the marker outlives its own reason: reconciliation re-finds that lead every
  // sweep forever for a conversion that will never be sent.
  it('releases the marker when the lead has opted out', async () => {
    const deps = makeDeps();
    await relayLeadStatusEvent(ctx({ lead: makeLead({ contactStatus: 'unsubscribed' }) }), deps);

    expect(deps.clearPending).toHaveBeenCalledWith('list-1', 'lead-1', 'won');
  });

  it('releases the marker when the event already went', async () => {
    const deps = makeDeps();
    await relayLeadStatusEvent(ctx({ lead: makeLead({ metaConversionsSent: ['won'] }) }), deps);

    expect(deps.clearPending).toHaveBeenCalledWith('list-1', 'lead-1', 'won');
  });

  it('KEEPS the marker when the conversion is merely not-yet sendable', async () => {
    // Not enabled, no pixel, throttled: still genuinely owed, so the marker must survive.
    const deps = makeDeps({
      resolvePixel: jest.fn().mockResolvedValue({ unresolved: true, reason: 'No Meta ad account connected' }),
    });
    await relayLeadStatusEvent(ctx(), deps);

    expect(deps.clearPending).not.toHaveBeenCalled();
  });
});

describe('relayLeadStatusEvent — failures never break the lead write', () => {
  it('returns a failure (does not throw) when Meta rejects the event', async () => {
    const deps = makeDeps({
      sendEvent: jest.fn().mockResolvedValue({ success: false, error: 'Invalid parameter' }),
    });

    const result = await relayLeadStatusEvent(ctx(), deps);
    expect(result).toMatchObject({ failed: true });
  });

  it('does NOT record the event as sent when Meta rejected it — it must be retryable', async () => {
    const deps = makeDeps({
      sendEvent: jest.fn().mockResolvedValue({ success: false, error: 'Invalid parameter' }),
    });

    await relayLeadStatusEvent(ctx(), deps);
    expect(deps.recordSent).not.toHaveBeenCalled();
  });

  it('does not throw when credential resolution throws', async () => {
    const deps = makeDeps({
      getCredentials: jest.fn().mockRejectedValue(new Error('token expired and refresh failed')),
    });

    await expect(relayLeadStatusEvent(ctx(), deps)).resolves.toMatchObject({ failed: true });
  });

  it('does not throw when the owner lookup itself throws', async () => {
    const deps = makeDeps({ getUserById: jest.fn().mockRejectedValue(new Error('DynamoDB down')) });
    await expect(relayLeadStatusEvent(ctx(), deps)).resolves.toMatchObject({ failed: true });
  });

  it('does not throw when recording the send fails after a successful Meta send', async () => {
    const deps = makeDeps({ recordSent: jest.fn().mockRejectedValue(new Error('write failed')) });
    await expect(relayLeadStatusEvent(ctx(), deps)).resolves.toBeDefined();
  });
});
