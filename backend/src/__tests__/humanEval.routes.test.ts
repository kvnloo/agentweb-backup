import request from 'supertest';
import express from 'express';

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = {
      userId: 'user-1',
      email: 'test@example.com',
      isAdmin: req.headers['x-admin'] === '1',
    };
    next();
  },
}));

jest.mock('../services/humanEvalService', () => ({
  humanEvalService: {
    createCandidate: jest.fn(),
    getCandidate: jest.fn(),
    listCandidates: jest.fn(),
  },
}));

import humanEvalRoutes from '../routes/humanEval';
import { humanEvalService } from '../services/humanEvalService';

const mockCreateCandidate = humanEvalService.createCandidate as jest.Mock;
const mockListCandidates = humanEvalService.listCandidates as jest.Mock;

const app = express();
app.use(express.json());
app.use('/api/human-eval', humanEvalRoutes);

beforeEach(() => {
  jest.clearAllMocks();
  mockCreateCandidate.mockResolvedValue({ candidateId: 'candidate-1', category: 'ad' });
  mockListCandidates.mockResolvedValue([]);
});

describe('POST /api/human-eval/candidates', () => {
  it('forwards an optional category to the service', async () => {
    const res = await request(app).post('/api/human-eval/candidates').send({
      reviewType: 'creative_image',
      outputSummary: 'Ad image generated.',
      category: 'ad',
    });

    expect(res.status).toBe(200);
    expect(mockCreateCandidate).toHaveBeenCalledWith(expect.objectContaining({
      reviewType: 'creative_image',
      category: 'ad',
      userId: 'user-1',
    }));
  });

  it('ignores non-string category values instead of failing the enqueue', async () => {
    const res = await request(app).post('/api/human-eval/candidates').send({
      reviewType: 'creative_image',
      outputSummary: 'Image generated.',
      category: { nested: true },
    });

    expect(res.status).toBe(200);
    expect(mockCreateCandidate).toHaveBeenCalledWith(expect.objectContaining({
      category: undefined,
    }));
  });
});

describe('GET /api/human-eval/candidates', () => {
  it('rejects non-admin users', async () => {
    const res = await request(app).get('/api/human-eval/candidates?category=ad');

    expect(res.status).toBe(403);
    expect(mockListCandidates).not.toHaveBeenCalled();
  });

  it('passes category/status/reviewType/limit filters through for admins', async () => {
    mockListCandidates.mockResolvedValue([{ candidateId: 'cand-ad', category: 'ad' }]);

    const res = await request(app)
      .get('/api/human-eval/candidates?category=ad&status=pending&reviewType=creative_image&limit=10')
      .set('x-admin', '1');

    expect(res.status).toBe(200);
    expect(res.body.candidates).toEqual([{ candidateId: 'cand-ad', category: 'ad' }]);
    expect(mockListCandidates).toHaveBeenCalledWith({
      category: 'ad',
      status: 'pending',
      reviewType: 'creative_image',
      limit: 10,
    });
  });

  it('lists without filters when none are provided', async () => {
    const res = await request(app).get('/api/human-eval/candidates').set('x-admin', '1');

    expect(res.status).toBe(200);
    expect(mockListCandidates).toHaveBeenCalledWith({
      category: undefined,
      status: undefined,
      reviewType: undefined,
      limit: undefined,
    });
  });

  it('returns 500 when listing fails', async () => {
    mockListCandidates.mockRejectedValue(new Error('scan failed'));

    const res = await request(app).get('/api/human-eval/candidates').set('x-admin', '1');

    expect(res.status).toBe(500);
    expect(res.body.error).toContain('scan failed');
  });
});
