import { findDuplicateCanonical } from '../services/dedupService';
import * as fb from '../services/featurebaseService';
import { agentModeService } from '../services/agentModeService';

jest.mock('../services/featurebaseService', () => ({
  listOpenPosts: jest.fn(),
}));

const mockListOpenPosts = fb.listOpenPosts as jest.Mock;

function mockJudge(content: string) {
  jest.spyOn(agentModeService, 'getDedupJudgeModel').mockResolvedValue('test-model');
  jest.spyOn(agentModeService, 'callLLM').mockResolvedValue({
    choices: [{ message: { content } }],
  } as any);
}

const CANDS = [
  { id: 'p10', title: 'Add dark mode', description: 'theme toggle', url: 'https://fb/p/dark' },
  { id: 'p11', title: 'Export to PDF', description: 'pdf export', url: 'https://fb/p/pdf' },
];

describe('dedupService.findDuplicateCanonical', () => {
  afterEach(() => jest.restoreAllMocks());

  it('returns null when there are no candidates (creates a new canonical)', async () => {
    mockListOpenPosts.mockResolvedValue([]);
    const m = await findDuplicateCanonical({ type: 'feature_request', title: 'dark mode', description: 'x' });
    expect(m).toBeNull();
  });

  it('returns the matched post when the judge is confident', async () => {
    mockListOpenPosts.mockResolvedValue(CANDS);
    mockJudge(JSON.stringify({ matchedIndex: 1, confidence: 92, reason: 'same feature' }));
    const m = await findDuplicateCanonical({ type: 'feature_request', title: 'please add night mode', description: 'dark theme' });
    expect(m).toEqual({ postId: 'p10', title: 'Add dark mode', url: 'https://fb/p/dark' });
  });

  it('returns null on a low-confidence match (bias to NEW)', async () => {
    mockListOpenPosts.mockResolvedValue(CANDS);
    mockJudge(JSON.stringify({ matchedIndex: 1, confidence: 40, reason: 'maybe' }));
    const m = await findDuplicateCanonical({ type: 'feature_request', title: 'something', description: 'x' });
    expect(m).toBeNull();
  });

  it('returns null when the judge says no match (null index)', async () => {
    mockListOpenPosts.mockResolvedValue(CANDS);
    mockJudge(JSON.stringify({ matchedIndex: null, confidence: 0, reason: 'different' }));
    const m = await findDuplicateCanonical({ type: 'feature_request', title: 'export to CSV', description: 'x' });
    expect(m).toBeNull();
  });

  it('ignores an out-of-range index (guards against hallucination)', async () => {
    mockListOpenPosts.mockResolvedValue(CANDS);
    mockJudge(JSON.stringify({ matchedIndex: 99, confidence: 99, reason: 'hallucinated' }));
    const m = await findDuplicateCanonical({ type: 'feature_request', title: 'x', description: 'y' });
    expect(m).toBeNull();
  });

  it('returns null (never throws) when the judge errors', async () => {
    mockListOpenPosts.mockResolvedValue(CANDS);
    jest.spyOn(agentModeService, 'getDedupJudgeModel').mockResolvedValue('test-model');
    jest.spyOn(agentModeService, 'callLLM').mockRejectedValue(new Error('LLM down'));
    const m = await findDuplicateCanonical({ type: 'feature_request', title: 'x', description: 'y' });
    expect(m).toBeNull();
  });
});
