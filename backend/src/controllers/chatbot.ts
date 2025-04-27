import { Request, Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import { chatbotDb, generateChatResponse } from '../services/chatbotService';

// Create a new chat session for the current user
export const createChatSession = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user.userId;
    const session = await chatbotDb.createChatSession(userId);
    
    res.status(201).json(session);
  } catch (error: any) {
    console.error('Error creating chat session:', error);
    res.status(500).json({ message: 'Failed to create chat session', error: error.message });
  }
};

// List all chat sessions for the current user
export const listUserSessions = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user.userId;
    const sessions = await chatbotDb.getUserSessions(userId);
    
    res.json(sessions);
  } catch (error: any) {
    console.error('Error listing chat sessions:', error);
    res.status(500).json({ message: 'Failed to list chat sessions', error: error.message });
  }
};

// Get a specific chat session
export const getChatSession = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { sessionId } = req.params;
    const session = await chatbotDb.getChatSession(sessionId);
    
    if (!session) {
      return res.status(404).json({ message: 'Chat session not found' });
    }
    
    // Ensure user can only access their own sessions
    if (session.userId !== req.user.userId && !req.user.isAdmin) {
      return res.status(403).json({ message: 'Access denied' });
    }
    
    res.json(session);
  } catch (error: any) {
    console.error('Error retrieving chat session:', error);
    res.status(500).json({ message: 'Failed to retrieve chat session', error: error.message });
  }
};

// Send a message and get a response
export const sendMessage = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { sessionId } = req.params;
    const { message } = req.body;
    
    if (!message) {
      return res.status(400).json({ message: 'Message is required' });
    }
    
    // Validate session exists and belongs to user
    const session = await chatbotDb.getChatSession(sessionId);
    if (!session) {
      return res.status(404).json({ message: 'Chat session not found' });
    }
    
    if (session.userId !== req.user.userId && !req.user.isAdmin) {
      return res.status(403).json({ message: 'Access denied' });
    }
    
    // Generate response using Azure OpenAI
    const response = await generateChatResponse(sessionId, message);
    
    // Return the updated session with the new messages
    const updatedSession = await chatbotDb.getChatSession(sessionId);
    res.json({
      response,
      session: updatedSession
    });
  } catch (error: any) {
    console.error('Error sending message:', error);
    res.status(500).json({ message: 'Failed to process message', error: error.message });
  }
};

// Delete a chat session
export const deleteChatSession = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { sessionId } = req.params;
    
    // Validate session exists and belongs to user
    const session = await chatbotDb.getChatSession(sessionId);
    if (!session) {
      return res.status(404).json({ message: 'Chat session not found' });
    }
    
    if (session.userId !== req.user.userId && !req.user.isAdmin) {
      return res.status(403).json({ message: 'Access denied' });
    }
    
    await chatbotDb.deleteSession(sessionId);
    res.json({ message: 'Chat session deleted successfully' });
  } catch (error: any) {
    console.error('Error deleting chat session:', error);
    res.status(500).json({ message: 'Failed to delete chat session', error: error.message });
  }
}; 