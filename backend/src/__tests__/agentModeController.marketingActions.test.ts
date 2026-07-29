/**
 * ENG-446 — canonical action payloads exposed through existing RUN data.
 *
 * The run surface is the scheduled-chat run result persisted by
 * `scheduleDb.addRunResult` and served by `GET /scheduled-chats/:id/test-history`.
 * These tests pin the behavioral contract (HUMAN-APPROVED in ENG-444, not
 * modified here) at that boundary:
 *
 *  A1 run responses carry the ENG-445 payload alongside the existing output
 *  A2 existing run-result content is behaviorally equivalent for legacy consumers
 *  A3 consumers receive the source's ids and canonical order; no re-ranking
 *  A4 a legacy run with no structured actions yields an empty list and still serves
 *  A6 duplicate delivery / retry does not mint new action IDs
 */

import { agentModeController } from '../controllers/agentModeController';
import { scheduleDb } from '../services/db';
import {
  MarketingActionCandidate,
  marketingActionId,
  selectTopMarketingActions,
} from '../services/marketingActionContract';
import { attachMarketingActions } from '../services/marketingActionEnvelope';

jest.mock('../services/db', () => ({
  scheduleDb: {
    getScheduleById: jest.fn(),
    getRunResults: jest.fn(),
  },
}));

jest.mock('../services/emailService', () => ({
  emailService: {
    sendDailyDigestEmail: jest.fn(),
    sendScheduledChatResultEmail: jest.fn(),
  },
}));

const mockScheduleDb = scheduleDb as jest.Mocked<typeof scheduleDb>;

const USER = { userId: 'user-123', email: 'test@example.com' };
const SCHEDULE = { scheduleId: 'schedule-123', userId: 'user-123', scheduleName: 'Weekly review' };

function mockReq() {
  return { user: USER, params: { scheduleId: SCHEDULE.scheduleId } } as any;
}

