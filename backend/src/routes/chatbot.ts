import express, { Request, Response } from 'express';
import { authenticateToken, requireAdmin, AuthenticatedRequest } from '../middleware/auth';
import {
  createChatSession,
  listUserSessions,
  listEmmaSessions,
  getChatSession,
  sendMessage,
  sendMessageStream,
  deleteChatSession
} from '../controllers/chatbot';
import { getEmmaSystemContext } from '../services/chatbotService';

const router = express.Router();

// Admin-only: get the full Emma sidebar system prompt (base + addendum) for display in admin UI
router.get('/system-prompt', authenticateToken, requireAdmin, (req: Request, res: Response) => {
  res.json(getEmmaSystemContext());
});

// All chatbot routes require authentication
router.use(authenticateToken);

// Create a new chat session
router.post('/sessions', (req: Request, res: Response) => createChatSession(req as AuthenticatedRequest, res));

// List all chat sessions for the current user
router.get('/sessions', (req: Request, res: Response) => listUserSessions(req as AuthenticatedRequest, res));

// List Emma (customer-portal) sessions only
router.get('/sessions/emma', (req: Request, res: Response) => listEmmaSessions(req as AuthenticatedRequest, res));

// Get a specific chat session
router.get('/sessions/:sessionId', (req: Request, res: Response) => getChatSession(req as AuthenticatedRequest, res));

// Send a message and get a response
router.post('/sessions/:sessionId/messages', (req: Request, res: Response) => sendMessage(req as AuthenticatedRequest, res));

// Send a message with SSE streaming for real-time tool call visibility
router.post('/sessions/:sessionId/messages/stream', (req: Request, res: Response) => sendMessageStream(req as AuthenticatedRequest, res));

// Delete a chat session
router.delete('/sessions/:sessionId', (req: Request, res: Response) => deleteChatSession(req as AuthenticatedRequest, res));

export default router; 