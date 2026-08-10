// Human-in-the-loop gate for image EDITING (generate_image with inputImages).
// Editing the wrong source images is the wrong-set mistake from the satisfaction
// incident. Before editing existing images the tool must surface the source
// image(s) (as markdown thumbnails) and wait for explicit user approval.

jest.mock('../mcp/client/mcpClientService', () => ({
  McpClientService: jest.fn().mockImplementation(() => ({
    isReady: jest.fn().mockReturnValue(true)
  }))
}));

// imageService is dynamically imported inside generateImage — jest.mock still intercepts.
const mockGenerateImage = jest.fn();
jest.mock('../services/imageGeneration', () => ({
  imageService: {
    isAvailable: jest.fn().mockResolvedValue(true),
    generateImage: (...args: any[]) => mockGenerateImage(...args)
  }
}));

jest.mock('../services/db', () => ({ userDb: { getUserById: jest.fn() } }));
jest.mock('../utils/secretsManager', () => ({ getMetaAccessToken: jest.fn() }));

import { AgentModeService } from '../services/agentModeService';

// signature: generateImage(prompt, filename, size, quality, inputImages, userId, sessionId, imageModel?, logoImage?, confirm?)
const genImage = (
  service: AgentModeService,
  opts: { inputImages?: string[]; confirm?: boolean } = {}
) =>
  (service as any).generateImage(
    'make it pop',
    'maintenance-ad-1.png',
    '1024x1024',
    'medium',
    opts.inputImages ?? [],
    'user123',
    'session1',
    'gemini-3-pro-image-preview',
    undefined,
    opts.confirm
  , 'ad');

describe('AgentModeService - generateImage edit-confirmation gate', () => {
  let service: AgentModeService;

  beforeEach(() => {
    service = new AgentModeService();
    jest.clearAllMocks();
    mockGenerateImage.mockResolvedValue({ success: false, message: 'stub — not asserted' });
  });

  it('blocks an image EDIT (inputImages present) without confirm and does not generate', async () => {
    const result = await genImage(service, {
      inputImages: ['https://cdn.example.com/maint-a.png', 'https://cdn.example.com/maint-b.png']
    });

    expect(result.requiresConfirmation).toBe(true);
    expect(result.awaitingUserConfirmation).toBe(true);
    expect(mockGenerateImage).not.toHaveBeenCalled();
    // Source images are embedded as markdown so the chat renders them as thumbnails.
    expect(result.confirmationPrompt).toContain('![source image 1](https://cdn.example.com/maint-a.png)');
    expect(result.confirmationPrompt).toContain('![source image 2](https://cdn.example.com/maint-b.png)');
    expect(result.confirmationPrompt).toContain('maintenance-ad-1.png');
    // Model-facing resume instruction must tell the model to re-call with confirm=true.
    expect(result.message).toContain('confirm=true');
  });

  it('proceeds with the edit when confirm=true (gate bypassed)', async () => {
    const result = await genImage(service, {
      inputImages: ['https://cdn.example.com/maint-a.png'],
      confirm: true
    });

    expect(result.awaitingUserConfirmation).toBeUndefined();
    expect(mockGenerateImage).toHaveBeenCalledTimes(1);
    // confirm must not leak into the image service call args.
    expect(JSON.stringify(mockGenerateImage.mock.calls[0][0])).not.toContain('confirm');
  });

  it('does NOT gate text-to-image (no inputImages) — fresh generation runs immediately', async () => {
    const result = await genImage(service, { inputImages: [] });

    expect(result.awaitingUserConfirmation).toBeUndefined();
    expect(mockGenerateImage).toHaveBeenCalledTimes(1);
  });
});
