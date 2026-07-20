/**
 * ENG-383 — you_search_web gains optional `freshness` + `include_domains` params.
 *
 * The retired local-agent Reddit digest is being repointed (data-side) to
 * you_search_web with freshness='week' + include_domains=['reddit.com'].
 * Live You.com API behavior: plain queries return months-old threads, while
 * freshness + include_domains return past-few-days content — so the params must
 * reach the provider request body, and omitting them must leave the current
 * request byte-identical (the provider only serializes present values — see
 * youSearchProvider.test.ts for the body mapping).
 */
const mockSearch = jest.fn();

jest.mock('@slack/web-api', () => ({
  WebClient: jest.fn().mockImplementation(() => ({
    chat: { postMessage: jest.fn() },
    conversations: { info: jest.fn(), list: jest.fn() },
    views: { open: jest.fn() },
  })),
}));

jest.mock('../search/youSearchProvider', () => ({
  YouSearchProvider: jest.fn().mockImplementation(() => ({ search: mockSearch })),
}));

import { AgentModeService } from '../services/agentModeService';
import '../emma/tools';
import { emmaToolRegistry } from '../emma/registry';

describe('youSearchWeb freshness + includeDomains threading (ENG-383)', () => {
  let service: AgentModeService;

  beforeEach(() => {
    mockSearch.mockReset();
    mockSearch.mockResolvedValue({
      provider: 'you',
      query: 'q',
      results: [],
      metadata: {},
    });
    service = new AgentModeService();
  });

  it('passes freshness and includeDomains through to the provider search request', async () => {
    const result = await service.youSearchWeb('reddit discussions about ai agents', 5, 'week', ['reddit.com']);

    expect(result.success).toBe(true);
    expect(mockSearch).toHaveBeenCalledTimes(1);
    expect(mockSearch).toHaveBeenCalledWith(expect.objectContaining({
      query: 'reddit discussions about ai agents',
      count: 5,
      freshness: 'week',
      includeDomains: ['reddit.com'],
      resultSource: 'web',
    }));
  });

  it('omitting the new params keeps the provider request identical to before', async () => {
    await service.youSearchWeb('agentweb pricing page', 5);

    // Exactly the pre-change request: no includeDomains key at all, freshness
    // still driven only by inference (undefined for a timeless query).
    expect(mockSearch).toHaveBeenCalledWith({
      query: 'agentweb pricing page',
      count: 5,
      freshness: undefined,
      resultSource: 'web',
      purpose: 'agent_research',
    });
    expect(mockSearch.mock.calls[0][0]).not.toHaveProperty('includeDomains');
  });

  it('explicit freshness wins over query-based inference', async () => {
    await service.youSearchWeb('latest agent news', 5, 'day');

    expect(mockSearch).toHaveBeenCalledWith(expect.objectContaining({ freshness: 'day' }));
  });

  it('an empty include_domains array is not forwarded (no empty allowlist in the body)', async () => {
    await service.youSearchWeb('agentweb pricing page', 5, undefined, []);

    expect(mockSearch.mock.calls[0][0]).not.toHaveProperty('includeDomains');
  });

  describe('you_search_web tool schema', () => {
    const definition = () => emmaToolRegistry.getTool('you_search_web')?.definition as any;

    it('declares the optional freshness enum param', () => {
      const freshness = definition().inputSchema.properties.freshness;
      expect(freshness).toBeDefined();
      expect(freshness.enum).toEqual(['day', 'week', 'month', 'year']);
      expect(definition().inputSchema.required).toEqual(['query']);
    });

    it('declares the optional include_domains array param', () => {
      const includeDomains = definition().inputSchema.properties.include_domains;
      expect(includeDomains).toBeDefined();
      expect(includeDomains.type).toBe('array');
      expect(includeDomains.items).toEqual({ type: 'string' });
    });

    it('threads tool args through to youSearchWeb', async () => {
      const spy = jest.spyOn(require('../services/agentModeService').agentModeService, 'youSearchWeb')
        .mockResolvedValue({ success: true });

      await emmaToolRegistry.execute(
        'you_search_web',
        { query: 'this week reddit ai agents', max_results: 5, freshness: 'week', include_domains: ['reddit.com'] },
        { userId: 'u1' },
      );

      expect(spy).toHaveBeenCalledWith('this week reddit ai agents', 5, 'week', ['reddit.com']);
      spy.mockRestore();
    });
  });
});
