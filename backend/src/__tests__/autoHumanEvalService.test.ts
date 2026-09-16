jest.mock('../services/humanEvalService', () => ({
  humanEvalService: {
    createCandidate: jest.fn(),
  },
}));

jest.mock('../services/settingsService', () => ({
  settingsService: {
    getSetting: jest.fn(),
    setSetting: jest.fn(),
    claimSetMember: jest.fn(),
    releaseSetMember: jest.fn(),
  },
}));

import { enqueueAutoHumanEval, claimArtifactForHumanEval, releaseArtifactClaim } from '../services/autoHumanEvalService';
import { humanEvalService } from '../services/humanEvalService';
import { settingsService } from '../services/settingsService';

const mockCreateCandidate = humanEvalService.createCandidate as jest.Mock;
const mockGetSetting = settingsService.getSetting as jest.Mock;
const mockSetSetting = settingsService.setSetting as jest.Mock;
const mockClaimSetMember = settingsService.claimSetMember as jest.Mock;
const mockReleaseSetMember = settingsService.releaseSetMember as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.AUTO_HUMAN_EVAL_DISABLED;
  mockGetSetting.mockResolvedValue(null);
  mockCreateCandidate.mockResolvedValue({
    candidateId: 'candidate-1',
    reviewType: 'creative_image',
  });
  mockSetSetting.mockResolvedValue(undefined);
  mockClaimSetMember.mockResolvedValue(true);
  mockReleaseSetMember.mockResolvedValue(undefined);
});

describe('enqueueAutoHumanEval', () => {
  it('creates a human eval candidate and stores a dedupe marker', async () => {
    const result = await enqueueAutoHumanEval({
      reviewType: 'creative_image',
      userId: 'user-1',
      sessionId: 'session-1',
      artifactUrl: 'https://example.com/image.png',
      originalRequest: 'Make an image',
      outputSummary: 'Image generated: image.png',
      sourceKey: 'image:session-1:image.png',
    });

    expect(result?.candidateId).toBe('candidate-1');
    expect(mockCreateCandidate).toHaveBeenCalledWith(expect.objectContaining({
      reviewType: 'creative_image',
      userId: 'user-1',
      sessionId: 'session-1',
      artifactUrl: 'https://example.com/image.png',
      originalRequest: 'Make an image',
      outputSummary: 'Image generated: image.png',
    }));
    expect(mockSetSetting).toHaveBeenCalledWith(
      expect.stringMatching(/^human_eval_auto_[a-f0-9]{32}$/),
      'candidate-1',
      expect.stringContaining('image:session-1:image.png'),
      'auto-human-eval',
    );
  });

  it('does not enqueue when the source key was already marked', async () => {
    mockGetSetting.mockResolvedValue({ settingValue: 'candidate-1' });

    const result = await enqueueAutoHumanEval({
      reviewType: 'landing_page',
      outputSummary: 'Landing page generated',
      sourceKey: 'landing-page:page-1',
    });

    expect(result).toBeNull();
    expect(mockCreateCandidate).not.toHaveBeenCalled();
    expect(mockSetSetting).not.toHaveBeenCalled();
  });

  it('swallows eval failures so the producer flow can continue', async () => {
    mockCreateCandidate.mockRejectedValue(new Error('Slack unavailable'));

    await expect(enqueueAutoHumanEval({
      reviewType: 'lead_enrichment',
      outputSummary: 'Lead enrichment completed',
      sourceKey: 'lead-enrichment:run-1',
    })).resolves.toBeNull();
  });

  it('passes the flow-derived category through to createCandidate', async () => {
    await enqueueAutoHumanEval({
      reviewType: 'creative_image',
      userId: 'user-1',
      sessionId: 'session-1',
      outputSummary: 'Ad image generated.',
      sourceKey: 'image:session-1:ad.png',
      category: 'ad',
    });

    expect(mockCreateCandidate).toHaveBeenCalledWith(expect.objectContaining({
      reviewType: 'creative_image',
      category: 'ad',
    }));
  });

  it('omits category when the enqueueing flow is ambiguous', async () => {
    await enqueueAutoHumanEval({
      reviewType: 'creative_image',
      userId: 'user-1',
      outputSummary: 'Image generated.',
      sourceKey: 'image:session-2:img.png',
    });

    expect(mockCreateCandidate).toHaveBeenCalledWith(expect.objectContaining({
      category: undefined,
    }));
  });

  // ENG-1854: cross-path dedup — the sourceKey dedup above only catches THIS function
  // re-firing on its own retries. It does nothing when a manual Emma tool call (which
  // bypasses enqueueAutoHumanEval entirely) posts the same artifact separately.
  it('does not enqueue when the artifact URL was already claimed by a different path', async () => {
    // sourceKey dedup passes (nothing marked yet), but the artifact-claim check finds it
    // already claimed.
    mockClaimSetMember.mockResolvedValue(false);

    const result = await enqueueAutoHumanEval({
      reviewType: 'creative_image',
      userId: 'user-1',
      sessionId: 'session-1',
      artifactUrl: 'https://example.com/already-claimed.png',
      outputSummary: 'Image generated.',
      sourceKey: 'image:session-1:already-claimed.png',
    });

    expect(result).toBeNull();
    expect(mockCreateCandidate).not.toHaveBeenCalled();
  });

  // Round-3 review finding: the claim used to be won BEFORE createCandidate ran and never
  // released on failure — a transient createCandidate error would permanently blackhole that
  // artifact from ever being sent again, exactly the "silently dropped" failure mode this PR
  // exists to eliminate. This proves the release actually happens.
  it('releases the artifact claim when createCandidate fails after the claim was won, so a retry can claim it again', async () => {
    mockCreateCandidate.mockRejectedValue(new Error('DynamoDB PutItem transiently failed'));

    const result = await enqueueAutoHumanEval({
      reviewType: 'creative_image',
      userId: 'user-1',
      artifactUrl: 'https://example.com/flaky-create.png',
      outputSummary: 'Image generated.',
      sourceKey: 'image:session-1:flaky-create.png',
    });

    expect(result).toBeNull();
    expect(mockReleaseSetMember).toHaveBeenCalledWith(
      expect.stringMatching(/^human_eval_artifact_claims_\d{4}-\d{2}$/),
      'https://example.com/flaky-create.png',
    );
  });

  it('does not attempt to release a claim that was never won (no artifactUrl given at all)', async () => {
    mockCreateCandidate.mockRejectedValue(new Error('DynamoDB PutItem transiently failed'));

    await enqueueAutoHumanEval({
      reviewType: 'lead_enrichment',
      outputSummary: 'Enrichment run, no single artifact URL.',
      sourceKey: 'lead-enrichment:run-1',
    });

    expect(mockReleaseSetMember).not.toHaveBeenCalled();
  });

  // Round-4 review finding: the sourceKey dedupe-marker write happens AFTER createCandidate
  // already succeeded — a failure there is housekeeping, not a real failure. It must not
  // release an artifact claim that a real candidate already legitimately consumed (that would
  // reopen the exact cross-path duplicate window this claim exists to close), and the
  // already-created candidate must still be returned to the caller.
  it('does not release the artifact claim, and still returns the candidate, when the dedupe-marker write fails after createCandidate already succeeded', async () => {
    mockSetSetting.mockRejectedValue(new Error('DynamoDB PutItem transiently failed'));

    const result = await enqueueAutoHumanEval({
      reviewType: 'creative_image',
      userId: 'user-1',
      artifactUrl: 'https://example.com/marker-write-fails.png',
      outputSummary: 'Image generated.',
      sourceKey: 'image:session-1:marker-write-fails.png',
    });

    expect(result?.candidateId).toBe('candidate-1');
    expect(mockReleaseSetMember).not.toHaveBeenCalled();
  });
});

