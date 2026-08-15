/**
 * ENG-926 §C follow-up — per-account Meta event-name override.
 *
 * §C hardcodes `Purchase` for a closed-won. A customer whose store pixel ALREADY uses
 * `Purchase` for e-commerce orders gets CRM deals blended into the same event their
 * campaign optimisation reads, and there is no way to separate them afterwards. The relay
 * is opt-in, so that is a consented outcome rather than an imposed one — but consenting to
 * it should not be the only option.
 *
 * ─── Why this is safe against double-counting, verified rather than assumed ──────────
 *
 * Renaming an event does NOT change dedup identity. Two independent reasons:
 *   - `metaConversionsSent` records the conversion KIND ('won'/'qualified'), never the
 *     emitted name, and the fire-once check reads that field.
 *   - `buildRelayEventId` is called with `mapped.conversionKind`, so the deterministic
 *     event_id is derived from the kind too.
 * So a lead that fired `Purchase` cannot fire again as `CRMPurchase` after a rename.
 *
 * ─── The one hard constraint Meta imposes ───────────────────────────────────────────
 *
 * `Purchase` REQUIRES value AND currency — §C established this by live probe, not docs
 * (error_subcode 2804010, "Missing Currency for Purchase Event"). The no-value and
 * qualified slots are used precisely when no value can be stated, so naming either of
 * them `Purchase` guarantees every such event is rejected by Meta. That is refused at the
 * point of configuration rather than discovered later in a log nobody reads.
 */

import {
  resolveEventName,
  validateEventNameOverrides,
  META_PURCHASE_EVENT,
  META_QUALIFIED_EVENT,
  META_WON_NO_VALUE_EVENT,
} from '../services/metaConversionRelay';

describe('resolveEventName — with no override (unchanged §C behaviour)', () => {
  it('sends Purchase for a won deal whose value can be stated', () => {
    expect(resolveEventName('won', true)).toBe(META_PURCHASE_EVENT);
  });

  it('sends the custom won event when value cannot be stated', () => {
    expect(resolveEventName('won', false)).toBe(META_WON_NO_VALUE_EVENT);
  });

  it('sends QualifiedLead for a qualified lead', () => {
    expect(resolveEventName('qualified', false)).toBe(META_QUALIFIED_EVENT);
  });

  it('is unchanged by an empty or absent override object', () => {
    expect(resolveEventName('won', true, undefined)).toBe(META_PURCHASE_EVENT);
    expect(resolveEventName('won', true, {})).toBe(META_PURCHASE_EVENT);
    expect(resolveEventName('won', true, null)).toBe(META_PURCHASE_EVENT);
  });
});

describe('resolveEventName — with an override', () => {
  it('renames the valued won event', () => {
    expect(resolveEventName('won', true, { won: 'CRMPurchase' })).toBe('CRMPurchase');
  });

  it('renames the no-value won event', () => {
    expect(resolveEventName('won', false, { wonNoValue: 'CRMClosedWon' })).toBe('CRMClosedWon');
  });

  it('renames the qualified event', () => {
    expect(resolveEventName('qualified', false, { qualified: 'CRMQualified' })).toBe('CRMQualified');
  });

  it('keeps the two won slots independent', () => {
    // Overriding the valued event must not silently rename the valueless one: they are
    // different events to Meta, and one of them may not carry a value at all.
    const overrides = { won: 'CRMPurchase' };
    expect(resolveEventName('won', true, overrides)).toBe('CRMPurchase');
    expect(resolveEventName('won', false, overrides)).toBe(META_WON_NO_VALUE_EVENT);
  });

  it('ignores a blank or whitespace-only override', () => {
    expect(resolveEventName('won', true, { won: '' })).toBe(META_PURCHASE_EVENT);
    expect(resolveEventName('won', true, { won: '   ' })).toBe(META_PURCHASE_EVENT);
  });

  it('ignores a non-string override rather than sending it to Meta', () => {
    expect(resolveEventName('won', true, { won: 42 } as any)).toBe(META_PURCHASE_EVENT);
    expect(resolveEventName('qualified', false, { qualified: {} } as any)).toBe(META_QUALIFIED_EVENT);
  });

  it('trims surrounding whitespace rather than sending a padded name', () => {
    expect(resolveEventName('won', true, { won: '  CRMPurchase  ' })).toBe('CRMPurchase');
  });
});

