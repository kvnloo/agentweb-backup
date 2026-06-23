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

import { enqueueAutoHumanEval } from '../services/autoHumanEvalService';
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
});
