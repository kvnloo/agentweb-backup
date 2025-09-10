import { Request, Response } from 'express';
import { agentModeService } from '../services/agentModeService';
import { chatbotDb, updateTaskExecutionStatus } from '../services/chatbotService';
import { User } from '../types/auth';

export const agentModeController = {
  // Get user's agent chat sessions
  async getSessions(req: Request, res: Response) {
    try {
      const user = req.user as User;
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
      const user = req.user as User;
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
      const user = req.user as User;
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

      // Create user message object
      const userMessageObj = {
        role: 'user' as const,
        content: userMessage,
        timestamp: new Date().toISOString(),
        metadata: {
          portalType: 'agent' as const,
          timestamp: new Date().toISOString()
        }
      };

      // Check if this is the first user message (excluding system message)
      const userMessages = session.messages?.filter(msg => msg.role === 'user') || [];
      const isFirstMessage = userMessages.length === 0;

      // If this is the first message, add system message with version info first
      if (isFirstMessage) {
        try {
          // Get the current system prompt version
          const systemPrompt = await agentModeService.getMarketingSystemPrompt();
          const systemPromptHash = require('crypto').createHash('md5').update(systemPrompt).digest('hex').substring(0, 8);
          
          // Add system message with version info (hash only in metadata)
          const systemMessage = {
            role: 'system' as const,
            content: systemPrompt,
            metadata: {
              timestamp: new Date().toISOString(),
              portalType: 'agent' as const,
              systemPromptVersion: systemPromptHash
            }
          };
          
          await chatbotDb.addMessageToSession(sessionId, systemMessage);
          console.log('AgentMode: Added system message with version:', systemPromptHash);
        } catch (error) {
          console.error('AgentMode: Failed to add system message:', error);
          // Continue with the message processing even if this fails
        }
      }

      // Add user message to session in database
      await chatbotDb.addMessageToSession(sessionId, userMessageObj);

      // If this is the first message, generate session title
      if (isFirstMessage) {
        try {
          console.log('AgentMode: First message detected, generating session title');
          const title = await agentModeService.generateSessionTitle(userMessage);
          await chatbotDb.updateSessionTitle(sessionId, title);
          console.log('AgentMode: Session title updated to:', title);
        } catch (error) {
          console.error('AgentMode: Failed to update session title:', error);
          // Continue with the message processing even if this fails
        }
      }

      // Get updated session with the new user message
      const updatedSession = await chatbotDb.getChatSession(sessionId);
      if (!updatedSession) {
        return res.status(404).json({ error: 'Session not found after update' });
      }

      // Generate AI response
      const response = await agentModeService.generateMarketingResponse(
        userMessage,
        updatedSession.messages,
        user.userId,
        sessionId
      );

      // Add assistant message to session
      const assistantMessage = {
        role: 'assistant' as const,
        content: response.content,
        metadata: {
          timestamp: new Date().toISOString(),
          portalType: 'agent' as const,
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

  // Get system prompt
  async getSystemPrompt(req: Request, res: Response) {
    try {
      const systemPrompt = await agentModeService.getMarketingSystemPrompt();
      res.json(systemPrompt);
    } catch (error) {
      console.error('AgentMode: Get system prompt error:', error);
      res.status(500).json({ error: 'Failed to get system prompt' });
    }
  },

  // Archive a chat session
  async archiveSession(req: Request, res: Response) {
    try {
      const { sessionId } = req.params;
      const user = req.user as User;

      console.log(`AgentMode: Archiving session ${sessionId} for user ${user.userId}`);

      await chatbotDb.archiveSession(sessionId);
      res.json({ message: 'Session archived successfully' });
    } catch (error) {
      console.error('AgentMode: Archive session error:', error);
      res.status(500).json({ error: 'Failed to archive session' });
    }
  },

  // Update task execution status in session
  async updateTaskStatus(req: Request, res: Response) {
    try {
      const { sessionId, taskId, executionId } = req.params;
      const { status } = req.body;
      const user = req.user as User;
      
      console.log(`AgentMode: Updating task status for session ${sessionId}, task ${taskId}, execution ${executionId} to ${status}`);

      await updateTaskExecutionStatus(sessionId, taskId, executionId, status);
      res.json({ message: 'Task status updated successfully' });
    } catch (error) {
      console.error('AgentMode: Update task status error:', error);
      res.status(500).json({ error: 'Failed to update task status' });
    }
  }
};