describe('claimArtifactForHumanEval', () => {
  it('claims a not-yet-seen artifact URL via an atomic claimSetMember call, and returns true', async () => {
    const claimed = await claimArtifactForHumanEval('https://example.com/new.png');

    expect(claimed).toBe(true);
    expect(mockClaimSetMember).toHaveBeenCalledWith(
      expect.stringMatching(/^human_eval_artifact_claims_\d{4}-\d{2}$/),
      'https://example.com/new.png',
    );
  });

  it('returns false for an artifact URL already claimed', async () => {
    mockClaimSetMember.mockResolvedValue(false);

    const claimed = await claimArtifactForHumanEval('https://example.com/dup.png');

    expect(claimed).toBe(false);
  });

  it('has nothing to dedupe against when no artifact URL is given, so returns true without touching settings', async () => {
    const claimed = await claimArtifactForHumanEval(undefined);

    expect(claimed).toBe(true);
    expect(mockClaimSetMember).not.toHaveBeenCalled();
  });

  it('fails open (returns true) rather than blocking a real candidate when claimSetMember itself throws', async () => {
    mockClaimSetMember.mockRejectedValue(new Error('DynamoDB transiently failed'));

    const claimed = await claimArtifactForHumanEval('https://example.com/flaky-settings.png');

    expect(claimed).toBe(true);
  });
});

describe('releaseArtifactClaim', () => {
  it('releases a previously-claimed artifact URL', async () => {
    await releaseArtifactClaim('https://example.com/release-me.png');

    expect(mockReleaseSetMember).toHaveBeenCalledWith(
      expect.stringMatching(/^human_eval_artifact_claims_\d{4}-\d{2}$/),
      'https://example.com/release-me.png',
    );
  });

  it('does nothing when no artifact URL is given', async () => {
    await releaseArtifactClaim(undefined);

    expect(mockReleaseSetMember).not.toHaveBeenCalled();
  });

  it('does not throw when the release itself fails (non-fatal, best-effort)', async () => {
    mockReleaseSetMember.mockRejectedValue(new Error('DynamoDB transiently failed'));

    await expect(releaseArtifactClaim('https://example.com/flaky-release.png')).resolves.toBeUndefined();
  });
});
