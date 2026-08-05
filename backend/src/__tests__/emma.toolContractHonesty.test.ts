const mockGetMetaAdsMetrics = jest.fn();

jest.mock('../services/agentModeService', () => {
  const actual = jest.requireActual('../services/agentModeService');
  return {
    ...actual,
    agentModeService: {
      getMetaAdsMetrics: (...args: any[]) => mockGetMetaAdsMetrics(...args),
      installSkills: jest.fn().mockResolvedValue({ success: true }),
      getUnassociatedToolNames: jest.fn().mockReturnValue([]),
    },
  };
});

jest.mock('../services/db', () => ({
  accountMemoryDb: {},
  orgMemoryDb: {},
  userDb: {},
  crmDb: {},
}));

jest.mock('../services/accountSummaryService', () => ({
  getAccountSummary: jest.fn().mockResolvedValue({}),
}));

jest.mock('../services/subscriptionService', () => ({
  getAllowedSkills: jest.fn().mockResolvedValue(['*']),
  resolveSkillsToToolNames: jest.fn().mockResolvedValue(['*']),
}));

jest.mock('../services/skillService', () => ({
  skillService: { getPublishedSkills: jest.fn().mockResolvedValue([]) },
}));

import { emmaToolRegistry } from '../emma/registry';
import { validateAndRepairToolArgs } from '../services/agentToolGatewayService';
import '../emma/tools';

describe('Emma tool contracts match dispatch behavior', () => {
  beforeEach(() => {
    mockGetMetaAdsMetrics.mockReset().mockResolvedValue({ success: true });
  });

  it('declares the enforced 2000-character save_memory limit in JSON Schema', () => {
    const contentSchema = emmaToolRegistry.getTool('save_memory')!
      .definition.inputSchema.properties.content;

    expect(contentSchema.maxLength).toBe(2000);
  });

  it('rejects over-length save_memory content at the gateway', () => {
    const tool = emmaToolRegistry.getTool('save_memory')!;
    const result = validateAndRepairToolArgs({
      toolName: 'save_memory',
      args: { content: 'x'.repeat(2001), category: 'insight' },
      inputSchema: tool.definition.inputSchema,
      effect: 'internal_write',
    });

    expect(result.status).toBe('invalid');
  });

  // The gateway and the persistence guard must MEASURE length the same way, not
  // merely share the number 2000. `accountMemoryDb.addMemory` (services/db.ts)
  // rejects with `content.length > 2000` — UTF-16 code units. A gateway that
  // counted code points instead would accept 1,500 emoji (1,500 code points /
  // 3,000 code units) and let them fail at execution.
  //
  // That is the exact defect class this issue exists to remove, so it would be a
  // poor outcome to reintroduce it inside the fix. These pin the boundary in the
  // units the runtime actually uses.
  it('measures save_memory length in the same units the persistence guard does', () => {
    const tool = emmaToolRegistry.getTool('save_memory')!;
    // 1,001 astral characters: 1,001 code points, 2,002 UTF-16 code units.
    // Under the runtime guard this is over the limit, so the gateway must reject it.
    const emoji = '😀'.repeat(1001);
    expect(Array.from(emoji).length).toBe(1001); // would look "valid" by code points
    expect(emoji.length).toBe(2002); // but this is what addMemory measures

    const result = validateAndRepairToolArgs({
      toolName: 'save_memory',
      args: { content: emoji, category: 'insight' },
      inputSchema: tool.definition.inputSchema,
      effect: 'internal_write',
    });

    expect(result.status).toBe('invalid');
  });

  it('still accepts astral content that fits the runtime limit', () => {
    // The mirror case: rejecting everything with an emoji in it would be its own
    // contract lie. 1,000 astral chars = 2,000 code units = exactly at the limit.
    const tool = emmaToolRegistry.getTool('save_memory')!;
    const emoji = '😀'.repeat(1000);
    expect(emoji.length).toBe(2000);

    const result = validateAndRepairToolArgs({
      toolName: 'save_memory',
      args: { content: emoji, category: 'insight' },
      inputSchema: tool.definition.inputSchema,
      effect: 'internal_write',
    });

    expect(result.status).not.toBe('invalid');
  });

  it('normalizes a JSON-encoded campaign_ids array before dispatch', async () => {
    await emmaToolRegistry.getTool('get_meta_ads_metrics')!.execute(
      { campaign_ids: '["campaign-1","campaign-2"]', timeframe: '14d' },
      { userId: 'user-1' },
    );

    expect(mockGetMetaAdsMetrics).toHaveBeenCalledWith(
      '14d',
      'user-1',
      ['campaign-1', 'campaign-2'],
      undefined,
    );
  });

  it('preserves an already-valid bare campaign id string', async () => {
    await emmaToolRegistry.getTool('get_meta_ads_metrics')!.execute(
      { campaign_ids: 'campaign-1' },
      { userId: 'user-1' },
    );

    expect(mockGetMetaAdsMetrics).toHaveBeenCalledWith(
      '7d',
      'user-1',
      ['campaign-1'],
      undefined,
    );
  });

  it('preserves an already-valid campaign id array', async () => {
    await emmaToolRegistry.getTool('get_meta_ads_metrics')!.execute(
      { campaign_ids: ['campaign-1', 'campaign-2'] },
      { userId: 'user-1' },
    );

    expect(mockGetMetaAdsMetrics).toHaveBeenCalledWith(
      '7d',
      'user-1',
      ['campaign-1', 'campaign-2'],
      undefined,
    );
  });
});
