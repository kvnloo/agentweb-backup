import React, { useEffect, useState } from "react";
import { useAdmin } from "../contexts/AdminContext";
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
} from "@mui/material";
import { format } from "date-fns";
import { Link } from "react-router-dom";
import axios from "axios";
import { useAuth } from "../contexts/AuthContext";
import { buildApiUrl } from "../config";
import DOMPurify from "dompurify";
import {
  Info as InfoIcon,
  Close as CloseIcon,
  Handshake as HandshakeIcon,
  Person as PersonIcon,
  Edit as EditIcon,
  PersonOff as PersonOffIcon,
  Delete as DeleteIcon,
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
  role?: "partner" | "customer"; // For single role from API
  roles?: ("partner" | "customer")[];
  taskCount?: number;
  workflowCount?: number;
  isOAuthUser?: boolean; // Ensured from API structure
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
  [key: string]: any; // Allow other properties if necessary
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
                to={`/profile/${session.userId}`}
                style={{
                  color: "#1976d2",
                  textDecoration: "none",
                }}
                target="_blank"
                rel="noopener noreferrer"
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
                          : "#f3e5f5", // System messages get a light purple background
                      color: "text.primary",
                      border: msg.role !== "user" ? "1px solid" : "none",
                      borderColor:
                        msg.role === "assistant"
                          ? "#90caf9"
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
  const [tabValue, setTabValue] = useState(0);
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
    ("partner" | "customer")[]
  >([]);
  const [editingNoteEmail, setEditingNoteEmail] = useState<string | null>(null);
  const [currentNoteText, setCurrentNoteText] = useState("");
  const [noteEditLoading, setNoteEditLoading] = useState(false);
  const [emailToDelete, setEmailToDelete] = useState<string | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
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
  } = useAdmin();

  useEffect(() => {
    const loadData = async () => {
      await loadUsers();
      await loadWaitlist();
    };
    loadData();
  }, []);

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

    if (tabValue === 4) {
      loadTasks();
    }
  }, [tabValue, token]);

  useEffect(() => {
    if (tabValue === 5) {
      loadChatSessions();
    }
  }, [tabValue]);

  const handleTabChange = (_event: React.SyntheticEvent, newValue: number) => {
    setTabValue(newValue);
  };

  const handleWaitlistAction = async (email: string, status: string) => {
    await updateWaitlistStatus(email, status);
  };

  const handleOpenDeleteConfirm = (email: string) => {
    setEmailToDelete(email);
    setDeleteConfirmOpen(true);
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

  const getTimeAgo = (dateString?: string) => {
    if (!dateString) return "Never";

    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();

    // Convert to appropriate time unit
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHours = Math.floor(diffMin / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffDays > 30) {
      const diffMonths = Math.floor(diffDays / 30);
      return `${diffMonths} month${diffMonths > 1 ? "s" : ""} ago`;
    } else if (diffDays > 0) {
      return `${diffDays} day${diffDays > 1 ? "s" : ""} ago`;
    } else if (diffHours > 0) {
      return `${diffHours} hour${diffHours > 1 ? "s" : ""} ago`;
    } else if (diffMin > 0) {
      return `${diffMin} minute${diffMin > 1 ? "s" : ""} ago`;
    } else {
      return "Just now";
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

  const loadChatSessions = async () => {
    try {
      setLoading(true);
      const response = await axios.get(
        buildApiUrl("/api/admin/chat-sessions"),
        { headers: { Authorization: `Bearer ${token}` } }
      );
      setChatSessions(response.data);
    } catch (error: any) {
      setError(error.response?.data?.message || "Failed to load chat sessions");
    } finally {
      setLoading(false);
    }
  };

  const handleViewChat = (session: AdminChatSession) => {
    setSelectedSession(session);
    setChatDialogOpen(true);
  };

  const handleRoleCheckboxChange = (role: "partner" | "customer") => {
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

      await loadUsers();

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
          >
            <Tab label="Overview" {...a11yProps(0)} />
            <Tab label="Announcements" {...a11yProps(1)} />
            <Tab label="Users" {...a11yProps(2)} />
            <Tab label="Waitlist" {...a11yProps(3)} />
            <Tab label="Tasks" {...a11yProps(4)} />
            <Tab label="Chat History" {...a11yProps(5)} />
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

          {adminLoading ? (
            <CircularProgress />
          ) : (
            <Grid container spacing={3}>
              <Grid item xs={12} md={6}>
                <Card>
                  <CardContent>
                    <Typography variant="h6" gutterBottom>
                      User Analytics
                    </Typography>
                    {userAnalytics && (
                      <>
                        <Typography>
                          Total Users: {userAnalytics.totalUsers}
                          <Box
                            component="span"
                            sx={{ color: "success.main", ml: 1 }}
                          >
                            +{userAnalytics.newUsers} new
                          </Box>
                        </Typography>
                        <Typography>
                          OAuth Users: {userAnalytics.oauthUsers}
                          <Box
                            component="span"
                            sx={{ color: "success.main", ml: 1 }}
                          >
                            +{userAnalytics.newOauthUsers} new
                          </Box>
                        </Typography>
                        <Typography>
                          Admin Users: {userAnalytics.adminUsers}
                        </Typography>
                      </>
                    )}
                  </CardContent>
                </Card>
              </Grid>
              <Grid item xs={12} md={6}>
                <Card>
                  <CardContent>
                    <Typography variant="h6" gutterBottom>
                      Task Analytics
                    </Typography>
                    {taskAnalytics && (
                      <>
                        <Typography>
                          Total Tasks: {taskAnalytics.totalTasks}
                          <Box
                            component="span"
                            sx={{ color: "success.main", ml: 1 }}
                          >
                            +{taskAnalytics.newTasks} new
                          </Box>
                        </Typography>
                        <Typography>
                          Total Executions: {taskAnalytics.totalExecutions}
                          <Box
                            component="span"
                            sx={{ color: "success.main", ml: 1 }}
                          >
                            +{taskAnalytics.newExecutions} new
                          </Box>
                        </Typography>
                        <Typography>
                          Successful Executions:{" "}
                          {taskAnalytics.successfulExecutions}
                        </Typography>
                        <Typography>
                          Failed Executions: {taskAnalytics.failedExecutions}
                        </Typography>
                        <Typography>
                          Pending/Running Executions:{" "}
                          {taskAnalytics.totalExecutions -
                            taskAnalytics.successfulExecutions -
                            taskAnalytics.failedExecutions}
                        </Typography>
                        <Typography>
                          Scheduled Tasks: {taskAnalytics.scheduledTasks}
                          <Box
                            component="span"
                            sx={{ color: "success.main", ml: 1 }}
                          >
                            +{taskAnalytics.newScheduledTasks} new
                          </Box>
                        </Typography>
                        <Typography>
                          Templates: {taskAnalytics.templates}
                          <Box
                            component="span"
                            sx={{ color: "success.main", ml: 1 }}
                          >
                            +{taskAnalytics.newTemplates} new
                          </Box>
                        </Typography>
                        <Typography>
                          Average Execution Time:{" "}
                          {taskAnalytics.averageExecutionTime != null
                            ? `${(
                                taskAnalytics.averageExecutionTime / 1000
                              ).toFixed(1)}s`
                            : "N/A"}
                        </Typography>
                      </>
                    )}
                  </CardContent>
                </Card>
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
              <Grid item xs={12} md={6}>
                <Card>
                  <CardContent>
                    <Typography variant="h6" gutterBottom>
                      Workflow Analytics
                    </Typography>
                    {taskAnalytics && (
                      <>
                        <Typography>
                          Total Workflows: {taskAnalytics.totalWorkflows}
                          <Box
                            component="span"
                            sx={{ color: "success.main", ml: 1 }}
                          >
                            +{taskAnalytics.newWorkflows} new
                          </Box>
                        </Typography>
                        <Typography>
                          Workflow Executions:{" "}
                          {taskAnalytics.workflowExecutions}
                          <Box
                            component="span"
                            sx={{ color: "success.main", ml: 1 }}
                          >
                            +{taskAnalytics.newWorkflowExecutions} new
                          </Box>
                        </Typography>
                        <Typography>
                          Successful Workflow Executions:{" "}
                          {taskAnalytics.successfulWorkflowExecutions}
                        </Typography>
                        <Typography>
                          Failed Workflow Executions:{" "}
                          {taskAnalytics.failedWorkflowExecutions}
                        </Typography>
                        <Typography>
                          Pending/Running Workflow Executions:{" "}
                          {taskAnalytics.pendingWorkflowExecutions}
                        </Typography>
                      </>
                    )}
                  </CardContent>
                </Card>
              </Grid>
            </Grid>
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
                  <TableCell>Created</TableCell>
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
                    <TableCell colSpan={9} align="center">
                      <CircularProgress />
                    </TableCell>
                  </TableRow>
                ) : (
                  contextUsers.map((user) => {
                    // Determine roles to display, SOLELY from roles array.
                    let displayRoles: ("partner" | "customer")[] = [];
                    if (user.roles && user.roles.length > 0) {
                      displayRoles = user.roles; // Use the array if present and not empty
                    }
                    // If user.roles is empty or undefined, displayRoles remains [], meaning no roles will be shown.

                    return (
                      <TableRow key={user.userId}>
                        <TableCell>{user.email}</TableCell>
                        <TableCell>
                          {new Date(user.createdAt).toLocaleDateString()}
                        </TableCell>
                        <TableCell>
                          <Box
                            sx={{ display: "flex", gap: 0.5, flexWrap: "wrap" }}
                          >
                            {displayRoles.map(
                              (role: "partner" | "customer") => (
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
                            color={user.taskCount > 0 ? "primary" : "default"}
                          />
                        </TableCell>
                        <TableCell>
                          <Chip
                            label={user.workflowCount || 0}
                            size="small"
                            color={
                              user.workflowCount > 0 ? "primary" : "default"
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
                          <Box sx={{ display: "flex", gap: 1 }}>
                            <Button
                              variant="outlined"
                              size="small"
                              onClick={() => handleRoleDialogOpen(user)}
                              startIcon={<EditIcon />}
                            >
                              Manage Roles
                            </Button>
                            {!user.isAdmin && user.isActive !== false && (
                              <Button
                                variant="outlined"
                                color="error"
                                size="small"
                                onClick={() => {
                                  setSelectedUser(user);
                                  setDeactivateDialogOpen(true);
                                }}
                                startIcon={<PersonOffIcon />}
                              >
                                Deactivate
                              </Button>
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
                  <TableCell>Full Name</TableCell>
                  <TableCell>Company Name</TableCell>
                  <TableCell>Phone Number</TableCell>
                  <TableCell>
                    <Box
                      sx={{
                        display: "flex",
                        alignItems: "center",
                        gap: 0.5,
                        fontWeight: "bold",
                      }}
                    >
                      Joined At
                      <Box
                        component="span"
                        sx={{ ml: 0.5, fontSize: "0.75rem" }}
                      >
                        ↓
                      </Box>
                    </Box>
                  </TableCell>
                  <TableCell>Use Cases</TableCell>
                  <TableCell>Use Case Description</TableCell>
                  <TableCell>Last Invited</TableCell>
                  <TableCell>Request Report</TableCell>
                  <TableCell>Support Note</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell>Actions</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {adminLoading ? (
                  <TableRow>
                    <TableCell colSpan={11} align="center">
                      <CircularProgress />
                    </TableCell>
                  </TableRow>
                ) : (
                  waitlist.map((entry: WaitlistEntry) => {
                    const userExists = contextUsers.some(
                      (user) => user.email === entry.email
                    );
                    return (
                      <TableRow key={entry.email}>
                        <TableCell>{entry.email}</TableCell>
                        <TableCell>{entry.fullName || "-"}</TableCell>
                        <TableCell>{entry.companyName || "-"}</TableCell>
                        <TableCell>{entry.phoneNumber || "-"}</TableCell>
                        <TableCell>
                          {entry.joinedAt
                            ? new Date(entry.joinedAt).toLocaleDateString()
                            : "-"}
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
                        <TableCell>{getTimeAgo(entry.invitedAt)}</TableCell>
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
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "space-between",
                              minHeight: "40px",
                            }}
                          >
                            <Tooltip
                              title={entry.supportNote || "No note"}
                              placement="top-start"
                            >
                              <Typography
                                variant="body2"
                                sx={{
                                  flexGrow: 1,
                                  maxWidth: 220, // Adjusted width
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                  pr: 0.5, // Padding before button
                                }}
                              >
                                {entry.supportNote || "-"}
                              </Typography>
                            </Tooltip>
                            <IconButton
                              onClick={() =>
                                handleEditNoteClick(
                                  entry.email,
                                  entry.supportNote || ""
                                )
                              }
                              size="small"
                            >
                              <EditIcon fontSize="small" />
                            </IconButton>
                          </Box>
                        </TableCell>
                        <TableCell>
                          <Chip
                            label={entry.status || "pending"}
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
                            {!userExists && entry.status !== "invited" && (
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
                            {!userExists && entry.status === "invited" && (
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
                            {userExists && (
                              <Typography
                                variant="body2"
                                color="text.secondary"
                              >
                                Registered
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
                        <Link
                          to={`/tasks/${task.taskId}`}
                          style={{
                            color: "#1976d2",
                            textDecoration: "none",
                          }}
                          target="_blank"
                          rel="noopener noreferrer"
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

        <TabPanel value={tabValue} index={5}>
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
                          to={`/profile/${session.userId}`}
                          style={{ textDecoration: "none" }}
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
          <DialogContentText sx={{ mb: 2 }}>
            Select roles for user: {selectedUser?.email}
          </DialogContentText>
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

      {success && (
        <Alert severity="success" onClose={() => setSuccess("")} sx={{ mt: 2 }}>
          {success}
        </Alert>
      )}
    </Container>
  );
}
