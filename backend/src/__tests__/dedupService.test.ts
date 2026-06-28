import { findDuplicateCanonical } from '../services/dedupService';
import * as linearService from '../services/linearService';
import { agentModeService } from '../services/agentModeService';

jest.mock('../services/linearService', () => ({
  listOpenCanonicals: jest.fn(),
}));

const mockListOpenCanonicals = linearService.listOpenCanonicals as jest.Mock;

function mockJudge(content: string) {
  jest.spyOn(agentModeService, 'getDedupJudgeModel').mockResolvedValue('test-model');
  jest.spyOn(agentModeService, 'callLLM').mockResolvedValue({
    choices: [{ message: { content } }],
  } as any);
}

const CANDS = [
  { identifier: 'ENG-10', issueId: 'uuid-10', title: 'Add dark mode', description: 'theme toggle', featurebasePostUrl: 'https://fb/p/dark' },
  { identifier: 'ENG-11', issueId: 'uuid-11', title: 'Export to PDF', description: 'pdf export', featurebasePostUrl: 'https://fb/p/pdf' },
];

describe('dedupService.findDuplicateCanonical', () => {
  afterEach(() => jest.restoreAllMocks());

  it('returns null when there are no candidates (creates a new canonical)', async () => {
    mockListOpenCanonicals.mockResolvedValue([]);
    const m = await findDuplicateCanonical({ type: 'feature_request', title: 'dark mode', description: 'x' });
    expect(m).toBeNull();
  });

  it('returns the matched canonical when the judge is confident', async () => {
    mockListOpenCanonicals.mockResolvedValue(CANDS);
    mockJudge(JSON.stringify({ matchedIdentifier: 'ENG-10', confidence: 92, reason: 'same feature' }));
    const m = await findDuplicateCanonical({ type: 'feature_request', title: 'please add night mode', description: 'dark theme' });
    expect(m).toEqual({ identifier: 'ENG-10', issueId: 'uuid-10', title: 'Add dark mode', featurebasePostUrl: 'https://fb/p/dark' });
  });

  it('returns null on a low-confidence match (bias to NEW)', async () => {
    mockListOpenCanonicals.mockResolvedValue(CANDS);
    mockJudge(JSON.stringify({ matchedIdentifier: 'ENG-10', confidence: 40, reason: 'maybe' }));
    const m = await findDuplicateCanonical({ type: 'feature_request', title: 'something', description: 'x' });
    expect(m).toBeNull();
  });

  it('returns null when the judge says no match', async () => {
    mockListOpenCanonicals.mockResolvedValue(CANDS);
    mockJudge(JSON.stringify({ matchedIdentifier: null, confidence: 0, reason: 'different' }));
    const m = await findDuplicateCanonical({ type: 'feature_request', title: 'export to CSV', description: 'x' });
    expect(m).toBeNull();
  });

  it('ignores a hallucinated identifier not in the candidate set', async () => {
    mockListOpenCanonicals.mockResolvedValue(CANDS);
    mockJudge(JSON.stringify({ matchedIdentifier: 'ENG-999', confidence: 99, reason: 'hallucinated' }));
    const m = await findDuplicateCanonical({ type: 'feature_request', title: 'x', description: 'y' });
    expect(m).toBeNull();
  });

  it('passes the type through to listOpenCanonicals (type-scoping)', async () => {
    mockListOpenCanonicals.mockResolvedValue([]);
    await findDuplicateCanonical({ type: 'bug', title: 'crash', description: 'x' });
    expect(mockListOpenCanonicals).toHaveBeenCalledWith('bug', expect.any(Number));
  });

  it('returns null (never throws) when the judge errors', async () => {
    mockListOpenCanonicals.mockResolvedValue(CANDS);
    jest.spyOn(agentModeService, 'getDedupJudgeModel').mockResolvedValue('test-model');
    jest.spyOn(agentModeService, 'callLLM').mockRejectedValue(new Error('LLM down'));
    const m = await findDuplicateCanonical({ type: 'feature_request', title: 'x', description: 'y' });
    expect(m).toBeNull();
  });
});
