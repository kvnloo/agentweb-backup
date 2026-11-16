import request from 'supertest';
import express from 'express';

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = {
      // x-no-user-id simulates a token without a userId (e.g. a service token).
      userId: req.headers['x-no-user-id'] === '1' ? undefined : 'user-1',
      email: 'test@example.com',
      isAdmin: req.headers['x-admin'] === '1',
    };
    next();
  },
}));

jest.mock('../services/humanEvalService', () => {
  const actual = jest.requireActual('../services/humanEvalService');
  return {
    // Pure parser stays real so the route's strict filter validation is exercised.
    parseHumanEvalCategoryFilter: actual.parseHumanEvalCategoryFilter,
    humanEvalService: {
      createCandidate: jest.fn(),
      getCandidate: jest.fn(),
      listCandidates: jest.fn(),
    },
  };
});

jest.mock('../services/autoHumanEvalService', () => ({
  claimArtifactForHumanEval: jest.fn().mockResolvedValue(true),
  releaseArtifactClaim: jest.fn().mockResolvedValue(undefined),
}));

// ENG-2651: the route reads the named session's record to decide who may attach it.
const mockGetChatSessionRecord = jest.fn();
jest.mock('../services/chatbotService', () => ({
  chatbotDb: { getChatSessionRecord: (...args: any[]) => mockGetChatSessionRecord(...args) },
}));

import humanEvalRoutes from '../routes/humanEval';
import { humanEvalService } from '../services/humanEvalService';
import { claimArtifactForHumanEval, releaseArtifactClaim } from '../services/autoHumanEvalService';

const mockCreateCandidate = humanEvalService.createCandidate as jest.Mock;
const mockListCandidates = humanEvalService.listCandidates as jest.Mock;
const mockGetCandidate = humanEvalService.getCandidate as jest.Mock;
const mockClaimArtifact = claimArtifactForHumanEval as jest.Mock;
const mockReleaseArtifact = releaseArtifactClaim as jest.Mock;

const app = express();
app.use(express.json());
app.use('/api/human-eval', humanEvalRoutes);

