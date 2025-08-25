import { Request, Response } from 'express';
import { growthGeniusService } from '../services/growthGeniusService';
import { UserPayload } from '../middleware/auth';

export const growthGeniusController = {
  // Create a new chat session
  async createSession(req: Request, res: Response) {
    try {
      const user = req.user as UserPayload;
      const { title, pageContext, pageIdentifier } = req.body;

      console.log(`GrowthGenius: Creating session for user ${user.userId}`);

      const session = await growthGeniusService.createSession(
        user.userId,
        title || pageContext || 'Growth Strategy Session'
      );

      res.status(201).json(session);
    } catch (error) {
      console.error('GrowthGenius: Create session error:', error);
      res.status(500).json({ message: 'Failed to create chat session' });
    }
  },

  // Get all chat sessions for the user
  async getSessions(req: Request, res: Response) {
    try {
      const user = req.user as UserPayload;
      console.log(`GrowthGenius: Getting sessions for user ${user.userId}`);

      // For now, return empty array - we'll implement session storage later
      // This prevents the 401 error while we build the full functionality
      res.json([]);
    } catch (error) {
      console.error('GrowthGenius: Get sessions error:', error);
      res.status(500).json({ message: 'Failed to get chat sessions' });
    }
  },

  // Get a specific chat session
  async getSession(req: Request, res: Response) {
    try {
      const user = req.user as UserPayload;
      const { sessionId } = req.params;

      console.log(`GrowthGenius: Getting session ${sessionId} for user ${user.userId}`);

      // For now, return a mock session - we'll implement session storage later
      const mockSession = {
        sessionId,
        userId: user.userId,
        title: 'Growth Strategy Session',
        messages: [],
        createdAt: new Date(),
        updatedAt: new Date(),
        portalType: 'genius' as const
      };

      res.json(mockSession);
    } catch (error) {
      console.error('GrowthGenius: Get session error:', error);
      res.status(500).json({ message: 'Failed to get chat session' });
    }
  },

  // Send a message in a chat session
  async sendMessage(req: Request, res: Response) {
    try {
      const user = req.user as UserPayload;
      const { sessionId } = req.params;
      const { content } = req.body;

      console.log(`GrowthGenius: Sending message in session ${sessionId} for user ${user.userId}`);

      if (!content || typeof content !== 'string') {
        return res.status(400).json({ message: 'Message content is required' });
      }

      // Create user message
      const userMessage = await growthGeniusService.addMessage(
        sessionId,
        user.userId,
        'user',
        content
      );

      // Generate AI response
      const aiResponse = await growthGeniusService.generateResponse(
        content,
        [userMessage], // For now, just the current message
        user.userId
      );

      // Create assistant message
      const assistantMessage = await growthGeniusService.addMessage(
        sessionId,
        user.userId,
        'assistant',
        aiResponse.content,
        {
          knowledgeBaseQueries: aiResponse.knowledgeBaseQueries,
          sources: aiResponse.sources
        }
      );

      // Return both messages
      res.json({
        userMessage,
        assistantMessage,
        sessionId
      });
    } catch (error) {
      console.error('GrowthGenius: Send message error:', error);
      res.status(500).json({ message: 'Failed to send message' });
    }
  },

  // Delete a chat session
  async deleteSession(req: Request, res: Response) {
    try {
      const user = req.user as UserPayload;
      const { sessionId } = req.params;

      console.log(`GrowthGenius: Deleting session ${sessionId} for user ${user.userId}`);

      // For now, just return success - we'll implement session deletion later
      res.json({ message: 'Session deleted successfully' });
    } catch (error) {
      console.error('GrowthGenius: Delete session error:', error);
      res.status(500).json({ message: 'Failed to delete chat session' });
    }
  },

  // Search knowledge base
  async searchKnowledgeBase(req: Request, res: Response) {
    try {
      const user = req.user as UserPayload;
      const { query } = req.query;

      if (!query || typeof query !== 'string') {
        return res.status(400).json({ message: 'Search query is required' });
      }

      console.log(`GrowthGenius: Searching knowledge base for "${query}" by user ${user.userId}`);

      const results = await growthGeniusService.searchKnowledgeBase(query, user.userId);

      res.json({
        query,
        results,
        count: results.length
      });
    } catch (error) {
      console.error('GrowthGenius: Search knowledge base error:', error);
      res.status(500).json({ message: 'Failed to search knowledge base' });
    }
  }
};
