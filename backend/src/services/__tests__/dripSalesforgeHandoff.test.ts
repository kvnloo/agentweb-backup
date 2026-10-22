import { decideSalesforgeHandoff, SalesforgeHandoffLead } from '../dripSalesforgeHandoff';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 19);
const config = { warmTags: ['Warm'], suppressionTags: ['DNE'] };
const base: SalesforgeHandoffLead = {
  email: 'lead@example.com',
  optedIn: true,
  tags: ['warm'],
  enrolledAtMs: NOW - DAY,
};
const decide = (lead: Partial<SalesforgeHandoffLead>, cfg: any = config) =>
  decideSalesforgeHandoff({ lead: { ...base, ...lead }, nowMs: NOW, config: cfg });

describe('decideSalesforgeHandoff', () => {
  it('eligible for warm opted-in lead inside the window', () => {
    expect(decide({})).toEqual({ eligible: true });
  });

  it('not_opted_in', () => {
    expect(decide({ optedIn: false })).toEqual({ eligible: false, reason: 'not_opted_in' });
    expect(decide({ optedIn: null })).toEqual({ eligible: false, reason: 'not_opted_in' });
  });

  it('invalid_email', () => {
    expect(decide({ email: 'nope' })).toEqual({ eligible: false, reason: 'invalid_email' });
    expect(decide({ email: null })).toEqual({ eligible: false, reason: 'invalid_email' });
  });

  it('not_warm, and empty warm config means nobody is warm', () => {
    expect(decide({ tags: ['cold'] })).toEqual({ eligible: false, reason: 'not_warm' });
    expect(decide({}, { warmTags: [] })).toEqual({ eligible: false, reason: 'not_warm' });
  });

  it('tag matching is case-insensitive and trimmed', () => {
    expect(decide({ tags: ['  WARM '] })).toEqual({ eligible: true });
    expect(decide({ tags: [' dne'] })).toEqual({ eligible: false, reason: 'suppressed' });
  });

  it('outside_window: too old, future, missing; default window is 3 days', () => {
    expect(decide({ enrolledAtMs: NOW - 3 * DAY })).toEqual({ eligible: true });
    expect(decide({ enrolledAtMs: NOW - 3 * DAY - 1 })).toEqual({ eligible: false, reason: 'outside_window' });
    expect(decide({ enrolledAtMs: NOW + 1 })).toEqual({ eligible: false, reason: 'outside_window' });
    expect(decide({ enrolledAtMs: null })).toEqual({ eligible: false, reason: 'outside_window' });
    expect(decide({ enrolledAtMs: NOW - 5 * DAY }, { ...config, windowDays: 7 })).toEqual({ eligible: true });
  });

  it('suppressed for unsubscribe/bounce/complaint/tag', () => {
    for (const s of [{ unsubscribed: true }, { bounced: true }, { complained: true }, { tags: ['warm', 'DNE'] }]) {
      expect(decide(s)).toEqual({ eligible: false, reason: 'suppressed' });
    }
  });

  it('suppression beats every other reason', () => {
    expect(
      decide({ bounced: true, salesforgePushedAt: 'x', optedIn: false, email: 'bad', tags: [], enrolledAtMs: null }),
    ).toEqual({ eligible: false, reason: 'suppressed' });
  });

  it('already_pushed precedes remaining reasons', () => {
    expect(decide({ salesforgePushedAt: NOW })).toEqual({ eligible: false, reason: 'already_pushed' });
    expect(decide({ salesforgePushedAt: '2026-10-18', optedIn: false, email: 'bad' })).toEqual({
      eligible: false,
      reason: 'already_pushed',
    });
  });
});
