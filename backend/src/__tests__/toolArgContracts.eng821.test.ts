/**
 * ENG-821 — tool argument contracts must match what the handler actually accepts.
 *
 * One root pattern, three instances. In each, the runtime contract was narrower than
 * what the schema advertised, so the model emitted a well-formed call the handler
 * refused. Because the model cannot see the real constraint, it retried the same shape
 * until the circuit breaker stopped it, turning one defect into two or three failure
 * events. Measured over Jul 28 – Aug 1 in Dev-AW-LoopEvents: 48 failures across these
 * three tools, roughly a third of them pure retry amplification.
 *
 * Each fix widens the declared contract to match the real one rather than adding a
 * retry or a guard, so nothing that worked before changes.
 */

jest.mock('@slack/web-api', () => ({
  WebClient: jest.fn().mockImplementation(() => ({
    chat: { postMessage: jest.fn() },
    conversations: { info: jest.fn(), list: jest.fn() },
    views: { open: jest.fn() },
  })),
}));

jest.mock('../services/db', () => ({
  crmDb: {
    getLeadListById: jest.fn(),
    getLeadsByListId: jest.fn(),
    canOrgMemberAccessList: jest.fn(),
  },
  userDb: { getUserById: jest.fn() },
}));

import { AgentModeService } from '../services/agentModeService';
import { crmDb } from '../services/db';
import '../emma/tools';
import { emmaToolRegistry } from '../emma/registry';

const mockCrmDb = crmDb as jest.Mocked<typeof crmDb>;

describe('ENG-821 — save_memory declares its length cap in the schema', () => {
  it('exposes maxLength on content so an over-length call is never generated', () => {
    const tool: any = emmaToolRegistry.getTool('save_memory');
    expect(tool).toBeDefined();

    // Registry stores handlers as { name, definition, execute }; the schema the model
    // actually sees lives on `definition`.
    const content = tool.definition?.inputSchema?.properties?.content;
    expect(content).toBeDefined();

    // The 2000-char cap is enforced by a hard throw in db.ts. Declaring it only in the
    // human-readable description left it advisory: 22 rejections plus 11 retry-amplified
    // ones in a single window, the largest single source of tool failures on the account.
    expect(content.maxLength).toBe(2000);
  });
});

describe('ENG-821 — searchLeads accepts free-text search as a filter criterion', () => {
  let service: AgentModeService;
  const userId = 'user-1';
  const listId = 'list-1';

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AgentModeService();
    mockCrmDb.getLeadListById.mockResolvedValue({ listId, userId, name: 'Test List' } as any);
    mockCrmDb.canOrgMemberAccessList.mockResolvedValue(true as any);
    mockCrmDb.getLeadsByListId.mockResolvedValue({
      leads: [
        { leadId: 'lead-1', listId, email: 'ops@openrouter.ai', firstName: 'A', customFields: {} },
        { leadId: 'lead-2', listId, email: 'nobody@example.com', firstName: 'B', customFields: {} },
      ],
      lastEvaluatedKey: undefined,
    } as any);
  });

  it('succeeds with an empty filters array when search is provided', async () => {
    // The exact shape the model emitted and the guard rejected 11 times.
    const result: any = await service.searchLeads(listId, [], userId, 50, {
      search: 'openrouter.ai',
    });

    expect(result.error).not.toBe('Provide at least one filter criterion');
    expect(result.success).not.toBe(false);
  });

  it('still rejects when neither filters nor search are supplied', async () => {
    const result: any = await service.searchLeads(listId, [], userId, 50, {});

    expect(result.success).toBe(false);
    expect(result.error).toBe('Provide at least one filter criterion');
  });

  it('still rejects when options is omitted entirely', async () => {
    const result: any = await service.searchLeads(listId, [], userId, 50);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Provide at least one filter criterion');
  });
});

describe('ENG-821 — get_meta_ads_metrics accepts a JSON-encoded campaign_ids array', () => {
  const CAMPAIGN = '120241445300020585';
  let metricsSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.restoreAllMocks();
    metricsSpy = jest
      .spyOn(AgentModeService.prototype, 'getMetaAdsMetrics')
      .mockResolvedValue({ success: true } as any);
  });

  afterEach(() => jest.restoreAllMocks());

  /** The campaign ids the tool actually forwarded to the service. */
  const forwardedIds = () => metricsSpy.mock.calls[0][2];

  it('parses a stringified array into real ids', async () => {
    // The schema advertises "array or string", so the model emitted a JSON-encoded
    // array. That previously became a one-element array holding the literal JSON text,
    // which Meta rejected with `(#100) param filtering must be an array`.
    await emmaToolRegistry.execute(
      'get_meta_ads_metrics',
      { account_id: '922903076601160', campaign_ids: `["${CAMPAIGN}"]`, timeframe: '7d' },
      { userId: 'user-1' },
    );

    expect(forwardedIds()).toEqual([CAMPAIGN]);
  });

  it('parses a multi-element stringified array', async () => {
    await emmaToolRegistry.execute(
      'get_meta_ads_metrics',
      { campaign_ids: `["${CAMPAIGN}", "999"]`, timeframe: '7d' },
      { userId: 'user-1' },
    );

    expect(forwardedIds()).toEqual([CAMPAIGN, '999']);
  });

  it('still accepts a real array unchanged', async () => {
    await emmaToolRegistry.execute(
      'get_meta_ads_metrics',
      { campaign_ids: [CAMPAIGN], timeframe: '7d' },
      { userId: 'user-1' },
    );

    expect(forwardedIds()).toEqual([CAMPAIGN]);
  });

  it('still accepts a bare id string unchanged', async () => {
    await emmaToolRegistry.execute(
      'get_meta_ads_metrics',
      { campaign_ids: CAMPAIGN, timeframe: '7d' },
      { userId: 'user-1' },
    );

    expect(forwardedIds()).toEqual([CAMPAIGN]);
  });

  it('treats a malformed bracketed string as a single literal id rather than throwing', async () => {
    await emmaToolRegistry.execute(
      'get_meta_ads_metrics',
      { campaign_ids: '[not-valid-json', timeframe: '7d' },
      { userId: 'user-1' },
    );

    expect(forwardedIds()).toEqual(['[not-valid-json']);
  });
});
