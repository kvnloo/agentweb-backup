import type { HotLeadCallMember, HotLeadCallWindow } from '../../services/hotLeadCallConfig';
import type { HotLeadCallRecord } from '../../services/voice/leadCallStore.types';

/** Available whenever the org's calling hours are open, so a one-member team behaves like one fixed phone. */
export const EVERY_DAY: HotLeadCallWindow = { days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '24:00' };
export const VERIFIED_AT = '2026-01-01T00:00:00.000Z';
export const MEMBER_ID = 'maaaaaaa';

export function teamMember(phone: string, over: Partial<HotLeadCallMember> = {}): HotLeadCallMember {
  return { id: MEMBER_ID, name: 'Dana Lee', phone, verifiedAt: VERIFIED_AT, windows: [EVERY_DAY], ...over };
}

/** A complete call record for tests that seed one by hand; override what the case is about. */
export function callRecord(over: Partial<HotLeadCallRecord> = {}): HotLeadCallRecord {
  const at = '2026-10-19T10:00:00.000Z';
  return {
    state: 'dialing', jobKey: 'job-1', startedAt: at, updatedAt: at,
    attemptNo: 1, memberId: MEMBER_ID, triedMemberIds: [MEMBER_ID], leadPhoneMac: 'mac-for-tests',
    ...over,
  };
}

/** The five people of the reference scenarios (a-e), with fake numbers and ids. */
export const REFERENCE_PHONE = { a: '+14155550101', b: '+14155550102', c: '+14155550103', d: '+14155550104', e: '+14155550105' } as const;
export const REFERENCE_ID = { a: 'maaaaaaa', b: 'mbbbbbbb', c: 'mccccccc', d: 'mddddddd', e: 'meeeeeee' } as const;
type ReferenceKey = keyof typeof REFERENCE_ID;

/** A verified person on duty every day between `start` and `end`. */
export const referenceMember = (key: ReferenceKey, start: string, end: string): HotLeadCallMember => ({
  id: REFERENCE_ID[key], name: `Member ${key.toUpperCase()}`, phone: REFERENCE_PHONE[key], verifiedAt: VERIFIED_AT, windows: [{ ...EVERY_DAY, start, end }],
});

/** Priority order a, b, c, d: A 09:00-12:00, B 12:15-15:00, C 15:00-18:00, D 14:00-19:00. */
export const referenceTeam = (): HotLeadCallMember[] => [
  referenceMember('a', '09:00', '12:00'), referenceMember('b', '12:15', '15:00'), referenceMember('c', '15:00', '18:00'), referenceMember('d', '14:00', '19:00'),
];

/** Lets work started without being awaited (a queued job, a next-attempt request) run to its end. Needs fake timers that leave setImmediate real. */
export const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  await jest.advanceTimersByTimeAsync(0);
};

export const STORED_NUMBER_SID = 'PN' + 'b'.repeat(32);

/**
 * A complete stored `hotLeadCall` org attribute: enabled, a caller number, calling hours 08:00-21:00 in Chicago and
 * every limit at its default. `extra` overrides any field; `team` replaces the one verified person.
 */
export function storedConfigFixture(extra: Record<string, unknown> = {}, team: HotLeadCallMember[] = [teamMember('+14155550100')]) {
  return {
    enabled: true, team,
    twilioNumber: '+14155550111', twilioNumberSid: STORED_NUMBER_SID, leadTypes: ['form_fill'], maxAgeMinutes: 10, maxCallsPerHour: 6,
    maxCallsPerDay: 20, maxCallsPerMonth: 200, memberCooldownMinutes: 2, maxAttemptsPerLead: 3, announcedName: 'Acme Plumbing',
    callingHours: { start: '08:00', end: '21:00', timezone: 'America/Chicago' }, allowedCountries: ['US', 'CA'], ...extra,
  };
}

/** ENG-2783: the call-consent record a form lead carries once the visitor ticked the notice (the gate `no_call_consent` needs it).
 *  FakeCrm.addLead adds it to every lead by default; pass `{ consent: false }` for a lead that has none. */
export const callConsentRecord = (over: Record<string, unknown> = {}) => ({
  granted: true,
  phoneDigits: '12125550142', // the default test lead's number; FakeCrm.addLead sets the lead's own
  text: 'By checking this box and submitting, I agree that Acme Plumbing LLC may call me at the number above, including automated calls.',
  version: 'v1', capturedAt: '2026-10-19T10:00:00.000Z', pageUrl: 'https://acme.example/quote', ip: '203.0.113.9', userAgent: 'jest', source: 'form' as const, ...over,
});
