import React, { useState, useEffect, useRef } from "react";
import { useAuth } from "../../contexts/AuthContext";
import { useLocation } from "react-router-dom";
import axios from "axios";
import { buildApiUrl } from "../../config";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { getPageTitle } from "../../utils/pageTitles";
import {
  MessageSquare,
  X as CloseIcon,
  Send as SendIcon,
  Bot,
  User,
  PlusCircle,
  Navigation,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { Alert, AlertDescription } from "../ui/alert";
import { io, Socket } from "socket.io-client";
import { DISCORD_INVITE_URL } from "@/config";
import { ScrollArea } from "@/components/ui/scroll-area";
import ReactMarkdown from "react-markdown";
import {
  AvatarFallback as NewAvatarFallback,
  AvatarImage as NewAvatarImage,
} from "@/components/ui/avatar";
import DOMPurify from "dompurify";

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatSession {
  sessionId: string;
  userId: string;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
  pageContext?: string;
  pageIdentifier?: string;
  portalType?: "customer" | "partner";
}

interface ChatSupportProps {
  isChatPanelCollapsed: boolean;
  onToggleChatPanel: () => void;
}

const ChatSupport: React.FC<ChatSupportProps> = ({
  isChatPanelCollapsed,
  onToggleChatPanel,
}) => {
  const { token } = useAuth();
  const location = useLocation();
  const [message, setMessage] = useState("");
  const [session, setSession] = useState<ChatSession | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [currentPage, setCurrentPage] = useState<string>("");
  const [showPageNotification, setShowPageNotification] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const socketRef = useRef<Socket | null>(null);
  const [socketConnected, setSocketConnected] = useState(false);
  const [useWebSockets, setUseWebSockets] = useState(false);
  const [reconnectAttempts, setReconnectAttempts] = useState(0);
  const apiUrl = import.meta.env.VITE_API_URL || "http://localhost:3001";

  // Initialize WebSocket connection
  useEffect(() => {
    let attemptCount = 0;

    if (token && useWebSockets) {
      try {
        socketRef.current = io(apiUrl, {
          auth: { token },
          reconnection: true,
          reconnectionAttempts: 3,
          reconnectionDelay: 1000,
          timeout: 5000,
        });

        socketRef.current.on("connect", () => {
          console.log("WebSocket connected");
          setSocketConnected(true);
          setReconnectAttempts(0);
          attemptCount = 0;
        });

        socketRef.current.on("connect_error", (error) => {
          console.error("WebSocket connection error:", error);
          setSocketConnected(false);
          attemptCount += 1;
          setReconnectAttempts(attemptCount);
          if (attemptCount >= 3) {
            console.log(
              "Falling back to HTTP-only mode after 3 failed attempts"
            );
            setUseWebSockets(false);
            if (socketRef.current) {
              socketRef.current.disconnect();
              socketRef.current = null;
            }
          }
        });

        socketRef.current.on("disconnect", (reason) => {
          console.log("WebSocket disconnected:", reason);
          setSocketConnected(false);
        });

        socketRef.current.on("message", (data) => {
          if (data.sessionId === session?.sessionId) {
            setSession((prevSession) => {
              if (!prevSession) return null;
              return {
                ...prevSession,
                messages: [
                  ...prevSession.messages,
                  { role: "assistant", content: data.content },
                ],
              };
            });
            setIsLoading(false);
          }
        });

        return () => {
          if (socketRef.current) {
            socketRef.current.disconnect();
            socketRef.current = null;
          }
        };
      } catch (error) {
        console.error("Error setting up WebSocket:", error);
        setUseWebSockets(false);
      }
    }
  }, [token, useWebSockets, session?.sessionId, apiUrl]);

  // Update page info when route changes
  useEffect(() => {
    const pageTitle = getPageTitle(location.pathname);
    const currentPageInfo = pageTitle;

    if (currentPage && currentPage !== currentPageInfo) {
      if (session && session.sessionId) {
        const updatedMessages = [
          ...(session.messages || []),
          {
            role: "assistant" as const,
            content: `📍 You are on page: ${currentPageInfo}`,
          },
        ];
        setSession({ ...session, messages: updatedMessages });
      }
    }
    setCurrentPage(currentPageInfo);
  }, [location.pathname, session, currentPage]);

  // Add page info when chat is first available (session exists and page info not yet set for current session)
  useEffect(() => {
    if (
      session &&
      session.sessionId &&
      session.pageIdentifier === location.pathname &&
      !currentPage
    ) {
      const pageTitle = getPageTitle(location.pathname);
      const currentPageInfo = pageTitle;
      const updatedMessages = [
        ...(session.messages || []),
        {
          role: "assistant" as const,
          content: `📍 You are on page: ${currentPageInfo}`,
        },
      ];
      setSession({ ...session, messages: updatedMessages });
      setCurrentPage(currentPageInfo);
      setShowPageNotification(true);
    }
  }, [session, location.pathname, currentPage]);

  // Create or get existing chat session when token or pathname changes
  useEffect(() => {
    if (token && !isChatPanelCollapsed) {
      fetchOrCreateSession();
    }
  }, [token, location.pathname, isChatPanelCollapsed]);

  // Manage page title when chat is opened/closed
  useEffect(() => {
    if (session) {
      document.title = `Chat Support - Customer Portal (${session.sessionId.substring(
        0,
        8
      )}...)`;
    } else {
      document.title = `Customer Portal - ${getPageTitle(location.pathname)}`;
    }
  }, [session, location.pathname]);

  // Scroll to bottom of messages
  useEffect(() => {
    if (messagesEndRef.current && !isChatPanelCollapsed) {
      messagesEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [session?.messages, isChatPanelCollapsed]);

  const fetchOrCreateSession = async () => {
    try {
      setIsLoading(true);
      const currentPathname = location.pathname;

      const sessionsResponse = await axios.get(
        buildApiUrl("/api/chatbot/sessions"),
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );

      if (sessionsResponse.data && sessionsResponse.data.length > 0) {
        const sortedSessions = [...sessionsResponse.data].sort(
          (a: ChatSession, b: ChatSession) =>
            new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
        );

        // Filter for sessions matching the current pageIdentifier
        const pageSpecificSessions = sortedSessions.filter(
          (s: ChatSession) => s.pageIdentifier === currentPathname
        );

        if (pageSpecificSessions.length > 0) {
          setSession(pageSpecificSessions[0]); // Use the most recent page-specific session
        } else {
          await createNewChatSession(currentPathname); // Pass currentPathname to create new session for this page
        }
      } else {
        await createNewChatSession(currentPathname); // Pass currentPathname to create new session for this page
      }
    } catch (error) {
      console.error("Error fetching or creating chat session:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const sendMessage = async () => {
    if (!message.trim() || !session || isLoading) return;

    try {
      setIsLoading(true);
      const trimmedMessage = message.trim();
      setMessage("");

      // Create a copy of current session to restore if API call fails
      const currentSession = { ...session };

      // Get current page content for RAG
      const pageContent = document.querySelector("main")?.innerHTML || "";

      // Optimistically update UI with properly typed message
      const updatedMessages: ChatMessage[] = [
        ...(session.messages || []),
        { role: "user", content: trimmedMessage },
      ];
      setSession({ ...session, messages: updatedMessages });

      // Send message through WebSocket if connected, otherwise fallback to HTTP
      if (useWebSockets && socketRef.current?.connected) {
        socketRef.current.emit("message", {
          sessionId: session.sessionId,
          message: trimmedMessage,
          currentUrl: window.location.pathname,
          pageContext: pageContent,
          portal: "customer",
        });
      } else {
        // HTTP fallback
        const response = await axios.post(
          buildApiUrl(
            `/api/chatbot/sessions/${session.sessionId}/messages?portal=customer`
          ),
          {
            message: trimmedMessage,
            currentUrl: window.location.pathname,
            pageContext: pageContent,
          },
          { headers: { Authorization: `Bearer ${token}` } }
        );

        if (response.data && response.data.session) {
          setSession(response.data.session);
        } else if (response.data && response.data.response) {
          const assistantMessage: ChatMessage = {
            role: "assistant",
            content: response.data.response,
          };
          setSession({
            ...currentSession,
            messages: [...updatedMessages, assistantMessage],
          });
        }
        setIsLoading(false);
      }
    } catch (error) {
      console.error("Error sending message:", error);
      // Show error message to user
      const assistantMessage: ChatMessage = {
        role: "assistant",
        content:
          "I'm sorry, there was an error processing your message. Please try again.",
      };

      if (session) {
        setSession({
          ...session,
          messages: [
            ...session.messages.filter(
              (msg) => msg.role !== "user" || msg.content !== message.trim()
            ),
            { role: "user", content: message.trim() },
            assistantMessage,
          ],
        });
      }
      setIsLoading(false);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  // Filter out system messages for display, but keep navigation messages
  const displayMessages =
    session?.messages.filter(
      (msg) => msg.role !== "system" || msg.content.startsWith("📍")
    ) || [];

  // Modify createNewChatSession to accept pageIdentifier
  const createNewChatSession = async (pageIdentifier: string) => {
    try {
      setIsLoading(true);
      const createResponse = await axios.post(
        buildApiUrl("/api/chatbot/sessions?portal=customer"),
        {
          currentUrl: pageIdentifier, // currentUrl can be the pageIdentifier too
          pageContext: document.querySelector("main")?.innerHTML || "",
          pageIdentifier: pageIdentifier, // Send pageIdentifier in the body
        },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      setSession(createResponse.data);
      setMessage("");
    } catch (error) {
      console.error("Error creating new chat session:", error);
    } finally {
      setIsLoading(false);
    }
  };

  if (isChatPanelCollapsed) {
    return (
      <div className="fixed bottom-5 right-5 z-[100]">
        <Button
          onClick={onToggleChatPanel}
          className="rounded-full h-14 w-14 shadow-lg use-template-button flex items-center justify-center"
          size="icon"
          aria-label="Expand chat"
        >
          <MessageSquare className="h-7 w-7" />
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full w-full bg-white border-gray-200 dark:border-gray-700 overflow-hidden">
      <div className="bg-[#7E69AB] text-white py-3 px-4 flex justify-between items-center shrink-0">
        <div className="flex items-center">
          <Bot className="mr-2 h-5 w-5" />
          <h3 className="text-sm font-medium">Emma</h3>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => createNewChatSession(location.pathname)}
            disabled={isLoading}
            className="text-white hover:bg-[#9578C7] hover:text-white h-8 px-2 text-xs flex items-center gap-1"
            aria-label="Start new chat"
          >
            <PlusCircle className="h-4 w-4" />
            <span>New Chat</span>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={onToggleChatPanel}
            className="text-white hover:bg-[#9578C7] hover:text-white h-8 w-8"
            aria-label="Collapse chat"
          >
            <ChevronDown className="h-5 w-5" />
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3 bg-gray-50 dark:bg-gray-800">
        <div className="mb-2 text-center">
          <a
            href={DISCORD_INVITE_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-[#5865F2] inline-flex items-center hover:underline"
          >
            <img
              src="https://assets-global.website-files.com/6257adef93867e50d84d30e2/636e0a6a49cf127bf92de1e2_icon_clyde_blurple_RGB.png"
              alt="Discord"
              className="w-4 h-4 mr-1"
            />
            Join Discord for Community Support
          </a>
        </div>

        {showPageNotification && (
          <Alert className="mb-2" variant="default">
            <div className="flex items-start gap-2">
              <Navigation className="h-4 w-4 mt-0.5 text-blue-500" />
              <div>
                <p className="text-xs font-medium">You are now on:</p>
                <div className="mt-1 text-xs bg-gray-100 p-2 rounded text-gray-800 max-h-[60px] overflow-auto">
                  {currentPage || "Home Page"}
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
            <h4 className="text-base font-medium mb-2">
              Your 24/7 marketing operator.
            </h4>
            <p className="text-sm px-6">
              Ask Emma to run market research, plan and optimize campaigns, or
              track performance metrics.
            </p>
          </div>
        ) : (
          displayMessages.map((msg, index) => (
            <div
              key={index}
              className={`mb-3 ${
                msg.role === "user" ? "text-right" : "text-left"
              } animate-in fade-in slide-in-from-bottom-5`}
            >
              <div
                className={`inline-block p-3 rounded-lg max-w-[85%] shadow-sm
                  ${
                    msg.role === "user"
                      ? "bg-[#7E69AB] text-white rounded-br-none"
                      : "bg-white text-gray-800 border border-gray-100 rounded-bl-none"
                  }
                `}
              >
                <div
                  className={`flex items-center mb-1.5 pb-1.5 border-b ${
                    msg.role === "user" ? "border-white/20" : "border-gray-100"
                  }`}
                >
                  {msg.role === "assistant" ? (
                    <Bot className="h-4 w-4 mr-1.5 opacity-70" />
                  ) : (
                    <User className="h-4 w-4 mr-1.5 opacity-70" />
                  )}
                  <span className="text-xs font-semibold tracking-wide">
                    {msg.role === "assistant" ? "Emma" : "You"}
                  </span>
                </div>
                <div className="text-sm whitespace-normal leading-relaxed prose dark:prose-invert prose-sm max-w-full">
                  {msg.role === "assistant" ? (
                    <div
                      dangerouslySetInnerHTML={{
                        __html: DOMPurify.sanitize(msg.content, {
                          USE_PROFILES: { html: true },
                        }),
                      }}
                    />
                  ) : (
                    <div
                      dangerouslySetInnerHTML={{
                        __html: DOMPurify.sanitize(msg.content, {
                          USE_PROFILES: { html: true },
                        }),
                      }}
                    />
                  )}
                </div>
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

      <div className="border-t border-[#D6BCFA] dark:border-gray-700 p-3 bg-white dark:bg-gray-900 shrink-0">
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
            className="h-10 w-10 rounded-full flex-shrink-0 use-template-button"
          >
            <SendIcon className="h-5 w-5" />
          </Button>
        </div>
      </div>
    </div>
  );
};

export default ChatSupport;
