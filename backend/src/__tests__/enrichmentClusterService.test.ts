// Cluster service: groups ungrouped fields and persists per-cluster templates.

const mockLLM = jest.fn();
jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    getClientForModel: jest.fn().mockResolvedValue({
      chat: { completions: { create: (...a: any[]) => mockLLM(...a) } },
    }),
  },
}));

jest.mock('../services/db', () => ({
  crmDb: {
    getLeadListById: jest.fn(),
    updateLeadList: jest.fn(),
  },
}));

jest.mock('../services/crmEnrichmentService', () => ({
  CrmEnrichmentService: {
    getEnrichmentConfig: async () => ({
      enrichmentModel: 'gemini-3-flash-preview',
      dataExtractionModel: 'gemini-3-flash-preview',
    }),
  },
}));

import { getOrCreateClustersForFields } from '../services/enrichmentClusterService';
import { crmDb } from '../services/db';
const mockDb = crmDb as jest.Mocked<typeof crmDb>;

beforeEach(() => {
  mockLLM.mockReset();
  mockDb.getLeadListById.mockReset();
  mockDb.updateLeadList.mockReset();
  mockDb.getLeadListById.mockResolvedValue({ listId: 'list1', userId: 'u1' } as any);
  mockDb.updateLeadList.mockResolvedValue(undefined as any);
});

function llmCluster(clusters: any[]) {
  return { choices: [{ message: { content: JSON.stringify(clusters) } }] };
}

// ── Fast paths (no LLM call) ─────────────────────────────────────────────────

describe('getOrCreateClustersForFields — no LLM call paths', () => {
  it('returns empty result for empty input', async () => {
    const r = await getOrCreateClustersForFields('list1', [], {});
    expect(r.clusters).toEqual([]);
    expect(r.newlyCreated).toEqual([]);
    expect(mockLLM).not.toHaveBeenCalled();
  });

  it('reuses persisted cluster when all fields are already covered', async () => {
    mockDb.getLeadListById.mockResolvedValue({
      listId: 'list1', userId: 'u1',
      ungroupedClusters: [
        { fields: ['x', 'y'], searchTemplate: '{{emailDomain}} foo' },
      ],
    } as any);
    const r = await getOrCreateClustersForFields('list1', ['x', 'y'], {});
    expect(r.clusters).toEqual([{ fields: ['x', 'y'], searchTemplate: '{{emailDomain}} foo' }]);
    expect(r.newlyCreated).toEqual([]);
    expect(mockLLM).not.toHaveBeenCalled();
    expect(mockDb.updateLeadList).not.toHaveBeenCalled();
  });

  it('returns only the persisted clusters that contain the input fields', async () => {
    mockDb.getLeadListById.mockResolvedValue({
      listId: 'list1', userId: 'u1',
      ungroupedClusters: [
        { fields: ['a', 'b'], searchTemplate: '{{emailDomain}} ab' },
        { fields: ['c'], searchTemplate: '{{emailDomain}} c' },
      ],
    } as any);
    const r = await getOrCreateClustersForFields('list1', ['a'], {});
    // Only the cluster covering 'a' is returned
    expect(r.clusters).toEqual([{ fields: ['a', 'b'], searchTemplate: '{{emailDomain}} ab' }]);
  });
});

// ── LLM call path ───────────────────────────────────────────────────────────