describe('validateEventNameOverrides', () => {
  const ok = (o: any) => validateEventNameOverrides(o);

  it('accepts an absent or empty configuration', () => {
    expect(ok(undefined).valid).toBe(true);
    expect(ok(null).valid).toBe(true);
    expect(ok({}).valid).toBe(true);
  });

  it('accepts ordinary custom event names', () => {
    expect(ok({ won: 'CRMPurchase', wonNoValue: 'CRMClosedWon', qualified: 'CRM_MQL' }).valid).toBe(true);
  });

  it('rejects a name with characters Meta does not accept', () => {
    for (const bad of ['CRM Purchase', 'CRM-Purchase', 'CRM.Purchase', 'CRM/Purchase', 'émoji🎉']) {
      expect(ok({ won: bad }).valid).toBe(false);
    }
  });

  it('rejects an over-long name', () => {
    expect(ok({ won: 'a'.repeat(51) }).valid).toBe(false);
    expect(ok({ won: 'a'.repeat(50) }).valid).toBe(true);
  });

  it('rejects an unknown slot rather than silently ignoring it', () => {
    // A typo'd key would otherwise be stored, do nothing, and read as configured.
    expect(ok({ wonn: 'CRMPurchase' }).valid).toBe(false);
  });

  it('rejects Purchase for the slots that carry no value', () => {
    // Meta rejects a Purchase with no currency (error_subcode 2804010, verified live in
    // §C). Both of these slots are used precisely when no value can be stated, so this
    // configuration would drop every one of those conversions.
    expect(ok({ wonNoValue: 'Purchase' }).valid).toBe(false);
    expect(ok({ qualified: 'Purchase' }).valid).toBe(false);

    const result = ok({ wonNoValue: 'Purchase' });
    // Narrowed rather than cast: the message is part of the contract, since it is what
    // tells whoever hit this why the configuration is impossible rather than merely
    // disallowed.
    if (result.valid) throw new Error('expected Purchase in a valueless slot to be rejected');
    expect(result.error).toMatch(/currency/i);
  });

  it('allows Purchase for the slot that does carry a value', () => {
    expect(ok({ won: 'Purchase' }).valid).toBe(true);
  });

  it('rejects a non-object configuration', () => {
    expect(ok('CRMPurchase').valid).toBe(false);
    expect(ok(['CRMPurchase']).valid).toBe(false);
  });

  it('accepts null for a slot, meaning "use the default"', () => {
    expect(ok({ won: null }).valid).toBe(true);
  });
});

// ── Wiring ───────────────────────────────────────────────────────────────────────────
//
// resolveEventName being correct proves nothing about the override REACHING it. §C
// shipped `metaFbp` threaded everywhere except the one function that assembles the record,
// so it did nothing at all while every unit test passed. These cover the path end to end.

import { relayLeadStatusEvent, RelayDeps } from '../services/metaConversionRelay';

const ownerWith = (accounts: any[]) => ({ email: 'owner@example.com', connected_accounts: accounts });

const adAccount = (accountId: string, eventNames?: any) => ({
  platform: 'meta',
  account_id: accountId,
  config: {
    account_type: 'ad_account',
    access_token: 'tok',
    crmConversionRelayEnabled: true,
    ...(eventNames ? { crmConversionEventNames: eventNames } : {}),
  },
});

const wonLead = () => ({
  leadId: 'lead-1',
  listId: 'list-1',
  email: 'buyer@example.com',
  status: 'won',
  dealValue: 5000,
  dealCurrency: 'USD',
});

const STATUSES = [
  { value: 'won', label: 'Won', color: 'green', type: 'won' as const },
  { value: 'qualified', label: 'Qualified', color: 'indigo', type: 'active' as const },
];

