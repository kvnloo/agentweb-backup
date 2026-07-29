/**
 * ENG-446 — Expose canonical action payloads through existing report/run data.
 *
 * Behavioral contract (HUMAN-APPROVED in ENG-444 — NOT modified here). Each
 * assertion maps to an A<n> describe block below:
 *
 *  A1 Existing report/run responses can carry the shared marketing-action
 *     payload (ENG-445) alongside the current text/HTML output.
 *  A2 Existing long-form report content remains byte-for-byte or behaviorally
 *     equivalent for legacy consumers; this issue does not redesign it.
 *  A3 All consumers receive the same selected action IDs and canonical order
 *     from the report/run source; consumers do not independently rerank or
 *     regenerate recommendations.
 *  A4 A legacy report/run with no structured actions produces an empty action
 *     list and continues to render successfully.
 *  A5 Status updates use the canonical action ID so proposed/approved/
 *     dismissed/completed state can be represented consistently to consumers.
 *  A6 Duplicate scheduled delivery or retry does not create new action IDs for
 *     the same report/run action.
 *  A7 No live campaign mutation, Slack send, or external API call occurs.
 *  A8 The implementation is backward-compatible until ENG-444's taste gate
 *     approves visible rendering.
 */

import fs from 'fs';
import path from 'path';

import {
  MarketingActionCandidate,
  MarketingActionContractError,
  MarketingActionPriorityInputs,
  marketingActionId,
  selectTopMarketingActions,
} from '../marketingActionContract';
import {
  MARKETING_ACTIONS_FIELD,
  attachMarketingActions,
  normalizeMarketingActions,
  readMarketingActions,
  setMarketingActionStatus,
} from '../marketingActionEnvelope';

function neutralPriority(
  overrides: Partial<MarketingActionPriorityInputs> = {}
): MarketingActionPriorityInputs {
  return {
    businessImpact: 'medium',
    campaignPriority: 'medium',
    urgency: 'medium',
    confidence: 'medium',
    easeOfExecution: 'medium',
    ...overrides,
  };
}

let fixtureCounter = 0;

function candidate(overrides: Partial<MarketingActionCandidate> = {}): MarketingActionCandidate {
  fixtureCounter += 1;
  return {
    actionType: `pause_ad_${fixtureCounter}`,
    recommendation: `Pause underperforming ad ${fixtureCounter}`,
    scopeId: `campaign_${fixtureCounter}`,
    evidence: [`CPA 3x target for 7 days (${fixtureCounter})`],
    expectedImpact: 'Recover ~20% of wasted spend',
    sourceKind: 'run',
    sourceId: 'run-abc-123',
    priority: neutralPriority(),
    ctaType: 'approve',
    deepLink: '/marketing-hub',
    ...overrides,
  };
}

/** A realistic scheduled-run envelope as persisted today (no actions field). */
function legacyRunEnvelope() {
  return {
    scheduleId: 'schedule-123',
    runId: 'run-abc-123',
    status: 'success' as const,
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
  };
}

/** A realistic HTML-report file entry as returned today (no actions field). */
function legacyReportEnvelope() {
  return {
    url: 'https://bucket.s3.amazonaws.com/files/weekly-report.html',
    filename: 'weekly-report.html',
    token: 'tok_abc',
    is_html: true,
    reportType: 'performance' as const,
    searchableText: '<h1>Weekly performance</h1><p>Spend was $4,120 …</p>',
  };
}

