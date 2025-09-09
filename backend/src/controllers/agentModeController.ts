import { Request, Response } from 'express';
import { agentModeService } from '../services/agentModeService';
import { chatbotDb } from '../services/chatbotService';
import { UserPayload } from '../types/auth';

export const agentModeController = {
  // Get user's agent chat sessions
  async getSessions(req: Request, res: Response) {
    try {
      const user = req.user as UserPayload;
      console.log(`AgentMode: Getting sessions for user ${user.userId}`);

      const sessions = await chatbotDb.getUserSessions(user.userId, 'agent');
      res.json(sessions);
    } catch (error) {
      console.error('AgentMode: Get sessions error:', error);
      res.status(500).json({ error: 'Failed to get sessions' });
    }
  },

  // Create new agent chat session
  async createSession(req: Request, res: Response) {
    try {
      const user = req.user as UserPayload;
      const { portalType = 'agent', pageIdentifier = 'agent-mode' } = req.body;

      console.log(`AgentMode: Creating new session for user ${user.userId}`);

      const session = await chatbotDb.createChatSession(
        user.userId,
        undefined, // pageContent
        portalType,
        pageIdentifier,
        undefined, // selectedStartupId
        undefined, // workflowId
        undefined  // executionId
      );

      res.status(201).json(session);
    } catch (error) {
      console.error('AgentMode: Create session error:', error);
      res.status(500).json({ error: 'Failed to create session' });
    }
  },

  // Get specific chat session
  async getSession(req: Request, res: Response) {
    try {
      const { sessionId } = req.params;
      console.log(`AgentMode: Getting session ${sessionId}`);

      const session = await chatbotDb.getChatSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      res.json(session);
    } catch (error) {
      console.error('AgentMode: Get session error:', error);
      res.status(500).json({ error: 'Failed to get session' });
    }
  },

  // Generate AI response for marketing conversation
  async generateResponse(req: Request, res: Response) {
    try {
      const user = req.user as UserPayload;
      const { sessionId, userMessage } = req.body;

      if (!sessionId || !userMessage) {
        return res.status(400).json({ error: 'Session ID and user message are required' });
      }

      console.log(`AgentMode: Generating marketing response for session ${sessionId}`);

      // Get session
      const session = await chatbotDb.getChatSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      // Generate AI response
      const response = await agentModeService.generateMarketingResponse(
        userMessage,
        session.messages,
        user.userId
      );

      // Add assistant message to session
      const assistantMessage = {
        role: 'assistant' as const,
        content: response.content,
        metadata: {
          timestamp: new Date().toISOString(),
          portalType: 'agent',
          toolCalls: response.toolCalls,
          knowledgeBaseQueries: response.knowledgeBaseQueries,
          sources: response.sources
        }
      };

      await chatbotDb.addMessageToSession(sessionId, assistantMessage);

      res.json({
        content: response.content,
        toolCalls: response.toolCalls,
        knowledgeBaseQueries: response.knowledgeBaseQueries,
        sources: response.sources
      });
    } catch (error) {
      console.error('AgentMode: Generate response error:', error);
      res.status(500).json({ error: 'Failed to generate response' });
    }
  },

  // Archive a chat session
  async archiveSession(req: Request, res: Response) {
    try {
      const { sessionId } = req.params;
      const user = req.user as UserPayload;

      console.log(`AgentMode: Archiving session ${sessionId} for user ${user.userId}`);

      await chatbotDb.archiveSession(sessionId);
      res.json({ message: 'Session archived successfully' });
    } catch (error) {
      console.error('AgentMode: Archive session error:', error);
      res.status(500).json({ error: 'Failed to archive session' });
    }
  }
};