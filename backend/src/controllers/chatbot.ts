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

    const { pageContext } = req.body;
    const session = await chatbotDb.createChatSession(userId, pageContext);
    
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

    const sessions = await chatbotDb.getUserSessions(userId);
    
    // Remove page context from response to reduce payload size
    const sanitizedSessions = sessions.map(session => {
      const { pageContext, contextChunks, ...rest } = session;
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
      const response = await generateChatResponse(sessionId, message, currentUrl, pageContext);
      
      // Get updated session with the new messages
      const updatedSession = await chatbotDb.getChatSession(sessionId);
      
      // Return both the response and updated session
      res.status(200).json({ 
        response,
        session: updatedSession 
      });
    } catch (error) {
      console.error('Error in chatbot service:', error);
      
      // Get the session again to return it even if response generation failed
      const currentSession = await chatbotDb.getChatSession(sessionId);
      
      // Return an error message but also return the current session state
      // so the frontend can maintain continuity
      res.status(200).json({
        response: "I'm sorry, I encountered an error processing your request. Please try again.",
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