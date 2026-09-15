jest.mock('../services/humanEvalService', () => ({
  humanEvalService: {
    createCandidate: jest.fn(),
  },
}));

jest.mock('../services/settingsService', () => ({
  settingsService: {
    getSetting: jest.fn(),
    setSetting: jest.fn(),
  },
}));

import { enqueueAutoHumanEval, claimArtifactForHumanEval } from '../services/autoHumanEvalService';
import { humanEvalService } from '../services/humanEvalService';
import { settingsService } from '../services/settingsService';

const mockCreateCandidate = humanEvalService.createCandidate as jest.Mock;
const mockGetSetting = settingsService.getSetting as jest.Mock;
const mockSetSetting = settingsService.setSetting as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.AUTO_HUMAN_EVAL_DISABLED;
  mockGetSetting.mockResolvedValue(null);
  mockCreateCandidate.mockResolvedValue({
    candidateId: 'candidate-1',
    reviewType: 'creative_image',
  });
  mockSetSetting.mockResolvedValue(undefined);
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
    mockGetSetting.mockImplementation(async (key: string) =>
      key.startsWith('human_eval_artifact_') ? { settingValue: 'claimed' } : null);

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
});

describe('claimArtifactForHumanEval', () => {
  it('claims a not-yet-seen artifact URL and returns true', async () => {
    const claimed = await claimArtifactForHumanEval('https://example.com/new.png');

    expect(claimed).toBe(true);
    expect(mockSetSetting).toHaveBeenCalledWith(
      expect.stringMatching(/^human_eval_artifact_[a-f0-9]{32}$/),
      'claimed',
      expect.stringContaining('https://example.com/new.png'),
      'auto-human-eval',
    );
  });

  it('returns false for an artifact URL already claimed', async () => {
    mockGetSetting.mockResolvedValue({ settingValue: 'claimed' });

    const claimed = await claimArtifactForHumanEval('https://example.com/dup.png');

    expect(claimed).toBe(false);
    expect(mockSetSetting).not.toHaveBeenCalled();
  });

  it('has nothing to dedupe against when no artifact URL is given, so returns true without touching settings', async () => {
    const claimed = await claimArtifactForHumanEval(undefined);

    expect(claimed).toBe(true);
    expect(mockGetSetting).not.toHaveBeenCalled();
    expect(mockSetSetting).not.toHaveBeenCalled();
  });

  it('fails open (returns true) rather than blocking a real candidate when the settings lookup itself throws', async () => {
    mockGetSetting.mockRejectedValue(new Error('DynamoDB GetItem transiently failed'));

    const claimed = await claimArtifactForHumanEval('https://example.com/flaky-settings.png');

    expect(claimed).toBe(true);
  });
});
