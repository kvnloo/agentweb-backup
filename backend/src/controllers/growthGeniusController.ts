import { Request, Response } from 'express';
import { growthGeniusService } from '../services/growthGeniusService';
import { UserPayload } from '../middleware/auth';
import { chatbotDb } from '../services/chatbotService';

export const growthGeniusController = {
  // Create a new chat session
  async createSession(req: Request, res: Response) {
    try {
      const user = req.user as UserPayload;
      const { title } = req.body;

      console.log(`GrowthGenius: Creating session for user ${user.userId}`);

      // Create session using the database with portalType: 'genius'
      const session = await chatbotDb.createChatSession(
        user.userId,
        title || 'Growth Strategy Session',
        'genius', // portalType
        'growth-genius-chat'
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

      // Get only Growth Genius sessions for the user from the database
      // Use filtering at the database level for better performance
      const geniusSessions = await chatbotDb.getUserSessions(
        user.userId, 
        'genius',  // portalType filter
        100,       // limit to prevent performance issues
        true       // sort by updatedAt descending (newest first)
      );
      
      console.log(`GrowthGenius: Found ${geniusSessions.length} genius sessions for user ${user.userId}`);
      
      res.json(geniusSessions);
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

      // Get the session from the database
      const session = await chatbotDb.getChatSession(sessionId);
      
      if (!session) {
        return res.status(404).json({ message: 'Chat session not found' });
      }
      
      // Verify user has access to this session
      if (session.userId !== user.userId) {
        return res.status(403).json({ message: 'Unauthorized access to chat session' });
      }
      
      // Verify this is a Growth Genius session
      if (session.portalType !== 'genius') {
        return res.status(400).json({ message: 'Invalid session type' });
      }

      res.json(session);
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

      // Verify the session exists and belongs to the user
      const session = await chatbotDb.getChatSession(sessionId);
      if (!session) {
        return res.status(404).json({ message: 'Chat session not found' });
      }
      if (session.userId !== user.userId) {
        return res.status(403).json({ message: 'Unauthorized access to chat session' });
      }
      if (session.portalType !== 'genius') {
        return res.status(400).json({ message: 'Invalid session type' });
      }

      // Create user message object
      const userMessage = {
        role: 'user' as const,
        content,
        metadata: {
          portalType: 'genius' as const,
          timestamp: new Date().toISOString()
        }
      };

      // Add user message to session in database
      await chatbotDb.addMessageToSession(sessionId, userMessage);

      // Check if this is the first user message (excluding system messages)
      const userMessages = session.messages?.filter(msg => msg.role === 'user') || [];
      const isFirstMessage = userMessages.length === 0;

      // If this is the first message, generate a session title
      if (isFirstMessage) {
        try {
          console.log('GrowthGenius: First message detected, generating session title');
          const title = await growthGeniusService.generateSessionTitle(content);
          await chatbotDb.updateSessionTitle(sessionId, title);
          console.log('GrowthGenius: Session title updated to:', title);
        } catch (error) {
          console.error('GrowthGenius: Failed to update session title:', error);
          // Continue with the message processing even if title generation fails
        }
      }

      // Generate AI response using the service
      const aiResponse = await growthGeniusService.generateResponse(
        content,
        session.messages
          ?.filter(msg => msg.role !== 'system') // Filter out system messages
          ?.map(msg => ({
            id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            role: msg.role === 'user' ? 'user' : 'assistant', // Ensure only user/assistant roles
            content: msg.content,
            timestamp: new Date(msg.metadata?.timestamp || Date.now())
          })) || [], // Convert ChatMessage to GrowthGeniusMessage format
        user.userId
      );

      // Create assistant message object
      const assistantMessage = {
        role: 'assistant' as const,
        content: aiResponse.content,
        metadata: {
          portalType: 'genius' as const,
          timestamp: new Date().toISOString(),
          knowledgeBaseQueries: aiResponse.knowledgeBaseQueries,
          sources: aiResponse.sources
        }
      };

      // Add assistant message to session in database
      await chatbotDb.addMessageToSession(sessionId, assistantMessage);

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

  // Archive a chat session (soft delete)
  async deleteSession(req: Request, res: Response) {
    try {
      const user = req.user as UserPayload;
      const { sessionId } = req.params;

      console.log(`GrowthGenius: Archiving session ${sessionId} for user ${user.userId}`);

      // Get the session first to verify ownership and type
      const session = await chatbotDb.getChatSession(sessionId);
      
      if (!session) {
        return res.status(404).json({ message: 'Chat session not found' });
      }
      
      // Verify user has access to this session
      if (session.userId !== user.userId) {
        return res.status(403).json({ message: 'Unauthorized access to chat session' });
      }
      
      // Verify this is a Growth Genius session
      if (session.portalType !== 'genius') {
        return res.status(400).json({ message: 'Invalid session type' });
      }

      // Archive the session instead of deleting it
      await chatbotDb.archiveSession(sessionId);

      res.json({ message: 'Session archived successfully' });
    } catch (error) {
      console.error('GrowthGenius: Archive session error:', error);
      res.status(500).json({ message: 'Failed to archive chat session' });
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
  },

  // Migrate existing sessions to genius portal type
  async migrateSessions(req: Request, res: Response) {
    try {
      const user = req.user as UserPayload;
      console.log(`GrowthGenius: Migrating sessions for user ${user.userId}`);

      // Get all sessions for the user (no portal type filter for migration)
      const allSessions = await chatbotDb.getUserSessions(user.userId, undefined, 200, false);
      
      // Filter sessions that don't have portalType: 'genius'
      const sessionsToMigrate = allSessions.filter(session => 
        session.portalType !== 'genius'
      );

      console.log(`GrowthGenius: Found ${sessionsToMigrate.length} sessions to migrate out of ${allSessions.length} total sessions`);

      // Update each session to have portalType: 'genius'
      const migrationResults = [];
      for (const session of sessionsToMigrate) {
        try {
          const updatedSession = await chatbotDb.updateSessionPortalType(session.sessionId, 'genius');
          migrationResults.push({
            sessionId: session.sessionId,
            success: true,
            oldPortalType: session.portalType || 'undefined'
          });
          console.log(`GrowthGenius: Successfully migrated session ${session.sessionId} from ${session.portalType || 'undefined'} to genius`);
        } catch (error) {
          console.error(`GrowthGenius: Failed to migrate session ${session.sessionId}:`, error);
          migrationResults.push({
            sessionId: session.sessionId,
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
          });
        }
      }

      const successCount = migrationResults.filter(r => r.success).length;
      console.log(`GrowthGenius: Migration completed. ${successCount}/${sessionsToMigrate.length} sessions migrated successfully`);

      res.json({
        message: `Migration completed. ${successCount}/${sessionsToMigrate.length} sessions migrated successfully`,
        results: migrationResults,
        totalSessions: allSessions.length,
        migratedSessions: successCount
      });
    } catch (error) {
      console.error('GrowthGenius: Session migration error:', error);
      res.status(500).json({ message: 'Failed to migrate sessions' });
    }
  },

  // Get session counts for debugging
  async getSessionCounts(req: Request, res: Response) {
    try {
      const user = req.user as UserPayload;
      console.log(`GrowthGenius: Getting session counts for user ${user.userId}`);

      // Get counts for different portal types
      const allCount = await chatbotDb.getUserSessionCount(user.userId);
      const geniusCount = await chatbotDb.getUserSessionCount(user.userId, 'genius');
      const customerCount = await chatbotDb.getUserSessionCount(user.userId, 'customer');
      const partnerCount = await chatbotDb.getUserSessionCount(user.userId, 'partner');

      res.json({
        userId: user.userId,
        counts: {
          all: allCount,
          genius: geniusCount,
          customer: customerCount,
          partner: partnerCount
        }
      });
    } catch (error) {
      console.error('GrowthGenius: Get session counts error:', error);
      res.status(500).json({ message: 'Failed to get session counts' });
    }
  },

  // Get archived sessions for admin management
  async getArchivedSessions(req: Request, res: Response) {
    try {
      const user = req.user as UserPayload;
      const { portalType } = req.query;
      
      console.log(`GrowthGenius: Getting archived sessions for user ${user.userId}, portalType: ${portalType || 'all'}`);

      const archivedSessions = await chatbotDb.getArchivedSessions(
        user.userId, 
        portalType as "customer" | "partner" | "genius" | undefined
      );

      res.json(archivedSessions);
    } catch (error) {
      console.error('GrowthGenius: Get archived sessions error:', error);
      res.status(500).json({ message: 'Failed to get archived sessions' });
    }
  }
};