describe('getOrCreateClustersForFields — LLM clustering', () => {
  it('calls LLM only for uncovered fields, persists, returns combined', async () => {
    mockDb.getLeadListById.mockResolvedValue({
      listId: 'list1', userId: 'u1',
      ungroupedClusters: [{ fields: ['existing'], searchTemplate: '{{emailDomain}} existing' }],
    } as any);
    mockLLM.mockResolvedValueOnce(llmCluster([
      { fields: ['novel_a', 'novel_b'], searchTemplate: '{{firstName}} {{lastName}} {{company}} novel' },
    ]));

    const r = await getOrCreateClustersForFields('list1', ['existing', 'novel_a', 'novel_b'], {
      novel_a: 'description for a',
      novel_b: 'description for b',
    });

    expect(mockLLM).toHaveBeenCalledTimes(1);
    // LLM only got the uncovered fields
    const userMsg = mockLLM.mock.calls[0][0].messages.find((m: any) => m.role === 'user').content;
    expect(userMsg).toContain('novel_a');
    expect(userMsg).toContain('novel_b');
    expect(userMsg).not.toContain('existing');
    // Result has both
    expect(r.clusters).toHaveLength(2);
    expect(r.newlyCreated).toHaveLength(1);
    // Persisted as the union
    expect(mockDb.updateLeadList).toHaveBeenCalledWith('list1', expect.objectContaining({
      ungroupedClusters: expect.arrayContaining([
        { fields: ['existing'], searchTemplate: '{{emailDomain}} existing' },
        { fields: ['novel_a', 'novel_b'], searchTemplate: '{{firstName}} {{lastName}} {{company}} novel' },
      ]),
    }));
  });

  it('passes example lead context to the LLM prompt for grounding', async () => {
    mockLLM.mockResolvedValueOnce(llmCluster([
      { fields: ['x'], searchTemplate: '{{emailDomain}} x' },
    ]));
    await getOrCreateClustersForFields(
      'list1', ['x'], {},
      { company: 'Acme', emailDomain: 'acme.com' },
    );
    const userMsg = mockLLM.mock.calls[0][0].messages.find((m: any) => m.role === 'user').content;
    expect(userMsg).toContain('Acme');
    expect(userMsg).toContain('acme.com');
  });

  it('produces a fallback cluster when LLM fails (graceful degrade)', async () => {
    mockLLM.mockRejectedValueOnce(new Error('rate limit'));
    const r = await getOrCreateClustersForFields('list1', ['x', 'y'], {});
    // Single fallback cluster covering all uncovered fields
    expect(r.clusters).toHaveLength(1);
    expect(r.clusters[0].fields).toEqual(['x', 'y']);
    expect(r.clusters[0].searchTemplate).toContain('{{emailDomain}}');
    expect(r.clusters[0].rationale).toMatch(/fallback/i);
  });

  it('fills in missing fields with fallback when LLM clusters miss some', async () => {
    // LLM only clusters one of the two fields; the other gets a fallback cluster.
    mockLLM.mockResolvedValueOnce(llmCluster([
      { fields: ['x'], searchTemplate: '{{emailDomain}} x' },
    ]));
    const r = await getOrCreateClustersForFields('list1', ['x', 'y'], {});
    expect(r.clusters.length).toBeGreaterThanOrEqual(2);
    const allFields = r.clusters.flatMap(c => c.fields);
    expect(allFields).toContain('x');
    expect(allFields).toContain('y');
    // The fallback for 'y'
    const fallback = r.clusters.find(c => c.fields.includes('y') && !c.fields.includes('x'));
    expect(fallback?.rationale).toMatch(/fallback/i);
  });

  it('rejects malformed LLM output and falls back', async () => {
    mockLLM.mockResolvedValueOnce(llmCluster([
      { fields: 'not-an-array', searchTemplate: 'foo' },     // invalid shape
      { fields: ['ok_field'], searchTemplate: '' },           // empty template
      { fields: ['real'], searchTemplate: '{{emailDomain}} real' }, // valid
    ]));
    const r = await getOrCreateClustersForFields('list1', ['real', 'other'], {});
    // Only the valid cluster is kept; 'other' gets a fallback
    const real = r.clusters.find(c => c.fields.includes('real'));
    expect(real?.searchTemplate).toBe('{{emailDomain}} real');
    const fallback = r.clusters.find(c => c.fields.includes('other'));
    expect(fallback?.rationale).toMatch(/fallback/i);
  });

  it('handles malformed LLM JSON gracefully', async () => {
    mockLLM.mockResolvedValueOnce({ choices: [{ message: { content: 'not json' } }] });
    const r = await getOrCreateClustersForFields('list1', ['x'], {});
    // Fallback cluster
    expect(r.clusters).toHaveLength(1);
    expect(r.clusters[0].fields).toEqual(['x']);
  });

  it('accepts both "[...]" array and "{ clusters: [...] }" wrapper from the LLM', async () => {
    mockLLM.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({
        clusters: [{ fields: ['x'], searchTemplate: '{{emailDomain}} x' }]
      })}}],
    });
    const r = await getOrCreateClustersForFields('list1', ['x'], {});
    const found = r.clusters.find(c => c.fields.includes('x'));
    expect(found?.searchTemplate).toBe('{{emailDomain}} x');
  });
});

// ── Persistence behavior ────────────────────────────────────────────────────

describe('getOrCreateClustersForFields — persistence', () => {
  it('does not write when nothing new was created', async () => {
    mockDb.getLeadListById.mockResolvedValue({
      listId: 'list1', userId: 'u1',
      ungroupedClusters: [{ fields: ['x'], searchTemplate: '{{emailDomain}} x' }],
    } as any);
    await getOrCreateClustersForFields('list1', ['x'], {});
    expect(mockDb.updateLeadList).not.toHaveBeenCalled();
  });

  it('survives a persistence failure (graceful)', async () => {
    mockDb.updateLeadList.mockRejectedValueOnce(new Error('db down'));
    mockLLM.mockResolvedValueOnce(llmCluster([
      { fields: ['x'], searchTemplate: '{{emailDomain}} x' },
    ]));
    const r = await getOrCreateClustersForFields('list1', ['x'], {});
    // Caller still gets the clusters back even though persistence failed
    expect(r.clusters).toHaveLength(1);
  });
});
