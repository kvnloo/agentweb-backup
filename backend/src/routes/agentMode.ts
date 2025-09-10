import express, { Request, Response } from 'express';
import { authenticateToken, AuthenticatedRequest, requireAdmin } from '../middleware/auth';
import { agentModeController } from '../controllers/agentModeController';

const router = express.Router();

// All routes require authentication
router.use(authenticateToken);

// Helper function to wrap async handlers
const asyncHandler = (fn: (req: Request, res: Response, next: express.NextFunction) => Promise<any>) => {
  return (req: Request, res: Response, next: express.NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

// Agent Mode Chat Routes

// GET /api/agent-mode/sessions
// Get user's agent chat sessions
router.get('/sessions', asyncHandler(agentModeController.getSessions));

// POST /api/agent-mode/sessions
// Create new agent chat session
router.post('/sessions', asyncHandler(agentModeController.createSession));

// GET /api/agent-mode/session/:sessionId
// Get specific chat session
router.get('/session/:sessionId', asyncHandler(agentModeController.getSession));

// POST /api/agent-mode/generate
// Generate AI response for marketing conversation
router.post('/generate', asyncHandler(agentModeController.generateResponse));

// GET /api/agent-mode/system-prompt
// Get current system prompt (admin only)
router.get('/system-prompt', requireAdmin, asyncHandler(agentModeController.getSystemPrompt));

// DELETE /api/agent-mode/session/:sessionId
// Archive a chat session
router.delete('/session/:sessionId', asyncHandler(agentModeController.archiveSession));

// PUT /api/agent-mode/session/:sessionId/task/:taskId/execution/:executionId/status
// Update task execution status in session
router.put('/session/:sessionId/task/:taskId/execution/:executionId/status', asyncHandler(agentModeController.updateTaskStatus));

export default router;