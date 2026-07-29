/**
 * ENG-446 — canonical action payloads exposed through existing REPORT data.
 *
 * The report surface is the HTML-report envelope returned by
 * `GET /api/tasks/executions/with-html-reports`. Its response post-processing
 * is `buildHtmlReportsResponsePayload`, which strips searchableText and now
 * also normalizes each report file's canonical action list.
 *
 * Behavioral contract (HUMAN-APPROVED in ENG-444, not modified here):
 *  A1 report responses carry the ENG-445 payload alongside the HTML output
 *  A2 existing long-form report content is byte-for-byte equivalent
 *  A3 consumers receive the source's ids and canonical order; no re-ranking
 *  A4 a legacy report with no structured actions yields an empty list and renders
 *  A6 duplicate delivery / retry does not mint new action IDs
 */

import {
  MarketingActionCandidate,
  marketingActionId,
  selectTopMarketingActions,
} from '../services/marketingActionContract';
import { attachMarketingActions } from '../services/marketingActionEnvelope';

jest.mock('../services/chatbotService');
jest.mock('../config/aws');
jest.mock('../services/db', () => ({
  taskDb: {},
  subscriberDb: {},
  orgDb: {},
  userDb: {},
}));
jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'user123', isAdmin: false };
    next();
  },
}));

const { buildHtmlReportsResponsePayload } = require('../routes/tasks');

const REPORT_URL = 'https://bucket.s3.amazonaws.com/files/weekly-report.html';
const LONG_FORM_HTML =
  '<h1>Weekly performance</h1><p>Spend was $4,120 against a $3,500 plan.</p>';

