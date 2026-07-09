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
  Collapse,
  Popover,
  ButtonGroup,
  InputAdornment,
  Autocomplete,
  Divider,
  Switch,
} from "@mui/material";
import { format } from "date-fns";
import axios from "axios";
import { useAuth } from "../contexts/AuthContext";
import { buildApiUrl, CUSTOMER_FRONTEND_URL } from "../config";
import { buildAgentRunInspectorUrl } from "../utils/agentRunLinks";
import DOMPurify from "dompurify";
import ImageModelsSettings from "../components/admin/ImageModelsSettings";
import DefaultPromptsSettings from "../components/admin/DefaultPromptsSettings";
import BenchmarksTab from "../components/admin/BenchmarksTab";
import SubscriptionTypesTab from "../components/admin/SubscriptionTypesTab";
import McpServersTab from "../components/admin/McpServersTab";
import EmmaMcpUsageTab from "../components/admin/EmmaMcpUsageTab";
import ResultEndpointsTab from "../components/admin/ResultEndpointsTab";
import ScoringJudgesTab from "../components/admin/ScoringJudgesTab";
import CrmTab from "../components/admin/CrmTab";
import RevenueTab from "../components/admin/RevenueTab";
import FunnelTab from "../components/admin/FunnelTab";
import AlertEmailsTab from "../components/admin/AlertEmailsTab";
import OnboardingTab from "../components/admin/OnboardingTab";
import ConnectedAccountsTab from "../components/admin/ConnectedAccountsTab";
import ContractorsTab from "../components/admin/ContractorsTab";
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
  PlayCircleOutline as PlayCircleOutlineIcon,
  Lock as LockIcon,
  Add as AddIcon,
  ThumbUp as ThumbUpIcon,
  ThumbDown as ThumbDownIcon,
  Sync as SyncIcon,
  Replay as ReplayIcon,
  ExpandMore as ExpandMoreIcon,
  ExpandLess as ExpandLessIcon,
  CreditCard as CreditCardIcon,
  Warning as WarningIcon,
  Cancel as CancelIcon,
  Search as SearchIcon,
  Email as EmailIcon,
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

interface UserNote {
  id: string;
  content: string;
  timestamp: string;
  authorEmail: string;
}

const FUNNEL_STATUS_OPTIONS = [
  { value: "", label: "Unset" },
  { value: "follow_up", label: "Follow-up" },
  { value: "call_booking", label: "Call Booking" },
  { value: "sales_conversation", label: "Sales Conversation" },
  { value: "design_trial", label: "Design Trial" },
  { value: "trial_agreed", label: "Trial Agreed" },
  { value: "account_setup", label: "Account Setup" },
  { value: "activation", label: "Activation" },
  { value: "evaluation_period", label: "Evaluation Period" },
  { value: "decision_day", label: "Decision Day" },
  { value: "payment_conversion", label: "Payment Conversion" },
  { value: "paid_retention_handoff", label: "Paid / Retention Handoff" },
  { value: "parked", label: "Parked" },
] as const;

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
  sessionType?: "regular" | "predefined-work-plan" | "scheduled" | "image-generation" | "video-generation" | "book-generation" | "report_generation" | "result-endpoint";
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
  title?: string;
  llmModel?: string;
  messageCount?: number;
  totalTokens?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  totalCost?: number;
  satisfactionScore?: {
    score: number;
    reason: string;
    evaluatedAt: string;
    evaluatedMessageIndex: number;
    adminOverride?: boolean;
    dimensions?: {
      goalCompletion: number;
      dataAccuracy: number;
      outputQuality: number;
    };
  };
  judgeScores?: Record<string, {
    score: number;
    reason: string;
    evaluatedAt: string;
    evaluatedMessageIndex: number;
    judgeName: string;
    dimensions?: {
      goalCompletion: number;
      dataAccuracy: number;
      outputQuality: number;
    };
  }>;
}

