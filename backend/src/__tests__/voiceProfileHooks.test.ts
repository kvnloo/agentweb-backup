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

describe('augmentPublishToolDefinitions', () => {
  it('injects voice card into post tool schema', async () => {
    const { augmentPublishToolDefinitions } = await import('../services/voiceProfileHooks');
    const tools = [{
      type: 'function',
      function: {
        name: 'post_on_connected_account',
        description: 'Post content',
        parameters: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'Body text' },
          },
        },
      },
    }];
    const profile = {
      observations: [],
      voiceCard: 'Direct tone. Short hooks.',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const augmented = augmentPublishToolDefinitions(tools, profile);
    expect(augmented[0].function.description).toMatch(/Voice Card/);
    expect(augmented[0].function.parameters.properties.content.description).toMatch(/Direct tone/);
  });
});
