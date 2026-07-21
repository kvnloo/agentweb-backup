/**
 * ENG-326 — generateImage brand-logo preference + ask-the-user gate.
 *
 * AC-2: image generation for an account with a persisted logo composites
 *       that logo (auto-injected as logoImage when the prompt asks for a
 *       logo and the model didn't pass one).
 * AC-3: when no logo is persisted and the prompt asks for one, the tool
 *       returns an ask-the-user result pointing at brand config instead of
 *       generating with an invented logo.
 */

import { AgentModeService } from '../services/agentModeService';
import * as autoHumanEvalService from '../services/autoHumanEvalService';
import * as imageGeneration from '../services/imageGeneration';

jest.mock('../services/imageGeneration');
jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    addMessageToSession: jest.fn().mockResolvedValue({}),
    addToolCostToSession: jest.fn().mockResolvedValue({}),
  },
}));
jest.mock('../services/db', () => ({
  userDb: { getUserById: jest.fn() },
  orgDb: { getOrgById: jest.fn() },
}));

const { userDb } = require('../services/db');

describe('AgentModeService.generateImage — persisted brand-logo gate (ENG-326)', () => {
  let service: AgentModeService;
  let mockImageService: any;
  let enqueueSpy: jest.SpyInstance;

  const call = (prompt: string, logoImage?: string, inputImages: string[] = []) =>
    (service as any).generateImage(
      prompt,
      'out.png',
      '1024x1024',
      'medium',
      inputImages,
      'user123',
      'session123',
      'gemini-3-pro-image-preview',
      logoImage,
      inputImages.length > 0 ? true : undefined,
    );

  beforeEach(() => {
    jest.clearAllMocks();
    enqueueSpy = jest
      .spyOn(autoHumanEvalService, 'enqueueAutoHumanEval')
      .mockResolvedValue(null as any);
    mockImageService = {
      generateImage: jest.fn().mockResolvedValue({
        success: true,
        imageUrl: 'https://example.com/image.png',
        filename: 'out.png',
      }),
      isAvailable: jest.fn().mockResolvedValue(true),
    };
    (imageGeneration.imageService as any).isAvailable = mockImageService.isAvailable;
    (imageGeneration.imageService as any).generateImage = mockImageService.generateImage;
    service = new AgentModeService();
  });

  afterEach(() => {
    enqueueSpy?.mockRestore();
  });

  it('auto-injects the persisted brand logo when the prompt asks for a logo and none was passed (AC-2)', async () => {
    userDb.getUserById.mockResolvedValue({
      userId: 'user123',
      brandGuidelines: {
        brandData: { logoUrl: 'https://s3.example.com/brand/logo.png' },
      },
    });

    const result = await call('Launch banner with our logo top-left');

    expect(result.success).toBe(true);
    expect(mockImageService.generateImage).toHaveBeenCalledWith(
      expect.objectContaining({
        logoImage: 'https://s3.example.com/brand/logo.png',
      }),
    );
  });

  it('returns the ask-the-user result and does NOT generate when no logo is persisted (AC-3)', async () => {
    userDb.getUserById.mockResolvedValue({
      userId: 'user123',
      brandGuidelines: { brandData: { brandName: 'Acme' } },
    });

    const result = await call('Event cover featuring the company logo');

    expect(result.success).toBe(false);
    expect(result.error).toBe('missing_brand_logo');
    expect(result.askUser).toBe(true);
    expect(result.message).toMatch(/brand guidelines/i);
    expect(mockImageService.generateImage).not.toHaveBeenCalled();
  });

  // NOTE on the next four cases: userDb.getUserById is mocked to return
  // undefined, so if the gate wrongly fired it would resolve "no persisted
  // logo" and return the missing_brand_logo result — success:true +
  // generation therefore proves the gate did NOT fire.

  it('leaves non-logo prompts untouched — no injected logo', async () => {
    const result = await call('A clean product launch graphic');

    expect(result.success).toBe(true);
    expect(result.error).not.toBe('missing_brand_logo');
    expect(mockImageService.generateImage).toHaveBeenCalledWith(
      expect.objectContaining({ logoImage: undefined }),
    );
  });

  it('respects an explicitly passed logo_image without overriding it', async () => {
    const result = await call(
      'Banner with the logo',
      'https://example.com/explicit-logo.png',
    );

    expect(result.success).toBe(true);
    expect(mockImageService.generateImage).toHaveBeenCalledWith(
      expect.objectContaining({
        logoImage: 'https://example.com/explicit-logo.png',
      }),
    );
  });

  it('skips the gate for image edits (inputImages present)', async () => {
    const result = await call('Remove the logo from this image', undefined, [
      'https://example.com/source.png',
    ]);

    expect(result.success).toBe(true);
    expect(mockImageService.generateImage).toHaveBeenCalledWith(
      expect.objectContaining({ logoImage: undefined }),
    );
  });

  it('skips the gate for negated logo mentions ("no logo")', async () => {
    const result = await call('Minimal poster, no logo, just typography');

    expect(result.success).toBe(true);
    expect(mockImageService.generateImage).toHaveBeenCalled();
  });

  // ENG-393: pure text-to-image LOGO CREATION (first logo, no persisted logo,
  // no logo_image, no inputImages) must NOT hit the missing_brand_logo gate.
  // userDb.getUserById returns undefined here → if the gate wrongly fired it
  // would resolve "no persisted logo" and return missing_brand_logo. Success +
  // generation therefore proves the gate did NOT fire for a creation ask.
  it('generates a first logo from scratch instead of gating (ENG-393)', async () => {
    const result = await call('Create a logo for AgentCapX, a modern fintech brand');

    expect(result.success).toBe(true);
    expect(result.error).not.toBe('missing_brand_logo');
    expect(mockImageService.generateImage).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'Create a logo for AgentCapX, a modern fintech brand',
        // No invented brand logo injected on the creation path.
        logoImage: undefined,
      }),
    );
  });

  it('still gates COMPOSITING an existing brand logo when none is persisted (ENG-326 preserved)', async () => {
    userDb.getUserById.mockResolvedValue({
      userId: 'user123',
      brandGuidelines: { brandData: { brandName: 'Acme' } },
    });

    const result = await call('Add our brand logo to this launch banner');

    expect(result.success).toBe(false);
    expect(result.error).toBe('missing_brand_logo');
    expect(mockImageService.generateImage).not.toHaveBeenCalled();
  });

  it('falls back to the attachments logo asset for the injection (canonical store)', async () => {
    userDb.getUserById.mockResolvedValue({
      userId: 'user123',
      brandGuidelines: {
        brandData: { brandName: 'Acme' },
        attachments: [
          { type: 'logo', url: 'https://s3.example.com/att/logo.png', filename: 'logo.png' },
        ],
      },
    });

    const result = await call('Social banner with the brand logo');

    expect(result.success).toBe(true);
    expect(mockImageService.generateImage).toHaveBeenCalledWith(
      expect.objectContaining({
        logoImage: 'https://s3.example.com/att/logo.png',
      }),
    );
  });
});
