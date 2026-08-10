import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useLocation } from 'react-router-dom';
import axios from 'axios';
import { Button, Box, Typography, CircularProgress, TextField, IconButton, Alert, Menu, MenuItem, Tooltip } from '@mui/material';
import ChatIcon from '@mui/icons-material/Chat';
import CloseIcon from '@mui/icons-material/Close';
import SendIcon from '@mui/icons-material/Send';
import SmartToy from '@mui/icons-material/SmartToy';
import Person from '@mui/icons-material/Person';
import AddCircleOutline from '@mui/icons-material/AddCircleOutline';
import NavigationIcon from '@mui/icons-material/Navigation';
import OpenInFullIcon from '@mui/icons-material/OpenInFull';
import CloseFullscreenIcon from '@mui/icons-material/CloseFullscreen';
import TextFieldsIcon from '@mui/icons-material/TextFields';
import { getPageTitle } from '../utils/pageTitles';
import { Chart } from 'chart.js/auto';
import { io, Socket } from 'socket.io-client';
import { API_URL, DISCORD_INVITE_URL } from '../config';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | unknown[];
}

interface ChatSession {
  sessionId: string;
  userId: string;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
  pageContext?: string;
}

type ChatWidth = 'default' | 'wide';
type ChatFontSize = 'small' | 'default' | 'large';

interface ChatDisplayPreferences {
  width: ChatWidth;
  fontSize: ChatFontSize;
}

const DEFAULT_DISPLAY_PREFERENCES: ChatDisplayPreferences = {
  width: 'default',
  fontSize: 'default',
};

const CHAT_FONT_SIZES: Record<ChatFontSize, string> = {
  small: '0.78rem',
  default: '0.875rem',
  large: '1rem',
};

const displayPreferenceKey = (userId?: string) => `agentweb.chatDisplay.v1.${userId || 'anonymous'}`;

const loadDisplayPreferences = (userId?: string): ChatDisplayPreferences => {
  try {
    const stored = JSON.parse(localStorage.getItem(displayPreferenceKey(userId)) || '{}');
    return {
      width: stored.width === 'wide' ? 'wide' : 'default',
      fontSize: ['small', 'default', 'large'].includes(stored.fontSize)
        ? stored.fontSize
        : 'default',
    };
  } catch {
    return DEFAULT_DISPLAY_PREFERENCES;
  }
};

