/**
 * Lead Magnet — Anonymous Task Execution
 *
 * Allows unauthenticated users to run a lightweight agent task
 * by providing their email + task input. Email is captured to waitlist.
 * Rate-limited per email (1/day) and per IP (5/day).
 */
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { taskDb } from '../services/db';
import { waitlistDb } from '../services/waitlistDb';
import {
  InMemoryPublicRateLimitStore,
  PublicRateLimitStore,
  emailRateLimitKey,
  ipRateLimitKey,
} from '../services/publicRateLimitStore';

// ENG-2946: per-email / per-IP daily limits live behind PublicRateLimitStore so
// the durable cross-instance store (ENG-1755, data-plane gated) is a one-line swap.
// Default: in-memory, resets on server restart (unchanged behavior).
const defaultRateLimitStore = new InMemoryPublicRateLimitStore();

const DAY_MS = 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const MAX_PER_EMAIL_PER_DAY = 1;
const MAX_PER_IP_PER_DAY = 5;
const DEFAULT_MAX_EXECUTIONS_PER_DAY = 50;

// ENG-2353: aggregate ceiling independent of IP/email, so IP rotation cannot
// produce unbounded browser/LLM spend on an instance. Per-process only; the
// durable cross-instance store is tracked on ENG-1755 (data-plane gate).
const globalExecutionTimestamps: number[] = [];

function maxExecutionsPerDay(): number {
  const raw = Number(process.env.LEAD_MAGNET_MAX_EXECUTIONS_PER_DAY);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : DEFAULT_MAX_EXECUTIONS_PER_DAY;
}

function isExecuteDisabled(): boolean {
  return process.env.LEAD_MAGNET_EXECUTE_DISABLED === 'true';
}

function isGlobalCeilingReached(now = Date.now()): boolean {
  const cutoff = now - DAY_MS;
  while (globalExecutionTimestamps.length && globalExecutionTimestamps[0] <= cutoff) {
    globalExecutionTimestamps.shift();
  }
  return globalExecutionTimestamps.length >= maxExecutionsPerDay();
}

// Periodic cleanup to prevent unbounded growth
setInterval(() => defaultRateLimitStore.prune(DAY_MS), CLEANUP_INTERVAL_MS).unref?.();

// Simple email validation
function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * POST /api/lead-magnet/execute
 * Body: { email: string, taskInput: string, skillId?: string }
 * Returns: { executionId: string }
 */
export interface LeadMagnetRouterOptions {
  rateLimitStore?: PublicRateLimitStore;
}

export function createLeadMagnetRouter(options: LeadMagnetRouterOptions = {}): express.Router {
  const router = express.Router();
  const store = options.rateLimitStore ?? defaultRateLimitStore;

router.post('/execute', async (req, res) => {
  try {
    if (isExecuteDisabled()) {
      return res.status(503).json({ message: 'Free tasks are temporarily unavailable.' });
    }

    const { email, taskInput, skillId } = req.body;

    // Validate required fields
    if (!email) {
      return res.status(400).json({ message: 'email is required' });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ message: 'Invalid email format' });
    }
    if (!taskInput || (typeof taskInput === 'string' && !taskInput.trim())) {
      return res.status(400).json({ message: 'taskInput is required' });
    }
    if (typeof taskInput !== 'string' || taskInput.length > 2000) {
      return res.status(400).json({ message: 'taskInput must be a string of 2000 characters or fewer' });
    }

    // Rate limiting — email (1 per day)
    const emailKey = emailRateLimitKey(email);
    if (!(await store.check(emailKey, MAX_PER_EMAIL_PER_DAY, DAY_MS)).allowed) {
      return res.status(429).json({
        message: 'Rate limit exceeded. You can run one free task per day.',
      });
    }

    // Rate limiting — IP (5 per day)
    // req.ip resolves to the real client IP via app.ts's `trust proxy` setting (ENG-493).
    const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
    const ipKey = ipRateLimitKey(clientIp);
    if (!(await store.check(ipKey, MAX_PER_IP_PER_DAY, DAY_MS)).allowed) {
      return res.status(429).json({
        message: 'Too many requests from this address. Please try again later.',
      });
    }

    if (isGlobalCeilingReached()) {
      return res.status(429).json({
        message: 'Free task capacity reached for today. Please try again later.',
      });
    }

    // Add email to waitlist (ignore if already exists)
    try {
      await waitlistDb.add({
        email: email.toLowerCase(),
        joinedAt: new Date().toISOString(),
        status: 'pending',
        supportNote: 'Lead magnet signup',
      });
    } catch (err: any) {
      // ConditionalCheckFailedException means email already on waitlist — that's fine
      if (err?.code !== 'ConditionalCheckFailedException') {
        console.error('Error adding to waitlist:', err);
        // Non-critical — continue with execution
      }
    }

    // Create task execution
    const executionId = `lm-${Date.now()}-${uuidv4().slice(0, 8)}`;
    const userId = `lead-magnet-${uuidv4()}`;

    await taskDb.createTaskExecution({
      executionId,
      taskId: `lead-magnet-${skillId || 'general'}`,
      userId,
      status: 'pending',
      startTime: new Date().toISOString(),
      prompt: taskInput,
    });

    // Record rate limit usage
    await store.record(emailKey, DAY_MS);
    await store.record(ipKey, DAY_MS);
    globalExecutionTimestamps.push(Date.now());

    return res.status(200).json({ executionId });
  } catch (error: any) {
    console.error('Lead magnet execute error:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

/**
 * GET /api/lead-magnet/status/:executionId
 * Returns: { executionId, status, result? }
 * Only returns data for lead-magnet executions (userId starts with "lead-magnet-")
 */
router.get('/status/:executionId', async (req, res) => {
  try {
    const { executionId } = req.params;
    const execution = await taskDb.getTaskExecutionById(executionId);

    if (!execution) {
      return res.status(404).json({ message: 'Execution not found' });
    }

    // Only allow polling lead-magnet executions (not regular user executions)
    if (!execution.userId?.startsWith('lead-magnet-')) {
      return res.status(404).json({ message: 'Execution not found' });
    }

    // Return sanitized response — only safe fields
    const response: Record<string, any> = {
      executionId: execution.executionId,
      status: execution.status,
      startTime: execution.startTime,
    };

    if (execution.status === 'completed' && execution.result) {
      response.result = execution.result;
    }

    if (execution.status === 'failed' && execution.error) {
      response.error = execution.error;
    }

    if (execution.completedAt) {
      response.completedAt = execution.completedAt;
    }

    return res.status(200).json(response);
  } catch (error: any) {
    console.error('Lead magnet status error:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

  return router;
}

const router = createLeadMagnetRouter();
export default router;

// Export for testing (both names reset the shared default store; kept for
// existing tests that clear them between cases).
const dailyEmailTracker = defaultRateLimitStore;
const dailyIpTracker = defaultRateLimitStore;
export { dailyEmailTracker, dailyIpTracker, defaultRateLimitStore, globalExecutionTimestamps };
