import { captureVoiceEditOnPublish, voiceCardPromptSuffix } from '../services/voiceProfileHooks';
import { chatbotDb } from '../services/chatbotService';

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    updateSessionVoiceProfile: jest.fn().mockResolvedValue(undefined),
  },
}));

describe('voiceProfileHooks', () => {
  beforeEach(() => jest.clearAllMocks());

  it('persists a voice observation when draft differs from approved', async () => {
    const profile = await captureVoiceEditOnPublish({
      sessionId: 'sess-1',
      platform: 'twitter',
      draftContent: 'Draft hook #old',
      approvedContent: 'Final hook #new',
    });

    expect(profile).not.toBeNull();
    expect(chatbotDb.updateSessionVoiceProfile).toHaveBeenCalledWith(
      'sess-1',
      expect.objectContaining({
        observations: expect.arrayContaining([
          expect.objectContaining({ platform: 'twitter', summary: expect.any(String) }),
        ]),
      }),
    );
  });

  it('skips capture without session id or unchanged text', async () => {
    expect(await captureVoiceEditOnPublish({
      platform: 'twitter',
      draftContent: 'same',
      approvedContent: 'same',
    })).toBeNull();
    expect(chatbotDb.updateSessionVoiceProfile).not.toHaveBeenCalled();
  });

  it('returns formatted prompt suffix from profile', () => {
    expect(voiceCardPromptSuffix(undefined)).toBe('');
    expect(voiceCardPromptSuffix({ observations: [], voiceCard: 'Direct tone.', updatedAt: 'x' }))
      .toMatch(/Author Voice Card/);
  });
});
