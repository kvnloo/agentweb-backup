import React, { useState, useEffect, useRef } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useLocation } from 'react-router-dom';
import axios from 'axios';
import { buildApiUrl } from '../../config';
import { Button } from '../ui/button';
import { Textarea } from '../ui/textarea';
import { getPageTitle } from '../../utils/pageTitles';
import { 
  MessageSquare, 
  X as CloseIcon, 
  Send as SendIcon, 
  Bot, 
  User, 
  PlusCircle, 
  Navigation 
} from 'lucide-react';
import { Alert, AlertDescription } from '../ui/alert';
import { io, Socket } from 'socket.io-client';

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
  const socketRef = useRef<Socket | null>(null);
  const [socketConnected, setSocketConnected] = useState(false);
  const [useWebSockets, setUseWebSockets] = useState(false); // Disabled by default - use HTTP only due to CORS issues
  const [reconnectAttempts, setReconnectAttempts] = useState(0);
  const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:3001';

  // Initialize WebSocket connection
  useEffect(() => {
    let attemptCount = 0;
    
    if (token && isOpen && useWebSockets) {
      try {
        // Initialize socket connection
        socketRef.current = io(apiUrl, {
          auth: { token },
          reconnection: true,
          reconnectionAttempts: 3,
          reconnectionDelay: 1000,
          timeout: 5000
        });

        // Handle connection events
        socketRef.current.on('connect', () => {
          console.log('WebSocket connected');
          setSocketConnected(true);
          setReconnectAttempts(0); // Reset counter on successful connection
          attemptCount = 0;
        });

        socketRef.current.on('connect_error', (error) => {
          console.error('WebSocket connection error:', error);
          setSocketConnected(false);
          
          // Increment reconnection attempt counter
          attemptCount += 1;
          setReconnectAttempts(attemptCount);
          
          // Disable WebSockets after multiple failures
          if (attemptCount >= 3) {
            console.log('Falling back to HTTP-only mode after 3 failed attempts');
            setUseWebSockets(false);
            if (socketRef.current) {
              socketRef.current.disconnect();
              socketRef.current = null;
            }
          }
        });

        socketRef.current.on('disconnect', (reason) => {
          console.log('WebSocket disconnected:', reason);
          setSocketConnected(false);
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
      } catch (error) {
        console.error('Error setting up WebSocket:', error);
        setUseWebSockets(false);
      }
    }
  }, [token, isOpen, useWebSockets]);

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
      document.title = `Chat Support - Customer Portal (${session.sessionId.substring(0, 8)}...)`;
    } else if (!isOpen) {
      // Restore page title when closed
      document.title = `Customer Portal - ${getPageTitle(location.pathname)}`;
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
      const sessionsResponse = await axios.get(buildApiUrl('/api/chatbot/sessions'), {
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
      if (useWebSockets && socketRef.current?.connected) {
        socketRef.current.emit('message', {
          sessionId: session.sessionId,
          message: trimmedMessage,
          currentUrl: window.location.pathname,
          pageContext: pageContent,
          portal: 'customer'
        });
      } else {
        // HTTP fallback
        const response = await axios.post(
          buildApiUrl(`/api/chatbot/sessions/${session.sessionId}/messages?portal=customer`),
          { 
            message: trimmedMessage,
            currentUrl: window.location.pathname,
            pageContext: pageContent
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

  // Filter out system messages for display, but keep navigation messages
  const displayMessages = session?.messages.filter(msg => 
    msg.role !== 'system' || msg.content.startsWith('📍')
  ) || [];

  // Create a new chat session manually
  const createNewChatSession = async () => {
    try {
      setIsLoading(true);
      const createResponse = await axios.post(
        buildApiUrl('/api/chatbot/sessions?portal=customer'),
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

  return (
    <>
      <div className="fixed bottom-4 right-4 z-50">
        {/* Chat toggle button */}
        {!isOpen ? (
          <Button
            variant="default"
            onClick={() => setIsOpen(true)}
            className="rounded-full w-14 h-14 min-w-14 shadow-md agent-gradient"
          >
            <MessageSquare className="h-6 w-6" />
          </Button>
        ) : (
          <div className="bg-white border border-[#D6BCFA] rounded-lg shadow-lg flex flex-col w-96 h-96">
            {/* Header */}
            <div className="bg-[#7E69AB] text-white py-3 px-4 rounded-t-lg flex justify-between items-center">
              <div className="flex items-center">
                <Bot className="mr-2 h-5 w-5" />
                <h3 className="text-sm font-medium">Customer Support</h3>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={createNewChatSession}
                  disabled={isLoading}
                  className="text-white hover:bg-[#9578C7] hover:text-white h-8 px-2 text-xs flex items-center gap-1"
                >
                  <PlusCircle className="h-4 w-4" />
                  <span>New Chat</span>
                </Button>
                <Button 
                  variant="ghost"
                  size="sm"
                  onClick={() => setIsOpen(false)}
                  className="text-white hover:bg-[#9578C7] hover:text-white h-8 w-8 p-0"
                >
                  <CloseIcon className="h-4 w-4" />
                </Button>
              </div>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto p-3 bg-gray-50">
              {/* Discord community notice */}
              <div className="mb-2 text-center">
                <a
                  href="https://discord.gg/ec7yR3yG" 
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-[#5865F2] inline-flex items-center hover:underline"
                >
                  <img src="https://assets-global.website-files.com/6257adef93867e50d84d30e2/636e0a6a49cf127bf92de1e2_icon_clyde_blurple_RGB.png" alt="Discord" className="w-4 h-4 mr-1" />
                  Join Discord for Community Support
                </a>
              </div>

              {/* Page navigation notification */}
              {showPageNotification && (
                <Alert className="mb-2" variant="default">
                  <div className="flex items-start gap-2">
                    <Navigation className="h-4 w-4 mt-0.5 text-blue-500" />
                    <div>
                      <p className="text-xs font-medium">You are now on:</p>
                      <div className="mt-1 text-xs bg-gray-100 p-2 rounded text-gray-800 max-h-[60px] overflow-auto">
                        {currentPage || 'Home Page'}
                      </div>
                    </div>
                    <Button 
                      variant="ghost" 
                      size="sm" 
                      className="h-5 w-5 p-0 ml-auto -mt-1 -mr-1"
                      onClick={() => setShowPageNotification(false)}
                    >
                      <CloseIcon className="h-3 w-3" />
                    </Button>
                  </div>
                </Alert>
              )}

              {displayMessages.length === 0 ? (
                <div className="text-center text-gray-500 mt-10">
                  <h4 className="text-base font-medium mb-2">How can I help you today?</h4>
                  <p className="text-sm px-6">
                    I can provide <strong>guidance about using the Customer Portal</strong> and <strong>answer questions about your current page</strong>.
                  </p>
                </div>
              ) : (
                displayMessages.map((msg, index) => (
                  <div
                    key={index}
                    className={`mb-3 ${msg.role === 'user' ? 'text-right' : 'text-left'} animate-in fade-in slide-in-from-bottom-5`}
                  >
                    <div
                      className={`inline-block p-3 rounded-lg max-w-[85%] shadow-sm
                        ${msg.role === 'user' 
                          ? 'bg-[#7E69AB] text-white rounded-br-none' 
                          : 'bg-white text-gray-800 border border-gray-100 rounded-bl-none'}
                      `}
                    >
                      <div className={`flex items-center mb-1.5 pb-1.5 border-b ${msg.role === 'user' ? 'border-white/20' : 'border-gray-100'}`}>
                        {msg.role === 'assistant' 
                          ? <Bot className="h-4 w-4 mr-1.5 opacity-70" /> 
                          : <User className="h-4 w-4 mr-1.5 opacity-70" />
                        }
                        <span className="text-xs font-semibold tracking-wide">
                          {msg.role === 'assistant' ? 'Support' : 'You'}
                        </span>
                      </div>
                      <div 
                        className="text-sm whitespace-normal leading-relaxed"
                        dangerouslySetInnerHTML={{
                          __html: msg.content
                        }}
                      />
                    </div>
                  </div>
                ))
              )}
              {isLoading && (
                <div className="flex justify-center p-2">
                  <div className="animate-spin h-5 w-5 border-2 border-[#7E69AB] border-t-transparent rounded-full" />
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Input */}
            <div className="border-t border-[#D6BCFA] p-3 bg-white rounded-b-lg">
              <div className="flex items-center gap-2">
                <Textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  onKeyDown={handleKeyPress}
                  placeholder="Type your message here..."
                  className="resize-none text-sm min-h-[60px]"
                  disabled={isLoading || !session}
                />
                <Button
                  size="icon"
                  onClick={sendMessage}
                  disabled={isLoading || !message.trim() || !session}
                  className="h-10 w-10 rounded-full flex-shrink-0 agent-gradient"
                >
                  <SendIcon className="h-5 w-5" />
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
};

export default ChatSupport; 