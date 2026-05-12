import { Request, Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import { chatbotDb, generateChatResponse } from '../services/chatbotService';
import { checkTokenUsage } from '../services/tokenUsageService';
import { userDb } from '../services/db';

// Create a new chat session
export const createChatSession = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { pageContext, pageIdentifier } = req.body; // Extract pageIdentifier from body
    const portalQuery = req.query.portal as string | undefined;

    let portalType: 'customer' | 'partner' = 'partner'; // Default to partner
    if (portalQuery === 'customer') {
      portalType = 'customer';
    } else if (portalQuery === 'partner') {
      portalType = 'partner';
    } else if (portalQuery) {
      console.warn(`Invalid portal type in createChatSession query: ${portalQuery}, defaulting to partner.`);
    }

    // Validate pageIdentifier if needed (e.g., ensure it's a string)
    if (pageIdentifier && typeof pageIdentifier !== 'string') {
      return res.status(400).json({ error: 'Invalid pageIdentifier format' });
    }

    const session = await chatbotDb.createChatSession(
      userId, 
      pageContext, 
      portalType, 
      pageIdentifier,
      undefined, // selectedStartupId
      undefined, // workflowId
      undefined, // executionId
      undefined, // emailCampaignTaskId
      'regular' // sessionType
    );
    
    res.status(201).json(session);
  } catch (error) {
    console.error('Error creating chat session:', error);
    res.status(500).json({ error: 'Failed to create chat session' });
  }
};

// Get all chat sessions for current user
export const listUserSessions = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const limitParam = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
    const result = await chatbotDb.getUserSessions(userId, undefined, limitParam);
    
    // Remove page content from response to reduce payload size
    const sanitizedSessions = result.sessions.map(session => {
      const { pageContent, contextChunks, ...rest } = session;
      return rest;
    });
    
    res.status(200).json(sanitizedSessions);
  } catch (error) {
    console.error('Error listing chat sessions:', error);
    res.status(500).json({ error: 'Failed to list chat sessions' });
  }
};

// List Emma (customer-portal) sessions only — filtered server-side
export const listEmmaSessions = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 20;
    const pageId = (req.query.pageIdentifier as string) || 'customer-portal';
    const sessions = await chatbotDb.getEmmaSessions(userId, limit, pageId);
    // Strip heavy fields not needed for the history list
    const sanitized = sessions.map(({ pageContent, contextChunks, ...rest }: any) => rest);
    res.status(200).json(sanitized);
  } catch (error) {
    console.error('Error listing Emma sessions:', error);
    res.status(500).json({ error: 'Failed to list Emma sessions' });
  }
};

// Get a specific chat session
export const getChatSession = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const sessionId = req.params.sessionId;
    const session = await chatbotDb.getChatSession(sessionId);
    
    if (!session) {
      return res.status(404).json({ error: 'Chat session not found' });
    }
    
    // Verify user has access to this session
    const userId = req.user?.userId;
    if (session.userId !== userId) {
      return res.status(403).json({ error: 'Unauthorized access to chat session' });
    }
    
    // Remove chunked context from response to reduce payload size
    const { contextChunks, ...sanitizedSession } = session;
    
    res.status(200).json(sanitizedSession);
  } catch (error) {
    console.error('Error getting chat session:', error);
    res.status(500).json({ error: 'Failed to get chat session' });
  }
};

// Send a message and get AI response
export const sendMessage = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const sessionId = req.params.sessionId;
    const { message, currentUrl, pageContext, structuredContext, screenshot, model } = req.body;
    const portal = req.query.portal as string | undefined;

    let portalType: 'customer' | 'partner' = 'partner'; // Default to partner
    if (portal === 'customer') {
      portalType = 'customer';
    } else if (portal === 'partner') {
      portalType = 'partner';
    } else if (portal) {
      // Optional: handle invalid portal query param, or let it default to partner
      console.warn(`Invalid portal type received: ${portal}, defaulting to partner.`);
    }
    
    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }
    
    // Verify session exists
    const session = await chatbotDb.getChatSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Chat session not found' });
    }
    
    // Verify user has access to this session
    const userId = req.user?.userId;
    if (session.userId !== userId) {
      return res.status(403).json({ error: 'Unauthorized access to chat session' });
    }

    // Check token usage limits
    if (userId) {
      const usageStatus = await checkTokenUsage(userId);
      if (!usageStatus.allowed) {
        return res.status(429).json({
          error: 'Monthly token limit reached. Please contact support or upgrade your plan.',
          tokenUsage: usageStatus,
        });
      }
    }

    try {
      // Generate response
      const delegateInfo = (req as any).delegateInfo;
      const isDelegatedAdmin = delegateInfo?.isDelegated === true;
      const adminEmail = isDelegatedAdmin ? delegateInfo.adminEmail : undefined;
      const orgRole = userId ? (await userDb.getUserById(userId))?.orgRole : undefined;
      const response = await generateChatResponse(sessionId, message, { currentUrl, pageContent: pageContext, portalType, userId, structuredContext, screenshot, model, isDelegatedAdmin: isDelegatedAdmin || undefined, adminEmail, orgRole });
      
      // Get updated session with the new messages
      const updatedSession = await chatbotDb.getChatSession(sessionId);
      
      // Return response in Agent Mode format (content + toolCalls)
      // Maintain backward compatibility: if response is string, wrap it
      const formattedResponse = typeof response === 'string'
        ? { content: response }
        : response; // Already { content, toolCalls }

      res.status(200).json({
        ...formattedResponse,  // content, toolCalls (if present)
        session: updatedSession
      });
    } catch (error) {
      console.error('Error in chatbot service:', error);

      // Get the session again to return it even if response generation failed
      const currentSession = await chatbotDb.getChatSession(sessionId);

      // Return an error message but also return the current session state
      // so the frontend can maintain continuity
      // Use 'content' key to match the normal response format
      res.status(200).json({
        content: "I'm sorry, I encountered an error processing your request. Please try again.",
        session: currentSession,
        error: true
      });
    }
  } catch (error) {
    console.error('Error sending message:', error);
    res.status(500).json({ error: 'Failed to process message' });
  }
};

