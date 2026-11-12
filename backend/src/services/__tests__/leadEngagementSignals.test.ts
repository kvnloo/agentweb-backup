import {
  classifyEngagementSignal,
  computeHeatBreakdown,
  computeGenuineHeatScore,
  isAutomatedReply,
  isGenuineEngagementEvent,
  HOT_THRESHOLD,
  WARM_THRESHOLD,
} from '../leadEngagementSignals';

const NOW = Date.parse('2026-11-11T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();
const score = (engagements: any[], extra: any = {}) => computeGenuineHeatScore({ engagements, ...extra }, NOW);

describe('classifyEngagementSignal', () => {
  it.each([
    ['email.received', { subject: 'Re: hello', text: 'Sounds good, let us talk.' }, 'reply'],
    ['linkedin.message.received', { text: 'Hi Sondra! I would be interested to learn more.' }, 'reply'],
    ['custom.email_reply_received', { notes: 'Replied asking about speaking opportunities.' }, 'reply'],
    ['custom.email_replied', { sentiment: 'positive', notes: 'Happy to connect' }, 'reply'],
    ['custom.linkedin_reply', { outcome: 'discussion_requested' }, 'reply'],
    ['meeting.transcript_received', {}, 'meeting'],
    ['custom.meeting_booked', {}, 'meeting'],
    ['email.clicked', {}, 'click'],
    ['email.sent', {}, 'none'],
    ['email.delivered', {}, 'none'],
    ['email.opened', {}, 'none'],
    ['custom.email_sent', { from: 'sondra@nuerraa.com' }, 'none'],
    ['custom.atlanta_first_touch_sent', {}, 'none'],
    ['linkedin.invite.sent', {}, 'none'],
    ['linkedin.message.sent', {}, 'none'],
    ['status.changed', { from: 'new', to: 'received' }, 'none'],
    ['custom.intent_signal', { signal: 'LinkedIn search' }, 'none'],
  ])('%s -> expected', (eventType, eventData, expected) => {
    expect(classifyEngagementSignal({ eventType, eventData })).toBe(expected);
  });

  it('flags OOO / auto-reply / bounce replies as auto_reply', () => {
    const cases = [
      { subject: 'Automatic reply: Meet the Nov 17 panel' },
      { subject: 'Out of Office', text: 'I am away until Monday.' },
      { subject: 'Re: hi', text: "I'm currently out of the office with limited access to email." },
      { notes: 'Auto-reply: traveling this week. Directs urgent inquiries to drew@x.com' },
      { headers: { 'Auto-Submitted': 'auto-replied' }, subject: 'Re: intro', text: 'Thanks for your email.' },
      { headers: { 'X-Autoreply': 'yes' }, subject: 'Re: intro', text: 'Thanks.' },
      { from: 'MAILER-DAEMON@mx.example.com', subject: 'Undelivered Mail Returned to Sender' },
    ];
    for (const eventData of cases) {
      expect(classifyEngagementSignal({ eventType: 'email.received', eventData })).toBe('auto_reply');
    }
  });

  it('keeps a human reply that merely mentions a vacation in the body', () => {
    const eventData = { subject: 'Re: intro', text: 'I was on vacation last week, yes let us talk Friday.' };
    expect(isAutomatedReply(eventData)).toBe(false);
    expect(classifyEngagementSignal({ eventType: 'email.received', eventData })).toBe('reply');
  });

  it('treats explicit not-interested replies as negative_reply', () => {
    expect(classifyEngagementSignal({ eventType: 'email.received', eventData: { text: 'Not interested, please remove me.' } })).toBe('negative_reply');
    expect(classifyEngagementSignal({ eventType: 'custom.email_replied', eventData: { sentiment: 'negative' } })).toBe('negative_reply');
  });

  it('reads `data` as well as `eventData` (EmailEvents rows)', () => {
    expect(isGenuineEngagementEvent({ eventType: 'email.received', data: { subject: 'Automatic reply' } })).toBe(false);
    expect(isGenuineEngagementEvent({ eventType: 'email.received', data: { text: 'Yes please send details' } })).toBe(true);
  });
});

describe('computeGenuineHeatScore', () => {
  it('Lisa Calhoun case: freshly imported + one outbound send is Cold', () => {
    expect(score([{ eventType: 'custom.email_sent', createdAt: daysAgo(40) }], { createdAt: daysAgo(0.5), engagementCount: 1 })).toBe(0);
  });

  it('outbound volume never inflates the score', () => {
    const sends = Array.from({ length: 30 }, (_, i) => ({ eventType: 'email.sent', createdAt: daysAgo(i) }));
    expect(score(sends, { engagementCount: 30 })).toBe(0);
  });

  it('OOO reply plus recent sends stays Cold', () => {
    expect(score([
      { eventType: 'email.sent', createdAt: daysAgo(1) },
      { eventType: 'email.received', createdAt: daysAgo(0.5), eventData: { subject: 'Automatic reply: hello' } },
    ])).toBeLessThan(WARM_THRESHOLD);
  });

  it('an older genuine reply is Warm, a recent one is Hot', () => {
    expect(score([{ eventType: 'email.received', createdAt: daysAgo(60), eventData: { text: 'Interested' } }])).toBe(5);
    expect(score([{ eventType: 'email.received', createdAt: daysAgo(2), eventData: { text: 'Interested' } }])).toBeGreaterThanOrEqual(HOT_THRESHOLD);
  });

  it('a recent OOO does not refresh recency of an old genuine reply', () => {
    const b = computeHeatBreakdown({ engagements: [
      { eventType: 'email.received', createdAt: daysAgo(60), eventData: { text: 'Yes' } },
      { eventType: 'email.received', createdAt: daysAgo(0.1), eventData: { subject: 'Out of Office' } },
    ] }, NOW);
    expect(b.score).toBe(5);
    expect(b.autoReplies).toBe(1);
  });

  it('clicks alone never reach Warm', () => {
    const clicks = Array.from({ length: 10 }, () => ({ eventType: 'email.clicked', createdAt: daysAgo(0.1) }));
    expect(score(clicks)).toBeLessThan(WARM_THRESHOLD);
  });

  it('a meeting is Warm; a recent meeting is Hot', () => {
    expect(score([{ eventType: 'meeting.transcript_received', createdAt: daysAgo(90) }])).toBe(6);
    expect(score([{ eventType: 'meeting.transcript_received', createdAt: daysAgo(1) }])).toBeGreaterThanOrEqual(HOT_THRESHOLD);
  });

  it('counts a re-logged reply once, at its first timestamp', () => {
    const dup = (d: number) => ({ eventType: 'custom.email_reply_received', createdAt: daysAgo(d), eventData: { from: 'a@x.com', subject: 'Re: hi', body: 'Yes, let us talk next week.' } });
    const b = computeHeatBreakdown({ engagements: [dup(40), dup(1), dup(0.5), dup(40)] }, NOW);
    expect(b.replies).toBe(1);
    expect(b.score).toBe(5);
  });

  it('a polite decline is not Warm', () => {
    expect(score([{ eventType: 'custom.email_reply_received', createdAt: daysAgo(1), eventData: { body: "Thanks for reaching out! We're pretty set with our hiring process for now." } }])).toBe(0);
  });

  it('caps at 10', () => {
    expect(score([
      { eventType: 'meeting.transcript_received', createdAt: daysAgo(1) },
      { eventType: 'email.received', createdAt: daysAgo(1), eventData: { text: 'yes' } },
      { eventType: 'email.received', createdAt: daysAgo(1), eventData: { text: 'yes' } },
      { eventType: 'email.clicked', createdAt: daysAgo(1) },
    ])).toBe(10);
  });
});
