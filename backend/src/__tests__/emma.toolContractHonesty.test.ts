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

  const dispatchMetaMetrics = async (args: Record<string, unknown>) => {
    const tool = emmaToolRegistry.getTool('get_meta_ads_metrics')!;
    const validation = validateAndRepairToolArgs({
      toolName: 'get_meta_ads_metrics',
      args,
      inputSchema: tool.definition.inputSchema,
      effect: 'read',
    });
    expect(validation.status).not.toBe('invalid');
    await tool.execute(validation.args as Record<string, unknown>, { userId: 'user-1' });
  };

  it('declares the enforced 2000-character save_memory limit in JSON Schema', () => {
    const contentSchema = emmaToolRegistry.getTool('save_memory')!
      .definition.inputSchema.properties.content;

    expect(contentSchema.maxLength).toBe(8000); // ENG-2574: auto-split ceiling
  });

  it('rejects over-length save_memory content at the gateway', () => {
    const tool = emmaToolRegistry.getTool('save_memory')!;
    const result = validateAndRepairToolArgs({
      toolName: 'save_memory',
      args: { content: 'x'.repeat(8001), category: 'insight' },
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
    // Under `maxLength: 8000` this is valid, so it must dispatch.
    const emoji = '😀'.repeat(4001);
    expect(Array.from(emoji).length).toBe(4001);
    expect(emoji.length).toBe(8002); // the misleading measure

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
    const emoji = '😀'.repeat(8001); // 8,001 characters — over by one
    expect(Array.from(emoji).length).toBe(8001);

    const result = validateAndRepairToolArgs({
      toolName: 'save_memory',
      args: { content: emoji, category: 'insight' },
      inputSchema: tool.definition.inputSchema,
      effect: 'internal_write',
    });

    expect(result.status).toBe('invalid');
  });

  // ENG-1486: org memory has always enforced this ceiling at persistence time,
  // but until these tests it only described it in prose. That let a schema-valid
  // call reach the handler and fail after the model had spent a full tool turn.
  it('declares the enforced 2,000-character org-memory limit in JSON Schema', () => {
    const contentSchema = emmaToolRegistry.getTool('save_org_memory')!
      .definition.inputSchema.properties.content;

    expect(contentSchema.maxLength).toBe(8000); // ENG-2574: auto-split ceiling
  });

  it('rejects over-length org memory before execution with an exact recovery count', () => {
    const tool = emmaToolRegistry.getTool('save_org_memory')!;
    const result = validateAndRepairToolArgs({
      toolName: 'save_org_memory',
      args: { content: 'x'.repeat(8001), category: 'insight' },
      inputSchema: tool.definition.inputSchema,
      effect: 'internal_write',
    });

    expect(result).toMatchObject({
      status: 'invalid',
      modelMessage: expect.stringContaining('received 8001; remove at least 1'),
    });
  });

  it('uses Unicode code points for the org-memory boundary too', () => {
    const tool = emmaToolRegistry.getTool('save_org_memory')!;
    const emoji = '😀'.repeat(8001);
    const result = validateAndRepairToolArgs({
      toolName: 'save_org_memory',
      args: { content: emoji, category: 'insight' },
      inputSchema: tool.definition.inputSchema,
      effect: 'internal_write',
    });

    expect(result).toMatchObject({
      status: 'invalid',
      modelMessage: expect.stringContaining('received 8001; remove at least 1'),
    });
  });


  it('normalizes a JSON-encoded campaign_ids array before dispatch', async () => {
    await dispatchMetaMetrics({ campaign_ids: '["campaign-1","campaign-2"]', timeframe: '14d' });

    expect(mockGetMetaAdsMetrics).toHaveBeenCalledWith(
      '14d',
      'user-1',
      ['campaign-1', 'campaign-2'],
      undefined,
    );
  });

  it('preserves an already-valid bare campaign id string', async () => {
    await dispatchMetaMetrics({ campaign_ids: 'campaign-1' });

    expect(mockGetMetaAdsMetrics).toHaveBeenCalledWith(
      '7d',
      'user-1',
      ['campaign-1'],
      undefined,
    );
  });

  it('preserves an already-valid campaign id array', async () => {
    await dispatchMetaMetrics({ campaign_ids: ['campaign-1', 'campaign-2'] });

    expect(mockGetMetaAdsMetrics).toHaveBeenCalledWith(
      '7d',
      'user-1',
      ['campaign-1', 'campaign-2'],
      undefined,
    );
  });
});
