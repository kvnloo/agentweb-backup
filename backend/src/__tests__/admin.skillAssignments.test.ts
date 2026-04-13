/**
 * Tests for skill assignment admin routes:
 * GET /api/admin/skills/:skillId/assignments
 * POST /api/admin/skills/:skillId/assignments
 * PUT /api/admin/skill-assignments/:assignmentId
 * DELETE /api/admin/skill-assignments/:assignmentId
 */

// Mock the skillAssignmentDb before imports
const mockGetAssignmentsBySkill = jest.fn();
const mockCreateAssignment = jest.fn();
const mockGetAssignment = jest.fn();
const mockUpdateAssignment = jest.fn();
const mockDeleteAssignment = jest.fn();

jest.mock('../services/skillAssignmentDb', () => ({
  skillAssignmentDb: {
    getAssignmentsBySkill: mockGetAssignmentsBySkill,
    createAssignment: mockCreateAssignment,
    getAssignment: mockGetAssignment,
    updateAssignment: mockUpdateAssignment,
    deleteAssignment: mockDeleteAssignment,
  },
}));

// Mock auth middleware to always pass
jest.mock('../middleware/auth', () => ({
  authenticateToken: (_req: any, _res: any, next: any) => next(),
}));

jest.mock('../middleware/admin', () => ({
  isAdmin: (_req: any, _res: any, next: any) => next(),
}));

import request from 'supertest';
import express from 'express';

// Dynamic import of the admin routes
let app: express.Application;

beforeAll(async () => {
  app = express();
  app.use(express.json());
  const adminRouter = (await import('../routes/admin')).default;
  app.use('/api/admin', adminRouter);
});

beforeEach(() => {
  jest.clearAllMocks();
});

const mockAssignment = {
  assignmentId: 'assign-1',
  skillId: 'skill-1',
  userId: 'user-1',
  status: 'active',
  createdAt: '2026-04-11T00:00:00Z',
  updatedAt: '2026-04-11T00:00:00Z',
};

describe('GET /api/admin/skills/:skillId/assignments', () => {
  it('returns assignments for a skill', async () => {
    mockGetAssignmentsBySkill.mockResolvedValue([mockAssignment]);

    const res = await request(app).get('/api/admin/skills/skill-1/assignments');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].assignmentId).toBe('assign-1');
    expect(mockGetAssignmentsBySkill).toHaveBeenCalledWith('skill-1');
  });

  it('returns empty array when no assignments', async () => {
    mockGetAssignmentsBySkill.mockResolvedValue([]);

    const res = await request(app).get('/api/admin/skills/skill-1/assignments');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(0);
  });
});

describe('POST /api/admin/skills/:skillId/assignments', () => {
  it('creates a new assignment', async () => {
    mockGetAssignmentsBySkill.mockResolvedValue([]);
    mockCreateAssignment.mockResolvedValue(mockAssignment);

    const res = await request(app)
      .post('/api/admin/skills/skill-1/assignments')
      .send({ userId: 'user-1' });

    expect(res.status).toBe(201);
    expect(res.body.assignmentId).toBe('assign-1');
    expect(mockCreateAssignment).toHaveBeenCalledWith(
      expect.objectContaining({ skillId: 'skill-1', userId: 'user-1', status: 'active' })
    );
  });

  it('returns 400 when userId is missing', async () => {
    const res = await request(app)
      .post('/api/admin/skills/skill-1/assignments')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('userId');
  });

  it('returns 400 when invalid status is provided', async () => {
    const res = await request(app)
      .post('/api/admin/skills/skill-1/assignments')
      .send({ userId: 'user-1', status: 'banana' });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('Invalid status');
    expect(res.body.message).toContain('banana');
    expect(mockCreateAssignment).not.toHaveBeenCalled();
  });

  it('returns 400 when invalid schedule frequency is provided', async () => {
    const res = await request(app)
      .post('/api/admin/skills/skill-1/assignments')
      .send({ userId: 'user-1', schedule: { frequency: 'every_5_seconds' } });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('Invalid schedule frequency');
    expect(mockCreateAssignment).not.toHaveBeenCalled();
  });

  it('returns 400 when invalid nextRunTime is provided', async () => {
    const res = await request(app)
      .post('/api/admin/skills/skill-1/assignments')
      .send({ userId: 'user-1', nextRunTime: 'not-a-date' });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('Invalid nextRunTime');
    expect(mockCreateAssignment).not.toHaveBeenCalled();
  });

  it('returns 409 when user is already assigned to the skill', async () => {
    mockGetAssignmentsBySkill.mockResolvedValue([mockAssignment]);

    const res = await request(app)
      .post('/api/admin/skills/skill-1/assignments')
      .send({ userId: 'user-1' });

    expect(res.status).toBe(409);
    expect(res.body.message).toContain('already assigned');
    expect(mockCreateAssignment).not.toHaveBeenCalled();
  });

  it('allows assigning a different user to the same skill', async () => {
    mockGetAssignmentsBySkill.mockResolvedValue([mockAssignment]);
    const newAssignment = { ...mockAssignment, assignmentId: 'assign-2', userId: 'user-2' };
    mockCreateAssignment.mockResolvedValue(newAssignment);

    const res = await request(app)
      .post('/api/admin/skills/skill-1/assignments')
      .send({ userId: 'user-2' });

    expect(res.status).toBe(201);
    expect(mockCreateAssignment).toHaveBeenCalled();
  });
});

describe('PUT /api/admin/skill-assignments/:assignmentId', () => {
  it('updates an existing assignment', async () => {
    const updated = { ...mockAssignment, status: 'paused' };
    mockGetAssignment.mockResolvedValue(mockAssignment);
    mockUpdateAssignment.mockResolvedValue(updated);

    const res = await request(app)
      .put('/api/admin/skill-assignments/assign-1')
      .send({ status: 'paused' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('paused');
  });

  it('returns 404 for non-existent assignment', async () => {
    mockGetAssignment.mockResolvedValue(null);

    const res = await request(app)
      .put('/api/admin/skill-assignments/nonexistent')
      .send({ status: 'paused' });

    expect(res.status).toBe(404);
  });

  it('returns 400 when invalid status is provided', async () => {
    const res = await request(app)
      .put('/api/admin/skill-assignments/assign-1')
      .send({ status: 'banana' });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('Invalid status');
    expect(mockGetAssignment).not.toHaveBeenCalled();
  });

  it('returns 400 when invalid schedule frequency is provided', async () => {
    const res = await request(app)
      .put('/api/admin/skill-assignments/assign-1')
      .send({ schedule: { frequency: 'every_5_seconds' } });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('Invalid schedule frequency');
    expect(mockGetAssignment).not.toHaveBeenCalled();
  });

  it('returns 400 when invalid nextRunTime is provided', async () => {
    const res = await request(app)
      .put('/api/admin/skill-assignments/assign-1')
      .send({ nextRunTime: 'not-a-date' });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('Invalid nextRunTime');
    expect(mockGetAssignment).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/admin/skill-assignments/:assignmentId', () => {
  it('deletes an existing assignment', async () => {
    mockGetAssignment.mockResolvedValue(mockAssignment);
    mockDeleteAssignment.mockResolvedValue(undefined);

    const res = await request(app)
      .delete('/api/admin/skill-assignments/assign-1');

    expect(res.status).toBe(200);
    expect(res.body.message).toContain('deleted');
  });

  it('returns 404 for non-existent assignment', async () => {
    mockGetAssignment.mockResolvedValue(null);

    const res = await request(app)
      .delete('/api/admin/skill-assignments/nonexistent');

    expect(res.status).toBe(404);
  });
});
