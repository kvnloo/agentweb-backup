import { findDuplicate, DedupCandidate } from '../services/dedupService';
import { agentModeService } from '../services/agentModeService';

function mockJudge(content: string) {
  jest.spyOn(agentModeService, 'getDedupJudgeModel').mockResolvedValue('test-model');
  jest.spyOn(agentModeService, 'callLLM').mockResolvedValue({
    choices: [{ message: { content } }],
  } as any);
}

const CANDS: DedupCandidate[] = [
  { ref: 'p10', title: 'Add dark mode', description: 'theme toggle' },
  { ref: 'p11', title: 'Export to PDF', description: 'pdf export' },
];

describe('dedupService.findDuplicate', () => {
  afterEach(() => jest.restoreAllMocks());

  it('returns null when there are no candidates (creates a new canonical)', async () => {
    const m = await findDuplicate({ type: 'feature_request', title: 'dark mode', description: 'x' }, []);
    expect(m).toBeNull();
  });

  it('returns the matched candidate when the judge is confident', async () => {
    mockJudge(JSON.stringify({ matchedIndex: 1, confidence: 92, reason: 'same feature' }));
    const m = await findDuplicate({ type: 'feature_request', title: 'please add night mode', description: 'dark theme' }, CANDS);
    expect(m).toEqual({ ref: 'p10', title: 'Add dark mode', description: 'theme toggle' });
  });

  it('returns null on a low-confidence match (bias to NEW)', async () => {
    mockJudge(JSON.stringify({ matchedIndex: 1, confidence: 40, reason: 'maybe' }));
    expect(await findDuplicate({ type: 'feature_request', title: 's', description: 'x' }, CANDS)).toBeNull();
  });

  it('returns null when the judge says no match (null index)', async () => {
    mockJudge(JSON.stringify({ matchedIndex: null, confidence: 0, reason: 'different' }));
    expect(await findDuplicate({ type: 'feature_request', title: 'export to CSV', description: 'x' }, CANDS)).toBeNull();
  });

  it('ignores an out-of-range index (guards against hallucination)', async () => {
    mockJudge(JSON.stringify({ matchedIndex: 99, confidence: 99, reason: 'hallucinated' }));
    expect(await findDuplicate({ type: 'feature_request', title: 'x', description: 'y' }, CANDS)).toBeNull();
  });

  it('returns null (never throws) when the judge errors', async () => {
    jest.spyOn(agentModeService, 'getDedupJudgeModel').mockResolvedValue('test-model');
    jest.spyOn(agentModeService, 'callLLM').mockRejectedValue(new Error('LLM down'));
    expect(await findDuplicate({ type: 'bug', title: 'x', description: 'y' }, CANDS)).toBeNull();
  });
});