describe('ENG-446 marketingActionEnvelope', () => {
  describe('A1 — report/run envelopes can carry the ENG-445 payload alongside existing output', () => {
    it('attaches selected actions to a run envelope without disturbing existing fields', () => {
      const envelope = legacyRunEnvelope();
      const attached = attachMarketingActions(envelope, [candidate()]);

      expect(attached[MARKETING_ACTIONS_FIELD]).toHaveLength(1);
      expect(attached.summary).toBe('Weekly performance review completed.');
      expect(attached.runId).toBe('run-abc-123');
      expect(attached.status).toBe('success');
    });

    it('attaches selected actions to a report envelope alongside its HTML content', () => {
      const envelope = legacyReportEnvelope();
      const attached = attachMarketingActions(envelope, [
        candidate({ sourceKind: 'report', sourceId: envelope.url }),
      ]);

      expect(attached[MARKETING_ACTIONS_FIELD]).toHaveLength(1);
      expect(attached[MARKETING_ACTIONS_FIELD][0].sourceKind).toBe('report');
      expect(attached.searchableText).toBe(envelope.searchableText);
      expect(attached.url).toBe(envelope.url);
    });

    it('carried actions expose the full ENG-445 field set including the stable id', () => {
      const c = candidate();
      const attached = attachMarketingActions(legacyRunEnvelope(), [c]);
      const action = attached[MARKETING_ACTIONS_FIELD][0];

      expect(action.id).toBe(marketingActionId(c.actionType, c.scopeId));
      expect(action.status).toBe('proposed');
      expect(action.actionType).toBe(c.actionType);
      expect(action.recommendation).toBe(c.recommendation);
      expect(action.scopeId).toBe(c.scopeId);
      expect(action.evidence).toEqual(c.evidence);
      expect(action.expectedImpact).toBe(c.expectedImpact);
      expect(action.sourceId).toBe(c.sourceId);
      expect(action.ctaType).toBe(c.ctaType);
      expect(action.deepLink).toBe(c.deepLink);
      expect(action.priority).toEqual(c.priority);
    });

    it('never carries more than the ENG-445 cap of three actions', () => {
      const attached = attachMarketingActions(legacyRunEnvelope(), [
        candidate(),
        candidate(),
        candidate(),
        candidate(),
        candidate(),
      ]);
      expect(attached[MARKETING_ACTIONS_FIELD]).toHaveLength(3);
    });
  });

  describe('A2 — existing long-form content is untouched for legacy consumers', () => {
    it('attaching does not mutate the source envelope', () => {
      const envelope = legacyReportEnvelope();
      const snapshot = JSON.stringify(envelope);

      attachMarketingActions(envelope, [candidate({ sourceKind: 'report' })]);

      expect(JSON.stringify(envelope)).toBe(snapshot);
      expect(MARKETING_ACTIONS_FIELD in envelope).toBe(false);
    });

    it('every pre-existing key is byte-for-byte equal after attaching', () => {
      const envelope = legacyReportEnvelope();
      const attached = attachMarketingActions(envelope, [candidate({ sourceKind: 'report' })]);

      for (const key of Object.keys(envelope) as Array<keyof typeof envelope>) {
        expect(JSON.stringify(attached[key])).toBe(JSON.stringify(envelope[key]));
      }
    });

    it('normalizing a legacy envelope leaves the long-form content identical', () => {
      const envelope = legacyReportEnvelope();
      const normalized = normalizeMarketingActions(envelope);

      expect(normalized.searchableText).toBe(envelope.searchableText);
      expect(normalized.filename).toBe(envelope.filename);
      expect(normalized.reportType).toBe(envelope.reportType);
    });

    it('normalizing does not mutate the source envelope', () => {
      const envelope = legacyRunEnvelope();
      const snapshot = JSON.stringify(envelope);

      normalizeMarketingActions(envelope);

      expect(JSON.stringify(envelope)).toBe(snapshot);
    });
  });

  describe('A3 — one selected order from the source; consumers never re-rank', () => {
    it('reading returns the stored order verbatim, even when it differs from a fresh ranking', () => {
      const high = candidate({
        actionType: 'scale_budget',
        scopeId: 'campaign_high',
        priority: neutralPriority({ businessImpact: 'high', campaignPriority: 'high' }),
      });
      const low = candidate({
        actionType: 'pause_ad',
        scopeId: 'campaign_low',
        priority: neutralPriority({ businessImpact: 'low', campaignPriority: 'low' }),
      });

      // The source ranked high-before-low. A consumer storing them in the
      // opposite order must still be handed exactly what it was given.
      const ranked = selectTopMarketingActions([low, high]);
      expect(ranked[0].scopeId).toBe('campaign_high');

      const reversed = { ...legacyRunEnvelope(), [MARKETING_ACTIONS_FIELD]: [...ranked].reverse() };
      const read = readMarketingActions(reversed);

      expect(read.map((a) => a.scopeId)).toEqual(['campaign_low', 'campaign_high']);
    });

    it('every consumer of the same envelope gets identical ids and order', () => {
      const attached = attachMarketingActions(legacyRunEnvelope(), [
        candidate({ actionType: 'a', scopeId: 's1' }),
        candidate({ actionType: 'b', scopeId: 's2' }),
      ]);

      // Two independent consumers reading the same transported envelope.
      const portal = readMarketingActions(JSON.parse(JSON.stringify(attached)));
      const notification = readMarketingActions(JSON.parse(JSON.stringify(attached)));

      expect(portal.map((a) => a.id)).toEqual(notification.map((a) => a.id));
      expect(portal.map((a) => a.id)).toEqual(attached[MARKETING_ACTIONS_FIELD].map((a) => a.id));
    });

    it('the carried order matches the ENG-445 selector for the same candidates', () => {
      const candidates = [
        candidate({ actionType: 'a', scopeId: 's1', priority: neutralPriority({ urgency: 'low' }) }),
        candidate({ actionType: 'b', scopeId: 's2', priority: neutralPriority({ urgency: 'high' }) }),
      ];
      const attached = attachMarketingActions(legacyRunEnvelope(), candidates);

      expect(attached[MARKETING_ACTIONS_FIELD].map((a) => a.id)).toEqual(
        selectTopMarketingActions(candidates).map((a) => a.id)
      );
    });

    it('rejects a transported payload whose id drifted from its canonical identity', () => {
      const attached = attachMarketingActions(legacyRunEnvelope(), [candidate()]);
      const tampered = {
        ...attached,
        [MARKETING_ACTIONS_FIELD]: [{ ...attached[MARKETING_ACTIONS_FIELD][0], id: 'act_deadbeefdeadbeef' }],
      };

      expect(() => readMarketingActions(tampered)).toThrow(MarketingActionContractError);
    });

    it('rejects a payload that is present but not an array', () => {
      expect(() =>
        readMarketingActions({ ...legacyRunEnvelope(), [MARKETING_ACTIONS_FIELD]: 'not-an-array' })
      ).toThrow(MarketingActionContractError);
    });

    it('rejects a structurally invalid carried action instead of silently dropping it', () => {
      const attached = attachMarketingActions(legacyRunEnvelope(), [candidate()]);
      const broken = {
        ...attached,
        [MARKETING_ACTIONS_FIELD]: [{ ...attached[MARKETING_ACTIONS_FIELD][0], recommendation: '' }],
      };

      expect(() => readMarketingActions(broken)).toThrow(MarketingActionContractError);
    });
  });

  describe('A4 — legacy report/run with no structured actions reads as empty and still renders', () => {
    it('a legacy run envelope reads as an empty action list', () => {
      expect(readMarketingActions(legacyRunEnvelope())).toEqual([]);
    });

    it('a legacy report envelope reads as an empty action list', () => {
      expect(readMarketingActions(legacyReportEnvelope())).toEqual([]);
    });

    it('normalizing a legacy envelope yields an explicit empty array plus all original fields', () => {
      const envelope = legacyRunEnvelope();
      const normalized = normalizeMarketingActions(envelope);

      expect(normalized[MARKETING_ACTIONS_FIELD]).toEqual([]);
      expect(normalized.scheduleId).toBe('schedule-123');
      expect(normalized.summary).toBe('Weekly performance review completed.');
    });

    it('an explicitly empty payload reads as empty', () => {
      expect(readMarketingActions({ ...legacyRunEnvelope(), [MARKETING_ACTIONS_FIELD]: [] })).toEqual([]);
    });

    it('a null payload reads as empty rather than throwing', () => {
      expect(readMarketingActions({ ...legacyRunEnvelope(), [MARKETING_ACTIONS_FIELD]: null })).toEqual([]);
    });

    it('a non-object envelope reads as empty rather than throwing', () => {
      expect(readMarketingActions(undefined)).toEqual([]);
      expect(readMarketingActions(null)).toEqual([]);
      expect(readMarketingActions('legacy string body')).toEqual([]);
    });

    it('attaching zero candidates yields an explicit empty list, never a placeholder', () => {
      const attached = attachMarketingActions(legacyRunEnvelope(), []);
      expect(attached[MARKETING_ACTIONS_FIELD]).toEqual([]);
    });
  });

  describe('A5 — status updates are keyed by the canonical action ID', () => {
    it('transitions the addressed action and preserves its id', () => {
      const c = candidate();
      const attached = attachMarketingActions(legacyRunEnvelope(), [c]);
      const id = marketingActionId(c.actionType, c.scopeId);

      const approved = setMarketingActionStatus(attached, id, 'approved');

      expect(approved[MARKETING_ACTIONS_FIELD][0].id).toBe(id);
      expect(approved[MARKETING_ACTIONS_FIELD][0].status).toBe('approved');
    });

    it('supports the full proposed → approved → dismissed → completed lifecycle on one id', () => {
      const c = candidate();
      let envelope: any = attachMarketingActions(legacyRunEnvelope(), [c]);
      const id = marketingActionId(c.actionType, c.scopeId);

      expect(envelope[MARKETING_ACTIONS_FIELD][0].status).toBe('proposed');
      for (const status of ['approved', 'dismissed', 'completed'] as const) {
        envelope = setMarketingActionStatus(envelope, id, status);
        expect(envelope[MARKETING_ACTIONS_FIELD][0].status).toBe(status);
        expect(envelope[MARKETING_ACTIONS_FIELD][0].id).toBe(id);
      }
    });

    it('leaves sibling actions and their order untouched', () => {
      const a = candidate({ actionType: 'a', scopeId: 's1' });
      const b = candidate({ actionType: 'b', scopeId: 's2' });
      const attached = attachMarketingActions(legacyRunEnvelope(), [a, b]);
      const beforeIds = attached[MARKETING_ACTIONS_FIELD].map((x) => x.id);

      const updated = setMarketingActionStatus(attached, marketingActionId('a', 's1'), 'completed');

      expect(updated[MARKETING_ACTIONS_FIELD].map((x) => x.id)).toEqual(beforeIds);
      const other = updated[MARKETING_ACTIONS_FIELD].find((x) => x.id !== marketingActionId('a', 's1'));
      expect(other!.status).toBe('proposed');
    });

    it('throws when the action ID is not carried by the envelope', () => {
      const attached = attachMarketingActions(legacyRunEnvelope(), [candidate()]);
      expect(() => setMarketingActionStatus(attached, 'act_0000000000000000', 'approved')).toThrow(
        MarketingActionContractError
      );
    });

    it('throws on an unknown status instead of writing it through', () => {
      const c = candidate();
      const attached = attachMarketingActions(legacyRunEnvelope(), [c]);
      const id = marketingActionId(c.actionType, c.scopeId);

      expect(() => setMarketingActionStatus(attached, id, 'archived' as any)).toThrow(
        MarketingActionContractError
      );
    });

    it('does not mutate the source envelope', () => {
      const c = candidate();
      const attached = attachMarketingActions(legacyRunEnvelope(), [c]);
      const snapshot = JSON.stringify(attached);

      setMarketingActionStatus(attached, marketingActionId(c.actionType, c.scopeId), 'approved');

      expect(JSON.stringify(attached)).toBe(snapshot);
    });
  });

  describe('A6 — duplicate delivery / retry never mints new action IDs', () => {
    it('re-attaching the same candidates produces identical ids', () => {
      const candidates = [candidate({ actionType: 'a', scopeId: 's1' })];
      const first = attachMarketingActions(legacyRunEnvelope(), candidates);
      const second = attachMarketingActions(legacyRunEnvelope(), candidates);

      expect(second[MARKETING_ACTIONS_FIELD].map((x) => x.id)).toEqual(
        first[MARKETING_ACTIONS_FIELD].map((x) => x.id)
      );
    });

    it('a retry that re-attaches onto an envelope already carrying actions keeps the same ids', () => {
      const candidates = [candidate({ actionType: 'a', scopeId: 's1' })];
      const firstDelivery = attachMarketingActions(legacyRunEnvelope(), candidates);
      const retry = attachMarketingActions(firstDelivery, candidates);

      expect(retry[MARKETING_ACTIONS_FIELD].map((x) => x.id)).toEqual(
        firstDelivery[MARKETING_ACTIONS_FIELD].map((x) => x.id)
      );
    });

    it('a retry preserves status already recorded against the canonical id', () => {
      const candidates = [candidate({ actionType: 'a', scopeId: 's1' })];
      const id = marketingActionId('a', 's1');
      const delivered = attachMarketingActions(legacyRunEnvelope(), candidates);
      const approved = setMarketingActionStatus(delivered, id, 'approved');

      const retry = attachMarketingActions(approved, candidates);

      expect(retry[MARKETING_ACTIONS_FIELD][0].id).toBe(id);
      expect(retry[MARKETING_ACTIONS_FIELD][0].status).toBe('approved');
    });

    it('a retry that drops an action does not resurrect its old status onto a different action', () => {
      const first = attachMarketingActions(legacyRunEnvelope(), [
        candidate({ actionType: 'a', scopeId: 's1' }),
      ]);
      const approved = setMarketingActionStatus(first, marketingActionId('a', 's1'), 'approved');

      const retry = attachMarketingActions(approved, [candidate({ actionType: 'b', scopeId: 's2' })]);

      expect(retry[MARKETING_ACTIONS_FIELD]).toHaveLength(1);
      expect(retry[MARKETING_ACTIONS_FIELD][0].id).toBe(marketingActionId('b', 's2'));
      expect(retry[MARKETING_ACTIONS_FIELD][0].status).toBe('proposed');
    });

    it('cosmetic producer variance (case/whitespace) does not mint a new id on retry', () => {
      const first = attachMarketingActions(legacyRunEnvelope(), [
        candidate({ actionType: 'pause_ad', scopeId: 'camp_1' }),
      ]);
      const retry = attachMarketingActions(first, [
        candidate({ actionType: '  Pause_Ad ', scopeId: ' CAMP_1  ' }),
      ]);

      expect(retry[MARKETING_ACTIONS_FIELD][0].id).toBe(first[MARKETING_ACTIONS_FIELD][0].id);
    });

    it('a serialize/transport round-trip preserves ids, order and status', () => {
      const c = candidate();
      const delivered = setMarketingActionStatus(
        attachMarketingActions(legacyRunEnvelope(), [c, candidate()]),
        marketingActionId(c.actionType, c.scopeId),
        'completed'
      );

      const transported = JSON.parse(JSON.stringify(delivered));
      const read = readMarketingActions(transported);

      expect(read.map((x) => x.id)).toEqual(delivered[MARKETING_ACTIONS_FIELD].map((x) => x.id));
      expect(read.map((x) => x.status)).toEqual(
        delivered[MARKETING_ACTIONS_FIELD].map((x) => x.status)
      );
    });
  });

  describe('A7 — no live campaign mutation, Slack send, or external API call', () => {
    it('the envelope module imports no network, AWS, or Slack dependency', () => {
      const source = fs.readFileSync(
        path.join(__dirname, '..', 'marketingActionEnvelope.ts'),
        'utf8'
      );
      const forbidden = [
        'aws-sdk',
        '@aws-sdk',
        'axios',
        'node-fetch',
        'http',
        'https',
        'slack',
        'dynamodb',
        './db',
      ];
      const imports = source.match(/from\s+'[^']+'/g) || [];
      for (const spec of imports) {
        for (const bad of forbidden) {
          expect(spec.toLowerCase()).not.toContain(bad);
        }
      }
    });

    it('exercising the full seam performs no I/O and returns plain data', () => {
      const c = candidate();
      const attached = attachMarketingActions(legacyRunEnvelope(), [c]);
      const updated = setMarketingActionStatus(
        attached,
        marketingActionId(c.actionType, c.scopeId),
        'approved'
      );
      const read = readMarketingActions(updated);

      expect(JSON.parse(JSON.stringify(read))).toEqual(read);
    });
  });

  describe('A8 — backward-compatible until the ENG-444 taste gate approves rendering', () => {
    it('adds exactly one new key and no rendering/copy fields', () => {
      const envelope = legacyRunEnvelope();
      const attached = attachMarketingActions(envelope, [candidate()]);

      const added = Object.keys(attached).filter((k) => !(k in envelope));
      expect(added).toEqual([MARKETING_ACTIONS_FIELD]);
    });

    it('normalizing a legacy envelope adds only the empty action list', () => {
      const envelope = legacyReportEnvelope();
      const normalized = normalizeMarketingActions(envelope);

      const added = Object.keys(normalized).filter((k) => !(k in envelope));
      expect(added).toEqual([MARKETING_ACTIONS_FIELD]);
    });

    it('normalizing an envelope that already carries actions is idempotent', () => {
      const attached = attachMarketingActions(legacyRunEnvelope(), [candidate()]);
      const once = normalizeMarketingActions(attached);
      const twice = normalizeMarketingActions(once);

      expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
    });

    it('the carried payload contains no presentation copy beyond the ENG-445 contract fields', () => {
      const attached = attachMarketingActions(legacyRunEnvelope(), [candidate()]);
      expect(Object.keys(attached[MARKETING_ACTIONS_FIELD][0]).sort()).toEqual(
        [
          'actionType',
          'ctaType',
          'deepLink',
          'evidence',
          'expectedImpact',
          'id',
          'priority',
          'recommendation',
          'scopeId',
          'sourceId',
          'sourceKind',
          'status',
        ].sort()
      );
    });
  });
});