// Send a message with SSE streaming for real-time tool call visibility
export const sendMessageStream = async (req: AuthenticatedRequest, res: Response) => {
  const sessionId = req.params.sessionId;
  const { message, currentUrl, pageContext, structuredContext, screenshot, model } = req.body;
  const portal = req.query.portal as string | undefined;

  const portalType: 'customer' | 'partner' = portal === 'customer' ? 'customer' : 'partner';

  // Auth guard — must be before any DB access so unauthenticated requests get 401, not 403
  const userId = req.user?.userId;
  if (!userId) {
    res.status(401).json({ error: 'User not authenticated' });
    return;
  }

  if (!message) {
    res.status(400).json({ error: 'Message is required' });
    return;
  }

  // Check token usage limits
  const usageStatus = await checkTokenUsage(userId);
  if (!usageStatus.allowed) {
    res.status(429).json({
      error: 'Monthly token limit reached. Please contact support or upgrade your plan.',
      tokenUsage: usageStatus,
    });
    return;
  }

  let session;
  try {
    session = await chatbotDb.getChatSession(sessionId);
  } catch (err) {
    res.status(500).json({ error: 'Failed to retrieve chat session' });
    return;
  }

  if (!session) {
    res.status(404).json({ error: 'Chat session not found' });
    return;
  }

  if (session.userId !== userId) {
    res.status(403).json({ error: 'Unauthorized access to chat session' });
    return;
  }

  // Set up SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendEvent = (data: object) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    // Flush immediately so the client receives events without buffering
    if (typeof (res as any).flush === 'function') {
      (res as any).flush();
    }
  };

  try {
    const delegateInfo = (req as any).delegateInfo;
    const isDelegatedAdmin = delegateInfo?.isDelegated === true;
    const adminEmail = isDelegatedAdmin ? delegateInfo.adminEmail : undefined;
    const orgRole = (await userDb.getUserById(userId))?.orgRole;
    const response = await generateChatResponse(
      sessionId, message,
      {
        currentUrl, pageContent: pageContext, portalType, userId,
        structuredContext, screenshot, model,
        isDelegatedAdmin: isDelegatedAdmin || undefined, adminEmail, orgRole,
        onToolStart: (toolName: string) => sendEvent({ type: 'tool_start', name: toolName })
      }
    );

    const updatedSession = await chatbotDb.getChatSession(sessionId);
    const formattedResponse = typeof response === 'string' ? { content: response } : response;

    sendEvent({ type: 'complete', ...formattedResponse, session: updatedSession });
  } catch (error) {
    console.error('Error in chatbot stream:', error);
    // getChatSession can itself throw (e.g. DB down). Wrap to avoid unhandled rejection
    // after SSE headers are already flushed.
    let currentSession = null;
    try {
      currentSession = await chatbotDb.getChatSession(sessionId);
    } catch {
      // Ignore — we still need to send the error event
    }
    sendEvent({
      type: 'complete',
      content: "I'm sorry, I encountered an error processing your request. Please try again.",
      session: currentSession,
      error: true
    });
  } finally {
    res.end();
  }
};

// Delete a chat session
export const deleteChatSession = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const sessionId = req.params.sessionId;
    
    // Verify session exists
    const session = await chatbotDb.getChatSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Chat session not found' });
    }
    
    // Verify user has access to this session
    const userId = req.user?.userId;
    if (session.userId !== userId) {
      return res.status(403).json({ error: 'Unauthorized access to chat session' });
    }
    
    await chatbotDb.deleteSession(sessionId);
    res.status(204).send();
  } catch (error) {
    console.error('Error deleting chat session:', error);
    res.status(500).json({ error: 'Failed to delete chat session' });
  }
}; 