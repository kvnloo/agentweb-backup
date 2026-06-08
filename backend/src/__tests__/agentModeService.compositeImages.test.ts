// Unit tests for the composite_images handler in agentModeService — the
// deterministic exact-count compositing path. The handler delegates to
// imageService.compositeImages and records a session message on success.

import { AgentModeService } from '../services/agentModeService';
import * as imageGeneration from '../services/imageGeneration';

jest.mock('../services/imageGeneration');
jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    addMessageToSession: jest.fn().mockResolvedValue({}),
    addToolCostToSession: jest.fn().mockResolvedValue({}),
  },
}));

const { chatbotDb } = require('../services/chatbotService');

describe('AgentModeService - composite_images handler', () => {
  let agentModeService: AgentModeService;
  let mockCompositeImages: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockCompositeImages = jest.fn();
    (imageGeneration.imageService as any).compositeImages = mockCompositeImages;
    agentModeService = new AgentModeService();
  });

  it('delegates to imageService.compositeImages with mapped options', async () => {
    mockCompositeImages.mockResolvedValue({
      success: true,
      imageUrl: 'https://s3/out.png',
      filename: 'avatars.png',
    });

    const images = ['https://img/1.png', 'https://img/2.png', 'https://img/3.png'];
    const result = await (agentModeService as any).compositeImages(
      images,
      'avatars.png',
      'user123',
      'session123',
      { layout: 'honeycomb', shape: 'circle', columns: 3, cellSize: 200, gap: 8, background: '#fff' }
    );

    expect(mockCompositeImages).toHaveBeenCalledWith({
      images,
      filename: 'avatars.png',
      userId: 'user123',
      layout: 'honeycomb',
      shape: 'circle',
      columns: 3,
      cellSize: 200,
      gap: 8,
      background: '#fff',
    });
    expect(result.success).toBe(true);
    expect(result.imageUrl).toBe('https://s3/out.png');
    expect(result.imageCount).toBe(3);
  });

  it('records a session message on success', async () => {
    mockCompositeImages.mockResolvedValue({
      success: true,
      imageUrl: 'https://s3/out.png',
      filename: 'grid.png',
    });

    await (agentModeService as any).compositeImages(
      ['https://img/1.png', 'https://img/2.png'],
      'grid.png',
      'user123',
      'session123'
    );

    expect(chatbotDb.addMessageToSession).toHaveBeenCalledWith(
      'session123',
      expect.objectContaining({
        role: 'system',
        content: expect.stringContaining('Composite image created: grid.png'),
      })
    );
  });

  it('still succeeds when the session-message write throws', async () => {
    mockCompositeImages.mockResolvedValue({
      success: true,
      imageUrl: 'https://s3/out.png',
      filename: 'grid.png',
    });
    chatbotDb.addMessageToSession.mockRejectedValueOnce(new Error('db down'));

    const result = await (agentModeService as any).compositeImages(
      ['https://img/1.png'],
      'grid.png',
      'user123',
      'session123'
    );

    expect(result.success).toBe(true);
  });

  it('propagates a failure result from imageService', async () => {
    mockCompositeImages.mockResolvedValue({ success: false, error: 'Too many images: 51. Maximum is 50.' });

    const result = await (agentModeService as any).compositeImages(
      ['https://img/1.png'],
      'grid.png',
      'user123',
      'session123'
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Too many images/);
  });

  it('handles a thrown exception from imageService', async () => {
    mockCompositeImages.mockRejectedValue(new Error('boom'));

    const result = await (agentModeService as any).compositeImages(
      ['https://img/1.png'],
      'grid.png',
      'user123',
      'session123'
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('boom');
  });
});
