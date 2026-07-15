import { Request, Response } from 'express';
import { growthGeniusService } from '../services/growthGeniusService';
import { UserPayload } from '../middleware/auth';
import { chatbotDb } from '../services/chatbotService';

export const growthGeniusController = {
  // Create a new chat session
  async createSession(req: Request, res: Response) {
    try {
      const user = req.user as UserPayload;
      const { title, selectedStartupId } = req.body;

      console.log(`GrowthGenius: Creating session for user ${user.userId} with startup: ${selectedStartupId || 'none'}`);

      // Create session using the database with portalType: 'genius'
      const session = await chatbotDb.createChatSession(
        user.userId,
        title || 'Growth Strategy Session',
        'genius', // portalType
        'growth-genius-chat',
        selectedStartupId,
        undefined, // workflowId
        undefined, // executionId
        undefined, // emailCampaignTaskId
        'regular' // sessionType
      );

      // Add context message based on startup selection
      await growthGeniusController.addOrUpdateContextMessage(session.sessionId, selectedStartupId || 'no-startup', user.userId);

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
      const result = await chatbotDb.getUserSessions(
        user.userId, 
        'genius',  // portalType filter
        100,       // limit to prevent performance issues
        true       // sort by updatedAt descending (newest first)
      );
      
      console.log(`GrowthGenius: Found ${result.sessions.length} genius sessions for user ${user.userId}`);
      
      res.json(result.sessions);
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

  // Update session startup selection
  async updateSession(req: Request, res: Response) {
    try {
      const user = req.user as UserPayload;
      const { sessionId } = req.params;
      const { selectedStartupId } = req.body;

      console.log(`GrowthGenius: Updating session ${sessionId} startup selection to ${selectedStartupId} for user ${user.userId}`);

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

      // Update the session with new startup selection
      await chatbotDb.updateSessionStartupSelection(sessionId, selectedStartupId);

      // Add or update context message based on startup selection
      await growthGeniusController.addOrUpdateContextMessage(sessionId, selectedStartupId, user.userId);

      res.json({ message: 'Session startup selection updated successfully' });
    } catch (error) {
      console.error('GrowthGenius: Update session error:', error);
      res.status(500).json({ message: 'Failed to update session startup selection' });
    }
  },

  // Helper method to add or update context message
  async addOrUpdateContextMessage(sessionId: string, selectedStartupId: string, userId: string) {
    try {
      // Get user's startup profiles to build context message
      const userDb = require('../services/db').userDb;
      const userData = await userDb.getUserById(userId);
      
      if (!userData) {
        console.error('GrowthGenius: User not found for context message:', userId);
        return;
      }
      
      const userStartups = userData.startupProfiles || [];
      
      let contextContent: string;
      
      if (selectedStartupId !== 'no-startup') {
        // Find the selected startup
        const startup = userStartups.find((s: any) => s.id === selectedStartupId);
        if (startup) {
          // Build context message with only non-empty fields
          let contextParts = [`🎯 **Startup Context**\n\nI'm focusing on **${startup.companyName}**`];
          
          // Add industry if available
          if (startup.industry && startup.industry.trim()) {
            contextParts.push(`(${startup.industry} industry`);
            
            // Add company size if available
            if (startup.companySize && startup.companySize.trim()) {
              contextParts.push(`, ${startup.companySize}`);
            }
            contextParts.push(')');
          } else if (startup.companySize && startup.companySize.trim()) {
            // Only company size available
            contextParts.push(`(${startup.companySize})`);
          }
          
          contextParts.push('.\n');
          
          // Add target market if available
          if (startup.targetMarket && startup.targetMarket.trim()) {
            contextParts.push(`**Target Market:** ${startup.targetMarket}\n`);
          }
          
          // Add current challenges if available
          if (startup.currentChallenges && startup.currentChallenges.trim()) {
            contextParts.push(`**Current Challenges:** ${startup.currentChallenges}\n`);
          }
          
          // Add goals if available
          if (startup.goals && startup.goals.trim()) {
            contextParts.push(`**Goals:** ${startup.goals}\n`);
          }
          
          contextParts.push('\nI\'ll tailor my advice specifically for this startup\'s context.');
          contextContent = contextParts.join('');
        } else {
          // Startup not found, use generic context
          contextContent = `🎯 **Context**\n\nI'm focusing on generic business advice. I'll provide insights based on the business details you describe in our conversation. Feel free to share information about your company, industry, challenges, and goals so I can tailor my advice accordingly.`;
        }
      } else {
        // Generic business context
        contextContent = `🎯 **Context**\n\nI'm focusing on generic business advice. I'll provide insights based on the business details you describe in our conversation. Feel free to share information about your company, industry, challenges, and goals so I can tailor my advice accordingly.`;
      }

      // Check if the last message is a context message
      const session = await chatbotDb.getChatSession(sessionId);
      if (session && session.messages && session.messages.length > 0) {
        const lastMessageIndex = session.messages.length - 1;
        const lastMessage = session.messages[lastMessageIndex];
        
        // If last message is a context message, replace it instead of adding new one
        if (lastMessage.metadata && lastMessage.metadata.isContextMessage) {
          // Update the last message content
          const updatedMessage = {
            ...lastMessage,
            content: contextContent,
            timestamp: new Date().toISOString()
          };
          
          // Replace the last message in the session
          await chatbotDb.updateMessageInSession(sessionId, lastMessageIndex, updatedMessage);
          return;
        }
      }

      // If no context message to replace, add a new one
      const contextMessage = {
        role: 'assistant' as const,
        content: contextContent,
        timestamp: new Date().toISOString(),
        metadata: {
          portalType: 'genius' as const,
          timestamp: new Date().toISOString(),
          isContextMessage: true
        }
      };
      
      await chatbotDb.addMessageToSession(sessionId, contextMessage);
    } catch (error) {
      console.error('GrowthGenius: Failed to add/update context message:', error);
      // Don't fail the entire update if context message fails
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
        timestamp: new Date().toISOString(),
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
          const title = await growthGeniusService.generateSessionTitle(content, user.userId);
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
        user.userId,
        session.selectedStartupId // Pass startup context
      );

      // Create assistant message object
      const assistantMessage = {
        role: 'assistant' as const,
        content: aiResponse.content,
        timestamp: new Date().toISOString(),
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
      const result = await chatbotDb.getUserSessions(user.userId, undefined, 200, false);
      
      // Filter sessions that don't have portalType: 'genius'
      const sessionsToMigrate = result.sessions.filter(session => 
        session.portalType !== 'genius'
      );

      console.log(`GrowthGenius: Found ${sessionsToMigrate.length} sessions to migrate out of ${result.sessions.length} total sessions`);

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
        totalSessions: result.sessions.length,
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
  },

  // Get all startup profiles for the user
  async getStartupProfiles(req: Request, res: Response) {
    try {
      const user = req.user as UserPayload;
      console.log(`GrowthGenius: Getting startup profiles for user ${user.userId}`);

      // Get user from database to access startup profiles
      const userDb = require('../services/db').userDb;
      const userData = await userDb.getUserById(user.userId);
      
      if (!userData) {
        return res.status(404).json({ message: 'User not found' });
      }

      const startupProfiles = userData.startupProfiles || [];
      res.json(startupProfiles);
    } catch (error) {
      console.error('GrowthGenius: Get startup profiles error:', error);
      res.status(500).json({ message: 'Failed to get startup profiles' });
    }
  },

  // Create a new startup profile
  async createStartupProfile(req: Request, res: Response) {
    try {
      const user = req.user as UserPayload;
      const { companyName, industry, companySize, targetMarket, currentChallenges, goals } = req.body;

      console.log(`GrowthGenius: Creating startup profile for user ${user.userId}`);

      if (!companyName || !industry) {
        return res.status(400).json({ message: 'Company name and industry are required' });
      }

      const userDb = require('../services/db').userDb;
      const userData = await userDb.getUserById(user.userId);
      
      if (!userData) {
        return res.status(404).json({ message: 'User not found' });
      }

      const newProfile = {
        id: `startup-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        companyName,
        industry,
        companySize: companySize || '',
        targetMarket: targetMarket || '',
        currentChallenges: currentChallenges || '',
        goals: goals || '',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      const existingProfiles = userData.startupProfiles || [];
      const updatedProfiles = [...existingProfiles, newProfile];

      await userDb.updateUser(user.userId, {
        startupProfiles: updatedProfiles
      });

      res.status(201).json(newProfile);
    } catch (error) {
      console.error('GrowthGenius: Create startup profile error:', error);
      res.status(500).json({ message: 'Failed to create startup profile' });
    }
  },

  // Update an existing startup profile
  async updateStartupProfile(req: Request, res: Response) {
    try {
      const user = req.user as UserPayload;
      const { profileId } = req.params;
      const { companyName, industry, companySize, targetMarket, currentChallenges, goals } = req.body;

      console.log(`GrowthGenius: Updating startup profile ${profileId} for user ${user.userId}`);

      if (!companyName || !industry) {
        return res.status(400).json({ message: 'Company name and industry are required' });
      }

      const userDb = require('../services/db').userDb;
      const userData = await userDb.getUserById(user.userId);
      
      if (!userData) {
        return res.status(404).json({ message: 'User not found' });
      }

      const existingProfiles = userData.startupProfiles || [];
      const profileIndex = existingProfiles.findIndex((p: any) => p.id === profileId);
      
      if (profileIndex === -1) {
        return res.status(404).json({ message: 'Startup profile not found' });
      }

      const updatedProfile = {
        ...existingProfiles[profileIndex],
        companyName,
        industry,
        companySize: companySize || '',
        targetMarket: targetMarket || '',
        currentChallenges: currentChallenges || '',
        goals: goals || '',
        updatedAt: new Date().toISOString()
      };

      existingProfiles[profileIndex] = updatedProfile;

      await userDb.updateUser(user.userId, {
        startupProfiles: existingProfiles
      });

      res.json(updatedProfile);
    } catch (error) {
      console.error('GrowthGenius: Update startup profile error:', error);
      res.status(500).json({ message: 'Failed to update startup profile' });
    }
  },

  // Delete a startup profile
  async deleteStartupProfile(req: Request, res: Response) {
    try {
      const user = req.user as UserPayload;
      const { profileId } = req.params;

      console.log(`GrowthGenius: Deleting startup profile ${profileId} for user ${user.userId}`);

      const userDb = require('../services/db').userDb;
      const userData = await userDb.getUserById(user.userId);
      
      if (!userData) {
        return res.status(404).json({ message: 'User not found' });
      }

      const existingProfiles = userData.startupProfiles || [];
      const updatedProfiles = existingProfiles.filter((p: any) => p.id !== profileId);

      await userDb.updateUser(user.userId, {
        startupProfiles: updatedProfiles
      });

      res.json({ message: 'Startup profile deleted successfully' });
    } catch (error) {
      console.error('GrowthGenius: Delete startup profile error:', error);
      res.status(500).json({ message: 'Failed to delete startup profile' });
    }
  }
};
