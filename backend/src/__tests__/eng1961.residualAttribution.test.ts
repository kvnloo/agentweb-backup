/**
 * ENG-1961 — the LLM/image paths ENG-1858 left booking to the `system`
 * placeholder.
 *
 * Two shapes are covered here, because they fail differently:
 *
 *  - a **user-triggered** path that simply never carried identity, which must
 *    now charge whoever triggered it (`inlineEmailStyles`);
 *  - a **platform-funded** path whose `userId` slot held a non-user string —
 *    `'workplans'`, which is really an S3 folder — and which must now book no
 *    user under a named `platform:` feature, while keeping that folder
 *    (workplan thumbnails).
 *
 * The dedup judge, the only production `callLLM` that passed no context at all,
 * is covered in `dedupService.test.ts` beside its own behaviour.
 */

const mockGenerateImage = jest.fn();
jest.mock('../services/imageGeneration', () => ({
  ImageService: jest.fn().mockImplementation(() => ({
    generateImage: (...a: any[]) => mockGenerateImage(...a),
  })),
}));

const mockGenerateHTML = jest.fn();
jest.mock('../utils/llmService', () => ({
  LLMService: jest.fn().mockImplementation(() => ({
    generateHTML: (...a: any[]) => mockGenerateHTML(...a),
  })),
}));

import { inlineEmailStyles } from '../utils/emailVariables';

// Only HTML with class-based styles reaches the LLM at all.
const CLASSY_HTML = `<html><head><style>.btn{color:#fff}</style></head><body><a class="btn">Go</a></body></html>`;

describe('inlineEmailStyles attribution (ENG-1961)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGenerateHTML.mockResolvedValue(
      `<html><body><a style="color:#fff">Go</a>${'x'.repeat(CLASSY_HTML.length)}</body></html>`,
    );
  });

  it('charges the importing user', async () => {
    await inlineEmailStyles(CLASSY_HTML, { userId: 'user-9' });

    expect(mockGenerateHTML).toHaveBeenCalledTimes(1);
    expect(mockGenerateHTML.mock.calls[0][3]).toEqual({ userId: 'user-9', feature: 'content_gen' });
  });

  it('meters feature-only when no user is in scope, inventing none', async () => {
    await inlineEmailStyles(CLASSY_HTML);

    expect(mockGenerateHTML.mock.calls[0][3]).toEqual({ feature: 'content_gen' });
  });

  it('does not call the LLM at all when the HTML needs no inlining', async () => {
    await inlineEmailStyles('<html><body><a style="color:#fff">Go</a></body></html>', { userId: 'user-9' });
    expect(mockGenerateHTML).not.toHaveBeenCalled();
  });
});

describe('workplan thumbnail attribution (ENG-1961)', () => {
  it('books no user under a named platform feature, and keeps its S3 folder', async () => {
    jest.clearAllMocks();
    mockGenerateImage.mockResolvedValue({ success: false, error: 'stop after the metering decision' });

    const { WorkPlanThumbnailService } = require('../services/workPlanThumbnailService');
    const svc = new WorkPlanThumbnailService();
    await svc.generateAIThumbnailDetailed(
      { planId: 'plan-1', title: 'A plan', description: 'does things', steps: [] } as any,
    );

    expect(mockGenerateImage).toHaveBeenCalledTimes(1);
    const params = mockGenerateImage.mock.calls[0][0];
    // The charge: nobody, named — not a customer, and not anonymous either.
    expect(params.meterUserId).toBeNull();
    expect(params.meterFeature).toBe('platform:workplan_thumbnail');
    // The S3 folder is unchanged, which is the whole reason the two had to split:
    // `userId` here has always been a bucket path, never an account.
    expect(params.userId).toBe('workplans');
  });
});