interface User {
  userId: string;
  email: string;
  isAdmin: boolean;
  isActive: boolean;
  createdAt: string;
  lastLoginTime?: string;
  lastActiveAt?: string;
  displayName?: string;
  funnelStatus?: string | null;
  supportNote?: string;
  role?: "partner" | "customer" | "free" | "contractor"; // For single role from API
  roles?: ("partner" | "customer" | "free" | "contractor")[];
  taskCount?: number;
  workflowCount?: number;
  chatSessionCount?: number;
  isOAuthUser?: boolean; // Ensured from API structure
  stripe_customer_id?: string;
  stripe_subscription_id?: string;
  subscription_status?: string; // active, trialing, past_due, canceled, canceling
  has_payment_method?: boolean;
  current_period_end?: string;
  adAccount?: string; // Meta ad account ID
  emailDomain?: string; // Email sender domain
  defaultSenderUsername?: string; // Default sender username (e.g., noreply)
  fromName?: string; // From name for emails
  slackChannel?: string; // @deprecated — use slackChannels
  slackChannels?: string[]; // Slack channels configured for this user
  slackSuggestedRepliesDisabled?: boolean; // When true, suppress Slack suggested-reply monitoring for this user
  secretNames?: string[]; // Names of configured secrets (values not exposed)
  seoDomains?: string[]; // SEO domains to track
  googleAnalyticsPropertyId?: string; // Google Analytics Property ID
  googleAnalyticsProperties?: Array<{ propertyId: string; label: string }>;
  primaryAnalyticsPropertyId?: string;
  clarityProjects?: Array<{ projectId: string; label: string }>;
  gaFilteredDomains?: string[]; // Domains to exclude from Google Analytics
  clarityProjectId?: string; // Microsoft Clarity Project ID
  productDomain?: string; // Product site domain for feature usage tracking
  cmsType?: "Basehub" | "Webflow"; // CMS Type for blog publishing
  subscriptionType?: string; // Subscription type for customer portal users
  tokenUsage?: {
    month: string;
    totalTokens: number;
    totalCost: number;
    resetDate: string;
  };
  tokenUsageHistory?: Array<{
    month: string;
    totalTokens: number;
    totalCost: number;
  }>;
  tokenAllowanceBonus?: number;
  extraCostUsage?: {
    month: string;
    totalCost: number;
    breakdown: Record<string, number>;
    resetDate: string;
  };
  extraCostUsageHistory?: Array<{
    month: string;
    totalCost: number;
    breakdown: Record<string, number>;
  }>;
  googleDriveFolders?: Array<{ folderId: string; name: string }>; // Google Drive shared folders
  introductionEmailSent?: string; // ISO date when team introduction email was sent
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmContent?: string;
  utmTerm?: string;
  orgId?: string;
  orgRole?: "owner" | "member";
  orgName?: string;
  isOrgOwner?: boolean;
  orgShareAnalyticsWithOrg?: boolean;
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

type CrmSyncSource = "users" | "waitlist";

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
                      {msg.role === "assistant" && msg.metadata?.iterationTimings && (
                        <Chip
                          label={`${(msg.metadata.iterationTimings.reduce((sum: number, t: any) => sum + t.llmDurationMs, 0) / 1000).toFixed(1)}s LLM`}
                          size="small"
                          sx={{ fontSize: '0.65rem', height: '18px', ml: 0.5, backgroundColor: 'rgba(25, 118, 210, 0.1)', color: '#1976d2' }}
                        />
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
                                {(() => {
                                  const tc = msg.metadata?.toolCalls?.find((tc: any) => tc.id === toolCall.id || tc.name === (toolCall.function?.name || toolCall.name));
                                  return tc?.duration != null ? (
                                    <span style={{ fontWeight: 'normal', color: '#666', marginLeft: '8px' }}>
                                      {(tc.duration / 1000).toFixed(1)}s
                                    </span>
                                  ) : null;
                                })()}
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

                      {/* Display iteration timing breakdown */}
                      {msg.role === "assistant" && msg.metadata?.iterationTimings?.length > 0 && (
                        <Box sx={{ mt: 1, p: 1, backgroundColor: 'rgba(25, 118, 210, 0.04)', borderRadius: 1 }}>
                          <Typography variant="caption" color="text.secondary" sx={{ fontWeight: "bold" }}>
                            Timing ({msg.metadata.iterationTimings.length} iteration{msg.metadata.iterationTimings.length > 1 ? 's' : ''}):
                          </Typography>
                          {msg.metadata.iterationTimings.map((timing: any, i: number) => (
                            <Typography key={i} variant="caption" component="div" sx={{ ml: 1, color: 'text.secondary' }}>
                              Iter {timing.iteration}: {(timing.llmDurationMs / 1000).toFixed(1)}s LLM
                              {timing.toolNames?.length > 0 && ` → ${timing.toolNames.join(', ')}`}
                            </Typography>
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
    'result-endpoints': 14,
    'scoring-judges': 15,
    'crm': 16,
    'revenue': 17,
    'funnel': 18,
    'alert-emails': 19,
    'onboarding': 20,
    'connected-accounts': 21,
    'contractors': 22,
    'emma-mcp': 23,
  };
  
  // Get initial tab value from URL or default to Users
  const getInitialTabValue = () => {
    const tabParam = searchParams.get('tab');
    return tabParam && TAB_MAP[tabParam as keyof typeof TAB_MAP] !== undefined 
      ? TAB_MAP[tabParam as keyof typeof TAB_MAP] 
      : TAB_MAP.users;
  };
  
  const [tabValue, setTabValue] = useState(getInitialTabValue());
  const [toolCallsExpanded, setToolCallsExpanded] = useState(false);
  const [startDate, setStartDate] = useState<Date | null>(
    new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
  );
  const [endDate, setEndDate] = useState<Date | null>(new Date());
  const [tasks, setTasks] = useState<AdminTask[]>([]);
  const [orderBy, setOrderBy] = useState<string>("latestRunTime");
  const [order, setOrder] = useState<"asc" | "desc">("desc");
  const [usersOrderBy, setUsersOrderBy] = useState<keyof User>("createdAt");
  const [usersOrder, setUsersOrder] = useState<"asc" | "desc">("desc");
  // User filters
  const [userSearchQuery, setUserSearchQuery] = useState("");
  const [userFilterStatus, setUserFilterStatus] = useState<"active" | "inactive" | "all">("active");
  const [userFilterTier, setUserFilterTier] = useState<string>("all");
  const [userFilterPaid, setUserFilterPaid] = useState<"all" | "paid" | "unpaid" | "bounced">("all");
  const [userFilterHasUsage, setUserFilterHasUsage] = useState(false);
  const [userFilterHideBotLike, setUserFilterHideBotLike] = useState(true);
  const [expandedUserId, setExpandedUserId] = useState<string | null>(null);
  const [userActivities, setUserActivities] = useState<Record<string, Array<{ sessionId: string; title: string; createdAt: string; updatedAt: string; portalType?: string; sessionType?: string; delegateInfo?: { adminEmail: string; isDelegated: boolean }; }>>>({});
  const [userActivitiesLoading, setUserActivitiesLoading] = useState<Record<string, boolean>>({});
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
  const [chatSessionIdSearch, setChatSessionIdSearch] = useState("");
  const [chatUserFilter, setChatUserFilter] = useState("");
  const [selectedSession, setSelectedSession] =
    useState<AdminChatSession | null>(null);
  const [chatDialogOpen, setChatDialogOpen] = useState(false);
  const [scoringSessionIds, setScoringSessionIds] = useState<Set<string>>(new Set());
  const [failedScoringIds, setFailedScoringIds] = useState<Set<string>>(new Set());
  const [scoringJudges, setScoringJudges] = useState<Array<{ id: string; name: string; systemPrompt: string }>>([]);
  const [selectedJudgeId, setSelectedJudgeId] = useState<string>("");
  const [scoreOverrideAnchor, setScoreOverrideAnchor] = useState<HTMLElement | null>(null);
  const [scoreOverrideSession, setScoreOverrideSession] = useState<AdminChatSession | null>(null);
  const [scoreOverrideValue, setScoreOverrideValue] = useState<number>(3);
  const [scoreOverrideReason, setScoreOverrideReason] = useState("");
  const [roleDialogOpen, setRoleDialogOpen] = useState(false);
  const [selectedUserRoles, setSelectedUserRoles] = useState<
    ("partner" | "customer" | "free" | "contractor")[]
  >([]);
  const [editingNoteEmail, setEditingNoteEmail] = useState<string | null>(null);
  const [currentNoteText, setCurrentNoteText] = useState("");
  const [noteEditLoading, setNoteEditLoading] = useState(false);
  const [editingSupportNoteUserId, setEditingSupportNoteUserId] = useState<string | null>(null);
  const [currentSupportNoteText, setCurrentSupportNoteText] = useState("");
  const [supportNoteEditLoading, setSupportNoteEditLoading] = useState(false);
  const [funnelStatusSavingUserId, setFunnelStatusSavingUserId] = useState<string | null>(null);
  const [userNotesMap, setUserNotesMap] = useState<Record<string, UserNote[]>>({});
  const [userNotesLoading, setUserNotesLoading] = useState<Record<string, boolean>>({});
  const [newNoteText, setNewNoteText] = useState<Record<string, string>>({});
  const [addingNoteLoading, setAddingNoteLoading] = useState<Record<string, boolean>>({});
  const [editingAdAccountUserId, setEditingAdAccountUserId] = useState<string | null>(null);
  const [currentAdAccountText, setCurrentAdAccountText] = useState("");
  const [adAccountEditLoading, setAdAccountEditLoading] = useState(false);
  const [editingStripeCustomerIdUserId, setEditingStripeCustomerIdUserId] = useState<string | null>(null);
  const [currentStripeCustomerIdText, setCurrentStripeCustomerIdText] = useState("");
  const [resyncPaymentsLoading, setResyncPaymentsLoading] = useState(false);
  const [stripeCustomerIdEditLoading, setStripeCustomerIdEditLoading] = useState(false);
  const [syncStripeLoadingUserId, setSyncStripeLoadingUserId] = useState<string | null>(null);
  const [editingEmailUserId, setEditingEmailUserId] = useState<string | null>(null);
  const [currentEmailText, setCurrentEmailText] = useState("");
  const [emailEditLoading, setEmailEditLoading] = useState(false);
  const [editingNameUserId, setEditingNameUserId] = useState<string | null>(null);
  const [currentDisplayName, setCurrentDisplayName] = useState("");
  const [nameEditLoading, setNameEditLoading] = useState(false);
  const [emailSenderDialogOpen, setEmailSenderDialogOpen] = useState(false);
  const [editingEmailSenderUserId, setEditingEmailSenderUserId] = useState<string | null>(null);
  const [emailDomain, setEmailDomain] = useState("");
  const [defaultSenderUsername, setDefaultSenderUsername] = useState("");
  const [fromName, setFromName] = useState("");
  const [emailSenderEditLoading, setEmailSenderEditLoading] = useState(false);
  const [slackChannelDialogOpen, setSlackChannelDialogOpen] = useState(false);
  const [editingSlackChannelUserId, setEditingSlackChannelUserId] = useState<string | null>(null);
  const [currentSlackChannels, setCurrentSlackChannels] = useState<string[]>([]);
  const [slackChannelNames, setSlackChannelNames] = useState<Record<string, string>>({});
  const [slackChannelInputText, setSlackChannelInputText] = useState("");
  const [slackChannelEditLoading, setSlackChannelEditLoading] = useState(false);
  const [adminSlackChannels, setAdminSlackChannels] = useState<string[]>([]);
  const [adminSlackChannelsInput, setAdminSlackChannelsInput] = useState<string[]>([]);
  const [adminSlackChannelLoading, setAdminSlackChannelLoading] = useState(false);
  const [adminSlackChannelSaved, setAdminSlackChannelSaved] = useState(false);
  const [availableSlackChannels, setAvailableSlackChannels] = useState<{ id: string; name: string }[]>([]);
  const [availableSlackChannelsLoading, setAvailableSlackChannelsLoading] = useState(false);
  const [secretsDialogOpen, setSecretsDialogOpen] = useState(false);
  const [editingSecretsUserId, setEditingSecretsUserId] = useState<string | null>(null);
  const [secretEntries, setSecretEntries] = useState<Array<{ name: string; value: string }>>([]);
  const [secretsEditLoading, setSecretsEditLoading] = useState(false);
  const [seoDomainsDialogOpen, setSeoDomainsDialogOpen] = useState(false);
  const [editingSeoDomainsUserId, setEditingSeoDomainsUserId] = useState<string | null>(null);
  const [seoDomainsText, setSeoDomainsText] = useState("");
  const [googleAnalyticsPropertyId, setGoogleAnalyticsPropertyId] = useState("");
  const [googleAnalyticsProperties, setGoogleAnalyticsProperties] = useState<Array<{ propertyId: string; label: string }>>([]);
  const [shareAnalyticsWithOrg, setShareAnalyticsWithOrg] = useState(false);
  const [editingUserIsOrgOwner, setEditingUserIsOrgOwner] = useState(false);
  const [editingUserOrgId, setEditingUserOrgId] = useState<string | null>(null);
  const [gaFilteredDomainsText, setGaFilteredDomainsText] = useState("");
  const [clarityProjectId, setClarityProjectId] = useState("");
  const [clarityProjects, setClarityProjects] = useState<Array<{ projectId: string; label: string }>>([]);
  const [productDomain, setProductDomain] = useState("");
  const [primaryAnalyticsPropertyId, setPrimaryAnalyticsPropertyId] = useState("");
  const [seoAeoDialogLoading, setSeoAeoDialogLoading] = useState(false);
  const [seoDomainsEditLoading, setSeoDomainsEditLoading] = useState(false);
  const [editingCmsTypeUserId, setEditingCmsTypeUserId] = useState<string | null>(null);
  const [currentCmsType, setCurrentCmsType] = useState<"Basehub" | "Webflow" | "">("");
  const [cmsTypeEditLoading, setCmsTypeEditLoading] = useState(false);
  const [editingSubscriptionTypeUserId, setEditingSubscriptionTypeUserId] = useState<string | null>(null);
  const [currentSubscriptionType, setCurrentSubscriptionType] = useState<string>("");
  const [subscriptionTypeEditLoading, setSubscriptionTypeEditLoading] = useState(false);
  const [availableSubscriptionTypes, setAvailableSubscriptionTypes] = useState<string[]>([]);
  const [subscriptionTypeAllowanceMap, setSubscriptionTypeAllowanceMap] = useState<Record<string, number | null>>({});
  const [grantBonusDialogOpen, setGrantBonusDialogOpen] = useState(false);
  const [grantBonusUserId, setGrantBonusUserId] = useState<string | null>(null);
  const [grantBonusEmail, setGrantBonusEmail] = useState("");
  const [grantBonusAmount, setGrantBonusAmount] = useState("");
  const [grantBonusLoading, setGrantBonusLoading] = useState(false);
  const [introEmailDialogOpen, setIntroEmailDialogOpen] = useState(false);
  const [introEmailUserId, setIntroEmailUserId] = useState<string | null>(null);
  const [introEmailUserEmail, setIntroEmailUserEmail] = useState("");
  const [introEmailLoading, setIntroEmailLoading] = useState(false);
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
  const [googleDriveFoldersDialogOpen, setGoogleDriveFoldersDialogOpen] = useState(false);
  const [editingGoogleDriveFoldersUserId, setEditingGoogleDriveFoldersUserId] = useState<string | null>(null);
  const [googleDriveFolderEntries, setGoogleDriveFolderEntries] = useState<Array<{ folderId: string; name: string }>>([]);
  const [googleDriveFoldersEditLoading, setGoogleDriveFoldersEditLoading] = useState(false);
  const [availableGoogleDriveFolders, setAvailableGoogleDriveFolders] = useState<Array<{ folderId: string; name: string }>>([]);
  const [googleDriveFoldersListLoading, setGoogleDriveFoldersListLoading] = useState(false);

  // Edit Waitlist Dialog state
  const [editWaitlistDialogOpen, setEditWaitlistDialogOpen] = useState(false);
  const [editWaitlistData, setEditWaitlistData] = useState<WaitlistEntry | null>(null);
  const [editWaitlistLoading, setEditWaitlistLoading] = useState(false);

  const { token, user, setToken } = useAuth();

  const {
    users: contextUsers,
    waitlist,
    taskAnalytics,
    userAnalytics,
    agentModeAnalytics,
    gtmAnalytics,
    crmAnalytics,
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
  const [crmSyncDialogOpen, setCrmSyncDialogOpen] = useState(false);
  const [crmSyncSource, setCrmSyncSource] = useState<CrmSyncSource>("users");
  const [crmSyncListId, setCrmSyncListId] = useState("");
  const [crmSyncLastSyncAt, setCrmSyncLastSyncAt] = useState<string | null>(null);
  const [crmSyncLoading, setCrmSyncLoading] = useState(false);
  const [crmSyncSaving, setCrmSyncSaving] = useState(false);
  const [crmSyncRunning, setCrmSyncRunning] = useState(false);
  const [crmSyncForceFull, setCrmSyncForceFull] = useState(false);
  const [crmSyncAutoSync, setCrmSyncAutoSync] = useState(false);

  // Load users data only when Users tab (2) is selected
  useEffect(() => {
    if (tabValue === 2) {
      loadUsers(userFilterHideBotLike);
      loadSubscriptionTypes();
      // Load admin Slack channels setting (multi-channel)
      axios.get(buildApiUrl('/api/settings/slack_admin_channels'), {
        headers: { Authorization: `Bearer ${token}` },
      }).then((res) => {
        try {
          const ids: string[] = JSON.parse(res.data?.settingValue || '[]');
          setAdminSlackChannels(ids);
          setAdminSlackChannelsInput(ids);
        } catch {
          setAdminSlackChannels([]);
          setAdminSlackChannelsInput([]);
        }
      }).catch(() => {
        // Setting not found — leave empty
      });
      // Fetch available Slack channels for dropdown
      setAvailableSlackChannelsLoading(true);
      axios.get(buildApiUrl('/api/slack/channels'), {
        headers: { Authorization: `Bearer ${token}` },
      }).then((res) => {
        setAvailableSlackChannels((res.data || []).map((ch: any) => ({ id: ch.id, name: ch.name })));
      }).catch(() => {
        setAvailableSlackChannels([]);
      }).finally(() => {
        setAvailableSlackChannelsLoading(false);
      });
    }
  }, [tabValue]);

  // Resolve Slack channel names for all users whenever users list loads
  useEffect(() => {
    const allChannelIds = Array.from(new Set(
      contextUsers.flatMap((u: User) =>
        u.slackChannels && u.slackChannels.length > 0
          ? u.slackChannels
          : u.slackChannel ? [u.slackChannel] : []
      )
    ));
    if (allChannelIds.length > 0) {
      resolveSlackChannelNames(allChannelIds);
    }
  }, [contextUsers]);

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
      const allowanceMap: Record<string, number | null> = {};
      types.forEach((t: any) => { allowanceMap[t.name] = t.monthlyTokenAllowance ?? null; });
      setSubscriptionTypeAllowanceMap(allowanceMap);
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
      loadUsers(userFilterHideBotLike); // Also load users to check if waitlist entries are registered
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
    async (options?: { reset?: boolean; sessionIdOverride?: string; userFilterOverride?: string }) => {
      if (!token || chatSessionsLoading) {
        return;
      }

      const shouldReset = options?.reset ?? false;
      const cursor = shouldReset ? null : chatSessionsCursor;
      const searchId = options?.sessionIdOverride !== undefined
        ? options.sessionIdOverride
        : chatSessionIdSearch;
      const userFilter = options?.userFilterOverride !== undefined
        ? options.userFilterOverride
        : chatUserFilter;

      try {
        setChatSessionsLoading(true);
        const params = new URLSearchParams();
        if (searchId.trim()) {
          params.set("sessionId", searchId.trim());
        } else if (userFilter.trim()) {
          // Determine if input looks like a userId (UUID) or email
          const trimmed = userFilter.trim();
          if (trimmed.includes("@")) {
            params.set("userEmail", trimmed);
          } else {
            params.set("userId", trimmed);
          }
          params.set("limit", "30");
          if (cursor) {
            params.set("cursor", cursor);
          }
        } else {
          params.set("limit", "30");
          if (cursor) {
            params.set("cursor", cursor);
          }
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

        const isSessionIdSearch = Boolean(searchId.trim());
        setChatSessions((prev) => {
          if (shouldReset || isSessionIdSearch) {
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
    [token, chatSessionsCursor, chatSessionsLoading, chatSessionIdSearch, chatUserFilter]
  );

  useEffect(() => {
    if (tabValue === 6 && !chatSessionsInitialized) {
      loadChatSessions({ reset: true });
    }
    // Fetch scoring judges when chat history tab is loaded
    if (tabValue === 6 && token && scoringJudges.length === 0) {
      axios.get(buildApiUrl('/api/settings/scoring-judges'), {
        headers: { Authorization: `Bearer ${token}` },
      }).then((res) => {
        setScoringJudges(res.data.judges || []);
      }).catch(() => {});
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

  // Trigger satisfaction scoring for sessions that need it
  useEffect(() => {
    if (!token || chatSessions.length === 0) return;

    const needsScoring = chatSessions.filter((s) => {
      if (scoringSessionIds.has(s.sessionId)) return false;
      if (failedScoringIds.has(s.sessionId)) return false;
      if (s.satisfactionScore?.adminOverride) return false;
      const msgCount = s.messageCount ?? s.messages?.length ?? 0;
      if (msgCount < 2) return false; // Need at least 1 user + 1 assistant message
      if (s.satisfactionScore && s.satisfactionScore.evaluatedMessageIndex >= msgCount) return false;
      return true;
    });

    if (needsScoring.length === 0) return;

    // Batch into groups of 5
    const batches: string[][] = [];
    for (let i = 0; i < needsScoring.length; i += 5) {
      batches.push(needsScoring.slice(i, i + 5).map((s) => s.sessionId));
    }

    const scoreBatches = async () => {
      // Mark all as in-flight
      setScoringSessionIds((prev) => {
        const next = new Set(prev);
        needsScoring.forEach((s) => next.add(s.sessionId));
        return next;
      });

      for (const batch of batches) {
        try {
          const response = await axios.post(
            buildApiUrl("/api/admin/chat-sessions/score"),
            { sessionIds: batch },
            { headers: { Authorization: `Bearer ${token}` }, timeout: 30000 }
          );
          const { scores, failed = [] } = response.data as {
            scores: Record<string, AdminChatSession["satisfactionScore"] | null>;
            failed?: string[];
          };
          setChatSessions((prev) =>
            prev.map((s) => {
              const newScore = scores[s.sessionId];
              if (newScore) return { ...s, satisfactionScore: newScore };
              return s;
            })
          );
          // Remove entire batch from scoring state
          setScoringSessionIds((prev) => {
            const next = new Set(prev);
            batch.forEach((id) => next.delete(id));
            return next;
          });
          // Mark sessions that didn't get a score as failed (retryable)
          const noResult = batch.filter((id) => !scores[id] && !failed.includes(id));
          const allFailed = [...failed, ...noResult];
          if (allFailed.length > 0) {
            setFailedScoringIds((prev) => {
              const next = new Set(prev);
              allFailed.forEach((id) => next.add(id));
              return next;
            });
          }
        } catch (error) {
          console.error("Error scoring sessions:", error);
          // Mark entire batch as failed
          setFailedScoringIds((prev) => {
            const next = new Set(prev);
            batch.forEach((id) => next.add(id));
            return next;
          });
          setScoringSessionIds((prev) => {
            const next = new Set(prev);
            batch.forEach((id) => next.delete(id));
            return next;
          });
        }
      }
    };

    scoreBatches();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatSessions.length, token]);

  const handleScoreOverrideSave = async () => {
    if (!scoreOverrideSession || !token) return;
    try {
      const response = await axios.put(
        buildApiUrl(`/api/admin/chat-sessions/${scoreOverrideSession.sessionId}/score`),
        { score: scoreOverrideValue, reason: scoreOverrideReason || undefined },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const { satisfactionScore } = response.data;
      setChatSessions((prev) =>
        prev.map((s) =>
          s.sessionId === scoreOverrideSession.sessionId
            ? { ...s, satisfactionScore }
            : s
        )
      );
      setScoreOverrideAnchor(null);
      setScoreOverrideSession(null);
    } catch (error) {
      console.error("Error saving score override:", error);
    }
  };

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

  const loadCrmSyncConfig = async (source: CrmSyncSource) => {
    try {
      setCrmSyncLoading(true);
      const response = await axios.get(buildApiUrl(`/api/admin/crm-sync/${source}`), {
        headers: { Authorization: `Bearer ${token}` },
      });
      setCrmSyncListId(response.data?.listId || "");
      setCrmSyncLastSyncAt(response.data?.lastSyncAt || null);
      setCrmSyncAutoSync(response.data?.autoSync || false);
    } catch (err: any) {
      console.error("Error loading CRM sync config:", err);
      setError(err.response?.data?.message || "Failed to load CRM sync configuration");
    } finally {
      setCrmSyncLoading(false);
    }
  };

  const handleOpenCrmSyncDialog = async (source: CrmSyncSource) => {
    setCrmSyncSource(source);
    setCrmSyncForceFull(false);
    setCrmSyncDialogOpen(true);
    await loadCrmSyncConfig(source);
  };

  const handleSaveCrmSyncConfig = async () => {
    try {
      setCrmSyncSaving(true);
      await axios.put(
        buildApiUrl(`/api/admin/crm-sync/${crmSyncSource}`),
        { listId: crmSyncListId.trim(), autoSync: crmSyncAutoSync },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      setSuccess(`CRM sync configuration saved for ${crmSyncSource}.`);
      await loadCrmSyncConfig(crmSyncSource);
    } catch (err: any) {
      console.error("Error saving CRM sync config:", err);
      setError(err.response?.data?.message || "Failed to save CRM sync configuration");
    } finally {
      setCrmSyncSaving(false);
    }
  };

  const handleStartCrmSync = async () => {
    try {
      setCrmSyncRunning(true);
      // Save config (including autoSync) before starting sync
      await axios.put(
        buildApiUrl(`/api/admin/crm-sync/${crmSyncSource}`),
        { listId: crmSyncListId.trim(), autoSync: crmSyncAutoSync },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const response = await axios.post(
        buildApiUrl(`/api/admin/crm-sync/${crmSyncSource}/start`),
        { forceFullSync: crmSyncForceFull },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      setCrmSyncLastSyncAt(response.data?.lastSyncAt || null);
      setSuccess(response.data?.message || `CRM sync started for ${crmSyncSource}.`);
      await loadCrmSyncConfig(crmSyncSource);
    } catch (err: any) {
      console.error("Error starting CRM sync:", err);
      setError(err.response?.data?.message || "Failed to start CRM sync");
    } finally {
      setCrmSyncRunning(false);
    }
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
        return (user.lastActiveAt || user.lastLoginTime) ? new Date(user.lastActiveAt || user.lastLoginTime!).getTime() : 0;
      case "chatSessionCount":
        return user.chatSessionCount ?? 0;
      case "taskCount":
        return user.taskCount ?? 0;
      case "workflowCount":
        return user.workflowCount ?? 0;
      case "roles":
        return (user.roles ?? []).join(",");
      case "secretNames":
        return (user.secretNames ?? []).join(",");
      case "seoDomains":
        return (user.seoDomains ?? []).join(",");
      case "googleDriveFolders":
        return (user.googleDriveFolders ?? []).map(f => f.name).join(",");
      case "isOAuthUser":
        return user.isOAuthUser ? 1 : 0;
      case "isAdmin":
        return user.isAdmin ? 1 : 0;
      case "isActive":
        return user.isActive === false ? 0 : 1;
      case "tokenUsage":
        return user.tokenUsage?.month === new Date().toISOString().slice(0, 7)
          ? (user.tokenUsage?.totalTokens || 0) : 0;
      default:
        return (user as unknown as Record<string, unknown>)[property] ?? "";
    }
  };

  const sortedUsers = React.useMemo(() => {
    const filtered = contextUsers.filter((user) => {
      // Search filter
      if (userSearchQuery) {
        const q = userSearchQuery.toLowerCase();
        const matchEmail = user.email?.toLowerCase().includes(q);
        const matchNote = user.supportNote?.toLowerCase().includes(q);
        const matchId = user.userId?.toLowerCase().includes(q);
        if (!matchEmail && !matchNote && !matchId) return false;
      }
      // Status filter
      if (userFilterStatus === "active" && user.isActive === false) return false;
      if (userFilterStatus === "inactive" && user.isActive !== false) return false;
      // Tier filter
      if (userFilterTier !== "all") {
        const tier = user.subscriptionType || (user.roles?.includes("customer") ? "Basic" : "");
        if (userFilterTier === "none" && tier) return false;
        if (userFilterTier !== "none" && tier !== userFilterTier) return false;
      }
      // Paid filter
      if (userFilterPaid === "paid" && user.subscription_status !== "active") return false;
      if (userFilterPaid === "unpaid" && user.subscription_status === "active") return false;
      if (userFilterPaid === "bounced" && !(user.stripe_customer_id && !user.subscription_status && !user.subscription_amount)) return false;
      // Has-usage filter — match the display logic: current-month tokens only
      if (userFilterHasUsage) {
        const currentMonth = new Date().toISOString().slice(0, 7);
        const used = user.tokenUsage?.month === currentMonth ? (user.tokenUsage?.totalTokens || 0) : 0;
        if (used <= 0) return false;
      }
      return true;
    });
    return filtered.sort((a, b) => {
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
  }, [contextUsers, usersOrder, usersOrderBy, userSearchQuery, userFilterStatus, userFilterTier, userFilterPaid, userFilterHasUsage]);

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
      await loadUsers(userFilterHideBotLike); // Reload users list
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
        await loadUsers(userFilterHideBotLike); // Ensure user list is refreshed
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

  const handleRoleCheckboxChange = (role: "partner" | "customer" | "free" | "contractor") => {
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

  const loadUserNotes = async (userId: string) => {
    setUserNotesLoading((prev) => ({ ...prev, [userId]: true }));
    try {
      const response = await axios.get(buildApiUrl(`/api/admin/users/${userId}/notes`), {
        headers: { Authorization: `Bearer ${token}` },
      });
      setUserNotesMap((prev) => ({ ...prev, [userId]: response.data.notes || [] }));
    } catch (error: any) {
      console.error("Error loading user notes:", error);
      setError(error.response?.data?.message || "Failed to load user notes");
    } finally {
      setUserNotesLoading((prev) => ({ ...prev, [userId]: false }));
    }
  };

  const handleAddUserNote = async (userId: string) => {
    const content = (newNoteText[userId] || "").trim();
    if (!content) return;
    setAddingNoteLoading((prev) => ({ ...prev, [userId]: true }));
    try {
      const response = await axios.post(
        buildApiUrl(`/api/admin/users/${userId}/notes`),
        { content },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      setUserNotesMap((prev) => ({ ...prev, [userId]: response.data.notes || [] }));
      setNewNoteText((prev) => ({ ...prev, [userId]: "" }));
      if (response.data.warning) setSuccess(response.data.warning);
    } catch (error: any) {
      console.error("Error adding user note:", error);
      setError(error.response?.data?.message || "Failed to add note");
    } finally {
      setAddingNoteLoading((prev) => ({ ...prev, [userId]: false }));
    }
  };

  const handleDeleteUserNote = async (userId: string, noteId: string) => {
    try {
      const response = await axios.delete(buildApiUrl(`/api/admin/users/${userId}/notes/${noteId}`), {
        headers: { Authorization: `Bearer ${token}` },
      });
      setUserNotesMap((prev) => ({ ...prev, [userId]: response.data.notes || [] }));
    } catch (error: any) {
      console.error("Error deleting user note:", error);
      setError(error.response?.data?.message || "Failed to delete note");
    }
  };

  const handleSaveFunnelStatus = async (userId: string, funnelStatus: string) => {
    try {
      setFunnelStatusSavingUserId(userId);
      const response = await axios.put(
        buildApiUrl(`/api/admin/users/${userId}/funnel-status`),
        { funnelStatus: funnelStatus || null },
        { headers: { Authorization: `Bearer ${token}` } }
      );

      if (response.status === 200) {
        setUsers((prevUsers: User[]) =>
          prevUsers.map((user: User) =>
            user.userId === userId
              ? { ...user, funnelStatus: response.data.funnelStatus ?? null }
              : user
          )
        );
        setSuccess("Funnel status updated successfully!");
      }
    } catch (error: any) {
      console.error("Error updating funnel status:", error);
      setError(error.response?.data?.message || "Failed to update funnel status");
    } finally {
      setFunnelStatusSavingUserId(null);
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

  const handleResyncPayments = async () => {
    try {
      setResyncPaymentsLoading(true);
      const response = await axios.post(
        buildApiUrl("/api/admin/resync-subscription-amounts"),
        {},
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const { checked, updated, reconciled, skipped, errors } = response.data;
      setSuccess(`Payments resynced: ${updated} amounts updated, ${reconciled ?? 0} statuses reconciled, ${skipped} skipped, ${errors} errors (${checked} total checked)`);
    } catch (err: any) {
      setError(err.response?.data?.message || "Failed to resync payments");
    } finally {
      setResyncPaymentsLoading(false);
    }
  };

  const handleSaveStripeCustomerId = async (userId: string) => {
    try {
      setStripeCustomerIdEditLoading(true);

      const stripeId = currentStripeCustomerIdText.trim();
      if (stripeId && !stripeId.startsWith("cus_")) {
        setError("Stripe Customer ID must start with 'cus_'");
        return;
      }

      const response = await axios.put(
        buildApiUrl(`/api/admin/users/${userId}/stripe-customer-id`),
        { stripeCustomerId: stripeId },
        {
          headers: { Authorization: `Bearer ${token}` }
        }
      );

      if (response.status === 200) {
        setUsers((prevUsers: User[]) =>
          prevUsers.map((user: User) =>
            user.userId === userId
              ? { ...user, stripe_customer_id: response.data.stripe_customer_id }
              : user
          )
        );
        setSuccess("Stripe Customer ID updated successfully!");
        setEditingStripeCustomerIdUserId(null);
        setCurrentStripeCustomerIdText("");
      }
    } catch (error: any) {
      console.error("Error updating Stripe Customer ID:", error);
      setError(error.response?.data?.message || "Failed to update Stripe Customer ID");
    } finally {
      setStripeCustomerIdEditLoading(false);
    }
  };

  const handleSyncStripe = async (userId: string) => {
    try {
      setSyncStripeLoadingUserId(userId);
      const response = await axios.post(
        buildApiUrl(`/api/admin/users/${userId}/sync-stripe`),
        {},
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const updatedUser = response.data.user;
      if (updatedUser) {
        setUsers((prevUsers: User[]) =>
          prevUsers.map((u: User) => u.userId === userId ? { ...u, ...updatedUser } : u)
        );
      }
      const updates = response.data.updates;
      if (updates && Object.keys(updates).length > 0) {
        setSuccess(`Stripe synced: updated ${Object.keys(updates).join(", ")}`);
      } else {
        setSuccess("Stripe sync complete — no new data found");
      }
    } catch (error: any) {
      setError(error.response?.data?.message || "Failed to sync Stripe subscription");
    } finally {
      setSyncStripeLoadingUserId(null);
    }
  };

  const handleSaveContactEmail = async (userId: string) => {
    const newEmail = currentEmailText.trim();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(newEmail)) {
      setError("Invalid email format");
      return;
    }
    if (!window.confirm(`Change login email to "${newEmail}"? The user will need to use this new email to sign in.`)) {
      return;
    }
    try {
      setEmailEditLoading(true);
      const response = await axios.put(
        buildApiUrl(`/api/admin/users/${userId}/email`),
        { newEmail },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (response.status === 200) {
        setUsers((prevUsers: User[]) =>
          prevUsers.map((u: User) =>
            u.userId === userId ? { ...u, email: response.data.email } : u
          )
        );
        setSuccess("Contact email updated successfully!");
        setEditingEmailUserId(null);
        setCurrentEmailText("");
      }
    } catch (error: any) {
      console.error("Error updating contact email:", error);
      setError(error.response?.data?.message || "Failed to update contact email");
    } finally {
      setEmailEditLoading(false);
    }
  };

  const handleSaveName = async (userId: string) => {
    try {
      setNameEditLoading(true);
      const response = await axios.put(
        buildApiUrl(`/api/admin/users/${userId}/name`),
        { displayName: currentDisplayName.trim() || null },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (response.status === 200) {
        setUsers((prevUsers: User[]) =>
          prevUsers.map((u: User) =>
            u.userId === userId
              ? { ...u, displayName: response.data.displayName }
              : u
          )
        );
        setSuccess("Display name updated successfully!");
        setEditingNameUserId(null);
        setCurrentDisplayName("");
      }
    } catch (error: any) {
      console.error("Error updating display name:", error);
      setError(error.response?.data?.message || "Failed to update display name");
    } finally {
      setNameEditLoading(false);
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

  const resolveSlackChannelNames = async (channelIds: string[]) => {
    const unresolved = channelIds.filter((id) => !slackChannelNames[id]);
    if (unresolved.length === 0) return;
    const results: Record<string, string> = {};
    await Promise.all(
      unresolved.map(async (id) => {
        try {
          const res = await axios.get(
            buildApiUrl(`/api/admin/slack/channel-info?channelId=${encodeURIComponent(id)}`),
            { headers: { Authorization: `Bearer ${token}` } }
          );
          results[id] = res.data.displayName || res.data.name || id;
        } catch {
          results[id] = id;
        }
      })
    );
    setSlackChannelNames((prev) => ({ ...prev, ...results }));
  };

  const handleSaveSlackChannel = async () => {
    if (!editingSlackChannelUserId) return;

    try {
      setSlackChannelEditLoading(true);

      // If admin typed a channel ID in the input field but didn't click Add, include it automatically
      const pendingInput = slackChannelInputText.trim();
      const channelsToSave =
        pendingInput && !currentSlackChannels.includes(pendingInput)
          ? [...currentSlackChannels, pendingInput]
          : currentSlackChannels;

      const response = await axios.put(
        buildApiUrl(`/api/admin/users/${editingSlackChannelUserId}/slack-channel`),
        { slackChannels: channelsToSave },
        { headers: { Authorization: `Bearer ${token}` } }
      );

      if (response.status === 200) {
        // Update the user in the local state without reloading
        setUsers((prevUsers: User[]) =>
          prevUsers.map((user: User) =>
            user.userId === editingSlackChannelUserId
              ? { ...user, slackChannels: response.data.slackChannels ?? [] }
              : user
          )
        );
        setSuccess("Slack channels updated successfully!");
        setSlackChannelDialogOpen(false);
        setEditingSlackChannelUserId(null);
        setCurrentSlackChannels([]);
        setSlackChannelInputText("");
      }
    } catch (error: any) {
      console.error("Error updating slack channel:", error);
      setError(error.response?.data?.message || "Failed to update slack channel");
    } finally {
      setSlackChannelEditLoading(false);
    }
  };

  // Toggle Slack suggested-reply monitoring for a user. `enabled` true = suggestions on.
  const handleToggleSlackSuggestedReplies = async (userId: string, enabled: boolean) => {
    // Optimistically reflect the change so the switch responds immediately.
    setUsers((prevUsers: User[]) =>
      prevUsers.map((user: User) =>
        user.userId === userId ? { ...user, slackSuggestedRepliesDisabled: !enabled } : user
      )
    );
    try {
      const response = await axios.put(
        buildApiUrl(`/api/admin/users/${userId}/slack-suggested-replies`),
        { enabled },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      setUsers((prevUsers: User[]) =>
        prevUsers.map((user: User) =>
          user.userId === userId
            ? { ...user, slackSuggestedRepliesDisabled: response.data.slackSuggestedRepliesDisabled ?? !enabled }
            : user
        )
      );
      setSuccess(`Slack suggested replies ${enabled ? "enabled" : "disabled"} successfully!`);
    } catch (error: any) {
      console.error("Error updating slack suggested replies setting:", error);
      setError(error.response?.data?.message || "Failed to update slack suggested replies setting");
      // Revert optimistic update on failure.
      setUsers((prevUsers: User[]) =>
        prevUsers.map((user: User) =>
          user.userId === userId ? { ...user, slackSuggestedRepliesDisabled: enabled } : user
        )
      );
    }
  };

  const handleSaveAdminSlackChannel = async () => {
    try {
      setAdminSlackChannelLoading(true);
      await axios.post(
        buildApiUrl('/api/settings'),
        {
          settingName: 'slack_admin_channels',
          settingValue: JSON.stringify(adminSlackChannelsInput),
          description: 'Admin Slack channel IDs for delegated Emma access'
        },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      setAdminSlackChannels(adminSlackChannelsInput);
      setAdminSlackChannelSaved(true);
      setTimeout(() => setAdminSlackChannelSaved(false), 3000);
    } catch (error: any) {
      console.error("Error saving admin Slack channels:", error);
      setError(error.response?.data?.message || "Failed to save admin Slack channels");
    } finally {
      setAdminSlackChannelLoading(false);
    }
  };

  const handleSaveSecrets = async () => {
    if (!editingSecretsUserId) return;

    setError("");
    try {
      setSecretsEditLoading(true);

      // Validate key names
      const keyRegex = /^[a-zA-Z0-9_]+$/;
      const secrets: Record<string, string> = {};
      for (const entry of secretEntries) {
        const name = entry.name.trim();
        if (!name) continue; // Skip empty rows
        if (!keyRegex.test(name)) {
          setError(`Invalid secret name: "${name}". Only alphanumeric characters and underscores are allowed.`);
          return;
        }
        secrets[name] = entry.value; // Empty string = keep existing
      }

      const response = await axios.put(
        buildApiUrl(`/api/admin/users/${editingSecretsUserId}/secrets`),
        { secrets },
        { headers: { Authorization: `Bearer ${token}` } }
      );

      if (response.status === 200) {
        setUsers((prevUsers: User[]) =>
          prevUsers.map((user: User) =>
            user.userId === editingSecretsUserId
              ? { ...user, secretNames: response.data.secretNames }
              : user
          )
        );
        setSuccess("Secrets updated successfully!");
        setSecretsDialogOpen(false);
        setEditingSecretsUserId(null);
        setSecretEntries([]);
      }
    } catch (error: any) {
      console.error("Error updating secrets:", error);
      setError(error.response?.data?.message || "Failed to update secrets");
    } finally {
      setSecretsEditLoading(false);
    }
  };

  const openSeoAeoDialog = async (user: User) => {
    setEditingSeoDomainsUserId(user.userId);
    setEditingUserIsOrgOwner(!!user.isOrgOwner);
    setEditingUserOrgId(user.orgId || null);
    setShareAnalyticsWithOrg(!!user.orgShareAnalyticsWithOrg);
    // Reset fields, then load the resolved config (Org record if the user is in an org).
    setSeoDomainsText(""); setGoogleAnalyticsProperties([]); setPrimaryAnalyticsPropertyId("");
    setGaFilteredDomainsText(""); setClarityProjects([]); setProductDomain("");
    setGoogleAnalyticsPropertyId(""); setClarityProjectId("");
    setSeoDomainsDialogOpen(true);
    setSeoAeoDialogLoading(true);
    try {
      const { data } = await axios.get(
        buildApiUrl(`/api/admin/users/${user.userId}/seo-aeo`),
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const c = data.config || {};
      setSeoDomainsText((c.seoDomains || []).join("\n"));
      setGoogleAnalyticsProperties(c.googleAnalyticsProperties || []);
      setPrimaryAnalyticsPropertyId(c.primaryAnalyticsPropertyId || "");
      setGaFilteredDomainsText((c.gaFilteredDomains || []).join("\n"));
      setClarityProjects(c.clarityProjects || []);
      setProductDomain(c.productDomain || "");
    } catch (e: any) {
      setError(e.response?.data?.message || "Failed to load SEO/AEO config");
    } finally {
      setSeoAeoDialogLoading(false);
    }
  };

  const handleSaveSeoDomains = async () => {
    if (!editingSeoDomainsUserId) return;

    // Clear any previous errors
    setError("");

    // Parse domains from text (one per line or comma-separated)
    const domainsText = seoDomainsText.trim();
    let domains: string[] = [];

    if (domainsText) {
      // Split by newlines or commas, then filter and validate
      domains = domainsText
        .split(/[\n,]+/)
        .map(d => d.trim())
        .filter(d => d.length > 0);

      // Validate each domain format (allow both domain and URL-prefix formats)
      // Domain property: example.com
      // URL-prefix property: https://example.com or https://example.com/
      const domainRegex = /^[a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9]*\.[a-zA-Z]{2,}$/;
      const urlPrefixRegex = /^https?:\/\/[a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9]*\.[a-zA-Z]{2,}\/?$/;

      for (const domain of domains) {
        if (!domainRegex.test(domain) && !urlPrefixRegex.test(domain)) {
          setError(`Invalid domain format: ${domain}. Use 'example.com' for domain properties or 'https://example.com' or 'https://example.com/' for URL-prefix properties`);
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

    // Validate Google Analytics Properties array
    const validatedGaProperties = googleAnalyticsProperties
      .filter(p => p.propertyId.trim() || p.label.trim()) // Filter out empty entries
      .map(p => ({ propertyId: p.propertyId.trim(), label: p.label.trim() }));

    const gaIdRegex = /^\d+$/;
    const seenPropertyIds = new Set<string>();

    for (const property of validatedGaProperties) {
      if (!property.propertyId || !property.label) {
        setError('Each GA4 property must have both Property ID and Label');
        return;
      }
      if (!gaIdRegex.test(property.propertyId)) {
        setError(`Invalid Google Analytics Property ID format: ${property.propertyId}. Please enter the numeric Property ID (e.g., 123456789).`);
        return;
      }
      if (property.label.length > 100) {
        setError(`GA4 property label too long: ${property.label}. Maximum 100 characters.`);
        return;
      }
      if (seenPropertyIds.has(property.propertyId)) {
        setError(`Duplicate Google Analytics Property ID: ${property.propertyId}`);
        return;
      }
      seenPropertyIds.add(property.propertyId);
    }

    const clarityId = clarityProjectId.trim();
    if (clarityId && !/^[a-zA-Z0-9_-]{6,32}$/.test(clarityId)) {
      setError(`Invalid Microsoft Clarity Project ID format: ${clarityId}. Please enter the project ID (e.g., ul13e4f7fe). You can find this in Clarity project settings.`);
      return;
    }

    // Validate Clarity Projects array
    const validatedClarityProjects = clarityProjects
      .filter(p => p.projectId.trim() || p.label.trim()) // Filter out empty entries
      .map(p => ({ projectId: p.projectId.trim(), label: p.label.trim() }));

    const clarityIdRegex = /^[a-zA-Z0-9_-]{6,32}$/;
    const seenProjectIds = new Set<string>();

    for (const project of validatedClarityProjects) {
      if (!project.projectId || !project.label) {
        setError('Each Clarity project must have both Project ID and Label');
        return;
      }
      if (!clarityIdRegex.test(project.projectId)) {
        setError(`Invalid Microsoft Clarity Project ID format: ${project.projectId}. Please enter the project ID (e.g., ul13e4f7fe).`);
        return;
      }
      if (project.label.length > 100) {
        setError(`Clarity project label too long: ${project.label}. Maximum 100 characters.`);
        return;
      }
      if (seenProjectIds.has(project.projectId)) {
        setError(`Duplicate Microsoft Clarity Project ID: ${project.projectId}`);
        return;
      }
      seenProjectIds.add(project.projectId);
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

    try {
      setSeoDomainsEditLoading(true);

      const response = await axios.put(
        buildApiUrl(`/api/admin/users/${editingSeoDomainsUserId}/seo-aeo`),
        {
          seoDomains: domains,
          googleAnalyticsProperties: validatedGaProperties,
          primaryAnalyticsPropertyId:
            validatedGaProperties.some(p => p.propertyId === primaryAnalyticsPropertyId)
              ? primaryAnalyticsPropertyId
              : null,
          gaFilteredDomains: filteredDomains,
          clarityProjects: validatedClarityProjects,
          productDomain: prodDomain || null,
        },
        {
          headers: { Authorization: `Bearer ${token}` }
        }
      );

      if (response.status === 200) {
        const savedConfig = response.data.config || {};
        // Update the user in the local state without reloading
        setUsers((prevUsers: User[]) =>
          prevUsers.map((user: User) =>
            user.userId === editingSeoDomainsUserId
              ? {
                  ...user,
                  seoDomains: savedConfig.seoDomains || [],
                  googleAnalyticsProperties: savedConfig.googleAnalyticsProperties || undefined,
                  primaryAnalyticsPropertyId: savedConfig.primaryAnalyticsPropertyId || undefined,
                  gaFilteredDomains: savedConfig.gaFilteredDomains || [],
                  clarityProjects: savedConfig.clarityProjects || undefined,
                  productDomain: savedConfig.productDomain || undefined
                }
              : user
          )
        );
        if (editingUserIsOrgOwner && editingUserOrgId) {
          await axios.patch(
            buildApiUrl(`/api/admin/orgs/${editingUserOrgId}/analytics-sharing`),
            { enabled: shareAnalyticsWithOrg },
            { headers: { Authorization: `Bearer ${token}` } }
          );
        }
        setSuccess("SEO/AEO configuration updated successfully!");
        setSeoDomainsDialogOpen(false);
        setEditingSeoDomainsUserId(null);
        setSeoDomainsText("");
        setGoogleAnalyticsPropertyId("");
        setGoogleAnalyticsProperties([]);
        setPrimaryAnalyticsPropertyId("");
        setGaFilteredDomainsText("");
        setClarityProjectId("");
        setClarityProjects([]);
        setProductDomain("");
      }
    } catch (error: any) {
      console.error("Error updating SEO/AEO configuration:", error);
      setError(error.response?.data?.message || "Failed to update SEO/AEO configuration");
    } finally {
      setSeoDomainsEditLoading(false);
    }
  };

  const handleSaveGoogleDriveFolders = async () => {
    if (!editingGoogleDriveFoldersUserId) return;

    setError("");

    try {
      setGoogleDriveFoldersEditLoading(true);

      // Filter out empty entries and validate
      const folders = googleDriveFolderEntries.filter(
        (entry) => entry.folderId.trim() && entry.name.trim()
      );

      const response = await axios.put(
        buildApiUrl(`/api/admin/users/${editingGoogleDriveFoldersUserId}/google-drive-folders`),
        { googleDriveFolders: folders },
        { headers: { Authorization: `Bearer ${token}` } }
      );

      if (response.status === 200) {
        setUsers((prevUsers: User[]) =>
          prevUsers.map((user: User) =>
            user.userId === editingGoogleDriveFoldersUserId
              ? { ...user, googleDriveFolders: response.data.googleDriveFolders || [] }
              : user
          )
        );
        setSuccess("Google Drive folders updated successfully!");
        setGoogleDriveFoldersDialogOpen(false);
        setEditingGoogleDriveFoldersUserId(null);
        setGoogleDriveFolderEntries([]);
        setAvailableGoogleDriveFolders([]);
      }
    } catch (error: any) {
      console.error("Error updating Google Drive folders:", error);
      setError(error.response?.data?.message || "Failed to update Google Drive folders");
    } finally {
      setGoogleDriveFoldersEditLoading(false);
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

  const handleGrantTokenBonus = async () => {
    if (!grantBonusUserId || !grantBonusAmount) return;
    const amount = parseInt(grantBonusAmount.replace(/,/g, ''), 10);
    if (isNaN(amount) || amount <= 0) {
      setError("Bonus amount must be a positive number");
      return;
    }
    try {
      setGrantBonusLoading(true);
      const response = await axios.post(
        buildApiUrl(`/api/admin/users/${grantBonusUserId}/token-bonus`),
        { bonusTokens: amount },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (response.status === 200) {
        setUsers((prevUsers: User[]) =>
          prevUsers.map((user: User) =>
            user.userId === grantBonusUserId
              ? { ...user, tokenAllowanceBonus: response.data.tokenAllowanceBonus }
              : user
          )
        );
        setSuccess(`Granted ${amount.toLocaleString()} bonus tokens to ${grantBonusEmail}`);
        setGrantBonusDialogOpen(false);
      }
    } catch (error: any) {
      setError(error.response?.data?.message || "Failed to grant token bonus");
    } finally {
      setGrantBonusLoading(false);
    }
  };

  const handleSendIntroEmail = async () => {
    if (!introEmailUserId) return;
    try {
      setIntroEmailLoading(true);
      const response = await axios.post(
        buildApiUrl(`/api/admin/users/${introEmailUserId}/send-intro-email`),
        {},
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (response.status === 200) {
        setUsers((prevUsers: User[]) =>
          prevUsers.map((user: User) =>
            user.userId === introEmailUserId
              ? { ...user, introductionEmailSent: response.data.introductionEmailSent }
              : user
          )
        );
        setSuccess(`Team introduction email sent to ${introEmailUserEmail}`);
        setIntroEmailDialogOpen(false);
      }
    } catch (error: any) {
      setError(error.response?.data?.message || "Failed to send introduction email");
    } finally {
      setIntroEmailLoading(false);
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

    if (newPassword.length < 12) {
      setError("Password must be at least 12 characters long");
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
        // If an admin reset THEIR OWN password, changing it terminated all other
        // sessions including this one's token. The backend returns a fresh token
        // in that case — adopt it so this session stays signed in.
        if (response.data?.token && passwordUserId === user?.userId) {
          await setToken(response.data.token);
        }
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
            <Tab label="Image Models (Legacy)" {...a11yProps(9)} />
            <Tab label="Default Prompts" {...a11yProps(10)} />
            <Tab label="Benchmarks" {...a11yProps(11)} />
            <Tab label="Subscriptions" {...a11yProps(12)} />
            <Tab label="MCP Servers" {...a11yProps(13)} />
            <Tab label="Result Endpoints" {...a11yProps(14)} />
            <Tab label="Scoring Judges" {...a11yProps(15)} />
            <Tab label="CRM" {...a11yProps(17)} />
            <Tab label="Revenue" {...a11yProps(18)} />
            <Tab label="Funnel" {...a11yProps(19)} />
            <Tab label="Alert Emails" {...a11yProps(18)} />
            <Tab label="Onboarding" {...a11yProps(20)} />
            <Tab label="Connected Accounts" {...a11yProps(21)} />
            <Tab label="Contractors" {...a11yProps(22)} />
            <Tab label="Emma MCP" {...a11yProps(23)} />
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
                    <Card sx={{ cursor: 'pointer' }} onClick={() => setToolCallsExpanded(v => !v)}>
                      <CardContent>
                        <Typography variant="h6" gutterBottom>
                          Tool Calls {toolCallsExpanded ? '▲' : '▼'}
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
                  <Grid item xs={12} md={3}>
                    <Card>
                      <CardContent>
                        <Typography variant="h6" gutterBottom>
                          GTM Tracker
                        </Typography>
                        {gtmAnalytics && (
                          <>
                            <Typography variant="h4" color="primary">
                              {gtmAnalytics.completedItemsInRange || 0}
                            </Typography>
                            <Typography variant="body2" color="text.secondary">
                              Completed Items (in period)
                            </Typography>
                            <Typography variant="body2" color="text.secondary">
                              Total Completed: {gtmAnalytics.completedItems || 0}
                            </Typography>
                            <Typography variant="body2" color="text.secondary">
                              Total Items: {gtmAnalytics.totalItems || 0}
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
                          CRM
                        </Typography>
                        {crmAnalytics && (
                          <>
                            <Typography variant="h4" color="primary">
                              {crmAnalytics.totalLeads || 0}
                            </Typography>
                            <Typography variant="body2" color="text.secondary">
                              Total Leads
                            </Typography>
                            <Typography variant="body2" color="text.secondary">
                              New Leads: <span style={{ color: '#4caf50' }}>+{crmAnalytics.newLeads || 0}</span>
                            </Typography>
                            <Typography variant="body2" color="text.secondary">
                              Lists: {crmAnalytics.totalLists || 0}
                            </Typography>
                            <Typography variant="body2" color="text.secondary">
                              ICP Leads: {crmAnalytics.totalICPLeads || 0}
                            </Typography>
                            <Typography variant="body2" color="text.secondary">
                              Engaged: {crmAnalytics.totalEngagedLeads || 0}
                            </Typography>
                          </>
                        )}
                      </CardContent>
                    </Card>
                  </Grid>
                </Grid>

                {/* Tool Call Details Table (expanded) */}
                <Collapse in={toolCallsExpanded}>
                  <Card sx={{ mb: 3 }}>
                    <CardContent>
                      <Typography variant="h6" gutterBottom>
                        Tool Call Details
                      </Typography>
                      {agentModeAnalytics && (agentModeAnalytics.toolCallDetailsInRange || agentModeAnalytics.toolCallDetails) && (
                        <TableContainer>
                          <Table size="small">
                            <TableHead>
                              <TableRow>
                                <TableCell sx={{ fontWeight: 'bold' }}>Tool Name</TableCell>
                                <TableCell align="right" sx={{ fontWeight: 'bold' }}>Total</TableCell>
                                <TableCell align="right" sx={{ fontWeight: 'bold' }}>Success</TableCell>
                                <TableCell align="right" sx={{ fontWeight: 'bold' }}>Failure</TableCell>
                              </TableRow>
                            </TableHead>
                            <TableBody>
                              {(agentModeAnalytics.toolCallDetailsInRange || agentModeAnalytics.toolCallDetails || []).map((tool: any) => (
                                <TableRow key={tool.name}>
                                  <TableCell>{tool.name}</TableCell>
                                  <TableCell align="right">{tool.total}</TableCell>
                                  <TableCell align="right" sx={{ color: 'success.main' }}>{tool.success}</TableCell>
                                  <TableCell align="right" sx={{ color: tool.failure > 0 ? 'error.main' : 'text.secondary' }}>{tool.failure}</TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </TableContainer>
                      )}
                    </CardContent>
                  </Card>
                </Collapse>

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
          {/* Attention needed — urgent users at the top */}
          {(() => {
            const now = new Date();
            const pastDue = contextUsers.filter(u => u.subscription_status === "past_due" && u.isActive !== false);
            const trialEnding = contextUsers.filter(u => {
              if (u.subscription_status !== "trialing" || !u.current_period_end) return false;
              const daysLeft = Math.ceil((new Date(u.current_period_end).getTime() - now.getTime()) / 86400000);
              return daysLeft <= 7 && daysLeft >= 0;
            }).map(u => ({ ...u, _daysLeft: Math.ceil((new Date(u.current_period_end!).getTime() - now.getTime()) / 86400000) }));
            const trialExpired = contextUsers.filter(u => {
              if (u.subscription_status !== "trialing" || !u.current_period_end) return false;
              return new Date(u.current_period_end).getTime() < now.getTime();
            });
            const subscriptionExpired = contextUsers.filter(u => {
              if (u.subscriptionType === "Free") return false;
              if (u.subscription_status !== "canceled" && u.subscription_status !== "canceling") return false;
              if (!u.current_period_end) return false;
              return new Date(u.current_period_end).getTime() < now.getTime();
            });
            const hasAttention = pastDue.length > 0 || trialEnding.length > 0 || trialExpired.length > 0 || subscriptionExpired.length > 0;
            if (!hasAttention) return null;
            return (
              <Paper variant="outlined" sx={{ mb: 3, p: 2, borderColor: "error.light", bgcolor: "error.50" }}>
                <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 1.5, color: "error.main" }}>
                  ⚠️ Attention Needed
                </Typography>
                {pastDue.length > 0 && (
                  <Box sx={{ mb: 1.5 }}>
                    <Typography variant="caption" sx={{ fontWeight: 600, color: "error.main" }}>PAYMENT FAILED</Typography>
                    {pastDue.map(u => (
                      <Box key={u.userId} sx={{ display: "flex", alignItems: "center", gap: 1, py: 0.5 }}>
                        <Chip label="Past Due" size="small" color="error" />
                        <Typography variant="body2" sx={{ fontWeight: 500 }}>{u.email}</Typography>
                        <Typography variant="caption" color="text.secondary">{u.supportNote || u.subscriptionType || ""}</Typography>
                      </Box>
                    ))}
                  </Box>
                )}
                {trialExpired.length > 0 && (
                  <Box sx={{ mb: 1.5 }}>
                    <Typography variant="caption" sx={{ fontWeight: 600, color: "error.main" }}>TRIAL EXPIRED — AWAITING PAYMENT</Typography>
                    {trialExpired.map(u => (
                      <Box key={u.userId} sx={{ display: "flex", alignItems: "center", gap: 1, py: 0.5 }}>
                        <Chip label="Expired" size="small" color="error" variant="outlined" />
                        <Typography variant="body2" sx={{ fontWeight: 500 }}>{u.email}</Typography>
                        <Typography variant="caption" color="text.secondary">expired {format(new Date(u.current_period_end!), "MMM d")}</Typography>
                      </Box>
                    ))}
                  </Box>
                )}
                {trialEnding.length > 0 && (
                  <Box>
                    <Typography variant="caption" sx={{ fontWeight: 600, color: "warning.main" }}>TRIAL ENDING SOON</Typography>
                    {trialEnding.sort((a, b) => a._daysLeft - b._daysLeft).map(u => (
                      <Box key={u.userId} sx={{ display: "flex", alignItems: "center", gap: 1, py: 0.5 }}>
                        <Chip label={u._daysLeft === 0 ? "Today!" : `${u._daysLeft}d left`} size="small" color={u._daysLeft <= 2 ? "error" : "warning"} variant="outlined" />
                        <Typography variant="body2" sx={{ fontWeight: 500 }}>{u.email}</Typography>
                        <Typography variant="caption" color="text.secondary">{u.supportNote || u.subscriptionType || ""} · ends {format(new Date(u.current_period_end!), "MMM d")}</Typography>
                      </Box>
                    ))}
                  </Box>
                )}
                {subscriptionExpired.length > 0 && (
                  <Box sx={{ mt: trialEnding.length > 0 ? 1.5 : 0 }}>
                    <Typography variant="caption" sx={{ fontWeight: 600, color: "warning.main" }}>SUBSCRIPTION ENDED — MOVE TO FREE TIER</Typography>
                    {subscriptionExpired.sort((a, b) => new Date(a.current_period_end!).getTime() - new Date(b.current_period_end!).getTime()).map(u => (
                      <Box key={u.userId} sx={{ display: "flex", alignItems: "center", gap: 1, py: 0.5 }}>
                        <Chip label="Ended" size="small" color="warning" variant="outlined" />
                        <Typography variant="body2" sx={{ fontWeight: 500 }}>{u.email}</Typography>
                        <Typography variant="caption" color="text.secondary">{u.subscriptionType || ""} · ended {format(new Date(u.current_period_end!), "MMM d")}</Typography>
                      </Box>
                    ))}
                  </Box>
                )}
              </Paper>
            );
          })()}
          {/* Summary cards - Stripe-style muted design */}
          <Box sx={{ display: "flex", gap: 2, mb: 3, flexWrap: "wrap" }}>
            {(() => {
              const active = contextUsers.filter(u => u.isActive !== false);
              const paying = contextUsers.filter(u => u.subscription_status === "active");
              const trialing = contextUsers.filter(u => u.subscription_status === "trialing");
              const pastDue = contextUsers.filter(u => u.subscription_status === "past_due");
              const canceled = contextUsers.filter(u => u.subscription_status === "canceled" || u.subscription_status === "canceling");
              const bounced = contextUsers.filter(u => u.stripe_customer_id && !u.subscription_status && !u.subscription_amount);
              // Churn rate: canceled / (paying + canceled) — lifetime simple churn
              const churnBase = paying.length + canceled.length;
              const churnRate = churnBase > 0 ? ((canceled.length / churnBase) * 100).toFixed(0) : "0";
              // Monthly churn: canceled in last 30 days
              const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000);
              const recentChurned = canceled.filter(u => u.current_period_end && new Date(u.current_period_end) > thirtyDaysAgo);
              const monthlyChurnBase = paying.length + recentChurned.length;
              const monthlyChurn = monthlyChurnBase > 0 ? ((recentChurned.length / monthlyChurnBase) * 100).toFixed(0) : "0";
              return [
                { label: "Active Users", value: active.length, sub: `${contextUsers.length} total` },
                { label: "Paying", value: paying.length, sub: trialing.length > 0 ? `+${trialing.length} trial` : undefined },
                { label: "Past Due", value: pastDue.length, sub: pastDue.length > 0 ? "⚠️ needs follow-up" : undefined, warn: pastDue.length > 0 },
                { label: "Churned", value: canceled.length, sub: `${recentChurned.length} last 30d` },
                { label: "Churn Rate", value: `${monthlyChurn}%`, sub: `${churnRate}% lifetime` },
                { label: "Bounced", value: bounced.length, sub: "checkout abandoned" },
                { label: "Showing", value: sortedUsers.length, sub: undefined },
              ];
            })().map((stat) => (
              <Paper key={stat.label} variant="outlined" sx={{ px: 2.5, py: 1.5, minWidth: 100, borderColor: stat.warn ? "error.main" : undefined }}>
                <Typography variant="h5" sx={{ fontWeight: 600, lineHeight: 1.2, color: stat.warn ? "error.main" : undefined }}>
                  {stat.value}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {stat.label}
                </Typography>
                {stat.sub && (
                  <Typography variant="caption" display="block" color="text.disabled" sx={{ fontSize: "0.65rem", mt: 0.25 }}>
                    {stat.sub}
                  </Typography>
                )}
              </Paper>
            ))}
          </Box>
          {/* Filter bar */}
          <Box sx={{ display: "flex", gap: 1.5, mb: 2, alignItems: "center" }}>
            <TextField
              size="small"
              placeholder="Search users..."
              value={userSearchQuery}
              onChange={(e) => setUserSearchQuery(e.target.value)}
              sx={{ minWidth: 240 }}
              InputProps={{
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchIcon fontSize="small" sx={{ color: "text.disabled" }} />
                  </InputAdornment>
                ),
              }}
            />
            <FormControl size="small" sx={{ minWidth: 110 }}>
              <InputLabel>Status</InputLabel>
              <Select value={userFilterStatus} label="Status" onChange={(e) => setUserFilterStatus(e.target.value as any)}>
                <MenuItem value="active">Active</MenuItem>
                <MenuItem value="inactive">Inactive</MenuItem>
                <MenuItem value="all">All</MenuItem>
              </Select>
            </FormControl>
            <FormControl size="small" sx={{ minWidth: 130 }}>
              <InputLabel>Tier</InputLabel>
              <Select value={userFilterTier} label="Tier" onChange={(e) => setUserFilterTier(e.target.value)}>
                <MenuItem value="all">All Tiers</MenuItem>
                {availableSubscriptionTypes.map((t) => (
                  <MenuItem key={t} value={t}>{t}</MenuItem>
                ))}
                <MenuItem value="none">No Tier</MenuItem>
              </Select>
            </FormControl>
            <FormControl size="small" sx={{ minWidth: 120 }}>
              <InputLabel>Payment</InputLabel>
              <Select value={userFilterPaid} label="Payment" onChange={(e) => setUserFilterPaid(e.target.value as any)}>
                <MenuItem value="all">All</MenuItem>
                <MenuItem value="paid">Paying</MenuItem>
                <MenuItem value="bounced">Bounced</MenuItem>
                <MenuItem value="unpaid">Not Paying</MenuItem>
              </Select>
            </FormControl>
            <FormControlLabel
              control={
                <Checkbox
                  size="small"
                  checked={userFilterHasUsage}
                  onChange={(e) => setUserFilterHasUsage(e.target.checked)}
                />
              }
              label={<Typography variant="body2">Has usage</Typography>}
              sx={{ ml: 0 }}
            />
            <FormControlLabel
              control={
                <Checkbox
                  size="small"
                  checked={userFilterHideBotLike}
                  onChange={(e) => {
                    setUserFilterHideBotLike(e.target.checked);
                    loadUsers(e.target.checked);
                  }}
                />
              }
              label={<Typography variant="body2">Hide bots</Typography>}
              sx={{ ml: 0 }}
            />
            {(userSearchQuery || userFilterStatus !== "active" || userFilterTier !== "all" || userFilterPaid !== "all" || userFilterHasUsage || !userFilterHideBotLike) && (
              <Button size="small" onClick={() => { setUserSearchQuery(""); setUserFilterStatus("active"); setUserFilterTier("all"); setUserFilterPaid("all"); setUserFilterHasUsage(false); setUserFilterHideBotLike(true); loadUsers(true); }}>
                Clear
              </Button>
            )}
            <Box sx={{ flexGrow: 1 }} />
            <Button variant="outlined" size="small" startIcon={resyncPaymentsLoading ? <CircularProgress size={14} /> : <SyncIcon />} onClick={handleResyncPayments} disabled={resyncPaymentsLoading}>
              Resync Payments
            </Button>
            <Button variant="contained" size="small" startIcon={<SyncIcon />} onClick={() => handleOpenCrmSyncDialog("users")}>
              Sync to CRM
            </Button>
          </Box>
          <Box sx={{ mb: 2, p: 2, bgcolor: 'background.paper', borderRadius: 1, border: '1px solid', borderColor: 'divider' }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
              <Typography variant="subtitle2" sx={{ minWidth: 160, whiteSpace: 'nowrap' }}>Admin Slack Channels:</Typography>
              <Button
                variant="contained"
                size="small"
                onClick={handleSaveAdminSlackChannel}
                disabled={adminSlackChannelLoading}
              >
                {adminSlackChannelLoading ? <CircularProgress size={20} /> : 'Save'}
              </Button>
              {adminSlackChannelSaved && (
                <Typography variant="caption" color="success.main">Saved!</Typography>
              )}
            </Box>
            <Autocomplete
              multiple
              options={availableSlackChannels}
              getOptionLabel={(opt) => `#${opt.name}`}
              value={availableSlackChannels.filter((ch) => adminSlackChannelsInput.includes(ch.id))}
              onChange={(_e, selected) => {
                setAdminSlackChannelsInput(selected.map((ch) => ch.id));
                setAdminSlackChannelSaved(false);
              }}
              loading={availableSlackChannelsLoading}
              isOptionEqualToValue={(opt, val) => opt.id === val.id}
              renderInput={(params) => (
                <TextField
                  {...params}
                  size="small"
                  placeholder={availableSlackChannels.length > 0 ? "Select channels…" : "No channels available (bot not in any channel)"}
                />
              )}
              renderTags={(selected, getTagProps) =>
                selected.map((ch, index) => (
                  <Chip
                    label={`#${ch.name}`}
                    size="small"
                    {...getTagProps({ index })}
                  />
                ))
              }
              sx={{ maxWidth: 560 }}
              noOptionsText={availableSlackChannelsLoading ? "Loading channels…" : "No channels found — make sure the bot is added to the channels"}
            />
            {adminSlackChannels.length > 0 && (
              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mt: 1 }}>
                {adminSlackChannels.map((id) => {
                  const ch = availableSlackChannels.find((c) => c.id === id);
                  return (
                    <Link
                      key={id}
                      href={`https://slack.com/app_redirect?channel=${id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      sx={{ display: 'flex', alignItems: 'center', gap: 0.5, fontSize: '0.75rem' }}
                    >
                      {ch ? `#${ch.name}` : id} <OpenInNewIcon sx={{ fontSize: '0.875rem' }} />
                    </Link>
                  );
                })}
              </Box>
            )}
          </Box>
          <TableContainer component={Paper} variant="outlined">
            <Table size="small">
              <TableHead>
                <TableRow sx={{ "& th": { fontWeight: 600, fontSize: "0.75rem", color: "text.secondary", textTransform: "uppercase", letterSpacing: "0.05em", py: 1.5 } }}>
                  <TableCell sx={{ width: 32, p: 0.5 }} />
                  <TableCell>
                    <UserSortLabel property="email" label="User" />
                  </TableCell>
                  <TableCell>
                    <UserSortLabel property="subscriptionType" label="Tier" />
                  </TableCell>
                  <TableCell>Payment</TableCell>
                  <TableCell>
                    <UserSortLabel property="funnelStatus" label="Funnel Status" />
                  </TableCell>
                  <TableCell>
                    <UserSortLabel property="createdAt" label="Created" />
                  </TableCell>
                  <TableCell>
                    <UserSortLabel property="lastLoginTime" label="Last Active" />
                  </TableCell>
                  <TableCell>
                    <UserSortLabel property={"tokenUsage" as keyof User} label="Usage" />
                  </TableCell>
                  <TableCell>Intro Email</TableCell>
                  <TableCell sx={{ width: 100 }}>Actions</TableCell>
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
                  sortedUsers.map((user) => {
                    const isExpanded = expandedUserId === user.userId;
                    const tier = user.subscriptionType || (user.roles?.includes("customer") ? "Basic" : "Free");
                    const tierColor = tier === "Managed" ? "info" as const
                      : tier === "Super Premium" ? "success" as const
                      : tier === "Advanced" ? "warning" as const
                      : "default" as const;
                    const tierVariant = (tier === "Free" || tier === "Basic") ? "outlined" as const : "filled" as const;
                    const paymentStatus = user.subscription_status === "past_due" ? "past_due"
                      : user.subscription_status === "canceled" || user.subscription_status === "canceling" ? "canceled"
                      : user.subscription_status === "trialing" ? "trialing"
                      : user.subscription_status === "active" ? "paying"
                      : user.stripe_customer_id && !user.subscription_status && !user.subscription_amount ? "bounced"
                      : "free";
                    const lastActiveTimestamp = user.lastActiveAt || user.lastLoginTime;
                    const lastSeen = lastActiveTimestamp ? (() => {
                      const d = new Date(lastActiveTimestamp);
                      const now = new Date();
                      const diffH = Math.floor((now.getTime() - d.getTime()) / 3600000);
                      if (diffH < 1) return "Just now";
                      if (diffH < 24) return `${diffH}h ago`;
                      const diffD = Math.floor(diffH / 24);
                      if (diffD < 7) return `${diffD}d ago`;
                      return format(d, "MMM d");
                    })() : "Never";
                    const used = user.tokenUsage?.month === new Date().toISOString().slice(0, 7)
                      ? (user.tokenUsage?.totalTokens || 0) : 0;

                    return (
                      <React.Fragment key={user.userId}>
                      <TableRow
                        hover
                        sx={{ cursor: "pointer", "& td": { py: 1.5, borderBottom: isExpanded ? "none" : undefined } }}
                        onClick={() => {
                          const nextExpanded = isExpanded ? null : user.userId;
                          setExpandedUserId(nextExpanded);
                          if (nextExpanded && userActivities[nextExpanded] === undefined) {
                            setUserActivitiesLoading(prev => ({ ...prev, [nextExpanded]: true }));
                            axios.get(buildApiUrl(`/api/admin/users/${nextExpanded}/activities`), { headers: { Authorization: `Bearer ${token}` } })
                              .then(res => setUserActivities(prev => ({ ...prev, [nextExpanded]: res.data.sessions })))
                              .catch(() => setUserActivities(prev => ({ ...prev, [nextExpanded]: [] })))
                              .finally(() => setUserActivitiesLoading(prev => ({ ...prev, [nextExpanded]: false })));
                          }
                          if (nextExpanded && userNotesMap[nextExpanded] === undefined) {
                            loadUserNotes(nextExpanded);
                          }
                        }}
                      >
                        <TableCell sx={{ p: 0.5, width: 32 }}>
                          <IconButton size="small" sx={{ p: 0.25 }}>
                            {isExpanded ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
                          </IconButton>
                        </TableCell>
                        <TableCell>
                          <Box>
                            <Typography variant="body2" sx={{ fontWeight: 500 }}>
                              {user.email}
                            </Typography>
                            {user.orgId ? (
                              <Typography variant="caption" color="text.secondary">
                                {user.orgRole === "owner" ? "Org Owner" : "Org Member"}{user.orgName ? ` · ${user.orgName}` : ""}
                              </Typography>
                            ) : (
                              <Typography variant="caption" color="text.secondary">
                                {user.supportNote || (user.roles?.includes("partner") ? "Partner" : "")}
                              </Typography>
                            )}
                          </Box>
                        </TableCell>
                        <TableCell>
                          <Chip label={tier} size="small" color={tierColor} variant={tierVariant} sx={{ fontWeight: 500, minWidth: 60 }} />
                        </TableCell>
                        <TableCell>
                          <Box sx={{ display: "flex", alignItems: "center", gap: 0.75 }}>
                          {paymentStatus === "paying" && (
                            <Chip icon={<CreditCardIcon />} label="Paid" size="small" color="success" variant="outlined" sx={{ fontWeight: 500 }} />
                          )}
                          {paymentStatus === "trialing" && (
                            <Chip label="Trial" size="small" color="info" variant="outlined" sx={{ fontWeight: 500 }} />
                          )}
                          {paymentStatus === "past_due" && (
                            <Chip icon={<WarningIcon />} label="Past Due" size="small" color="error" sx={{ fontWeight: 600 }} />
                          )}
                          {paymentStatus === "canceled" && (
                            <Chip icon={<CancelIcon />} label="Canceled" size="small" color="error" variant="outlined" sx={{ fontWeight: 500 }} />
                          )}
                          {paymentStatus === "bounced" && (
                            <Chip label="Bounced" size="small" color="warning" variant="outlined" sx={{ fontWeight: 500 }} />
                          )}
                          {paymentStatus === "free" && (
                            <Typography variant="caption" color="text.disabled">—</Typography>
                          )}
                          {user.subscription_amount != null && (
                            <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: "nowrap" }}>
                              ${(user.subscription_amount / 100).toFixed(0)}/mo
                            </Typography>
                          )}
                          </Box>
                        </TableCell>
                        <TableCell onClick={(e) => e.stopPropagation()}>
                          <FormControl size="small" sx={{ minWidth: 160 }}>
                            <Select
                              value={FUNNEL_STATUS_OPTIONS.some((option) => option.value === (user.funnelStatus || "")) ? (user.funnelStatus || "") : ""}
                              onChange={(e) => handleSaveFunnelStatus(user.userId, e.target.value)}
                              disabled={funnelStatusSavingUserId === user.userId}
                              displayEmpty
                            >
                              {FUNNEL_STATUS_OPTIONS.map((option) => (
                                <MenuItem key={option.value || "unset"} value={option.value}>
                                  {option.label}
                                </MenuItem>
                              ))}
                            </Select>
                          </FormControl>
                        </TableCell>
                        <TableCell>
                          <Typography variant="body2" color="text.secondary">
                            {user.createdAt ? format(new Date(user.createdAt), "MMM d, yyyy") : "—"}
                          </Typography>
                        </TableCell>
                        <TableCell>
                          <Typography variant="body2" color="text.secondary">{lastSeen}</Typography>
                        </TableCell>
                        <TableCell>
                          <Typography variant="body2" sx={{ fontVariantNumeric: "tabular-nums" }}>
                            {used > 0 ? used.toLocaleString() : "—"}
                          </Typography>
                        </TableCell>
                        <TableCell>
                          {user.introductionEmailSent ? (
                            <Tooltip title={`Sent ${new Date(user.introductionEmailSent).toLocaleString()}`}>
                              <Typography variant="body2" color="success.main" sx={{ fontVariantNumeric: "tabular-nums" }}>
                                {format(new Date(user.introductionEmailSent), "MMM d, yyyy")}
                              </Typography>
                            </Tooltip>
                          ) : (
                            <Typography variant="body2" color="text.disabled">—</Typography>
                          )}
                        </TableCell>
                        <TableCell onClick={(e) => e.stopPropagation()}>
                          <Box sx={{ display: "flex", gap: 0.5 }}>
                            {user.roles?.includes("customer") && (
                              <Tooltip title="Access Portal">
                                <IconButton size="small" onClick={() => handleAccessCustomerPortal(user.userId)} disabled={delegateAccessLoading === user.userId} color="primary">
                                  {delegateAccessLoading === user.userId ? <CircularProgress size={14} /> : <OpenInNewIcon fontSize="small" />}
                                </IconButton>
                              </Tooltip>
                            )}
                            <Tooltip title="Manage Roles">
                              <IconButton size="small" onClick={() => handleRoleDialogOpen(user)}><EditIcon fontSize="small" /></IconButton>
                            </Tooltip>
                          </Box>
                        </TableCell>
                      </TableRow>
                      {/* Expandable detail row */}
                      <TableRow>
                        <TableCell colSpan={10} sx={{ py: 0, borderBottom: isExpanded ? undefined : "none" }}>
                          <Collapse in={isExpanded} timeout="auto" unmountOnExit>
                            <Box sx={{ py: 2, px: 1 }}>
                              <Grid container spacing={2}>
                                <Grid item xs={3}>
                                  <Typography variant="caption" color="text.secondary">User ID</Typography>
                                  <Typography variant="body2" sx={{ fontFamily: "monospace", fontSize: "0.75rem", wordBreak: "break-all" }}>{user.userId}</Typography>
                                </Grid>
                                <Grid item xs={3}>
                                  <Typography variant="caption" color="text.secondary">Created</Typography>
                                  <Typography variant="body2">{user.createdAt ? format(new Date(user.createdAt), "MMM d, yyyy") : "—"}</Typography>
                                </Grid>
                                <Grid item xs={3}>
                                  <Typography variant="caption" color="text.secondary">Status</Typography>
                                  <Box><Chip label={user.isActive === false ? "Inactive" : "Active"} color={user.isActive === false ? "error" : "success"} size="small" /></Box>
                                </Grid>
                                <Grid item xs={3}>
                                  <Typography variant="caption" color="text.secondary">Roles</Typography>
                                  <Box sx={{ display: "flex", gap: 0.5, flexWrap: "wrap", mt: 0.5 }}>
                                    {(user.roles || []).map(r => <Chip key={r} label={r} size="small" variant="outlined" />)}
                                    {(!user.roles || user.roles.length === 0) && <Typography variant="body2" color="text.disabled">—</Typography>}
                                  </Box>
                                </Grid>
                                {user.orgId && (
                                  <Grid item xs={3}>
                                    <Typography variant="caption" color="text.secondary">Organization</Typography>
                                    <Box sx={{ display: "flex", gap: 0.5, alignItems: "center", flexWrap: "wrap", mt: 0.5 }}>
                                      <Chip
                                        label={user.orgRole === "owner" ? "Owner" : "Member"}
                                        size="small"
                                        color={user.orgRole === "owner" ? "primary" : "default"}
                                        variant="outlined"
                                      />
                                      {user.orgName && (
                                        <Typography variant="body2">{user.orgName}</Typography>
                                      )}
                                      <Typography variant="caption" color="text.disabled" sx={{ fontFamily: "monospace", fontSize: "0.7rem" }}>
                                        {user.orgId}
                                      </Typography>
                                    </Box>
                                  </Grid>
                                )}
                                <Grid item xs={3}>
                                  <Typography variant="caption" color="text.secondary">Tasks / Workflows</Typography>
                                  <Box sx={{ display: "flex", gap: 1, mt: 0.5 }}>
                                    <Chip
                                      label={`${user.taskCount || 0} tasks`}
                                      size="small"
                                      color={(user.taskCount ?? 0) > 0 ? "primary" : "default"}
                                      variant="outlined"
                                      sx={{ cursor: (user.taskCount ?? 0) > 0 ? "pointer" : undefined }}
                                      onClick={() => { if ((user.taskCount ?? 0) > 0) { setUserTasksDialogUserId(user.userId); setUserTasksDialogUserEmail(user.email); setUserTasksDialogOpen(true); } }}
                                    />
                                    <Chip label={`${user.workflowCount || 0} workflows`} size="small" color={(user.workflowCount ?? 0) > 0 ? "primary" : "default"} variant="outlined" />
                                  </Box>
                                </Grid>
                                <Grid item xs={3}>
                                  <Typography variant="caption" color="text.secondary">OAuth / Admin</Typography>
                                  <Typography variant="body2">{user.isOAuthUser ? "OAuth" : "Email"} / {user.isAdmin ? "Admin" : "No"}</Typography>
                                </Grid>
                                <Grid item xs={3}>
                                  <Typography variant="caption" color="text.secondary">Subscription</Typography>
                                  <Box sx={{ display: "flex", alignItems: "center", gap: 1, mt: 0.5 }}>
                                    {user.roles?.includes("customer") ? (
                                      editingSubscriptionTypeUserId === user.userId ? (
                                        <Box sx={{ display: "flex", gap: 0.5 }}>
                                          <FormControl size="small" sx={{ minWidth: 100 }}>
                                            <Select value={currentSubscriptionType} onChange={(e) => setCurrentSubscriptionType(e.target.value)} disabled={subscriptionTypeEditLoading}>
                                              {availableSubscriptionTypes.map(t => <MenuItem key={t} value={t}>{t}</MenuItem>)}
                                            </Select>
                                          </FormControl>
                                          <IconButton size="small" onClick={handleSaveSubscriptionType} disabled={subscriptionTypeEditLoading} color="primary"><CheckIcon /></IconButton>
                                          <IconButton size="small" onClick={() => { setEditingSubscriptionTypeUserId(null); setCurrentSubscriptionType(""); }}><CloseIcon /></IconButton>
                                        </Box>
                                      ) : (
                                        <>
                                          <Chip label={tier} size="small" color={tierColor} variant={tierVariant} />
                                          <IconButton size="small" onClick={() => { setEditingSubscriptionTypeUserId(user.userId); setCurrentSubscriptionType(user.subscriptionType || "Basic"); }}><EditIcon fontSize="small" /></IconButton>
                                        </>
                                      )
                                    ) : <Typography variant="body2" color="text.disabled">—</Typography>}
                                  </Box>
                                </Grid>
                                {/* Config details — all with inline edit */}
                                <Grid item xs={3}>
                                  <Typography variant="caption" color="text.secondary">Display Name</Typography>
                                  <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
                                    {editingNameUserId === user.userId ? (
                                      <>
                                        <TextField size="small" value={currentDisplayName} onChange={(e) => setCurrentDisplayName(e.target.value)} placeholder="Full name" sx={{ flex: 1 }} />
                                        <IconButton size="small" onClick={() => handleSaveName(user.userId)} disabled={nameEditLoading} color="primary"><CheckIcon fontSize="small" /></IconButton>
                                        <IconButton size="small" onClick={() => { setEditingNameUserId(null); setCurrentDisplayName(""); }}><CloseIcon fontSize="small" /></IconButton>
                                      </>
                                    ) : (
                                      <>
                                        <Typography variant="body2" sx={{ fontSize: "0.75rem" }}>{user.displayName || "—"}</Typography>
                                        <IconButton size="small" onClick={() => { setEditingNameUserId(user.userId); setCurrentDisplayName(user.displayName || ""); }}><EditIcon sx={{ fontSize: 14 }} /></IconButton>
                                      </>
                                    )}
                                  </Box>
                                </Grid>
                                <Grid item xs={3}>
                                  <Typography variant="caption" color="text.secondary">Contact Email</Typography>
                                  <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
                                    {editingEmailUserId === user.userId ? (
                                      <>
                                        <TextField size="small" value={currentEmailText} onChange={(e) => setCurrentEmailText(e.target.value)} placeholder="user@example.com" sx={{ flex: 1 }} />
                                        <IconButton size="small" onClick={() => handleSaveContactEmail(user.userId)} disabled={emailEditLoading} color="primary"><CheckIcon fontSize="small" /></IconButton>
                                        <IconButton size="small" onClick={() => setEditingEmailUserId(null)}><CloseIcon fontSize="small" /></IconButton>
                                      </>
                                    ) : (
                                      <>
                                        <Typography variant="body2" sx={{ fontSize: "0.75rem" }}>{user.email}</Typography>
                                        <IconButton size="small" onClick={() => { setEditingEmailUserId(user.userId); setCurrentEmailText(user.email); }}><EditIcon sx={{ fontSize: 14 }} /></IconButton>
                                      </>
                                    )}
                                  </Box>
                                </Grid>
                                <Grid item xs={3}>
                                  <Typography variant="caption" color="text.secondary">Stripe Customer ID</Typography>
                                  <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
                                    {editingStripeCustomerIdUserId === user.userId ? (
                                      <>
                                        <TextField size="small" value={currentStripeCustomerIdText} onChange={(e) => setCurrentStripeCustomerIdText(e.target.value)} placeholder="cus_..." sx={{ flex: 1 }} />
                                        <IconButton size="small" onClick={() => handleSaveStripeCustomerId(user.userId)} disabled={stripeCustomerIdEditLoading} color="primary"><CheckIcon fontSize="small" /></IconButton>
                                        <IconButton size="small" onClick={() => setEditingStripeCustomerIdUserId(null)}><CloseIcon fontSize="small" /></IconButton>
                                      </>
                                    ) : (
                                      <>
                                        <Typography variant="body2" sx={{ fontFamily: "monospace", fontSize: "0.75rem" }}>{user.stripe_customer_id || "—"}</Typography>
                                        <IconButton size="small" onClick={() => { setEditingStripeCustomerIdUserId(user.userId); setCurrentStripeCustomerIdText(user.stripe_customer_id || ""); }}><EditIcon sx={{ fontSize: 14 }} /></IconButton>
                                        {user.stripe_customer_id && (
                                          <IconButton size="small" title="Sync subscription status from Stripe" onClick={() => handleSyncStripe(user.userId)} disabled={syncStripeLoadingUserId === user.userId}>
                                            {syncStripeLoadingUserId === user.userId ? <CircularProgress size={14} /> : <SyncIcon sx={{ fontSize: 14 }} />}
                                          </IconButton>
                                        )}
                                      </>
                                    )}
                                  </Box>
                                </Grid>
                                <Grid item xs={3}>
                                  <Typography variant="caption" color="text.secondary">Ad Account</Typography>
                                  <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
                                    {editingAdAccountUserId === user.userId ? (
                                      <>
                                        <TextField size="small" value={currentAdAccountText} onChange={(e) => setCurrentAdAccountText(e.target.value)} sx={{ flex: 1 }} />
                                        <IconButton size="small" onClick={() => handleSaveAdAccount(user.userId)} disabled={adAccountEditLoading} color="primary"><CheckIcon fontSize="small" /></IconButton>
                                        <IconButton size="small" onClick={() => setEditingAdAccountUserId(null)}><CloseIcon fontSize="small" /></IconButton>
                                      </>
                                    ) : (
                                      <>
                                        <Typography variant="body2">{user.adAccount || "—"}</Typography>
                                        <IconButton size="small" onClick={() => { setEditingAdAccountUserId(user.userId); setCurrentAdAccountText(user.adAccount || ""); }}><EditIcon sx={{ fontSize: 14 }} /></IconButton>
                                      </>
                                    )}
                                  </Box>
                                </Grid>
                                <Grid item xs={3}>
                                  <Typography variant="caption" color="text.secondary">Email Sender</Typography>
                                  <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
                                    <Typography variant="body2">{user.emailDomain ? `${user.defaultSenderUsername || "noreply"}@${user.emailDomain}` : "—"}</Typography>
                                    <IconButton size="small" onClick={() => { setEditingEmailSenderUserId(user.userId); setEmailDomain(user.emailDomain || ""); setDefaultSenderUsername(user.defaultSenderUsername || ""); setFromName(user.fromName || ""); setEmailSenderDialogOpen(true); }}><EditIcon sx={{ fontSize: 14 }} /></IconButton>
                                  </Box>
                                </Grid>
                                <Grid item xs={3}>
                                  <Typography variant="caption" color="text.secondary">Slack Channels</Typography>
                                  <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, flexWrap: "wrap" }}>
                                    <Typography variant="body2">
                                      {(() => {
                                        const ids = user.slackChannels && user.slackChannels.length > 0
                                          ? user.slackChannels
                                          : user.slackChannel ? [user.slackChannel] : [];
                                        if (ids.length === 0) return "—";
                                        return ids.map((id) =>
                                          slackChannelNames[id] ? `${slackChannelNames[id]} (${id})` : id
                                        ).join(", ");
                                      })()}
                                    </Typography>
                                    <IconButton size="small" onClick={() => {
                                      setEditingSlackChannelUserId(user.userId);
                                      const channels = user.slackChannels && user.slackChannels.length > 0
                                        ? user.slackChannels
                                        : user.slackChannel ? [user.slackChannel] : [];
                                      setCurrentSlackChannels(channels);
                                      setSlackChannelInputText("");
                                      setSlackChannelDialogOpen(true);
                                      resolveSlackChannelNames(channels);
                                    }}><EditIcon sx={{ fontSize: 14 }} /></IconButton>
                                  </Box>
                                  {(() => {
                                    const hasChannels = (user.slackChannels && user.slackChannels.length > 0) || !!user.slackChannel;
                                    if (!hasChannels) return null;
                                    return (
                                      <FormControlLabel
                                        sx={{ mt: 0.5, ml: 0 }}
                                        control={
                                          <Switch
                                            size="small"
                                            checked={!user.slackSuggestedRepliesDisabled}
                                            onChange={(e) => handleToggleSlackSuggestedReplies(user.userId, e.target.checked)}
                                          />
                                        }
                                        label={<Typography variant="caption">Suggested replies</Typography>}
                                      />
                                    );
                                  })()}
                                </Grid>
                                <Grid item xs={3}>
                                  <Typography variant="caption" color="text.secondary">SEO / GA / Clarity</Typography>
                                  <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
                                    <Typography variant="body2">{user.seoDomains?.join(", ") || "—"}</Typography>
                                    <IconButton size="small" onClick={() => openSeoAeoDialog(user)}><EditIcon sx={{ fontSize: 14 }} /></IconButton>
                                  </Box>
                                </Grid>
                                <Grid item xs={3}>
                                  <Typography variant="caption" color="text.secondary">UTM Attribution</Typography>
                                  <Typography variant="body2">
                                    {user.utmSource || user.utmCampaign
                                      ? [user.utmSource && `src: ${user.utmSource}`, user.utmMedium && `med: ${user.utmMedium}`, user.utmCampaign && `camp: ${user.utmCampaign}`, user.utmContent && `ctn: ${user.utmContent}`].filter(Boolean).join(" · ")
                                      : "—"}
                                  </Typography>
                                </Grid>
                                <Grid item xs={3}>
                                  <Typography variant="caption" color="text.secondary">Secrets</Typography>
                                  <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
                                    <Typography variant="body2">{user.secretNames?.join(", ") || "—"}</Typography>
                                    <IconButton size="small" onClick={() => { setEditingSecretsUserId(user.userId); setSecretEntries((user.secretNames || []).map(n => ({ name: n, value: "" }))); setSecretsDialogOpen(true); }}><EditIcon sx={{ fontSize: 14 }} /></IconButton>
                                  </Box>
                                </Grid>
                                <Grid item xs={3}>
                                  <Typography variant="caption" color="text.secondary">CMS Type</Typography>
                                  <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
                                    {editingCmsTypeUserId === user.userId ? (
                                      <>
                                        <FormControl size="small" sx={{ minWidth: 100 }}>
                                          <Select value={currentCmsType} onChange={(e) => setCurrentCmsType(e.target.value as any)}>
                                            <MenuItem value="">None</MenuItem>
                                            <MenuItem value="Basehub">Basehub</MenuItem>
                                            <MenuItem value="Webflow">Webflow</MenuItem>
                                          </Select>
                                        </FormControl>
                                        <IconButton size="small" onClick={() => handleSaveCmsType()} disabled={cmsTypeEditLoading} color="primary"><CheckIcon fontSize="small" /></IconButton>
                                        <IconButton size="small" onClick={() => setEditingCmsTypeUserId(null)}><CloseIcon fontSize="small" /></IconButton>
                                      </>
                                    ) : (
                                      <>
                                        <Typography variant="body2">{user.cmsType || "—"}</Typography>
                                        <IconButton size="small" onClick={() => { setEditingCmsTypeUserId(user.userId); setCurrentCmsType(user.cmsType || ""); }}><EditIcon sx={{ fontSize: 14 }} /></IconButton>
                                      </>
                                    )}
                                  </Box>
                                </Grid>
                                <Grid item xs={3}>
                                  <Typography variant="caption" color="text.secondary">Shared Folders</Typography>
                                  <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
                                    <Typography variant="body2">{user.googleDriveFolders?.map(f => f.name).join(", ") || "—"}</Typography>
                                  </Box>
                                </Grid>
                                <Grid item xs={6}>
                                  <Typography variant="caption" color="text.secondary">Support Note</Typography>
                                  <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
                                    {editingSupportNoteUserId === user.userId ? (
                                      <>
                                        <TextField size="small" value={currentSupportNoteText} onChange={(e) => setCurrentSupportNoteText(e.target.value)} sx={{ flex: 1 }} multiline maxRows={3} />
                                        <IconButton size="small" onClick={() => handleSaveSupportNote(user.userId)} disabled={supportNoteEditLoading} color="primary"><CheckIcon fontSize="small" /></IconButton>
                                        <IconButton size="small" onClick={() => setEditingSupportNoteUserId(null)}><CloseIcon fontSize="small" /></IconButton>
                                      </>
                                    ) : (
                                      <>
                                        <Typography variant="body2">{user.supportNote || "—"}</Typography>
                                        <IconButton size="small" onClick={() => { setEditingSupportNoteUserId(user.userId); setCurrentSupportNoteText(user.supportNote || ""); }}><EditIcon sx={{ fontSize: 14 }} /></IconButton>
                                      </>
                                    )}
                                  </Box>
                                </Grid>
                                {/* User Notes */}
                                <Grid item xs={12}>
                                  <Typography variant="caption" color="text.secondary">Notes</Typography>
                                  <Box sx={{ mt: 0.5 }}>
                                    {userNotesLoading[user.userId] ? (
                                      <CircularProgress size={16} />
                                    ) : (
                                      <>
                                        {(userNotesMap[user.userId] || []).length === 0 && (
                                          <Typography variant="body2" color="text.disabled">No notes yet</Typography>
                                        )}
                                        {(userNotesMap[user.userId] || []).map((note) => (
                                          <Box
                                            key={note.id}
                                            sx={{
                                              display: "flex",
                                              alignItems: "flex-start",
                                              gap: 0.5,
                                              mb: 0.75,
                                              p: 0.75,
                                              borderRadius: 1,
                                              bgcolor: "action.hover",
                                            }}
                                          >
                                            <Box sx={{ flex: 1 }}>
                                              <Typography variant="body2" sx={{ whiteSpace: "pre-wrap" }}>{note.content}</Typography>
                                              <Typography variant="caption" color="text.secondary">
                                                {format(new Date(note.timestamp), "MMM d, yyyy h:mm a")} · {note.authorEmail}
                                              </Typography>
                                            </Box>
                                            <Tooltip title="Delete note">
                                              <IconButton size="small" onClick={() => handleDeleteUserNote(user.userId, note.id)} sx={{ flexShrink: 0 }}>
                                                <DeleteIcon sx={{ fontSize: 14 }} />
                                              </IconButton>
                                            </Tooltip>
                                          </Box>
                                        ))}
                                        <Box sx={{ display: "flex", gap: 0.5, mt: 0.5 }}>
                                          <TextField
                                            size="small"
                                            placeholder="Add a note…"
                                            value={newNoteText[user.userId] || ""}
                                            onChange={(e) => setNewNoteText((prev) => ({ ...prev, [user.userId]: e.target.value }))}
                                            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleAddUserNote(user.userId); } }}
                                            multiline
                                            maxRows={3}
                                            sx={{ flex: 1 }}
                                          />
                                          <IconButton
                                            size="small"
                                            color="primary"
                                            onClick={() => handleAddUserNote(user.userId)}
                                            disabled={addingNoteLoading[user.userId] || !(newNoteText[user.userId] || "").trim()}
                                          >
                                            {addingNoteLoading[user.userId] ? <CircularProgress size={16} /> : <AddIcon fontSize="small" />}
                                          </IconButton>
                                        </Box>
                                      </>
                                    )}
                                  </Box>
                                </Grid>
                                {/* Usage + actions row */}
                                <Grid item xs={6}>
                                  <Typography variant="caption" color="text.secondary">Token Usage</Typography>
                                  <Box sx={{ display: "flex", alignItems: "center", gap: 1, mt: 0.5 }}>
                                    {user.roles?.includes("customer") ? (() => {
                                      const baseAllowance = subscriptionTypeAllowanceMap[user.subscriptionType || "Basic"] ?? null;
                                      const bonus = user.tokenAllowanceBonus || 0;
                                      const effectiveAllowance = baseAllowance != null ? baseAllowance + bonus : null;
                                      return (
                                        <Typography variant="body2">
                                          {used.toLocaleString()} / {effectiveAllowance != null ? effectiveAllowance.toLocaleString() : "∞"}
                                          {bonus > 0 && <Typography component="span" variant="caption" color="text.secondary"> (+{bonus.toLocaleString()} bonus)</Typography>}
                                        </Typography>
                                      );
                                    })() : <Typography variant="body2" color="text.disabled">—</Typography>}
                                    {user.roles?.includes("customer") && (
                                      <Tooltip title="Grant Bonus Tokens">
                                        <IconButton size="small" onClick={() => { setGrantBonusUserId(user.userId); setGrantBonusEmail(user.email); setGrantBonusAmount(""); setGrantBonusDialogOpen(true); }} color="primary"><AddIcon fontSize="small" /></IconButton>
                                      </Tooltip>
                                    )}
                                  </Box>
                                  {user.roles?.includes("customer") && user.tokenUsageHistory && user.tokenUsageHistory.length > 0 && (
                                    <Box sx={{ mt: 0.5 }}>
                                      <Typography variant="caption" color="text.secondary">History: </Typography>
                                      {[...user.tokenUsageHistory].reverse().slice(0, 6).map((h) => (
                                        <Typography key={h.month} component="span" variant="caption" color="text.secondary" sx={{ mr: 1 }}>
                                          {h.month}: {h.totalTokens.toLocaleString()}
                                        </Typography>
                                      ))}
                                    </Box>
                                  )}
                                </Grid>
                                {/* Extra Cost Usage (enrichment, image gen, etc.) */}
                                {user.roles?.includes("customer") && (
                                  <Grid item xs={6}>
                                    <Typography variant="caption" color="text.secondary">Extra Cost Usage</Typography>
                                    <Box sx={{ mt: 0.5 }}>
                                      {(() => {
                                        const currentMonth = new Date().toISOString().slice(0, 7);
                                        const extraUsage = user.extraCostUsage?.month === currentMonth ? user.extraCostUsage : null;
                                        const totalCost = extraUsage?.totalCost ?? 0;
                                        const breakdown = (extraUsage?.breakdown ?? {}) as Record<string, number>;
                                        const breakdownEntries = Object.entries(breakdown).filter(([, v]) => v > 0);
                                        return (
                                          <>
                                            <Typography variant="body2">
                                              ${totalCost.toFixed(4)} this month
                                            </Typography>
                                            {breakdownEntries.length > 0 && (
                                              <Box sx={{ mt: 0.25 }}>
                                                {breakdownEntries.map(([key, val]) => (
                                                  <Typography key={key} component="span" variant="caption" color="text.secondary" sx={{ mr: 1 }}>
                                                    {key}: ${(val as number).toFixed(4)}
                                                  </Typography>
                                                ))}
                                              </Box>
                                            )}
                                          </>
                                        );
                                      })()}
                                    </Box>
                                    {user.extraCostUsageHistory && user.extraCostUsageHistory.length > 0 && (
                                      <Box sx={{ mt: 0.5 }}>
                                        <Typography variant="caption" color="text.secondary">History: </Typography>
                                        {[...user.extraCostUsageHistory].reverse().slice(0, 6).map((h) => (
                                          <Typography key={h.month} component="span" variant="caption" color="text.secondary" sx={{ mr: 1 }}>
                                            {h.month}: ${h.totalCost.toFixed(4)}
                                          </Typography>
                                        ))}
                                      </Box>
                                    )}
                                  </Grid>
                                )}
                                <Grid item xs={6}>
                                  <Typography variant="caption" color="text.secondary">Actions</Typography>
                                  <Box sx={{ display: "flex", gap: 0.5, mt: 0.5 }}>
                                    {user.roles?.includes("customer") && (
                                      <Button size="small" variant="outlined" startIcon={<OpenInNewIcon />} onClick={() => handleAccessCustomerPortal(user.userId)} disabled={delegateAccessLoading === user.userId}>
                                        Portal
                                      </Button>
                                    )}
                                    {user.replayUrl && (
                                      <Button size="small" variant="outlined" startIcon={<PlayCircleOutlineIcon />} component="a" href={user.replayUrl} target="_blank" rel="noopener noreferrer">
                                        Replays
                                      </Button>
                                    )}
                                    <Button size="small" variant="outlined" startIcon={<LockIcon />} onClick={() => handleSetPassword(user.userId, user.email)}>Password</Button>
                                    <Tooltip title={user.introductionEmailSent ? `Intro email sent ${new Date(user.introductionEmailSent).toLocaleDateString()}` : "Send team introduction email"}>
                                      <Button size="small" variant="outlined" color={user.introductionEmailSent ? "success" : "primary"} startIcon={<EmailIcon />} onClick={() => { setIntroEmailUserId(user.userId); setIntroEmailUserEmail(user.email); setIntroEmailDialogOpen(true); }}>
                                        Intro{user.introductionEmailSent ? " ✓" : ""}
                                      </Button>
                                    </Tooltip>
                                    {!user.isAdmin && user.isActive !== false && (
                                      <Button size="small" variant="outlined" color="warning" startIcon={<PersonOffIcon />} onClick={() => { setSelectedUser(user); setDeactivateDialogOpen(true); }}>Deactivate</Button>
                                    )}
                                    {!user.isAdmin && (
                                      <Button size="small" variant="outlined" color="error" startIcon={<DeleteIcon />} onClick={() => handleOpenUserDeleteConfirm(user.userId)}>Delete</Button>
                                    )}
                                  </Box>
                                </Grid>
                                {/* Activities — last 30 days of chat sessions */}
                                <Grid item xs={12}>
                                  <Typography variant="caption" color="text.secondary">Activities (last 30 days)</Typography>
                                  <Box sx={{ mt: 0.5 }}>
                                    {userActivitiesLoading[user.userId] ? (
                                      <CircularProgress size={16} />
                                    ) : (userActivities[user.userId] || []).length === 0 ? (
                                      <Typography variant="body2" color="text.disabled">No sessions in the last 30 days</Typography>
                                    ) : (
                                      <Box sx={{ display: "flex", flexDirection: "column", gap: 0.5 }}>
                                        <Typography variant="caption" color="text.secondary" sx={{ mb: 0.5 }}>
                                          {(userActivities[user.userId] || []).length} session{(userActivities[user.userId] || []).length !== 1 ? "s" : ""}
                                        </Typography>
                                        {(userActivities[user.userId] || []).slice(0, 10).map(session => (
                                          <Box key={session.sessionId} sx={{ display: "flex", gap: 1, alignItems: "center" }}>
                                            <Typography variant="caption" color="text.secondary" sx={{ minWidth: 130 }}>
                                              {new Date(session.updatedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                                            </Typography>
                                            <Typography variant="body2" sx={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                              {session.title || "Untitled Session"}
                                            </Typography>
                                            {session.delegateInfo?.isDelegated ? (
                                              <Chip label="admin" size="small" color="warning" variant="outlined" sx={{ height: 16, fontSize: "0.65rem", "& .MuiChip-label": { px: 0.75 } }} title={`Via delegate access by ${session.delegateInfo.adminEmail}`} />
                                            ) : session.portalType && (
                                              <Typography variant="caption" color="text.secondary">{session.portalType}</Typography>
                                            )}
                                          </Box>
                                        ))}
                                        {(userActivities[user.userId] || []).length > 10 && (
                                          <Typography variant="caption" color="text.secondary">
                                            +{(userActivities[user.userId] || []).length - 10} more
                                          </Typography>
                                        )}
                                      </Box>
                                    )}
                                  </Box>
                                </Grid>
                              </Grid>
                            </Box>
                          </Collapse>
                        </TableCell>
                      </TableRow>
                      </React.Fragment>
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

          <Box sx={{ display: "flex", justifyContent: "space-between", mb: 2 }}>
            <Button
              variant="contained"
              startIcon={<SyncIcon />}
              onClick={() => handleOpenCrmSyncDialog("waitlist")}
            >
              Sync to CRM
            </Button>
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
                    <TableCell colSpan={10} align="center">
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
          {scoringJudges.length > 0 && (
            <Box sx={{ display: 'flex', gap: 2, mb: 2, alignItems: 'center' }}>
              <FormControl size="small" sx={{ minWidth: 200 }}>
                <InputLabel>Judge</InputLabel>
                <Select
                  value={selectedJudgeId}
                  label="Judge"
                  onChange={(e) => setSelectedJudgeId(e.target.value)}
                >
                  {scoringJudges.map((j) => (
                    <MenuItem key={j.id} value={j.id}>{j.name}</MenuItem>
                  ))}
                </Select>
              </FormControl>
              <Button
                variant="outlined"
                size="small"
                disabled={!selectedJudgeId || chatSessions.length === 0}
                onClick={async () => {
                  if (!selectedJudgeId || !token) return;
                  const sessionsToScore = chatSessions.filter((s) => {
                    const msgCount = s.messageCount ?? s.messages?.length ?? 0;
                    if (msgCount < 2) return false;
                    const existing = s.judgeScores?.[selectedJudgeId];
                    if (existing && existing.evaluatedMessageIndex >= msgCount) return false;
                    return true;
                  });
                  if (sessionsToScore.length === 0) return;
                  const batches: string[][] = [];
                  for (let i = 0; i < sessionsToScore.length; i += 5) {
                    batches.push(sessionsToScore.slice(i, i + 5).map((s) => s.sessionId));
                  }
                  setScoringSessionIds((prev) => {
                    const next = new Set(prev);
                    sessionsToScore.forEach((s) => next.add(s.sessionId));
                    return next;
                  });
                  for (const batch of batches) {
                    try {
                      const response = await axios.post(
                        buildApiUrl("/api/admin/chat-sessions/judge-score"),
                        { sessionIds: batch, judgeId: selectedJudgeId },
                        { headers: { Authorization: `Bearer ${token}` }, timeout: 60000 }
                      );
                      const { scores } = response.data;
                      const judge = scoringJudges.find((j) => j.id === selectedJudgeId);
                      setChatSessions((prev) =>
                        prev.map((s) => {
                          const newScore = scores[s.sessionId];
                          if (newScore) {
                            return {
                              ...s,
                              judgeScores: {
                                ...s.judgeScores,
                                [selectedJudgeId]: { ...newScore, judgeName: judge?.name || selectedJudgeId },
                              },
                            };
                          }
                          return s;
                        })
                      );
                    } catch (err) {
                      console.error("Error scoring with judge:", err);
                    } finally {
                      setScoringSessionIds((prev) => {
                        const next = new Set(prev);
                        batch.forEach((id) => next.delete(id));
                        return next;
                      });
                    }
                  }
                }}
              >
                Score All with Judge
              </Button>
            </Box>
          )}
          <Box sx={{ display: 'flex', gap: 1, mb: 2, alignItems: 'center', flexWrap: 'wrap' }}>
            <TextField
              label="Filter by User Email or ID"
              size="small"
              value={chatUserFilter}
              onChange={(e) => setChatUserFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  setChatSessionIdSearch("");
                  loadChatSessions({ reset: true, sessionIdOverride: "", userFilterOverride: chatUserFilter });
                }
              }}
              sx={{ width: 300 }}
              placeholder="Email or user ID"
            />
            <Button
              variant="contained"
              size="small"
              onClick={() => {
                setChatSessionIdSearch("");
                loadChatSessions({ reset: true, sessionIdOverride: "", userFilterOverride: chatUserFilter });
              }}
            >
              Filter
            </Button>
            {chatUserFilter && (
              <Button
                variant="outlined"
                size="small"
                onClick={() => {
                  setChatUserFilter("");
                  loadChatSessions({ reset: true, sessionIdOverride: "", userFilterOverride: "" });
                }}
              >
                Clear
              </Button>
            )}
            <Box sx={{ width: 16 }} />
            <TextField
              label="Search by Session ID"
              size="small"
              value={chatSessionIdSearch}
              onChange={(e) => setChatSessionIdSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  setChatUserFilter("");
                  loadChatSessions({ reset: true, sessionIdOverride: chatSessionIdSearch, userFilterOverride: "" });
                }
              }}
              sx={{ width: 340 }}
              placeholder="Paste a session ID and press Enter or Search"
            />
            <Button
              variant="contained"
              size="small"
              onClick={() => {
                setChatUserFilter("");
                loadChatSessions({ reset: true, sessionIdOverride: chatSessionIdSearch, userFilterOverride: "" });
              }}
            >
              Search
            </Button>
            {chatSessionIdSearch && (
              <Button
                variant="outlined"
                size="small"
                onClick={() => {
                  setChatSessionIdSearch("");
                  loadChatSessions({ reset: true, sessionIdOverride: "", userFilterOverride: "" });
                }}
              >
                Clear
              </Button>
            )}
          </Box>
          <TableContainer component={Paper}>
            <Table>
              <TableHead>
                <TableRow>
                  <TableCell>Session ID</TableCell>
                  <TableCell>Title</TableCell>
                  <TableCell>User ID</TableCell>
                  <TableCell>Portal Type</TableCell>
                  <TableCell>Session Type</TableCell>
                  <TableCell>LLM</TableCell>
                  <TableCell>Created At</TableCell>
                  <TableCell>Updated At</TableCell>
                  <TableCell>Message Count</TableCell>
                  <TableCell>Tokens / Cost</TableCell>
                  <TableCell>Longest Wait</TableCell>
                  <TableCell>Max Heap</TableCell>
                  <TableCell>Feedback</TableCell>
                  <TableCell>Satisfaction</TableCell>
                  <TableCell>Actions</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {chatSessionsLoading && chatSessions.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={15} align="center">
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
                        <TableCell sx={{ maxWidth: 200 }}>
                          {session.title ? (
                            <Tooltip title={session.title}>
                              <span style={{
                                display: 'block',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}>
                                {session.title}
                              </span>
                            </Tooltip>
                          ) : (
                            <span style={{ color: '#999' }}>-</span>
                          )}
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
                                  : session.sessionType === "result-endpoint"
                                  ? "Result Endpoint"
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
                                  : session.sessionType === "result-endpoint"
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
                          {session.llmModel ? (
                            <Chip
                              label={session.llmModel}
                              size="small"
                              variant="outlined"
                            />
                          ) : (
                            <span style={{ color: "#999" }}>-</span>
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
                            if (!session.totalTokens && session.totalCost == null) {
                              return <span style={{ color: '#999' }}>-</span>;
                            }
                            const tokens = session.totalTokens?.total_tokens || 0;
                            const cost = session.totalCost || 0;
                            const tokenLabel = tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(1)}M` : tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}K` : `${tokens}`;
                            const costLabel = cost >= 1 ? `$${cost.toFixed(2)}` : `$${cost.toFixed(4)}`;
                            const costColor = cost > 1 ? '#d32f2f' : cost > 0.1 ? '#ed6c02' : '#666';
                            return (
                              <Tooltip title={`Input: ${(session.totalTokens?.prompt_tokens || 0).toLocaleString()} | Output: ${(session.totalTokens?.completion_tokens || 0).toLocaleString()} | Total: ${tokens.toLocaleString()} tokens | Cost: ${costLabel}`}>
                                <span style={{ color: costColor, fontSize: '0.85rem' }}>
                                  {tokenLabel} / {costLabel}
                                </span>
                              </Tooltip>
                            );
                          })()}
                        </TableCell>
                        <TableCell>
                          {(() => {
                            const waitTimes = (session.messages || [])
                              .filter((msg: any) => msg?.role === 'assistant' && msg?.metadata?.iterationTimings?.length > 0)
                              .map((msg: any) => msg.metadata.iterationTimings.reduce((sum: number, t: any) => sum + (t.llmDurationMs || 0), 0));
                            if (waitTimes.length === 0) return <span style={{ color: '#999' }}>-</span>;
                            const maxWaitMs = Math.max(...waitTimes);
                            const maxWaitSec = maxWaitMs / 1000;
                            const label = maxWaitSec >= 60 ? `${(maxWaitSec / 60).toFixed(1)}m` : `${maxWaitSec.toFixed(1)}s`;
                            const color = maxWaitSec > 60 ? '#d32f2f' : maxWaitSec > 30 ? '#ed6c02' : '#666';
                            return <span style={{ color, fontWeight: maxWaitSec > 30 ? 'bold' : 'normal' }}>{label}</span>;
                          })()}
                        </TableCell>
                        <TableCell>
                          {(() => {
                            const heapUsages = (session.messages || [])
                              .filter((msg: any) => msg?.role === 'assistant' && msg?.metadata?.memoryUsage?.currentHeapUsedMB != null)
                              .map((msg: any) => msg.metadata.memoryUsage.currentHeapUsedMB);
                            if (heapUsages.length === 0) return <span style={{ color: '#999' }}>-</span>;
                            const maxHeapMB = Math.max(...heapUsages);
                            const label = maxHeapMB >= 1000 ? `${(maxHeapMB / 1024).toFixed(2)}GB` : `${maxHeapMB.toFixed(0)}MB`;
                            const color = maxHeapMB > 3000 ? '#d32f2f' : maxHeapMB > 2000 ? '#ed6c02' : '#666';
                            return <span style={{ color, fontWeight: maxHeapMB > 2000 ? 'bold' : 'normal' }}>{label}</span>;
                          })()}
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
                          {(() => {
                            const sat = session.satisfactionScore;
                            if (scoringSessionIds.has(session.sessionId) && !sat) {
                              return <CircularProgress size={16} />;
                            }
                            if (failedScoringIds.has(session.sessionId) && !sat) {
                              return (
                                <Tooltip title="Scoring failed. Click to retry.">
                                  <IconButton
                                    size="small"
                                    color="error"
                                    onClick={async () => {
                                      setFailedScoringIds((prev) => {
                                        const next = new Set(prev);
                                        next.delete(session.sessionId);
                                        return next;
                                      });
                                      setScoringSessionIds((prev) => new Set(prev).add(session.sessionId));
                                      try {
                                        const response = await axios.post(
                                          buildApiUrl("/api/admin/chat-sessions/score"),
                                          { sessionIds: [session.sessionId] },
                                          { headers: { Authorization: `Bearer ${token}` }, timeout: 30000 }
                                        );
                                        const { scores, failed = [] } = response.data;
                                        const newScore = scores[session.sessionId];
                                        if (newScore) {
                                          setChatSessions((prev) =>
                                            prev.map((s) =>
                                              s.sessionId === session.sessionId ? { ...s, satisfactionScore: newScore } : s
                                            )
                                          );
                                        }
                                        if (failed.includes(session.sessionId)) {
                                          setFailedScoringIds((prev) => new Set(prev).add(session.sessionId));
                                        }
                                      } catch {
                                        setFailedScoringIds((prev) => new Set(prev).add(session.sessionId));
                                      } finally {
                                        setScoringSessionIds((prev) => {
                                          const next = new Set(prev);
                                          next.delete(session.sessionId);
                                          return next;
                                        });
                                      }
                                    }}
                                  >
                                    <ReplayIcon sx={{ fontSize: '1rem' }} />
                                  </IconButton>
                                </Tooltip>
                              );
                            }
                            if (!sat && (!session.judgeScores || Object.keys(session.judgeScores).length === 0)) {
                              return <span style={{ color: '#999' }}>-</span>;
                            }
                            const chips: React.ReactNode[] = [];
                            if (sat) {
                              const color = sat.score <= 2 ? 'error' : sat.score === 3 ? 'warning' : 'success';
                              const dimSummary = sat.dimensions
                                ? ` | Goal:${sat.dimensions.goalCompletion} Accuracy:${sat.dimensions.dataAccuracy} Quality:${sat.dimensions.outputQuality}`
                                : '';
                              chips.push(
                                <Tooltip key="default" title={`Default: ${sat.reason}${dimSummary}${sat.adminOverride ? ' (admin override)' : ''}`}>
                                  <Chip
                                    label={`Default: ${sat.score}`}
                                    size="small"
                                    color={color}
                                    variant={sat.adminOverride ? 'filled' : 'outlined'}
                                    icon={sat.adminOverride ? <EditIcon sx={{ fontSize: '0.8rem' }} /> : undefined}
                                    onClick={(e) => {
                                      setScoreOverrideAnchor(e.currentTarget);
                                      setScoreOverrideSession(session);
                                      setScoreOverrideValue(sat.score);
                                      setScoreOverrideReason(sat.reason);
                                    }}
                                    sx={{ cursor: 'pointer' }}
                                  />
                                </Tooltip>
                              );
                              if (sat.dimensions) {
                                const { goalCompletion, dataAccuracy, outputQuality } = sat.dimensions;
                                const dimColor = (v: number) => v <= 2 ? 'error' : v === 3 ? 'warning' : 'success';
                                chips.push(
                                  <Tooltip key="dim-goal" title="Goal completion"><Chip label={`G:${goalCompletion}`} size="small" color={dimColor(goalCompletion) as any} variant="outlined" sx={{ fontSize: '0.65rem', height: 18 }} /></Tooltip>,
                                  <Tooltip key="dim-acc" title="Data accuracy"><Chip label={`A:${dataAccuracy}`} size="small" color={dimColor(dataAccuracy) as any} variant="outlined" sx={{ fontSize: '0.65rem', height: 18 }} /></Tooltip>,
                                  <Tooltip key="dim-qual" title="Output quality"><Chip label={`Q:${outputQuality}`} size="small" color={dimColor(outputQuality) as any} variant="outlined" sx={{ fontSize: '0.65rem', height: 18 }} /></Tooltip>,
                                );
                              }
                            }
                            if (session.judgeScores) {
                              Object.entries(session.judgeScores).forEach(([jId, jScore]) => {
                                const jColor = jScore.score <= 2 ? 'error' : jScore.score === 3 ? 'warning' : 'success';
                                const jDimSummary = jScore.dimensions
                                  ? ` | Goal:${jScore.dimensions.goalCompletion} Accuracy:${jScore.dimensions.dataAccuracy} Quality:${jScore.dimensions.outputQuality}`
                                  : '';
                                chips.push(
                                  <Tooltip key={jId} title={`${jScore.judgeName}: ${jScore.reason}${jDimSummary}`}>
                                    <Chip
                                      label={`${jScore.judgeName}: ${jScore.score}`}
                                      size="small"
                                      color={jColor as any}
                                      variant="outlined"
                                    />
                                  </Tooltip>
                                );
                              });
                            }
                            return (
                              <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
                                {chips}
                              </Box>
                            );
                          })()}
                        </TableCell>
                        <TableCell>
                          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                            <Button
                              variant="outlined"
                              size="small"
                              component={RouterLink}
                              to={buildAgentRunInspectorUrl({ sessionId: session.sessionId })}
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
                        <TableCell colSpan={15} align="center">
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

        <TabPanel value={tabValue} index={14}>
          <ResultEndpointsTab />
        </TabPanel>

        <TabPanel value={tabValue} index={15}>
          <ScoringJudgesTab />
        </TabPanel>

        <TabPanel value={tabValue} index={16}>
          <CrmTab />
        </TabPanel>
        <TabPanel value={tabValue} index={17}>
          <RevenueTab />
        </TabPanel>
        <TabPanel value={tabValue} index={18}>
          <FunnelTab />
        </TabPanel>

        <TabPanel value={tabValue} index={19}>
          <AlertEmailsTab />
        </TabPanel>

        <TabPanel value={tabValue} index={20}>
          <OnboardingTab />
        </TabPanel>

        <TabPanel value={tabValue} index={21}>
          <ConnectedAccountsTab />
        </TabPanel>

        <TabPanel value={tabValue} index={22}>
          <ContractorsTab />
        </TabPanel>

        <TabPanel value={tabValue} index={23}>
          <EmmaMcpUsageTab />
        </TabPanel>

      </Paper>

      {/* Satisfaction Score Override Popover */}
      <Popover
        open={Boolean(scoreOverrideAnchor)}
        anchorEl={scoreOverrideAnchor}
        onClose={() => { setScoreOverrideAnchor(null); setScoreOverrideSession(null); }}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        transformOrigin={{ vertical: 'top', horizontal: 'center' }}
      >
        <Box sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 1.5, width: 400 }}>
          <Typography variant="subtitle2">Override Satisfaction Score</Typography>
          <ButtonGroup size="small" fullWidth>
            {[1, 2, 3, 4, 5].map((v) => (
              <Button
                key={v}
                variant={scoreOverrideValue === v ? 'contained' : 'outlined'}
                color={v <= 2 ? 'error' : v === 3 ? 'warning' : 'success'}
                onClick={() => setScoreOverrideValue(v)}
              >
                {v}
              </Button>
            ))}
          </ButtonGroup>
          <TextField
            size="small"
            label="Reason (optional)"
            value={scoreOverrideReason}
            onChange={(e) => setScoreOverrideReason(e.target.value)}
            multiline
            minRows={3}
            maxRows={8}
          />
          <Button variant="contained" size="small" onClick={handleScoreOverrideSave}>
            Save
          </Button>
        </Box>
      </Popover>

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

      {/* Grant Token Bonus Dialog */}
      <Dialog open={introEmailDialogOpen} onClose={() => setIntroEmailDialogOpen(false)}>
        <DialogTitle>Send Team Introduction Email</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Send a team introduction email to <strong>{introEmailUserEmail}</strong>? The email will be CC'd to founders@agentweb.pro so the conversation can continue from there.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setIntroEmailDialogOpen(false)} disabled={introEmailLoading}>Cancel</Button>
          <Button onClick={handleSendIntroEmail} variant="contained" disabled={introEmailLoading}>
            {introEmailLoading ? <CircularProgress size={24} /> : "Send"}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={grantBonusDialogOpen} onClose={() => setGrantBonusDialogOpen(false)}>
        <DialogTitle>Grant Bonus Tokens</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ mb: 2 }}>
            Grant additional tokens to <strong>{grantBonusEmail}</strong> for the current month.
          </DialogContentText>
          <TextField
            autoFocus
            fullWidth
            label="Bonus Tokens"
            value={grantBonusAmount}
            onChange={(e) => setGrantBonusAmount(e.target.value)}
            placeholder="e.g. 50000"
            type="text"
            inputProps={{ inputMode: 'numeric', pattern: '[0-9,]*' }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setGrantBonusDialogOpen(false)} disabled={grantBonusLoading}>
            Cancel
          </Button>
          <Button
            onClick={handleGrantTokenBonus}
            variant="contained"
            disabled={grantBonusLoading || !grantBonusAmount}
          >
            {grantBonusLoading ? <CircularProgress size={24} /> : "Grant"}
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
          <FormControlLabel
            control={
              <Checkbox
                checked={selectedUserRoles.includes("contractor")}
                onChange={() => handleRoleCheckboxChange("contractor")}
                name="contractorRole"
              />
            }
            label="Contractor Access"
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
          setGoogleAnalyticsProperties([]);
          setPrimaryAnalyticsPropertyId("");
          setGaFilteredDomainsText("");
          setClarityProjectId("");
          setClarityProjects([]);
          setProductDomain("");
        }}
        maxWidth="md"
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
              setGoogleAnalyticsProperties([]);
              setPrimaryAnalyticsPropertyId("");
              setGaFilteredDomainsText("");
              setClarityProjectId("");
              setClarityProjects([]);
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
        {editingUserOrgId && (
          <Typography variant="caption" display="block" sx={{ px: 3, color: 'text.secondary' }}>
            This is the organization-wide analytics config — shared by all members.
          </Typography>
        )}
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
                placeholder="example.com&#10;https://subdomain.example.com/&#10;another-domain.com"
                helperText="Enter one domain per line. For Domain properties: example.com (no https://). For URL-prefix properties: https://example.com/ (with https:// and trailing slash)"
                disabled={seoDomainsEditLoading}
              />
            </Grid>
            {editingUserIsOrgOwner && (
              <Grid item xs={12}>
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={shareAnalyticsWithOrg}
                      onChange={(e) => setShareAnalyticsWithOrg(e.target.checked)}
                      disabled={seoDomainsEditLoading}
                    />
                  }
                  label="Share analytics with organization"
                />
                <Typography variant="caption" display="block" sx={{ color: 'text.secondary' }}>
                  When on, every member of this org sees this owner's analytics
                  (GA4, Search Console, Clarity, funnels run against this property).
                </Typography>
              </Grid>
            )}
            <Grid item xs={12}>
              <Box>
                <Typography variant="subtitle2" sx={{ mb: 1 }}>
                  Google Analytics 4 Properties
                </Typography>
                {googleAnalyticsProperties.map((property, index) => (
                  <Box key={index} sx={{ display: 'flex', gap: 1, mb: 1 }}>
                    <TextField
                      size="small"
                      label="Label"
                      value={property.label}
                      onChange={(e) => {
                        const newProps = [...googleAnalyticsProperties];
                        newProps[index].label = e.target.value;
                        setGoogleAnalyticsProperties(newProps);
                      }}
                      placeholder="Main Website"
                      sx={{ flex: 1 }}
                      disabled={seoDomainsEditLoading}
                    />
                    <TextField
                      size="small"
                      label="Property ID"
                      value={property.propertyId}
                      onChange={(e) => {
                        const newProps = [...googleAnalyticsProperties];
                        newProps[index].propertyId = e.target.value;
                        setGoogleAnalyticsProperties(newProps);
                      }}
                      placeholder="123456789"
                      sx={{ flex: 1 }}
                      disabled={seoDomainsEditLoading}
                    />
                    <IconButton
                      size="small"
                      onClick={() => {
                        const newProps = googleAnalyticsProperties.filter((_, i) => i !== index);
                        setGoogleAnalyticsProperties(newProps);
                      }}
                      disabled={seoDomainsEditLoading}
                      color="error"
                    >
                      <DeleteIcon />
                    </IconButton>
                  </Box>
                ))}
                <Button
                  startIcon={<AddIcon />}
                  onClick={() => {
                    setGoogleAnalyticsProperties([...googleAnalyticsProperties, { propertyId: '', label: '' }]);
                  }}
                  disabled={seoDomainsEditLoading}
                  size="small"
                >
                  Add GA4 Property
                </Button>
                <Typography variant="caption" display="block" sx={{ mt: 1, color: 'text.secondary' }}>
                  Enter your Google Analytics 4 Property IDs (numeric, e.g., 123456789). You can find this in GA4 Admin &gt; Property Settings.
                </Typography>
              </Box>
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
              <Box>
                <Typography variant="subtitle2" sx={{ mb: 1 }}>
                  Microsoft Clarity Projects
                </Typography>
                {clarityProjects.map((project, index) => (
                  <Box key={index} sx={{ display: 'flex', gap: 1, mb: 1 }}>
                    <TextField
                      size="small"
                      label="Label"
                      value={project.label}
                      onChange={(e) => {
                        const newProjects = [...clarityProjects];
                        newProjects[index].label = e.target.value;
                        setClarityProjects(newProjects);
                      }}
                      placeholder="Main Site"
                      sx={{ flex: 1 }}
                      disabled={seoDomainsEditLoading}
                    />
                    <TextField
                      size="small"
                      label="Project ID"
                      value={project.projectId}
                      onChange={(e) => {
                        const newProjects = [...clarityProjects];
                        newProjects[index].projectId = e.target.value;
                        setClarityProjects(newProjects);
                      }}
                      placeholder="ul13e4f7fe"
                      sx={{ flex: 1 }}
                      disabled={seoDomainsEditLoading}
                    />
                    <IconButton
                      size="small"
                      onClick={() => {
                        const newProjects = clarityProjects.filter((_, i) => i !== index);
                        setClarityProjects(newProjects);
                      }}
                      disabled={seoDomainsEditLoading}
                      color="error"
                    >
                      <DeleteIcon />
                    </IconButton>
                  </Box>
                ))}
                <Button
                  startIcon={<AddIcon />}
                  onClick={() => {
                    setClarityProjects([...clarityProjects, { projectId: '', label: '' }]);
                  }}
                  disabled={seoDomainsEditLoading}
                  size="small"
                >
                  Add Clarity Project
                </Button>
                <Typography variant="caption" display="block" sx={{ mt: 1, color: 'text.secondary' }}>
                  Enter your Microsoft Clarity Project IDs (e.g., ul13e4f7fe). You can find this in Clarity project settings.
                </Typography>
              </Box>
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
              setGoogleAnalyticsProperties([]);
              setPrimaryAnalyticsPropertyId("");
              setGaFilteredDomainsText("");
              setClarityProjectId("");
              setClarityProjects([]);
              setProductDomain("");
            }}
            disabled={seoDomainsEditLoading || seoAeoDialogLoading}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSaveSeoDomains}
            color="primary"
            variant="contained"
            disabled={seoDomainsEditLoading || seoAeoDialogLoading}
          >
            {seoDomainsEditLoading ? "Saving..." : "Save"}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Google Drive Shared Folders Dialog */}
      <Dialog
        open={googleDriveFoldersDialogOpen}
        onClose={() => {
          setGoogleDriveFoldersDialogOpen(false);
          setEditingGoogleDriveFoldersUserId(null);
          setGoogleDriveFolderEntries([]);
          setAvailableGoogleDriveFolders([]);
        }}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>
          Configure Google Drive Shared Folders
          <IconButton
            aria-label="close"
            onClick={() => {
              setGoogleDriveFoldersDialogOpen(false);
              setEditingGoogleDriveFoldersUserId(null);
              setGoogleDriveFolderEntries([]);
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
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Select folders that have been shared with the service account. These folders will appear on the customer&apos;s Knowledge Base page.
          </Typography>
          {googleDriveFoldersListLoading ? (
            <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
              <CircularProgress size={24} />
              <Typography variant="body2" sx={{ ml: 2 }}>Loading folders from Google Drive...</Typography>
            </Box>
          ) : availableGoogleDriveFolders.length === 0 ? (
            <Typography variant="body2" color="text.secondary" sx={{ py: 2, textAlign: "center" }}>
              No folders found. Make sure folders have been shared with the service account.
            </Typography>
          ) : (
            <Box>
              {availableGoogleDriveFolders.map((folder) => {
                const isSelected = googleDriveFolderEntries.some((e) => e.folderId === folder.folderId);
                return (
                  <FormControlLabel
                    key={folder.folderId}
                    control={
                      <Checkbox
                        checked={isSelected}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setGoogleDriveFolderEntries([...googleDriveFolderEntries, { folderId: folder.folderId, name: folder.name }]);
                          } else {
                            setGoogleDriveFolderEntries(googleDriveFolderEntries.filter((entry) => entry.folderId !== folder.folderId));
                          }
                        }}
                        disabled={googleDriveFoldersEditLoading}
                      />
                    }
                    label={
                      <Box>
                        <Typography variant="body2">{folder.name}</Typography>
                        <Typography variant="caption" color="text.secondary">{folder.folderId}</Typography>
                      </Box>
                    }
                    sx={{ display: "flex", alignItems: "flex-start", mb: 1, width: "100%" }}
                  />
                );
              })}
            </Box>
          )}
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => {
              setGoogleDriveFoldersDialogOpen(false);
              setEditingGoogleDriveFoldersUserId(null);
              setGoogleDriveFolderEntries([]);
            }}
            disabled={googleDriveFoldersEditLoading}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSaveGoogleDriveFolders}
            color="primary"
            variant="contained"
            disabled={googleDriveFoldersEditLoading}
          >
            {googleDriveFoldersEditLoading ? "Saving..." : "Save"}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Slack Channels Configuration Dialog */}
      <Dialog
        open={slackChannelDialogOpen}
        onClose={() => {
          setSlackChannelDialogOpen(false);
          setEditingSlackChannelUserId(null);
          setCurrentSlackChannels([]);
          setSlackChannelInputText("");
        }}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>
          Configure Slack Channels
          <IconButton
            aria-label="close"
            onClick={() => {
              setSlackChannelDialogOpen(false);
              setEditingSlackChannelUserId(null);
              setCurrentSlackChannels([]);
              setSlackChannelNames({});
              setSlackChannelInputText("");
            }}
            sx={{ position: 'absolute', right: 8, top: 8 }}
          >
            <CloseIcon />
          </IconButton>
        </DialogTitle>
        <DialogContent dividers>
          <Box sx={{ mb: 2 }}>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
              Configured channels (agent tools are restricted to these):
            </Typography>
            <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5, minHeight: 32 }}>
              {currentSlackChannels.length === 0 && (
                <Typography variant="body2" color="text.disabled">No channels configured</Typography>
              )}
              {currentSlackChannels.map((ch) => (
                <Chip
                  key={ch}
                  label={slackChannelNames[ch] ? `${slackChannelNames[ch]} (${ch})` : ch}
                  size="small"
                  onDelete={() => setCurrentSlackChannels((prev) => prev.filter((c) => c !== ch))}
                  disabled={slackChannelEditLoading}
                />
              ))}
            </Box>
          </Box>
          <Box sx={{ display: "flex", gap: 1 }}>
            <TextField
              autoFocus
              fullWidth
              size="small"
              label="Add Slack Channel ID"
              value={slackChannelInputText}
              onChange={(e) => setSlackChannelInputText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  const val = slackChannelInputText.trim();
                  if (val && !currentSlackChannels.includes(val)) {
                    setCurrentSlackChannels((prev) => [...prev, val]);
                    resolveSlackChannelNames([val]);
                  }
                  setSlackChannelInputText("");
                }
              }}
              placeholder="C1234567890"
              helperText="Enter a channel ID and press Enter or click Add"
              disabled={slackChannelEditLoading}
            />
            <Button
              variant="outlined"
              size="small"
              sx={{ mt: 0, mb: "auto", height: 40, whiteSpace: "nowrap" }}
              disabled={slackChannelEditLoading || !slackChannelInputText.trim()}
              onClick={() => {
                const val = slackChannelInputText.trim();
                if (val && !currentSlackChannels.includes(val)) {
                  setCurrentSlackChannels((prev) => [...prev, val]);
                  resolveSlackChannelNames([val]);
                }
                setSlackChannelInputText("");
              }}
            >
              Add
            </Button>
          </Box>
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => {
              setSlackChannelDialogOpen(false);
              setEditingSlackChannelUserId(null);
              setCurrentSlackChannels([]);
              setSlackChannelNames({});
              setSlackChannelInputText("");
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

      {/* Secrets Configuration Dialog */}
      <Dialog
        open={secretsDialogOpen}
        onClose={() => {
          setSecretsDialogOpen(false);
          setEditingSecretsUserId(null);
          setSecretEntries([]);
        }}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>
          Configure Secrets
          <IconButton
            aria-label="close"
            onClick={() => {
              setSecretsDialogOpen(false);
              setEditingSecretsUserId(null);
              setSecretEntries([]);
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
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Enter secret variable names and values. Values are encrypted at rest. Leave value empty to keep existing value unchanged.
          </Typography>
          {secretEntries.map((entry, idx) => (
            <Box key={idx} sx={{ display: "flex", gap: 1, mb: 1, alignItems: "center" }}>
              <TextField
                size="small"
                label="Name"
                value={entry.name}
                onChange={(e) => {
                  const updated = [...secretEntries];
                  updated[idx] = { ...updated[idx], name: e.target.value };
                  setSecretEntries(updated);
                }}
                placeholder="github_access_token"
                disabled={secretsEditLoading}
                sx={{ flex: 1 }}
              />
              <TextField
                size="small"
                label="Value"
                type="password"
                value={entry.value}
                onChange={(e) => {
                  const updated = [...secretEntries];
                  updated[idx] = { ...updated[idx], value: e.target.value };
                  setSecretEntries(updated);
                }}
                placeholder={
                  editingSecretsUserId &&
                  contextUsers.find((u: User) => u.userId === editingSecretsUserId)?.secretNames?.includes(entry.name)
                    ? "••••••• (unchanged)"
                    : "Enter value"
                }
                disabled={secretsEditLoading}
                sx={{ flex: 1 }}
              />
              <IconButton
                size="small"
                onClick={() => {
                  setSecretEntries(secretEntries.filter((_, i) => i !== idx));
                }}
                disabled={secretsEditLoading || secretEntries.length <= 1}
              >
                <CloseIcon fontSize="small" />
              </IconButton>
            </Box>
          ))}
          <Button
            size="small"
            onClick={() => setSecretEntries([...secretEntries, { name: "", value: "" }])}
            disabled={secretsEditLoading}
            sx={{ mt: 1 }}
          >
            + Add Secret
          </Button>
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => {
              setSecretsDialogOpen(false);
              setEditingSecretsUserId(null);
              setSecretEntries([]);
            }}
            disabled={secretsEditLoading}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSaveSecrets}
            color="primary"
            variant="contained"
            disabled={secretsEditLoading}
          >
            {secretsEditLoading ? "Saving..." : "Save"}
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
            helperText="Minimum 12 characters"
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

      <Dialog
        open={crmSyncDialogOpen}
        onClose={() => setCrmSyncDialogOpen(false)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>
          Sync {crmSyncSource === "users" ? "Users" : "Waitlist"} to CRM
        </DialogTitle>
        <DialogContent>
          {crmSyncLoading ? (
            <Box sx={{ display: "flex", justifyContent: "center", py: 3 }}>
              <CircularProgress size={24} />
            </Box>
          ) : (
            <Box sx={{ pt: 1 }}>
              <TextField
                fullWidth
                label="Lead List ID"
                value={crmSyncListId}
                onChange={(e) => setCrmSyncListId(e.target.value)}
                helperText="Configured in CRM lead list API Integration"
                disabled={crmSyncSaving || crmSyncRunning}
                sx={{ mb: 2 }}
              />
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                Last sync: {crmSyncLastSyncAt ? new Date(crmSyncLastSyncAt).toLocaleString() : "Never"}
              </Typography>
              <FormControlLabel
                control={
                  <Checkbox
                    checked={crmSyncForceFull}
                    onChange={(e) => setCrmSyncForceFull(e.target.checked)}
                    disabled={crmSyncRunning}
                  />
                }
                label="Force full sync"
              />
              {crmSyncSource === "users" && (
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={crmSyncAutoSync}
                      onChange={(e) => setCrmSyncAutoSync(e.target.checked)}
                      disabled={crmSyncSaving || crmSyncRunning}
                    />
                  }
                  label="Auto-sync new users to this lead list"
                />
              )}
            </Box>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCrmSyncDialogOpen(false)} disabled={crmSyncSaving || crmSyncRunning}>
            Close
          </Button>
          <Button
            variant="outlined"
            onClick={handleSaveCrmSyncConfig}
            disabled={crmSyncLoading || crmSyncSaving || crmSyncRunning || !crmSyncListId.trim()}
          >
            {crmSyncSaving ? <CircularProgress size={20} /> : "Save"}
          </Button>
          <Button
            variant="contained"
            onClick={handleStartCrmSync}
            disabled={crmSyncLoading || crmSyncSaving || crmSyncRunning || !crmSyncListId.trim()}
          >
            {crmSyncRunning ? <CircularProgress size={20} /> : "Start Syncing"}
          </Button>
        </DialogActions>
      </Dialog>
    </Container>
  );
}

// Image API models offered in the Agent Mode settings dropdown below.
// Keep in sync with the backend AgentModeService.IMAGE_API_MODELS.
// 'gemini-3.1-flash-image-preview' is retained as a legacy alias of the GA
// 'gemini-3.1-flash-image' so a previously-saved default still renders/validates.
export const IMAGE_API_MODELS = ['gemini-3-pro-image-preview', 'gemini-3.1-flash-image', 'gemini-3.1-flash-image-preview', 'gpt-image-1', 'gpt-image-2', 'gemini-2.5-flash-image'];

// Agent Mode Settings Component
const AgentModeSettings = () => {
  const [systemPrompt, setSystemPrompt] = useState('');
  const [sidebarAddendum, setSidebarAddendum] = useState('');
  const [welcomeMessage, setWelcomeMessage] = useState('');
  const [, setConversationStarters] = useState<string[]>([]);
  const [conversationStartersText, setConversationStartersText] = useState('');
  const [defaultModel, setDefaultModel] = useState('gpt-5-chat-2');
  const [supportedModels, setSupportedModels] = useState<string[]>([]);
  const [contentModel, setContentModel] = useState('');
  const [loading, setLoading] = useState(true);
  const [savingDefaultModel, setSavingDefaultModel] = useState(false);
  const [savingSystemPrompt, setSavingSystemPrompt] = useState(false);
  const [savingWelcomeMessage, setSavingWelcomeMessage] = useState(false);
  const [savingConversationStarters, setSavingConversationStarters] = useState(false);
  const [savingContentModel, setSavingContentModel] = useState(false);
  const [scheduledChatsDefaultModel, setScheduledChatsDefaultModel] = useState('');
  const [savingScheduledChatsDefaultModel, setSavingScheduledChatsDefaultModel] = useState(false);
  const [reportGenerationDefaultModel, setReportGenerationDefaultModel] = useState('');
  const [savingReportGenerationDefaultModel, setSavingReportGenerationDefaultModel] = useState(false);
  const [imageGenerationDefaultModel, setImageGenerationDefaultModel] = useState('');
  const [savingImageGenerationDefaultModel, setSavingImageGenerationDefaultModel] = useState(false);
  const [imageApiDefaultModel, setImageApiDefaultModel] = useState('');
  const [savingImageApiDefaultModel, setSavingImageApiDefaultModel] = useState(false);
  const [videoApiDefaultModel, setVideoApiDefaultModel] = useState('');
  const [savingVideoApiDefaultModel, setSavingVideoApiDefaultModel] = useState(false);
  const [videoGenerationDefaultModel, setVideoGenerationDefaultModel] = useState('');
  const [savingVideoGenerationDefaultModel, setSavingVideoGenerationDefaultModel] = useState(false);
  const [customerSupportDefaultModel, setCustomerSupportDefaultModel] = useState('');
  const [savingCustomerSupportDefaultModel, setSavingCustomerSupportDefaultModel] = useState(false);
  const [codingAgentDefaultModel, setCodingAgentDefaultModel] = useState('');
  const [savingCodingAgentDefaultModel, setSavingCodingAgentDefaultModel] = useState(false);
  const [visionModel, setVisionModel] = useState('');
  const [visionModelOptions, setVisionModelOptions] = useState<string[]>([]);
  const [savingVisionModel, setSavingVisionModel] = useState(false);
  const [backupModel, setBackupModel] = useState('');
  const [savingBackupModel, setSavingBackupModel] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const { token } = useAuth();
  const fallbackDefaultModel = 'gpt-5-chat-2';

  useEffect(() => {
    loadAllSettings();
  }, []);


  const loadAllSettings = async () => {
    try {
      setLoading(true);
      setError('');

      const models = await loadSupportedModels();
      await loadDefaultModel(models);

      // Load system prompt and sidebar addendum
      await Promise.all([loadSystemPrompt(), loadSidebarAddendum()]);

      // Load welcome message
      await loadWelcomeMessage();

      // Load conversation starters
      await loadConversationStarters();

      // Load content model
      await loadContentModel();

      // Load scheduled chats default model
      await loadScheduledChatsDefaultModel(models);

      // Load report generation default model
      await loadReportGenerationDefaultModel(models);

      // Load image generation default model (LLM session model)
      await loadImageGenerationDefaultModel(models);

      // Load image API default model
      await loadImageApiDefaultModel();

      // Load video API default model
      await loadVideoApiDefaultModel();

      // Load video generation default model
      await loadVideoGenerationDefaultModel(models);

      // Load customer support default model
      await loadCustomerSupportDefaultModel(models);

      // Load coding agent default model
      await loadCodingAgentDefaultModel(models);

      // Load vision model (describe_image tool) + its vision-ready options
      const visionModels = await loadVisionModelOptions();
      await loadVisionModel(visionModels);

      // Load backup model
      await loadBackupModel(models);
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


  const loadSystemPrompt = async () => {
    try {
      // System prompt is code-controlled (backend/src/docs/agentModeSystemPrompt.ts).
      // Always load from the code-backed endpoint — AW-Settings is no longer used.
      const response = await axios.get(buildApiUrl('/api/agent-mode/system-prompt'), {
        headers: { Authorization: `Bearer ${token}` }
      });
      setSystemPrompt(response.data);
    } catch (error) {
      console.error('Error loading system prompt:', error);
      throw error;
    }
  };

  const loadSidebarAddendum = async () => {
    try {
      const response = await axios.get(buildApiUrl('/api/chatbot/system-prompt'), {
        headers: { Authorization: `Bearer ${token}` }
      });
      setSidebarAddendum(response.data);
    } catch (error) {
      console.error('Error loading sidebar addendum:', error);
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

  const loadScheduledChatsDefaultModel = async (models: string[] = []) => {
    const availableModels = models.length > 0 ? models : [fallbackDefaultModel, 'gemini-3-pro-preview'];
    try {
      const response = await axios.get(buildApiUrl('/api/settings/agent_mode_scheduled_chats_default_model'), {
        headers: { Authorization: `Bearer ${token}` }
      });

      if (response.data && response.data.settingValue) {
        const configuredModel = response.data.settingValue.trim();
        if (configuredModel && availableModels.includes(configuredModel)) {
          setScheduledChatsDefaultModel(configuredModel);
          return;
        }
      }
    } catch (settingsError: any) {
      if (settingsError.response?.status !== 404) {
        console.error('Error loading scheduled chats default model:', settingsError);
      }
    }
    // Empty means "use general default"
    setScheduledChatsDefaultModel('');
  };

  const saveScheduledChatsDefaultModel = async () => {
    try {
      setSavingScheduledChatsDefaultModel(true);
      setError('');
      setSuccess('');

      if (scheduledChatsDefaultModel) {
        await axios.put(buildApiUrl('/api/settings/agent_mode_scheduled_chats_default_model'), {
          settingValue: scheduledChatsDefaultModel,
          description: 'Default LLM model for scheduled chats (overrides the general default model)'
        }, {
          headers: { Authorization: `Bearer ${token}` }
        });
      } else {
        // Empty means "use general default" — delete the override
        await axios.delete(buildApiUrl('/api/settings/agent_mode_scheduled_chats_default_model'), {
          headers: { Authorization: `Bearer ${token}` }
        });
      }

      setSuccess('Scheduled chats default model updated successfully!');
    } catch (error) {
      console.error('Error saving scheduled chats default model:', error);
      setError('Failed to save scheduled chats default model');
    } finally {
      setSavingScheduledChatsDefaultModel(false);
    }
  };

  const loadReportGenerationDefaultModel = async (models: string[] = []) => {
    const availableModels = models.length > 0 ? models : [fallbackDefaultModel, 'gemini-3-pro-preview'];
    try {
      const response = await axios.get(buildApiUrl('/api/settings/agent_mode_report_generation_default_model'), {
        headers: { Authorization: `Bearer ${token}` }
      });

      if (response.data && response.data.settingValue) {
        const configuredModel = response.data.settingValue.trim();
        if (configuredModel && availableModels.includes(configuredModel)) {
          setReportGenerationDefaultModel(configuredModel);
          return;
        }
      }
    } catch (settingsError: any) {
      if (settingsError.response?.status !== 404) {
        console.error('Error loading report generation default model:', settingsError);
      }
    }
    setReportGenerationDefaultModel('');
  };

  const saveReportGenerationDefaultModel = async () => {
    try {
      setSavingReportGenerationDefaultModel(true);
      setError('');
      setSuccess('');

      if (reportGenerationDefaultModel) {
        await axios.put(buildApiUrl('/api/settings/agent_mode_report_generation_default_model'), {
          settingValue: reportGenerationDefaultModel,
          description: 'Default LLM model for report generation (overrides the general default model)'
        }, {
          headers: { Authorization: `Bearer ${token}` }
        });
      } else {
        await axios.delete(buildApiUrl('/api/settings/agent_mode_report_generation_default_model'), {
          headers: { Authorization: `Bearer ${token}` }
        });
      }

      setSuccess('Report generation default model updated successfully!');
    } catch (error) {
      console.error('Error saving report generation default model:', error);
      setError('Failed to save report generation default model');
    } finally {
      setSavingReportGenerationDefaultModel(false);
    }
  };

  const loadImageGenerationDefaultModel = async (models: string[] = []) => {
    const availableModels = models.length > 0 ? models : [fallbackDefaultModel, 'gemini-3-pro-preview'];
    try {
      const response = await axios.get(buildApiUrl('/api/settings/agent_mode_image_generation_default_model'), {
        headers: { Authorization: `Bearer ${token}` }
      });

      if (response.data && response.data.settingValue) {
        const configuredModel = response.data.settingValue.trim();
        if (configuredModel && availableModels.includes(configuredModel)) {
          setImageGenerationDefaultModel(configuredModel);
          return;
        }
      }
    } catch (settingsError: any) {
      if (settingsError.response?.status !== 404) {
        console.error('Error loading image generation default model:', settingsError);
      }
    }
    setImageGenerationDefaultModel('');
  };

  const saveImageGenerationDefaultModel = async () => {
    try {
      setSavingImageGenerationDefaultModel(true);
      setError('');
      setSuccess('');

      if (imageGenerationDefaultModel) {
        await axios.put(buildApiUrl('/api/settings/agent_mode_image_generation_default_model'), {
          settingValue: imageGenerationDefaultModel,
          description: 'Default LLM model for image generation (overrides the general default model)'
        }, {
          headers: { Authorization: `Bearer ${token}` }
        });
      } else {
        await axios.delete(buildApiUrl('/api/settings/agent_mode_image_generation_default_model'), {
          headers: { Authorization: `Bearer ${token}` }
        });
      }

      setSuccess('Image generation default model updated successfully!');
    } catch (error) {
      console.error('Error saving image generation default model:', error);
      setError('Failed to save image generation default model');
    } finally {
      setSavingImageGenerationDefaultModel(false);
    }
  };

  const loadImageApiDefaultModel = async () => {
    try {
      const response = await axios.get(buildApiUrl('/api/settings/agent_mode_image_api_default_model'), {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (response.data && response.data.settingValue) {
        const configuredModel = response.data.settingValue.trim();
        if (configuredModel && IMAGE_API_MODELS.includes(configuredModel)) {
          setImageApiDefaultModel(configuredModel);
          return;
        }
      }
    } catch (settingsError: any) {
      if (settingsError.response?.status !== 404) {
        console.error('Error loading image API default model:', settingsError);
      }
    }
    setImageApiDefaultModel('');
  };

  const saveImageApiDefaultModel = async () => {
    try {
      setSavingImageApiDefaultModel(true);
      setError('');
      setSuccess('');

      if (imageApiDefaultModel) {
        await axios.put(buildApiUrl('/api/settings/agent_mode_image_api_default_model'), {
          settingValue: imageApiDefaultModel,
          description: 'Default image API model for generate_image tool (e.g. gemini-3-pro-image-preview)'
        }, {
          headers: { Authorization: `Bearer ${token}` }
        });
      } else {
        await axios.delete(buildApiUrl('/api/settings/agent_mode_image_api_default_model'), {
          headers: { Authorization: `Bearer ${token}` }
        });
      }

      setSuccess('Image API default model updated successfully!');
    } catch (error) {
      console.error('Error saving image API default model:', error);
      setError('Failed to save image API default model');
    } finally {
      setSavingImageApiDefaultModel(false);
    }
  };

  const VIDEO_API_MODELS = ['veo-3.1-generate-preview', 'veo-3-generate-preview'];

  const loadVideoApiDefaultModel = async () => {
    try {
      const response = await axios.get(buildApiUrl('/api/settings/agent_mode_video_api_default_model'), {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (response.data && response.data.settingValue) {
        const configuredModel = response.data.settingValue.trim();
        if (configuredModel && VIDEO_API_MODELS.includes(configuredModel)) {
          setVideoApiDefaultModel(configuredModel);
          return;
        }
      }
    } catch (settingsError: any) {
      if (settingsError.response?.status !== 404) {
        console.error('Error loading video API default model:', settingsError);
      }
    }
    setVideoApiDefaultModel('');
  };

  const saveVideoApiDefaultModel = async () => {
    try {
      setSavingVideoApiDefaultModel(true);
      setError('');
      setSuccess('');

      if (videoApiDefaultModel) {
        await axios.put(buildApiUrl('/api/settings/agent_mode_video_api_default_model'), {
          settingValue: videoApiDefaultModel,
          description: 'Default video API model for generate_video tool (e.g. veo-3.1-generate-preview)'
        }, {
          headers: { Authorization: `Bearer ${token}` }
        });
      } else {
        await axios.delete(buildApiUrl('/api/settings/agent_mode_video_api_default_model'), {
          headers: { Authorization: `Bearer ${token}` }
        });
      }

      setSuccess('Video API default model updated successfully!');
    } catch (error) {
      console.error('Error saving video API default model:', error);
      setError('Failed to save video API default model');
    } finally {
      setSavingVideoApiDefaultModel(false);
    }
  };

  const loadVideoGenerationDefaultModel = async (models: string[] = []) => {
    const availableModels = models.length > 0 ? models : [fallbackDefaultModel, 'gemini-3-pro-preview'];
    try {
      const response = await axios.get(buildApiUrl('/api/settings/agent_mode_video_generation_default_model'), {
        headers: { Authorization: `Bearer ${token}` }
      });

      if (response.data && response.data.settingValue) {
        const configuredModel = response.data.settingValue.trim();
        if (configuredModel && availableModels.includes(configuredModel)) {
          setVideoGenerationDefaultModel(configuredModel);
          return;
        }
      }
    } catch (settingsError: any) {
      if (settingsError.response?.status !== 404) {
        console.error('Error loading video generation default model:', settingsError);
      }
    }
    setVideoGenerationDefaultModel('');
  };

  const saveVideoGenerationDefaultModel = async () => {
    try {
      setSavingVideoGenerationDefaultModel(true);
      setError('');
      setSuccess('');

      if (videoGenerationDefaultModel) {
        await axios.put(buildApiUrl('/api/settings/agent_mode_video_generation_default_model'), {
          settingValue: videoGenerationDefaultModel,
          description: 'Default LLM model for video generation (overrides the general default model)'
        }, {
          headers: { Authorization: `Bearer ${token}` }
        });
      } else {
        await axios.delete(buildApiUrl('/api/settings/agent_mode_video_generation_default_model'), {
          headers: { Authorization: `Bearer ${token}` }
        });
      }

      setSuccess('Video generation default model updated successfully!');
    } catch (error) {
      console.error('Error saving video generation default model:', error);
      setError('Failed to save video generation default model');
    } finally {
      setSavingVideoGenerationDefaultModel(false);
    }
  };

  const loadCustomerSupportDefaultModel = async (models: string[] = []) => {
    const availableModels = models.length > 0 ? models : [fallbackDefaultModel, 'gemini-3-pro-preview'];
    try {
      const response = await axios.get(buildApiUrl('/api/settings/agent_mode_customer_support_default_model'), {
        headers: { Authorization: `Bearer ${token}` }
      });

      if (response.data && response.data.settingValue) {
        const configuredModel = response.data.settingValue.trim();
        if (configuredModel && availableModels.includes(configuredModel)) {
          setCustomerSupportDefaultModel(configuredModel);
          return;
        }
      }
    } catch (settingsError: any) {
      if (settingsError.response?.status !== 404) {
        console.error('Error loading customer support default model:', settingsError);
      }
    }
    setCustomerSupportDefaultModel('');
  };

  const saveCustomerSupportDefaultModel = async () => {
    try {
      setSavingCustomerSupportDefaultModel(true);
      setError('');
      setSuccess('');

      if (customerSupportDefaultModel) {
        await axios.put(buildApiUrl('/api/settings/agent_mode_customer_support_default_model'), {
          settingValue: customerSupportDefaultModel,
          description: 'Default LLM model for customer support agent (overrides the general default model)'
        }, {
          headers: { Authorization: `Bearer ${token}` }
        });
      } else {
        await axios.delete(buildApiUrl('/api/settings/agent_mode_customer_support_default_model'), {
          headers: { Authorization: `Bearer ${token}` }
        });
      }

      setSuccess('Customer support default model updated successfully!');
    } catch (error) {
      console.error('Error saving customer support default model:', error);
      setError('Failed to save customer support default model');
    } finally {
      setSavingCustomerSupportDefaultModel(false);
    }
  };

  const loadCodingAgentDefaultModel = async (models: string[] = []) => {
    const availableModels = models.length > 0 ? models : [fallbackDefaultModel, 'gemini-3-pro-preview'];
    try {
      const response = await axios.get(buildApiUrl('/api/settings/agent_mode_coding_agent_default_model'), {
        headers: { Authorization: `Bearer ${token}` }
      });

      if (response.data && response.data.settingValue) {
        const configuredModel = response.data.settingValue.trim();
        if (configuredModel && availableModels.includes(configuredModel)) {
          setCodingAgentDefaultModel(configuredModel);
          return;
        }
      }
    } catch (settingsError: any) {
      if (settingsError.response?.status !== 404) {
        console.error('Error loading coding agent default model:', settingsError);
      }
    }
    // Default to Sonnet 4.6
    setCodingAgentDefaultModel('anthropic.claude-sonnet-4-6');
  };

  const saveCodingAgentDefaultModel = async () => {
    try {
      setSavingCodingAgentDefaultModel(true);
      setError('');
      setSuccess('');

      if (codingAgentDefaultModel) {
        await axios.put(buildApiUrl('/api/settings/agent_mode_coding_agent_default_model'), {
          settingValue: codingAgentDefaultModel,
          description: 'Default LLM model for coding agent (code editing tasks)'
        }, {
          headers: { Authorization: `Bearer ${token}` }
        });
      } else {
        await axios.delete(buildApiUrl('/api/settings/agent_mode_coding_agent_default_model'), {
          headers: { Authorization: `Bearer ${token}` }
        });
      }

      setSuccess('Coding agent default model updated successfully!');
    } catch (error) {
      console.error('Error saving coding agent default model:', error);
      setError('Failed to save coding agent default model');
    } finally {
      setSavingCodingAgentDefaultModel(false);
    }
  };

  const visionFallbackModel = 'anthropic.claude-opus-4-8';

  const loadVisionModelOptions = async (): Promise<string[]> => {
    try {
      const response = await axios.get(buildApiUrl('/api/agent-mode/public/vision-model-options'), {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (Array.isArray(response.data) && response.data.length > 0) {
        setVisionModelOptions(response.data);
        return response.data;
      }
    } catch (error) {
      console.error('Error loading vision model options:', error);
    }
    setVisionModelOptions([]);
    return [];
  };

  const loadVisionModel = async (models: string[] = []) => {
    try {
      const response = await axios.get(buildApiUrl('/api/settings/agent_mode_vision_model'), {
        headers: { Authorization: `Bearer ${token}` }
      });

      if (response.data && response.data.settingValue) {
        const configuredModel = response.data.settingValue.trim();
        if (configuredModel && (models.length === 0 || models.includes(configuredModel))) {
          setVisionModel(configuredModel);
          return;
        }
      }
    } catch (settingsError: any) {
      if (settingsError.response?.status !== 404) {
        console.error('Error loading vision model:', settingsError);
      }
    }
    // Default to Opus 4.8 (Vertex AI) — the current known-good vision model
    setVisionModel(visionFallbackModel);
  };

  const saveVisionModel = async () => {
    try {
      setSavingVisionModel(true);
      setError('');
      setSuccess('');

      if (visionModel) {
        await axios.put(buildApiUrl('/api/settings/agent_mode_vision_model'), {
          settingValue: visionModel,
          description: 'Model used by the describe_image vision tool (independent of the chat/default model)'
        }, {
          headers: { Authorization: `Bearer ${token}` }
        });
      } else {
        await axios.delete(buildApiUrl('/api/settings/agent_mode_vision_model'), {
          headers: { Authorization: `Bearer ${token}` }
        });
      }

      setSuccess('Default vision model updated successfully!');
    } catch (error) {
      console.error('Error saving vision model:', error);
      setError('Failed to save default vision model');
    } finally {
      setSavingVisionModel(false);
    }
  };

  const loadBackupModel = async (models: string[] = []) => {
    const availableModels = models.length > 0 ? models : [fallbackDefaultModel, 'gemini-3-pro-preview'];
    try {
      const response = await axios.get(buildApiUrl('/api/settings/agent_mode_backup_model'), {
        headers: { Authorization: `Bearer ${token}` }
      });

      if (response.data && response.data.settingValue) {
        const configuredModel = response.data.settingValue.trim();
        if (configuredModel && availableModels.includes(configuredModel)) {
          setBackupModel(configuredModel);
          return;
        }
      }
    } catch (settingsError: any) {
      if (settingsError.response?.status !== 404) {
        console.error('Error loading backup model setting:', settingsError);
      }
    }
    setBackupModel('');
  };

  const saveBackupModel = async () => {
    try {
      setSavingBackupModel(true);
      setError('');
      setSuccess('');

      if (backupModel) {
        await axios.put(buildApiUrl('/api/settings/agent_mode_backup_model'), {
          settingValue: backupModel,
          description: 'Backup LLM model used when the primary model times out or encounters transient errors'
        }, {
          headers: { Authorization: `Bearer ${token}` }
        });
      } else {
        await axios.delete(buildApiUrl('/api/settings/agent_mode_backup_model'), {
          headers: { Authorization: `Bearer ${token}` }
        });
      }

      setSuccess('Backup model updated successfully!');
    } catch (error) {
      console.error('Error saving backup model:', error);
      setError('Failed to save backup model');
    } finally {
      setSavingBackupModel(false);
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

  const resetToDefault = async (type: 'systemPrompt' | 'welcomeMessage' | 'conversationStarters' | 'defaultModel' | 'backupModel' | 'scheduledChatsDefaultModel' | 'reportGenerationDefaultModel' | 'imageGenerationDefaultModel' | 'imageApiDefaultModel' | 'videoApiDefaultModel' | 'videoGenerationDefaultModel' | 'customerSupportDefaultModel' | 'codingAgentDefaultModel' | 'visionModel') => {
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
      } else if (type === 'backupModel') {
        setSavingBackupModel(true);
        await axios.delete(buildApiUrl('/api/settings/agent_mode_backup_model'), {
          headers: { Authorization: `Bearer ${token}` }
        });

        setBackupModel('');
        setSuccess('Backup model cleared. No automatic fallback will occur on timeout.');
      } else if (type === 'scheduledChatsDefaultModel') {
        setSavingScheduledChatsDefaultModel(true);
        await axios.delete(buildApiUrl('/api/settings/agent_mode_scheduled_chats_default_model'), {
          headers: { Authorization: `Bearer ${token}` }
        });

        setScheduledChatsDefaultModel('');
        setSuccess('Reset scheduled chats default model successfully!');
      } else if (type === 'reportGenerationDefaultModel') {
        setSavingReportGenerationDefaultModel(true);
        await axios.delete(buildApiUrl('/api/settings/agent_mode_report_generation_default_model'), {
          headers: { Authorization: `Bearer ${token}` }
        });

        setReportGenerationDefaultModel('');
        setSuccess('Reset report generation default model successfully!');
      } else if (type === 'imageGenerationDefaultModel') {
        setSavingImageGenerationDefaultModel(true);
        await axios.delete(buildApiUrl('/api/settings/agent_mode_image_generation_default_model'), {
          headers: { Authorization: `Bearer ${token}` }
        });

        setImageGenerationDefaultModel('');
        setSuccess('Reset image session default model successfully!');
      } else if (type === 'imageApiDefaultModel') {
        setSavingImageApiDefaultModel(true);
        await axios.delete(buildApiUrl('/api/settings/agent_mode_image_api_default_model'), {
          headers: { Authorization: `Bearer ${token}` }
        });

        setImageApiDefaultModel('');
        setSuccess('Reset image API default model successfully!');
      } else if (type === 'videoApiDefaultModel') {
        setSavingVideoApiDefaultModel(true);
        await axios.delete(buildApiUrl('/api/settings/agent_mode_video_api_default_model'), {
          headers: { Authorization: `Bearer ${token}` }
        });

        setVideoApiDefaultModel('');
        setSuccess('Reset video API default model successfully!');
      } else if (type === 'videoGenerationDefaultModel') {
        setSavingVideoGenerationDefaultModel(true);
        await axios.delete(buildApiUrl('/api/settings/agent_mode_video_generation_default_model'), {
          headers: { Authorization: `Bearer ${token}` }
        });

        setVideoGenerationDefaultModel('');
        setSuccess('Reset video generation default model successfully!');
      } else if (type === 'customerSupportDefaultModel') {
        setSavingCustomerSupportDefaultModel(true);
        await axios.delete(buildApiUrl('/api/settings/agent_mode_customer_support_default_model'), {
          headers: { Authorization: `Bearer ${token}` }
        });

        setCustomerSupportDefaultModel('');
        setSuccess('Reset customer support default model successfully!');
      } else if (type === 'codingAgentDefaultModel') {
        setSavingCodingAgentDefaultModel(true);
        await axios.delete(buildApiUrl('/api/settings/agent_mode_coding_agent_default_model'), {
          headers: { Authorization: `Bearer ${token}` }
        });

        setCodingAgentDefaultModel('anthropic.claude-sonnet-4-6');
        setSuccess('Reset coding agent default model successfully!');
      } else if (type === 'visionModel') {
        setSavingVisionModel(true);
        await axios.delete(buildApiUrl('/api/settings/agent_mode_vision_model'), {
          headers: { Authorization: `Bearer ${token}` }
        });

        setVisionModel(visionFallbackModel);
        setSuccess('Reset default vision model successfully!');
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
      } else if (type === 'backupModel') {
        setSavingBackupModel(false);
      } else if (type === 'scheduledChatsDefaultModel') {
        setSavingScheduledChatsDefaultModel(false);
      } else if (type === 'reportGenerationDefaultModel') {
        setSavingReportGenerationDefaultModel(false);
      } else if (type === 'imageGenerationDefaultModel') {
        setSavingImageGenerationDefaultModel(false);
      } else if (type === 'imageApiDefaultModel') {
        setSavingImageApiDefaultModel(false);
      } else if (type === 'videoApiDefaultModel') {
        setSavingVideoApiDefaultModel(false);
      } else if (type === 'videoGenerationDefaultModel') {
        setSavingVideoGenerationDefaultModel(false);
      } else if (type === 'customerSupportDefaultModel') {
        setSavingCustomerSupportDefaultModel(false);
      } else if (type === 'codingAgentDefaultModel') {
        setSavingCodingAgentDefaultModel(false);
      } else if (type === 'visionModel') {
        setSavingVisionModel(false);
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
                <MenuItem key={model} value={model} disabled={model === backupModel}>
                  {model}{model === backupModel ? ' (used as backup model)' : ''}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
            Sets the default model for newly created Agent Mode sessions. Existing sessions keep their current model.
          </Typography>
        </CardContent>
      </Card>

      {/* Backup Model */}
      <Card sx={{ mb: 3 }}>
        <CardContent>
          <Box display="flex" justifyContent="space-between" alignItems="center" mb={2}>
            <Typography variant="h6">Backup Model</Typography>
            <Box>
              <Button
                variant="outlined"
                onClick={() => resetToDefault('backupModel')}
                disabled={savingBackupModel}
                sx={{ mr: 1 }}
              >
                Reset to Default
              </Button>
              <Button
                variant="contained"
                onClick={saveBackupModel}
                disabled={savingBackupModel}
              >
                {savingBackupModel ? <CircularProgress size={20} /> : 'Save Changes'}
              </Button>
            </Box>
          </Box>

          <FormControl fullWidth>
            <InputLabel id="agent-mode-backup-model-label">Backup Model</InputLabel>
            <Select
              labelId="agent-mode-backup-model-label"
              value={backupModel}
              label="Backup Model"
              onChange={(e) => setBackupModel(e.target.value as string)}
            >
              <MenuItem value="">
                <em>None (no backup)</em>
              </MenuItem>
              {(supportedModels.length > 0
                ? supportedModels
                : [fallbackDefaultModel, 'gemini-3-pro-preview']
              ).map((model) => (
                <MenuItem key={model} value={model} disabled={model === defaultModel}>
                  {model}{model === defaultModel ? ' (current default model)' : ''}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
            When the primary model times out or encounters transient errors, the system automatically switches to this backup model. If not set, no automatic fallback occurs and the error is returned to the user.
          </Typography>
        </CardContent>
      </Card>

      {/* Scheduled Chats Default Model */}
      <Card sx={{ mb: 3 }}>
        <CardContent>
          <Box display="flex" justifyContent="space-between" alignItems="center" mb={2}>
            <Typography variant="h6">Scheduled Chats Default Model</Typography>
            <Box>
              <Button
                variant="outlined"
                onClick={() => resetToDefault('scheduledChatsDefaultModel')}
                disabled={savingScheduledChatsDefaultModel}
                sx={{ mr: 1 }}
              >
                Reset to Default
              </Button>
              <Button
                variant="contained"
                onClick={saveScheduledChatsDefaultModel}
                disabled={savingScheduledChatsDefaultModel}
              >
                {savingScheduledChatsDefaultModel ? <CircularProgress size={20} /> : 'Save Changes'}
              </Button>
            </Box>
          </Box>

          <FormControl fullWidth>
            <InputLabel id="agent-mode-scheduled-chats-model-label">Scheduled Chats Default Model</InputLabel>
            <Select
              labelId="agent-mode-scheduled-chats-model-label"
              value={scheduledChatsDefaultModel}
              label="Scheduled Chats Default Model"
              onChange={(e) => setScheduledChatsDefaultModel(e.target.value as string)}
            >
              <MenuItem value="">
                <em>Use general default</em>
              </MenuItem>
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
            If set, scheduled chats use this model instead of the general default. Leave as "Use general default" to follow the Default Model setting above.
          </Typography>
        </CardContent>
      </Card>

      {/* Report Generation Default Model */}
      <Card sx={{ mb: 3 }}>
        <CardContent>
          <Box display="flex" justifyContent="space-between" alignItems="center" mb={2}>
            <Typography variant="h6">Report Generation Default Model</Typography>
            <Box>
              <Button
                variant="outlined"
                onClick={() => resetToDefault('reportGenerationDefaultModel')}
                disabled={savingReportGenerationDefaultModel}
                sx={{ mr: 1 }}
              >
                Reset to Default
              </Button>
              <Button
                variant="contained"
                onClick={saveReportGenerationDefaultModel}
                disabled={savingReportGenerationDefaultModel}
              >
                {savingReportGenerationDefaultModel ? <CircularProgress size={20} /> : 'Save Changes'}
              </Button>
            </Box>
          </Box>

          <FormControl fullWidth>
            <InputLabel id="agent-mode-report-generation-model-label">Report Generation Default Model</InputLabel>
            <Select
              labelId="agent-mode-report-generation-model-label"
              value={reportGenerationDefaultModel}
              label="Report Generation Default Model"
              onChange={(e) => setReportGenerationDefaultModel(e.target.value as string)}
            >
              <MenuItem value="">
                <em>Use general default</em>
              </MenuItem>
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
            If set, report creation and revision uses this model instead of the general default. Leave as "Use general default" to follow the Default Model setting above.
          </Typography>
        </CardContent>
      </Card>

      {/* Image Session Default Model (LLM used to think/plan during image generation sessions) */}
      <Card sx={{ mb: 3 }}>
        <CardContent>
          <Box display="flex" justifyContent="space-between" alignItems="center" mb={2}>
            <Typography variant="h6">Image Session Default Model</Typography>
            <Box>
              <Button
                variant="outlined"
                onClick={() => resetToDefault('imageGenerationDefaultModel')}
                disabled={savingImageGenerationDefaultModel}
                sx={{ mr: 1 }}
              >
                Reset to Default
              </Button>
              <Button
                variant="contained"
                onClick={saveImageGenerationDefaultModel}
                disabled={savingImageGenerationDefaultModel}
              >
                {savingImageGenerationDefaultModel ? <CircularProgress size={20} /> : 'Save Changes'}
              </Button>
            </Box>
          </Box>

          <FormControl fullWidth>
            <InputLabel id="agent-mode-image-session-model-label">Image Session Default Model</InputLabel>
            <Select
              labelId="agent-mode-image-session-model-label"
              value={imageGenerationDefaultModel}
              label="Image Session Default Model"
              onChange={(e) => setImageGenerationDefaultModel(e.target.value as string)}
            >
              <MenuItem value="">
                <em>Use general default</em>
              </MenuItem>
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
            The LLM used to plan and orchestrate during image generation sessions. Leave as "Use general default" to follow the Default Model setting above.
          </Typography>
        </CardContent>
      </Card>

      {/* Image API Default Model (controls which image generation API/model is called) */}
      <Card sx={{ mb: 3 }}>
        <CardContent>
          <Box display="flex" justifyContent="space-between" alignItems="center" mb={2}>
            <Typography variant="h6">Image API Default Model</Typography>
            <Box>
              <Button
                variant="outlined"
                onClick={() => resetToDefault('imageApiDefaultModel')}
                disabled={savingImageApiDefaultModel}
                sx={{ mr: 1 }}
              >
                Reset to Default
              </Button>
              <Button
                variant="contained"
                onClick={saveImageApiDefaultModel}
                disabled={savingImageApiDefaultModel}
              >
                {savingImageApiDefaultModel ? <CircularProgress size={20} /> : 'Save Changes'}
              </Button>
            </Box>
          </Box>

          <FormControl fullWidth>
            <InputLabel id="agent-mode-image-api-model-label">Image API Default Model</InputLabel>
            <Select
              labelId="agent-mode-image-api-model-label"
              value={imageApiDefaultModel}
              label="Image API Default Model"
              onChange={(e) => setImageApiDefaultModel(e.target.value as string)}
            >
              <MenuItem value="">
                <em>Use hardcoded default (gemini-3-pro-image-preview)</em>
              </MenuItem>
              {IMAGE_API_MODELS.map((model) => (
                <MenuItem key={model} value={model}>
                  {model}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
            The image generation API model used by the <code>generate_image</code> tool when the agent doesn't specify one explicitly. Overrides the hardcoded default.
          </Typography>
        </CardContent>
      </Card>

      {/* Video API Default Model (controls which video generation API/model is called) */}
      <Card sx={{ mb: 3 }}>
        <CardContent>
          <Box display="flex" justifyContent="space-between" alignItems="center" mb={2}>
            <Typography variant="h6">Video API Default Model</Typography>
            <Box>
              <Button
                variant="outlined"
                onClick={() => resetToDefault('videoApiDefaultModel')}
                disabled={savingVideoApiDefaultModel}
                sx={{ mr: 1 }}
              >
                Reset to Default
              </Button>
              <Button
                variant="contained"
                onClick={saveVideoApiDefaultModel}
                disabled={savingVideoApiDefaultModel}
              >
                {savingVideoApiDefaultModel ? <CircularProgress size={20} /> : 'Save Changes'}
              </Button>
            </Box>
          </Box>

          <FormControl fullWidth>
            <InputLabel id="agent-mode-video-api-model-label">Video API Default Model</InputLabel>
            <Select
              labelId="agent-mode-video-api-model-label"
              value={videoApiDefaultModel}
              label="Video API Default Model"
              onChange={(e) => setVideoApiDefaultModel(e.target.value as string)}
            >
              <MenuItem value="">
                <em>Use hardcoded default (veo-3.1-generate-preview)</em>
              </MenuItem>
              {VIDEO_API_MODELS.map((model) => (
                <MenuItem key={model} value={model}>
                  {model}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
            The video generation API model used by the <code>generate_video</code> tool when the agent doesn't specify one explicitly. Overrides the hardcoded default.
          </Typography>
        </CardContent>
      </Card>

      {/* Video Generation Default Model */}
      <Card sx={{ mb: 3 }}>
        <CardContent>
          <Box display="flex" justifyContent="space-between" alignItems="center" mb={2}>
            <Typography variant="h6">Video Generation Default Model</Typography>
            <Box>
              <Button
                variant="outlined"
                onClick={() => resetToDefault('videoGenerationDefaultModel')}
                disabled={savingVideoGenerationDefaultModel}
                sx={{ mr: 1 }}
              >
                Reset to Default
              </Button>
              <Button
                variant="contained"
                onClick={saveVideoGenerationDefaultModel}
                disabled={savingVideoGenerationDefaultModel}
              >
                {savingVideoGenerationDefaultModel ? <CircularProgress size={20} /> : 'Save Changes'}
              </Button>
            </Box>
          </Box>

          <FormControl fullWidth>
            <InputLabel id="agent-mode-video-generation-model-label">Video Generation Default Model</InputLabel>
            <Select
              labelId="agent-mode-video-generation-model-label"
              value={videoGenerationDefaultModel}
              label="Video Generation Default Model"
              onChange={(e) => setVideoGenerationDefaultModel(e.target.value as string)}
            >
              <MenuItem value="">
                <em>Use general default</em>
              </MenuItem>
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
            If set, video generation uses this model instead of the general default. Leave as "Use general default" to follow the Default Model setting above.
          </Typography>
        </CardContent>
      </Card>

      {/* Customer Support Agent Default Model */}
      <Card sx={{ mb: 3 }}>
        <CardContent>
          <Box display="flex" justifyContent="space-between" alignItems="center" mb={2}>
            <Typography variant="h6">Customer Support Agent Default Model</Typography>
            <Box>
              <Button
                variant="outlined"
                onClick={() => resetToDefault('customerSupportDefaultModel')}
                disabled={savingCustomerSupportDefaultModel}
                sx={{ mr: 1 }}
              >
                Reset to Default
              </Button>
              <Button
                variant="contained"
                onClick={saveCustomerSupportDefaultModel}
                disabled={savingCustomerSupportDefaultModel}
              >
                {savingCustomerSupportDefaultModel ? <CircularProgress size={20} /> : 'Save Changes'}
              </Button>
            </Box>
          </Box>

          <FormControl fullWidth>
            <InputLabel id="agent-mode-customer-support-model-label">Customer Support Agent Default Model</InputLabel>
            <Select
              labelId="agent-mode-customer-support-model-label"
              value={customerSupportDefaultModel}
              label="Customer Support Agent Default Model"
              onChange={(e) => setCustomerSupportDefaultModel(e.target.value as string)}
            >
              <MenuItem value="">
                <em>Use general default</em>
              </MenuItem>
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
            Sets the default model for Emma Chat in the customer portal. If not set, uses the general default model.
          </Typography>
        </CardContent>
      </Card>

      {/* Coding Agent Default Model */}
      <Card sx={{ mb: 3 }}>
        <CardContent>
          <Box display="flex" justifyContent="space-between" alignItems="center" mb={2}>
            <Typography variant="h6">Coding Agent Default Model</Typography>
            <Box>
              <Button
                variant="outlined"
                onClick={() => resetToDefault('codingAgentDefaultModel')}
                disabled={savingCodingAgentDefaultModel}
                sx={{ mr: 1 }}
              >
                Reset to Default
              </Button>
              <Button
                variant="contained"
                onClick={saveCodingAgentDefaultModel}
                disabled={savingCodingAgentDefaultModel}
              >
                {savingCodingAgentDefaultModel ? <CircularProgress size={20} /> : 'Save Changes'}
              </Button>
            </Box>
          </Box>

          <FormControl fullWidth>
            <InputLabel id="agent-mode-coding-agent-model-label">Coding Agent Default Model</InputLabel>
            <Select
              labelId="agent-mode-coding-agent-model-label"
              value={codingAgentDefaultModel}
              label="Coding Agent Default Model"
              onChange={(e) => setCodingAgentDefaultModel(e.target.value as string)}
            >
              {(supportedModels.length > 0
                ? supportedModels
                : ['anthropic.claude-sonnet-4-6', 'anthropic.claude-opus-4-6-v1', 'anthropic.claude-opus-4-8']
              ).filter(model => model.includes('anthropic.claude')).map((model) => (
                <MenuItem key={model} value={model}>
                  {model === 'anthropic.claude-opus-4-8' ? 'anthropic.claude-opus-4-8 (Bedrock)' : model}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
            Sets the default model for the coding agent (code editing tasks for landing pages). Defaults to Sonnet 4.6. Opus 4.6 and Opus 4.8 (both Bedrock) are also available for more complex coding tasks.
          </Typography>
        </CardContent>
      </Card>

      {/* Default Vision Model (describe_image tool) */}
      <Card sx={{ mb: 3 }}>
        <CardContent>
          <Box display="flex" justifyContent="space-between" alignItems="center" mb={2}>
            <Typography variant="h6">Default Vision Model</Typography>
            <Box>
              <Button
                variant="outlined"
                onClick={() => resetToDefault('visionModel')}
                disabled={savingVisionModel}
                sx={{ mr: 1 }}
              >
                Reset to Default
              </Button>
              <Button
                variant="contained"
                onClick={saveVisionModel}
                disabled={savingVisionModel}
              >
                {savingVisionModel ? <CircularProgress size={20} /> : 'Save Changes'}
              </Button>
            </Box>
          </Box>

          <FormControl fullWidth>
            <InputLabel id="agent-mode-vision-model-label">Default Vision Model</InputLabel>
            <Select
              labelId="agent-mode-vision-model-label"
              value={visionModel}
              label="Default Vision Model"
              onChange={(e) => setVisionModel(e.target.value as string)}
            >
              {(visionModelOptions.length > 0 ? visionModelOptions : [visionFallbackModel]).map((model) => (
                <MenuItem key={model} value={model}>
                  {model === 'anthropic.claude-opus-4-8' ? 'anthropic.claude-opus-4-8 (Bedrock)' : model}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
            Model used by Emma's <code>describe_image</code> tool to analyze images (charts, screenshots, photos). This is a vision utility and is independent of the chat model and the agent-mode default model. Defaults to Opus 4.8 (Vertex AI); pick a cheaper/faster vision-capable model (e.g. a Gemini or GPT model) to reduce cost.
          </Typography>
        </CardContent>
      </Card>

      {/* Content Agent Model for Blog/Book Generation */}
      <Card sx={{ mb: 3 }}>
        <CardContent>
          <Box display="flex" justifyContent="space-between" alignItems="center" mb={2}>
            <Typography variant="h6">Content Agent Model (Blog & Book Generation)</Typography>
            <Button
              variant="contained"
              onClick={saveContentModel}
              disabled={savingContentModel}
            >
              {savingContentModel ? <CircularProgress size={20} /> : 'Save Changes'}
            </Button>
          </Box>

          <FormControl fullWidth sx={{ mb: 2 }}>
            <InputLabel>Content Agent Model</InputLabel>
            <Select
              value={contentModel}
              onChange={(e) => setContentModel(e.target.value)}
              label="Content Agent Model"
            >
              <MenuItem value="gpt-5-chat-2">GPT-5 Chat 2 (Azure)</MenuItem>
              <MenuItem value="anthropic.claude-sonnet-4-6">
                Claude Sonnet 4.6 (AWS Bedrock)
              </MenuItem>
              <MenuItem value="anthropic.claude-sonnet-4-5-20250929-v1:0">
                Claude Sonnet 4.5 (AWS Bedrock)
              </MenuItem>
              <MenuItem value="anthropic.claude-opus-4-8">Claude Opus 4.8 (AWS Bedrock)</MenuItem>
            </Select>
          </FormControl>

          <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
            Select the LLM model to use for blog article and book content generation. This setting does NOT affect Agent Mode chat conversations, which use their own model configuration.
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
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, bgcolor: 'warning.light', px: 2, py: 0.75, borderRadius: 1 }}>
              <Typography variant="body2" sx={{ fontWeight: 600, color: 'warning.dark' }}>
                🔒 Read-only — managed in code
              </Typography>
            </Box>
          </Box>

          <Box sx={{ bgcolor: 'info.light', borderRadius: 1, p: 2, mb: 2, border: '1px solid', borderColor: 'info.main' }}>
            <Typography variant="body2" sx={{ fontWeight: 600, color: 'info.dark', mb: 0.5 }}>
              To update the system prompt, edit the source file and open a PR:
            </Typography>
            <Typography variant="body2" sx={{ fontFamily: 'monospace', color: 'info.dark' }}>
              backend/src/docs/agentModeSystemPrompt.ts
            </Typography>
          </Box>

          <TextField
            fullWidth
            multiline
            rows={15}
            value={systemPrompt}
            InputProps={{ readOnly: true }}
            variant="outlined"
            sx={{ fontFamily: 'monospace', '& .MuiInputBase-input': { color: 'text.secondary' } }}
          />

          <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
            Read-only view of the active system prompt. Editing is disabled — changes must go through a PR to backend/src/docs/agentModeSystemPrompt.ts.
          </Typography>
        </CardContent>
      </Card>

      {/* Sidebar Addendum */}
      <Card sx={{ mb: 3 }}>
        <CardContent>
          <Box display="flex" justifyContent="space-between" alignItems="center" mb={2}>
            <Typography variant="h6">
              Customer Portal Sidebar Addendum
            </Typography>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, bgcolor: 'warning.light', px: 2, py: 0.75, borderRadius: 1 }}>
              <Typography variant="body2" sx={{ fontWeight: 600, color: 'warning.dark' }}>
                🔒 Read-only — managed in code
              </Typography>
            </Box>
          </Box>

          <Box sx={{ bgcolor: 'info.light', borderRadius: 1, p: 2, mb: 2, border: '1px solid', borderColor: 'info.main' }}>
            <Typography variant="body2" sx={{ color: 'info.dark' }}>
              This additional context is <strong>appended to the System Prompt above</strong> when Emma runs as a popup/sidebar inside the Customer Portal. It is <strong>not</strong> used in the full Agent Mode chat. To update: edit <code>EMMA_SIDEBAR_ADDENDUM</code> in <code>backend/src/docs/agentModeSystemPrompt.ts</code> and open a PR.
            </Typography>
          </Box>

          <TextField
            fullWidth
            multiline
            rows={10}
            value={sidebarAddendum}
            InputProps={{ readOnly: true }}
            variant="outlined"
            sx={{ fontFamily: 'monospace', '& .MuiInputBase-input': { color: 'text.secondary' } }}
          />
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

      {/* Work Plans - moved to dedicated /work-plans page */}
      <Card>
        <CardContent>
          <Box display="flex" justifyContent="space-between" alignItems="center">
            <Typography variant="h6">
              Work Plans
            </Typography>
            <Button variant="outlined" href="/work-plans">
              Manage Work Plans
            </Button>
          </Box>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            Work plans have been moved to their own page. Use the button above to manage predefined work plans and review user-submitted plans.
          </Typography>
        </CardContent>
      </Card>

    </Box>
  );
};
