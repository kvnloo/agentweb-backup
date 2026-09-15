// ENG-1854: the manual `enqueue_human_eval` Emma tool bypasses enqueueAutoHumanEval's own
// dedup entirely (it calls humanEvalService.createCandidate directly) — so nothing previously
// stopped an auto-trigger and a manual Emma call from both posting the same artifact to
// #eval-queue. Covers the cross-path artifact-URL dedup fix.

jest.mock('../server', () => ({
  io: { to: jest.fn().mockReturnValue({ emit: jest.fn() }), emit: jest.fn() },
  app: {},
}));

jest.mock('../services/humanEvalService', () => ({
  humanEvalService: { createCandidate: jest.fn() },
}));

jest.mock('../services/autoHumanEvalService', () => ({
  enqueueAutoHumanEval: jest.fn().mockResolvedValue(null),
  claimArtifactForHumanEval: jest.fn().mockResolvedValue(true),
}));

import '../emma/tools';
import { emmaToolRegistry } from '../emma/registry';
import { humanEvalService } from '../services/humanEvalService';
import { claimArtifactForHumanEval } from '../services/autoHumanEvalService';

const mockCreateCandidate = humanEvalService.createCandidate as jest.Mock;
const mockClaimArtifact = claimArtifactForHumanEval as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockClaimArtifact.mockResolvedValue(true);
  mockCreateCandidate.mockResolvedValue({
    candidateId: 'candidate-1',
    reviewType: 'creative_image',
    reviewer: 'matt',
    slackChannel: 'C_EVAL',
    slackMessageTs: '178.0',
  });
});

describe('enqueue_human_eval', () => {
  it('claims the artifact and creates a candidate when the artifact was not already claimed', async () => {
    const tool = emmaToolRegistry.getTool('enqueue_human_eval')!;
    const result = await tool.execute(
      {
        review_type: 'creative_image',
        output_summary: 'A new ad creative.',
        artifact_url: 'https://example.com/ad.png',
      },
      { userId: 'user-1', sessionId: 'session-1' },
    );

    expect(mockClaimArtifact).toHaveBeenCalledWith('https://example.com/ad.png');
    expect(mockCreateCandidate).toHaveBeenCalledWith(expect.objectContaining({
      reviewType: 'creative_image',
      artifactUrl: 'https://example.com/ad.png',
      userId: 'user-1',
      sessionId: 'session-1',
    }));
    expect(result.success).toBe(true);
    expect(result.candidateId).toBe('candidate-1');
  });

  it('skips creating a duplicate candidate when the artifact was already claimed (e.g. by an auto-trigger)', async () => {
    mockClaimArtifact.mockResolvedValue(false);
    const tool = emmaToolRegistry.getTool('enqueue_human_eval')!;
    const result = await tool.execute(
      {
        review_type: 'creative_image',
        output_summary: 'The same ad creative, already auto-posted.',
        artifact_url: 'https://example.com/ad.png',
      },
      { userId: 'user-1', sessionId: 'session-1' },
    );

    expect(mockClaimArtifact).toHaveBeenCalledWith('https://example.com/ad.png');
    expect(mockCreateCandidate).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.message).toContain('already sent for human eval');
  });

  it('does not attempt a dedup claim, and proceeds normally, when no artifact_url is given', async () => {
    const tool = emmaToolRegistry.getTool('enqueue_human_eval')!;
    const result = await tool.execute(
      {
        review_type: 'lead_enrichment',
        output_summary: 'Enrichment run summary with no single artifact URL.',
      },
      { userId: 'user-1', sessionId: 'session-1' },
    );

    expect(mockClaimArtifact).not.toHaveBeenCalled();
    expect(mockCreateCandidate).toHaveBeenCalled();
    expect(result.success).toBe(true);
  });
});
