/**
 * ENG-926 AC2 — a booked call must appear in Meta as an ATTRIBUTED Schedule event.
 *
 * Emitting `Schedule` was already verified. Attribution was not, and the two are different
 * problems: Meta ties a conversion to an ad through `fbc` (the click id) or `fbp`, and the
 * event was going out carrying a hashed email and name only.
 *
 * §28 is the cautionary case. Every.io's server events reached Meta with only Meta's own
 * browser cookies as match keys — no fbc, no fbp — and $557 of spend produced zero
 * attributed conversions. AC2 would have failed the same way even with real ad traffic,
 * because the payload could not be matched, not because the traffic was missing.
 *
 * The booking itself cannot supply either signal: the invitee is on the booking tool's
 * domain, where our pixel never fires. What can supply them is the lead this person already
 * created on a landing page before booking.
 */

import { resolveBookingMatchIdentity } from '../routes/calendlyWebhook';
import { crmDb } from '../services/db';

jest.mock('../services/db', () => ({
  crmDb: { findLeadsByEmail: jest.fn() },
  userDb: { getUserById: jest.fn() },
}));
jest.mock('../services/connectedAccountsDb', () => ({
  getAccountsByCalendlyUserUri: jest.fn(), updateAccountConfig: jest.fn(),
}));
jest.mock('../services/metaService', () => ({ metaService: {} }));
jest.mock('../services/externalCrmSyncService', () => ({ externalCrmSyncService: {} }));
jest.mock('../services/leadListAlertService', () => ({ leadListAlertService: {} }));
jest.mock('../services/asyncJobQueue', () => ({
  enqueueJob: jest.fn(), markJobComplete: jest.fn(), markJobFailed: jest.fn(),
  registerProcessor: jest.fn(), startHeartbeat: jest.fn(),
}));

const OWNER = 'user_owner';
const FBCLID = 'IwAR_real_click_from_the_ad';

const lead = (over: Record<string, any> = {}) => ({
  leadId: 'lead_1',
  userId: OWNER,
  email: 'invitee@example.com',
  firstTouch: { timestamp: '2026-08-01T00:00:00.000Z', clickIds: { fbclid: FBCLID } },
  ...over,
});

describe('resolveBookingMatchIdentity (ENG-926 AC2)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('recovers fbc from the lead the invitee created before booking', async () => {
    (crmDb.findLeadsByEmail as jest.Mock).mockResolvedValue([lead()]);
    const got = await resolveBookingMatchIdentity('invitee@example.com', OWNER);
    // Meta's documented deterministic encoding: fb.1.<creation-ms>.<fbclid>
    expect(got.fbc).toMatch(new RegExp(`^fb\\.1\\.\\d+\\.${FBCLID}$`));
  });

  it('recovers the persisted fbp as well', async () => {
    (crmDb.findLeadsByEmail as jest.Mock).mockResolvedValue([
      lead({ metaFbp: 'fb.1.1754000000000.987654321' }),
    ]);
    const got = await resolveBookingMatchIdentity('invitee@example.com', OWNER);
    expect(got.fbp).toBe('fb.1.1754000000000.987654321');
    expect(got.fbc).toBeDefined();
  });

  it('NEVER returns another tenant\'s click id — findLeadsByEmail is a GLOBAL index', async () => {
    // The safety-critical case. That GSI has no userId filter, so an unfiltered read would
    // send a DIFFERENT customer's click id to THIS customer's pixel.
    (crmDb.findLeadsByEmail as jest.Mock).mockResolvedValue([
      lead({ userId: 'someone_else', firstTouch: { clickIds: { fbclid: 'OTHER_TENANT_CLICK' } } }),
    ]);
    expect(await resolveBookingMatchIdentity('invitee@example.com', OWNER)).toEqual({});
  });

  it('fails CLOSED on a lead with no userId rather than assuming ownership', async () => {
    // createLead derives userId from the parent list so it never desyncs, but older rows
    // may predate that. An unattributable lead is skipped, not trusted.
    (crmDb.findLeadsByEmail as jest.Mock).mockResolvedValue([lead({ userId: undefined })]);
    expect(await resolveBookingMatchIdentity('invitee@example.com', OWNER)).toEqual({});
  });

  it('picks this owner\'s lead out of a mixed cross-tenant result', async () => {
    (crmDb.findLeadsByEmail as jest.Mock).mockResolvedValue([
      lead({ userId: 'other_a', firstTouch: { clickIds: { fbclid: 'WRONG_A' } } }),
      lead({ userId: OWNER }),
      lead({ userId: 'other_b', firstTouch: { clickIds: { fbclid: 'WRONG_B' } } }),
    ]);
    const got = await resolveBookingMatchIdentity('invitee@example.com', OWNER);
    expect(got.fbc).toContain(FBCLID);
    expect(got.fbc).not.toContain('WRONG');
  });

  it('skips this owner\'s leads that carry no identity and keeps looking', async () => {
    (crmDb.findLeadsByEmail as jest.Mock).mockResolvedValue([
      lead({ firstTouch: { timestamp: '2026-08-02T00:00:00.000Z' } }), // organic, nothing to match on
      lead({ leadId: 'lead_2' }),
    ]);
    const got = await resolveBookingMatchIdentity('invitee@example.com', OWNER);
    expect(got.fbc).toContain(FBCLID);
  });

  it('returns nothing for an invitee with no matching lead — an organic booking', async () => {
    (crmDb.findLeadsByEmail as jest.Mock).mockResolvedValue([]);
    expect(await resolveBookingMatchIdentity('nobody@example.com', OWNER)).toEqual({});
  });

  it('returns nothing, and does not throw, when the lookup fails', async () => {
    // Best-effort by construction: the Schedule event must still send. Identity enrichment
    // can never cost us the conversion — the rule §F applies to alert enrichment.
    (crmDb.findLeadsByEmail as jest.Mock).mockRejectedValue(new Error('dynamo exploded'));
    await expect(resolveBookingMatchIdentity('invitee@example.com', OWNER)).resolves.toEqual({});
  });

  it('does not query at all without an email or a userId', async () => {
    expect(await resolveBookingMatchIdentity(undefined, OWNER)).toEqual({});
    expect(await resolveBookingMatchIdentity('invitee@example.com', undefined)).toEqual({});
    expect(crmDb.findLeadsByEmail).not.toHaveBeenCalled();
  });

  it('omits keys entirely rather than emitting undefined values', async () => {
    // sendCapiLeadEvent spreads this object; an explicit `fbc: undefined` would still be a
    // key, and metaService only guards on truthiness, so keep the shape clean.
    (crmDb.findLeadsByEmail as jest.Mock).mockResolvedValue([
      lead({ firstTouch: undefined, metaFbp: 'fb.1.1754000000000.111' }),
    ]);
    const got = await resolveBookingMatchIdentity('invitee@example.com', OWNER);
    expect(Object.keys(got)).toEqual(['fbp']);
  });
});
