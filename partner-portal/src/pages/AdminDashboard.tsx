import React, { useEffect, useState } from "react";
import { useAdmin } from "../contexts/AdminContext";
import { Link as RouterLink, useSearchParams } from "react-router-dom";
import {
  Box,
  Tabs,
  Tab,
  Typography,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Button,
  CircularProgress,
  Alert,
  Grid,
  Card,
  CardContent,
  TextField,
  Chip,
  Container,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  DialogContentText,
  Tooltip,
  IconButton,
  FormControlLabel,
  Checkbox,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  FormGroup,
  Link,
} from "@mui/material";
import { format } from "date-fns";
import axios from "axios";
import { useAuth } from "../contexts/AuthContext";
import { buildApiUrl, CUSTOMER_FRONTEND_URL } from "../config";
import DOMPurify from "dompurify";
import ImageModelsSettings from "../components/admin/ImageModelsSettings";
import DefaultPromptsSettings from "../components/admin/DefaultPromptsSettings";
import BenchmarksTab from "../components/admin/BenchmarksTab";
import SubscriptionTypesTab from "../components/admin/SubscriptionTypesTab";
import McpServersTab from "../components/admin/McpServersTab";
import {
  UserGrowthChart,
  TaskGrowthChart,
  ExecutionTrendsChart,
  ExecutionStatusChart,
  UserTypeChart,
  AgentModeSessionGrowthChart,
  AgentModeSessionTypesChart,
} from "../components/admin/AdminCharts";
import {
  Info as InfoIcon,
  Close as CloseIcon,
  Handshake as HandshakeIcon,
  Person as PersonIcon,
  Edit as EditIcon,
  PersonOff as PersonOffIcon,
  Delete as DeleteIcon,
  PersonAdd as PersonAddIcon,
  Check as CheckIcon,
  OpenInNew as OpenInNewIcon,
  Lock as LockIcon,
  Add as AddIcon,
  ThumbUp as ThumbUpIcon,
  ThumbDown as ThumbDownIcon,
} from "@mui/icons-material";

interface TabPanelProps {
  children?: React.ReactNode;
  index: number;
  value: number;
}

function TabPanel(props: TabPanelProps) {
  const { children, value, index, ...other } = props;

  return (
    <div
      role="tabpanel"
      hidden={value !== index}
      id={`admin-tabpanel-${index}`}
      aria-labelledby={`admin-tab-${index}`}
      {...other}
    >
      {value === index && <Box sx={{ p: 3 }}>{children}</Box>}
    </div>
  );
}

function a11yProps(index: number) {
  return {
    id: `admin-tab-${index}`,
    "aria-controls": `admin-tabpanel-${index}`,
  };
}

interface WaitlistEntry {
  email: string;
  status: "pending" | "invited" | "rejected";
  createdAt: string;
  invitedAt?: string;
  fullName?: string;
  companyName?: string;
  phoneNumber?: string;
  joinedAt?: string;
  useCaseCategories?: string[];
  useCaseDescription?: string;
  requestReport?: boolean;
  supportNote?: string;
  stripe_customer_id?: string;
  monthlyMarketingSpend?: string;
  businessArea?: string;
  marketingChannels?: string[];
}

// Define ChatSession interface for the frontend, including portalType
interface AdminChatSession {
  sessionId: string;
  userId: string;
  messages: any[]; // Keeping messages as any for now, as per existing ChatDialog
  createdAt: string;
  updatedAt: string;
  pageContent?: string;
  contextChunks?: any[];
  portalType?: "customer" | "partner";
  sessionType?: "regular" | "predefined-work-plan" | "scheduled" | "image-generation" | "video-generation" | "book-generation" | "report_generation";
  shareMetadata?: {
    isShared: boolean;
    sharedAt?: string;
    expiresAt?: string;
  };
  interactiveShareMetadata?: {
    isActive: boolean;
    token?: string;
    sharedAt?: string;
  };
  workPlan?: {
    title: string;
    steps: Array<any>;
    createdAt: string;
    updatedAt: string;
    welcomeMessage?: string;
    autocomplete?: boolean;
  };
  // Add other fields if the backend sends more for the session list
}

interface User {
  userId: string;
  email: string;
  isAdmin: boolean;
  isActive: boolean;
  createdAt: string;
  lastLoginTime?: string;
  supportNote?: string;
  role?: "partner" | "customer" | "free"; // For single role from API
  roles?: ("partner" | "customer" | "free")[];
  taskCount?: number;
  workflowCount?: number;
  chatSessionCount?: number;
  isOAuthUser?: boolean; // Ensured from API structure
  stripe_customer_id?: string; // Added stripe_customer_id
  adAccount?: string; // Meta ad account ID
  emailDomain?: string; // Email sender domain
  defaultSenderUsername?: string; // Default sender username (e.g., noreply)
  fromName?: string; // From name for emails
  slackChannel?: string; // Default Slack channel for this user
  seoDomains?: string[]; // SEO domains to track
  googleAnalyticsPropertyId?: string; // Google Analytics Property ID
  gaFilteredDomains?: string[]; // Domains to exclude from Google Analytics
  clarityProjectId?: string; // Microsoft Clarity Project ID
  productDomain?: string; // Product site domain for feature usage tracking
  cmsType?: "Basehub" | "Webflow"; // CMS Type for blog publishing
  subscriptionType?: string; // Subscription type for customer portal users
}

// Define an interface for the task data shown in the admin tasks tab
interface AdminTask {
  taskId: string;
  name: string;
  prompt: string;
  userId: string;
  createdAt: string;
  latestRunStatus?: string;
  latestRunTime?: string | null;
  completedRuns?: number;
  totalRuns?: number;
  preferredLLM?: string;
  imageModel?: string;
  [key: string]: any; // Allow other properties if necessary
}

// Define an interface for the workflow data shown in the admin workflows tab
interface AdminWorkflow {
  workflowId: string;
  name: string;
  description: string;
  userId: string;
  createdAt: string;
  latestRunStatus?: string;
  latestRunTime?: string | null;
  completedRuns?: number;
  totalRuns?: number;
  completedTasks?: number;
  totalTasks?: number;
  [key: string]: any; // Allow other properties if necessary
}

// Define an interface for knowledge base metrics
interface KnowledgeBaseMetrics {
  totalTasks: number;
  tasksWithKnowledgeBase: number;
  totalKnowledgeBaseSize: number;
  averageKnowledgeBaseSize: number;
  uploadedFiles: {
    totalFiles: number;
    totalSize: number;
    tasksWithUploadedFiles: number;
    averageFilesPerTask: number;
    averageSizePerTask: number;
  };
  public: {
    tasks: number;
    tasksWithKnowledgeBase: number;
    totalSize: number;
    averageSize: number;
    uploadedFiles: {
      totalFiles: number;
      totalSize: number;
      tasksWithUploadedFiles: number;
      averageFilesPerTask: number;
      averageSizePerTask: number;
    };
  };
  private: {
    tasks: number;
    tasksWithKnowledgeBase: number;
    totalSize: number;
    averageSize: number;
    uploadedFiles: {
      totalFiles: number;
      totalSize: number;
      tasksWithUploadedFiles: number;
      averageFilesPerTask: number;
      averageSizePerTask: number;
    };
  };
  tasks: {
    taskId: string;
    name: string;
    knowledgeBaseSize: number;
    owner: string;
    type: "public" | "private";
    uploadedFilesCount?: number;
    uploadedFilesSize?: number;
  }[];
}

const ChatDialog = ({
  session,
  open,
  onClose,
}: {
  session: any;
  open: boolean;
  onClose: () => void;
}) => {
  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>
        Chat Session Details
        <IconButton
          aria-label="close"
          onClick={onClose}
          sx={{ position: "absolute", right: 8, top: 8 }}
        >
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers>
        {session && (
          <>
            <Typography variant="subtitle2" gutterBottom>
              Session ID: {session.sessionId}
            </Typography>
            <Typography variant="subtitle2" gutterBottom>
              User ID:{" "}
              <Link
                component={RouterLink}
                to={`/profile/${session.userId}`}
                color="primary"
                underline="hover"
              >
                {session.userId}
              </Link>
            </Typography>
            <Box sx={{ mt: 2 }}>
              {session.messages
                ?.filter((msg: any) => msg.role !== "system")
                .map((msg: any, index: number) => (
                  <Box
                    key={index}
                    sx={{
                      mb: 2,
                      p: 2,
                      borderRadius: 1,
                      backgroundColor:
                        msg.role === "user"
                          ? "grey.100"
                          : msg.role === "assistant"
                          ? "#e3f2fd"
                          : msg.role === "tool"
                          ? "#fff3e0" // Tool messages get a light orange background
                          : "#f3e5f5", // System messages get a light purple background
                      color: "text.primary",
                      border: msg.role !== "user" ? "1px solid" : "none",
                      borderColor:
                        msg.role === "assistant"
                          ? "#90caf9"
                          : msg.role === "tool"
                          ? "#ffb74d"
                          : msg.role === "system"
                          ? "#ce93d8"
                          : "transparent",
                      "& code": {
                        backgroundColor: "rgba(0, 0, 0, 0.04)",
                        padding: "2px 4px",
                        borderRadius: "4px",
                        fontFamily: "monospace",
                      },
                      "& pre": {
                        maxWidth: "360px",
                        overflow: "auto",
                        backgroundColor: "rgba(0, 0, 0, 0.04)",
                        padding: "8px",
                        borderRadius: "4px",
                        margin: "8px 0",
                      },
                      "& ul, & ol": {
                        marginTop: "4px",
                        marginBottom: "4px",
                        paddingLeft: "20px",
                      },
                      "& li": {
                        marginBottom: "2px",
                      },
                      "& p": {
                        marginTop: "4px",
                        marginBottom: "4px",
                      },
                      "& a": {
                        color: "#1976d2",
                        textDecoration: "none",
                        "&:hover": {
                          textDecoration: "underline",
                        },
                      },
                      "& table": {
                        maxWidth: "360px",
                        borderCollapse: "collapse",
                        margin: "8px 0",
                        "& th, & td": {
                          border: "1px solid rgba(0, 0, 0, 0.12)",
                          padding: "4px 8px",
                        },
                      },
                    }}
                  >
                    <Typography
                      variant="caption"
                      display="block"
                      gutterBottom
                      sx={{
                        color:
                          msg.role === "assistant"
                            ? "#1976d2"
                            : msg.role === "tool"
                            ? "#f57c00"
                            : msg.role === "system"
                            ? "#7b1fa2"
                            : "text.secondary",
                        fontWeight: "bold",
                        display: "flex",
                        alignItems: "center",
                        gap: 0.5,
                      }}
                    >
                      <span>
                        {msg.role.toUpperCase()}
                        {msg.metadata?.timestamp &&
                          !isNaN(new Date(msg.metadata.timestamp).getTime()) && (
                            <>
                              {" "}
                              -{" "}
                              {new Date(msg.metadata.timestamp).toLocaleString()}
                            </>
                          )}
                      </span>
                      {msg.role === "assistant" && msg.llm && (
                        <Chip label={msg.llm} size="small" sx={{ fontSize: '0.65rem', height: '18px' }} />
                      )}
                      {msg.role === "assistant" && msg.metadata?.feedback && (
                        <Tooltip title={`User feedback: ${msg.metadata.feedback.type}`}>
                          <Box sx={{ display: 'inline-flex', alignItems: 'center', ml: 0.5 }}>
                            {msg.metadata.feedback.type === 'like' ? (
                              <ThumbUpIcon sx={{ fontSize: '0.9rem', color: 'success.main' }} />
                            ) : (
                              <ThumbDownIcon sx={{ fontSize: '0.9rem', color: 'error.main' }} />
                            )}
                          </Box>
                        </Tooltip>
                      )}
                    </Typography>
                    <Box
                      sx={{
                        "& > div": {
                          overflow: "auto",
                          maxWidth: "100%",
                        },
                      }}
                    >
                      {/* Display content if available */}
                      {msg.content && (
                        <div
                          dangerouslySetInnerHTML={{
                            __html: DOMPurify.sanitize(msg.content, {
                              ADD_TAGS: [
                                "strong",
                                "em",
                                "code",
                                "ul",
                                "li",
                                "pre",
                                "a",
                                "table",
                                "tr",
                                "td",
                                "th",
                                "p",
                              ],
                              ADD_ATTR: ["href", "target"],
                            }),
                          }}
                        />
                      )}
                      
                      {/* Display tool calls for assistant messages */}
                      {msg.role === "assistant" && msg.tool_calls && msg.tool_calls.length > 0 && (
                        <Box sx={{ mt: 1 }}>
                          <Typography variant="caption" color="text.secondary" sx={{ fontWeight: "bold" }}>
                            Tool Calls:
                          </Typography>
                          {msg.tool_calls.map((toolCall: any, toolIndex: number) => (
                            <Box key={toolIndex} sx={{ mt: 1, p: 1, backgroundColor: "rgba(0, 0, 0, 0.03)", borderRadius: 1 }}>
                              <Typography variant="caption" sx={{ fontWeight: "bold" }}>
                                {toolCall.function?.name || toolCall.name}
                              </Typography>
                              {toolCall.function?.arguments && (
                                <pre style={{ fontSize: "0.75rem", margin: "4px 0 0 0", overflowX: "auto" }}>
                                  {JSON.stringify(JSON.parse(toolCall.function.arguments), null, 2)}
                                </pre>
                              )}
                            </Box>
                          ))}
                        </Box>
                      )}
                      
                      {/* Display tool message content */}
                      {msg.role === "tool" && (
                        <Box sx={{ mt: 1 }}>
                          <Typography variant="caption" color="text.secondary" sx={{ fontWeight: "bold" }}>
                            Tool Response ({msg.name}):
                          </Typography>
                          <pre style={{ fontSize: "0.75rem", margin: "4px 0 0 0", overflowX: "auto", whiteSpace: "pre-wrap" }}>
                            {msg.content}
                          </pre>
                        </Box>
                      )}

                      {/* Display user feedback for assistant messages */}
                      {msg.role === "assistant" && msg.metadata?.feedback && (
                        <Box sx={{ mt: 2, p: 1.5, backgroundColor: msg.metadata.feedback.type === 'like' ? 'rgba(76, 175, 80, 0.08)' : 'rgba(244, 67, 54, 0.08)', borderRadius: 1, borderLeft: `3px solid ${msg.metadata.feedback.type === 'like' ? '#4caf50' : '#f44336'}` }}>
                          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: msg.metadata.feedback.comment ? 1 : 0 }}>
                            {msg.metadata.feedback.type === 'like' ? (
                              <ThumbUpIcon sx={{ fontSize: '1rem', color: 'success.main' }} />
                            ) : (
                              <ThumbDownIcon sx={{ fontSize: '1rem', color: 'error.main' }} />
                            )}
                            <Typography variant="caption" sx={{ fontWeight: "bold", color: msg.metadata.feedback.type === 'like' ? 'success.dark' : 'error.dark' }}>
                              User Feedback
                            </Typography>
                            <Typography variant="caption" color="text.secondary" sx={{ ml: 'auto' }}>
                              {new Date(msg.metadata.feedback.timestamp).toLocaleString()}
                            </Typography>
                          </Box>
                          {msg.metadata.feedback.comment && (
                            <Typography variant="body2" sx={{ mt: 0.5, fontSize: '0.85rem', fontStyle: 'italic', color: 'text.secondary' }}>
                              "{msg.metadata.feedback.comment}"
                            </Typography>
                          )}
                        </Box>
                      )}
                    </Box>
                    {msg.metadata && (
                      <Box sx={{ mt: 1 }}>
                        <Typography variant="caption" color="text.secondary">
                          Metadata:
                        </Typography>
                        <pre
                          style={{
                            fontSize: "0.75rem",
                            margin: 0,
                            padding: "8px",
                            backgroundColor: "rgba(0, 0, 0, 0.03)",
                            borderRadius: "4px",
                            overflowX: "auto",
                          }}
                        >
                          {JSON.stringify(msg.metadata, null, 2)}
                        </pre>
                      </Box>
                    )}
                    {msg.usage && (
                      <Box sx={{ mt: 1 }}>
                        <Typography variant="caption" color="text.secondary">
                          Usage:
                        </Typography>
                        <pre
                          style={{
                            fontSize: "0.75rem",
                            margin: 0,
                            padding: "8px",
                            backgroundColor: "rgba(0, 0, 0, 0.03)",
                            borderRadius: "4px",
                            overflowX: "auto",
                          }}
                        >
                          {JSON.stringify(msg.usage, null, 2)}
                        </pre>
                      </Box>
                    )}
                  </Box>
                ))}
            </Box>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
};

