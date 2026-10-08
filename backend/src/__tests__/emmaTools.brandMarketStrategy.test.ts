/**
 * ENG-2103 F2 — proves emma/tools.ts's 5 brand-guidelines/market-strategy
 * tool execute() bodies call emma/impl/brandMarketStrategy.ts directly (not
 * agentModeService.<method>) and forward args unchanged. Same pattern as
 * emmaTools.leads.test.ts / emmaTools.htmlTools.test.ts.
 */

jest.mock('../emma/impl/brandMarketStrategy', () => ({
  readBrandGuidelines: jest.fn(),
  updateBrandGuidelines: jest.fn(),
  readMarketStrategy: jest.fn(),
  updateMarketStrategy: jest.fn(),
  regenerateMarketStrategy: jest.fn(),
}));

const BRAND_MARKET_STRATEGY_CLUSTER_METHODS = [
  'readBrandGuidelines', 'updateBrandGuidelines', 'readMarketStrategy',
  'updateMarketStrategy', 'regenerateMarketStrategy',
];

// agentModeService.<brandMarketStrategyClusterMethod> must NOT be called by
// these 5 tools anymore. Other agentModeService methods are untouched by this
// cluster, so the proxy below only throws for the 5 names this cluster owns.
jest.mock('../services/agentModeService', () => ({
  agentModeService: new Proxy(
    {},
    {
      get(_target, prop) {
        if (BRAND_MARKET_STRATEGY_CLUSTER_METHODS.includes(String(prop))) {
          return () => {
            throw new Error(`agentModeService.${String(prop)} should not be called by the brand/market-strategy cluster after ENG-2103 F2`);
          };
        }
        return jest.fn().mockResolvedValue({ success: true });
      },
    }
  ),
}));

import { emmaToolRegistry } from '../emma/registry';
import * as brandMarketStrategyImpl from '../emma/impl/brandMarketStrategy';
import '../emma/tools';

const mockBrandMarketStrategy = brandMarketStrategyImpl as jest.Mocked<typeof brandMarketStrategyImpl>;

describe('brand/market-strategy cluster delegates to emma/impl/brandMarketStrategy.ts (ENG-2103 F2)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('read_brand_guidelines forwards userId and returns the result unchanged', async () => {
    const expected = { success: true, exists: true };
    mockBrandMarketStrategy.readBrandGuidelines.mockResolvedValue(expected);

    const result = await emmaToolRegistry.getTool('read_brand_guidelines')!.execute({}, { userId: 'u1' });

    expect(mockBrandMarketStrategy.readBrandGuidelines).toHaveBeenCalledWith('u1');
    expect(result).toBe(expected);
  });

  it('update_brand_guidelines forwards args, userId and the calling sessionId, and returns the result unchanged', async () => {
    const expected = { success: true, updatedFields: ['brandData'] };
    mockBrandMarketStrategy.updateBrandGuidelines.mockResolvedValue(expected);
    const args = { brandData: { brandName: 'Acme' }, refreshMarketStrategy: true };

    const result = await emmaToolRegistry
      .getTool('update_brand_guidelines')!
      .execute(args, { userId: 'u1', sessionId: 's1' });

    // The session id lets the brand-build `ready` flip complete only the
    // claim its session was started under (ENG-2308).
    expect(mockBrandMarketStrategy.updateBrandGuidelines).toHaveBeenCalledWith(args, 'u1', {
      sessionId: 's1',
    });
    expect(result).toBe(expected);
  });

  it('read_market_strategy forwards userId and only competitorOffset/competitorNames from args', async () => {
    const expected = { success: true, exists: true };
    mockBrandMarketStrategy.readMarketStrategy.mockResolvedValue(expected);

    const result = await emmaToolRegistry.getTool('read_market_strategy')!.execute(
      { competitorOffset: 40, competitorNames: ['Acme Corp'] },
      { userId: 'u1' }
    );

    expect(mockBrandMarketStrategy.readMarketStrategy).toHaveBeenCalledWith('u1', {
      competitorOffset: 40,
      competitorNames: ['Acme Corp'],
    });
    expect(result).toBe(expected);
  });

  it('update_market_strategy forwards args and userId, and returns the result unchanged', async () => {
    const expected = { success: true, totalCompetitors: 3 };
    mockBrandMarketStrategy.updateMarketStrategy.mockResolvedValue(expected);
    const args = { businessOverview: 'We sell widgets.' };

    const result = await emmaToolRegistry
      .getTool('update_market_strategy')!
      .execute(args, { userId: 'u1', sessionId: 's1' });

    // The session id lets a superseded brand-build session be refused (ENG-2308).
    expect(mockBrandMarketStrategy.updateMarketStrategy).toHaveBeenCalledWith(args, 'u1', {
      sessionId: 's1',
    });
    expect(result).toBe(expected);
  });

  it('regenerate_market_strategy forwards userId and returns the result unchanged', async () => {
    const expected = { success: true, replaced: { competitors: 2, icps: 1 } };
    mockBrandMarketStrategy.regenerateMarketStrategy.mockResolvedValue(expected);

    const result = await emmaToolRegistry
      .getTool('regenerate_market_strategy')!
      .execute({}, { userId: 'u1', sessionId: 's1' });

    // The session id lets a superseded brand-build session be refused (ENG-2308).
    expect(mockBrandMarketStrategy.regenerateMarketStrategy).toHaveBeenCalledWith('u1', {}, {
      sessionId: 's1',
    });
    expect(result).toBe(expected);
  });
});
