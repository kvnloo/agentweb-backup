import request from 'supertest';

describe('Admin WorkPlan Thumbnail Endpoints', () => {
  let app: any;
  let mockGetWorkPlan: jest.Mock;
  let mockUpdateWorkPlan: jest.Mock;
  let mockGenerateAIThumbnail: jest.Mock;
  let mockGenerateAIThumbnailDetailed: jest.Mock;
  let mockUploadCustomThumbnail: jest.Mock;
  let mockRemoveThumbnail: jest.Mock;
  let mockSharpMetadata: jest.Mock;

  const mockPlan = {
    planId: 'plan-123',
    title: 'Test Plan',
    description: 'A test plan',
    steps: [{ stepCount: 1, title: 'Step 1' }],
    visibility: 'system',
    isBuiltIn: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  const mockPlanWithThumbnail = {
    ...mockPlan,
    thumbnail_url: 'https://s3.amazonaws.com/bucket/workplans/plan-123/thumbnail-abc123.png',
    thumbnail_source: 'ai',
    thumbnail_alt_text: 'Thumbnail for Test Plan',
  };

  beforeAll(() => {
    jest.resetModules();

    mockGetWorkPlan = jest.fn();
    mockUpdateWorkPlan = jest.fn();
    mockGenerateAIThumbnail = jest.fn();
    mockGenerateAIThumbnailDetailed = jest.fn();
    mockUploadCustomThumbnail = jest.fn();
    mockRemoveThumbnail = jest.fn();
    mockSharpMetadata = jest.fn();

    jest.doMock('../services/workPlanService', () => ({
      workPlanService: {
        getWorkPlan: mockGetWorkPlan,
        updateWorkPlan: mockUpdateWorkPlan,
        getAllWorkPlans: jest.fn(),
        createWorkPlan: jest.fn(),
      },
    }));

    jest.doMock('../services/workPlanThumbnailService', () => ({
      workPlanThumbnailService: {
        generateAIThumbnail: mockGenerateAIThumbnail,
        generateAIThumbnailDetailed: mockGenerateAIThumbnailDetailed,
        uploadCustomThumbnail: mockUploadCustomThumbnail,
        removeThumbnail: mockRemoveThumbnail,
      },
    }));

    jest.doMock('sharp', () => {
      const sharpFn = jest.fn(() => ({
        metadata: mockSharpMetadata,
      }));
      return sharpFn;
    });

    jest.doMock('../middleware/auth', () => ({
      authenticateToken: (_req: any, _res: any, next: any) => next(),
    }));
    jest.doMock('../middleware/admin', () => ({
      isAdmin: (_req: any, _res: any, next: any) => next(),
    }));

    // Build express app with the route
    const express = require('express');
    const appInstance = express();
    appInstance.use(express.json());
    const router = require('../routes/adminWorkPlanRoutes').default;
    appInstance.use('/api/admin/work-plans', router);
    app = appInstance;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockSharpMetadata.mockResolvedValue({ width: 800, height: 800 }); // square by default
  });

  // ── POST /:planId/thumbnail/generate ──────────────────────────────────────

  describe('POST /:planId/thumbnail/generate', () => {
    it('returns 404 when plan does not exist', async () => {
      mockGetWorkPlan.mockResolvedValue(null);

      const res = await request(app).post('/api/admin/work-plans/nonexistent/thumbnail/generate');

      expect(res.status).toBe(404);
      expect(res.body.message).toBe('Work plan not found');
      expect(mockGenerateAIThumbnail).not.toHaveBeenCalled();
    });

    it('returns updated plan with thumbnail_url on success', async () => {
      mockGetWorkPlan.mockResolvedValue(mockPlan);
      mockGenerateAIThumbnailDetailed.mockResolvedValue({ outcome: 'applied', plan: mockPlanWithThumbnail });

      const res = await request(app).post('/api/admin/work-plans/plan-123/thumbnail/generate');

      expect(res.status).toBe(200);
      expect(res.body.thumbnail_url).toBe(mockPlanWithThumbnail.thumbnail_url);
      expect(res.body.thumbnail_source).toBe('ai');
      // Manual regeneration must supersede any background job already running,
      // otherwise both race the same baseline and the admin can silently get
      // the older job's image back instead of their own.
      expect(mockGenerateAIThumbnailDetailed).toHaveBeenCalledWith(mockPlan, { supersedeInFlight: true });
    });

    it('returns plan with source=none when AI generation fails gracefully', async () => {
      const planWithNoThumbnail = { ...mockPlan, thumbnail_source: 'none' };
      mockGetWorkPlan.mockResolvedValue(mockPlan);
      mockGenerateAIThumbnailDetailed.mockResolvedValue({ outcome: 'applied', plan: planWithNoThumbnail });

      const res = await request(app).post('/api/admin/work-plans/plan-123/thumbnail/generate');

      expect(res.status).toBe(200);
      expect(res.body.thumbnail_source).toBe('none');
    });

    it('returns 500 when service throws an unexpected error', async () => {
      mockGetWorkPlan.mockResolvedValue(mockPlan);
      mockGenerateAIThumbnailDetailed.mockRejectedValue(new Error('Unexpected error'));

      const res = await request(app).post('/api/admin/work-plans/plan-123/thumbnail/generate');

      expect(res.status).toBe(500);
      expect(res.body.message).toBe('Failed to generate thumbnail');
    });
  });

  // ── POST /:planId/thumbnail/upload ────────────────────────────────────────

  describe('POST /:planId/thumbnail/generate — concurrent outcomes', () => {
    it('answers 409, not 200, when a concurrent change discarded the generation', async () => {
      // The admin is waiting on this. The discard is correct — it protects newer
      // state — but reporting it as success would be a silent no-op (ENG-889).
      mockGetWorkPlan.mockResolvedValue(mockPlan);
      mockGenerateAIThumbnailDetailed.mockResolvedValue({ outcome: 'superseded', plan: mockPlan });

      const res = await request(app).post('/api/admin/work-plans/plan-123/thumbnail/generate');

      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/changed while the thumbnail was generating/i);
      expect(res.body.plan).toBeDefined();
    });

    it('answers 404 when the plan was deleted while rendering', async () => {
      mockGetWorkPlan.mockResolvedValue(mockPlan);
      mockGenerateAIThumbnailDetailed.mockResolvedValue({ outcome: 'gone', plan: null });

      const res = await request(app).post('/api/admin/work-plans/plan-123/thumbnail/generate');

      expect(res.status).toBe(404);
    });
  });

  describe('POST /:planId/thumbnail/upload', () => {
    it('returns 404 when plan does not exist', async () => {
      mockGetWorkPlan.mockResolvedValue(null);

      const res = await request(app)
        .post('/api/admin/work-plans/nonexistent/thumbnail/upload')
        .attach('thumbnail', Buffer.from('fake-png-data'), {
          filename: 'test.png',
          contentType: 'image/png',
        });

      expect(res.status).toBe(404);
      expect(mockUploadCustomThumbnail).not.toHaveBeenCalled();
    });

    it('returns 400 when no file is provided', async () => {
      mockGetWorkPlan.mockResolvedValue(mockPlan);

      const res = await request(app).post('/api/admin/work-plans/plan-123/thumbnail/upload');

      expect(res.status).toBe(400);
      expect(res.body.message).toBe('No file uploaded');
    });

    it('returns 400 for unsupported image format (GIF)', async () => {
      mockGetWorkPlan.mockResolvedValue(mockPlan);

      const res = await request(app)
        .post('/api/admin/work-plans/plan-123/thumbnail/upload')
        .attach('thumbnail', Buffer.from('fake-gif-data'), {
          filename: 'test.gif',
          contentType: 'image/gif',
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('Unsupported file format');
    });

    it('returns 400 for landscape images (width > height)', async () => {
      mockGetWorkPlan.mockResolvedValue(mockPlan);
      mockSharpMetadata.mockResolvedValue({ width: 1200, height: 800 }); // landscape

      const res = await request(app)
        .post('/api/admin/work-plans/plan-123/thumbnail/upload')
        .attach('thumbnail', Buffer.from('fake-png-data'), {
          filename: 'landscape.png',
          contentType: 'image/png',
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('Landscape images are not accepted');
    });

    it('returns updated plan with thumbnail_url on successful upload', async () => {
      mockGetWorkPlan.mockResolvedValue(mockPlan);
      mockSharpMetadata.mockResolvedValue({ width: 800, height: 800 }); // square
      const uploadedPlan = { ...mockPlan, thumbnail_url: 'https://s3.amazonaws.com/bucket/custom.png', thumbnail_source: 'upload' };
      mockUploadCustomThumbnail.mockResolvedValue(uploadedPlan);

      const res = await request(app)
        .post('/api/admin/work-plans/plan-123/thumbnail/upload')
        .attach('thumbnail', Buffer.from('fake-png-data'), {
          filename: 'custom.png',
          contentType: 'image/png',
        });

      expect(res.status).toBe(200);
      expect(res.body.thumbnail_source).toBe('upload');
      expect(res.body.thumbnail_url).toBe('https://s3.amazonaws.com/bucket/custom.png');
      expect(mockUploadCustomThumbnail).toHaveBeenCalledWith(
        mockPlan,
        expect.any(Buffer),
        'image/png',
      );
    });

    it('accepts vertical (portrait) images', async () => {
      mockGetWorkPlan.mockResolvedValue(mockPlan);
      mockSharpMetadata.mockResolvedValue({ width: 600, height: 800 }); // portrait (3:4)
      mockUploadCustomThumbnail.mockResolvedValue({ ...mockPlan, thumbnail_source: 'upload' });

      const res = await request(app)
        .post('/api/admin/work-plans/plan-123/thumbnail/upload')
        .attach('thumbnail', Buffer.from('fake-png-data'), {
          filename: 'portrait.png',
          contentType: 'image/png',
        });

      expect(res.status).toBe(200);
    });
  });

  // ── DELETE /:planId/thumbnail ─────────────────────────────────────────────

  describe('DELETE /:planId/thumbnail', () => {
    it('returns 404 when plan does not exist', async () => {
      mockGetWorkPlan.mockResolvedValue(null);

      const res = await request(app).delete('/api/admin/work-plans/nonexistent/thumbnail');

      expect(res.status).toBe(404);
      expect(mockRemoveThumbnail).not.toHaveBeenCalled();
    });

    it('returns cleared plan and triggers async AI regen on success', async () => {
      mockGetWorkPlan.mockResolvedValue(mockPlanWithThumbnail);
      const clearedPlan = { ...mockPlan, thumbnail_source: 'none' };
      mockRemoveThumbnail.mockResolvedValue(clearedPlan);

      const res = await request(app).delete('/api/admin/work-plans/plan-123/thumbnail');

      expect(res.status).toBe(200);
      expect(res.body.thumbnail_source).toBe('none');
      expect(res.body.thumbnail_url).toBeUndefined();
      expect(mockRemoveThumbnail).toHaveBeenCalledWith(mockPlanWithThumbnail);
    });

    it('returns 500 when service throws an unexpected error', async () => {
      mockGetWorkPlan.mockResolvedValue(mockPlan);
      mockRemoveThumbnail.mockRejectedValue(new Error('S3 error'));

      const res = await request(app).delete('/api/admin/work-plans/plan-123/thumbnail');

      expect(res.status).toBe(500);
      expect(res.body.message).toBe('Failed to remove thumbnail');
    });
  });
});
