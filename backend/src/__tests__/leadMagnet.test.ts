/**
 * TDD tests for Anonymous Task Execution (Lead Magnet)
 * POST /api/lead-magnet/execute — no auth, email + taskInput
 * GET /api/lead-magnet/status/:executionId — poll results
 */

// Mock dependencies before imports
jest.mock('../services/db', () => ({
  taskDb: {
    createTaskExecution: jest.fn(),
    getTaskExecutionById: jest.fn(),
  },
}));

jest.mock('../services/waitlistDb', () => ({
  waitlistDb: {
    add: jest.fn(),
    getByEmail: jest.fn(),
  },
}));

import express from 'express';
import request from 'supertest';

// Import mocked modules
const { taskDb } = require('../services/db');
const { waitlistDb } = require('../services/waitlistDb');

// Import after mocks
import leadMagnetRoutes, { dailyEmailTracker, dailyIpTracker } from '../routes/leadMagnet';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/lead-magnet', leadMagnetRoutes);
  return app;
}

describe('Lead Magnet API', () => {
  let app: express.Express;

  beforeEach(() => {
    app = createApp();
    jest.clearAllMocks();
    // Clear rate limit state between tests
    dailyEmailTracker.clear();
    dailyIpTracker.clear();
  });

  afterAll(() => {
    // Clean up timers from RateLimiter instances
    jest.useRealTimers();
  });

  // ==========================================
  // FAIL tests (validation / error paths)
  // ==========================================

  describe('POST /api/lead-magnet/execute', () => {
    it('returns 400 when email is missing', async () => {
      const res = await request(app)
        .post('/api/lead-magnet/execute')
        .send({ taskInput: 'Create a landing page' });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/email/i);
    });

    it('returns 400 when email format is invalid', async () => {
      const res = await request(app)
        .post('/api/lead-magnet/execute')
        .send({ email: 'not-an-email', taskInput: 'Create a landing page' });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/email/i);
    });

    it('returns 400 when taskInput is missing', async () => {
      const res = await request(app)
        .post('/api/lead-magnet/execute')
        .send({ email: 'test@example.com' });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/taskInput/i);
    });

    it('returns 429 when same email exceeds daily rate limit', async () => {
      // Set up mocks for successful execution
      taskDb.createTaskExecution.mockResolvedValue({});
      waitlistDb.add.mockResolvedValue({});
      waitlistDb.getByEmail.mockResolvedValue(null);

      // First request should succeed
      const res1 = await request(app)
        .post('/api/lead-magnet/execute')
        .send({ email: 'ratelimited@example.com', taskInput: 'Test task' });

      expect(res1.status).toBe(200);

      // Second request with same email should be rate limited
      const res2 = await request(app)
        .post('/api/lead-magnet/execute')
        .send({ email: 'ratelimited@example.com', taskInput: 'Test task 2' });

      expect(res2.status).toBe(429);
      expect(res2.body.message).toMatch(/rate limit|too many/i);
    });

    it('returns 429 when IP exceeds rate limit', async () => {
      taskDb.createTaskExecution.mockResolvedValue({});
      waitlistDb.add.mockResolvedValue({});
      waitlistDb.getByEmail.mockResolvedValue(null);

      // Make 5 requests with different emails from same IP
      for (let i = 0; i < 5; i++) {
        await request(app)
          .post('/api/lead-magnet/execute')
          .send({ email: `user${i}@example.com`, taskInput: 'Test task' });
      }

      // 6th request should be rate limited
      const res = await request(app)
        .post('/api/lead-magnet/execute')
        .send({ email: 'user99@example.com', taskInput: 'Test task' });

      expect(res.status).toBe(429);
    });

    // ==========================================
    // SUCCESS tests (happy path)
    // ==========================================

    it('creates execution and returns executionId on valid request', async () => {
      taskDb.createTaskExecution.mockResolvedValue({
        executionId: 'exec-123',
        status: 'pending',
      });
      waitlistDb.add.mockResolvedValue({});
      waitlistDb.getByEmail.mockResolvedValue(null);

      const res = await request(app)
        .post('/api/lead-magnet/execute')
        .send({
          email: 'newuser@example.com',
          taskInput: 'Create a landing page for my SaaS product',
        });

      expect(res.status).toBe(200);
      expect(res.body.executionId).toBeDefined();
      expect(typeof res.body.executionId).toBe('string');
    });

    it('adds email to waitlist on execute', async () => {
      taskDb.createTaskExecution.mockResolvedValue({
        executionId: 'exec-456',
        status: 'pending',
      });
      waitlistDb.add.mockResolvedValue({});
      waitlistDb.getByEmail.mockResolvedValue(null);

      await request(app)
        .post('/api/lead-magnet/execute')
        .send({
          email: 'waitlist-test@example.com',
          taskInput: 'Generate marketing copy',
        });

      expect(waitlistDb.add).toHaveBeenCalledWith(
        expect.objectContaining({
          email: 'waitlist-test@example.com',
        })
      );
    });

    it('does not error if email is already on waitlist', async () => {
      taskDb.createTaskExecution.mockResolvedValue({
        executionId: 'exec-789',
        status: 'pending',
      });
      // Simulate ConditionalCheckFailedException (email already exists)
      waitlistDb.add.mockRejectedValue({
        code: 'ConditionalCheckFailedException',
        message: 'The conditional request failed',
      });
      waitlistDb.getByEmail.mockResolvedValue({ email: 'existing@example.com' });

      const res = await request(app)
        .post('/api/lead-magnet/execute')
        .send({
          email: 'existing@example.com',
          taskInput: 'Create a landing page',
        });

      // Should still succeed — duplicate waitlist entry is fine
      expect(res.status).toBe(200);
      expect(res.body.executionId).toBeDefined();
    });

    it('creates execution with lead-magnet userId prefix', async () => {
      taskDb.createTaskExecution.mockResolvedValue({
        executionId: 'exec-abc',
        status: 'pending',
      });
      waitlistDb.add.mockResolvedValue({});
      waitlistDb.getByEmail.mockResolvedValue(null);

      await request(app)
        .post('/api/lead-magnet/execute')
        .send({
          email: 'prefix-test@example.com',
          taskInput: 'Test',
        });

      expect(taskDb.createTaskExecution).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: expect.stringMatching(/^lead-magnet-/),
          status: 'pending',
        })
      );
    });
  });

  // ==========================================
  // Status polling endpoint
  // ==========================================

  describe('GET /api/lead-magnet/status/:executionId', () => {
    it('returns 404 for nonexistent execution', async () => {
      taskDb.getTaskExecutionById.mockResolvedValue(null);

      const res = await request(app)
        .get('/api/lead-magnet/status/nonexistent-id');

      expect(res.status).toBe(404);
      expect(res.body.message).toMatch(/not found/i);
    });

    it('returns status for existing execution', async () => {
      taskDb.getTaskExecutionById.mockResolvedValue({
        executionId: 'exec-poll-1',
        status: 'pending',
        startTime: new Date().toISOString(),
        userId: 'lead-magnet-abc123',
      });

      const res = await request(app)
        .get('/api/lead-magnet/status/exec-poll-1');

      expect(res.status).toBe(200);
      expect(res.body.executionId).toBe('exec-poll-1');
      expect(res.body.status).toBe('pending');
    });

    it('returns sanitized result (no internal fields leaked)', async () => {
      taskDb.getTaskExecutionById.mockResolvedValue({
        executionId: 'exec-done-1',
        status: 'completed',
        startTime: new Date().toISOString(),
        userId: 'lead-magnet-abc123',
        result: JSON.stringify({ output: 'Landing page created' }),
        // Internal fields that should NOT be exposed
        taskId: 'internal-task-123',
        workflowExecutionId: 'wf-secret-456',
        prompt: 'internal prompt details',
      });

      const res = await request(app)
        .get('/api/lead-magnet/status/exec-done-1');

      expect(res.status).toBe(200);
      expect(res.body.executionId).toBe('exec-done-1');
      expect(res.body.status).toBe('completed');
      expect(res.body.result).toBeDefined();
      // Internal fields should not be present
      expect(res.body.taskId).toBeUndefined();
      expect(res.body.workflowExecutionId).toBeUndefined();
      expect(res.body.prompt).toBeUndefined();
    });

    it('rejects polling for non-lead-magnet executions', async () => {
      taskDb.getTaskExecutionById.mockResolvedValue({
        executionId: 'exec-auth-1',
        status: 'completed',
        userId: 'regular-user-123', // Not a lead-magnet execution
      });

      const res = await request(app)
        .get('/api/lead-magnet/status/exec-auth-1');

      expect(res.status).toBe(404);
      expect(res.body.message).toMatch(/not found/i);
    });
  });
});
