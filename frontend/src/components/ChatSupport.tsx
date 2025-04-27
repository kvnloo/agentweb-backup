import React, { useState, useEffect, useRef } from 'react';
import { useAuth } from '../contexts/AuthContext';
import axios from 'axios';
import { Button, Box, Typography, CircularProgress, TextField, IconButton, Tooltip } from '@mui/material';
import ChatIcon from '@mui/icons-material/Chat';
import CloseIcon from '@mui/icons-material/Close';
import SendIcon from '@mui/icons-material/Send';
import SmartToy from '@mui/icons-material/SmartToy';
import Person from '@mui/icons-material/Person';
import AddCircleOutline from '@mui/icons-material/AddCircleOutline';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ChatSession {
  sessionId: string;
  userId: string;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
}

const ChatSupport: React.FC = () => {
  const { token } = useAuth();
  const [isOpen, setIsOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [session, setSession] = useState<ChatSession | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:3001';

  // Create or get existing chat session
  useEffect(() => {
    if (token && isOpen && !session) {
      fetchOrCreateSession();
    }
  }, [token, isOpen]);

  // Scroll to bottom of messages
  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [session?.messages]);

  const fetchOrCreateSession = async () => {
    try {
      setIsLoading(true);
      // First try to get existing sessions
      const sessionsResponse = await axios.get(`${apiUrl}/api/chatbot/sessions`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      
      // If there are existing sessions, use the most recent one
      if (sessionsResponse.data && sessionsResponse.data.length > 0) {
        // Sort by updatedAt in descending order to get most recent
        const sortedSessions = [...sessionsResponse.data].sort(
          (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
        );
        setSession(sortedSessions[0]);
      } else {
        // Create a new session if none exist
        const createResponse = await axios.post(`${apiUrl}/api/chatbot/sessions`, {}, {
          headers: { Authorization: `Bearer ${token}` }
        });
        setSession(createResponse.data);
      }
    } catch (error) {
      console.error('Error fetching or creating chat session:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const sendMessage = async () => {
    if (!message.trim() || !session || isLoading) return;
    
    try {
      setIsLoading(true);
      const trimmedMessage = message.trim();
      setMessage('');
      
      // Optimistically update UI with properly typed message
      const updatedMessages: ChatMessage[] = [
        ...(session.messages || []),
        { role: 'user' as const, content: trimmedMessage }
      ];
      setSession({ ...session, messages: updatedMessages });
      
      // Send to backend
      const response = await axios.post(
        `${apiUrl}/api/chatbot/sessions/${session.sessionId}/messages`,
        { message: trimmedMessage },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      
      // Update with actual response from server
      setSession(response.data.session);
    } catch (error) {
      console.error('Error sending message:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  // Filter out system messages
  const displayMessages = session?.messages.filter(msg => msg.role !== 'system') || [];

  // Create a new chat session manually
  const createNewChatSession = async () => {
    try {
      setIsLoading(true);
      console.log('Creating new chat session');
      const createResponse = await axios.post(`${apiUrl}/api/chatbot/sessions`, {}, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setSession(createResponse.data);
      // Clear the message input when starting a new chat
      setMessage('');
      console.log('Created new session:', createResponse.data.sessionId);
    } catch (error) {
      console.error('Error creating new chat session:', error);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Box sx={{ position: 'fixed', bottom: 16, right: 16, zIndex: 1050 }}>
      {/* Chat toggle button */}
      {!isOpen ? (
        <Button
          variant="contained"
          color="primary"
          onClick={() => {
            console.log('Opening chat window');
            setIsOpen(true);
          }}
          sx={{ 
            borderRadius: '50%', 
            width: 56, 
            height: 56, 
            minWidth: 56
          }}
        >
          <ChatIcon />
        </Button>
      ) : (
        <Box 
          sx={{ 
            bgcolor: 'background.paper',
            borderRadius: 2,
            boxShadow: 3,
            display: 'flex',
            flexDirection: 'column',
            width: { xs: 320, md: 384 },
            height: 384,
            border: '1px solid',
            borderColor: 'divider'
          }}
        >
          {/* Header */}
          <Box sx={{ 
            bgcolor: 'primary.main',
            color: 'primary.contrastText',
            py: 1.5,
            px: 2,
            borderTopLeftRadius: 8,
            borderTopRightRadius: 8,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center'
          }}>
            <Box sx={{ display: 'flex', alignItems: 'center' }}>
              <SmartToy sx={{ mr: 1 }} />
              <Typography variant="subtitle1">AgentWeb Support</Typography>
            </Box>
            <Box>
              <Button
                variant="outlined"
                size="small"
                startIcon={<AddCircleOutline />}
                onClick={createNewChatSession}
                disabled={isLoading}
                sx={{ 
                  color: 'white', 
                  borderColor: 'rgba(255,255,255,0.5)',
                  mr: 1,
                  '&:hover': {
                    borderColor: 'white',
                    bgcolor: 'rgba(255,255,255,0.1)'
                  }
                }}
              >
                New Chat
              </Button>
              <IconButton 
                size="small" 
                onClick={() => setIsOpen(false)}
                sx={{ color: 'inherit' }}
              >
                <CloseIcon />
              </IconButton>
            </Box>
          </Box>

          {/* Messages */}
          <Box sx={{ 
            flexGrow: 1, 
            overflowY: 'auto', 
            p: 2,
            bgcolor: 'grey.50'
          }}>
            {displayMessages.length === 0 ? (
              <Box sx={{ textAlign: 'center', color: 'text.secondary', mt: 5 }}>
                <Typography>How can I help you today?</Typography>
              </Box>
            ) : (
              displayMessages.map((msg, index) => (
                <Box
                  key={index}
                  sx={{
                    mb: 2,
                    textAlign: msg.role === 'user' ? 'right' : 'left',
                    animation: 'fadeIn 0.3s ease-in-out',
                    '@keyframes fadeIn': {
                      from: { opacity: 0, transform: 'translateY(10px)' },
                      to: { opacity: 1, transform: 'translateY(0)' }
                    }
                  }}
                >
                  <Box
                    sx={{
                      display: 'inline-block',
                      p: 1.5,
                      borderRadius: 2.5,
                      maxWidth: '85%',
                      boxShadow: '0 1px 2px rgba(0,0,0,0.1)',
                      transition: 'all 0.2s ease',
                      '&:hover': {
                        boxShadow: '0 3px 6px rgba(0,0,0,0.15)'
                      },
                      ...(msg.role === 'user' 
                        ? { 
                            bgcolor: 'primary.main', 
                            color: 'primary.contrastText',
                            borderBottomRightRadius: 0,
                            background: 'linear-gradient(135deg, #4776E6 0%, #3451B2 100%)'
                          } 
                        : { 
                            bgcolor: 'grey.100', 
                            color: 'text.primary',
                            borderBottomLeftRadius: 0,
                            border: '1px solid rgba(0,0,0,0.05)'
                          })
                    }}
                  >
                    <Box sx={{ 
                      display: 'flex', 
                      alignItems: 'center', 
                      mb: 0.75,
                      pb: 0.75, 
                      borderBottom: '1px solid',
                      borderColor: msg.role === 'user' ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.05)'
                    }}>
                      {msg.role === 'assistant' ? (
                        <SmartToy sx={{ fontSize: 18, mr: 0.75, opacity: 0.9 }} />
                      ) : (
                        <Person sx={{ fontSize: 18, mr: 0.75, opacity: 0.9 }} />
                      )}
                      <Typography variant="caption" sx={{ fontWeight: 600, letterSpacing: '0.2px' }}>
                        {msg.role === 'assistant' ? 'Support' : 'You'}
                      </Typography>
                    </Box>
                    <Typography variant="body2" sx={{ 
                      whiteSpace: 'pre-wrap',
                      lineHeight: 1.5,
                      fontWeight: msg.role === 'user' ? 400 : 400,
                      letterSpacing: '0.1px'
                    }}>
                      {msg.content}
                    </Typography>
                  </Box>
                </Box>
              ))
            )}
            {isLoading && (
              <Box sx={{ textAlign: 'center', p: 1 }}>
                <CircularProgress size={20} color="primary" />
              </Box>
            )}
            <div ref={messagesEndRef} />
          </Box>

          {/* Input */}
          <Box sx={{ 
            borderTop: '1px solid',
            borderColor: 'divider',
            p: 1.5,
            bgcolor: 'background.paper',
            borderBottomLeftRadius: 8, 
            borderBottomRightRadius: 8
          }}>
            <Box sx={{ display: 'flex', alignItems: 'center' }}>
              <TextField
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                onKeyPress={handleKeyPress}
                placeholder="Type your message here..."
                fullWidth
                size="small"
                multiline
                rows={2}
                disabled={isLoading || !session}
                sx={{ mr: 1 }}
              />
              <IconButton
                color="primary"
                onClick={sendMessage}
                disabled={isLoading || !message.trim() || !session}
              >
                <SendIcon />
              </IconButton>
            </Box>
          </Box>
        </Box>
      )}
    </Box>
  );
};

export default ChatSupport; 