export default function AdminDashboard() {
  const [searchParams, setSearchParams] = useSearchParams();
  
  // Tab mapping for URL parameters
  const TAB_MAP = {
    overview: 0,
    announcements: 1,
    users: 2,
    waitlist: 3,
    tasks: 4,
    workflows: 5,
    'chat-history': 6,
    'knowledge-base': 7,
    'agent-mode': 8,
    'image-models': 9,
    'default-prompts': 10,
    'benchmarks': 11,
    'subscriptions': 12,
    'mcp-servers': 13,
  };
  
  // Get initial tab value from URL or default to Users
  const getInitialTabValue = () => {
    const tabParam = searchParams.get('tab');
    return tabParam && TAB_MAP[tabParam as keyof typeof TAB_MAP] !== undefined 
      ? TAB_MAP[tabParam as keyof typeof TAB_MAP] 
      : TAB_MAP.users;
  };
  
  const [tabValue, setTabValue] = useState(getInitialTabValue());
  const [startDate, setStartDate] = useState<Date | null>(
    new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
  );
  const [endDate, setEndDate] = useState<Date | null>(new Date());
  const [tasks, setTasks] = useState<AdminTask[]>([]);
  const [orderBy, setOrderBy] = useState<string>("latestRunTime");
  const [order, setOrder] = useState<"asc" | "desc">("desc");
  const [usersOrderBy, setUsersOrderBy] = useState<keyof User>("createdAt");
  const [usersOrder, setUsersOrder] = useState<"asc" | "desc">("desc");
  const [waitlistOrderBy, setWaitlistOrderBy] = useState<keyof WaitlistEntry>("joinedAt");
  const [waitlistOrder, setWaitlistOrder] = useState<"asc" | "desc">("desc");
  const [message, setMessage] = useState("");
  const [title, setTitle] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [testDialogOpen, setTestDialogOpen] = useState(false);
  const [testRecipients, setTestRecipients] = useState("");
  const [testLoading, setTestLoading] = useState(false);
  const [htmlUrl, setHtmlUrl] = useState("");
  const [loadingHtml, setLoadingHtml] = useState(false);
  const [selectedUser, setSelectedUser] = useState<User | null>(null);
  const [deactivateDialogOpen, setDeactivateDialogOpen] = useState(false);
  const [chatSessions, setChatSessions] = useState<AdminChatSession[]>([]);
  const [chatSessionsLoading, setChatSessionsLoading] = useState(false);
  const [chatSessionsCursor, setChatSessionsCursor] = useState<string | null>(null);
  const [chatSessionsHasMore, setChatSessionsHasMore] = useState(true);
  const [chatSessionsInitialized, setChatSessionsInitialized] = useState(false);
  const [selectedSession, setSelectedSession] =
    useState<AdminChatSession | null>(null);
  const [chatDialogOpen, setChatDialogOpen] = useState(false);
  const [roleDialogOpen, setRoleDialogOpen] = useState(false);
  const [selectedUserRoles, setSelectedUserRoles] = useState<
    ("partner" | "customer" | "free")[]
  >([]);
  const [editingNoteEmail, setEditingNoteEmail] = useState<string | null>(null);
  const [currentNoteText, setCurrentNoteText] = useState("");
  const [noteEditLoading, setNoteEditLoading] = useState(false);
  const [editingSupportNoteUserId, setEditingSupportNoteUserId] = useState<string | null>(null);
  const [currentSupportNoteText, setCurrentSupportNoteText] = useState("");
  const [supportNoteEditLoading, setSupportNoteEditLoading] = useState(false);
  const [editingAdAccountUserId, setEditingAdAccountUserId] = useState<string | null>(null);
  const [currentAdAccountText, setCurrentAdAccountText] = useState("");
  const [adAccountEditLoading, setAdAccountEditLoading] = useState(false);
  const [emailSenderDialogOpen, setEmailSenderDialogOpen] = useState(false);
  const [editingEmailSenderUserId, setEditingEmailSenderUserId] = useState<string | null>(null);
  const [emailDomain, setEmailDomain] = useState("");
  const [defaultSenderUsername, setDefaultSenderUsername] = useState("");
  const [fromName, setFromName] = useState("");
  const [emailSenderEditLoading, setEmailSenderEditLoading] = useState(false);
  const [slackChannelDialogOpen, setSlackChannelDialogOpen] = useState(false);
  const [editingSlackChannelUserId, setEditingSlackChannelUserId] = useState<string | null>(null);
  const [currentSlackChannelText, setCurrentSlackChannelText] = useState("");
  const [slackChannelEditLoading, setSlackChannelEditLoading] = useState(false);
  const [seoDomainsDialogOpen, setSeoDomainsDialogOpen] = useState(false);
  const [editingSeoDomainsUserId, setEditingSeoDomainsUserId] = useState<string | null>(null);
  const [seoDomainsText, setSeoDomainsText] = useState("");
  const [googleAnalyticsPropertyId, setGoogleAnalyticsPropertyId] = useState("");
  const [gaFilteredDomainsText, setGaFilteredDomainsText] = useState("");
  const [clarityProjectId, setClarityProjectId] = useState("");
  const [productDomain, setProductDomain] = useState("");
  const [seoDomainsEditLoading, setSeoDomainsEditLoading] = useState(false);
  const [editingCmsTypeUserId, setEditingCmsTypeUserId] = useState<string | null>(null);
  const [currentCmsType, setCurrentCmsType] = useState<"Basehub" | "Webflow" | "">("");
  const [cmsTypeEditLoading, setCmsTypeEditLoading] = useState(false);
  const [editingSubscriptionTypeUserId, setEditingSubscriptionTypeUserId] = useState<string | null>(null);
  const [currentSubscriptionType, setCurrentSubscriptionType] = useState<string>("");
  const [subscriptionTypeEditLoading, setSubscriptionTypeEditLoading] = useState(false);
  const [availableSubscriptionTypes, setAvailableSubscriptionTypes] = useState<string[]>([]);
  const [delegateAccessLoading, setDelegateAccessLoading] = useState<string | null>(null);
  const [emailToDelete, setEmailToDelete] = useState<string | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [userIdToDelete, setUserIdToDelete] = useState<string | null>(null);
  const [userDeleteConfirmOpen, setUserDeleteConfirmOpen] = useState(false);
  const [workflows, setWorkflows] = useState<AdminWorkflow[]>([]);
  const [knowledgeBaseMetrics, setKnowledgeBaseMetrics] =
    useState<KnowledgeBaseMetrics | null>(null);
  const [createUserDialogOpen, setCreateUserDialogOpen] = useState(false);
  const [userToCreate, setUserToCreate] = useState<string | null>(null);
  const [createUserRoles, setCreateUserRoles] = useState<string[]>(["customer"]);
  const [createUserLoading, setCreateUserLoading] = useState(false);

  // Edit Waitlist Dialog state
  const [editWaitlistDialogOpen, setEditWaitlistDialogOpen] = useState(false);
  const [editWaitlistData, setEditWaitlistData] = useState<WaitlistEntry | null>(null);
  const [editWaitlistLoading, setEditWaitlistLoading] = useState(false);

  const { token } = useAuth();

  const {
    users: contextUsers,
    waitlist,
    taskAnalytics,
    userAnalytics,
    agentModeAnalytics,
    loadUsers,
    loadWaitlist,
    loadAnalytics,
    updateWaitlistStatus,
    loading: adminLoading,
    error: adminError,
    updateWaitlistSupportNote,
    deleteWaitlistEntry,
    deleteUser,
    addToWaitlist,
    createUserFromWaitlist,
    setUsers,
  } = useAdmin();

  // Manual invite modal state
  const [manualInviteOpen, setManualInviteOpen] = useState(false);
  const [manualInviteForm, setManualInviteForm] = useState({
    email: "",
    fullName: "",
    phoneNumber: "",
    companyName: "",
    useCaseCategories: [] as string[],
    useCaseDescription: "",
    requestReport: false,
    supportNote: "",
    monthlyMarketingSpend: "",
    businessArea: "",
    stripe_customer_id: "",
    sendInvitation: true,
    marketingChannels: [] as string[],
  });
  const [manualInviteLoading, setManualInviteLoading] = useState(false);

  // State for user tasks dialog
  const [userTasksDialogOpen, setUserTasksDialogOpen] = useState(false);
  const [userTasksDialogUserId, setUserTasksDialogUserId] = useState<string | null>(null);
  const [userTasksDialogUserEmail, setUserTasksDialogUserEmail] = useState<string | null>(null);

  // State for password reset dialog
  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false);
  const [passwordUserId, setPasswordUserId] = useState<string | null>(null);
  const [passwordUserEmail, setPasswordUserEmail] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [passwordResetLoading, setPasswordResetLoading] = useState(false);

  // Load users data only when Users tab (2) is selected
  useEffect(() => {
    if (tabValue === 2) {
      loadUsers();
      loadSubscriptionTypes();
    }
  }, [tabValue]);

  // Load subscription types
  const loadSubscriptionTypes = async () => {
    try {
      const response = await axios.get(buildApiUrl('/api/admin/subscription-types'), {
        headers: { Authorization: `Bearer ${token}` },
      });
      const types = response.data;
      // Extract type names, including "Basic" as default
      const typeNames = types.length > 0 
        ? types.map((t: any) => t.name)
        : ['Basic'];
      setAvailableSubscriptionTypes(typeNames);
    } catch (error) {
      console.error('Error loading subscription types:', error);
      // Default to Basic if loading fails
      setAvailableSubscriptionTypes(['Basic']);
    }
  };

  // Load waitlist data only when Waitlist tab (3) is selected
  useEffect(() => {
    if (tabValue === 3) {
      loadWaitlist();
      loadUsers(); // Also load users to check if waitlist entries are registered
    }
  }, [tabValue]);

  // Handle URL parameter changes
  useEffect(() => {
    const tabParam = searchParams.get('tab');
    if (tabParam && TAB_MAP[tabParam as keyof typeof TAB_MAP] !== undefined) {
      setTabValue(TAB_MAP[tabParam as keyof typeof TAB_MAP]);
      return;
    }
    setSearchParams({ tab: "users" });
    setTabValue(TAB_MAP.users);
  }, [searchParams, setSearchParams]);

  // Track last loaded dates to prevent unnecessary reloads
  const lastLoadedDatesRef = React.useRef<{ startDate: string; endDate: string } | null>(null);
  const chatSessionsLoadMoreRef = React.useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (startDate && endDate && tabValue === 0 && !adminLoading) {
      const startDateStr = format(startDate, "yyyy-MM-dd");
      const endDateStr = format(endDate, "yyyy-MM-dd");
      
      // Only load if dates have changed or we haven't loaded yet
      const lastLoaded = lastLoadedDatesRef.current;
      if (!lastLoaded || lastLoaded.startDate !== startDateStr || lastLoaded.endDate !== endDateStr) {
        lastLoadedDatesRef.current = { startDate: startDateStr, endDate: endDateStr };
        loadAnalytics(startDateStr, endDateStr);
      }
    }
    // Reset ref when switching tabs to allow reload when coming back
    if (tabValue !== 0) {
      lastLoadedDatesRef.current = null;
    }
  }, [startDate, endDate, tabValue, loadAnalytics, adminLoading]);

  useEffect(() => {
    const loadTasks = async () => {
      try {
        const response = await axios.get(buildApiUrl("/api/admin/tasks"), {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });
        setTasks(response.data as AdminTask[]);
      } catch (error) {
        console.error("Error loading tasks:", error);
      }
    };

    // Only load tasks when Tasks tab (4) is selected and we haven't loaded them yet
    if (tabValue === 4 && tasks.length === 0) {
      loadTasks();
    }
  }, [tabValue, token]);

  useEffect(() => {
    const loadWorkflows = async () => {
      try {
        const response = await axios.get(buildApiUrl("/api/admin/workflows"), {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });
        setWorkflows(response.data as AdminWorkflow[]);
      } catch (error) {
        console.error("Error loading workflows:", error);
      }
    };

    // Only load workflows when Workflows tab (5) is selected and we haven't loaded them yet
    if (tabValue === 5 && workflows.length === 0) {
      loadWorkflows();
    }
  }, [tabValue, token]);

  const loadChatSessions = React.useCallback(
    async (options?: { reset?: boolean }) => {
      if (!token || chatSessionsLoading) {
        return;
      }

      const shouldReset = options?.reset ?? false;
      const cursor = shouldReset ? null : chatSessionsCursor;

      try {
        setChatSessionsLoading(true);
        const params = new URLSearchParams();
        params.set("limit", "30");
        if (cursor) {
          params.set("cursor", cursor);
        }

        const response = await axios.get(
          buildApiUrl(`/api/admin/chat-sessions?${params.toString()}`),
          {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          }
        );

        const { sessions, nextCursor } = response.data as {
          sessions: AdminChatSession[];
          nextCursor: string | null;
        };

        setChatSessions((prev) => {
          if (shouldReset) {
            return sessions;
          }
          const seen = new Set(prev.map((session) => session.sessionId));
          const merged = [...prev];
          sessions.forEach((session) => {
            if (!seen.has(session.sessionId)) {
              merged.push(session);
              seen.add(session.sessionId);
            }
          });
          return merged;
        });
        setChatSessionsCursor(nextCursor);
        setChatSessionsHasMore(Boolean(nextCursor));
        setChatSessionsInitialized(true);
      } catch (error) {
        console.error("Error loading chat sessions:", error);
      } finally {
        setChatSessionsLoading(false);
      }
    },
    [token, chatSessionsCursor, chatSessionsLoading]
  );

  useEffect(() => {
    if (tabValue === 6 && !chatSessionsInitialized) {
      loadChatSessions({ reset: true });
    }
  }, [tabValue, chatSessionsInitialized, loadChatSessions]);

  useEffect(() => {
    if (tabValue !== 6 || !chatSessionsHasMore) {
      return;
    }

    const target = chatSessionsLoadMoreRef.current;
    if (!target) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const [entry] = entries;
        if (entry.isIntersecting && !chatSessionsLoading && chatSessionsHasMore) {
          loadChatSessions();
        }
      },
      { root: null, rootMargin: "200px", threshold: 0.1 }
    );

    observer.observe(target);
    return () => observer.disconnect();
  }, [tabValue, chatSessionsHasMore, chatSessionsLoading, loadChatSessions]);

  useEffect(() => {
    const loadKnowledgeBaseMetrics = async () => {
      try {
        const response = await axios.get(
          buildApiUrl("/api/admin/knowledge-base-metrics"),
          {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          }
        );
        setKnowledgeBaseMetrics(response.data);
      } catch (error) {
        console.error("Error loading knowledge base metrics:", error);
      }
    };

    // Only load knowledge base metrics when Knowledge Base tab (7) is selected and we haven't loaded them yet
    if (tabValue === 7 && !knowledgeBaseMetrics) {
      loadKnowledgeBaseMetrics();
    }
  }, [tabValue, token]);

  const handleTabChange = (_event: React.SyntheticEvent, newValue: number) => {
    setTabValue(newValue);
    
    // Update URL with the selected tab
    const tabName = Object.keys(TAB_MAP).find(key => TAB_MAP[key as keyof typeof TAB_MAP] === newValue);
    if (tabName && tabName !== 'overview') {
      setSearchParams({ tab: tabName });
    } else {
      setSearchParams({ tab: "overview" });
    }
  };

  const handleWaitlistAction = async (email: string, status: string) => {
    await updateWaitlistStatus(email, status);
  };

  const handleOpenDeleteConfirm = (email: string) => {
    setEmailToDelete(email);
    setDeleteConfirmOpen(true);
  };

  const handleCreateUserClick = (email: string) => {
    setUserToCreate(email);
    setCreateUserRoles(["customer"]);
    setCreateUserDialogOpen(true);
  };

  const handleCreateUser = async () => {
    if (!userToCreate) return;

    try {
      setCreateUserLoading(true);
      const result = await createUserFromWaitlist(userToCreate, createUserRoles);
      setSuccess(`User created successfully! Temporary password: ${result.temporaryPassword}. A welcome email with login credentials has been sent to ${userToCreate}.`);
      setCreateUserDialogOpen(false);
      setUserToCreate(null);
    } catch (error) {
      setError("Failed to create user");
    } finally {
      setCreateUserLoading(false);
    }
  };

  const handleCloseDeleteConfirm = () => {
    setEmailToDelete(null);
    setDeleteConfirmOpen(false);
  };

  const handleDeleteConfirmed = async () => {
    if (emailToDelete) {
      try {
        setLoading(true);
        await deleteWaitlistEntry(emailToDelete);
        setSuccess(`Waitlist entry for ${emailToDelete} deleted successfully.`);
        handleCloseDeleteConfirm();
      } catch (error) {
        let errorMessage = "Failed to delete waitlist entry";
        if (axios.isAxiosError(error) && error.response?.data?.message) {
          errorMessage = error.response.data.message;
        } else if (error instanceof Error) {
          errorMessage = error.message;
        }
        setError(errorMessage);
      } finally {
        setLoading(false);
      }
    }
  };

  const handleResendInvitation = async (email: string) => {
    try {
      setLoading(true);
      await axios.post(
        buildApiUrl("/api/admin/waitlist/resend-invitation"),
        { email },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      setSuccess(`Invitation email resent to ${email}`);
      await loadWaitlist(); // Reload waitlist data
    } catch (error: any) {
      setError(error.response?.data?.message || "Failed to resend invitation");
    } finally {
      setLoading(false);
    }
  };

  const handleSort = (property: string) => {
    const isAsc = orderBy === property && order === "asc";
    setOrder(isAsc ? "desc" : "asc");
    setOrderBy(property);
  };

  const sortedAdminTasks = React.useMemo(() => {
    return [...tasks].sort((a, b) => {
      const aVal = a[orderBy];
      const bVal = b[orderBy];

      if (orderBy === "createdAt" || orderBy === "latestRunTime") {
        const aDate = aVal ? new Date(aVal).getTime() : 0;
        const bDate = bVal ? new Date(bVal).getTime() : 0;
        return order === "asc" ? aDate - bDate : bDate - aDate;
      } else if (orderBy === "completedRuns") {
        const aRatio =
          a.totalRuns && a.totalRuns > 0
            ? (a.completedRuns || 0) / a.totalRuns
            : 0;
        const bRatio =
          b.totalRuns && b.totalRuns > 0
            ? (b.completedRuns || 0) / b.totalRuns
            : 0;
        return order === "asc" ? aRatio - bRatio : bRatio - aRatio;
      }

      const aStr = String(aVal ?? "").toLowerCase();
      const bStr = String(bVal ?? "").toLowerCase();
      return order === "asc"
        ? aStr.localeCompare(bStr)
        : bStr.localeCompare(aStr);
    });
  }, [tasks, order, orderBy]);

  const getUserSortValue = (user: User, property: keyof User) => {
    switch (property) {
      case "createdAt":
        return user.createdAt ? new Date(user.createdAt).getTime() : 0;
      case "lastLoginTime":
        return user.lastLoginTime ? new Date(user.lastLoginTime).getTime() : 0;
      case "chatSessionCount":
        return user.chatSessionCount ?? 0;
      case "taskCount":
        return user.taskCount ?? 0;
      case "workflowCount":
        return user.workflowCount ?? 0;
      case "roles":
        return (user.roles ?? []).join(",");
      case "seoDomains":
        return (user.seoDomains ?? []).join(",");
      case "isOAuthUser":
        return user.isOAuthUser ? 1 : 0;
      case "isAdmin":
        return user.isAdmin ? 1 : 0;
      case "isActive":
        return user.isActive === false ? 0 : 1;
      default:
        return (user as unknown as Record<string, unknown>)[property] ?? "";
    }
  };

  const sortedUsers = React.useMemo(() => {
    return [...contextUsers].sort((a, b) => {
      const aVal = getUserSortValue(a, usersOrderBy);
      const bVal = getUserSortValue(b, usersOrderBy);

      if (typeof aVal === "number" && typeof bVal === "number") {
        return usersOrder === "asc" ? aVal - bVal : bVal - aVal;
      }

      const aStr = String(aVal ?? "").toLowerCase();
      const bStr = String(bVal ?? "").toLowerCase();
      return usersOrder === "asc"
        ? aStr.localeCompare(bStr)
        : bStr.localeCompare(aStr);
    });
  }, [contextUsers, usersOrder, usersOrderBy]);

  const handleUserSort = (property: keyof User) => {
    const isAsc = usersOrderBy === property && usersOrder === "asc";
    setUsersOrder(isAsc ? "desc" : "asc");
    setUsersOrderBy(property);
  };

  const getWaitlistSortValue = (entry: WaitlistEntry, property: keyof WaitlistEntry) => {
    switch (property) {
      case "createdAt":
      case "invitedAt":
      case "joinedAt":
        return entry[property] ? new Date(entry[property] as string).getTime() : 0;
      case "useCaseCategories":
        return (entry.useCaseCategories ?? []).join(",");
      case "marketingChannels":
        return (entry.marketingChannels ?? []).join(",");
      case "requestReport":
        return entry.requestReport ? 1 : 0;
      default:
        return (entry as unknown as Record<string, unknown>)[property] ?? "";
    }
  };

  const sortedWaitlist = React.useMemo(() => {
    return [...waitlist].sort((a, b) => {
      const aVal = getWaitlistSortValue(a, waitlistOrderBy);
      const bVal = getWaitlistSortValue(b, waitlistOrderBy);

      if (typeof aVal === "number" && typeof bVal === "number") {
        return waitlistOrder === "asc" ? aVal - bVal : bVal - aVal;
      }

      const aStr = String(aVal ?? "").toLowerCase();
      const bStr = String(bVal ?? "").toLowerCase();
      return waitlistOrder === "asc"
        ? aStr.localeCompare(bStr)
        : bStr.localeCompare(aStr);
    });
  }, [waitlist, waitlistOrder, waitlistOrderBy]);

  const handleWaitlistSort = (property: keyof WaitlistEntry) => {
    const isAsc = waitlistOrderBy === property && waitlistOrder === "asc";
    setWaitlistOrder(isAsc ? "desc" : "asc");
    setWaitlistOrderBy(property);
  };

  const SortLabel = ({
    property,
    label,
  }: {
    property: string;
    label: string;
  }) => (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        cursor: "pointer",
        userSelect: "none",
        "&:hover": {
          color: "primary.main",
        },
      }}
      onClick={() => handleSort(property)}
    >
      {label}
      {orderBy === property ? (
        <Box component="span" sx={{ ml: 1 }}>
          {order === "desc" ? "↓" : "↑"}
        </Box>
      ) : null}
    </Box>
  );

  const UserSortLabel = ({
    property,
    label,
  }: {
    property: keyof User;
    label: string;
  }) => (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        cursor: "pointer",
        userSelect: "none",
        "&:hover": {
          color: "primary.main",
        },
      }}
      onClick={() => handleUserSort(property)}
    >
      {label}
      {usersOrderBy === property ? (
        <Box component="span" sx={{ ml: 1 }}>
          {usersOrder === "desc" ? "↓" : "↑"}
        </Box>
      ) : null}
    </Box>
  );

  const WaitlistSortLabel = ({
    property,
    label,
  }: {
    property: keyof WaitlistEntry;
    label: string;
  }) => (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        cursor: "pointer",
        userSelect: "none",
        "&:hover": {
          color: "primary.main",
        },
      }}
      onClick={() => handleWaitlistSort(property)}
    >
      {label}
      {waitlistOrderBy === property ? (
        <Box component="span" sx={{ ml: 1 }}>
          {waitlistOrder === "desc" ? "↓" : "↑"}
        </Box>
      ) : null}
    </Box>
  );

  const formatMessageToHtml = (text: string) => {
    return text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => `<p>${line}</p>`)
      .join("");
  };

  const handleAnnouncementSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!message.trim() || !title.trim()) {
      setError("Please enter both title and message");
      return;
    }

    setLoading(true);
    setError("");
    setSuccess("");

    try {
      await axios.post(
        buildApiUrl("/api/admin/announcements/send"),
        {
          title,
          message: formatMessageToHtml(message),
        },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      setSuccess("Announcement sent successfully");
      setMessage("");
      setTitle("");
    } catch (error: any) {
      setError(error.response?.data?.message || "Failed to send announcement");
    } finally {
      setLoading(false);
    }
  };

  const handleTestAnnouncement = async () => {
    if (!message.trim() || !title.trim()) {
      setError("Please enter both title and message");
      return;
    }

    if (!testRecipients.trim()) {
      setError("Please enter at least one recipient email address");
      return;
    }

    // Parse recipients (comma or newline separated)
    const recipients = testRecipients
      .split(/[,\n]/)
      .map((email) => email.trim())
      .filter((email) => email.length > 0);

    if (recipients.length === 0) {
      setError("Please enter at least one valid recipient email address");
      return;
    }

    setTestLoading(true);
    setError("");
    setSuccess("");

    try {
      const response = await axios.post(
        buildApiUrl("/api/admin/announcements/test"),
        {
          title,
          message: formatMessageToHtml(message),
          recipients,
        },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      
      const details = response.data.details;
      let successMessage = response.data.message;
      
      if (details.invalidEmails && details.invalidEmails.length > 0) {
        successMessage += `. Invalid emails: ${details.invalidEmails.join(", ")}`;
      }
      
      if (details.failedEmails && details.failedEmails.length > 0) {
        successMessage += `. Failed to send to: ${details.failedEmails.join(", ")}`;
      }
      
      setSuccess(successMessage);
      setTestDialogOpen(false);
      setTestRecipients("");
    } catch (error: any) {
      setError(error.response?.data?.message || "Failed to send test announcement");
    } finally {
      setTestLoading(false);
    }
  };

  const handleLoadFromUrl = async () => {
    if (!htmlUrl.trim()) {
      setError("Please enter a URL");
      return;
    }

    // Basic URL validation
    try {
      new URL(htmlUrl);
    } catch {
      setError("Please enter a valid URL");
      return;
    }

    setLoadingHtml(true);
    setError("");
    setSuccess("");

    try {
      const response = await axios.post(
        buildApiUrl("/api/admin/announcements/load-from-url"),
        { url: htmlUrl.trim() },
        { headers: { Authorization: `Bearer ${token}` } }
      );

      if (response.data.success) {
        setTitle(response.data.title || "");
        setMessage(response.data.message || "");
        setSuccess("Content loaded successfully from URL");
        setHtmlUrl("");
      } else {
        setError(response.data.message || "Failed to load content from URL");
      }
    } catch (error: any) {
      setError(
        error.response?.data?.message ||
          error.response?.data?.error ||
          "Failed to load content from URL"
      );
    } finally {
      setLoadingHtml(false);
    }
  };

  const handleDeactivateUser = async () => {
    if (!selectedUser) return;

    setLoading(true);
    try {
      await axios.post(
        buildApiUrl(`/api/admin/users/${selectedUser.userId}/deactivate`),
        {},
        { headers: { Authorization: `Bearer ${token}` } }
      );
      await loadUsers(); // Reload users list
      setSuccess(`User ${selectedUser.email} has been deactivated`);
    } catch (error: any) {
      setError(error.response?.data?.message || "Failed to deactivate user");
    } finally {
      setLoading(false);
      setDeactivateDialogOpen(false);
      setSelectedUser(null);
    }
  };

  const handleOpenUserDeleteConfirm = (userId: string) => {
    setUserIdToDelete(userId);
    setUserDeleteConfirmOpen(true);
  };

  const handleCloseUserDeleteConfirm = () => {
    setUserIdToDelete(null);
    setUserDeleteConfirmOpen(false);
  };

  const handleUserDeleteConfirmed = async () => {
    if (userIdToDelete) {
      try {
        setLoading(true);
        await deleteUser(userIdToDelete);
        setSuccess(`User ${userIdToDelete} deleted successfully.`); // Consider showing email or a more user-friendly identifier
        await loadUsers(); // Ensure user list is refreshed
        handleCloseUserDeleteConfirm();
      } catch (error) {
        let errorMessage = "Failed to delete user";
        if (axios.isAxiosError(error) && error.response?.data?.message) {
          errorMessage = error.response.data.message;
        } else if (error instanceof Error) {
          errorMessage = error.message;
        }
        setError(errorMessage);
      } finally {
        setLoading(false);
      }
    }
  };

  const handleViewChat = (session: AdminChatSession) => {
    setSelectedSession(session);
    setChatDialogOpen(true);
  };

  const handleRoleCheckboxChange = (role: "partner" | "customer" | "free") => {
    setSelectedUserRoles((prevRoles) =>
      prevRoles.includes(role)
        ? prevRoles.filter((r) => r !== role)
        : [...prevRoles, role]
    );
  };

  const handleRoleDialogOpen = (user: User) => {
    setSelectedUser(user);
    // Initialize roles for the dialog based SOLELY on user.roles
    if (user.roles && user.roles.length > 0) {
      setSelectedUserRoles(user.roles);
    } else {
      setSelectedUserRoles([]); // Default to empty array if no roles are present
    }
    setRoleDialogOpen(true);
  };

  const handleRoleDialogClose = () => {
    setRoleDialogOpen(false);
  };

  const handleUpdateRole = async () => {
    try {
      setLoading(true);
      setError("");

      await axios.put(
        buildApiUrl(`/api/admin/users/${selectedUser?.userId}/role`),
        { roles: selectedUserRoles },
        { headers: { Authorization: `Bearer ${token}` } }
      );

      // Update the user in the local state without reloading
      setUsers((prevUsers: User[]) => 
        prevUsers.map((user: User) => 
          user.userId === selectedUser?.userId 
            ? { ...user, roles: selectedUserRoles }
            : user
        )
      );

      setSuccess("User roles updated successfully");
      setRoleDialogOpen(false);
    } catch (err) {
      console.error("Error updating user roles:", err);
      setError("Failed to update user roles. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleEditNoteClick = (email: string, currentNote: string) => {
    setEditingNoteEmail(email);
    setCurrentNoteText(currentNote);
  };

  const handleCancelEditNote = () => {
    setEditingNoteEmail(null);
    setCurrentNoteText("");
  };

  const handleSaveNote = async () => {
    if (!editingNoteEmail) return;

    setNoteEditLoading(true);
    try {
      // Use the context function to update the waitlist support note
      await updateWaitlistSupportNote(editingNoteEmail, currentNoteText);
      setSuccess("Support note updated successfully");
      handleCancelEditNote(); // Close dialog and clear state
    } catch (error: any) {
      // The context function already sets a generic error,
      // but we can set a more specific one or rely on the context's error handling.
      // For now, let AdminContext's error handling take precedence or be shown.
      // setError(error.response?.data?.message || 'Failed to update support note');
      console.error("Failed to save support note:", error); // Keep console log for debugging
    } finally {
      setNoteEditLoading(false);
    }
  };

  const handleManualInviteOpen = () => {
    setManualInviteOpen(true);
  };

  const handleManualInviteClose = () => {
    setManualInviteOpen(false);
    setManualInviteForm({
      email: "",
      fullName: "",
      phoneNumber: "",
      companyName: "",
      useCaseCategories: [],
      useCaseDescription: "",
      requestReport: false,
      supportNote: "",
      monthlyMarketingSpend: "",
      businessArea: "",
      stripe_customer_id: "",
      sendInvitation: true,
      marketingChannels: [],
    });
  };

  const handleManualInviteSubmit = async () => {
    try {
      setManualInviteLoading(true);
      await addToWaitlist(manualInviteForm);
      setSuccess("Successfully added to waitlist!");
      handleManualInviteClose();
    } catch (error) {
      // Error is already handled in the context
    } finally {
      setManualInviteLoading(false);
    }
  };

  const handleSaveSupportNote = async (userId: string) => {
    try {
      setSupportNoteEditLoading(true);
      
      const response = await axios.put(
        buildApiUrl(`/api/admin/users/${userId}/support-note`),
        { supportNote: currentSupportNoteText },
        {
          headers: { Authorization: `Bearer ${token}` }
        }
      );

      if (response.status === 200) {
        // Update the user in the local state without reloading
        setUsers((prevUsers: User[]) => 
          prevUsers.map((user: User) => 
            user.userId === userId 
              ? { ...user, supportNote: response.data.supportNote }
              : user
          )
        );
        setSuccess("Support note updated successfully!");
        setEditingSupportNoteUserId(null);
        setCurrentSupportNoteText("");
      }
    } catch (error: any) {
      console.error("Error updating support note:", error);
      setError(error.response?.data?.message || "Failed to update support note");
    } finally {
      setSupportNoteEditLoading(false);
    }
  };

  const handleSaveAdAccount = async (userId: string) => {
    try {
      setAdAccountEditLoading(true);
      
      // Validate Meta Ad Account ID format (should be a numeric string)
      const adAccountId = currentAdAccountText.trim();
      if (adAccountId && !/^\d+$/.test(adAccountId)) {
        setError("Meta Ad Account ID must be a numeric value (e.g., 123456789012345)");
        return;
      }
      
      const response = await axios.put(
        buildApiUrl(`/api/admin/users/${userId}/ad-account`),
        { adAccount: adAccountId },
        {
          headers: { Authorization: `Bearer ${token}` }
        }
      );

      if (response.status === 200) {
        // Update the user in the local state without reloading
        setUsers((prevUsers: User[]) => 
          prevUsers.map((user: User) => 
            user.userId === userId 
              ? { ...user, adAccount: response.data.adAccount }
              : user
          )
        );
        setSuccess("Ad account updated successfully!");
        setEditingAdAccountUserId(null);
        setCurrentAdAccountText("");
      }
    } catch (error: any) {
      console.error("Error updating ad account:", error);
      setError(error.response?.data?.message || "Failed to update ad account");
    } finally {
      setAdAccountEditLoading(false);
    }
  };


  const handleSaveEmailSender = async () => {
    if (!editingEmailSenderUserId) return;
    
    try {
      setEmailSenderEditLoading(true);
      
      // Validate email domain format - allow empty domain or valid format
      const domain = emailDomain.trim();
      if (domain && !/^[a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9]*\.[a-zA-Z]{2,}$/.test(domain)) {
        setError("Please enter a valid email domain (e.g., example.com)");
        return;
      }
      
      const response = await axios.put(
        buildApiUrl(`/api/admin/users/${editingEmailSenderUserId}/email-sender`),
        { 
          emailDomain: domain,
          defaultSenderUsername: defaultSenderUsername.trim(),
          fromName: fromName.trim()
        },
        {
          headers: { Authorization: `Bearer ${token}` }
        }
      );

      if (response.status === 200) {
        // Update the user in the local state without reloading
        setUsers((prevUsers: User[]) => 
          prevUsers.map((user: User) => 
            user.userId === editingEmailSenderUserId 
              ? { 
                  ...user, 
                  emailDomain: response.data.emailDomain,
                  defaultSenderUsername: response.data.defaultSenderUsername,
                  fromName: response.data.fromName
                }
              : user
          )
        );
        setSuccess("Email sender configuration updated successfully!");
        setEmailSenderDialogOpen(false);
        setEditingEmailSenderUserId(null);
        setEmailDomain("");
        setDefaultSenderUsername("");
        setFromName("");
      }
    } catch (error: any) {
      console.error("Error updating email sender configuration:", error);
      setError(error.response?.data?.message || "Failed to update email sender configuration");
    } finally {
      setEmailSenderEditLoading(false);
    }
  };

  const handleSaveSlackChannel = async () => {
    if (!editingSlackChannelUserId) return;
    
    try {
      setSlackChannelEditLoading(true);
      
      const response = await axios.put(
        buildApiUrl(`/api/admin/users/${editingSlackChannelUserId}/slack-channel`),
        { 
          slackChannel: currentSlackChannelText.trim() || null
        },
        {
          headers: { Authorization: `Bearer ${token}` }
        }
      );

      if (response.status === 200) {
        // Update the user in the local state without reloading
        setUsers((prevUsers: User[]) => 
          prevUsers.map((user: User) => 
            user.userId === editingSlackChannelUserId 
              ? { 
                  ...user, 
                  slackChannel: response.data.slackChannel
                }
              : user
          )
        );
        setSuccess("Slack channel updated successfully!");
        setSlackChannelDialogOpen(false);
        setEditingSlackChannelUserId(null);
        setCurrentSlackChannelText("");
      }
    } catch (error: any) {
      console.error("Error updating slack channel:", error);
      setError(error.response?.data?.message || "Failed to update slack channel");
    } finally {
      setSlackChannelEditLoading(false);
    }
  };

  const handleSaveSeoDomains = async () => {
    if (!editingSeoDomainsUserId) return;

    // Clear any previous errors
    setError("");

    try {
      setSeoDomainsEditLoading(true);
      
      // Parse domains from text (one per line or comma-separated)
      const domainsText = seoDomainsText.trim();
      let domains: string[] = [];
      
      if (domainsText) {
        // Split by newlines or commas, then filter and validate
        domains = domainsText
          .split(/[\n,]+/)
          .map(d => d.trim())
          .filter(d => d.length > 0);
        
        // Validate each domain format
        const domainRegex = /^[a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9]*\.[a-zA-Z]{2,}$/;
        for (const domain of domains) {
          if (!domainRegex.test(domain)) {
            setError(`Invalid domain format: ${domain}. Please use format like example.com`);
            return;
          }
        }
      }
      
      // Validate Google Analytics Property ID format if provided
      // Note: The API uses Property ID (numeric), not Measurement ID (G-XXXXXXXXXX)
      const gaId = googleAnalyticsPropertyId.trim();
      if (gaId && !/^\d+$/.test(gaId)) {
        setError(`Invalid Google Analytics Property ID format: ${gaId}. Please enter the numeric Property ID (e.g., 123456789). You can find this in GA4 Admin > Property Settings.`);
        return;
      }

      const clarityId = clarityProjectId.trim();
      if (clarityId && !/^[a-zA-Z0-9_-]{6,32}$/.test(clarityId)) {
        setError(`Invalid Microsoft Clarity Project ID format: ${clarityId}. Please enter the project ID (e.g., ul13e4f7fe). You can find this in Clarity project settings.`);
        return;
      }

      // Validate product domain format if provided
      const prodDomain = productDomain.trim();
      if (prodDomain) {
        const domainRegex = /^[a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9]*\.[a-zA-Z]{2,}$/;
        if (!domainRegex.test(prodDomain)) {
          setError(`Invalid product domain format: ${prodDomain}. Please use format like app.example.com`);
          return;
        }
      }

      // Parse filtered domains from text (one per line or comma-separated)
      const filteredDomainsText = gaFilteredDomainsText.trim();
      let filteredDomains: string[] = [];

      if (filteredDomainsText) {
        // Split by newlines or commas, then filter and validate
        filteredDomains = filteredDomainsText
          .split(/[\n,]+/)
          .map(d => d.trim())
          .filter(d => d.length > 0);

        // Validate each domain format (allow localhost and standard domains)
        const domainRegex = /^[a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9]*\.[a-zA-Z]{2,}$/;
        for (const domain of filteredDomains) {
          // Allow localhost and IP addresses (common for filtering local/dev traffic)
          const isLocalhost = domain === 'localhost' || domain.startsWith('localhost:');
          const isIpAddress = /^(\d{1,3}\.){3}\d{1,3}(:\d+)?$/.test(domain);

          if (!isLocalhost && !isIpAddress && !domainRegex.test(domain)) {
            setError(`Invalid filtered domain format: ${domain}. Please use format like app.example.com, localhost, or an IP address`);
            return;
          }
        }
      }

      const response = await axios.put(
        buildApiUrl(`/api/admin/users/${editingSeoDomainsUserId}/seo-aeo`),
        {
          seoDomains: domains,
          googleAnalyticsPropertyId: gaId || null,
          gaFilteredDomains: filteredDomains,
          clarityProjectId: clarityId || null,
          productDomain: prodDomain || null
        },
        {
          headers: { Authorization: `Bearer ${token}` }
        }
      );

      if (response.status === 200) {
        // Update the user in the local state without reloading
        setUsers((prevUsers: User[]) =>
          prevUsers.map((user: User) =>
            user.userId === editingSeoDomainsUserId
              ? {
                  ...user,
                  seoDomains: response.data.seoDomains || [],
                  googleAnalyticsPropertyId: response.data.googleAnalyticsPropertyId || undefined,
                  gaFilteredDomains: response.data.gaFilteredDomains || [],
                  clarityProjectId: response.data.clarityProjectId || undefined,
                  productDomain: response.data.productDomain || undefined
                }
              : user
          )
        );
        setSuccess("SEO/AEO configuration updated successfully!");
        setSeoDomainsDialogOpen(false);
        setEditingSeoDomainsUserId(null);
        setSeoDomainsText("");
        setGoogleAnalyticsPropertyId("");
        setGaFilteredDomainsText("");
        setClarityProjectId("");
        setProductDomain("");
      }
    } catch (error: any) {
      console.error("Error updating SEO/AEO configuration:", error);
      setError(error.response?.data?.message || "Failed to update SEO/AEO configuration");
    } finally {
      setSeoDomainsEditLoading(false);
    }
  };

  const handleSaveCmsType = async () => {
    if (!editingCmsTypeUserId) return;
    
    try {
      setCmsTypeEditLoading(true);
      
      const response = await axios.put(
        buildApiUrl(`/api/admin/users/${editingCmsTypeUserId}/cms-type`),
        { cmsType: currentCmsType || null },
        {
          headers: { Authorization: `Bearer ${token}` }
        }
      );

      if (response.status === 200) {
        // Update the user in the local state without reloading
        setUsers((prevUsers: User[]) => 
          prevUsers.map((user: User) => 
            user.userId === editingCmsTypeUserId 
              ? { 
                  ...user, 
                  cmsType: response.data.cmsType
                }
              : user
          )
        );
        setSuccess("CMS Type updated successfully!");
        setEditingCmsTypeUserId(null);
        setCurrentCmsType("");
      }
    } catch (error: any) {
      setError(error.response?.data?.message || "Failed to update CMS Type");
    } finally {
      setCmsTypeEditLoading(false);
    }
  };

  const handleSaveSubscriptionType = async () => {
    if (!editingSubscriptionTypeUserId) return;
    
    try {
      setSubscriptionTypeEditLoading(true);
      
      const response = await axios.put(
        buildApiUrl(`/api/admin/users/${editingSubscriptionTypeUserId}/subscription-type`),
        { subscriptionType: currentSubscriptionType || 'Basic' },
        {
          headers: { Authorization: `Bearer ${token}` }
        }
      );

      if (response.status === 200) {
        // Update the user in the local state without reloading
        setUsers((prevUsers: User[]) => 
          prevUsers.map((user: User) => 
            user.userId === editingSubscriptionTypeUserId 
              ? { 
                  ...user, 
                  subscriptionType: response.data.subscriptionType || 'Basic'
                }
              : user
          )
        );
        setSuccess("Subscription Type updated successfully!");
        setEditingSubscriptionTypeUserId(null);
        setCurrentSubscriptionType("");
      }
    } catch (error: any) {
      setError(error.response?.data?.message || "Failed to update Subscription Type");
    } finally {
      setSubscriptionTypeEditLoading(false);
    }
  };

  const handleAccessCustomerPortal = async (userId: string) => {
    try {
      setDelegateAccessLoading(userId);
      
      const response = await axios.post(
        buildApiUrl(`/api/admin/users/${userId}/delegate-access`),
        {},
        {
          headers: { Authorization: `Bearer ${token}` }
        }
      );

      if (response.status === 200) {
        const { customerPortalUrl } = response.data;
        // Open customer portal in new tab with delegate token
        window.open(customerPortalUrl, '_blank');
        setSuccess("Delegate access created successfully!");
      }
    } catch (error: any) {
      console.error("Error creating delegate access:", error);
      setError(error.response?.data?.message || "Failed to create delegate access");
    } finally {
      setDelegateAccessLoading(null);
    }
  };

  const handleSetPassword = (userId: string, email: string) => {
    setPasswordUserId(userId);
    setPasswordUserEmail(email);
    setNewPassword("");
    setPasswordDialogOpen(true);
  };

  const handlePasswordReset = async () => {
    if (!passwordUserId || !newPassword.trim()) {
      setError("Please enter a new password");
      return;
    }

    try {
      setPasswordResetLoading(true);
      setError("");
      
      const response = await axios.put(
        buildApiUrl(`/api/admin/users/${passwordUserId}/password`),
        { password: newPassword },
        { headers: { Authorization: `Bearer ${token}` } }
      );

      if (response.status === 200) {
        setSuccess(`Password updated successfully for ${passwordUserEmail}`);
        setPasswordDialogOpen(false);
        setPasswordUserId(null);
        setPasswordUserEmail(null);
        setNewPassword("");
      }
    } catch (error: any) {
      console.error("Error updating password:", error);
      setError(error.response?.data?.message || "Failed to update password");
    } finally {
      setPasswordResetLoading(false);
    }
  };

  // Edit Waitlist Dialog handlers
  const handleEditWaitlistOpen = (entry: WaitlistEntry) => {
    setEditWaitlistData({ ...entry });
    setEditWaitlistDialogOpen(true);
  };

  const handleEditWaitlistClose = () => {
    setEditWaitlistDialogOpen(false);
    setEditWaitlistData(null);
  };

  const handleEditWaitlistSave = async () => {
    if (!editWaitlistData) return;

    try {
      setEditWaitlistLoading(true);
      setError("");

      const response = await axios.put(
        buildApiUrl(`/api/admin/waitlist/${encodeURIComponent(editWaitlistData.email)}`),
        editWaitlistData,
        { headers: { Authorization: `Bearer ${token}` } }
      );

      if (response.status === 200) {
        // Reload waitlist to get updated data
        await loadWaitlist();
        setSuccess("Waitlist entry updated successfully!");
        handleEditWaitlistClose();
      }
    } catch (error: any) {
      console.error("Error updating waitlist entry:", error);
      setError(error.response?.data?.message || "Failed to update waitlist entry");
    } finally {
      setEditWaitlistLoading(false);
    }
  };

  const useCaseOptions = [
    "Content Marketing",
    "SEO",
    "Lead Generation",
    "Social Media Marketing",
    "Email Marketing",
    "PPC Advertising",
    "Analytics & Reporting",
    "Market Research",
    "Competitor Analysis",
    "Other",
  ];

  const marketingChannelOptions = [
    "Meta",
    "Youtube",
    "LinkedIn",
    "Email",
    "TikTok",
    "Google Search",
    "Other",
  ];

  if (adminError) {
    return <Alert severity="error">{adminError}</Alert>;
  }

  return (
    <Container maxWidth="lg" sx={{ mt: 4, mb: 4 }}>
      <Typography variant="h4" component="h1" gutterBottom>
        Admin Dashboard
      </Typography>

      <Paper sx={{ width: "100%", mt: 3 }}>
        <Box sx={{ borderBottom: 1, borderColor: "divider" }}>
          <Tabs
            value={tabValue}
            onChange={handleTabChange}
            aria-label="admin tabs"
            variant="scrollable"
            scrollButtons="auto"
          >
            <Tab label="Overview" {...a11yProps(0)} />
            <Tab label="Announcements" {...a11yProps(1)} />
            <Tab label="Users" {...a11yProps(2)} />
            <Tab label="Waitlist" {...a11yProps(3)} />
            <Tab label="Tasks" {...a11yProps(4)} />
            <Tab label="Workflows" {...a11yProps(5)} />
            <Tab label="Chat History" {...a11yProps(6)} />
            <Tab label="Knowledge Base" {...a11yProps(7)} />
            <Tab label="Agent Mode" {...a11yProps(8)} />
            <Tab label="Image Models" {...a11yProps(9)} />
            <Tab label="Default Prompts" {...a11yProps(10)} />
            <Tab label="Benchmarks" {...a11yProps(11)} />
            <Tab label="Subscriptions" {...a11yProps(12)} />
            <Tab label="MCP Servers" {...a11yProps(13)} />
          </Tabs>
        </Box>

        <TabPanel value={tabValue} index={0}>
          <Box sx={{ mb: 3 }}>
            <Grid container spacing={2} alignItems="center">
              <Grid item>
                <TextField
                  type="date"
                  label="Start Date"
                  value={startDate ? format(startDate, "yyyy-MM-dd") : ""}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    setStartDate(new Date(e.target.value))
                  }
                  InputLabelProps={{
                    shrink: true,
                  }}
                />
              </Grid>
              <Grid item>
                <TextField
                  type="date"
                  label="End Date"
                  value={endDate ? format(endDate, "yyyy-MM-dd") : ""}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    setEndDate(new Date(e.target.value))
                  }
                  InputLabelProps={{
                    shrink: true,
                  }}
                />
              </Grid>
            </Grid>
          </Box>

          {adminError && (
            <Alert severity="error" sx={{ mb: 3 }}>
              {adminError}
            </Alert>
          )}

          {adminLoading ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}>
              <CircularProgress />
            </Box>
          ) : (
            <Box>
              {/* Key Metrics Cards */}
              <Grid container spacing={3} sx={{ mb: 4 }}>
                <Grid item xs={12} md={3}>
                  <Card>
                    <CardContent>
                      <Typography variant="h6" gutterBottom>
                        User Analytics
                      </Typography>
                      {userAnalytics && (
                        <>
                          <Typography variant="h4" color="primary">
                            {userAnalytics.totalUsers}
                          </Typography>
                          <Typography variant="body2" color="text.secondary">
                            Total Users
                            <Box
                              component="span"
                              sx={{ color: "success.main", ml: 1 }}
                            >
                              +{userAnalytics.newUsers} new
                            </Box>
                          </Typography>
                          <Typography variant="body2" color="text.secondary">
                            OAuth: {userAnalytics.oauthUsers} (+{userAnalytics.newOauthUsers})
                          </Typography>
                          <Typography variant="body2" color="text.secondary">
                            Admin: {userAnalytics.adminUsers}
                          </Typography>
                        </>
                      )}
                    </CardContent>
                  </Card>
                </Grid>
                <Grid item xs={12} md={3}>
                  <Card>
                    <CardContent>
                      <Typography variant="h6" gutterBottom>
                        Task Analytics
                      </Typography>
                      {taskAnalytics && (
                        <>
                          <Typography variant="h4" color="primary">
                            {taskAnalytics.totalTasks}
                          </Typography>
                          <Typography variant="body2" color="text.secondary">
                            Total Tasks
                            <Box
                              component="span"
                              sx={{ color: "success.main", ml: 1 }}
                            >
                              +{taskAnalytics.newTasks} new
                            </Box>
                          </Typography>
                          <Typography variant="body2" color="text.secondary">
                            Templates: {taskAnalytics.templates} (+{taskAnalytics.newTemplates})
                          </Typography>
                          <Typography variant="body2" color="text.secondary">
                            Scheduled: {taskAnalytics.scheduledTasks} (+{taskAnalytics.newScheduledTasks})
                          </Typography>
                        </>
                      )}
                    </CardContent>
                  </Card>
                </Grid>
                <Grid item xs={12} md={3}>
                  <Card>
                    <CardContent>
                      <Typography variant="h6" gutterBottom>
                        Execution Analytics
                      </Typography>
                      {taskAnalytics && (
                        <>
                          <Typography variant="h4" color="primary">
                            {taskAnalytics.totalExecutions}
                          </Typography>
                          <Typography variant="body2" color="text.secondary">
                            Total Executions
                            <Box
                              component="span"
                              sx={{ color: "success.main", ml: 1 }}
                            >
                              +{taskAnalytics.newExecutions} new
                            </Box>
                          </Typography>
                          <Typography variant="body2" color="success.main">
                            ✓ {taskAnalytics.successfulExecutions} successful
                          </Typography>
                          <Typography variant="body2" color="error.main">
                            ✗ {taskAnalytics.failedExecutions} failed
                          </Typography>
                        </>
                      )}
                    </CardContent>
                  </Card>
                </Grid>
                <Grid item xs={12} md={3}>
                  <Card>
                    <CardContent>
                      <Typography variant="h6" gutterBottom>
                        Performance
                      </Typography>
                      {taskAnalytics && (
                        <>
                          <Typography variant="h4" color="primary">
                            {taskAnalytics.averageExecutionTime != null
                              ? `${(taskAnalytics.averageExecutionTime / 1000).toFixed(1)}s`
                              : "N/A"}
                          </Typography>
                          <Typography variant="body2" color="text.secondary">
                            Avg Execution Time
                          </Typography>
                          <Typography variant="body2" color="text.secondary">
                            Pending: {taskAnalytics.totalExecutions - taskAnalytics.successfulExecutions - taskAnalytics.failedExecutions}
                          </Typography>
                        </>
                      )}
                    </CardContent>
                  </Card>
                </Grid>
              </Grid>

              {/* Growth Charts */}
              <Grid container spacing={3} sx={{ mb: 4 }}>
                <Grid item xs={12} md={6}>
                  {userAnalytics && (
                    <UserGrowthChart
                      data={userAnalytics}
                      startDate={startDate ? format(startDate, "yyyy-MM-dd") : ""}
                      endDate={endDate ? format(endDate, "yyyy-MM-dd") : ""}
                    />
                  )}
                </Grid>
                <Grid item xs={12} md={6}>
                  {taskAnalytics && (
                    <TaskGrowthChart
                      data={taskAnalytics}
                      startDate={startDate ? format(startDate, "yyyy-MM-dd") : ""}
                      endDate={endDate ? format(endDate, "yyyy-MM-dd") : ""}
                    />
                  )}
                </Grid>
              </Grid>

              {/* Execution Trends and Distribution Charts */}
              <Grid container spacing={3} sx={{ mb: 4 }}>
                <Grid item xs={12} md={8}>
                  {taskAnalytics && (
                    <ExecutionTrendsChart
                      data={taskAnalytics}
                      startDate={startDate ? format(startDate, "yyyy-MM-dd") : ""}
                      endDate={endDate ? format(endDate, "yyyy-MM-dd") : ""}
                    />
                  )}
                </Grid>
                <Grid item xs={12} md={4}>
                  {taskAnalytics && (
                    <ExecutionStatusChart data={taskAnalytics} />
                  )}
                </Grid>
              </Grid>

              {/* User Type Distribution */}
              <Grid container spacing={3} sx={{ mb: 4 }}>
                <Grid item xs={12} md={6}>
                  {userAnalytics && (
                    <UserTypeChart data={userAnalytics} />
                  )}
                </Grid>
                <Grid item xs={12} md={6}>
                  <Card>
                    <CardContent>
                      <Typography variant="h6" gutterBottom>
                        Config Analytics
                      </Typography>
                      {taskAnalytics && (
                        <>
                          <Typography>
                            Website Credentials: {taskAnalytics.websiteConfigs}
                            <Box
                              component="span"
                              sx={{ color: "success.main", ml: 1 }}
                            >
                              +{taskAnalytics.newWebsiteConfigs} new
                            </Box>
                          </Typography>
                          <Typography>
                            API Credentials: {taskAnalytics.apiConfigs}
                            <Box
                              component="span"
                              sx={{ color: "success.main", ml: 1 }}
                            >
                              +{taskAnalytics.newApiConfigs} new
                            </Box>
                          </Typography>
                          <Typography>
                            Shared Credentials: {taskAnalytics.sharedConfigs}
                          </Typography>
                        </>
                      )}
                    </CardContent>
                  </Card>
                </Grid>
              </Grid>

              {/* Agent Mode Metrics Section */}
              <Box sx={{ mb: 4 }}>
                <Typography variant="h5" gutterBottom sx={{ mt: 4, mb: 3 }}>
                  Agent Mode Analytics
                </Typography>

                {/* Agent Mode Key Metrics Cards */}
                <Grid container spacing={3} sx={{ mb: 4 }}>
                  <Grid item xs={12} md={3}>
                    <Card>
                      <CardContent>
                        <Typography variant="h6" gutterBottom>
                          Session Analytics
                        </Typography>
                        {agentModeAnalytics && (
                          <>
                            <Typography variant="h4" color="primary">
                              {agentModeAnalytics.newSessions || 0}
                            </Typography>
                            <Typography variant="body2" color="text.secondary">
                              Sessions (in period)
                            </Typography>
                            <Typography variant="body2" color="text.secondary">
                              Total: {agentModeAnalytics.totalSessions || 0}
                            </Typography>
                            <Typography variant="body2" color="text.secondary">
                              Non-Scheduled: {agentModeAnalytics.newNonScheduledSessions || 0}
                              <Box
                                component="span"
                                sx={{ color: "success.main", ml: 0.5 }}
                              >
                                •
                              </Box>
                              Scheduled: {agentModeAnalytics.newScheduledSessions || 0}
                            </Typography>
                            <Typography variant="body2" color="text.secondary" sx={{ fontSize: '0.75rem', mt: 0.5 }}>
                              Shared: {agentModeAnalytics.sharedSessions || 0} • 
                              With Work Plans: {agentModeAnalytics.sessionsWithWorkPlans || 0}
                            </Typography>
                          </>
                        )}
                      </CardContent>
                    </Card>
                  </Grid>
                  <Grid item xs={12} md={3}>
                    <Card>
                      <CardContent>
                        <Typography variant="h6" gutterBottom>
                          User Analytics
                        </Typography>
                        {agentModeAnalytics && (
                          <>
                            <Typography variant="h4" color="primary">
                              {agentModeAnalytics.activeUsers || 0}
                            </Typography>
                            <Typography variant="body2" color="text.secondary">
                              Active Users (in period)
                            </Typography>
                            <Typography variant="body2" color="text.secondary">
                              Total: {agentModeAnalytics.totalUsers || 0}
                            </Typography>
                            <Typography variant="body2" color="text.secondary">
                              New: {agentModeAnalytics.newUsers || 0}
                              <Box
                                component="span"
                                sx={{ color: "success.main", ml: 0.5 }}
                              >
                                •
                              </Box>
                              Returning: {agentModeAnalytics.returningUsers || 0}
                            </Typography>
                            <Typography variant="body2" color="text.secondary" sx={{ fontSize: '0.75rem' }}>
                              Anonymous: {agentModeAnalytics.activeAnonymousUsers || 0}
                              {agentModeAnalytics.totalAnonymousUsers !== undefined && (
                                <>
                                  {' '}(Total: {agentModeAnalytics.totalAnonymousUsers || 0})
                                </>
                              )}
                            </Typography>
                            <Typography variant="body2" color="text.secondary">
                              Avg Sessions/User: {agentModeAnalytics.averageSessionsPerActiveUser || 0}
                            </Typography>
                          </>
                        )}
                      </CardContent>
                    </Card>
                  </Grid>
                  <Grid item xs={12} md={3}>
                    <Card>
                      <CardContent>
                        <Typography variant="h6" gutterBottom>
                          Message Analytics
                        </Typography>
                        {agentModeAnalytics && (
                          <>
                            <Typography variant="h4" color="primary">
                              {agentModeAnalytics.messagesInRange || agentModeAnalytics.totalMessages || 0}
                            </Typography>
                            <Typography variant="body2" color="text.secondary">
                              Messages (in period)
                            </Typography>
                            <Typography variant="body2" color="text.secondary">
                              Total: {agentModeAnalytics.totalMessages || 0}
                            </Typography>
                            <Typography variant="body2" color="text.secondary">
                              Avg/Session: {agentModeAnalytics.averageMessagesPerSession || 0}
                            </Typography>
                            <Typography variant="body2" color="text.secondary">
                              Avg/Active User: {agentModeAnalytics.averageMessagesPerActiveUser || 0}
                            </Typography>
                            {agentModeAnalytics.messagesByRole && (
                              <>
                                <Typography variant="body2" color="text.secondary" sx={{ mt: 1, fontSize: '0.75rem' }}>
                                  User: {agentModeAnalytics.messagesByRole.user || 0} • 
                                  Assistant: {agentModeAnalytics.messagesByRole.assistant || 0}
                                </Typography>
                                <Typography variant="body2" color="text.secondary" sx={{ fontSize: '0.75rem' }}>
                                  With Attachments: {agentModeAnalytics.messagesWithAttachments || 0} • 
                                  With Tool Calls: {agentModeAnalytics.messagesWithToolCalls || 0}
                                </Typography>
                              </>
                            )}
                            {agentModeAnalytics.totalTokens > 0 && (
                              <Typography variant="body2" color="text.secondary" sx={{ fontSize: '0.75rem', mt: 0.5 }}>
                                Total Tokens: {(agentModeAnalytics.totalTokens / 1000).toFixed(1)}K
                              </Typography>
                            )}
                          </>
                        )}
                      </CardContent>
                    </Card>
                  </Grid>
                  <Grid item xs={12} md={3}>
                    <Card>
                      <CardContent>
                        <Typography variant="h6" gutterBottom>
                          Tool Calls
                        </Typography>
                        {agentModeAnalytics && (
                          <>
                            <Typography variant="h4" color="primary">
                              {agentModeAnalytics.toolCallsInRange || agentModeAnalytics.totalToolCalls || 0}
                            </Typography>
                            <Typography variant="body2" color="text.secondary">
                              Tool Calls (in period)
                            </Typography>
                            <Typography variant="body2" color="text.secondary">
                              Total: {agentModeAnalytics.totalToolCalls || 0}
                            </Typography>
                            <Typography variant="body2" color="text.secondary">
                              Avg/Session: {agentModeAnalytics.averageToolCallsPerSession || 0}
                            </Typography>
                            <Typography variant="body2" color="text.secondary">
                              Avg/Active User: {agentModeAnalytics.averageToolCallsPerActiveUser || 0}
                            </Typography>
                            <Typography variant="body2" color="text.secondary">
                              Sessions w/ Tools: {agentModeAnalytics.sessionsWithToolCallsInRange || agentModeAnalytics.sessionsWithToolCalls || 0}
                            </Typography>
                            {agentModeAnalytics.topToolsInRange && agentModeAnalytics.topToolsInRange.length > 0 && (
                              <Box sx={{ mt: 1 }}>
                                <Typography variant="caption" color="text.secondary" sx={{ fontSize: '0.7rem', fontWeight: 'bold' }}>
                                  Top Tools:
                                </Typography>
                                {agentModeAnalytics.topToolsInRange.slice(0, 3).map((tool: any, idx: number) => (
                                  <Typography key={idx} variant="caption" color="text.secondary" sx={{ display: 'block', fontSize: '0.7rem' }}>
                                    {idx + 1}. {tool.name}: {tool.count}
                                  </Typography>
                                ))}
                              </Box>
                            )}
                          </>
                        )}
                      </CardContent>
                    </Card>
                  </Grid>
                </Grid>

                {/* Agent Mode Growth Charts */}
                <Grid container spacing={3} sx={{ mb: 4 }}>
                  <Grid item xs={12} md={8}>
                    {agentModeAnalytics && (
                      <AgentModeSessionGrowthChart
                        data={agentModeAnalytics}
                        startDate={startDate ? format(startDate, "yyyy-MM-dd") : ""}
                        endDate={endDate ? format(endDate, "yyyy-MM-dd") : ""}
                      />
                    )}
                  </Grid>
                  <Grid item xs={12} md={4}>
                    {agentModeAnalytics && (
                      <AgentModeSessionTypesChart data={agentModeAnalytics} />
                    )}
                  </Grid>
                </Grid>
              </Box>
            </Box>
          )}
        </TabPanel>

        <TabPanel value={tabValue} index={1}>
          <Box component="form" onSubmit={handleAnnouncementSubmit}>
            {error && (
              <Alert severity="error" sx={{ mb: 3 }}>
                {error}
              </Alert>
            )}
            {success && (
              <Alert severity="success" sx={{ mb: 3 }}>
                {success}
              </Alert>
            )}

            {/* Load from URL section */}
            <Paper sx={{ p: 2, mb: 3, backgroundColor: "grey.50" }}>
              <Typography variant="subtitle2" gutterBottom>
                Load from HTML URL
              </Typography>
              <Box sx={{ display: "flex", gap: 2, alignItems: "flex-start" }}>
                <TextField
                  label="HTML URL"
                  value={htmlUrl}
                  onChange={(e) => setHtmlUrl(e.target.value)}
                  placeholder="https://example.com/page.html"
                  fullWidth
                  size="small"
                  disabled={loadingHtml}
                  helperText="Enter a URL to load title and content from an HTML file"
                />
                <Button
                  type="button"
                  variant="outlined"
                  onClick={handleLoadFromUrl}
                  disabled={loadingHtml || !htmlUrl.trim()}
                  sx={{ minWidth: 100, mt: 0.5 }}
                >
                  {loadingHtml ? <CircularProgress size={20} /> : "Load"}
                </Button>
              </Box>
            </Paper>

            <TextField
              label="Announcement Title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              fullWidth
              required
              sx={{ mb: 2 }}
            />

            <TextField
              label="Announcement Message"
              multiline
              rows={4}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              fullWidth
              required
              sx={{ mb: 1 }}
              helperText={
                <Typography variant="caption">
                  Supported HTML tags: <code>&lt;b&gt;</code> for bold,{" "}
                  <code>&lt;i&gt;</code> for italic,
                  <code>&lt;u&gt;</code> for underline,{" "}
                  <code>&lt;font color="..."&gt;</code> for text color,
                  <code>&lt;br&gt;</code> for line break
                </Typography>
              }
            />

            {message && (
              <Box sx={{ mt: 3, mb: 3 }}>
                <Typography variant="subtitle1" gutterBottom>
                  Preview:
                </Typography>
                <Paper
                  variant="outlined"
                  sx={{
                    p: 2,
                    backgroundColor: "grey.50",
                    minHeight: "100px",
                  }}
                >
                  <div
                    dangerouslySetInnerHTML={{
                      __html: DOMPurify.sanitize(message),
                    }}
                  />
                </Paper>
              </Box>
            )}

            <Box sx={{ display: "flex", gap: 2, mt: 2 }}>
              <Button
                type="submit"
                variant="contained"
                disabled={loading}
                sx={{ minWidth: 120 }}
              >
                {loading ? <CircularProgress size={24} /> : "Send"}
              </Button>
              <Button
                type="button"
                variant="outlined"
                onClick={() => setTestDialogOpen(true)}
                disabled={loading || !title.trim() || !message.trim()}
                sx={{ minWidth: 120 }}
              >
                Test
              </Button>
            </Box>
          </Box>

          {/* Test Email Dialog */}
          <Dialog
            open={testDialogOpen}
            onClose={() => !testLoading && setTestDialogOpen(false)}
            maxWidth="sm"
            fullWidth
          >
            <DialogTitle>Send Test Email</DialogTitle>
            <DialogContent>
              <DialogContentText sx={{ mb: 2 }}>
                Enter email addresses (comma or newline separated) to send a test announcement.
                The email will be marked as a test email.
              </DialogContentText>
              <TextField
                label="Recipients"
                multiline
                rows={4}
                value={testRecipients}
                onChange={(e) => setTestRecipients(e.target.value)}
                fullWidth
                placeholder="email1@example.com, email2@example.com"
                helperText="Enter email addresses separated by commas or newlines"
                disabled={testLoading}
              />
            </DialogContent>
            <DialogActions>
              <Button
                onClick={() => {
                  setTestDialogOpen(false);
                  setTestRecipients("");
                }}
                disabled={testLoading}
              >
                Cancel
              </Button>
              <Button
                onClick={handleTestAnnouncement}
                variant="contained"
                disabled={testLoading || !testRecipients.trim()}
              >
                {testLoading ? <CircularProgress size={24} /> : "Send Test"}
              </Button>
            </DialogActions>
          </Dialog>
        </TabPanel>

        <TabPanel value={tabValue} index={2}>
          {error && (
            <Alert severity="error" sx={{ mb: 3 }}>
              {error}
            </Alert>
          )}
          {success && (
            <Alert severity="success" sx={{ mb: 3 }}>
              {success}
            </Alert>
          )}
          <TableContainer component={Paper}>
            <Table>
              <TableHead>
                <TableRow>
                  <TableCell>
                    <UserSortLabel property="email" label="Email" />
                  </TableCell>
                  <TableCell>
                    <UserSortLabel property="userId" label="User ID" />
                  </TableCell>
                  <TableCell>
                    <UserSortLabel
                      property="stripe_customer_id"
                      label="Stripe Customer ID"
                    />
                  </TableCell>
                  <TableCell>
                    <UserSortLabel property="adAccount" label="Ad Account" />
                  </TableCell>
                  <TableCell>
                    <UserSortLabel
                      property="emailDomain"
                      label="Email Sender"
                    />
                  </TableCell>
                  <TableCell>
                    <UserSortLabel
                      property="slackChannel"
                      label="Slack Channel"
                    />
                  </TableCell>
                  <TableCell>
                    <UserSortLabel property="seoDomains" label="SEO/AEO" />
                  </TableCell>
                  <TableCell>
                    <UserSortLabel property="cmsType" label="CMS Type" />
                  </TableCell>
                  <TableCell>
                    <UserSortLabel property="createdAt" label="Created" />
                  </TableCell>
                  <TableCell>
                    <UserSortLabel
                      property="lastLoginTime"
                      label="Last Login"
                    />
                  </TableCell>
                  <TableCell>
                    <UserSortLabel
                      property="supportNote"
                      label="Support Note"
                    />
                  </TableCell>
                  <TableCell>
                    <UserSortLabel property="roles" label="Roles" />
                  </TableCell>
                  <TableCell>
                    <UserSortLabel
                      property="chatSessionCount"
                      label="Chat Sessions"
                    />
                  </TableCell>
                  <TableCell>
                    <UserSortLabel property="taskCount" label="Tasks" />
                  </TableCell>
                  <TableCell>
                    <UserSortLabel property="workflowCount" label="Workflows" />
                  </TableCell>
                  <TableCell>
                    <UserSortLabel
                      property="isOAuthUser"
                      label="OAuth User"
                    />
                  </TableCell>
                  <TableCell>
                    <UserSortLabel property="isAdmin" label="Admin" />
                  </TableCell>
                  <TableCell>
                    <UserSortLabel property="isActive" label="Status" />
                  </TableCell>
                  <TableCell>
                    <UserSortLabel
                      property="subscriptionType"
                      label="Subscription Type"
                    />
                  </TableCell>
                  <TableCell>Actions</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {adminLoading ? (
                  <TableRow>
                    <TableCell colSpan={20} align="center">
                      <CircularProgress />
                    </TableCell>
                  </TableRow>
                ) : (
                  sortedUsers.map((user) => {
                    // Determine roles to display, SOLELY from roles array.
                    let displayRoles: ("partner" | "customer" | "free")[] = [];
                    if (user.roles && user.roles.length > 0) {
                      displayRoles = user.roles; // Use the array if present and not empty
                    }
                    // If user.roles is empty or undefined, displayRoles remains [], meaning no roles will be shown.

                    return (
                      <TableRow key={user.userId}>
                        <TableCell>{user.email}</TableCell>
                        <TableCell>{user.userId}</TableCell>
                        <TableCell>{user.stripe_customer_id || "-"}</TableCell>
                        <TableCell>
                          {editingAdAccountUserId === user.userId ? (
                            <>
                                                              <TextField
                                  size="small"
                                  value={currentAdAccountText}
                                  onChange={(e) => setCurrentAdAccountText(e.target.value)}
                                  placeholder="Enter Meta Ad Account ID (e.g., 123456789012345)..."
                                  sx={{ minWidth: 250 }}
                                  disabled={adAccountEditLoading}
                                  helperText="Meta Ad Account ID from business.facebook.com"
                                />
                              <IconButton
                                size="small"
                                onClick={() => handleSaveAdAccount(user.userId)}
                                disabled={adAccountEditLoading}
                                color="primary"
                              >
                                <CheckIcon />
                              </IconButton>
                              <IconButton
                                size="small"
                                onClick={() => {
                                  setEditingAdAccountUserId(null);
                                  setCurrentAdAccountText("");
                                }}
                                disabled={adAccountEditLoading}
                              >
                                <CloseIcon />
                              </IconButton>
                            </>
                          ) : (
                            <>
                              <Typography variant="body2" sx={{ flex: 1, minWidth: 100 }}>
                                {user.adAccount || "-"}
                              </Typography>
                              <IconButton
                                size="small"
                                onClick={() => {
                                  setEditingAdAccountUserId(user.userId);
                                  setCurrentAdAccountText(user.adAccount || "");
                                }}
                                disabled={adAccountEditLoading}
                              >
                                <EditIcon />
                              </IconButton>
                            </>
                          )}
                        </TableCell>
                        <TableCell>
                          <Box sx={{ flex: 1, minWidth: 100 }}>
                            {user.emailDomain ? (
                              <div>
                                <div><strong>Domain:</strong> {user.emailDomain}</div>
                                {user.defaultSenderUsername && (
                                  <div><strong>Username:</strong> {user.defaultSenderUsername}</div>
                                )}
                                {user.fromName && (
                                  <div><strong>From:</strong> {user.fromName}</div>
                                )}
                              </div>
                            ) : "-"}
                          </Box>
                          <IconButton
                            type="button"
                            size="small"
                            onClick={() => {
                              setEditingEmailSenderUserId(user.userId);
                              setEmailDomain(user.emailDomain || "");
                              setDefaultSenderUsername(user.defaultSenderUsername || "");
                              setFromName(user.fromName || "");
                              setEmailSenderDialogOpen(true);
                            }}
                            disabled={emailSenderEditLoading}
                          >
                            <EditIcon />
                          </IconButton>
                        </TableCell>
                        <TableCell>
                          <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                            <Typography variant="body2" sx={{ flex: 1, minWidth: 100 }}>
                              {user.slackChannel || "-"}
                            </Typography>
                            <IconButton
                              size="small"
                              onClick={() => {
                                setEditingSlackChannelUserId(user.userId);
                                setCurrentSlackChannelText(user.slackChannel || "");
                                setSlackChannelDialogOpen(true);
                              }}
                              disabled={slackChannelEditLoading}
                            >
                              <EditIcon />
                            </IconButton>
                          </Box>
                        </TableCell>
                        <TableCell>
                          <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                            <Box sx={{ flex: 1, minWidth: 200 }}>
                              {user.seoDomains && user.seoDomains.length > 0 ? (
                                <Box sx={{ mb: 1 }}>
                                  {user.seoDomains.map((domain: string, idx: number) => (
                                    <Chip
                                      key={idx}
                                      label={domain}
                                      size="small"
                                      sx={{ mr: 0.5, mb: 0.5 }}
                                    />
                                  ))}
                                </Box>
                              ) : (
                                <Typography variant="body2" sx={{ mb: 1 }}>
                                  No domains
                                </Typography>
                              )}
                              {user.googleAnalyticsPropertyId ? (
                                <Typography variant="body2" color="text.secondary">
                                  GA: {user.googleAnalyticsPropertyId}
                                </Typography>
                              ) : (
                                <Typography variant="body2" color="text.secondary">
                                  No GA ID
                                </Typography>
                              )}
                              {user.clarityProjectId ? (
                                <Typography variant="body2" color="text.secondary">
                                  Clarity: {user.clarityProjectId}
                                </Typography>
                              ) : (
                                <Typography variant="body2" color="text.secondary">
                                  No Clarity ID
                                </Typography>
                              )}
                              {user.productDomain ? (
                                <Typography variant="body2" color="text.secondary">
                                  Product: {user.productDomain}
                                </Typography>
                              ) : (
                                <Typography variant="body2" color="text.secondary">
                                  No Product Domain
                                </Typography>
                              )}
                            </Box>
                            <IconButton
                              size="small"
                              onClick={() => {
                                setEditingSeoDomainsUserId(user.userId);
                                setSeoDomainsText(user.seoDomains?.join("\n") || "");
                                setGoogleAnalyticsPropertyId(user.googleAnalyticsPropertyId || "");
                                setGaFilteredDomainsText(user.gaFilteredDomains?.join("\n") || "");
                                setClarityProjectId(user.clarityProjectId || "");
                                setProductDomain(user.productDomain || "");
                                setSeoDomainsDialogOpen(true);
                              }}
                              disabled={seoDomainsEditLoading}
                            >
                              <EditIcon />
                            </IconButton>
                          </Box>
                        </TableCell>
                        <TableCell>
                          <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                            {editingCmsTypeUserId === user.userId ? (
                              <>
                                <FormControl size="small" sx={{ minWidth: 120 }}>
                                  <Select
                                    value={currentCmsType}
                                    onChange={(e) => setCurrentCmsType(e.target.value as "Basehub" | "Webflow" | "")}
                                    disabled={cmsTypeEditLoading}
                                  >
                                    <MenuItem value="">None</MenuItem>
                                    <MenuItem value="Basehub">Basehub</MenuItem>
                                    <MenuItem value="Webflow">Webflow</MenuItem>
                                  </Select>
                                </FormControl>
                                <IconButton
                                  size="small"
                                  onClick={handleSaveCmsType}
                                  disabled={cmsTypeEditLoading}
                                  color="primary"
                                >
                                  <CheckIcon />
                                </IconButton>
                                <IconButton
                                  size="small"
                                  onClick={() => {
                                    setEditingCmsTypeUserId(null);
                                    setCurrentCmsType("");
                                  }}
                                  disabled={cmsTypeEditLoading}
                                >
                                  <CloseIcon />
                                </IconButton>
                              </>
                            ) : (
                              <>
                                <Typography variant="body2" sx={{ flex: 1, minWidth: 100 }}>
                                  {user.cmsType || "-"}
                                </Typography>
                                <IconButton
                                  size="small"
                                  onClick={() => {
                                    setEditingCmsTypeUserId(user.userId);
                                    setCurrentCmsType(user.cmsType || "");
                                  }}
                                  disabled={cmsTypeEditLoading}
                                >
                                  <EditIcon />
                                </IconButton>
                              </>
                            )}
                          </Box>
                        </TableCell>
                        <TableCell>
                          {new Date(user.createdAt).toLocaleDateString()}
                        </TableCell>
                        <TableCell>
                          {user.lastLoginTime 
                            ? new Date(user.lastLoginTime).toLocaleDateString() + ' ' + 
                              new Date(user.lastLoginTime).toLocaleTimeString()
                            : "Never"
                          }
                        </TableCell>
                        <TableCell>
                          <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                            {editingSupportNoteUserId === user.userId ? (
                              <>
                                <TextField
                                  size="small"
                                  value={currentSupportNoteText}
                                  onChange={(e) => setCurrentSupportNoteText(e.target.value)}
                                  placeholder="Add support note..."
                                  sx={{ minWidth: 200 }}
                                  disabled={supportNoteEditLoading}
                                />
                                <IconButton
                                  size="small"
                                  onClick={() => handleSaveSupportNote(user.userId)}
                                  disabled={supportNoteEditLoading}
                                  color="primary"
                                >
                                  <CheckIcon />
                                </IconButton>
                                <IconButton
                                  size="small"
                                  onClick={() => {
                                    setEditingSupportNoteUserId(null);
                                    setCurrentSupportNoteText("");
                                  }}
                                  disabled={supportNoteEditLoading}
                                >
                                  <CloseIcon />
                                </IconButton>
                              </>
                            ) : (
                              <>
                                <Typography variant="body2" sx={{ flex: 1, minWidth: 100 }}>
                                  {user.supportNote || "-"}
                                </Typography>
                                <IconButton
                                  size="small"
                                  onClick={() => {
                                    setEditingSupportNoteUserId(user.userId);
                                    setCurrentSupportNoteText(user.supportNote || "");
                                  }}
                                  disabled={supportNoteEditLoading}
                                >
                                  <EditIcon />
                                </IconButton>
                              </>
                            )}
                          </Box>
                        </TableCell>
                        <TableCell>
                          <Box
                            sx={{ display: "flex", gap: 0.5, flexWrap: "wrap" }}
                          >
                            {displayRoles.map(
                              (role) => (
                                <Chip
                                  key={role}
                                  label={
                                    role.charAt(0).toUpperCase() + role.slice(1)
                                  }
                                  size="small"
                                  color={
                                    role === "partner" ? "primary" : "secondary"
                                  }
                                  icon={
                                    role === "partner" ? (
                                      <HandshakeIcon fontSize="small" />
                                    ) : (
                                      <PersonIcon fontSize="small" />
                                    )
                                  }
                                  sx={{
                                    height: "auto", // Ensure icon doesn't overly stretch chip
                                    "& .MuiChip-label": { py: "1px" }, // Adjust padding if needed
                                  }}
                                />
                              )
                            )}
                          </Box>
                        </TableCell>
                        <TableCell>
                          <Chip
                            label={user.chatSessionCount || 0}
                            size="small"
                            color={
                              (user.chatSessionCount ?? 0) > 0
                                ? "primary"
                                : "default"
                            }
                          />
                        </TableCell>
                        <TableCell>
                          <Chip
                            label={user.taskCount || 0}
                            size="small"
                            color={(user.taskCount ?? 0) > 0 ? "primary" : "default"}
                            style={{ cursor: (user.taskCount ?? 0) > 0 ? "pointer" : undefined }}
                            onClick={() => {
                              if ((user.taskCount ?? 0) > 0) {
                                setUserTasksDialogUserId(user.userId);
                                setUserTasksDialogUserEmail(user.email);
                                setUserTasksDialogOpen(true);
                              }
                            }}
                          />
                        </TableCell>
                        <TableCell>
                          <Chip
                            label={user.workflowCount || 0}
                            size="small"
                            color={
                              (user.workflowCount ?? 0) > 0
                                ? "primary"
                                : "default"
                            }
                          />
                        </TableCell>
                        <TableCell>{user.isOAuthUser ? "Yes" : "No"}</TableCell>
                        <TableCell>{user.isAdmin ? "Yes" : "No"}</TableCell>
                        <TableCell>
                          <Chip
                            label={
                              user.isActive === false ? "Inactive" : "Active"
                            }
                            color={
                              user.isActive === false ? "error" : "success"
                            }
                            size="small"
                          />
                        </TableCell>
                        <TableCell>
                          {user.roles && user.roles.includes("customer") ? (
                            <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                              {editingSubscriptionTypeUserId === user.userId ? (
                                <>
                                  <FormControl size="small" sx={{ minWidth: 120 }}>
                                    <Select
                                      value={currentSubscriptionType}
                                      onChange={(e) => setCurrentSubscriptionType(e.target.value)}
                                      disabled={subscriptionTypeEditLoading}
                                    >
                                      {availableSubscriptionTypes.map((type) => (
                                        <MenuItem key={type} value={type}>
                                          {type}
                                        </MenuItem>
                                      ))}
                                    </Select>
                                  </FormControl>
                                  <IconButton
                                    size="small"
                                    onClick={handleSaveSubscriptionType}
                                    disabled={subscriptionTypeEditLoading}
                                    color="primary"
                                  >
                                    <CheckIcon />
                                  </IconButton>
                                  <IconButton
                                    size="small"
                                    onClick={() => {
                                      setEditingSubscriptionTypeUserId(null);
                                      setCurrentSubscriptionType("");
                                    }}
                                    disabled={subscriptionTypeEditLoading}
                                  >
                                    <CloseIcon />
                                  </IconButton>
                                </>
                              ) : (
                                <>
                                  <Typography variant="body2" sx={{ flex: 1, minWidth: 100 }}>
                                    {user.subscriptionType || "Basic"}
                                  </Typography>
                                  <IconButton
                                    size="small"
                                    onClick={() => {
                                      setEditingSubscriptionTypeUserId(user.userId);
                                      setCurrentSubscriptionType(user.subscriptionType || "Basic");
                                    }}
                                    disabled={subscriptionTypeEditLoading}
                                  >
                                    <EditIcon />
                                  </IconButton>
                                </>
                              )}
                            </Box>
                          ) : (
                            <Typography variant="body2" color="text.secondary">
                              -
                            </Typography>
                          )}
                        </TableCell>
                        <TableCell>
                          <Box sx={{ display: "flex", gap: 0.5, alignItems: "center", flexWrap: "nowrap" }}>
                            {user.roles && user.roles.includes("customer") && (
                              <Tooltip title="Access Customer Portal">
                                <IconButton
                                  size="small"
                                  onClick={() => handleAccessCustomerPortal(user.userId)}
                                  disabled={delegateAccessLoading === user.userId}
                                  color="primary"
                                  sx={{
                                    border: '1px solid',
                                    borderColor: 'primary.main',
                                    '&:hover': { bgcolor: 'primary.50' }
                                  }}
                                >
                                  {delegateAccessLoading === user.userId ? (
                                    <CircularProgress size={16} />
                                  ) : (
                                    <OpenInNewIcon fontSize="small" />
                                  )}
                                </IconButton>
                              </Tooltip>
                            )}

                            <Tooltip title="Manage Roles">
                              <IconButton
                                size="small"
                                onClick={() => handleRoleDialogOpen(user)}
                                color="primary"
                                sx={{ 
                                  border: '1px solid',
                                  borderColor: 'primary.main',
                                  '&:hover': { bgcolor: 'primary.50' }
                                }}
                              >
                                <EditIcon fontSize="small" />
                              </IconButton>
                            </Tooltip>
                            
                            {!user.isAdmin && user.isActive !== false && (
                              <Tooltip title="Deactivate User">
                                <IconButton
                                  size="small"
                                  onClick={() => {
                                    setSelectedUser(user);
                                    setDeactivateDialogOpen(true);
                                  }}
                                  color="warning"
                                  sx={{ 
                                    border: '1px solid',
                                    borderColor: 'warning.main',
                                    '&:hover': { bgcolor: 'warning.50' }
                                  }}
                                >
                                  <PersonOffIcon fontSize="small" />
                                </IconButton>
                              </Tooltip>
                            )}
                            
                            <Tooltip title="Set Password">
                              <IconButton
                                size="small"
                                onClick={() => handleSetPassword(user.userId, user.email)}
                                color="secondary"
                                sx={{ 
                                  border: '1px solid',
                                  borderColor: 'secondary.main',
                                  '&:hover': { bgcolor: 'secondary.50' }
                                }}
                              >
                                <LockIcon fontSize="small" />
                              </IconButton>
                            </Tooltip>
                            
                            {!user.isAdmin && (
                              <Tooltip title="Delete User">
                                <IconButton
                                  size="small"
                                  onClick={() => handleOpenUserDeleteConfirm(user.userId)}
                                  color="error"
                                  sx={{ 
                                    border: '1px solid',
                                    borderColor: 'error.main',
                                    '&:hover': { bgcolor: 'error.50' }
                                  }}
                                >
                                  <DeleteIcon fontSize="small" />
                                </IconButton>
                              </Tooltip>
                            )}
                          </Box>
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </TableContainer>
        </TabPanel>

        <TabPanel value={tabValue} index={3}>
          {error && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {error}
            </Alert>
          )}
          {success && (
            <Alert severity="success" sx={{ mb: 2 }}>
              {success}
            </Alert>
          )}

          {/* Manual Invite Button */}
          <Box sx={{ display: "flex", justifyContent: "flex-end", mb: 2 }}>
            <Button
              variant="contained"
              startIcon={<PersonAddIcon />}
              onClick={handleManualInviteOpen}
              disabled={adminLoading}
            >
              Manual Invite
            </Button>
          </Box>

          <TableContainer component={Paper}>
            <Table>
              <TableHead>
                <TableRow>
                  <TableCell>
                    <WaitlistSortLabel property="email" label="Email" />
                  </TableCell>
                  <TableCell>
                    <WaitlistSortLabel
                      property="stripe_customer_id"
                      label="Stripe Customer ID"
                    />
                  </TableCell>
                  <TableCell>
                    <WaitlistSortLabel property="fullName" label="Full Name" />
                  </TableCell>
                  <TableCell>
                    <WaitlistSortLabel property="companyName" label="Company" />
                  </TableCell>
                  <TableCell>
                    <WaitlistSortLabel property="phoneNumber" label="Phone Number" />
                  </TableCell>
                  <TableCell>
                    <WaitlistSortLabel
                      property="monthlyMarketingSpend"
                      label="Marketing Spend"
                    />
                  </TableCell>
                  <TableCell>
                    <WaitlistSortLabel
                      property="marketingChannels"
                      label="Marketing Channels"
                    />
                  </TableCell>
                  <TableCell>
                    <WaitlistSortLabel property="businessArea" label="Business Area" />
                  </TableCell>
                  <TableCell>
                    <WaitlistSortLabel property="joinedAt" label="Joined" />
                  </TableCell>
                  <TableCell>Details</TableCell>
                  <TableCell>
                    <WaitlistSortLabel
                      property="useCaseDescription"
                      label="Use Case"
                    />
                  </TableCell>
                  <TableCell>
                    <WaitlistSortLabel
                      property="requestReport"
                      label="Request Report"
                    />
                  </TableCell>
                  <TableCell>
                    <WaitlistSortLabel
                      property="supportNote"
                      label="Support Note"
                    />
                  </TableCell>
                  <TableCell>
                    <WaitlistSortLabel property="status" label="Status" />
                  </TableCell>
                  <TableCell>Actions</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {adminLoading ? (
                  <TableRow>
                    <TableCell colSpan={12} align="center">
                      <CircularProgress />
                    </TableCell>
                  </TableRow>
                ) : (
                  sortedWaitlist.map((entry: WaitlistEntry) => {
                    const existingUser = contextUsers.find(
                      (user) => user.email === entry.email
                    );
                    const userExists = !!existingUser;
                    const isFreeUserOnly = existingUser && existingUser.roles?.includes('free') && !existingUser.roles?.some(role => role !== 'free');
                    const isRegisteredUser = existingUser && existingUser.roles?.some(role => role !== 'free');
                    return (
                      <TableRow key={entry.email}>
                        <TableCell>{entry.email}</TableCell>
                        <TableCell>{entry.stripe_customer_id || "-"}</TableCell>
                        <TableCell>{entry.fullName || "-"}</TableCell>
                        <TableCell>{entry.companyName || "-"}</TableCell>
                        <TableCell>{entry.phoneNumber || "-"}</TableCell>
                        <TableCell>
                          {entry.monthlyMarketingSpend || "N/A"}
                        </TableCell>
                        <TableCell>
                          {entry.marketingChannels &&
                          entry.marketingChannels.length > 0 ? (
                            <Box
                              sx={{
                                display: "flex",
                                flexWrap: "wrap",
                                gap: 0.5,
                              }}
                            >
                              {entry.marketingChannels.map((channel) => (
                                <Chip
                                  key={channel}
                                  label={channel}
                                  size="small"
                                />
                              ))}
                            </Box>
                          ) : (
                            <Typography variant="body2" color="text.secondary">
                              Not specified
                            </Typography>
                          )}
                        </TableCell>
                        <TableCell>{entry.businessArea || "N/A"}</TableCell>
                        <TableCell>
                          {entry.joinedAt
                            ? new Date(entry.joinedAt).toLocaleDateString()
                            : "-"}
                        </TableCell>
                        <TableCell>
                          <Tooltip
                            title={
                              entry.phoneNumber
                                ? `Phone: ${entry.phoneNumber}`
                                : "No phone number"
                            }
                          >
                            <InfoIcon color="action" />
                          </Tooltip>
                        </TableCell>
                        <TableCell>
                          {entry.useCaseCategories &&
                          entry.useCaseCategories.length > 0 ? (
                            <Box
                              sx={{
                                display: "flex",
                                flexWrap: "wrap",
                                gap: 0.5,
                              }}
                            >
                              {entry.useCaseCategories.map(
                                (category: string) => (
                                  <Chip
                                    key={category}
                                    label={category}
                                    size="small"
                                  />
                                )
                              )}
                            </Box>
                          ) : (
                            <Typography variant="body2" color="text.secondary">
                              Not specified
                            </Typography>
                          )}
                        </TableCell>
                        <TableCell>
                          {entry.useCaseDescription ? (
                            <Tooltip
                              title={
                                <Typography
                                  variant="body2"
                                  style={{ whiteSpace: "pre-wrap" }}
                                >
                                  {entry.useCaseDescription}
                                </Typography>
                              }
                              placement="top-start"
                              arrow
                              enterDelay={500}
                              leaveDelay={200}
                              sx={{ maxWidth: 500 }}
                            >
                              <Box
                                sx={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: 0.5,
                                }}
                              >
                                <Typography
                                  variant="body2"
                                  sx={{
                                    maxWidth: 220,
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                    whiteSpace: "nowrap",
                                    cursor: "pointer",
                                  }}
                                >
                                  {entry.useCaseDescription}
                                </Typography>
                                <InfoIcon
                                  fontSize="small"
                                  color="action"
                                  sx={{
                                    opacity: 0.7,
                                    "&:hover": { opacity: 1 },
                                  }}
                                />
                              </Box>
                            </Tooltip>
                          ) : (
                            <Typography variant="body2" color="text.secondary">
                              Not specified
                            </Typography>
                          )}
                        </TableCell>
                        <TableCell>
                          <Chip
                            label={
                              typeof entry.requestReport === "boolean"
                                ? entry.requestReport
                                  ? "Yes"
                                  : "No"
                                : "N/A"
                            }
                            size="small"
                            color={
                              entry.requestReport === true
                                ? "primary"
                                : entry.requestReport === false
                                ? "default"
                                : "error"
                            }
                          />
                        </TableCell>
                        <TableCell>
                          <Box
                            sx={{
                              maxWidth: 200,
                              whiteSpace: "nowrap",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              display: "flex",
                              alignItems: "center",
                            }}
                          >
                            <Tooltip title={entry.supportNote || "No note"}>
                              <span>
                                {entry.supportNote || (
                                  <Typography
                                    variant="body2"
                                    color="text.secondary"
                                  >
                                    No note
                                  </Typography>
                                )}
                              </span>
                            </Tooltip>
                            <IconButton
                              size="small"
                              onClick={() =>
                                handleEditNoteClick(
                                  entry.email,
                                  entry.supportNote || ""
                                )
                              }
                            >
                              <EditIcon fontSize="small" />
                            </IconButton>
                          </Box>
                        </TableCell>
                        <TableCell>
                          <Chip
                            label={entry.status}
                            color={
                              entry.status === "invited"
                                ? "success"
                                : entry.status === "rejected"
                                ? "error"
                                : "default"
                            }
                            size="small"
                          />
                        </TableCell>
                        <TableCell>
                          <Box
                            sx={{
                              display: "flex",
                              alignItems: "center",
                              gap: 0.5,
                            }}
                          >
                            <Tooltip title="Edit All Fields">
                              <IconButton
                                size="small"
                                onClick={() => handleEditWaitlistOpen(entry)}
                                color="info"
                                sx={{
                                  border: '1px solid',
                                  borderColor: 'info.main',
                                  '&:hover': { bgcolor: 'info.50' }
                                }}
                              >
                                <EditIcon fontSize="small" />
                              </IconButton>
                            </Tooltip>
                            {(!userExists || isFreeUserOnly) && entry.status !== "invited" && !isRegisteredUser && (
                              <Button
                                variant="outlined"
                                size="small"
                                onClick={() =>
                                  handleWaitlistAction(entry.email, "invited")
                                }
                              >
                                Invite
                              </Button>
                            )}
                            {(!userExists || isFreeUserOnly) && entry.status === "invited" && !isRegisteredUser && (
                              <Button
                                variant="outlined"
                                size="small"
                                onClick={() =>
                                  handleResendInvitation(entry.email)
                                }
                              >
                                Resend
                              </Button>
                            )}
                            {!userExists && !adminLoading && (
                              <Tooltip title="Create User">
                                <IconButton
                                  size="small"
                                  onClick={() => handleCreateUserClick(entry.email)}
                                  sx={{ ml: 1, color: "primary.main" }}
                                >
                                  <AddIcon />
                                </IconButton>
                              </Tooltip>
                            )}
                            {existingUser && (
                              <Typography
                                variant="body2"
                                color={isRegisteredUser ? "text.secondary" : "warning.main"}
                              >
                                {isRegisteredUser ? 'Registered' : 'Free User'}
                              </Typography>
                            )}
                            {/* Delete Button - visible for all entries for now */}
                            <IconButton
                              aria-label="delete waitlist entry"
                              size="small"
                              onClick={() =>
                                handleOpenDeleteConfirm(entry.email)
                              }
                              sx={{ color: "error.main" }} // Make it red
                            >
                              <DeleteIcon fontSize="small" />
                            </IconButton>
                          </Box>
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </TableContainer>
        </TabPanel>

        <TabPanel value={tabValue} index={4}>
          <TableContainer component={Paper}>
            <Table>
              <TableHead>
                <TableRow>
                  <TableCell>
                    <SortLabel property="taskId" label="Task ID" />
                  </TableCell>
                  <TableCell>
                    <SortLabel property="name" label="Name" />
                  </TableCell>
                  <TableCell>
                    <SortLabel property="prompt" label="Prompt" />
                  </TableCell>
                  <TableCell>
                    <SortLabel property="userId" label="Owner" />
                  </TableCell>
                  <TableCell>
                    <SortLabel property="createdAt" label="Created At" />
                  </TableCell>
                  <TableCell>
                    Preferred LLM
                  </TableCell>
                  <TableCell>
                    Image Model
                  </TableCell>
                  <TableCell>
                    <SortLabel
                      property="latestRunStatus"
                      label="Latest Run Status"
                    />
                  </TableCell>
                  <TableCell>
                    <SortLabel
                      property="latestRunTime"
                      label="Latest Run Time"
                    />
                  </TableCell>
                  <TableCell>
                    <SortLabel
                      property="completedRuns"
                      label="Completed/Total Runs"
                    />
                  </TableCell>
                  <TableCell>Details</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {adminLoading ? (
                  <TableRow>
                    <TableCell colSpan={9} align="center">
                      <CircularProgress />
                    </TableCell>
                  </TableRow>
                ) : (
                  sortedAdminTasks.map((task) => (
                    <TableRow key={task.taskId}>
                      <TableCell>{task.taskId}</TableCell>
                      <TableCell>{task.name}</TableCell>
                      <TableCell>
                        {task.prompt.length > 100
                          ? `${task.prompt.substring(0, 100)}...`
                          : task.prompt}
                      </TableCell>
                      <TableCell>{task.userId}</TableCell>
                      <TableCell>
                        {new Date(task.createdAt).toLocaleDateString()}
                      </TableCell>
                      <TableCell>
                        {task.preferredLLM || task.llmName || '—'}
                      </TableCell>
                      <TableCell>
                        {task.imageModel || task.image_model || '—'}
                      </TableCell>
                      <TableCell>
                        <Chip
                          label={task.latestRunStatus || "none"}
                          color={
                            task.latestRunStatus === "completed"
                              ? "success"
                              : task.latestRunStatus === "failed"
                              ? "error"
                              : task.latestRunStatus === "pending"
                              ? "warning"
                              : task.latestRunStatus === "running"
                              ? "info"
                              : "default"
                          }
                          size="small"
                        />
                      </TableCell>
                      <TableCell>
                        {task.latestRunTime
                          ? new Date(task.latestRunTime).toLocaleString()
                          : "Never"}
                      </TableCell>
                      <TableCell>
                        {task.completedRuns || 0}/{task.totalRuns || 0}
                        {task.totalRuns != null && task.totalRuns > 0 && (
                          <Box component="span" sx={{ ml: 1 }}>
                            (
                            {Math.round(
                              ((task.completedRuns || 0) / task.totalRuns) * 100
                            )}
                            %)
                          </Box>
                        )}
                      </TableCell>
                      <TableCell>
                        <Button
                          size="small"
                          component={RouterLink}
                          to={`/tasks/${task.taskId}`}
                          target="_blank"
                        >
                          View Details
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </TableContainer>
        </TabPanel>

        <TabPanel value={tabValue} index={5}>
          <TableContainer component={Paper}>
            <Table>
              <TableHead>
                <TableRow>
                  <TableCell>
                    <SortLabel property="workflowId" label="Workflow ID" />
                  </TableCell>
                  <TableCell>
                    <SortLabel property="name" label="Name" />
                  </TableCell>
                  <TableCell>
                    <SortLabel property="description" label="Description" />
                  </TableCell>
                  <TableCell>
                    <SortLabel property="userId" label="Owner" />
                  </TableCell>
                  <TableCell>
                    <SortLabel property="createdAt" label="Created At" />
                  </TableCell>
                  <TableCell>
                    <SortLabel
                      property="latestRunStatus"
                      label="Latest Run Status"
                    />
                  </TableCell>
                  <TableCell>
                    <SortLabel
                      property="latestRunTime"
                      label="Latest Run Time"
                    />
                  </TableCell>
                  <TableCell>
                    <SortLabel
                      property="completedRuns"
                      label="Completed/Total Runs"
                    />
                  </TableCell>
                  <TableCell>
                    <SortLabel
                      property="completedTasks"
                      label="Completed/Total Tasks"
                    />
                  </TableCell>
                  <TableCell>Details</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {adminLoading ? (
                  <TableRow>
                    <TableCell colSpan={10} align="center">
                      <CircularProgress />
                    </TableCell>
                  </TableRow>
                ) : (
                  workflows.map((workflow) => (
                    <TableRow key={workflow.workflowId}>
                      <TableCell>{workflow.workflowId}</TableCell>
                      <TableCell>{workflow.name}</TableCell>
                      <TableCell>
                        {workflow.description?.length > 100
                          ? `${workflow.description.substring(0, 100)}...`
                          : workflow.description}
                      </TableCell>
                      <TableCell>{workflow.userId}</TableCell>
                      <TableCell>
                        {new Date(workflow.createdAt).toLocaleDateString()}
                      </TableCell>
                      <TableCell>
                        <Chip
                          label={workflow.latestRunStatus || "none"}
                          color={
                            workflow.latestRunStatus === "completed"
                              ? "success"
                              : workflow.latestRunStatus === "failed"
                              ? "error"
                              : workflow.latestRunStatus === "pending"
                              ? "warning"
                              : workflow.latestRunStatus === "running"
                              ? "info"
                              : "default"
                          }
                          size="small"
                        />
                      </TableCell>
                      <TableCell>
                        {workflow.latestRunTime
                          ? new Date(workflow.latestRunTime).toLocaleString()
                          : "Never"}
                      </TableCell>
                      <TableCell>
                        {workflow.completedRuns || 0}/{workflow.totalRuns || 0}
                        {workflow.totalRuns != null &&
                          workflow.totalRuns > 0 && (
                            <Box component="span" sx={{ ml: 1 }}>
                              (
                              {Math.round(
                                ((workflow.completedRuns || 0) /
                                  workflow.totalRuns) *
                                  100
                              )}
                              %)
                            </Box>
                          )}
                      </TableCell>
                      <TableCell>
                        {workflow.completedTasks || 0}/
                        {workflow.totalTasks || 0}
                        {workflow.totalTasks != null &&
                          workflow.totalTasks > 0 && (
                            <Box component="span" sx={{ ml: 1 }}>
                              (
                              {Math.round(
                                ((workflow.completedTasks || 0) /
                                  workflow.totalTasks) *
                                  100
                              )}
                              %)
                            </Box>
                          )}
                      </TableCell>
                      <TableCell>
                        <Link
                          component={RouterLink}
                          to={`/workflows/${workflow.workflowId}/run`}
                          color="primary"
                          underline="hover"
                        >
                          View Details
                        </Link>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </TableContainer>
        </TabPanel>

        <TabPanel value={tabValue} index={6}>
          {error && (
            <Alert severity="error" sx={{ mb: 3 }}>
              {error}
            </Alert>
          )}
          <TableContainer component={Paper}>
            <Table>
              <TableHead>
                <TableRow>
                  <TableCell>Session ID</TableCell>
                  <TableCell>User ID</TableCell>
                  <TableCell>Portal Type</TableCell>
                  <TableCell>Session Type</TableCell>
                  <TableCell>Created At</TableCell>
                  <TableCell>Updated At</TableCell>
                  <TableCell>Message Count</TableCell>
                  <TableCell>Feedback</TableCell>
                  <TableCell>Actions</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {chatSessionsLoading && chatSessions.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={9} align="center">
                      <CircularProgress />
                    </TableCell>
                  </TableRow>
                ) : (
                  <>
                    {chatSessions.map((session) => (
                      <TableRow key={session.sessionId}>
                        <TableCell component="th" scope="row">
                          <Tooltip title={session.sessionId}>
                            <span>{`${session.sessionId.substring(
                              0,
                              8
                            )}...`}</span>
                          </Tooltip>
                        </TableCell>
                        <TableCell>
                          <Link
                            component={RouterLink}
                            to={`/profile/${session.userId}`}
                            color="primary"
                            underline="hover"
                          >
                            {session.userId}
                          </Link>
                        </TableCell>
                        <TableCell>
                          {session.portalType ? (
                            <Chip
                              label={
                                session.portalType.charAt(0).toUpperCase() +
                                session.portalType.slice(1)
                              }
                              color={
                                session.portalType === "customer"
                                  ? "secondary"
                                  : "primary"
                              }
                              size="small"
                            />
                          ) : (
                            <Chip label="Partner" color="primary" size="small" />
                          )}
                        </TableCell>
                        <TableCell>
                          {session.sessionType ? (
                            <Chip
                              label={
                                session.sessionType === "predefined-work-plan"
                                  ? "Predefined Work Plan"
                                  : session.sessionType === "scheduled"
                                  ? "Scheduled"
                                  : session.sessionType === "image-generation"
                                  ? "Image Generation"
                                  : session.sessionType === "video-generation"
                                  ? "Video Generation"
                                  : session.sessionType === "book-generation"
                                  ? "Book Generation"
                                  : session.sessionType === "report_generation"
                                  ? "Report Generation"
                                  : "Regular"
                              }
                              color={
                                session.sessionType === "predefined-work-plan"
                                  ? "primary"
                                  : session.sessionType === "scheduled"
                                  ? "secondary"
                                  : session.sessionType === "image-generation"
                                  ? "success"
                                  : session.sessionType === "video-generation"
                                  ? "info"
                                  : session.sessionType === "book-generation"
                                  ? "info"
                                  : session.sessionType === "report_generation"
                                  ? "warning"
                                  : "default"
                              }
                              size="small"
                            />
                          ) : (
                            <Chip label="Undefined" color="default" size="small" />
                          )}
                        </TableCell>
                        <TableCell>
                          {format(new Date(session.createdAt), "Pp")}
                        </TableCell>
                        <TableCell>
                          {format(new Date(session.updatedAt), "Pp")}
                        </TableCell>
                        <TableCell>
                          <Chip
                            label={session.messages?.length || 0}
                            color="primary"
                            size="small"
                          />
                        </TableCell>
                        <TableCell>
                          {(() => {
                            const likes = session.messages?.filter((msg: any) =>
                              msg?.role === 'assistant' && msg?.metadata?.feedback?.type === 'like'
                            ).length || 0;
                            const dislikes = session.messages?.filter((msg: any) =>
                              msg?.role === 'assistant' && msg?.metadata?.feedback?.type === 'dislike'
                            ).length || 0;

                            if (likes === 0 && dislikes === 0) {
                              return <span style={{ color: '#999' }}>-</span>;
                            }

                            return (
                              <Box sx={{ display: 'flex', gap: 0.5, alignItems: 'center' }}>
                                {likes > 0 && (
                                  <Chip
                                    icon={<ThumbUpIcon sx={{ fontSize: '0.9rem' }} />}
                                    label={likes}
                                    size="small"
                                    sx={{
                                      backgroundColor: 'rgba(76, 175, 80, 0.1)',
                                      color: 'success.main',
                                      '& .MuiChip-icon': { color: 'success.main' }
                                    }}
                                  />
                                )}
                                {dislikes > 0 && (
                                  <Chip
                                    icon={<ThumbDownIcon sx={{ fontSize: '0.9rem' }} />}
                                    label={dislikes}
                                    size="small"
                                    sx={{
                                      backgroundColor: 'rgba(244, 67, 54, 0.1)',
                                      color: 'error.main',
                                      '& .MuiChip-icon': { color: 'error.main' }
                                    }}
                                  />
                                )}
                              </Box>
                            );
                          })()}
                        </TableCell>
                        <TableCell>
                          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                            <Button
                              variant="outlined"
                              size="small"
                              onClick={() => handleViewChat(session)}
                            >
                              Debug Chat
                            </Button>
                            {session.shareMetadata?.isShared && !(session.interactiveShareMetadata?.isActive && session.interactiveShareMetadata?.token) && (
                              <Button
                                variant="outlined"
                                size="small"
                                color="error"
                                component="a"
                                href={`${CUSTOMER_FRONTEND_URL}/share/${session.sessionId}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                sx={{ textAlign: 'center' }}
                              >
                                Shared Chat
                              </Button>
                            )}
                            {session.interactiveShareMetadata?.isActive && session.interactiveShareMetadata?.token && (
                              <Button
                                variant="outlined"
                                size="small"
                                color="error"
                                component="a"
                                href={
                                  session.sessionType === "predefined-work-plan" && session.workPlan?.title
                                    ? `${CUSTOMER_FRONTEND_URL}/plan/${encodeURIComponent(session.workPlan.title)}/${session.sessionId}?conversable=${session.interactiveShareMetadata.token}`
                                    : `${CUSTOMER_FRONTEND_URL}/ishare/${session.sessionId}?conversable=${session.interactiveShareMetadata.token}`
                                }
                                target="_blank"
                                rel="noopener noreferrer"
                                sx={{ textAlign: 'center' }}
                              >
                                Shared Chat
                              </Button>
                            )}
                          </Box>
                        </TableCell>
                      </TableRow>
                    ))}
                    {chatSessionsLoading && (
                      <TableRow>
                        <TableCell colSpan={9} align="center">
                          <CircularProgress size={24} />
                        </TableCell>
                      </TableRow>
                    )}
                  </>
                )}
              </TableBody>
            </Table>
          </TableContainer>
          <Box ref={chatSessionsLoadMoreRef} sx={{ height: 1 }} />
        </TabPanel>

        <TabPanel value={tabValue} index={7}>
          {error && (
            <Alert severity="error" sx={{ mb: 3 }}>
              {error}
            </Alert>
          )}
          <Grid container spacing={3}>
            <Grid item xs={12}>
              <Card>
                <CardContent>
                  <Typography variant="h6" gutterBottom>
                    Knowledge Base Overview
                  </Typography>
                  <Typography variant="body2" color="text.secondary" paragraph>
                    The knowledge base is the collection of all knowledge bases
                    from all the tasks on the AgentWeb platform. It is indexed
                    daily with Google Vertex AI Search and thus updates to the
                    knowledge base will be available for use next day.
                  </Typography>
                  <TableContainer component={Paper}>
                    <Table>
                      <TableHead>
                        <TableRow>
                          <TableCell>Category</TableCell>
                          <TableCell>Tasks with Knowledge Base</TableCell>
                          <TableCell>Total Size</TableCell>
                          <TableCell>Average Size</TableCell>
                          <TableCell>Uploaded Files</TableCell>
                          <TableCell>Uploaded Size</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {knowledgeBaseMetrics ? (
                          <>
                            <TableRow>
                              <TableCell>Overall</TableCell>
                              <TableCell>
                                {knowledgeBaseMetrics.tasksWithKnowledgeBase}
                              </TableCell>
                              <TableCell>
                                {(
                                  knowledgeBaseMetrics.totalKnowledgeBaseSize /
                                  1024
                                ).toFixed(2)}{" "}
                                KB
                              </TableCell>
                              <TableCell>
                                {(
                                  knowledgeBaseMetrics.averageKnowledgeBaseSize /
                                  1024
                                ).toFixed(2)}{" "}
                                KB
                              </TableCell>
                              <TableCell>
                                {knowledgeBaseMetrics.uploadedFiles.totalFiles} files (
                                {knowledgeBaseMetrics.uploadedFiles.tasksWithUploadedFiles} tasks)
                              </TableCell>
                              <TableCell>
                                {(knowledgeBaseMetrics.uploadedFiles.totalSize / 1024).toFixed(2)} KB
                              </TableCell>
                            </TableRow>
                            <TableRow>
                              <TableCell>Public</TableCell>
                              <TableCell>
                                {
                                  knowledgeBaseMetrics.public
                                    .tasksWithKnowledgeBase
                                }
                              </TableCell>
                              <TableCell>
                                {(
                                  knowledgeBaseMetrics.public.totalSize / 1024
                                ).toFixed(2)}{" "}
                                KB
                              </TableCell>
                              <TableCell>
                                {(
                                  knowledgeBaseMetrics.public.averageSize / 1024
                                ).toFixed(2)}{" "}
                                KB
                              </TableCell>
                              <TableCell>
                                {knowledgeBaseMetrics.public.uploadedFiles.totalFiles} files (
                                {knowledgeBaseMetrics.public.uploadedFiles.tasksWithUploadedFiles} tasks)
                              </TableCell>
                              <TableCell>
                                {(knowledgeBaseMetrics.public.uploadedFiles.totalSize / 1024).toFixed(2)} KB
                              </TableCell>
                            </TableRow>
                            <TableRow>
                              <TableCell>Private</TableCell>
                              <TableCell>
                                {
                                  knowledgeBaseMetrics.private
                                    .tasksWithKnowledgeBase
                                }
                              </TableCell>
                              <TableCell>
                                {(
                                  knowledgeBaseMetrics.private.totalSize / 1024
                                ).toFixed(2)}{" "}
                                KB
                              </TableCell>
                              <TableCell>
                                {(
                                  knowledgeBaseMetrics.private.averageSize /
                                  1024
                                ).toFixed(2)}{" "}
                                KB
                              </TableCell>
                              <TableCell>
                                {knowledgeBaseMetrics.private.uploadedFiles.totalFiles} files (
                                {knowledgeBaseMetrics.private.uploadedFiles.tasksWithUploadedFiles} tasks)
                              </TableCell>
                              <TableCell>
                                {(knowledgeBaseMetrics.private.uploadedFiles.totalSize / 1024).toFixed(2)} KB
                              </TableCell>
                            </TableRow>
                          </>
                        ) : (
                          <TableRow>
                            <TableCell colSpan={7} align="center">
                              <Typography
                                variant="body2"
                                color="text.secondary"
                              >
                                Loading metrics...
                              </Typography>
                            </TableCell>
                          </TableRow>
                        )}
                      </TableBody>
                    </Table>
                  </TableContainer>
                </CardContent>
              </Card>
            </Grid>

            <Grid item xs={12}>
              <Card>
                <CardContent>
                  <Typography variant="h6" gutterBottom>
                    Tasks with Knowledge Base
                  </Typography>
                  <TableContainer component={Paper}>
                    <Table>
                      <TableHead>
                        <TableRow>
                          <TableCell>Task ID</TableCell>
                          <TableCell>Name</TableCell>
                          <TableCell>Owner</TableCell>
                          <TableCell>Type</TableCell>
                          <TableCell>Knowledge Base Size</TableCell>
                          <TableCell>Uploaded Files</TableCell>
                          <TableCell>Uploaded Size</TableCell>
                          <TableCell>Actions</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {knowledgeBaseMetrics?.tasks ? (
                          knowledgeBaseMetrics.tasks.map((task) => (
                            <TableRow key={task.taskId}>
                              <TableCell>{task.taskId}</TableCell>
                              <TableCell>{task.name}</TableCell>
                              <TableCell>{task.owner}</TableCell>
                              <TableCell>
                                {task.type === "public" ? (
                                  <Chip
                                    size="small"
                                    label="Public"
                                    color="primary"
                                  />
                                ) : (
                                  <Chip
                                    size="small"
                                    label="Private"
                                    color="default"
                                  />
                                )}
                              </TableCell>
                              <TableCell>
                                {(task.knowledgeBaseSize / 1024).toFixed(2)} KB
                              </TableCell>
                              <TableCell>
                                {task.uploadedFilesCount ?? 0}
                              </TableCell>
                              <TableCell>
                                {((task.uploadedFilesSize || 0) / 1024).toFixed(2)} KB
                              </TableCell>
                              <TableCell>
                                <Button
                                  size="small"
                                  component={RouterLink}
                                  to={`/tasks/${task.taskId}`}
                                  target="_blank"
                                >
                                  View Details
                                </Button>
                              </TableCell>
                            </TableRow>
                          ))
                        ) : (
                          <TableRow>
                            <TableCell colSpan={8} align="center">
                              <Typography
                                variant="body2"
                                color="text.secondary"
                              >
                                {knowledgeBaseMetrics === null
                                  ? "Loading tasks..."
                                  : "No knowledge bases found"}
                              </Typography>
                            </TableCell>
                          </TableRow>
                        )}
                      </TableBody>
                    </Table>
                  </TableContainer>
                </CardContent>
              </Card>
            </Grid>
          </Grid>
        </TabPanel>

        <TabPanel value={tabValue} index={8}>
          <AgentModeSettings />
        </TabPanel>

        <TabPanel value={tabValue} index={9}>
          <ImageModelsSettings />
        </TabPanel>

        <TabPanel value={tabValue} index={10}>
          <DefaultPromptsSettings />
        </TabPanel>

        <TabPanel value={tabValue} index={11}>
          <BenchmarksTab />
        </TabPanel>

        <TabPanel value={tabValue} index={12}>
          <SubscriptionTypesTab />
        </TabPanel>

        <TabPanel value={tabValue} index={13}>
          <McpServersTab />
        </TabPanel>
      </Paper>

      {/* Deactivation Confirmation Dialog */}
      <Dialog
        open={deactivateDialogOpen}
        onClose={() => setDeactivateDialogOpen(false)}
      >
        <DialogTitle>Confirm User Deactivation</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Are you sure you want to deactivate the account for{" "}
            {selectedUser?.email}? This action will prevent the user from
            accessing their account.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => setDeactivateDialogOpen(false)}
            disabled={loading}
          >
            Cancel
          </Button>
          <Button
            onClick={handleDeactivateUser}
            color="error"
            variant="contained"
            disabled={loading}
          >
            {loading ? <CircularProgress size={24} /> : "Deactivate"}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Chat Dialog */}
      <ChatDialog
        session={selectedSession}
        open={chatDialogOpen}
        onClose={() => setChatDialogOpen(false)}
      />

      {/* Add Role Dialog */}
      <Dialog open={roleDialogOpen} onClose={handleRoleDialogClose}>
        <DialogTitle>Update User Roles</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Select roles for user: {selectedUser?.email}
          </Typography>
          <FormControlLabel
            control={
              <Checkbox
                checked={selectedUserRoles.includes("partner")}
                onChange={() => handleRoleCheckboxChange("partner")}
                name="partnerRole"
              />
            }
            label="Partner Portal Access"
          />
          <FormControlLabel
            control={
              <Checkbox
                checked={selectedUserRoles.includes("customer")}
                onChange={() => handleRoleCheckboxChange("customer")}
                name="customerRole"
              />
            }
            label="Customer Portal Access"
          />
          <FormControlLabel
            control={
              <Checkbox
                checked={selectedUserRoles.includes("free")}
                onChange={() => handleRoleCheckboxChange("free")}
                name="freeRole"
              />
            }
            label="Free Access"
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={handleRoleDialogClose}>Cancel</Button>
          <Button
            onClick={handleUpdateRole}
            variant="contained"
            color="primary"
            disabled={loading}
          >
            {loading ? <CircularProgress size={24} /> : "Update Roles"}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Support Note Edit Dialog */}
      <Dialog
        open={Boolean(editingNoteEmail)}
        onClose={handleCancelEditNote}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>
          Edit Support Note for {editingNoteEmail}
          <IconButton
            aria-label="close"
            onClick={handleCancelEditNote}
            sx={{ position: "absolute", right: 8, top: 8 }}
            disabled={noteEditLoading}
          >
            <CloseIcon />
          </IconButton>
        </DialogTitle>
        <DialogContent dividers>
          <TextField
            autoFocus
            margin="dense"
            label="Support Note"
            type="text"
            fullWidth
            multiline
            rows={4}
            value={currentNoteText}
            onChange={(e) => setCurrentNoteText(e.target.value)}
            disabled={noteEditLoading}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={handleCancelEditNote} disabled={noteEditLoading}>
            Cancel
          </Button>
          <Button
            onClick={handleSaveNote}
            variant="contained"
            disabled={noteEditLoading}
          >
            {noteEditLoading ? <CircularProgress size={24} /> : "Save"}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog
        open={deleteConfirmOpen}
        onClose={handleCloseDeleteConfirm}
        aria-labelledby="alert-dialog-title"
        aria-describedby="alert-dialog-description"
      >
        <DialogTitle id="alert-dialog-title">{"Confirm Deletion"}</DialogTitle>
        <DialogContent>
          <DialogContentText id="alert-dialog-description">
            Are you sure you want to delete the waitlist entry for{" "}
            {emailToDelete}? This action cannot be undone.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleCloseDeleteConfirm}>Cancel</Button>
          <Button onClick={handleDeleteConfirmed} color="error" autoFocus>
            Delete
          </Button>
        </DialogActions>
      </Dialog>

      {/* User Delete Confirmation Dialog */}
      <Dialog
        open={userDeleteConfirmOpen}
        onClose={handleCloseUserDeleteConfirm}
        aria-labelledby="user-delete-dialog-title"
        aria-describedby="user-delete-dialog-description"
      >
        <DialogTitle id="user-delete-dialog-title">
          {"Confirm User Deletion"}
        </DialogTitle>
        <DialogContent>
          <DialogContentText id="user-delete-dialog-description">
            Are you sure you want to permanently delete this user (
            {userIdToDelete})? This action cannot be undone and will remove all
            associated data.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleCloseUserDeleteConfirm}>Cancel</Button>
          <Button onClick={handleUserDeleteConfirmed} color="error" autoFocus>
            Delete User
          </Button>
        </DialogActions>
      </Dialog>

      {/* Manual Invite Dialog */}
      <Dialog
        open={manualInviteOpen}
        onClose={handleManualInviteClose}
        maxWidth="md"
        fullWidth
      >
        <DialogTitle>
          Manually Add to Waitlist
          <IconButton
            aria-label="close"
            onClick={handleManualInviteClose}
            sx={{ position: "absolute", right: 8, top: 8 }}
          >
            <CloseIcon />
          </IconButton>
        </DialogTitle>
        <DialogContent dividers>
          <Grid container spacing={2}>
            <Grid item xs={12} sm={6}>
              <TextField
                fullWidth
                label="Email *"
                type="email"
                value={manualInviteForm.email}
                onChange={(e) =>
                  setManualInviteForm({
                    ...manualInviteForm,
                    email: e.target.value,
                  })
                }
                required
              />
            </Grid>
            <Grid item xs={12} sm={6}>
              <TextField
                fullWidth
                label="Full Name"
                value={manualInviteForm.fullName}
                onChange={(e) =>
                  setManualInviteForm({
                    ...manualInviteForm,
                    fullName: e.target.value,
                  })
                }
              />
            </Grid>
            <Grid item xs={12} sm={6}>
              <TextField
                fullWidth
                label="Phone Number"
                value={manualInviteForm.phoneNumber}
                onChange={(e) =>
                  setManualInviteForm({
                    ...manualInviteForm,
                    phoneNumber: e.target.value,
                  })
                }
              />
            </Grid>
            <Grid item xs={12} sm={6}>
              <TextField
                fullWidth
                label="Company Name"
                value={manualInviteForm.companyName}
                onChange={(e) =>
                  setManualInviteForm({
                    ...manualInviteForm,
                    companyName: e.target.value,
                  })
                }
              />
            </Grid>
            <Grid item xs={12} sm={6}>
              <FormControl fullWidth>
                <InputLabel>Use Case Categories</InputLabel>
                <Select
                  multiple
                  value={manualInviteForm.useCaseCategories}
                  onChange={(e) =>
                    setManualInviteForm({
                      ...manualInviteForm,
                      useCaseCategories:
                        typeof e.target.value === "string"
                          ? [e.target.value]
                          : e.target.value,
                    })
                  }
                  renderValue={(selected) => (
                    <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5 }}>
                      {selected.map((value) => (
                        <Chip key={value} label={value} size="small" />
                      ))}
                    </Box>
                  )}
                >
                  {useCaseOptions.map((option) => (
                    <MenuItem key={option} value={option}>
                      {option}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            </Grid>
            <Grid item xs={12} sm={6}>
              <FormControl fullWidth>
                <InputLabel>Marketing Channels</InputLabel>
                <Select
                  multiple
                  value={manualInviteForm.marketingChannels}
                  onChange={(e) => {
                    setManualInviteForm({
                      ...manualInviteForm,
                      marketingChannels:
                        typeof e.target.value === "string"
                          ? [e.target.value]
                          : e.target.value,
                    });
                  }}
                  renderValue={(selected) => (
                    <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5 }}>
                      {selected.map((value) => (
                        <Chip key={value} label={value} size="small" />
                      ))}
                    </Box>
                  )}
                >
                  {marketingChannelOptions.map((option) => (
                    <MenuItem key={option} value={option}>
                      {option}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            </Grid>
            <Grid item xs={12} sm={6}>
              <TextField
                fullWidth
                label="Monthly Marketing Spend"
                value={manualInviteForm.monthlyMarketingSpend}
                onChange={(e) =>
                  setManualInviteForm({
                    ...manualInviteForm,
                    monthlyMarketingSpend: e.target.value,
                  })
                }
              />
            </Grid>
            <Grid item xs={12} sm={6}>
              <TextField
                fullWidth
                label="Stripe Customer ID"
                value={manualInviteForm.stripe_customer_id}
                onChange={(e) =>
                  setManualInviteForm({
                    ...manualInviteForm,
                    stripe_customer_id: e.target.value,
                  })
                }
                placeholder="cus_..."
              />
            </Grid>
            <Grid item xs={12}>
              <TextField
                fullWidth
                label="Business Area"
                value={manualInviteForm.businessArea}
                onChange={(e) =>
                  setManualInviteForm({
                    ...manualInviteForm,
                    businessArea: e.target.value,
                  })
                }
              />
            </Grid>
            <Grid item xs={12}>
              <TextField
                fullWidth
                label="Use Case Description"
                multiline
                rows={3}
                value={manualInviteForm.useCaseDescription}
                onChange={(e) =>
                  setManualInviteForm({
                    ...manualInviteForm,
                    useCaseDescription: e.target.value,
                  })
                }
              />
            </Grid>
            <Grid item xs={12}>
              <TextField
                fullWidth
                label="Support Note"
                multiline
                rows={2}
                value={manualInviteForm.supportNote}
                onChange={(e) =>
                  setManualInviteForm({
                    ...manualInviteForm,
                    supportNote: e.target.value,
                  })
                }
                placeholder="Internal notes about this entry..."
              />
            </Grid>
            <Grid item xs={12}>
              <FormGroup>
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={manualInviteForm.requestReport}
                      onChange={(e) =>
                        setManualInviteForm({
                          ...manualInviteForm,
                          requestReport: e.target.checked,
                        })
                      }
                    />
                  }
                  label="Request Report"
                />
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={manualInviteForm.sendInvitation}
                      onChange={(e) =>
                        setManualInviteForm({
                          ...manualInviteForm,
                          sendInvitation: e.target.checked,
                        })
                      }
                    />
                  }
                  label="Send Invitation Email Immediately"
                />
              </FormGroup>
            </Grid>
          </Grid>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleManualInviteClose}>Cancel</Button>
          <Button
            onClick={handleManualInviteSubmit}
            variant="contained"
            disabled={!manualInviteForm.email || manualInviteLoading}
          >
            {manualInviteLoading ? (
              <CircularProgress size={24} />
            ) : (
              "Add to Waitlist"
            )}
          </Button>
        </DialogActions>
      </Dialog>

      {success && (
        <Alert severity="success" onClose={() => setSuccess("")} sx={{ mt: 2 }}>
          {success}
        </Alert>
      )}

      {/* User Tasks Dialog */}
      <Dialog
        open={userTasksDialogOpen}
        onClose={() => setUserTasksDialogOpen(false)}
        maxWidth="md"
        fullWidth
      >
        <DialogTitle>User Tasks{userTasksDialogUserEmail ? ` for ${userTasksDialogUserEmail}` : ""}</DialogTitle>
        <DialogContent dividers>
          {(() => {
            const filteredTasks = tasks.filter((task) => task.userId === userTasksDialogUserId);
            if (adminLoading) {
              return (
                <Box display="flex" justifyContent="center" alignItems="center" minHeight={60}>
                  <CircularProgress size={24} />
                </Box>
              );
            } else if (filteredTasks.length === 0) {
              return (
                <Typography variant="body2" color="text.secondary">
                  No tasks found for this user.
                </Typography>
              );
            } else {
              return (
                <TableContainer component={Paper}>
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell>Task ID</TableCell>
                        <TableCell>Name</TableCell>
                        <TableCell>Prompt</TableCell>
                        <TableCell>Details</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {filteredTasks.map((task: AdminTask) => (
                        <TableRow key={task.taskId}>
                          <TableCell>{task.taskId}</TableCell>
                          <TableCell>{task.name}</TableCell>
                          <TableCell>
                            {task.prompt && task.prompt.length > 80
                              ? `${task.prompt.substring(0, 80)}...`
                              : task.prompt}
                          </TableCell>
                          <TableCell>
                            <Button
                              size="small"
                              component="a"
                              href={`/tasks/${task.taskId}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              sx={{ textTransform: "none" }}
                            >
                              View Details
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableContainer>
              );
            }
          })()}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setUserTasksDialogOpen(false)} color="primary" variant="contained">
            Close
          </Button>
        </DialogActions>
      </Dialog>

      {/* Email Sender Configuration Dialog */}
      <Dialog
        open={emailSenderDialogOpen}
        onClose={() => {
          setEmailSenderDialogOpen(false);
          setEditingEmailSenderUserId(null);
          setEmailDomain("");
          setDefaultSenderUsername("");
          setFromName("");
        }}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>
          Configure Email Sender
          <IconButton
            aria-label="close"
            onClick={() => {
              setEmailSenderDialogOpen(false);
              setEditingEmailSenderUserId(null);
              setEmailDomain("");
              setDefaultSenderUsername("");
              setFromName("");
            }}
            sx={{
              position: 'absolute',
              right: 8,
              top: 8,
            }}
          >
            <CloseIcon />
          </IconButton>
        </DialogTitle>
        <DialogContent dividers>
          <Grid container spacing={2}>
            <Grid item xs={12}>
              <TextField
                autoFocus
                fullWidth
                label="Email Domain"
                value={emailDomain}
                onChange={(e) => setEmailDomain(e.target.value)}
                placeholder="example.com"
                helperText="The domain for sending emails (e.g., example.com)"
                disabled={emailSenderEditLoading}
              />
            </Grid>
            <Grid item xs={12}>
              <TextField
                fullWidth
                label="Default Sender Username"
                value={defaultSenderUsername}
                onChange={(e) => setDefaultSenderUsername(e.target.value)}
                placeholder="noreply"
                helperText="The username part of the sender email (e.g., noreply)"
                disabled={emailSenderEditLoading}
              />
            </Grid>
            <Grid item xs={12}>
              <TextField
                fullWidth
                label="From Name"
                value={fromName}
                onChange={(e) => setFromName(e.target.value)}
                placeholder="Your Company Name"
                helperText="The display name for the sender (e.g., Your Company Name)"
                disabled={emailSenderEditLoading}
              />
            </Grid>
          </Grid>
        </DialogContent>
        <DialogActions>
          <Button 
            onClick={() => {
              setEmailSenderDialogOpen(false);
              setEditingEmailSenderUserId(null);
              setEmailDomain("");
              setDefaultSenderUsername("");
              setFromName("");
            }}
            disabled={emailSenderEditLoading}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSaveEmailSender}
            color="primary"
            variant="contained"
            disabled={emailSenderEditLoading}
          >
            {emailSenderEditLoading ? "Saving..." : "Save"}
          </Button>
        </DialogActions>
      </Dialog>

      {/* SEO/AEO Configuration Dialog */}
      <Dialog
        open={seoDomainsDialogOpen}
        onClose={() => {
          setSeoDomainsDialogOpen(false);
          setEditingSeoDomainsUserId(null);
          setSeoDomainsText("");
          setGoogleAnalyticsPropertyId("");
          setGaFilteredDomainsText("");
          setClarityProjectId("");
          setProductDomain("");
        }}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>
          Configure SEO/AEO
          <IconButton
            aria-label="close"
            onClick={() => {
              setSeoDomainsDialogOpen(false);
              setEditingSeoDomainsUserId(null);
              setSeoDomainsText("");
              setGoogleAnalyticsPropertyId("");
              setGaFilteredDomainsText("");
              setClarityProjectId("");
              setProductDomain("");
            }}
            sx={{
              position: 'absolute',
              right: 8,
              top: 8,
            }}
          >
            <CloseIcon />
          </IconButton>
        </DialogTitle>
        <DialogContent dividers>
          <Grid container spacing={2}>
            <Grid item xs={12}>
              <TextField
                autoFocus
                fullWidth
                multiline
                rows={6}
                label="SEO Domains"
                value={seoDomainsText}
                onChange={(e) => setSeoDomainsText(e.target.value)}
                placeholder="example.com&#10;subdomain.example.com&#10;another-domain.com"
                helperText="Enter one domain per line. These domains will be tracked for SEO metrics in the customer portal. Format: example.com (without http:// or https://)"
                disabled={seoDomainsEditLoading}
              />
            </Grid>
            <Grid item xs={12}>
              <TextField
                fullWidth
                label="Google Analytics Property ID"
                value={googleAnalyticsPropertyId}
                onChange={(e) => setGoogleAnalyticsPropertyId(e.target.value)}
                placeholder="123456789"
                helperText="Enter your Google Analytics 4 Property ID (numeric, e.g., 123456789). You can find this in GA4 Admin > Property Settings. This will enable Google Analytics metrics on the SEO/AEO page."
                disabled={seoDomainsEditLoading}
              />
            </Grid>
            <Grid item xs={12}>
              <TextField
                fullWidth
                multiline
                rows={3}
                label="Filtered Domains (GA)"
                value={gaFilteredDomainsText}
                onChange={(e) => setGaFilteredDomainsText(e.target.value)}
                placeholder="app.example.com&#10;admin.example.com"
                helperText="Enter domains to exclude from Google Analytics (one per line). This helps filter out internal traffic from subdomains when viewing landing site analytics. Example: Exclude app.agentweb.pro when analyzing agentweb.pro."
                disabled={seoDomainsEditLoading}
              />
            </Grid>
            <Grid item xs={12}>
              <TextField
                fullWidth
                label="Microsoft Clarity Project ID"
                value={clarityProjectId}
                onChange={(e) => setClarityProjectId(e.target.value)}
                placeholder="ul13e4f7fe"
                helperText="Enter your Microsoft Clarity Project ID (e.g., ul13e4f7fe). You can find this in Clarity project settings."
                disabled={seoDomainsEditLoading}
              />
            </Grid>
            <Grid item xs={12}>
              <TextField
                fullWidth
                label="Product Domain"
                value={productDomain}
                onChange={(e) => setProductDomain(e.target.value)}
                placeholder="app.example.com"
                helperText="Enter your product site domain for feature usage tracking (e.g., app.example.com). This will enable Product Analytics on the Performance Hub page."
                disabled={seoDomainsEditLoading}
              />
            </Grid>
          </Grid>
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => {
              setSeoDomainsDialogOpen(false);
              setEditingSeoDomainsUserId(null);
              setSeoDomainsText("");
              setGoogleAnalyticsPropertyId("");
              setGaFilteredDomainsText("");
              setClarityProjectId("");
              setProductDomain("");
            }}
            disabled={seoDomainsEditLoading}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSaveSeoDomains}
            color="primary"
            variant="contained"
            disabled={seoDomainsEditLoading}
          >
            {seoDomainsEditLoading ? "Saving..." : "Save"}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Slack Channel Configuration Dialog */}
      <Dialog
        open={slackChannelDialogOpen}
        onClose={() => {
          setSlackChannelDialogOpen(false);
          setEditingSlackChannelUserId(null);
          setCurrentSlackChannelText("");
        }}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>
          Configure Slack Channel
          <IconButton
            aria-label="close"
            onClick={() => {
              setSlackChannelDialogOpen(false);
              setEditingSlackChannelUserId(null);
              setCurrentSlackChannelText("");
            }}
            sx={{
              position: 'absolute',
              right: 8,
              top: 8,
            }}
          >
            <CloseIcon />
          </IconButton>
        </DialogTitle>
        <DialogContent dividers>
          <TextField
            autoFocus
            fullWidth
            label="Slack Channel ID"
            value={currentSlackChannelText}
            onChange={(e) => setCurrentSlackChannelText(e.target.value)}
            placeholder="C1234567890"
            helperText="Enter the Slack channel ID where this user's approval requests should be sent. Leave empty to disable account-level Slack channel restriction."
            disabled={slackChannelEditLoading}
          />
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => {
              setSlackChannelDialogOpen(false);
              setEditingSlackChannelUserId(null);
              setCurrentSlackChannelText("");
            }}
            disabled={slackChannelEditLoading}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSaveSlackChannel}
            color="primary"
            variant="contained"
            disabled={slackChannelEditLoading}
          >
            {slackChannelEditLoading ? "Saving..." : "Save"}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Password Reset Dialog */}
      <Dialog open={passwordDialogOpen} onClose={() => setPasswordDialogOpen(false)}>
        <DialogTitle>Set Password for {passwordUserEmail}</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Enter a new password for this user. The user will need to use this password to log in.
          </Typography>
          <TextField
            autoFocus
            fullWidth
            type="password"
            label="New Password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            placeholder="Enter new password"
            disabled={passwordResetLoading}
            helperText="Minimum 6 characters"
          />
        </DialogContent>
        <DialogActions>
          <Button 
            onClick={() => setPasswordDialogOpen(false)}
            disabled={passwordResetLoading}
          >
            Cancel
          </Button>
          <Button
            onClick={handlePasswordReset}
            color="primary"
            variant="contained"
            disabled={passwordResetLoading || !newPassword.trim()}
          >
            {passwordResetLoading ? <CircularProgress size={24} /> : "Set Password"}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Create User Confirmation Dialog */}
      <Dialog
        open={createUserDialogOpen}
        onClose={() => setCreateUserDialogOpen(false)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>Create User Account</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ mb: 2 }}>
            Are you sure you want to create a user account for <strong>{userToCreate}</strong>?
            This will create an account with a random password and send a welcome email.
          </DialogContentText>
          
          <FormControl fullWidth sx={{ mt: 2 }}>
            <InputLabel id="user-roles-label">User Roles</InputLabel>
            <Select
              labelId="user-roles-label"
              multiple
              value={createUserRoles}
              onChange={(e) => setCreateUserRoles(e.target.value as string[])}
              renderValue={(selected) => (selected as string[]).join(', ')}
              label="User Roles"
            >
              <MenuItem value="customer">Customer</MenuItem>
              <MenuItem value="partner">Partner</MenuItem>
              <MenuItem value="free">Free</MenuItem>
            </Select>
          </FormControl>
        </DialogContent>
        <DialogActions>
          <Button 
            onClick={() => setCreateUserDialogOpen(false)}
            disabled={createUserLoading}
          >
            Cancel
          </Button>
          <Button
            onClick={handleCreateUser}
            variant="contained"
            disabled={createUserLoading}
            startIcon={createUserLoading ? <CircularProgress size={20} /> : <AddIcon />}
          >
            {createUserLoading ? 'Creating...' : 'Create User'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Edit Waitlist Entry Dialog */}
      <Dialog
        open={editWaitlistDialogOpen}
        onClose={handleEditWaitlistClose}
        maxWidth="md"
        fullWidth
      >
        <DialogTitle>Edit Waitlist Entry</DialogTitle>
        <DialogContent>
          {editWaitlistData && (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, mt: 1 }}>
              <TextField
                fullWidth
                label="Email"
                value={editWaitlistData.email || ''}
                disabled
                helperText="Email cannot be changed (primary key)"
              />
              <TextField
                fullWidth
                label="Full Name"
                value={editWaitlistData.fullName || ''}
                onChange={(e) => setEditWaitlistData({ ...editWaitlistData, fullName: e.target.value })}
                disabled={editWaitlistLoading}
              />
              <TextField
                fullWidth
                label="Company Name"
                value={editWaitlistData.companyName || ''}
                onChange={(e) => setEditWaitlistData({ ...editWaitlistData, companyName: e.target.value })}
                disabled={editWaitlistLoading}
              />
              <TextField
                fullWidth
                label="Phone Number"
                value={editWaitlistData.phoneNumber || ''}
                onChange={(e) => setEditWaitlistData({ ...editWaitlistData, phoneNumber: e.target.value })}
                disabled={editWaitlistLoading}
              />
              <TextField
                fullWidth
                label="Stripe Customer ID"
                value={editWaitlistData.stripe_customer_id || ''}
                onChange={(e) => setEditWaitlistData({ ...editWaitlistData, stripe_customer_id: e.target.value })}
                disabled={editWaitlistLoading}
              />
              <TextField
                fullWidth
                label="Monthly Marketing Spend"
                value={editWaitlistData.monthlyMarketingSpend || ''}
                onChange={(e) => setEditWaitlistData({ ...editWaitlistData, monthlyMarketingSpend: e.target.value })}
                disabled={editWaitlistLoading}
              />
              <TextField
                fullWidth
                label="Business Area"
                value={editWaitlistData.businessArea || ''}
                onChange={(e) => setEditWaitlistData({ ...editWaitlistData, businessArea: e.target.value })}
                disabled={editWaitlistLoading}
              />
              <FormControl fullWidth>
                <InputLabel>Marketing Channels</InputLabel>
                <Select
                  multiple
                  value={editWaitlistData.marketingChannels || []}
                  onChange={(e) => setEditWaitlistData({ ...editWaitlistData, marketingChannels: e.target.value as string[] })}
                  renderValue={(selected) => (selected as string[]).join(', ')}
                  label="Marketing Channels"
                  disabled={editWaitlistLoading}
                >
                  {marketingChannelOptions.map((channel) => (
                    <MenuItem key={channel} value={channel}>{channel}</MenuItem>
                  ))}
                </Select>
              </FormControl>
              <FormControl fullWidth>
                <InputLabel>Use Case Categories</InputLabel>
                <Select
                  multiple
                  value={editWaitlistData.useCaseCategories || []}
                  onChange={(e) => setEditWaitlistData({ ...editWaitlistData, useCaseCategories: e.target.value as string[] })}
                  renderValue={(selected) => (selected as string[]).join(', ')}
                  label="Use Case Categories"
                  disabled={editWaitlistLoading}
                >
                  {useCaseOptions.map((category) => (
                    <MenuItem key={category} value={category}>{category}</MenuItem>
                  ))}
                </Select>
              </FormControl>
              <TextField
                fullWidth
                label="Use Case Description"
                value={editWaitlistData.useCaseDescription || ''}
                onChange={(e) => setEditWaitlistData({ ...editWaitlistData, useCaseDescription: e.target.value })}
                multiline
                rows={3}
                disabled={editWaitlistLoading}
              />
              <FormControlLabel
                control={
                  <Checkbox
                    checked={editWaitlistData.requestReport || false}
                    onChange={(e) => setEditWaitlistData({ ...editWaitlistData, requestReport: e.target.checked })}
                    disabled={editWaitlistLoading}
                  />
                }
                label="Request Report"
              />
              <TextField
                fullWidth
                label="Support Note"
                value={editWaitlistData.supportNote || ''}
                onChange={(e) => setEditWaitlistData({ ...editWaitlistData, supportNote: e.target.value })}
                multiline
                rows={3}
                disabled={editWaitlistLoading}
              />
            </Box>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={handleEditWaitlistClose} disabled={editWaitlistLoading}>
            Cancel
          </Button>
          <Button
            onClick={handleEditWaitlistSave}
            variant="contained"
            disabled={editWaitlistLoading}
          >
            {editWaitlistLoading ? <CircularProgress size={24} /> : 'Save'}
          </Button>
        </DialogActions>
      </Dialog>
    </Container>
  );
}

// Agent Mode Settings Component
interface WorkPlanStep {
  stepCount: number;
  title: string;
  description?: string;
  requiredFunctionCalls?: string[];
}

interface PredefinedWorkPlan {
  id?: string;
  title: string;
  description?: string;
  steps: WorkPlanStep[];
  welcomeMessage?: string;
  autocomplete?: boolean;
  requireLogin?: boolean;
  showLoginSignup?: 'after_plan_completed' | 'always';
  showInAgentMode?: boolean;
  defaultModel?: string;
}

interface AvailableFunctionCall {
  name: string;
  description: string;
}

const AgentModeSettings = () => {
  const [systemPrompt, setSystemPrompt] = useState('');
  const [welcomeMessage, setWelcomeMessage] = useState('');
  const [, setConversationStarters] = useState<string[]>([]);
  const [conversationStartersText, setConversationStartersText] = useState('');
  const [predefinedWorkPlans, setPredefinedWorkPlans] = useState<PredefinedWorkPlan[]>([]);
  const [availableFunctionCalls, setAvailableFunctionCalls] = useState<AvailableFunctionCall[]>([]);
  const [selectedFunctionCall, setSelectedFunctionCall] = useState<Record<string, string>>({});
  const [defaultModel, setDefaultModel] = useState('gpt-5-chat-2');
  const [supportedModels, setSupportedModels] = useState<string[]>([]);
  const [contentModel, setContentModel] = useState('');
  const [reportsModel, setReportsModel] = useState('');
  const [loading, setLoading] = useState(true);
  const [savingDefaultModel, setSavingDefaultModel] = useState(false);
  const [savingSystemPrompt, setSavingSystemPrompt] = useState(false);
  const [savingWelcomeMessage, setSavingWelcomeMessage] = useState(false);
  const [savingConversationStarters, setSavingConversationStarters] = useState(false);
  const [savingWorkPlanId, setSavingWorkPlanId] = useState<string | null>(null);
  const [savingWorkPlanIndex, setSavingWorkPlanIndex] = useState<number | null>(null);
  const [savingContentModel, setSavingContentModel] = useState(false);
  const [savingReportsModel, setSavingReportsModel] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [workPlanErrors, setWorkPlanErrors] = useState<Record<string, string>>({});
  const [newlyAddedPlanId, setNewlyAddedPlanId] = useState<string | null>(null);
  const { token } = useAuth();
  const fallbackDefaultModel = 'gpt-5-chat-2';

  useEffect(() => {
    loadAllSettings();
  }, []);

  // Scroll to newly added work plan
  useEffect(() => {
    if (newlyAddedPlanId) {
      // Use setTimeout to ensure DOM is updated
      setTimeout(() => {
        const element = document.getElementById(`work-plan-${newlyAddedPlanId}`);
        if (element) {
          element.scrollIntoView({ behavior: 'smooth', block: 'start' });
          // Focus on the title field for better UX
          const titleInput = element.querySelector('input[type="text"]') as HTMLInputElement;
          if (titleInput) {
            titleInput.focus();
          }
        }
        // Clear the newly added plan ID after scrolling
        setNewlyAddedPlanId(null);
      }, 100);
    }
  }, [newlyAddedPlanId, predefinedWorkPlans]);

  const loadAllSettings = async () => {
    try {
      setLoading(true);
      setError('');

      const models = await loadSupportedModels();
      await loadDefaultModel(models);

      // Load system prompt
      await loadSystemPrompt();

      // Load welcome message
      await loadWelcomeMessage();

      // Load conversation starters
      await loadConversationStarters();

      // Load available function calls
      await loadAvailableFunctionCalls();

      // Load predefined work plans
      await loadPredefinedWorkPlans();

      // Load content model
      await loadContentModel();

      // Load reports model (pass models array for validation)
      await loadReportsModel(models);
    } catch (error) {
      console.error('Error loading settings:', error);
      setError('Failed to load settings');
    } finally {
      setLoading(false);
    }
  };

  const loadSupportedModels = async (): Promise<string[]> => {
    try {
      const response = await axios.get(buildApiUrl('/api/agent-mode/public/llm-models'), {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (Array.isArray(response.data) && response.data.length > 0) {
        setSupportedModels(response.data);
        return response.data;
      }
    } catch (error) {
      console.error('Error loading supported models:', error);
    }
    const fallbackModels = [fallbackDefaultModel, 'gemini-3-pro-preview'];
    setSupportedModels(fallbackModels);
    return fallbackModels;
  };

  const loadDefaultModel = async (models: string[] = []) => {
    const availableModels = models.length > 0 ? models : [fallbackDefaultModel, 'gemini-3-pro-preview'];
    try {
      try {
        const response = await axios.get(buildApiUrl('/api/settings/agent_mode_default_model'), {
          headers: { Authorization: `Bearer ${token}` }
        });
        
        if (response.data && response.data.settingValue) {
          const modelValue = response.data.settingValue.trim();
          if (modelValue && availableModels.includes(modelValue)) {
            setDefaultModel(modelValue);
          } else {
            setDefaultModel(fallbackDefaultModel);
          }
          return;
        }
      } catch (settingsError: any) {
        if (settingsError.response?.status !== 404) {
          console.error('Error loading default model setting:', settingsError);
        }
      }
      
      setDefaultModel(fallbackDefaultModel);
    } catch (error) {
      console.error('Error loading default model:', error);
      setDefaultModel(fallbackDefaultModel);
    }
  };

  const loadAvailableFunctionCalls = async () => {
    try {
      const response = await axios.get(buildApiUrl('/api/agent-mode/function-calls'), {
        headers: { Authorization: `Bearer ${token}` }
      });
      
      if (response.data && response.data.functionCalls) {
        // Filter out work plan management functions
        const workPlanFunctions = ['create_work_plan', 'modify_work_plan', 'set_work_plan_status'];
        const filtered = response.data.functionCalls.filter(
          (func: AvailableFunctionCall) => !workPlanFunctions.includes(func.name)
        );
        setAvailableFunctionCalls(filtered);
      }
    } catch (error) {
      console.error('Error loading available function calls:', error);
      // Don't fail the entire load if this fails
      setAvailableFunctionCalls([]);
    }
  };

  const loadSystemPrompt = async () => {
    try {
      try {
        // Try to get custom system prompt from settings
        const response = await axios.get(buildApiUrl('/api/settings/agent_mode_system_prompt'), {
          headers: { Authorization: `Bearer ${token}` }
        });
        
        if (response.data && response.data.settingValue) {
          setSystemPrompt(response.data.settingValue);
          return;
        }
      } catch (settingsError: any) {
        // If setting doesn't exist (404) or other error, fall back to default
        if (settingsError.response?.status !== 404) {
          console.error('Error loading custom system prompt:', settingsError);
        }
      }
      
      // Load default system prompt
      const defaultResponse = await axios.get(buildApiUrl('/api/agent-mode/system-prompt'), {
        headers: { Authorization: `Bearer ${token}` }
      });
      setSystemPrompt(defaultResponse.data);
    } catch (error) {
      console.error('Error loading system prompt:', error);
      throw error;
    }
  };

  const loadWelcomeMessage = async () => {
    try {
      try {
        // Try to get custom welcome message from settings
        const response = await axios.get(buildApiUrl('/api/settings/agent_mode_welcome_message'), {
          headers: { Authorization: `Bearer ${token}` }
        });
        
        if (response.data && response.data.settingValue) {
          setWelcomeMessage(response.data.settingValue);
          return;
        }
      } catch (settingsError: any) {
        // If setting doesn't exist (404) or other error, fall back to default
        if (settingsError.response?.status !== 404) {
          console.error('Error loading custom welcome message:', settingsError);
        }
      }
      
      // Load default welcome message
      const defaultResponse = await axios.get(buildApiUrl('/api/agent-mode/welcome-message'), {
        headers: { Authorization: `Bearer ${token}` }
      });
      setWelcomeMessage(defaultResponse.data);
    } catch (error) {
      console.error('Error loading welcome message:', error);
      throw error;
    }
  };

  const loadConversationStarters = async () => {
    try {
      try {
        // Try to get custom conversation starters from settings
        const response = await axios.get(buildApiUrl('/api/settings/agent_mode_conversation_starters'), {
          headers: { Authorization: `Bearer ${token}` }
        });
        
        if (response.data && response.data.settingValue) {
          const starters = JSON.parse(response.data.settingValue);
          setConversationStarters(starters);
          setConversationStartersText(starters.join('\n'));
          return;
        }
      } catch (settingsError: any) {
        // If setting doesn't exist (404) or other error, fall back to default
        if (settingsError.response?.status !== 404) {
          console.error('Error loading custom conversation starters:', settingsError);
        }
      }
      
      // Load default conversation starters
      const defaultResponse = await axios.get(buildApiUrl('/api/agent-mode/conversation-starters'), {
        headers: { Authorization: `Bearer ${token}` }
      });
      setConversationStarters(defaultResponse.data);
      setConversationStartersText(defaultResponse.data.join('\n'));
    } catch (error) {
      console.error('Error loading conversation starters:', error);
      throw error;
    }
  };

  const getDefaultOnboardingPlan = (): PredefinedWorkPlan => ({
    id: `plan_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    autocomplete: false,
    requireLogin: false,
    showLoginSignup: 'after_plan_completed',
    showInAgentMode: false,
    title: 'Onboarding',
    welcomeMessage: 'Welcome to the onboarding process! I\'m here to help you get set up. Let\'s get started!',
    steps: [
      {
        stepCount: 1,
        title: 'Analyze website and business',
        description: 'Research and analyze the client\'s website and business to understand their industry, target audience, and current marketing presence',
        requiredFunctionCalls: ['search_web']
      },
      {
        stepCount: 2,
        title: 'Create/update brand guidelines',
        description: 'Establish or update brand guidelines including colors, fonts, tone of voice, and visual identity',
        requiredFunctionCalls: ['update_brand_guidelines']
      },
      {
        stepCount: 3,
        title: 'Create/update marketing strategy',
        description: 'Develop a comprehensive marketing strategy based on business analysis and brand guidelines',
        requiredFunctionCalls: ['update_marketing_strategy']
      },
      {
        stepCount: 4,
        title: 'Generate 3 blog articles',
        description: 'Create three high-quality blog articles aligned with the marketing strategy and brand voice',
        requiredFunctionCalls: ['create_blog_article']
      },
      {
        stepCount: 5,
        title: 'Generate social media posts',
        description: 'Create engaging social media content and visuals to support the marketing strategy',
        requiredFunctionCalls: ['generate_image']
      }
    ]
  });

  const loadPredefinedWorkPlans = async () => {
    try {
      try {
        const response = await axios.get(buildApiUrl('/api/settings/agent-mode-predefined-workplans'), {
          headers: { Authorization: `Bearer ${token}` }
        });
        
        if (response.data && response.data.settingValue) {
          const workPlans = JSON.parse(response.data.settingValue);
          
          // Ensure all work plans have IDs (for backward compatibility)
          const workPlansWithIds = workPlans.map((wp: PredefinedWorkPlan) => {
            if (!wp.id) {
              // Generate ID from title or create a new one
              wp.id = `plan_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            }
            return wp;
          });
          
          // Check if "Onboarding" work plan already exists
          const hasOnboarding = workPlansWithIds.some((wp: PredefinedWorkPlan) => 
            wp.title.toLowerCase() === 'onboarding'
          );
          
          // If no Onboarding plan exists, add the default one
          if (!hasOnboarding) {
            const defaultOnboardingPlan = getDefaultOnboardingPlan();
            defaultOnboardingPlan.id = `plan_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            workPlansWithIds.push(defaultOnboardingPlan);
            
            // Save the updated work plans with the default Onboarding plan
            try {
              await axios.put(buildApiUrl('/api/settings/agent-mode-predefined-workplans'), {
                settingValue: JSON.stringify(workPlansWithIds),
                description: 'Agent Mode predefined work plans for Emma AI assistant'
              }, {
                headers: { Authorization: `Bearer ${token}` }
              });
            } catch (saveError) {
              console.error('Error saving default Onboarding work plan:', saveError);
              // Continue anyway - we'll still show it in the UI
            }
          }
          
          setPredefinedWorkPlans(workPlansWithIds);
          return;
        }
      } catch (settingsError: any) {
        // If setting doesn't exist (404), create default Onboarding plan
        if (settingsError.response?.status === 404) {
          const defaultOnboardingPlan = getDefaultOnboardingPlan();
          defaultOnboardingPlan.id = `plan_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
          
          // Try to save the default Onboarding plan
          try {
            await axios.put(buildApiUrl('/api/settings/agent-mode-predefined-workplans'), {
              settingValue: JSON.stringify([defaultOnboardingPlan]),
              description: 'Agent Mode predefined work plans for Emma AI assistant'
            }, {
              headers: { Authorization: `Bearer ${token}` }
            });
          } catch (saveError) {
            console.error('Error saving default Onboarding work plan:', saveError);
            // Continue anyway - we'll still show it in the UI
          }
          
          setPredefinedWorkPlans([defaultOnboardingPlan]);
          return;
        } else {
          console.error('Error loading predefined work plans:', settingsError);
          setPredefinedWorkPlans([]);
        }
      }
    } catch (error) {
      console.error('Error loading predefined work plans:', error);
      setPredefinedWorkPlans([]);
    }
  };

  const loadContentModel = async () => {
    try {
      try {
        // Try to get content model from settings
        const response = await axios.get(buildApiUrl('/api/settings/agent_mode_content_model'), {
          headers: { Authorization: `Bearer ${token}` }
        });
        
        if (response.data && response.data.settingValue) {
          setContentModel(response.data.settingValue);
          return;
        }
      } catch (settingsError: any) {
        // If setting doesn't exist (404), use default
        if (settingsError.response?.status !== 404) {
          console.error('Error loading content model:', settingsError);
        }
      }
      
      // Default to gpt-5-chat-2 if no setting exists
      setContentModel('gpt-5-chat-2');
    } catch (error) {
      console.error('Error loading content model:', error);
      setContentModel('gpt-4');
    }
  };

  const saveContentModel = async () => {
    try {
      setSavingContentModel(true);
      setError('');
      setSuccess('');

      await axios.put(buildApiUrl('/api/settings/agent_mode_content_model'), {
        settingValue: contentModel,
        description: 'Content model for blog article and book content generation (e.g., gpt-4, claude-sonnet-4-5 via AWS Bedrock). Note: This does not affect Agent Mode chat conversations.'
      }, {
        headers: { Authorization: `Bearer ${token}` }
      });

      setSuccess('Content model updated successfully!');
    } catch (error) {
      console.error('Error saving content model:', error);
      setError('Failed to save content model');
    } finally {
      setSavingContentModel(false);
    }
  };

  const loadReportsModel = async (models: string[] = []) => {
    const availableModels = models.length > 0 ? models : [fallbackDefaultModel, 'gemini-3-pro-preview'];
    try {
      try {
        // Try to get reports model from settings
        const response = await axios.get(buildApiUrl('/api/settings/agent_mode_reports_model'), {
          headers: { Authorization: `Bearer ${token}` }
        });

        if (response.data && response.data.settingValue) {
          const configuredModel = response.data.settingValue;
          // Verify the model is in available Agent Mode models list
          if (availableModels.includes(configuredModel)) {
            setReportsModel(configuredModel);
            return;
          } else {
            console.warn('Configured reports model not in supported Agent Mode models list, using fallback');
          }
        }
      } catch (settingsError: any) {
        // If setting doesn't exist (404), use default
        if (settingsError.response?.status !== 404) {
          console.error('Error loading reports model:', settingsError);
        }
      }

      // Default to fallbackDefaultModel or first supported model
      const fallback = availableModels.includes(fallbackDefaultModel)
        ? fallbackDefaultModel
        : (availableModels[0] || 'gpt-5-chat-2');
      setReportsModel(fallback);
    } catch (error) {
      console.error('Error loading reports model:', error);
      setReportsModel(availableModels[0] || 'gpt-5-chat-2');
    }
  };

  const saveReportsModel = async () => {
    try {
      setSavingReportsModel(true);
      setError('');
      setSuccess('');

      await axios.put(buildApiUrl('/api/settings/agent_mode_reports_model'), {
        settingValue: reportsModel,
        description: 'Default LLM model for Reports page (for creating and revising reports in Agent Mode). This is used as the initial model selection when creating new reports or revising existing reports.'
      }, {
        headers: { Authorization: `Bearer ${token}` }
      });

      setSuccess('Reports model updated successfully!');
    } catch (error) {
      console.error('Error saving reports model:', error);
      setError('Failed to save reports model');
    } finally {
      setSavingReportsModel(false);
    }
  };

  const saveSystemPrompt = async () => {
    try {
      setSavingSystemPrompt(true);
      setError('');
      setSuccess('');
      
      await axios.put(buildApiUrl('/api/settings/agent_mode_system_prompt'), {
        settingValue: systemPrompt,
        description: 'Agent Mode system prompt for Emma AI assistant'
      }, {
        headers: { Authorization: `Bearer ${token}` }
      });
      
      setSuccess('System prompt updated successfully!');
    } catch (error) {
      console.error('Error saving system prompt:', error);
      setError('Failed to save system prompt');
    } finally {
      setSavingSystemPrompt(false);
    }
  };

  const saveDefaultModel = async () => {
    try {
      setSavingDefaultModel(true);
      setError('');
      setSuccess('');

      await axios.put(buildApiUrl('/api/settings/agent_mode_default_model'), {
        settingValue: defaultModel,
        description: 'Agent Mode default model for new sessions'
      }, {
        headers: { Authorization: `Bearer ${token}` }
      });

      setSuccess('Default model updated successfully!');
    } catch (error) {
      console.error('Error saving default model:', error);
      setError('Failed to save default model');
    } finally {
      setSavingDefaultModel(false);
    }
  };

  const saveWelcomeMessage = async () => {
    try {
      setSavingWelcomeMessage(true);
      setError('');
      setSuccess('');
      
      await axios.put(buildApiUrl('/api/settings/agent_mode_welcome_message'), {
        settingValue: welcomeMessage,
        description: 'Agent Mode welcome message for Emma AI assistant'
      }, {
        headers: { Authorization: `Bearer ${token}` }
      });
      
      setSuccess('Welcome message updated successfully!');
    } catch (error) {
      console.error('Error saving welcome message:', error);
      setError('Failed to save welcome message');
    } finally {
      setSavingWelcomeMessage(false);
    }
  };

  const saveConversationStarters = async () => {
    try {
      setSavingConversationStarters(true);
      setError('');
      setSuccess('');
      
      // Parse the text input into an array
      const starters = conversationStartersText
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0);
      
      await axios.put(buildApiUrl('/api/settings/agent_mode_conversation_starters'), {
        settingValue: JSON.stringify(starters),
        description: 'Agent Mode conversation starters for Emma AI assistant'
      }, {
        headers: { Authorization: `Bearer ${token}` }
      });
      
      setConversationStarters(starters);
      setSuccess('Conversation starters updated successfully!');
    } catch (error) {
      console.error('Error saving conversation starters:', error);
      setError('Failed to save conversation starters');
    } finally {
      setSavingConversationStarters(false);
    }
  };

  const saveIndividualWorkPlan = async (workPlanIndex: number) => {
    const workPlan = predefinedWorkPlans[workPlanIndex];
    if (!workPlan) {
      setError('Work plan not found');
      return;
    }

    // Generate ID if it doesn't exist (for new plans)
    const planId = workPlan.id || `plan_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Clear previous messages
    setError('');
    setSuccess('');
    setWorkPlanErrors(prev => {
      const updated = { ...prev };
      delete updated[planId];
      return updated;
    });
    
    try {
      setSavingWorkPlanId(planId);
      setSavingWorkPlanIndex(workPlanIndex);
      
      // Validate work plan title
      if (workPlan.title.trim().length === 0) {
        const errorMsg = 'Work plan must have a title';
        setError(errorMsg);
        setWorkPlanErrors(prev => ({ ...prev, [planId]: errorMsg }));
        setSavingWorkPlanId(null);
        setSavingWorkPlanIndex(null);
        // Scroll to the work plan
        setTimeout(() => {
          const workPlanCard = document.getElementById(`work-plan-${planId}`);
          if (workPlanCard) {
            workPlanCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        }, 100);
        return;
      }
      
      // Validate that at least one step exists
      if (!workPlan.steps || workPlan.steps.length === 0) {
        const errorMsg = 'Work plan must have at least one step';
        setError(errorMsg);
        setWorkPlanErrors(prev => ({ ...prev, [planId]: errorMsg }));
        setSavingWorkPlanId(null);
        setSavingWorkPlanIndex(null);
        setTimeout(() => {
          const workPlanCard = document.getElementById(`work-plan-${planId}`);
          if (workPlanCard) {
            workPlanCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        }, 100);
        return;
      }
      
      // Validate that the first step has a title (first step is required)
      if (!workPlan.steps[0] || workPlan.steps[0].title.trim().length === 0) {
        const errorMsg = 'The first step is required and must have a title';
        setError(errorMsg);
        setWorkPlanErrors(prev => ({ ...prev, [planId]: errorMsg }));
        setSavingWorkPlanId(null);
        setSavingWorkPlanIndex(null);
        // Scroll to the first step input field
        setTimeout(() => {
          const workPlanCard = document.getElementById(`work-plan-${planId}`);
          if (workPlanCard) {
            const firstStepInput = workPlanCard.querySelector('input[placeholder*="Step Title"]') as HTMLInputElement;
            if (firstStepInput) {
              firstStepInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
              firstStepInput.focus();
            } else {
              workPlanCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
          }
        }, 100);
        return;
      }
      
      // Validate work plan
      const validatedWorkPlan = {
        id: planId,
        title: workPlan.title.trim(),
        description: workPlan.description?.trim() || undefined,
        welcomeMessage: workPlan.welcomeMessage?.trim() || undefined,
        autocomplete: workPlan.autocomplete || false,
        requireLogin: workPlan.requireLogin || false,
        showLoginSignup: workPlan.showLoginSignup || 'after_plan_completed',
        showInAgentMode: workPlan.showInAgentMode || false,
        defaultModel: workPlan.defaultModel?.trim() || undefined,
        steps: workPlan.steps
          .filter(step => step.title.trim().length > 0)
          .map((step, index) => ({
            stepCount: index + 1,
            title: step.title.trim(),
            description: step.description?.trim() || undefined,
            requiredFunctionCalls: step.requiredFunctionCalls?.filter(f => f.trim().length > 0) || undefined
          }))
      };

      // Final validation after filtering
      if (validatedWorkPlan.steps.length === 0) {
        const errorMsg = 'Work plan must have at least one step with a title';
        setError(errorMsg);
        setWorkPlanErrors(prev => ({ ...prev, [planId]: errorMsg }));
        setSavingWorkPlanId(null);
        setSavingWorkPlanIndex(null);
        setTimeout(() => {
          const workPlanCard = document.getElementById(`work-plan-${planId}`);
          if (workPlanCard) {
            workPlanCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        }, 100);
        return;
      }
      
      // Try PUT first (for existing plans), fall back to POST if plan doesn't exist (404)
      try {
        // Try to update existing work plan
        await axios.put(buildApiUrl(`/api/settings/agent-mode-predefined-workplans/${planId}`), validatedWorkPlan, {
          headers: { Authorization: `Bearer ${token}` }
        });
      } catch (putError: any) {
        // If PUT fails with 404, the plan doesn't exist yet, so create it with POST
        if (putError.response?.status === 404) {
          await axios.post(buildApiUrl('/api/settings/agent-mode-predefined-workplans'), validatedWorkPlan, {
            headers: { Authorization: `Bearer ${token}` }
          });
        } else {
          // Re-throw other errors
          throw putError;
        }
      }
      
      // Update local state with the validated plan (including the ID)
      const updated = [...predefinedWorkPlans];
      updated[workPlanIndex] = validatedWorkPlan;
      setPredefinedWorkPlans(updated);
      setSuccess(`Work plan "${validatedWorkPlan.title}" saved successfully!`);
      // Clear any work plan specific errors
      setWorkPlanErrors(prev => {
        const updated = { ...prev };
        delete updated[planId];
        return updated;
      });
    } catch (error: any) {
      console.error('Error saving work plan:', error);
      const errorMessage = error.response?.data?.error || 'Failed to save work plan';
      setError(errorMessage);
      setWorkPlanErrors(prev => ({ ...prev, [planId]: errorMessage }));
    } finally {
      setSavingWorkPlanId(null);
      setSavingWorkPlanIndex(null);
    }
  };

  const addWorkPlan = async () => {
    const newWorkPlan: PredefinedWorkPlan = {
      id: `plan_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      title: '',
      steps: [{ stepCount: 1, title: '' }],
      autocomplete: false,
      requireLogin: false,
      showLoginSignup: 'after_plan_completed',
      showInAgentMode: false,
      defaultModel: undefined
    };
    
    setPredefinedWorkPlans([
      ...predefinedWorkPlans,
      newWorkPlan
    ]);
    
    // Set the newly added plan ID to trigger scroll
    setNewlyAddedPlanId(newWorkPlan.id || null);
  };

  const removeWorkPlan = async (index: number) => {
    const workPlan = predefinedWorkPlans[index];
    if (!workPlan) return;

    // If the work plan has an ID and has been saved, delete it from the backend
    if (workPlan.id) {
      try {
        setSavingWorkPlanId(workPlan.id);
        setSavingWorkPlanIndex(index);
        await axios.delete(buildApiUrl(`/api/settings/agent-mode-predefined-workplans/${workPlan.id}`), {
          headers: { Authorization: `Bearer ${token}` }
        });
      } catch (error: any) {
        console.error('Error deleting work plan from backend:', error);
        const errorMessage = error.response?.data?.error || 'Failed to delete work plan from backend';
        setError(errorMessage);
        // Continue with local removal even if backend delete fails
      } finally {
        setSavingWorkPlanId(null);
        setSavingWorkPlanIndex(null);
      }
    }

    // Remove from local state
    setPredefinedWorkPlans(predefinedWorkPlans.filter((_, i) => i !== index));
    
    // Clear any errors for this work plan
    if (workPlan.id) {
      setWorkPlanErrors(prev => {
        const updated = { ...prev };
        delete updated[workPlan.id!];
        return updated;
      });
    }
  };

  const updateWorkPlan = (index: number, workPlan: PredefinedWorkPlan) => {
    const updated = [...predefinedWorkPlans];
    updated[index] = workPlan;
    setPredefinedWorkPlans(updated);
  };

  const addStepToWorkPlan = (workPlanIndex: number) => {
    const updated = [...predefinedWorkPlans];
    updated[workPlanIndex].steps.push({
      stepCount: updated[workPlanIndex].steps.length + 1,
      title: ''
    });
    setPredefinedWorkPlans(updated);
  };

  const removeStepFromWorkPlan = (workPlanIndex: number, stepIndex: number) => {
    const updated = [...predefinedWorkPlans];
    updated[workPlanIndex].steps = updated[workPlanIndex].steps
      .filter((_, i) => i !== stepIndex)
      .map((step, i) => ({ ...step, stepCount: i + 1 }));
    setPredefinedWorkPlans(updated);
  };

  const updateStepInWorkPlan = (workPlanIndex: number, stepIndex: number, step: WorkPlanStep) => {
    const updated = [...predefinedWorkPlans];
    updated[workPlanIndex].steps[stepIndex] = step;
    setPredefinedWorkPlans(updated);
  };

  const resetToDefault = async (type: 'systemPrompt' | 'welcomeMessage' | 'conversationStarters' | 'defaultModel') => {
    try {
      setError('');
      setSuccess('');
      
      if (type === 'systemPrompt') {
        setSavingSystemPrompt(true);
        // First, delete the custom setting from the database
        await axios.delete(buildApiUrl('/api/settings/agent_mode_system_prompt'), {
          headers: { Authorization: `Bearer ${token}` }
        });
        
        // Then load the default system prompt
        const response = await axios.get(buildApiUrl('/api/agent-mode/system-prompt'), {
          headers: { Authorization: `Bearer ${token}` }
        });
        
        setSystemPrompt(response.data);
        setSuccess('Reset to default system prompt successfully!');
      } else if (type === 'welcomeMessage') {
        setSavingWelcomeMessage(true);
        // First, delete the custom setting from the database
        await axios.delete(buildApiUrl('/api/settings/agent_mode_welcome_message'), {
          headers: { Authorization: `Bearer ${token}` }
        });
        
        // Then load the default welcome message
        const response = await axios.get(buildApiUrl('/api/agent-mode/welcome-message'), {
          headers: { Authorization: `Bearer ${token}` }
        });
        
        setWelcomeMessage(response.data);
        setSuccess('Reset to default welcome message successfully!');
      } else if (type === 'conversationStarters') {
        setSavingConversationStarters(true);
        // First, delete the custom setting from the database
        await axios.delete(buildApiUrl('/api/settings/agent_mode_conversation_starters'), {
          headers: { Authorization: `Bearer ${token}` }
        });
        
        // Then load the default conversation starters
        const response = await axios.get(buildApiUrl('/api/agent-mode/conversation-starters'), {
          headers: { Authorization: `Bearer ${token}` }
        });
        
        setConversationStarters(response.data);
        setConversationStartersText(response.data.join('\n'));
        setSuccess('Reset to default conversation starters successfully!');
      } else if (type === 'defaultModel') {
        setSavingDefaultModel(true);
        await axios.delete(buildApiUrl('/api/settings/agent_mode_default_model'), {
          headers: { Authorization: `Bearer ${token}` }
        });

        setDefaultModel(fallbackDefaultModel);
        setSuccess('Reset to default model successfully!');
      }
    } catch (error) {
      console.error('Error resetting setting:', error);
      setError('Failed to reset setting');
    } finally {
      if (type === 'systemPrompt') {
        setSavingSystemPrompt(false);
      } else if (type === 'welcomeMessage') {
        setSavingWelcomeMessage(false);
      } else if (type === 'conversationStarters') {
        setSavingConversationStarters(false);
      } else if (type === 'defaultModel') {
        setSavingDefaultModel(false);
      }
    }
  };

  if (loading) {
    return (
      <Box display="flex" justifyContent="center" alignItems="center" minHeight="400px">
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box>
      <Typography variant="h6" gutterBottom>
        Agent Mode Configuration
      </Typography>
      <Typography variant="body2" color="text.secondary" paragraph>
        Customize Emma's behavior, welcome message, and conversation starters in Agent Mode. 
        Changes will apply to new chat sessions.
      </Typography>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {success && (
        <Alert severity="success" sx={{ mb: 2 }}>
          {success}
        </Alert>
      )}

      {/* Default Model */}
      <Card sx={{ mb: 3 }}>
        <CardContent>
          <Box display="flex" justifyContent="space-between" alignItems="center" mb={2}>
            <Typography variant="h6">Default Model</Typography>
            <Box>
              <Button
                variant="outlined"
                onClick={() => resetToDefault('defaultModel')}
                disabled={savingDefaultModel}
                sx={{ mr: 1 }}
              >
                Reset to Default
              </Button>
              <Button
                variant="contained"
                onClick={saveDefaultModel}
                disabled={savingDefaultModel || !defaultModel}
              >
                {savingDefaultModel ? <CircularProgress size={20} /> : 'Save Changes'}
              </Button>
            </Box>
          </Box>

          <FormControl fullWidth>
            <InputLabel id="agent-mode-default-model-label">Default Model</InputLabel>
            <Select
              labelId="agent-mode-default-model-label"
              value={defaultModel}
              label="Default Model"
              onChange={(e) => setDefaultModel(e.target.value as string)}
            >
              {(supportedModels.length > 0
                ? supportedModels
                : [fallbackDefaultModel, 'gemini-3-pro-preview']
              ).map((model) => (
                <MenuItem key={model} value={model}>
                  {model}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
            Sets the default model for newly created Agent Mode sessions. Existing sessions keep their current model.
          </Typography>
        </CardContent>
      </Card>

      {/* Content Model for Blog/Book Generation */}
      <Card sx={{ mb: 3 }}>
        <CardContent>
          <Box display="flex" justifyContent="space-between" alignItems="center" mb={2}>
            <Typography variant="h6">Content Model (Blog & Book Generation)</Typography>
            <Button
              variant="contained"
              onClick={saveContentModel}
              disabled={savingContentModel}
            >
              {savingContentModel ? <CircularProgress size={20} /> : 'Save Changes'}
            </Button>
          </Box>

          <FormControl fullWidth sx={{ mb: 2 }}>
            <InputLabel>Content Model</InputLabel>
            <Select
              value={contentModel}
              onChange={(e) => setContentModel(e.target.value)}
              label="Content Model"
            >
              <MenuItem value="gpt-5-chat-2">GPT-5 Chat 2 (Azure)</MenuItem>
              <MenuItem value="anthropic.claude-sonnet-4-5-20250929-v1:0">
                Claude Sonnet 4.5 (AWS Bedrock)
              </MenuItem>
            </Select>
          </FormControl>

          <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
            Select the LLM model to use for blog article and book content generation. This setting does NOT affect Agent Mode chat conversations, which use their own model configuration.
          </Typography>
        </CardContent>
      </Card>

      {/* Reports Model Configuration */}
      <Card sx={{ mb: 3 }}>
        <CardContent>
          <Box display="flex" justifyContent="space-between" alignItems="center" mb={2}>
            <Typography variant="h6">Reports Model (Default)</Typography>
            <Button
              variant="contained"
              onClick={saveReportsModel}
              disabled={savingReportsModel}
            >
              {savingReportsModel ? <CircularProgress size={20} /> : 'Save Changes'}
            </Button>
          </Box>

          <FormControl fullWidth sx={{ mb: 2 }}>
            <InputLabel>Reports Model</InputLabel>
            <Select
              value={reportsModel}
              onChange={(e) => setReportsModel(e.target.value)}
              label="Reports Model"
            >
              {supportedModels.map((model) => (
                <MenuItem key={model} value={model}>
                  {model}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
            Select the default LLM model for the Reports page in Agent Mode. This model will be used when creating new reports and as the default when revising existing reports. This uses the same models available for Agent Mode sessions.
          </Typography>
        </CardContent>
      </Card>

      {/* System Prompt */}
      <Card sx={{ mb: 3 }}>
        <CardContent>
          <Box display="flex" justifyContent="space-between" alignItems="center" mb={2}>
            <Typography variant="h6">
              System Prompt
            </Typography>
            <Box>
              <Button
                variant="outlined"
                onClick={() => resetToDefault('systemPrompt')}
                disabled={savingSystemPrompt}
                sx={{ mr: 1 }}
              >
                Reset to Default
              </Button>
              <Button
                variant="contained"
                onClick={saveSystemPrompt}
                disabled={savingSystemPrompt}
              >
                {savingSystemPrompt ? <CircularProgress size={20} /> : 'Save Changes'}
              </Button>
            </Box>
          </Box>
          
          <TextField
            fullWidth
            multiline
            rows={15}
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            placeholder="Enter the system prompt for Emma..."
            variant="outlined"
            sx={{ fontFamily: 'monospace' }}
          />
          
          <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
            The system prompt defines Emma's behavior, capabilities, and response format. 
            Use HTML formatting for responses. Changes will be versioned and tracked in chat history.
          </Typography>
        </CardContent>
      </Card>

      {/* Welcome Message */}
      <Card sx={{ mb: 3 }}>
        <CardContent>
          <Box display="flex" justifyContent="space-between" alignItems="center" mb={2}>
            <Typography variant="h6">
              Welcome Message
            </Typography>
            <Box>
              <Button
                variant="outlined"
                onClick={() => resetToDefault('welcomeMessage')}
                disabled={savingWelcomeMessage}
                sx={{ mr: 1 }}
              >
                Reset to Default
              </Button>
              <Button
                variant="contained"
                onClick={saveWelcomeMessage}
                disabled={savingWelcomeMessage}
              >
                {savingWelcomeMessage ? <CircularProgress size={20} /> : 'Save Changes'}
              </Button>
            </Box>
          </Box>
          
          <TextField
            fullWidth
            multiline
            rows={4}
            value={welcomeMessage}
            onChange={(e) => setWelcomeMessage(e.target.value)}
            placeholder="Enter the welcome message for Emma... (supports HTML formatting like &lt;strong&gt;bold&lt;/strong&gt;, &lt;ul&gt;&lt;li&gt;lists&lt;/li&gt;&lt;/ul&gt;, etc.)"
            variant="outlined"
          />
          
          <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
            The welcome message appears when users start a new chat session with Emma. 
            Supports HTML formatting: <strong>&lt;strong&gt;</strong>, <em>&lt;em&gt;</em>, 
            <code>&lt;ul&gt;</code>, <code>&lt;li&gt;</code>, <code>&lt;br&gt;</code>, etc.
            <br /><br />
            <strong>Example:</strong><br />
            <code>
              I'm Emma, your team's new CMO 😎&lt;br&gt;&lt;br&gt;<br />
              &lt;strong&gt;I can help you with:&lt;/strong&gt;&lt;br&gt;<br />
              • Market research and analysis&lt;br&gt;<br />
              • Ad campaign optimization&lt;br&gt;<br />
              • Content strategy development
            </code>
          </Typography>
        </CardContent>
      </Card>

      {/* Conversation Starters */}
      <Card sx={{ mb: 3 }}>
        <CardContent>
          <Box display="flex" justifyContent="space-between" alignItems="center" mb={2}>
            <Typography variant="h6">
              Conversation Starters
            </Typography>
            <Box>
              <Button
                variant="outlined"
                onClick={() => resetToDefault('conversationStarters')}
                disabled={savingConversationStarters}
                sx={{ mr: 1 }}
              >
                Reset to Default
              </Button>
              <Button
                variant="contained"
                onClick={saveConversationStarters}
                disabled={savingConversationStarters}
              >
                {savingConversationStarters ? <CircularProgress size={20} /> : 'Save Changes'}
              </Button>
            </Box>
          </Box>
          
          <TextField
            fullWidth
            multiline
            rows={6}
            value={conversationStartersText}
            onChange={(e) => setConversationStartersText(e.target.value)}
            placeholder="Enter conversation starters, one per line..."
            variant="outlined"
          />
          
          <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
            Enter one conversation starter per line. These will appear as quick-start buttons in the Agent Mode interface.
          </Typography>
        </CardContent>
      </Card>

      {/* Predefined Work Plans */}
      <Card>
        <CardContent>
          <Box display="flex" justifyContent="space-between" alignItems="center" mb={2}>
            <Typography variant="h6">
              Predefined Work Plans
            </Typography>
            <Box>
              <Button
                variant="outlined"
                startIcon={<AddIcon />}
                onClick={addWorkPlan}
                disabled={false}
                sx={{ mr: 1 }}
              >
                Add Work Plan
              </Button>
            </Box>
          </Box>
          
          <Typography variant="body2" color="text.secondary" paragraph>
            Configure predefined work plans that can be used in Agent Mode. Each work plan consists of a title and multiple steps.
          </Typography>

          {predefinedWorkPlans.length === 0 ? (
            <Box sx={{ textAlign: 'center', py: 4 }}>
              <Typography variant="body2" color="text.secondary">
                No predefined work plans configured. Click "Add Work Plan" to create one.
              </Typography>
            </Box>
          ) : (
            <Box>
              {predefinedWorkPlans.map((workPlan, workPlanIndex) => (
                <Card 
                  key={workPlan.id || workPlanIndex} 
                  id={`work-plan-${workPlan.id || workPlanIndex}`}
                  sx={{ mb: 2, border: '1px solid', borderColor: 'divider' }}
                >
                  <CardContent>
                    {workPlanErrors[workPlan.id || ''] && (
                      <Alert severity="error" sx={{ mb: 2 }} onClose={() => {
                        setWorkPlanErrors(prev => {
                          const updated = { ...prev };
                          delete updated[workPlan.id || ''];
                          return updated;
                        });
                      }}>
                        {workPlanErrors[workPlan.id || '']}
                      </Alert>
                    )}
                    <Box display="flex" justifyContent="space-between" alignItems="center" mb={2}>
                      <TextField
                        label="Work Plan Title"
                        value={workPlan.title}
                        onChange={(e) => {
                          updateWorkPlan(workPlanIndex, { ...workPlan, title: e.target.value });
                          // Clear error when user starts typing
                          if (workPlanErrors[workPlan.id || '']) {
                            setWorkPlanErrors(prev => {
                              const updated = { ...prev };
                              delete updated[workPlan.id || ''];
                              return updated;
                            });
                          }
                        }}
                        placeholder="Enter work plan title..."
                        variant="outlined"
                        fullWidth
                        sx={{ mr: 2 }}
                        error={!!workPlanErrors[workPlan.id || ''] && workPlanErrors[workPlan.id || ''].includes('title')}
                      />
                      <Box display="flex" gap={1}>
                        <Button
                          variant="contained"
                          onClick={() => saveIndividualWorkPlan(workPlanIndex)}
                          disabled={(savingWorkPlanId === workPlan.id || savingWorkPlanIndex === workPlanIndex)}
                          size="small"
                        >
                          {(savingWorkPlanId === workPlan.id || savingWorkPlanIndex === workPlanIndex) ? <CircularProgress size={20} /> : 'Save'}
                        </Button>
                        <IconButton
                          color="error"
                          onClick={() => removeWorkPlan(workPlanIndex)}
                          disabled={(savingWorkPlanId === workPlan.id || savingWorkPlanIndex === workPlanIndex)}
                        >
                          <DeleteIcon />
                        </IconButton>
                      </Box>
                    </Box>

                    <TextField
                      label="Description (Optional)"
                      value={workPlan.description || ''}
                      onChange={(e) => updateWorkPlan(workPlanIndex, { ...workPlan, description: e.target.value })}
                      placeholder="Enter a brief description of this work plan..."
                      variant="outlined"
                      fullWidth
                      multiline
                      rows={2}
                      sx={{ mb: 2 }}
                      helperText="This description will be displayed on the work plan card in Agent Mode."
                    />

                    <TextField
                      label="Welcome Message (Optional)"
                      value={workPlan.welcomeMessage || ''}
                      onChange={(e) => updateWorkPlan(workPlanIndex, { ...workPlan, welcomeMessage: e.target.value })}
                      placeholder="Enter the welcome message to display when a session is created with this plan... (supports HTML formatting)"
                      variant="outlined"
                      fullWidth
                      multiline
                      rows={4}
                      sx={{ mb: 2 }}
                      helperText="This message will be displayed as the welcome message when a session is created with this plan. If not provided, the default Agent Mode welcome message will be used."
                    />

                    <Box sx={{ mb: 2 }}>
                      <Box display="flex" flexDirection="column" gap={2}>
                        <Box display="flex" flexWrap="wrap" gap={3}>
                          <Box display="flex" flexDirection="column" sx={{ minWidth: 200 }}>
                            <FormControlLabel
                              control={
                                <Checkbox
                                  checked={workPlan.autocomplete || false}
                                  onChange={(e) => updateWorkPlan(workPlanIndex, { ...workPlan, autocomplete: e.target.checked })}
                                  disabled={false}
                                />
                              }
                              label="Autocomplete Steps"
                            />
                            <Typography variant="caption" color="text.secondary" sx={{ ml: 4, mt: -1 }}>
                              When enabled, Emma MUST complete each step before responding to the user. Steps will be automatically completed when all required function calls are executed.
                            </Typography>
                          </Box>
                          <Box display="flex" flexDirection="column" sx={{ minWidth: 200 }}>
                            <FormControlLabel
                              control={
                                <Checkbox
                                  checked={workPlan.requireLogin || false}
                                  onChange={(e) => updateWorkPlan(workPlanIndex, { ...workPlan, requireLogin: e.target.checked })}
                                  disabled={false}
                                />
                              }
                              label="Require Login"
                            />
                            <Typography variant="caption" color="text.secondary" sx={{ ml: 4, mt: -1 }}>
                              Users must log in before starting this plan.
                            </Typography>
                          </Box>
                          <Box display="flex" flexDirection="column" sx={{ minWidth: 200 }}>
                            <FormControlLabel
                              control={
                                <Checkbox
                                  checked={workPlan.showInAgentMode || false}
                                  onChange={(e) => updateWorkPlan(workPlanIndex, { ...workPlan, showInAgentMode: e.target.checked })}
                                  disabled={false}
                                />
                              }
                              label="Show in Agent Mode"
                            />
                            <Typography variant="caption" color="text.secondary" sx={{ ml: 4, mt: -1 }}>
                              When enabled, this plan will be displayed on the agent-mode/new page in the customer portal.
                            </Typography>
                          </Box>
                        </Box>
                      </Box>
                    </Box>

                    <FormControl fullWidth size="small" sx={{ mb: 2 }}>
                      <InputLabel>Show Login/Signup</InputLabel>
                      <Select
                        value={workPlan.showLoginSignup || 'after_plan_completed'}
                        label="Show Login/Signup"
                        onChange={(e) =>
                          updateWorkPlan(workPlanIndex, {
                            ...workPlan,
                            showLoginSignup: e.target.value as 'after_plan_completed' | 'always'
                          })
                        }
                        disabled={false}
                      >
                        <MenuItem value="after_plan_completed">After plan completed</MenuItem>
                        <MenuItem value="always">Always</MenuItem>
                      </Select>
                      <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: 'block' }}>
                        Controls when the login/signup prompt is displayed during a plan session.
                      </Typography>
                    </FormControl>

                    {/* Default Model Selection */}
                    <FormControl fullWidth size="small" sx={{ mb: 2 }}>
                      <InputLabel>Default Model (Optional)</InputLabel>
                      <Select
                        value={workPlan.defaultModel || ''}
                        onChange={(e) => {
                          const updated = [...predefinedWorkPlans];
                          updated[workPlanIndex].defaultModel = e.target.value || undefined;
                          setPredefinedWorkPlans(updated);
                        }}
                        label="Default Model (Optional)"
                      >
                        <MenuItem value="">
                          <em>Use Agent Mode Default</em>
                        </MenuItem>
                        {supportedModels.map((modelName) => (
                          <MenuItem key={modelName} value={modelName}>
                            {modelName}
                          </MenuItem>
                        ))}
                      </Select>
                      <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: 'block' }}>
                        Model to use for sessions created with this work plan. Leave empty to use the global Agent Mode default.
                      </Typography>
                    </FormControl>

                    <Typography variant="subtitle2" gutterBottom sx={{ mt: 2, mb: 1 }}>
                      Steps:
                    </Typography>

                    {workPlan.steps.map((step, stepIndex) => (
                      <Box key={stepIndex} sx={{ mb: 2, p: 2, bgcolor: 'background.default', borderRadius: 1 }}>
                        <Box display="flex" justifyContent="space-between" alignItems="flex-start" mb={1}>
                          <Typography variant="body2" color="text.secondary" sx={{ minWidth: 60 }}>
                            Step {step.stepCount}:
                          </Typography>
                          <IconButton
                            size="small"
                            color="error"
                            onClick={() => removeStepFromWorkPlan(workPlanIndex, stepIndex)}
                            disabled={false}
                          >
                            <DeleteIcon fontSize="small" />
                          </IconButton>
                        </Box>
                        <TextField
                          label="Step Title"
                          value={step.title}
                          onChange={(e) => updateStepInWorkPlan(workPlanIndex, stepIndex, { ...step, title: e.target.value })}
                          placeholder="Enter step title..."
                          variant="outlined"
                          fullWidth
                          size="small"
                          sx={{ mb: 1 }}
                        />
                        <TextField
                          label="Step Description (Optional)"
                          value={step.description || ''}
                          onChange={(e) => updateStepInWorkPlan(workPlanIndex, stepIndex, { ...step, description: e.target.value })}
                          placeholder="Enter step description..."
                          variant="outlined"
                          fullWidth
                          multiline
                          rows={2}
                          size="small"
                          sx={{ mb: 1 }}
                        />
                        <Box>
                          <Typography variant="body2" fontWeight="medium" gutterBottom>
                            Required Function Calls (Optional)
                          </Typography>
                          
                          {/* Add Function Call Dropdown */}
                          <Box sx={{ display: 'flex', gap: 1, mb: 1 }}>
                            <FormControl size="small" sx={{ flexGrow: 1 }}>
                              <InputLabel>Add Function Call</InputLabel>
                              <Select
                                value={selectedFunctionCall[`${workPlanIndex}-${stepIndex}`] || ''}
                                label="Add Function Call"
                                onChange={(e) => {
                                  const selectedFunc = e.target.value as string;
                                  if (selectedFunc) {
                                    const currentCalls = step.requiredFunctionCalls || [];
                                    updateStepInWorkPlan(workPlanIndex, stepIndex, {
                                      ...step,
                                      requiredFunctionCalls: [...currentCalls, selectedFunc]
                                    });
                                    // Reset the select
                                    setSelectedFunctionCall(prev => ({
                                      ...prev,
                                      [`${workPlanIndex}-${stepIndex}`]: ''
                                    }));
                                  }
                                }}
                                disabled={savingWorkPlanId !== null || availableFunctionCalls.length === 0}
                              >
                                <MenuItem value="">
                                  <em>Select a function...</em>
                                </MenuItem>
                                {availableFunctionCalls.length === 0 ? (
                                  <MenuItem disabled>Loading function calls...</MenuItem>
                                ) : (
                                  availableFunctionCalls.map((func) => (
                                    <MenuItem key={func.name} value={func.name}>
                                      <Box>
                                        <Typography variant="body2" fontWeight="medium">
                                          {func.name}
                                        </Typography>
                                        <Typography variant="caption" color="text.secondary">
                                          {func.description}
                                        </Typography>
                                      </Box>
                                    </MenuItem>
                                  ))
                                )}
                              </Select>
                            </FormControl>
                          </Box>

                          {/* Display Added Function Calls */}
                          {step.requiredFunctionCalls && step.requiredFunctionCalls.length > 0 && (
                            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mb: 1 }}>
                              {step.requiredFunctionCalls.map((funcName, callIndex) => (
                                <Chip
                                  key={`${workPlanIndex}-${stepIndex}-${callIndex}`}
                                  label={funcName}
                                  onDelete={() => {
                                    const currentCalls = step.requiredFunctionCalls || [];
                                    const newCalls = currentCalls.filter((_, idx) => idx !== callIndex);
                                    updateStepInWorkPlan(workPlanIndex, stepIndex, {
                                      ...step,
                                      requiredFunctionCalls: newCalls.length > 0 ? newCalls : undefined
                                    });
                                  }}
                                  deleteIcon={<DeleteIcon />}
                                  disabled={false}
                                  color="primary"
                                  variant="outlined"
                                />
                              ))}
                            </Box>
                          )}

                          <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: 'block' }}>
                            Add functions that must be called before this step can be marked as completed. The same function can be added multiple times.
                          </Typography>
                        </Box>
                      </Box>
                    ))}

                    <Button
                      variant="outlined"
                      startIcon={<AddIcon />}
                      onClick={() => addStepToWorkPlan(workPlanIndex)}
                      disabled={false}
                      size="small"
                      sx={{ mt: 1 }}
                    >
                      Add Step
                    </Button>
                  </CardContent>
                </Card>
              ))}
            </Box>
          )}

          <Typography variant="caption" color="text.secondary" sx={{ mt: 2, display: 'block' }}>
            Predefined work plans can be used to quickly set up structured workflows in Agent Mode. 
            Each step can have a title, optional description, and optional required function calls.
          </Typography>
        </CardContent>
      </Card>
    </Box>
  );
};
