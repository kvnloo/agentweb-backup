import { newsletterCadence, issueMonthOf } from '../dripNewsletterCadence';

const now = new Date('2026-10-15T12:00:00Z');
const joined = new Date('2026-09-01T00:00:00Z');

describe('newsletterCadence (ENG-2545)', () => {
  it('AC1: sends with UTC issue month', () => {
    expect(newsletterCadence({ joinedSegmentAt: joined, lastIssueMonth: '2026-09' }, now)).toEqual({
      action: 'send',
      issueMonth: '2026-10',
    });
  });

  it('AC2: skips when already sent this month', () => {
    expect(newsletterCadence({ joinedSegmentAt: joined, lastIssueMonth: '2026-10' }, now)).toEqual({
      action: 'skip',
      reason: 'already_sent_this_month',
    });
  });

  it.each(['unsubscribed', 'bounced', 'complained'] as const)('AC3: suppresses %s', (flag) => {
    expect(newsletterCadence({ joinedSegmentAt: joined, [flag]: true }, now)).toEqual({
      action: 'skip',
      reason: 'suppressed',
    });
  });

  it('AC3: suppression wins over before_send_day', () => {
    expect(newsletterCadence({ joinedSegmentAt: joined, bounced: true }, now, { sendDay: 20 }).action).toBe('skip');
    expect(newsletterCadence({ joinedSegmentAt: joined, bounced: true }, now, { sendDay: 20 })).toEqual({
      action: 'skip',
      reason: 'suppressed',
    });
  });

  it('AC4: before configured send day', () => {
    expect(newsletterCadence({ joinedSegmentAt: joined }, now, { sendDay: 16 })).toEqual({
      action: 'skip',
      reason: 'before_send_day',
    });
    expect(newsletterCadence({ joinedSegmentAt: joined }, now, { sendDay: 15 }).action).toBe('send');
  });

  it('AC5: joined too recently', () => {
    const recent = new Date('2026-10-10T12:00:00Z');
    expect(newsletterCadence({ joinedSegmentAt: recent }, now)).toEqual({ action: 'skip', reason: 'joined_after_issue' });
    expect(newsletterCadence({ joinedSegmentAt: recent }, now, { minDaysInSegment: 5 }).action).toBe('send');
  });

  it.each([0, 29, 1.5, NaN])('AC6: invalid sendDay %p fails closed', (sendDay) => {
    expect(newsletterCadence({ joinedSegmentAt: joined }, now, { sendDay })).toEqual({
      action: 'skip',
      reason: 'invalid_config',
    });
  });

  it('AC6: negative minDaysInSegment fails closed', () => {
    expect(newsletterCadence({ joinedSegmentAt: joined }, now, { minDaysInSegment: -1 })).toEqual({
      action: 'skip',
      reason: 'invalid_config',
    });
  });

  it('invalid join date fails closed', () => {
    expect(newsletterCadence({ joinedSegmentAt: new Date('nope') }, now).action).toBe('skip');
  });

  it('invalid now fails closed', () => {
    expect(newsletterCadence({ joinedSegmentAt: joined }, new Date(NaN))).toEqual({ action: 'skip', reason: 'invalid_now' });
  });

  it('issueMonthOf uses UTC', () => {
    expect(issueMonthOf(new Date('2026-01-01T00:30:00Z'))).toBe('2026-01');
  });
});
