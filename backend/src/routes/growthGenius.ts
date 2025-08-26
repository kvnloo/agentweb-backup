import express from 'express';
import { authenticateToken } from '../middleware/auth';
import { growthGeniusController } from '../controllers/growthGeniusController';

const router = express.Router();

// All routes require authentication
router.use(authenticateToken);

// Create a new Growth Genius chat session
router.post('/sessions', growthGeniusController.createSession);

// Get all Growth Genius chat sessions for the authenticated user
router.get('/sessions', growthGeniusController.getSessions);

// Get a specific Growth Genius chat session
router.get('/sessions/:sessionId', growthGeniusController.getSession);

// Send a message in a Growth Genius chat session
router.post('/sessions/:sessionId/messages', growthGeniusController.sendMessage);

// Delete a Growth Genius chat session
router.delete('/sessions/:sessionId', growthGeniusController.deleteSession);

// Search knowledge base (Growth Genius specific)
router.get('/search', growthGeniusController.searchKnowledgeBase);

// Migrate existing sessions to genius portal type
router.post('/migrate-sessions', growthGeniusController.migrateSessions);

// Get session counts for debugging
router.get('/session-counts', growthGeniusController.getSessionCounts);

// Get archived sessions for admin management
router.get('/archived-sessions', growthGeniusController.getArchivedSessions);

export default router;