function candidate(overrides: Partial<MarketingActionCandidate> = {}): MarketingActionCandidate {
  return {
    actionType: 'pause_ad',
    recommendation: 'Pause the Gusto creative — CPA is 3x target.',
    scopeId: 'campaign_42',
    evidence: ['CPA $180 vs $60 target over 7 days'],
    expectedImpact: 'Recover ~$1.2k/wk of wasted spend',
    sourceKind: 'report',
    sourceId: REPORT_URL,
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

/** A report file entry in the shape produced today. */
function legacyReportFile(overrides: Record<string, any> = {}) {
  return {
    url: REPORT_URL,
    filename: 'weekly-report.html',
    token: 'tok_abc',
    is_html: true,
    is_favorited: false,
    is_archived: false,
    reportType: 'performance',
    searchableText: LONG_FORM_HTML,
    ...overrides,
  };
}

/** The executions-with-assets envelope shape produced by getExecutionsWithAssets. */
function reportEnvelope(files: any[]) {
  return {
    'agent-mode-session-9': {
      taskId: 'agent-mode-session-9',
      taskName: 'Weekly marketing review',
      createdAt: '2026-07-28T09:00:00.000Z',
      source: 'agent-mode',
      sessionId: 'session-9',
      latestExecutionTime: '2026-07-28T10:00:00.000Z',
      executions: [
        {
          executionId: 'session-9-html',
          startTime: '2026-07-28T10:00:00.000Z',
          result_files: files,
        },
      ],
    },
  };
}

function filesOf(payload: any) {
  return payload['agent-mode-session-9'].executions[0].result_files;
}

describe('ENG-446 report surface — buildHtmlReportsResponsePayload', () => {
  describe('A1 — report responses carry the canonical payload', () => {
    it('exposes actions attached to a report file', () => {
      const file = attachMarketingActions(legacyReportFile(), [candidate()]);
      const payload = buildHtmlReportsResponsePayload(reportEnvelope([file]));

      expect(filesOf(payload)[0].marketingActions).toHaveLength(1);
      expect(filesOf(payload)[0].marketingActions[0].id).toBe(
        marketingActionId('pause_ad', 'campaign_42')
      );
      expect(filesOf(payload)[0].marketingActions[0].sourceKind).toBe('report');
    });

    it('carries actions alongside the report file identity fields', () => {
      const file = attachMarketingActions(legacyReportFile(), [candidate()]);
      const payload = buildHtmlReportsResponsePayload(reportEnvelope([file]));

      expect(filesOf(payload)[0].url).toBe(REPORT_URL);
      expect(filesOf(payload)[0].filename).toBe('weekly-report.html');
      expect(filesOf(payload)[0].reportType).toBe('performance');
      expect(filesOf(payload)[0].marketingActions[0].status).toBe('proposed');
    });

    it('never exposes more than the ENG-445 cap of three actions', () => {
      const file = attachMarketingActions(legacyReportFile(), [
        candidate({ actionType: 'a', scopeId: 's1' }),
        candidate({ actionType: 'b', scopeId: 's2' }),
        candidate({ actionType: 'c', scopeId: 's3' }),
        candidate({ actionType: 'd', scopeId: 's4' }),
      ]);
      const payload = buildHtmlReportsResponsePayload(reportEnvelope([file]));

      expect(filesOf(payload)[0].marketingActions).toHaveLength(3);
    });
  });

  describe('A2 — long-form report content unchanged for legacy consumers', () => {
    it('still strips searchableText from the response (pre-existing behavior)', () => {
      const payload = buildHtmlReportsResponsePayload(reportEnvelope([legacyReportFile()]));

      expect(filesOf(payload)[0].searchableText).toBeUndefined();
    });

    it('does not mutate the source envelope or its long-form content', () => {
      const source = reportEnvelope([legacyReportFile()]);
      const snapshot = JSON.stringify(source);

      buildHtmlReportsResponsePayload(source);

      expect(JSON.stringify(source)).toBe(snapshot);
      expect(filesOf(source)[0].searchableText).toBe(LONG_FORM_HTML);
    });

    it('preserves every other pre-existing report field byte-for-byte', () => {
      const original = legacyReportFile();
      const payload = buildHtmlReportsResponsePayload(reportEnvelope([original]));
      const served = filesOf(payload)[0];

      for (const key of Object.keys(original)) {
        if (key === 'searchableText') continue;
        expect(JSON.stringify(served[key])).toBe(JSON.stringify((original as any)[key]));
      }
    });

    it('preserves the surrounding task/execution envelope fields', () => {
      const payload = buildHtmlReportsResponsePayload(reportEnvelope([legacyReportFile()]));
      const task = payload['agent-mode-session-9'];

      expect(task.taskName).toBe('Weekly marketing review');
      expect(task.sessionId).toBe('session-9');
      expect(task.executions[0].executionId).toBe('session-9-html');
    });
  });

  describe('A3 — one order from the report source; consumers never re-rank', () => {
    it('serves the stored order verbatim even when it differs from a fresh ranking', () => {
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

      const file = { ...legacyReportFile(), marketingActions: [...ranked].reverse() };
      const payload = buildHtmlReportsResponsePayload(reportEnvelope([file]));

      expect(filesOf(payload)[0].marketingActions.map((a: any) => a.scopeId)).toEqual([
        'camp_weak',
        'camp_strong',
      ]);
    });

    it('fails loudly on a report whose carried action id drifted from its canonical identity', () => {
      const file = attachMarketingActions(legacyReportFile(), [candidate()]);
      const tampered = {
        ...file,
        marketingActions: [{ ...file.marketingActions[0], id: 'act_deadbeefdeadbeef' }],
      };

      expect(() => buildHtmlReportsResponsePayload(reportEnvelope([tampered]))).toThrow();
    });
  });

  describe('A4 — legacy reports read as empty and keep rendering', () => {
    it('returns an empty action list for a report with no structured actions', () => {
      const payload = buildHtmlReportsResponsePayload(reportEnvelope([legacyReportFile()]));

      expect(filesOf(payload)[0].marketingActions).toEqual([]);
    });

    it('serves a mix of legacy and action-carrying report files', () => {
      const withActions = attachMarketingActions(
        legacyReportFile({ url: `${REPORT_URL}?v=2`, filename: 'weekly-report-v2.html' }),
        [candidate()]
      );
      const payload = buildHtmlReportsResponsePayload(
        reportEnvelope([legacyReportFile(), withActions])
      );

      expect(filesOf(payload)[0].marketingActions).toEqual([]);
      expect(filesOf(payload)[1].marketingActions).toHaveLength(1);
    });

    it('handles an execution with no result_files', () => {
      const envelope = reportEnvelope([]);
      (envelope['agent-mode-session-9'].executions[0] as any).result_files = undefined;

      const payload = buildHtmlReportsResponsePayload(envelope);

      expect(payload['agent-mode-session-9'].executions[0].result_files).toBeUndefined();
    });

    it('handles a task envelope with no executions', () => {
      const envelope: any = reportEnvelope([]);
      delete envelope['agent-mode-session-9'].executions;

      expect(() => buildHtmlReportsResponsePayload(envelope)).not.toThrow();
    });

    it('handles an entirely empty envelope', () => {
      expect(buildHtmlReportsResponsePayload({})).toEqual({});
    });
  });

  describe('A6 — duplicate delivery / retry never mints new action IDs', () => {
    it('a regenerated report re-attaching the same action serves the same id', () => {
      const candidates = [candidate()];
      const first = attachMarketingActions(legacyReportFile(), candidates);
      const regenerated = attachMarketingActions(
        legacyReportFile({ url: `${REPORT_URL}?v=2` }),
        candidates
      );

      const payload = buildHtmlReportsResponsePayload(reportEnvelope([first, regenerated]));

      expect(filesOf(payload)[0].marketingActions[0].id).toBe(
        filesOf(payload)[1].marketingActions[0].id
      );
    });

    it('a regenerated report preserves a status already recorded against the canonical id', () => {
      const candidates = [candidate()];
      const delivered = attachMarketingActions(legacyReportFile(), candidates);
      const completed = {
        ...delivered,
        marketingActions: [{ ...delivered.marketingActions[0], status: 'completed' as const }],
      };
      const regenerated = attachMarketingActions(completed, candidates);

      const payload = buildHtmlReportsResponsePayload(reportEnvelope([regenerated]));

      expect(filesOf(payload)[0].marketingActions[0].status).toBe('completed');
      expect(filesOf(payload)[0].marketingActions[0].id).toBe(
        marketingActionId('pause_ad', 'campaign_42')
      );
    });
  });
});
