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

const router = express.Router();

// Daily rate limit tracking (in-memory, resets on server restart)
const dailyEmailTracker = new Map<string, number>(); // email -> last execution timestamp
const dailyIpTracker = new Map<string, number[]>(); // ip -> execution timestamps (last 24h)

const DAY_MS = 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const MAX_PER_EMAIL_PER_DAY = 1;
const MAX_PER_IP_PER_DAY = 5;

// Periodic cleanup to prevent unbounded Map growth
setInterval(() => {
  const cutoff = Date.now() - DAY_MS;
  for (const [email, ts] of dailyEmailTracker) {
    if (ts < cutoff) dailyEmailTracker.delete(email);
  }
  for (const [ip, timestamps] of dailyIpTracker) {
    const recent = timestamps.filter(t => t > cutoff);
    if (recent.length === 0) {
      dailyIpTracker.delete(ip);
    } else {
      dailyIpTracker.set(ip, recent);
    }
  }
}, CLEANUP_INTERVAL_MS);

function isEmailRateLimited(email: string): boolean {
  const lastExec = dailyEmailTracker.get(email.toLowerCase());
  if (!lastExec) return false;
  return (Date.now() - lastExec) < DAY_MS;
}

function isIpRateLimited(ip: string): boolean {
  const timestamps = dailyIpTracker.get(ip);
  if (!timestamps) return false;
  const cutoff = Date.now() - DAY_MS;
  const recent = timestamps.filter(t => t > cutoff);
  dailyIpTracker.set(ip, recent);
  return recent.length >= MAX_PER_IP_PER_DAY;
}

function recordEmailUsage(email: string): void {
  dailyEmailTracker.set(email.toLowerCase(), Date.now());
}

function recordIpUsage(ip: string): void {
  const timestamps = dailyIpTracker.get(ip) || [];
  timestamps.push(Date.now());
  dailyIpTracker.set(ip, timestamps);
}

// Simple email validation
function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * POST /api/lead-magnet/execute
 * Body: { email: string, taskInput: string, skillId?: string }
 * Returns: { executionId: string }
 */
router.post('/execute', async (req, res) => {
  try {
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
    if (isEmailRateLimited(email)) {
      return res.status(429).json({
        message: 'Rate limit exceeded. You can run one free task per day.',
      });
    }

    // Rate limiting — IP (5 per day)
    // Note: req.ip returns ::1 or ::ffff:127.0.0.1 behind a proxy without 'trust proxy' set.
    // If running behind nginx/ALB, ensure app.set('trust proxy', 1) is configured in server.ts.
    const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
    if (isIpRateLimited(clientIp)) {
      return res.status(429).json({
        message: 'Too many requests from this address. Please try again later.',
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
    recordEmailUsage(email);
    recordIpUsage(clientIp);

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

export default router;

// Export for testing
export { dailyEmailTracker, dailyIpTracker };
