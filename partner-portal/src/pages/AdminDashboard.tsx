import React, { useEffect, useState } from "react";
import { useAdmin } from "../contexts/AdminContext";
import { useSearchParams } from "react-router-dom";
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
import { Link as RouterLink } from "react-router-dom";
import axios from "axios";
import { useAuth } from "../contexts/AuthContext";
import { buildApiUrl } from "../config";
import DOMPurify from "dompurify";
import ImageModelsSettings from "../components/admin/ImageModelsSettings";
import DefaultPromptsSettings from "../components/admin/DefaultPromptsSettings";
import BenchmarksTab from "../components/admin/BenchmarksTab";
import {
  UserGrowthChart,
  TaskGrowthChart,
  ExecutionTrendsChart,
  ExecutionStatusChart,
  UserTypeChart,
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
  isOAuthUser?: boolean; // Ensured from API structure
  stripe_customer_id?: string; // Added stripe_customer_id
  adAccount?: string; // Meta ad account ID
  emailDomain?: string; // Email sender domain
  defaultSenderUsername?: string; // Default sender username (e.g., noreply)
  fromName?: string; // From name for emails
  slackChannel?: string; // Default Slack channel for this user
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
  public: {
    tasks: number;
    tasksWithKnowledgeBase: number;
    totalSize: number;
    averageSize: number;
  };
  private: {
    tasks: number;
    tasksWithKnowledgeBase: number;
    totalSize: number;
    averageSize: number;
  };
  tasks: {
    taskId: string;
    name: string;
    knowledgeBaseSize: number;
    owner: string;
    type: "public" | "private";
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
                      }}
                    >
                      {msg.role.toUpperCase()}
                      {msg.metadata?.timestamp &&
                        !isNaN(new Date(msg.metadata.timestamp).getTime()) && (
                          <>
                            {" "}
                            -{" "}
                            {new Date(msg.metadata.timestamp).toLocaleString()}
                          </>
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
  };
  
  // Get initial tab value from URL or default to 0
  const getInitialTabValue = () => {
    const tabParam = searchParams.get('tab');
    return tabParam && TAB_MAP[tabParam as keyof typeof TAB_MAP] !== undefined 
      ? TAB_MAP[tabParam as keyof typeof TAB_MAP] 
      : 0;
  };
  
  const [tabValue, setTabValue] = useState(getInitialTabValue());
  const [startDate, setStartDate] = useState<Date | null>(
    new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
  );
  const [endDate, setEndDate] = useState<Date | null>(new Date());
  const [tasks, setTasks] = useState<AdminTask[]>([]);
  const [orderBy, setOrderBy] = useState<string>("latestRunTime");
  const [order, setOrder] = useState<"asc" | "desc">("desc");
  const [message, setMessage] = useState("");
  const [title, setTitle] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [selectedUser, setSelectedUser] = useState<User | null>(null);
  const [deactivateDialogOpen, setDeactivateDialogOpen] = useState(false);
  const [chatSessions, setChatSessions] = useState<AdminChatSession[]>([]);
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
  const { token } = useAuth();

  const {
    users: contextUsers,
    waitlist,
    taskAnalytics,
    userAnalytics,
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
    }
  }, [tabValue]);

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
    }
  }, [searchParams]);

  useEffect(() => {
    if (startDate && endDate && tabValue === 0 && !adminLoading) {
      loadAnalytics(
        format(startDate, "yyyy-MM-dd"),
        format(endDate, "yyyy-MM-dd")
      );
    }
  }, [startDate, endDate, tabValue]);

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

  useEffect(() => {
    const loadChatSessions = async () => {
      try {
        const response = await axios.get(
          buildApiUrl("/api/admin/chat-sessions"),
          {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          }
        );
        setChatSessions(response.data);
      } catch (error) {
        console.error("Error loading chat sessions:", error);
      }
    };

    // Only load chat sessions when Chat History tab (6) is selected and we haven't loaded them yet
    if (tabValue === 6 && chatSessions.length === 0) {
      loadChatSessions();
    }
  }, [tabValue, token]);

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
      setSearchParams({}); // Remove tab parameter for overview tab
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
              <Grid container spacing={3}>
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

            <Button
              type="submit"
              variant="contained"
              disabled={loading}
              sx={{ minWidth: 120 }}
            >
              {loading ? <CircularProgress size={24} /> : "Send"}
            </Button>
          </Box>
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
                  <TableCell>Email</TableCell>
                  <TableCell>User ID</TableCell>
                  <TableCell>Stripe Customer ID</TableCell>
                  <TableCell>Ad Account</TableCell>
                  <TableCell>Email Sender</TableCell>
                  <TableCell>Slack Channel</TableCell>
                  <TableCell>Created</TableCell>
                  <TableCell>Last Login</TableCell>
                  <TableCell>Support Note</TableCell>
                  <TableCell>Roles</TableCell>
                  <TableCell>Tasks</TableCell>
                  <TableCell>Workflows</TableCell>
                  <TableCell>OAuth User</TableCell>
                  <TableCell>Admin</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell>Actions</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {adminLoading ? (
                  <TableRow>
                    <TableCell colSpan={16} align="center">
                      <CircularProgress />
                    </TableCell>
                  </TableRow>
                ) : (
                  contextUsers.map((user) => {
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
                    <SortLabel property="email" label="Email" />
                  </TableCell>
                  <TableCell>Stripe Customer ID</TableCell>
                  <TableCell>
                    <SortLabel property="fullName" label="Full Name" />
                  </TableCell>
                  <TableCell>
                    <SortLabel property="companyName" label="Company" />
                  </TableCell>
                  <TableCell>
                    <SortLabel property="phoneNumber" label="Phone Number" />
                  </TableCell>
                  <TableCell>
                    <SortLabel
                      property="monthlyMarketingSpend"
                      label="Marketing Spend"
                    />
                  </TableCell>
                  <TableCell>
                    <SortLabel
                      property="marketingChannels"
                      label="Marketing Channels"
                    />
                  </TableCell>
                  <TableCell>
                    <SortLabel property="businessArea" label="Business Area" />
                  </TableCell>
                  <TableCell>
                    <SortLabel property="joinedAt" label="Joined" />
                  </TableCell>
                  <TableCell>Details</TableCell>
                  <TableCell>Use Case</TableCell>
                  <TableCell>Request Report</TableCell>
                  <TableCell>Support Note</TableCell>
                  <TableCell>
                    <SortLabel property="status" label="Status" />
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
                  waitlist.map((entry: WaitlistEntry) => {
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
                  <TableCell>Created At</TableCell>
                  <TableCell>Updated At</TableCell>
                  <TableCell>Message Count</TableCell>
                  <TableCell>Actions</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {loading ? (
                  <TableRow>
                    <TableCell colSpan={6} align="center">
                      <CircularProgress />
                    </TableCell>
                  </TableRow>
                ) : (
                  chatSessions.map((session) => (
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
                        <Button
                          variant="outlined"
                          size="small"
                          onClick={() => handleViewChat(session)}
                        >
                          View Chat
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </TableContainer>
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
                            </TableRow>
                          </>
                        ) : (
                          <TableRow>
                            <TableCell colSpan={5} align="center">
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
                            <TableCell colSpan={6} align="center">
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
  title: string;
  steps: WorkPlanStep[];
  welcomeMessage?: string;
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
  const [loading, setLoading] = useState(true);
  const [savingSystemPrompt, setSavingSystemPrompt] = useState(false);
  const [savingWelcomeMessage, setSavingWelcomeMessage] = useState(false);
  const [savingConversationStarters, setSavingConversationStarters] = useState(false);
  const [savingWorkPlans, setSavingWorkPlans] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const { token } = useAuth();

  useEffect(() => {
    loadAllSettings();
  }, []);

  const loadAllSettings = async () => {
    try {
      setLoading(true);
      setError('');
      
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
    } catch (error) {
      console.error('Error loading settings:', error);
      setError('Failed to load settings');
    } finally {
      setLoading(false);
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
          
          // Check if "Onboarding" work plan already exists
          const hasOnboarding = workPlans.some((wp: PredefinedWorkPlan) => 
            wp.title.toLowerCase() === 'onboarding'
          );
          
          // If no Onboarding plan exists, add the default one
          if (!hasOnboarding) {
            const defaultOnboardingPlan = getDefaultOnboardingPlan();
            workPlans.push(defaultOnboardingPlan);
            
            // Save the updated work plans with the default Onboarding plan
            try {
              await axios.put(buildApiUrl('/api/settings/agent-mode-predefined-workplans'), {
                settingValue: JSON.stringify(workPlans),
                description: 'Agent Mode predefined work plans for Emma AI assistant'
              }, {
                headers: { Authorization: `Bearer ${token}` }
              });
            } catch (saveError) {
              console.error('Error saving default Onboarding work plan:', saveError);
              // Continue anyway - we'll still show it in the UI
            }
          }
          
          setPredefinedWorkPlans(workPlans);
          return;
        }
      } catch (settingsError: any) {
        // If setting doesn't exist (404), create default Onboarding plan
        if (settingsError.response?.status === 404) {
          const defaultOnboardingPlan = getDefaultOnboardingPlan();
          
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

  const savePredefinedWorkPlans = async () => {
    try {
      setSavingWorkPlans(true);
      setError('');
      setSuccess('');
      
      // Validate work plans
      const validatedWorkPlans = predefinedWorkPlans.map(workPlan => ({
        title: workPlan.title.trim(),
        welcomeMessage: workPlan.welcomeMessage?.trim() || undefined,
        steps: workPlan.steps
          .filter(step => step.title.trim().length > 0)
          .map((step, index) => ({
            stepCount: index + 1,
            title: step.title.trim(),
            description: step.description?.trim() || undefined,
            requiredFunctionCalls: step.requiredFunctionCalls?.filter(f => f.trim().length > 0) || undefined
          }))
      })).filter(workPlan => workPlan.title.length > 0 && workPlan.steps.length > 0);
      
      await axios.put(buildApiUrl('/api/settings/agent-mode-predefined-workplans'), {
        settingValue: JSON.stringify(validatedWorkPlans),
        description: 'Agent Mode predefined work plans for Emma AI assistant'
      }, {
        headers: { Authorization: `Bearer ${token}` }
      });
      
      setPredefinedWorkPlans(validatedWorkPlans);
      setSuccess('Predefined work plans updated successfully!');
    } catch (error) {
      console.error('Error saving predefined work plans:', error);
      setError('Failed to save predefined work plans');
    } finally {
      setSavingWorkPlans(false);
    }
  };

  const addWorkPlan = () => {
    setPredefinedWorkPlans([
      ...predefinedWorkPlans,
      {
        title: '',
        steps: [{ stepCount: 1, title: '' }]
      }
    ]);
  };

  const removeWorkPlan = (index: number) => {
    setPredefinedWorkPlans(predefinedWorkPlans.filter((_, i) => i !== index));
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

  const resetToDefault = async (type: 'systemPrompt' | 'welcomeMessage' | 'conversationStarters') => {
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
                disabled={savingWorkPlans}
                sx={{ mr: 1 }}
              >
                Add Work Plan
              </Button>
              <Button
                variant="contained"
                onClick={savePredefinedWorkPlans}
                disabled={savingWorkPlans}
              >
                {savingWorkPlans ? <CircularProgress size={20} /> : 'Save Changes'}
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
                <Card key={workPlanIndex} sx={{ mb: 2, border: '1px solid', borderColor: 'divider' }}>
                  <CardContent>
                    <Box display="flex" justifyContent="space-between" alignItems="center" mb={2}>
                      <TextField
                        label="Work Plan Title"
                        value={workPlan.title}
                        onChange={(e) => updateWorkPlan(workPlanIndex, { ...workPlan, title: e.target.value })}
                        placeholder="Enter work plan title..."
                        variant="outlined"
                        fullWidth
                        sx={{ mr: 2 }}
                      />
                      <IconButton
                        color="error"
                        onClick={() => removeWorkPlan(workPlanIndex)}
                        disabled={savingWorkPlans}
                      >
                        <DeleteIcon />
                      </IconButton>
                    </Box>

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
                            disabled={savingWorkPlans}
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
                                disabled={savingWorkPlans || availableFunctionCalls.length === 0}
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
                                  disabled={savingWorkPlans}
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
                      disabled={savingWorkPlans}
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
