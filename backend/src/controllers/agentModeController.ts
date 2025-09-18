import { Request, Response } from 'express';
import { agentModeService } from '../services/agentModeService';
import { chatbotDb, updateTaskExecutionStatus } from '../services/chatbotService';
import { User } from '../types/auth';
import multer from 'multer';
import { S3 } from 'aws-sdk';
import crypto from 'crypto';

const s3 = new S3();

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
      const { sessionId, userMessage, attachments } = req.body;

      if (!sessionId || !userMessage) {
        return res.status(400).json({ error: 'Session ID and user message are required' });
      }

      console.log(`AgentMode: Generating marketing response for session ${sessionId}`);

      // Get session
      const session = await chatbotDb.getChatSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      // Process attachments and include URLs in message content for LLM
      let messageContent = userMessage;
      if (attachments && attachments.length > 0) {
        const attachmentUrls = attachments.map((attachment: any) => {
          return `[${attachment.filename || 'Attachment'}](${attachment.url})`;
        }).join('\n');
        messageContent = `${userMessage}\n\n**Attached Files:**\n${attachmentUrls}`;
        
        // Also add structured attachment information for LLM processing
        const structuredAttachments = attachments.map((attachment: any) => {
          return `- **${attachment.filename}**: ${attachment.url} (${attachment.mimetype}, ${(attachment.size / 1024).toFixed(1)} KB)`;
        }).join('\n');
        messageContent += `\n\n**Attachment Details for Processing:**\n${structuredAttachments}`;
      }

      // Create user message object - store original content, not processed content
      const userMessageObj = {
        role: 'user' as const,
        content: userMessage, // Store original user message, not processed content
        timestamp: new Date().toISOString(),
        metadata: {
          portalType: 'agent' as const,
          timestamp: new Date().toISOString(),
          attachments: attachments || []
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
        messageContent,
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

  // Get welcome message
  async getWelcomeMessage(req: Request, res: Response) {
    try {
      const welcomeMessage = await agentModeService.getWelcomeMessage();
      res.json(welcomeMessage);
    } catch (error) {
      console.error('AgentMode: Get welcome message error:', error);
      res.status(500).json({ error: 'Failed to get welcome message' });
    }
  },

  // Get conversation starters
  async getConversationStarters(req: Request, res: Response) {
    try {
      const conversationStarters = await agentModeService.getConversationStarters();
      res.json(conversationStarters);
    } catch (error) {
      console.error('AgentMode: Get conversation starters error:', error);
      res.status(500).json({ error: 'Failed to get conversation starters' });
    }
  },

  // Create shareable link for conversation
  async createShareLink(req: Request, res: Response) {
    try {
      const user = req.user as User;
      const { sessionId } = req.body;

      if (!sessionId) {
        return res.status(400).json({ error: 'Session ID is required' });
      }

      // Verify the session belongs to the user
      const session = await chatbotDb.getChatSession(sessionId);
      if (!session || session.userId !== user.userId) {
        return res.status(404).json({ error: 'Session not found' });
      }

      // Use session ID as share ID
      const shareId = sessionId;
      
      // Add share metadata to the session (no expiration by default)
      const shareMetadata = {
        isShared: true,
        sharedAt: new Date().toISOString()
        // expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() // 30 days - disabled for now
      };

      // Update the session with share metadata
      await chatbotDb.updateSessionShareMetadata(sessionId, shareMetadata);

      res.json({ shareId });
    } catch (error) {
      console.error('AgentMode: Create share link error:', error);
      res.status(500).json({ error: 'Failed to create share link' });
    }
  },

  // Stop sharing conversation
  async stopSharing(req: Request, res: Response) {
    try {
      const user = req.user as User;
      const { sessionId } = req.params;

      // Verify the session belongs to the user
      const session = await chatbotDb.getChatSession(sessionId);
      if (!session || session.userId !== user.userId) {
        return res.status(404).json({ error: 'Session not found' });
      }

      // Remove share metadata from the session
      await chatbotDb.updateSessionShareMetadata(sessionId, { isShared: false });

      res.json({ success: true });
    } catch (error) {
      console.error('AgentMode: Stop sharing error:', error);
      res.status(500).json({ error: 'Failed to stop sharing' });
    }
  },

  // Get shared conversation
  async getSharedConversation(req: Request, res: Response) {
    try {
      const { shareId } = req.params;

      // Get the session data directly using shareId as sessionId
      const session = await chatbotDb.getChatSession(shareId);
      if (!session) {
        return res.status(404).json({ error: 'Conversation not found' });
      }

      // Check if the session is shared
      if (!session.shareMetadata?.isShared) {
        return res.status(404).json({ error: 'This conversation is not shared' });
      }

      // Check if expired (only if expiresAt is set)
      if (session.shareMetadata.expiresAt && new Date() > new Date(session.shareMetadata.expiresAt)) {
        // Remove share metadata if expired
        await chatbotDb.updateSessionShareMetadata(shareId, { isShared: false });
        return res.status(410).json({ error: 'Share link has expired' });
      }

      res.json({
        session: {
          sessionId: session.sessionId,
          title: session.title,
          messages: session.messages,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          shareMetadata: session.shareMetadata
        }
      });
    } catch (error) {
      console.error('AgentMode: Get shared conversation error:', error);
      res.status(500).json({ error: 'Failed to get shared conversation' });
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
  },

  // Upload file attachment for Agent Mode
  async uploadAttachment(req: Request, res: Response) {
    try {
      const user = req.user as User;
      const file = (req as any).file;

      if (!file) {
        return res.status(400).json({ error: 'No file uploaded' });
      }

      // Generate a random token (32 characters)
      const randomToken = Array.from(crypto.getRandomValues(new Uint8Array(16)))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

      // Sanitize filename to handle special characters and spaces for S3 key
      const sanitizedFilename = file.originalname
        .replace(/[^a-zA-Z0-9.-]/g, '_') // Replace special chars with underscores
        .replace(/\s+/g, '_'); // Replace spaces with underscores
      
      const key = `users/${user.userId}/attachments/${Date.now()}/${randomToken}/${sanitizedFilename}`;

      // Upload to S3
      await s3
        .putObject({
          Bucket: process.env.AWS_S3_BUCKET || "agentweb-user-files",
          Key: key,
          Body: file.buffer,
          ContentType: file.mimetype,
        })
        .promise();

      // Generate S3 URL
      const url = `https://${
        process.env.AWS_S3_BUCKET || "agentweb-user-files"
      }.s3.${process.env.AWS_REGION || "us-west-2"}.amazonaws.com/${key}`;

      res.json({
        url,
        key,
        filename: file.originalname,
        size: file.size,
        mimetype: file.mimetype,
        uploadedAt: new Date().toISOString()
      });
    } catch (error) {
      console.error('AgentMode: Upload attachment error:', error);
      res.status(500).json({ error: 'Failed to upload attachment' });
    }
  }
};