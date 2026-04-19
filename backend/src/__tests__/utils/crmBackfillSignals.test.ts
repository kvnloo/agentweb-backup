import {
  BackfillEvent,
  BackfillDeal,
  buildBackfillSignalsExtension,
  deriveActivitySignalsFromEvents,
  findUnresolvedSupportIssueOpenedAt,
  openDealStagesFromDeals,
} from '../../utils/crmBackfillSignals';

function ev(eventType: string, eventTimestamp: string): BackfillEvent {
  return { eventType, eventTimestamp };
}

describe('crmBackfillSignals', () => {
  describe('deriveActivitySignalsFromEvents', () => {
    it('returns all-null when there are no events', () => {
      expect(deriveActivitySignalsFromEvents([])).toEqual({
        lastEngagementAt: null,
        lastUsageAt: null,
        lastEmmaSessionAt: null,
        lastEngagementReplyAt: null,
      });
    });

    it('picks the latest emma session for emma + usage fields', () => {
      const events = [
        ev('engagement.emma_session', '2026-04-01T10:00:00Z'),
        ev('engagement.emma_session', '2026-04-15T09:30:00Z'),
        ev('engagement.emma_session', '2026-03-20T08:00:00Z'),
      ];
      const out = deriveActivitySignalsFromEvents(events);
      expect(out.lastEmmaSessionAt).toBe('2026-04-15T09:30:00Z');
      expect(out.lastUsageAt).toBe('2026-04-15T09:30:00Z');
    });

    it('picks the latest across email_opened/clicked/linkedin_reply/meeting.attended for lastEngagementAt', () => {
      const events = [
        ev('engagement.email_opened', '2026-04-01T10:00:00Z'),
        ev('engagement.email_clicked', '2026-04-05T10:00:00Z'),
        ev('engagement.linkedin_reply', '2026-04-10T10:00:00Z'),
        ev('meeting.attended', '2026-04-02T10:00:00Z'),
      ];
      expect(deriveActivitySignalsFromEvents(events).lastEngagementAt).toBe(
        '2026-04-10T10:00:00Z'
      );
    });

    it('only linkedin_reply flows into lastEngagementReplyAt', () => {
      const events = [
        ev('engagement.linkedin_reply', '2026-04-10T10:00:00Z'),
        ev('engagement.linkedin_reply', '2026-04-14T10:00:00Z'),
        ev('engagement.email_opened', '2026-04-15T10:00:00Z'),
      ];
      expect(deriveActivitySignalsFromEvents(events).lastEngagementReplyAt).toBe(
        '2026-04-14T10:00:00Z'
      );
    });

    it('ignores unrelated event types', () => {
      const events = [
        ev('contact.created', '2026-04-01T10:00:00Z'),
        ev('payment.subscribed', '2026-04-05T10:00:00Z'),
        ev('lifecycle.changed', '2026-04-14T10:00:00Z'),
      ];
      expect(deriveActivitySignalsFromEvents(events)).toEqual({
        lastEngagementAt: null,
        lastUsageAt: null,
        lastEmmaSessionAt: null,
        lastEngagementReplyAt: null,
      });
    });

    it('skips malformed timestamps', () => {
      const events = [
        ev('engagement.emma_session', 'not-a-date'),
        ev('engagement.emma_session', '2026-04-15T09:30:00Z'),
        ev('engagement.emma_session', ''),
      ];
      expect(deriveActivitySignalsFromEvents(events).lastEmmaSessionAt).toBe(
        '2026-04-15T09:30:00Z'
      );
    });

    it('skips rows missing eventType / eventTimestamp', () => {
      const events = [
        { eventType: '', eventTimestamp: '2026-04-15T09:30:00Z' } as BackfillEvent,
        { eventType: 'engagement.emma_session', eventTimestamp: '' } as BackfillEvent,
        ev('engagement.emma_session', '2026-04-15T09:30:00Z'),
      ];
      expect(deriveActivitySignalsFromEvents(events).lastEmmaSessionAt).toBe(
        '2026-04-15T09:30:00Z'
      );
    });
  });

  describe('findUnresolvedSupportIssueOpenedAt', () => {
    it('returns null when there are no support.opened events', () => {
      expect(findUnresolvedSupportIssueOpenedAt([])).toBeNull();
      expect(
        findUnresolvedSupportIssueOpenedAt([ev('engagement.email_opened', '2026-04-01T10:00:00Z')])
      ).toBeNull();
    });

    it('returns the latest opened when no resolved exists', () => {
      const events = [
        ev('support.opened', '2026-04-01T10:00:00Z'),
        ev('support.opened', '2026-04-10T10:00:00Z'),
      ];
      expect(findUnresolvedSupportIssueOpenedAt(events)).toBe('2026-04-10T10:00:00Z');
    });

    it('returns null when resolved happened AFTER the latest opened', () => {
      const events = [
        ev('support.opened', '2026-04-01T10:00:00Z'),
        ev('support.resolved', '2026-04-05T10:00:00Z'),
      ];
      expect(findUnresolvedSupportIssueOpenedAt(events)).toBeNull();
    });

    it('returns the opened when resolved predates it', () => {
      const events = [
        ev('support.resolved', '2026-04-01T10:00:00Z'),
        ev('support.opened', '2026-04-10T10:00:00Z'),
      ];
      expect(findUnresolvedSupportIssueOpenedAt(events)).toBe('2026-04-10T10:00:00Z');
    });
  });

  describe('openDealStagesFromDeals', () => {
    it('returns an empty list for empty input', () => {
      expect(openDealStagesFromDeals([])).toEqual([]);
    });

    it('filters out Won/Lost closed stages', () => {
      const deals: BackfillDeal[] = [
        { dealId: 'd1', stage: 'Qualified' },
        { dealId: 'd2', stage: 'Won' },
        { dealId: 'd3', stage: 'Lost' },
        { dealId: 'd4', stage: 'Demo' },
      ];
      expect(openDealStagesFromDeals(deals).sort()).toEqual(['Demo', 'Qualified']);
    });

    it('de-dupes repeated stages', () => {
      const deals: BackfillDeal[] = [
        { dealId: 'd1', stage: 'Qualified' },
        { dealId: 'd2', stage: 'Qualified' },
        { dealId: 'd3', stage: 'Demo' },
      ];
      expect(openDealStagesFromDeals(deals)).toEqual(['Qualified', 'Demo']);
    });

    it('drops malformed rows (no stage, non-string stage)', () => {
      const deals = [
        { dealId: 'd1' } as BackfillDeal,
        { dealId: 'd2', stage: null } as BackfillDeal,
        { dealId: 'd3', stage: 42 as unknown as string } as BackfillDeal,
        { dealId: 'd4', stage: 'Proposal' } as BackfillDeal,
      ];
      expect(openDealStagesFromDeals(deals)).toEqual(['Proposal']);
    });
  });

  describe('buildBackfillSignalsExtension', () => {
    it('composes activity + support + open-deal signals in one call', () => {
      const events: BackfillEvent[] = [
        ev('engagement.emma_session', '2026-04-15T09:30:00Z'),
        ev('engagement.linkedin_reply', '2026-04-10T10:00:00Z'),
        ev('support.opened', '2026-04-12T10:00:00Z'),
      ];
      const deals: BackfillDeal[] = [
        { dealId: 'd1', stage: 'Demo' },
        { dealId: 'd2', stage: 'Won' },
      ];
      expect(buildBackfillSignalsExtension(events, deals)).toEqual({
        lastEngagementAt: '2026-04-10T10:00:00Z',
        lastUsageAt: '2026-04-15T09:30:00Z',
        lastEmmaSessionAt: '2026-04-15T09:30:00Z',
        lastEngagementReplyAt: '2026-04-10T10:00:00Z',
        unresolvedSupportIssueOpenedAt: '2026-04-12T10:00:00Z',
        openDealStages: ['Demo'],
      });
    });

    it('yields all-null/empty when the contact has no events or deals (prospect-only lead)', () => {
      expect(buildBackfillSignalsExtension([], [])).toEqual({
        lastEngagementAt: null,
        lastUsageAt: null,
        lastEmmaSessionAt: null,
        lastEngagementReplyAt: null,
        unresolvedSupportIssueOpenedAt: null,
        openDealStages: [],
      });
    });
  });
});
