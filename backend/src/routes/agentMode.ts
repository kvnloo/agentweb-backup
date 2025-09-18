import express, { Request, Response } from 'express';
import { authenticateToken, AuthenticatedRequest, requireAdmin } from '../middleware/auth';
import { agentModeController } from '../controllers/agentModeController';

const router = express.Router();

// Helper function to wrap async handlers
const asyncHandler = (fn: (req: Request, res: Response, next: express.NextFunction) => Promise<any>) => {
  return (req: Request, res: Response, next: express.NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

// Public routes (no authentication required)
// GET /api/agent-mode/share/:shareId
// Get shared conversation (public)
router.get('/share/:shareId', asyncHandler(agentModeController.getSharedConversation));

// GET /api/agent-mode/public/welcome-message
// Get current welcome message (public)
router.get('/public/welcome-message', asyncHandler(agentModeController.getWelcomeMessage));

// GET /api/agent-mode/public/conversation-starters
// Get current conversation starters (public)
router.get('/public/conversation-starters', asyncHandler(agentModeController.getConversationStarters));

// All other routes require authentication
router.use(authenticateToken);

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

// GET /api/agent-mode/welcome-message
// Get current welcome message (admin only)
router.get('/welcome-message', requireAdmin, asyncHandler(agentModeController.getWelcomeMessage));

// GET /api/agent-mode/conversation-starters
// Get current conversation starters (admin only)
router.get('/conversation-starters', requireAdmin, asyncHandler(agentModeController.getConversationStarters));

// DELETE /api/agent-mode/session/:sessionId
// Archive a chat session
router.delete('/session/:sessionId', asyncHandler(agentModeController.archiveSession));

// PUT /api/agent-mode/session/:sessionId/task/:taskId/execution/:executionId/status
// Update task execution status in session
router.put('/session/:sessionId/task/:taskId/execution/:executionId/status', asyncHandler(agentModeController.updateTaskStatus));

// POST /api/agent-mode/share
// Create shareable link for conversation
router.post('/share', asyncHandler(agentModeController.createShareLink));

// DELETE /api/agent-mode/session/:sessionId/share
// Stop sharing conversation
router.delete('/session/:sessionId/share', asyncHandler(agentModeController.stopSharing));

export default router;