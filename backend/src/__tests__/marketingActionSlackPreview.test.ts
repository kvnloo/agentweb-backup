/**
 * ENG-573 — Slack rendering of the shared top-three marketing actions.
 *
 * Behavioral contract (HUMAN-APPROVED in ENG-444/ENG-573 — NOT modified here):
 *  AC2 Slack receives the same action IDs, order, and statuses as the
 *      portal/report source.
 *  AC3 Slack does not run an independent ranking or recommendation path.
 *  AC4 Each preview deep-links to the canonical portal detail.
 *  AC5 No live budget/campaign mutation or customer message is fired in tests.
 *  AC6 Fixture-based tests prove parity with the shared action payload and
 *      cover failure/degraded states.
 */
import {
  MarketingActionCandidate,
  marketingActionId,
} from '../services/marketingActionContract';
import {
  attachMarketingActions,
  readMarketingActions,
  setMarketingActionStatus,
} from '../services/marketingActionEnvelope';
import {
  buildMarketingActionSlackPreview,
  sendMarketingActionsSlackPreview,
} from '../services/marketingActionSlackPreview';

jest.mock('../services/slackService', () => ({
  postSlackMessage: jest.fn().mockResolvedValue({ ts: '123.456', channel: 'C123' }),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { postSlackMessage } = require('../services/slackService') as {
  postSlackMessage: jest.Mock;
};

const candidate = (
  overrides: Partial<MarketingActionCandidate> & { actionType: string; scopeId: string }
): MarketingActionCandidate => ({
  recommendation: `Do ${overrides.actionType} on ${overrides.scopeId}`,
  evidence: ['fixture evidence'],
  expectedImpact: 'fixture impact',
  sourceKind: 'run',
  sourceId: 'run-fixture-1',
  priority: {
    businessImpact: 'medium',
    campaignPriority: 'medium',
    urgency: 'medium',
    confidence: 'medium',
    easeOfExecution: 'medium',
  },
  ctaType: 'review',
  deepLink: '/marketing-hub',
  ...overrides,
});

const PORTAL = 'https://app.agentweb.pro';

const fixtureEnvelope = () =>
  attachMarketingActions(
    { runId: 'run-fixture-1' },
    [
      candidate({
        actionType: 'scale_budget',
        scopeId: 'camp-a',
        priority: {
          businessImpact: 'high',
          campaignPriority: 'high',
          urgency: 'high',
          confidence: 'high',
          easeOfExecution: 'high',
        },
        deepLink: '/campaigns/camp-a',
      }),
      candidate({
        actionType: 'pause_ad',
        scopeId: 'camp-b',
        priority: {
          businessImpact: 'high',
          campaignPriority: 'medium',
          urgency: 'medium',
          confidence: 'medium',
          easeOfExecution: 'low',
        },
        deepLink: 'https://app.agentweb.pro/campaigns/camp-b',
      }),
      candidate({ actionType: 'refresh_creative', scopeId: 'camp-c' }),
    ]
  );

beforeEach(() => {
  postSlackMessage.mockClear();
});

describe('buildMarketingActionSlackPreview — parity with the shared payload', () => {
  it('renders the same action IDs in the same stored order as the envelope (AC2/AC3)', () => {
    const envelope = fixtureEnvelope();
    const storedIds = readMarketingActions(envelope).map((a) => a.id);

    const preview = buildMarketingActionSlackPreview(envelope, { portalBaseUrl: PORTAL });
    if (preview.kind !== 'preview') throw new Error(`expected preview, got ${preview.kind}`);

    expect(preview.actionIds).toEqual(storedIds);
    // Every id appears in the text, in stored order — no re-ranking path.
    const positions = storedIds.map((id) => preview.text.indexOf(id));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('renders the source statuses verbatim, including non-proposed ones (AC2)', () => {
    let envelope = fixtureEnvelope();
    const ids = readMarketingActions(envelope).map((a) => a.id);
    envelope = setMarketingActionStatus(envelope, ids[0], 'approved');

    const preview = buildMarketingActionSlackPreview(envelope, { portalBaseUrl: PORTAL });
    if (preview.kind !== 'preview') throw new Error(`expected preview, got ${preview.kind}`);

    expect(preview.text).toContain('approved');
    // Statuses in the preview mirror the envelope, not a recomputed default.
    const actions = readMarketingActions(envelope);
    for (const action of actions) {
      expect(preview.text).toContain(action.status);
    }
  });

  it('is invariant under candidate input permutation because it renders stored order (AC3)', () => {
    const base = fixtureEnvelope();
    // Same candidates, different order → the SHARED selector fixes the order;
    // the Slack preview must match it, not re-derive its own.
    const permuted = attachMarketingActions(
      { runId: 'run-fixture-1' },
      [
        candidate({ actionType: 'refresh_creative', scopeId: 'camp-c' }),
        candidate({
          actionType: 'pause_ad',
          scopeId: 'camp-b',
          priority: {
            businessImpact: 'high',
            campaignPriority: 'medium',
            urgency: 'medium',
            confidence: 'medium',
            easeOfExecution: 'low',
          },
          deepLink: 'https://app.agentweb.pro/campaigns/camp-b',
        }),
        candidate({
          actionType: 'scale_budget',
          scopeId: 'camp-a',
          priority: {
            businessImpact: 'high',
            campaignPriority: 'high',
            urgency: 'high',
            confidence: 'high',
            easeOfExecution: 'high',
          },
          deepLink: '/campaigns/camp-a',
        }),
      ]
    );

    const a = buildMarketingActionSlackPreview(base, { portalBaseUrl: PORTAL });
    const b = buildMarketingActionSlackPreview(permuted, { portalBaseUrl: PORTAL });
    expect(a).toEqual(b);
  });

  it('deep-links each action to the canonical portal detail (AC4)', () => {
    const preview = buildMarketingActionSlackPreview(fixtureEnvelope(), { portalBaseUrl: PORTAL });
    if (preview.kind !== 'preview') throw new Error(`expected preview, got ${preview.kind}`);

    // Portal-relative deepLink is joined onto the portal base…
    expect(preview.text).toContain('https://app.agentweb.pro/campaigns/camp-a');
    // …absolute deepLinks pass through untouched.
    expect(preview.text).toContain('https://app.agentweb.pro/campaigns/camp-b');
  });

  it('fails closed for off-origin and Slack-control-character deep links', () => {
    const offOrigin = attachMarketingActions({ runId: 'r-off-origin' }, [
      candidate({
        actionType: 'pause_ad',
        scopeId: 'camp-off-origin',
        deepLink: 'https://evil.example/campaigns/camp-off-origin',
      }),
    ]);
    const slackControl = attachMarketingActions({ runId: 'r-slack-control' }, [
      candidate({
        actionType: 'pause_ad',
        scopeId: 'camp-slack-control',
        deepLink: '/campaigns/camp-slack-control|<!channel>',
      }),
    ]);

    expect(buildMarketingActionSlackPreview(offOrigin, { portalBaseUrl: PORTAL }).kind).toBe(
      'invalid'
    );
    expect(buildMarketingActionSlackPreview(slackControl, { portalBaseUrl: PORTAL }).kind).toBe(
      'invalid'
    );
  });

  it('escapes Slack control characters in user-visible action text', () => {
    const envelope = attachMarketingActions({ runId: 'r' }, [
      candidate({
        actionType: 'pause_ad',
        scopeId: 'camp-x',
        recommendation: 'Pause <!channel> & <https://evil.example|click>',
      }),
    ]);
    const preview = buildMarketingActionSlackPreview(envelope, { portalBaseUrl: PORTAL });
    if (preview.kind !== 'preview') throw new Error(`expected preview, got ${preview.kind}`);
    expect(preview.text).not.toContain('<!channel>');
    expect(preview.text).toContain('&lt;!channel&gt;');
  });
});

describe('buildMarketingActionSlackPreview — degraded states (AC6)', () => {
  it('reads a legacy envelope with no actions as empty, never a fabricated preview', () => {
    expect(buildMarketingActionSlackPreview({ runId: 'legacy' }, { portalBaseUrl: PORTAL })).toEqual(
      { kind: 'empty' }
    );
    expect(
      buildMarketingActionSlackPreview(
        { runId: 'explicit-empty', marketingActions: [] },
        { portalBaseUrl: PORTAL }
      )
    ).toEqual({ kind: 'empty' });
  });

  it('surfaces a tampered payload as invalid instead of rendering it', () => {
    const tampered = {
      runId: 'r',
      marketingActions: [
        {
          ...readMarketingActions(fixtureEnvelope())[0],
          id: 'act_forged_id_0000',
        },
      ],
    };
    const result = buildMarketingActionSlackPreview(tampered, { portalBaseUrl: PORTAL });
    if (result.kind !== 'invalid') throw new Error(`expected invalid, got ${result.kind}`);
    expect(result.reason).toContain('canonical identity');
  });

  it('rethrows non-contract errors instead of misreporting them as payload problems', () => {
    const hostile = {};
    Object.defineProperty(hostile, 'marketingActions', {
      enumerable: true,
      get() {
        throw new TypeError('unrelated infrastructure failure');
      },
    });
    expect(() => buildMarketingActionSlackPreview(hostile, { portalBaseUrl: PORTAL })).toThrow(
      'unrelated infrastructure failure'
    );
  });

  it('joins a portal path without a leading slash onto the base correctly', () => {
    const envelope = attachMarketingActions({ runId: 'r' }, [
      candidate({ actionType: 'pause_ad', scopeId: 'camp-x', deepLink: 'marketing-hub' }),
    ]);
    const preview = buildMarketingActionSlackPreview(envelope, { portalBaseUrl: `${PORTAL}/` });
    if (preview.kind !== 'preview') throw new Error('expected preview');
    expect(preview.text).toContain('https://app.agentweb.pro/marketing-hub');
  });

  it('surfaces a structurally broken payload as invalid with the parser reason', () => {
    const broken = { runId: 'r', marketingActions: [{ actionType: '' }] };
    const result = buildMarketingActionSlackPreview(broken, { portalBaseUrl: PORTAL });
    expect(result.kind).toBe('invalid');
  });

  it('rejects an oversized stored payload instead of rendering or truncating it', () => {
    const firstThree = readMarketingActions(fixtureEnvelope());
    const fourth = readMarketingActions(
      attachMarketingActions({ runId: 'r-fourth' }, [
        candidate({ actionType: 'reduce_bid', scopeId: 'camp-d' }),
      ])
    )[0];

    const result = buildMarketingActionSlackPreview(
      { runId: 'r-oversized', marketingActions: [...firstThree, fourth] },
      { portalBaseUrl: PORTAL }
    );

    expect(result.kind).toBe('invalid');
  });
});

describe('sendMarketingActionsSlackPreview — thin transport (AC5)', () => {
  it('posts exactly one message carrying the built preview text', async () => {
    const envelope = fixtureEnvelope();
    const outcome = await sendMarketingActionsSlackPreview('C123', envelope, {
      portalBaseUrl: PORTAL,
    });

    expect(outcome.kind).toBe('sent');
    expect(postSlackMessage).toHaveBeenCalledTimes(1);
    const [channel, text] = postSlackMessage.mock.calls[0];
    expect(channel).toBe('C123');
    const built = buildMarketingActionSlackPreview(envelope, { portalBaseUrl: PORTAL });
    if (built.kind !== 'preview') throw new Error('fixture must build a preview');
    expect(text).toBe(built.text);
  });

  it('sends with default options when none are given', async () => {
    const outcome = await sendMarketingActionsSlackPreview('C123', fixtureEnvelope());
    expect(outcome.kind).toBe('sent');
    expect(postSlackMessage).toHaveBeenCalledTimes(1);
  });

  it('sends nothing for an empty envelope', async () => {
    const outcome = await sendMarketingActionsSlackPreview('C123', { runId: 'legacy' }, {
      portalBaseUrl: PORTAL,
    });
    expect(outcome).toEqual({ kind: 'empty' });
    expect(postSlackMessage).not.toHaveBeenCalled();
  });

  it('sends nothing for an invalid payload and reports the reason', async () => {
    const outcome = await sendMarketingActionsSlackPreview(
      'C123',
      { runId: 'r', marketingActions: [{ actionType: '' }] },
      { portalBaseUrl: PORTAL }
    );
    expect(outcome.kind).toBe('invalid');
    expect(postSlackMessage).not.toHaveBeenCalled();
  });

  it('returns an explicit failed outcome when Slack transport rejects', async () => {
    postSlackMessage.mockRejectedValueOnce(new Error('transport unavailable'));

    await expect(
      sendMarketingActionsSlackPreview('C123', fixtureEnvelope(), { portalBaseUrl: PORTAL })
    ).resolves.toEqual({ kind: 'failed', reason: 'Slack transport failed: transport unavailable' });
  });

  it('defaults the portal base to CUSTOMER_FRONTEND_URL, falling back to prod portal', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { defaultPortalBaseUrl } = require('../services/marketingActionSlackPreview');
    expect(defaultPortalBaseUrl({ CUSTOMER_FRONTEND_URL: 'https://portal.test' })).toBe(
      'https://portal.test'
    );
    expect(defaultPortalBaseUrl({})).toBe('https://app.agentweb.pro');

    // And build() without an explicit base uses the default resolution path.
    const preview = buildMarketingActionSlackPreview(fixtureEnvelope());
    if (preview.kind !== 'preview') throw new Error('expected preview');
    expect(preview.text).toContain('/campaigns/camp-a');
  });

  it('id derivation sanity: preview ids are the canonical contract ids', () => {
    const envelope = fixtureEnvelope();
    const preview = buildMarketingActionSlackPreview(envelope, { portalBaseUrl: PORTAL });
    if (preview.kind !== 'preview') throw new Error('expected preview');
    expect(preview.actionIds).toContain(marketingActionId('scale_budget', 'camp-a'));
  });
});
