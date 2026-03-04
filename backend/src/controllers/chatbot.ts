import { Request, Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import { chatbotDb, generateChatResponse } from '../services/chatbotService';

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

    const result = await chatbotDb.getUserSessions(userId);
    
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
    const { message, currentUrl, pageContext } = req.body;
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
    
    try {
      // Generate response
      const response = await generateChatResponse(sessionId, message, currentUrl, pageContext, portalType, userId);
      
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