const ChatSupport: React.FC = () => {
  const { token, user } = useAuth();
  const location = useLocation();
  const [isOpen, setIsOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [session, setSession] = useState<ChatSession | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [currentPage, setCurrentPage] = useState<string>('');
  const [showPageNotification, setShowPageNotification] = useState(false);
  const [displayPreferences, setDisplayPreferences] = useState<ChatDisplayPreferences>(
    () => loadDisplayPreferences(user?.userId)
  );
  const [displayMenuAnchor, setDisplayMenuAnchor] = useState<HTMLElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const socketRef = useRef<Socket | null>(null);
  const apiUrl = API_URL;
  const chartRefs = useRef<{ [key: string]: HTMLCanvasElement }>({});

  useEffect(() => {
    setDisplayPreferences(loadDisplayPreferences(user?.userId));
  }, [user?.userId]);

  const updateDisplayPreferences = (
    update: (current: ChatDisplayPreferences) => ChatDisplayPreferences
  ) => {
    setDisplayPreferences((current) => {
      const next = update(current);
      try {
        localStorage.setItem(displayPreferenceKey(user?.userId), JSON.stringify(next));
      } catch {
        // Keep the in-memory preference usable when browser storage is unavailable.
      }
      return next;
    });
  };

  const toggleChatWidth = () => {
    updateDisplayPreferences((current) => ({
      ...current,
      width: current.width === 'wide' ? 'default' : 'wide',
    }));
  };

  const chooseFontSize = (fontSize: ChatFontSize) => {
    updateDisplayPreferences((current) => ({ ...current, fontSize }));
    setDisplayMenuAnchor(null);
  };

  // Initialize WebSocket connection
  useEffect(() => {
    if (token && isOpen) {
      // Initialize socket connection
      socketRef.current = io(apiUrl, {
        auth: { token },
        reconnection: true,
        reconnectionAttempts: 5,
        reconnectionDelay: 1000
      });

      // Handle connection events
      socketRef.current.on('connect', () => {
        console.log('WebSocket connected');
      });

      socketRef.current.on('connect_error', (error) => {
        console.error('WebSocket connection error:', error);
      });

      socketRef.current.on('disconnect', (reason) => {
        console.log('WebSocket disconnected:', reason);
      });

      // Handle chat events
      socketRef.current.on('message', (data) => {
        if (data.sessionId === session?.sessionId) {
          setSession(prevSession => {
            if (!prevSession) return null;
            return {
              ...prevSession,
              messages: [...prevSession.messages, {
                role: 'assistant',
                content: data.content
              }]
            };
          });
          setIsLoading(false);
        }
      });

      // Cleanup on unmount
      return () => {
        if (socketRef.current) {
          socketRef.current.disconnect();
          socketRef.current = null;
        }
      };
    }
  }, [token, isOpen, session?.sessionId]);

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

  useEffect(() => {
    // Clean up charts when component unmounts
    return () => {
      Object.values(chartRefs.current).forEach(canvas => {
        const chart = Chart.getChart(canvas);
        if (chart) {
          chart.destroy();
        }
      });
    };
  }, []);

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
      
      // Get current page content for RAG
      const pageContent = document.querySelector('main')?.innerHTML || '';
      
      // Optimistically update UI with properly typed message
      const updatedMessages: ChatMessage[] = [
        ...(session.messages || []),
        { role: 'user', content: trimmedMessage }
      ];
      setSession({ ...session, messages: updatedMessages });
      
      // Send message through WebSocket if connected, otherwise fallback to HTTP
      if (socketRef.current?.connected) {
        socketRef.current.emit('message', {
          sessionId: session.sessionId,
          message: trimmedMessage,
          currentUrl: window.location.pathname,
          pageContent: pageContent
        });
      } else {
        // Fallback to HTTP
        const response = await axios.post(
          `${apiUrl}/api/chatbot/sessions/${session.sessionId}/messages`,
          { 
            message: trimmedMessage,
            currentUrl: window.location.pathname,
            pageContent: pageContent
          },
          { headers: { Authorization: `Bearer ${token}` } }
        );
        
        if (response.data && response.data.session) {
          setSession(response.data.session);
        } else if (response.data && response.data.response) {
          const assistantMessage: ChatMessage = {
            role: 'assistant',
            content: response.data.response
          };
          setSession({
            ...currentSession,
            messages: [...updatedMessages, assistantMessage]
          });
        }
        setIsLoading(false);
      }
    } catch (error) {
      console.error('Error sending message:', error);
      // Show error message to user
      const assistantMessage: ChatMessage = {
        role: 'assistant',
        content: "I'm sorry, there was an error processing your message. Please try again."
      };
      
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
      setIsLoading(false);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const displayMessages = useMemo(() => session?.messages.filter(msg => {
    if (msg.role === 'system') return typeof msg.content === 'string' && msg.content.startsWith('📍');
    if (msg.role === 'tool') return false;
    if (msg.role === 'assistant' && typeof msg.content !== 'string') return false;
    return true;
  }) || [], [session?.messages]);

  // Create a new chat session manually
  const createNewChatSession = async () => {
    try {
      setIsLoading(true);
      const createResponse = await axios.post(
        `${apiUrl}/api/chatbot/sessions?portal=partner`,
        { 
          currentUrl: window.location.pathname,
          pageContext: document.querySelector('main')?.innerHTML || ''
        },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      setSession(createResponse.data);
      // Clear the message input when starting a new chat
      setMessage('');
    } catch (error) {
      console.error('Error creating new chat session:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const renderChart = (content: string) => {
    // Extract chart data from the content
    const canvasMatch = content.match(/<canvas[^>]*>([\s\S]*?)<\/canvas>/);
    if (!canvasMatch) return content;

    const scriptMatch = content.match(/<script>([\s\S]*?)<\/script>/);
    if (!scriptMatch) return content;

    const scriptContent = scriptMatch[1];
    const chartId = canvasMatch[0].match(/id="([^"]+)"/)?.[1] || 'chart-' + Math.random().toString(36).substr(2, 9);

    // Create a new canvas with the same ID
    const newCanvas = `<canvas id="${chartId}" width="600" height="300"></canvas>`;

    // Replace the original canvas with our new one
    let newContent = content.replace(canvasMatch[0], newCanvas);

    // Remove the script tag since we'll handle the chart creation separately
    newContent = newContent.replace(scriptMatch[0], '');

    // Use setTimeout to ensure the canvas is in the DOM before creating the chart
    setTimeout(() => {
      const canvas = document.getElementById(chartId) as HTMLCanvasElement;
      if (canvas) {
        // Destroy any existing chart on this canvas
        const existingChart = Chart.getChart(canvas);
        if (existingChart) {
          existingChart.destroy();
        }

        chartRefs.current[chartId] = canvas;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          try {
            // Extract data from the script content
            const labelsMatch = scriptContent.match(/const chartLabels = \[([\s\S]*?)\];/);
            const dataMatch = scriptContent.match(/const chartData = \[([\s\S]*?)\];/);
            
            if (labelsMatch && dataMatch) {
              // Clean and parse the arrays
              const labels = labelsMatch[1]
                .split(',')
                .map(label => {
                  // Extract just the date part before the comment
                  const datePart = label.split('//')[0].trim();
                  return datePart.replace(/"/g, '').replace(/'/g, '');
                });
              
              const data = dataMatch[1]
                .split(',')
                .map(num => parseInt(num.trim(), 10));

              // Create the chart using Chart.js
              new Chart(ctx, {
                type: 'line',
                data: {
                  labels: labels,
                  datasets: [{
                    label: 'Features Released',
                    data: data,
                    borderColor: '#1976d2',
                    backgroundColor: '#1976d2',
                    borderWidth: 2.5,
                    pointRadius: 6,
                    pointBackgroundColor: '#1976d2',
                    pointBorderColor: '#fff',
                    pointBorderWidth: 2,
                    fill: false
                  }]
                },
                options: {
                  responsive: false,
                  scales: {
                    y: {
                      beginAtZero: true,
                      ticks: {
                        stepSize: 1
                      }
                    },
                    x: {
                      ticks: {
                        maxRotation: 30,
                        minRotation: 30
                      }
                    }
                  }
                }
              });
            }
          } catch (error) {
            console.error('Error creating chart:', error);
          }
        }
      }
    }, 0);

    return newContent;
  };

  return (
    <>
      <Box sx={{ position: 'fixed', bottom: 16, right: 16, zIndex: 1050 }}>
        {/* Chat toggle button */}
        {!isOpen ? (
          <Button
            aria-label="Open support chat"
            variant="contained"
            color="primary"
            onClick={() => setIsOpen(true)}
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
            data-testid="chat-support-panel"
            data-chat-width={displayPreferences.width}
            sx={{ 
              bgcolor: 'background.paper',
              borderRadius: 2,
              boxShadow: 3,
              display: 'flex',
              flexDirection: 'column',
              width: displayPreferences.width === 'wide'
                ? { xs: 'calc(100vw - 32px)', sm: 'min(760px, calc(100vw - 32px))' }
                : { xs: 'calc(100vw - 32px)', sm: '384px' },
              height: 384,
              border: '1px solid',
              borderColor: 'divider',
              transition: 'width 180ms ease-out'
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
              <Box sx={{ display: 'flex', alignItems: 'center' }}>
                <Tooltip title="New chat">
                  <span>
                    <IconButton
                      aria-label="Start a new chat"
                      size="small"
                      onClick={createNewChatSession}
                      disabled={isLoading}
                      sx={{
                        color: 'white',
                        '&:hover': {
                          bgcolor: 'rgba(255,255,255,0.1)'
                        }
                      }}
                    >
                      <AddCircleOutline />
                    </IconButton>
                  </span>
                </Tooltip>
                <Tooltip title={displayPreferences.width === 'wide' ? 'Default width' : 'Wide chat'}>
                  <IconButton
                    aria-label={displayPreferences.width === 'wide' ? 'Use default chat width' : 'Use wide chat'}
                    size="small"
                    onClick={toggleChatWidth}
                    sx={{ color: 'inherit' }}
                  >
                    {displayPreferences.width === 'wide' ? <CloseFullscreenIcon /> : <OpenInFullIcon />}
                  </IconButton>
                </Tooltip>
                <Tooltip title="Text size">
                  <IconButton
                    aria-label="Chat display settings"
                    size="small"
                    onClick={(event) => setDisplayMenuAnchor(event.currentTarget)}
                    sx={{ color: 'inherit' }}
                  >
                    <TextFieldsIcon />
                  </IconButton>
                </Tooltip>
                <Menu
                  anchorEl={displayMenuAnchor}
                  open={Boolean(displayMenuAnchor)}
                  onClose={() => setDisplayMenuAnchor(null)}
                  MenuListProps={{ 'aria-label': 'Chat text size' }}
                >
                  {(['small', 'default', 'large'] as const).map((fontSize) => (
                    <MenuItem
                      key={fontSize}
                      selected={displayPreferences.fontSize === fontSize}
                      onClick={() => chooseFontSize(fontSize)}
                      aria-label={`${fontSize[0].toUpperCase()}${fontSize.slice(1)} text`}
                    >
                      {fontSize[0].toUpperCase()}{fontSize.slice(1)} text
                    </MenuItem>
                  ))}
                </Menu>
                <IconButton 
                  aria-label="Close support chat"
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
              bgcolor: 'grey.50',
              '& > *': {
                maxWidth: '100%',
                overflowX: 'auto'
              }
            }} data-testid="chat-messages" data-chat-font-size={displayPreferences.fontSize}>
              {/* Discord community notice */}
              <Box sx={{ 
                mb: 2,
                textAlign: 'center'
              }}>
                <Button
                  variant="text" 
                  size="small"
                  href={DISCORD_INVITE_URL} 
                  target="_blank"
                  rel="noopener noreferrer"
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
                    I can provide <strong>guidance about using AgentWeb</strong> and <strong>answer questions about your current page</strong>.
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
                        maxWidth: msg.role === 'assistant' && displayPreferences.width === 'wide' ? '100%' : '85%',
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
                        component="div"
                        variant="body2" 
                        sx={{ 
                          whiteSpace: 'normal',
                          overflowX: 'hidden',
                          fontSize: CHAT_FONT_SIZES[displayPreferences.fontSize],
                          lineHeight: 1.4,
                          fontWeight: msg.role === 'user' ? 400 : 400,
                          letterSpacing: '0.1px',
                          '& p': {
                            margin: 0,
                            padding: 0,
                            '& + p': {
                              marginTop: '0.5em'
                            }
                          },
                          '& ul, & ol': {
                            margin: '0.25em 0',
                            padding: '0 0 0 1.2em'
                          },
                          '& li': {
                            margin: 0,
                            padding: 0,
                            lineHeight: 1.3
                          },
                          '& li + li': {
                            marginTop: '0.1em'
                          },
                          '& a': {
                            color: msg.role === 'user' ? '#fff' : '#1976d2',
                            textDecoration: 'underline'
                          },
                          '& pre': {
                            backgroundColor: msg.role === 'user' ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.05)',
                            padding: '0.5em',
                            borderRadius: '4px',
                            overflowX: 'auto',
                            margin: '0.25em 0',
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-word'
                          },
                          '& code': {
                            backgroundColor: msg.role === 'user' ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.05)',
                            padding: '0.15em 0.3em',
                            borderRadius: '3px',
                            fontSize: '0.9em'
                          },
                          '& table': {
                            display: 'block',
                            maxWidth: '100%',
                            overflowX: 'auto',
                            borderCollapse: 'collapse',
                            whiteSpace: 'nowrap',
                            WebkitOverflowScrolling: 'touch'
                          },
                          '& th, & td': {
                            whiteSpace: 'nowrap'
                          }
                        }}
                        data-testid={`chat-message-content-${index}`}
                        dangerouslySetInnerHTML={{
                          __html: renderChart(typeof msg.content === 'string' ? msg.content : '')
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