function depsFor(owner: any, resolvedAccountId = 'acct1'): RelayDeps {
  return {
    getUserById: jest.fn().mockResolvedValue(owner),
    resolvePixel: jest.fn().mockResolvedValue({ pixelId: 'px1', accountId: resolvedAccountId }),
    getCredentials: jest.fn().mockResolvedValue({
      accountId: resolvedAccountId,
      accessToken: 'tok',
      accountName: 'Acct',
      currency: 'USD',
    }),
    sendEvent: jest.fn().mockResolvedValue({ success: true, fbtraceId: 't' }),
    recordSent: jest.fn().mockResolvedValue(undefined),
    clearPending: jest.fn().mockResolvedValue(undefined),
    shouldAttemptSend: jest.fn().mockReturnValue(true),
    isAccountPaused: jest.fn().mockReturnValue(false),
  } as RelayDeps;
}

const relay = (deps: RelayDeps, lead: any = wonLead()) =>
  relayLeadStatusEvent(
    { listId: 'list-1', userId: 'u1', lead, statusConfig: STATUSES },
    deps,
  );

describe('relayLeadStatusEvent — the override actually reaches the wire', () => {
  it('sends the default event name when nothing is configured', async () => {
    const deps = depsFor(ownerWith([adAccount('acct1')]));
    await relay(deps);
    expect((deps.sendEvent as jest.Mock).mock.calls[0][2].eventName).toBe(META_PURCHASE_EVENT);
  });

  it('sends the configured name for a valued closed-won', async () => {
    const deps = depsFor(ownerWith([adAccount('acct1', { won: 'CRMPurchase' })]));
    await relay(deps);
    expect((deps.sendEvent as jest.Mock).mock.calls[0][2].eventName).toBe('CRMPurchase');
  });

  it('reads names from the RESOLVED account, not the first connected one', async () => {
    // The production account this was built against has two ad accounts. A customer may
    // run a store pixel on one and CRM conversions on the other; applying the first
    // account's naming to the second's events is the multi-account defect of ENG-1141.
    const owner = ownerWith([
      adAccount('acct-store', { won: 'StorePurchase' }),
      adAccount('acct-crm', { won: 'CRMPurchase' }),
    ]);
    const deps = depsFor(owner, 'acct-crm');

    await relay(deps);

    expect((deps.sendEvent as jest.Mock).mock.calls[0][2].eventName).toBe('CRMPurchase');
  });

  it('falls back to the default when the resolved account has no override of its own', async () => {
    const owner = ownerWith([adAccount('acct-store', { won: 'StorePurchase' }), adAccount('acct-crm')]);
    const deps = depsFor(owner, 'acct-crm');

    await relay(deps);

    expect((deps.sendEvent as jest.Mock).mock.calls[0][2].eventName).toBe(META_PURCHASE_EVENT);
  });

  it('leaves the event_id untouched when the name changes — fire-once must not move', async () => {
    const plain = depsFor(ownerWith([adAccount('acct1')]));
    const renamed = depsFor(ownerWith([adAccount('acct1', { won: 'CRMPurchase' })]));

    await relay(plain);
    await relay(renamed);

    const idA = (plain.sendEvent as jest.Mock).mock.calls[0][2].eventId;
    const idB = (renamed.sendEvent as jest.Mock).mock.calls[0][2].eventId;
    expect(idB).toBe(idA);
  });

  it('records the conversion KIND, not the renamed event, so a rename cannot re-fire it', async () => {
    const deps = depsFor(ownerWith([adAccount('acct1', { won: 'CRMPurchase' })]));
    await relay(deps);
    expect(deps.recordSent).toHaveBeenCalledWith('list-1', 'lead-1', 'won');
  });

  it('uses the no-value slot when the deal value cannot be stated', async () => {
    const deps = depsFor(ownerWith([adAccount('acct1', { won: 'CRMPurchase', wonNoValue: 'CRMClosedWon' })]));
    await relay(deps, { ...wonLead(), dealValue: undefined, dealCurrency: undefined });
    expect((deps.sendEvent as jest.Mock).mock.calls[0][2].eventName).toBe('CRMClosedWon');
  });
});
