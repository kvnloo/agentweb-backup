import express, { Request, Response } from 'express';
import { authenticateToken, AuthenticatedRequest, requireAdmin } from '../middleware/auth';
import { agentModeController } from '../controllers/agentModeController';
import multer from 'multer';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

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

// POST /api/agent-mode/run-scheduled-chats
// Run all scheduled chats that are ready to execute (called by agent-engine)
router.post('/run-scheduled-chats', asyncHandler(agentModeController.runScheduledChats));

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

// GET /api/agent-mode/function-calls
// Get available function calls for benchmark tests
router.get('/function-calls', asyncHandler(agentModeController.getAvailableFunctionCalls));

// POST /api/agent-mode/generate
// Generate AI response for marketing conversation
router.post('/generate', asyncHandler(agentModeController.generateResponse));

// POST /api/agent-mode/upload
// Upload file attachment for Agent Mode
router.post('/upload', upload.single('file'), asyncHandler(agentModeController.uploadAttachment));

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

// POST /api/agent-mode/scheduled-chats
// Create scheduled chat
router.post('/scheduled-chats', asyncHandler(agentModeController.createScheduledChat));

// GET /api/agent-mode/scheduled-chats
// Get user's scheduled chats
router.get('/scheduled-chats', asyncHandler(agentModeController.getScheduledChats));

// PUT /api/agent-mode/scheduled-chats/:scheduleId
// Update scheduled chat
router.put('/scheduled-chats/:scheduleId', asyncHandler(agentModeController.updateScheduledChat));

// POST /api/agent-mode/scheduled-chats/:scheduleId/test
// Test scheduled chat
router.post('/scheduled-chats/:scheduleId/test', asyncHandler(agentModeController.testScheduledChat));

// PATCH /api/agent-mode/scheduled-chats/:scheduleId/toggle
// Toggle scheduled chat status (enable/disable)
router.patch('/scheduled-chats/:scheduleId/toggle', asyncHandler(agentModeController.toggleScheduledChatStatus));

// DELETE /api/agent-mode/scheduled-chats/:scheduleId
// Delete scheduled chat
router.delete('/scheduled-chats/:scheduleId', asyncHandler(agentModeController.deleteScheduledChat));

// GET /api/agent-mode/scheduled-chats/:scheduleId/test-history
// Get test history for a scheduled chat
router.get('/scheduled-chats/:scheduleId/test-history', asyncHandler(agentModeController.getScheduledChatTestHistory));

export default router;