import React, { useState, useEffect, useRef } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useLocation } from 'react-router-dom';
import axios from 'axios';
import { Button, Box, Typography, CircularProgress, TextField, IconButton, Tooltip, Chip, Alert } from '@mui/material';
import ChatIcon from '@mui/icons-material/Chat';
import CloseIcon from '@mui/icons-material/Close';
import SendIcon from '@mui/icons-material/Send';
import SmartToy from '@mui/icons-material/SmartToy';
import Person from '@mui/icons-material/Person';
import AddCircleOutline from '@mui/icons-material/AddCircleOutline';
import DescriptionIcon from '@mui/icons-material/Description';
import NavigationIcon from '@mui/icons-material/Navigation';
import { getPageTitle } from '../utils/pageTitles';

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
  pageContext?: string;
}

const ChatSupport: React.FC = () => {
  const { token } = useAuth();
  const location = useLocation();
  const [isOpen, setIsOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [session, setSession] = useState<ChatSession | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [currentPage, setCurrentPage] = useState<string>('');
  const [showPageNotification, setShowPageNotification] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:3001';

  // Update page info when route changes
  useEffect(() => {
    if (isOpen) {
      const pageTitle = getPageTitle(location.pathname);
      const currentPageInfo = pageTitle;
      
      // Only show notification if page has actually changed
      if (currentPage && currentPage !== currentPageInfo) {
        if (session && session.sessionId) {
          const updatedMessages = [
            ...(session.messages || []),
            {
              role: 'assistant' as const,
              content: `📍 You are on page: ${currentPageInfo}`
            }
          ];
          setSession({
            ...session,
            messages: updatedMessages
          });
        }
      }
      
      setCurrentPage(currentPageInfo);
    }
  }, [location.pathname, isOpen]);

  // Add page info when chat is first opened
  useEffect(() => {
    if (isOpen && session && session.sessionId && !currentPage) {
      const pageTitle = getPageTitle(location.pathname);
      const currentPageInfo = pageTitle;
      
      const updatedMessages = [
        ...(session.messages || []),
        {
          role: 'assistant' as const,
          content: `📍 You are on page: ${currentPageInfo}`
        }
      ];
      
      setSession({
        ...session,
        messages: updatedMessages
      });
      
      setCurrentPage(currentPageInfo);
      setShowPageNotification(true);
    }
  }, [isOpen, session]);

  // Create or get existing chat session
  useEffect(() => {
    if (token && isOpen && !session) {
      fetchOrCreateSession();
    }
  }, [token, isOpen]);

  // Manage page title when chat is opened/closed
  useEffect(() => {
    if (isOpen && session) {
      // Set chat-specific title when open
      document.title = `Chat Support - AgentWeb (${session.sessionId.substring(0, 8)}...)`;
    } else if (!isOpen) {
      // Restore page title when closed
      document.title = `AgentWeb - ${getPageTitle(location.pathname)}`;
    }
  }, [isOpen, session, location.pathname]);

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
        await createNewChatSession();
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
      
      // Create a copy of current session to restore if API call fails
      const currentSession = { ...session };
      
      // Optimistically update UI with properly typed message
      const updatedMessages: ChatMessage[] = [
        ...(session.messages || []),
        { role: 'user' as const, content: trimmedMessage }
      ];
      setSession({ ...session, messages: updatedMessages });
      
      // Send to backend with current URL
      const response = await axios.post(
        `${apiUrl}/api/chatbot/sessions/${session.sessionId}/messages`,
        { 
          message: trimmedMessage,
          currentUrl: window.location.pathname
        },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      
      // Check if the response contains valid session data
      if (response.data && response.data.session) {
        // Update with actual response from server
        setSession(response.data.session);
      } else if (response.data && response.data.response) {
        // If we just got a response without session update, append it to our local session
        const assistantMessage: ChatMessage = {
          role: 'assistant',
          content: response.data.response
        };
        setSession({
          ...currentSession,
          messages: [...updatedMessages, assistantMessage]
        });
      }
    } catch (error) {
      console.error('Error sending message:', error);
      // Show error message to user
      const assistantMessage: ChatMessage = {
        role: 'assistant',
        content: "I'm sorry, there was an error processing your message. Please try again."
      };
      
      // Keep the user's message and add error response
      if (session) {
        setSession({
          ...session,
          messages: [
            ...session.messages.filter(msg => msg.role !== 'user' || msg.content !== message.trim()),
            { role: 'user', content: message.trim() },
            assistantMessage
          ]
        });
      }
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

  // Filter out system messages for display, but keep navigation messages
  const displayMessages = session?.messages.filter(msg => 
    msg.role !== 'system' || msg.content.startsWith('📍')
  ) || [];

  // Create a new chat session manually
  const createNewChatSession = async () => {
    try {
      setIsLoading(true);
      console.log('Creating new chat session');
      const createResponse = await axios.post(
        `${apiUrl}/api/chatbot/sessions`, 
        { currentUrl: window.location.pathname },
        { headers: { Authorization: `Bearer ${token}` } }
      );
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
    <>
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
              {/* Discord community notice */}
              <Box sx={{ 
                mb: 2,
                textAlign: 'center'
              }}>
                <Button
                  variant="text" 
                  size="small"
                  href="https://discord.gg/ec7yR3yG" 
                  target="_blank"
                  startIcon={<img src="https://assets-global.website-files.com/6257adef93867e50d84d30e2/636e0a6a49cf127bf92de1e2_icon_clyde_blurple_RGB.png" alt="Discord" style={{ width: 16, height: 16 }} />}
                  sx={{ 
                    color: '#5865F2',
                    textTransform: 'none',
                    fontSize: '0.85rem',
                    fontWeight: 500,
                    '&:hover': {
                      bgcolor: 'rgba(88, 101, 242, 0.08)'
                    }
                  }}
                >
                  Join Discord for Community Support
                </Button>
              </Box>

              {/* Page navigation notification */}
              {showPageNotification && (
                <Alert 
                  icon={<NavigationIcon fontSize="inherit" />}
                  severity="info" 
                  sx={{ 
                    mb: 2,
                    '& .MuiAlert-message': { width: '100%' }
                  }}
                  onClose={() => setShowPageNotification(false)}
                >
                  <Box sx={{ display: 'flex', flexDirection: 'column' }}>
                    <Typography variant="body2" sx={{ fontWeight: 500 }}>
                      You are now on:
                    </Typography>
                    <Typography variant="body2" component="div" sx={{ 
                      mt: 0.5, 
                      wordBreak: 'break-all',
                      fontWeight: 400,
                      backgroundColor: 'rgba(0, 0, 0, 0.04)',
                      p: 1,
                      borderRadius: 1,
                      fontSize: '0.8rem',
                      maxHeight: '60px',
                      overflow: 'auto'
                    }}>
                      {currentPage || 'Home Page'}
                    </Typography>
                  </Box>
                </Alert>
              )}

              {displayMessages.length === 0 ? (
                <Box sx={{ textAlign: 'center', color: 'text.secondary', mt: 5 }}>
                  <Typography variant="h6" sx={{ mb: 2 }}>How can I help you today?</Typography>
                  <Typography variant="body2" sx={{ fontSize: '0.9rem', px: 3 }}>
                    I can help answer general questions about AgentWeb, information on this page.
                  </Typography>
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
                      <Typography 
                        variant="body2" 
                        sx={{ 
                          whiteSpace: 'pre-wrap',
                          lineHeight: 1.5,
                          fontWeight: msg.role === 'user' ? 400 : 400,
                          letterSpacing: '0.1px',
                          '& ul, & ol': {
                            margin: '0',
                            padding: '0 0 0 20px'
                          },
                          '& li': {
                            margin: '0',
                            padding: '0'
                          },
                          '& a': {
                            color: msg.role === 'user' ? '#fff' : '#1976d2',
                            textDecoration: 'underline'
                          }
                        }}
                        dangerouslySetInnerHTML={{
                          __html: msg.content
                        }}
                      />
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
    </>
  );
};

export default ChatSupport; 