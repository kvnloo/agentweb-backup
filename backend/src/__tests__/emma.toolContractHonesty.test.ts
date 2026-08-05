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

  // The gateway and the persistence guard must measure length in the SAME unit,
  // and that unit must be the one the schema advertises. `maxLength` in JSON
  // Schema means Unicode characters (code points), so 1,001 emoji is 1,001
  // characters and plainly inside a declared limit of 2,000.
  //
  // Getting this wrong in either direction reintroduces exactly the defect this
  // issue exists to remove:
  //   - gateway looser than runtime → schema-valid call throws at execution;
  //   - gateway stricter than schema → a contract stricter than its declaration.
  // Both are "contracts disagree with dispatch". These pin the agreement.
  it('accepts astral content that fits the declared character limit', () => {
    const tool = emmaToolRegistry.getTool('save_memory')!;
    // 1,001 astral characters: 1,001 code points, 2,002 UTF-16 code units.
    // Under `maxLength: 2000` this is valid, so it must dispatch.
    const emoji = '😀'.repeat(1001);
    expect(Array.from(emoji).length).toBe(1001);
    expect(emoji.length).toBe(2002); // the misleading measure

    const result = validateAndRepairToolArgs({
      toolName: 'save_memory',
      args: { content: emoji, category: 'insight' },
      inputSchema: tool.definition.inputSchema,
      effect: 'internal_write',
    });

    expect(result.status).not.toBe('invalid');
  });

  it('rejects astral content that exceeds the declared character limit', () => {
    const tool = emmaToolRegistry.getTool('save_memory')!;
    const emoji = '😀'.repeat(2001); // 2,001 characters — over by one
    expect(Array.from(emoji).length).toBe(2001);

    const result = validateAndRepairToolArgs({
      toolName: 'save_memory',
      args: { content: emoji, category: 'insight' },
      inputSchema: tool.definition.inputSchema,
      effect: 'internal_write',
    });

    expect(result.status).toBe('invalid');
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
