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

// ENG-1961: the judge is an LLM call the caller triggered. It used to run with no
// usage context at all, so its spend booked to the `system` placeholder —
// recorded, but charged to nobody.
describe('dedupService.findDuplicate attribution (ENG-1961)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('bills the triggering user and tags the feature', async () => {
    mockJudge(JSON.stringify({ matchedIndex: null, confidence: 0, reason: 'different' }));
    await findDuplicate(
      { type: 'bug', title: 'crash on save', description: 'x' },
      CANDS,
      { userId: 'user-7', sessionId: 'sess-7' },
    );

    const options = (agentModeService.callLLM as jest.Mock).mock.calls[0][2];
    expect(options.usageContext).toEqual({
      userId: 'user-7',
      sessionId: 'sess-7',
      feature: 'intake_dedup',
    });
  });

  it('meters feature-only rather than inventing a user when none is in scope', async () => {
    mockJudge(JSON.stringify({ matchedIndex: null, confidence: 0, reason: 'different' }));
    await findDuplicate({ type: 'bug', title: 'crash', description: 'x' }, CANDS);

    const options = (agentModeService.callLLM as jest.Mock).mock.calls[0][2];
    expect(options.usageContext).toEqual({ feature: 'intake_dedup' });
    expect(options.usageContext.userId).toBeUndefined();
  });
});


// ENG-1335: the judge must compare the substantive ask, not title tokens, and must keep
// adjacent-but-different asks (publish-refusal vs awaiting-user-input) apart.
describe('dedupService.findDuplicate prompt (ENG-1335)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('instructs substantive-ask matching with an explicit over-match guard', async () => {
    mockJudge(JSON.stringify({ matchedIndex: null, confidence: 0 }));
    await findDuplicate({ type: 'bug', title: 'a', description: 'b' }, CANDS);
    const system = (agentModeService.callLLM as jest.Mock).mock.calls[0][1][0].content as string;
    expect(system).toMatch(/substantive ask/);
    expect(system).toMatch(/no distinctive title words/);
    expect(system).toMatch(/DIFFERENT change are NOT a match/);
    expect(system).toMatch(/publish-approval gate/);
  });

  it('keeps an ask that sits past a long preamble (ENG-1334 shape) in the prompt', async () => {
    mockJudge(JSON.stringify({ matchedIndex: null, confidence: 0 }));
    const description = 'REPEAT REQUEST — evidence. '.repeat(30) + 'ASK: score awaiting-user-input sessions neutral';
    expect(description.length).toBeGreaterThan(600);
    await findDuplicate({ type: 'bug', title: 'x', description }, CANDS);
    const user = (agentModeService.callLLM as jest.Mock).mock.calls[0][1][1].content as string;
    expect(user).toContain('ASK: score awaiting-user-input sessions neutral');
  });
});