beforeEach(() => {
  jest.clearAllMocks();
  mockCreateCandidate.mockResolvedValue({ candidateId: 'candidate-1', category: 'ad' });
  mockListCandidates.mockResolvedValue([]);
  mockClaimArtifact.mockResolvedValue(true);
  mockReleaseArtifact.mockResolvedValue(undefined);
  mockGetChatSessionRecord.mockResolvedValue(null);
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

  // ENG-1854: this route calls createCandidate directly, same as the manual Emma tool —
  // same cross-path duplicate risk against an already-auto-posted artifact.
  it('claims the artifact and creates a candidate when it was not already claimed', async () => {
    const res = await request(app).post('/api/human-eval/candidates').send({
      reviewType: 'creative_image',
      outputSummary: 'Ad image generated.',
      artifactUrl: 'https://example.com/ad.png',
    });

    expect(res.status).toBe(200);
    expect(mockClaimArtifact).toHaveBeenCalledWith('https://example.com/ad.png');
    expect(mockCreateCandidate).toHaveBeenCalled();
  });

  it('skips creating a duplicate candidate when the artifact was already claimed', async () => {
    mockClaimArtifact.mockResolvedValue(false);

    const res = await request(app).post('/api/human-eval/candidates').send({
      reviewType: 'creative_image',
      outputSummary: 'Same ad image, already auto-posted.',
      artifactUrl: 'https://example.com/ad.png',
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toContain('already sent');
    expect(mockCreateCandidate).not.toHaveBeenCalled();
  });

  it('does not attempt a dedup claim when no artifactUrl is given', async () => {
    const res = await request(app).post('/api/human-eval/candidates').send({
      reviewType: 'lead_enrichment',
      outputSummary: 'Enrichment run with no single artifact URL.',
    });

    expect(res.status).toBe(200);
    expect(mockClaimArtifact).not.toHaveBeenCalled();
    expect(mockCreateCandidate).toHaveBeenCalled();
  });

  // Round-3 review finding: the claim used to be won BEFORE createCandidate ran and never
  // released on failure — a transient createCandidate error would permanently blackhole that
  // artifact from ever being sent for review again.
  it('releases the artifact claim when createCandidate fails after the claim was won', async () => {
    mockCreateCandidate.mockRejectedValue(new Error('DynamoDB PutItem transiently failed'));

    const res = await request(app).post('/api/human-eval/candidates').send({
      reviewType: 'creative_image',
      outputSummary: 'Ad image generated.',
      artifactUrl: 'https://example.com/flaky-create.png',
    });

    expect(res.status).toBe(500);
    expect(mockReleaseArtifact).toHaveBeenCalledWith('https://example.com/flaky-create.png');
  });

  it('does not attempt to release a claim that was never won when there is no artifactUrl', async () => {
    mockCreateCandidate.mockRejectedValue(new Error('DynamoDB PutItem transiently failed'));

    await request(app).post('/api/human-eval/candidates').send({
      reviewType: 'lead_enrichment',
      outputSummary: 'Enrichment run, no single artifact URL.',
    });

    expect(mockReleaseArtifact).not.toHaveBeenCalled();
  });
});

// ENG-2651: createCandidate mints an iShare link (a token that opens and chats in the session) for
// the candidate's sessionId and returns it as candidate.chatUrl, and reviewer feedback is later
// written into that session. Only the session owner or an admin may name a session; anything else
// must be refused before any candidate, claim, or link exists.
describe('POST /api/human-eval/candidates — session ownership (ENG-2651)', () => {
  const body = {
    reviewType: 'creative_image',
    outputSummary: 'Ad image generated.',
    artifactUrl: 'https://example.com/ad.png',
  };

  it('refuses another account\'s session with 404 and mints nothing', async () => {
    mockGetChatSessionRecord.mockResolvedValue({ sessionId: 'victim-session', userId: 'victim-user' });

    const res = await request(app).post('/api/human-eval/candidates').send({ ...body, sessionId: 'victim-session' });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Session not found' });
    expect(res.body.candidate).toBeUndefined();
    expect(mockGetChatSessionRecord).toHaveBeenCalledWith('victim-session', true);
    expect(mockCreateCandidate).not.toHaveBeenCalled();
    expect(mockClaimArtifact).not.toHaveBeenCalled();
  });

  it('answers a missing session exactly like a foreign one', async () => {
    mockGetChatSessionRecord.mockResolvedValue(null);

    const res = await request(app).post('/api/human-eval/candidates').send({ ...body, sessionId: 'no-such-session' });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Session not found' });
    expect(mockCreateCandidate).not.toHaveBeenCalled();
    expect(mockClaimArtifact).not.toHaveBeenCalled();
  });

  it('refuses a session id when the caller has an empty userId even if the session has none', async () => {
    mockGetChatSessionRecord.mockResolvedValue({ sessionId: 'orphan-session' });

    const res = await request(app)
      .post('/api/human-eval/candidates')
      .set('x-no-user-id', '1')
      .send({ ...body, sessionId: 'orphan-session' });

    expect(res.status).toBe(404);
    expect(mockCreateCandidate).not.toHaveBeenCalled();
  });

  it('answers an oversized sessionId 404 without reading it (DynamoDB would reject the key with a 500)', async () => {
    const res = await request(app).post('/api/human-eval/candidates').send({ ...body, sessionId: 'x'.repeat(4000) });

    expect(res.status).toBe(404);
    expect(mockGetChatSessionRecord).not.toHaveBeenCalled();
    expect(mockCreateCandidate).not.toHaveBeenCalled();
  });

  it('rejects a non-string sessionId with 400 instead of silently dropping it', async () => {
    const res = await request(app).post('/api/human-eval/candidates').send({ ...body, sessionId: { $ne: null } });

    expect(res.status).toBe(400);
    expect(mockGetChatSessionRecord).not.toHaveBeenCalled();
    expect(mockCreateCandidate).not.toHaveBeenCalled();
  });

  it('accepts the caller\'s own session and passes it to createCandidate', async () => {
    mockGetChatSessionRecord.mockResolvedValue({ sessionId: 'own-session', userId: 'user-1' });

    const res = await request(app).post('/api/human-eval/candidates').send({ ...body, sessionId: 'own-session' });

    expect(res.status).toBe(200);
    expect(mockClaimArtifact).toHaveBeenCalledWith('https://example.com/ad.png');
    expect(mockCreateCandidate).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'own-session',
      userId: 'user-1',
    }));
  });

  it('lets an admin attach any account\'s session', async () => {
    mockGetChatSessionRecord.mockResolvedValue({ sessionId: 'customer-session', userId: 'customer-user' });

    const res = await request(app)
      .post('/api/human-eval/candidates')
      .set('x-admin', '1')
      .send({ ...body, sessionId: 'customer-session' });

    expect(res.status).toBe(200);
    expect(mockCreateCandidate).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'customer-session' }));
  });

  it('does not read any session when none is named', async () => {
    const res = await request(app).post('/api/human-eval/candidates').send({ ...body, sessionId: '' });

    expect(res.status).toBe(200);
    expect(mockGetChatSessionRecord).not.toHaveBeenCalled();
    expect(mockCreateCandidate).toHaveBeenCalledWith(expect.objectContaining({ sessionId: undefined }));
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

  it('accepts friendly category spellings and forwards the canonical value', async () => {
    const res = await request(app)
      .get('/api/human-eval/candidates?category=Organic%20Post')
      .set('x-admin', '1');

    expect(res.status).toBe(200);
    expect(mockListCandidates).toHaveBeenCalledWith(expect.objectContaining({
      category: 'organic_post',
    }));
  });

  it('rejects an unrecognized category with 400 instead of silently coercing it', async () => {
    const res = await request(app)
      .get('/api/human-eval/candidates?category=orgnic_post')
      .set('x-admin', '1');

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('category');
    expect(mockListCandidates).not.toHaveBeenCalled();
  });

  it('rejects near-miss category values like "ads" with 400', async () => {
    const res = await request(app)
      .get('/api/human-eval/candidates?category=ads')
      .set('x-admin', '1');

    expect(res.status).toBe(400);
    expect(mockListCandidates).not.toHaveBeenCalled();
  });

  it('rejects an unknown status value with 400', async () => {
    const res = await request(app)
      .get('/api/human-eval/candidates?status=bogus')
      .set('x-admin', '1');

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('status');
    expect(mockListCandidates).not.toHaveBeenCalled();
  });

  it('rejects an unknown reviewType value with 400', async () => {
    const res = await request(app)
      .get('/api/human-eval/candidates?reviewType=bogus')
      .set('x-admin', '1');

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('reviewType');
    expect(mockListCandidates).not.toHaveBeenCalled();
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

describe('GET /api/human-eval/candidates/:candidateId (ENG-2154)', () => {
  const candidate = { candidateId: 'candidate-9', userId: 'owner-1', userEmail: 'owner@example.com' };

  it('returns any candidate to an admin', async () => {
    mockGetCandidate.mockResolvedValue(candidate);
    const res = await request(app).get('/api/human-eval/candidates/candidate-9').set('x-admin', '1');
    expect(res.status).toBe(200);
    expect(res.body.candidate).toEqual(candidate);
  });

  it("returns the candidate to its owner", async () => {
    mockGetCandidate.mockResolvedValue({ ...candidate, userId: 'user-1' });
    const res = await request(app).get('/api/human-eval/candidates/candidate-9');
    expect(res.status).toBe(200);
  });

  it("answers 404, not 403, for another user's candidate so its existence does not leak", async () => {
    mockGetCandidate.mockResolvedValue(candidate);
    const res = await request(app).get('/api/human-eval/candidates/candidate-9');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Candidate not found' });
  });

  it('answers 404 for a candidate without an owner unless the caller is an admin', async () => {
    mockGetCandidate.mockResolvedValue({ candidateId: 'candidate-9' });
    expect((await request(app).get('/api/human-eval/candidates/candidate-9')).status).toBe(404);
    expect((await request(app).get('/api/human-eval/candidates/candidate-9').set('x-admin', '1')).status).toBe(200);
  });

  it('does not treat a missing caller id and a missing owner as a match (#3080 review)', async () => {
    mockGetCandidate.mockResolvedValue({ candidateId: 'candidate-9' });
    const res = await request(app).get('/api/human-eval/candidates/candidate-9').set('x-no-user-id', '1');
    expect(res.status).toBe(404);
  });

  it('answers 404 for an unknown id', async () => {
    mockGetCandidate.mockResolvedValue(null);
    expect((await request(app).get('/api/human-eval/candidates/nope').set('x-admin', '1')).status).toBe(404);
  });
});