function mockRes() {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

function candidate(overrides: Partial<MarketingActionCandidate> = {}): MarketingActionCandidate {
  return {
    actionType: 'pause_ad',
    recommendation: 'Pause the Gusto creative — CPA is 3x target.',
    scopeId: 'campaign_42',
    evidence: ['CPA $180 vs $60 target over 7 days'],
    expectedImpact: 'Recover ~$1.2k/wk of wasted spend',
    sourceKind: 'run',
    sourceId: 'run-1',
    priority: {
      businessImpact: 'high',
      campaignPriority: 'high',
      urgency: 'medium',
      confidence: 'high',
      easeOfExecution: 'high',
    },
    ctaType: 'approve',
    deepLink: '/marketing-hub',
    ...overrides,
  };
}

/** A run result in the shape persisted today (actualResponse already stripped). */
function legacyRunResult(overrides: Record<string, any> = {}) {
  return {
    scheduleId: SCHEDULE.scheduleId,
    runId: 'run-1',
    status: 'success',
    passed: true,
    actualFunctionCalls: ['get_campaign_metrics'],
    keywordMatches: ['spend'],
    keywordMisses: [],
    functionCallMatches: [],
    functionCallMisses: [],
    executionTime: 5120,
    sessionId: 'session-9',
    attempt: 1,
    createdAt: '2026-07-28T10:00:00.000Z',
    summary: 'Weekly performance review completed.',
    ...overrides,
  };
}

async function getTestHistory() {
  const res = mockRes();
  mockScheduleDb.getScheduleById.mockResolvedValue(SCHEDULE as any);
  await agentModeController.getScheduledChatTestHistory(mockReq(), res);
  expect(res.status).not.toHaveBeenCalledWith(500);
  return res.json.mock.calls[0][0];
}

describe('ENG-446 run surface — GET /scheduled-chats/:id/test-history', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('A1 — run responses carry the canonical payload', () => {
    it('exposes actions attached to a run result', async () => {
      const stored = attachMarketingActions(legacyRunResult(), [candidate()]);
      mockScheduleDb.getRunResults.mockResolvedValue([stored] as any);

      const body = await getTestHistory();

      expect(body).toHaveLength(1);
      expect(body[0].marketingActions).toHaveLength(1);
      expect(body[0].marketingActions[0].id).toBe(marketingActionId('pause_ad', 'campaign_42'));
      expect(body[0].marketingActions[0].recommendation).toBe(
        'Pause the Gusto creative — CPA is 3x target.'
      );
    });

    it('exposes the action status carried by the run', async () => {
      const stored = attachMarketingActions(legacyRunResult(), [candidate()]);
      mockScheduleDb.getRunResults.mockResolvedValue([stored] as any);

      const body = await getTestHistory();

      expect(body[0].marketingActions[0].status).toBe('proposed');
    });

    it('never exposes more than the ENG-445 cap of three actions', async () => {
      const stored = attachMarketingActions(legacyRunResult(), [
        candidate({ actionType: 'a', scopeId: 's1' }),
        candidate({ actionType: 'b', scopeId: 's2' }),
        candidate({ actionType: 'c', scopeId: 's3' }),
        candidate({ actionType: 'd', scopeId: 's4' }),
      ]);
      mockScheduleDb.getRunResults.mockResolvedValue([stored] as any);

      const body = await getTestHistory();

      expect(body[0].marketingActions).toHaveLength(3);
    });
  });

  describe('A2 — existing run-result content stays behaviorally equivalent', () => {
    it('preserves every pre-existing field of a legacy run result', async () => {
      const stored = legacyRunResult();
      mockScheduleDb.getRunResults.mockResolvedValue([stored] as any);

      const body = await getTestHistory();

      for (const key of Object.keys(stored)) {
        expect(JSON.stringify(body[0][key])).toBe(JSON.stringify((stored as any)[key]));
      }
    });

    it('does not mutate the stored run result', async () => {
      const stored = legacyRunResult();
      const snapshot = JSON.stringify(stored);
      mockScheduleDb.getRunResults.mockResolvedValue([stored] as any);

      await getTestHistory();

      expect(JSON.stringify(stored)).toBe(snapshot);
    });
  });

  describe('A3 — one order from the run source; consumers never re-rank', () => {
    it('serves the stored order verbatim even when it differs from a fresh ranking', async () => {
      const strong = candidate({ actionType: 'scale_budget', scopeId: 'camp_strong' });
      const weak = candidate({
        actionType: 'tweak_copy',
        scopeId: 'camp_weak',
        priority: {
          businessImpact: 'low',
          campaignPriority: 'low',
          urgency: 'low',
          confidence: 'low',
          easeOfExecution: 'low',
        },
      });

      const ranked = selectTopMarketingActions([strong, weak]);
      expect(ranked[0].scopeId).toBe('camp_strong');

      // The run persisted the reverse order; the endpoint must not re-sort it.
      const stored = { ...legacyRunResult(), marketingActions: [...ranked].reverse() };
      mockScheduleDb.getRunResults.mockResolvedValue([stored] as any);

      const body = await getTestHistory();

      expect(body[0].marketingActions.map((a: any) => a.scopeId)).toEqual([
        'camp_weak',
        'camp_strong',
      ]);
    });

    it('serves identical ids and order to repeated consumers', async () => {
      const stored = attachMarketingActions(legacyRunResult(), [
        candidate({ actionType: 'a', scopeId: 's1' }),
        candidate({ actionType: 'b', scopeId: 's2' }),
      ]);
      mockScheduleDb.getRunResults.mockResolvedValue([stored] as any);

      const first = await getTestHistory();
      const second = await getTestHistory();

      expect(first[0].marketingActions.map((a: any) => a.id)).toEqual(
        second[0].marketingActions.map((a: any) => a.id)
      );
    });

    it('fails loudly on a run whose carried action id drifted from its canonical identity', async () => {
      const stored = attachMarketingActions(legacyRunResult(), [candidate()]);
      const tampered = {
        ...stored,
        marketingActions: [{ ...stored.marketingActions[0], id: 'act_deadbeefdeadbeef' }],
      };
      mockScheduleDb.getRunResults.mockResolvedValue([tampered] as any);
      mockScheduleDb.getScheduleById.mockResolvedValue(SCHEDULE as any);

      const res = mockRes();
      await agentModeController.getScheduledChatTestHistory(mockReq(), res);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  describe('A4 — legacy runs read as empty and keep serving', () => {
    it('returns an empty action list for a run with no structured actions', async () => {
      mockScheduleDb.getRunResults.mockResolvedValue([legacyRunResult()] as any);

      const body = await getTestHistory();

      expect(body[0].marketingActions).toEqual([]);
    });

    it('serves a mixed history of legacy and action-carrying runs', async () => {
      const withActions = attachMarketingActions(legacyRunResult({ runId: 'run-2' }), [candidate()]);
      mockScheduleDb.getRunResults.mockResolvedValue([legacyRunResult(), withActions] as any);

      const body = await getTestHistory();

      expect(body).toHaveLength(2);
      expect(body[0].marketingActions).toEqual([]);
      expect(body[1].marketingActions).toHaveLength(1);
    });

    it('returns an empty history without error when the schedule has never run', async () => {
      mockScheduleDb.getRunResults.mockResolvedValue([] as any);

      const body = await getTestHistory();

      expect(body).toEqual([]);
    });
  });

  describe('A6 — duplicate delivery / retry never mints new action IDs', () => {
    it('a retried run re-attaching the same action serves the same id', async () => {
      const candidates = [candidate()];
      const firstDelivery = attachMarketingActions(legacyRunResult(), candidates);
      const retry = attachMarketingActions(legacyRunResult({ attempt: 2 }), candidates);

      mockScheduleDb.getRunResults.mockResolvedValue([firstDelivery, retry] as any);

      const body = await getTestHistory();

      expect(body[0].marketingActions[0].id).toBe(body[1].marketingActions[0].id);
    });

    it('a retry preserves an approval already recorded against the canonical id', async () => {
      const candidates = [candidate()];
      const delivered = attachMarketingActions(legacyRunResult(), candidates);
      const approved = {
        ...delivered,
        marketingActions: [{ ...delivered.marketingActions[0], status: 'approved' as const }],
      };
      const retry = attachMarketingActions(approved, candidates);

      mockScheduleDb.getRunResults.mockResolvedValue([retry] as any);

      const body = await getTestHistory();

      expect(body[0].marketingActions[0].status).toBe('approved');
      expect(body[0].marketingActions[0].id).toBe(marketingActionId('pause_ad', 'campaign_42'));
    });
  });
});
