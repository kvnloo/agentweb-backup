import React, { useEffect, useState } from 'react';
import { useAdmin } from '../contexts/AdminContext';
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
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  SelectChangeEvent
} from '@mui/material';
import { format } from 'date-fns';
import { Link } from 'react-router-dom';
import axios from 'axios';
import { useAuth } from '../contexts/AuthContext';
import { buildApiUrl } from '../config';
import DOMPurify from 'dompurify';
import {
  Info as InfoIcon,
  Close as CloseIcon
} from '@mui/icons-material';

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
    'aria-controls': `admin-tabpanel-${index}`,
  };
}

interface WaitlistEntry {
  email: string;
  status: 'pending' | 'invited' | 'rejected';
  createdAt: string;
  invitedAt?: string;
  fullName?: string;
  companyName?: string;
  phoneNumber?: string;
  joinedAt?: string;
  useCaseCategories?: string[];
  useCaseDescription?: string;
  requestReport?: boolean;
}

const ChatDialog = ({ session, open, onClose }: { session: any; open: boolean; onClose: () => void }) => {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="md"
      fullWidth
    >
      <DialogTitle>
        Chat Session Details
        <IconButton
          aria-label="close"
          onClick={onClose}
          sx={{ position: 'absolute', right: 8, top: 8 }}
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
              User ID: <Link 
                to={`/profile/${session.userId}`}
                style={{ 
                  color: '#1976d2',
                  textDecoration: 'none'
                }}
                target="_blank"
                rel="noopener noreferrer"
              >
                {session.userId}
              </Link>
            </Typography>
            <Box sx={{ mt: 2 }}>
              {session.messages?.filter((msg: any) => msg.role !== 'system').map((msg: any, index: number) => (
                <Box
                  key={index}
                  sx={{
                    mb: 2,
                    p: 2,
                    borderRadius: 1,
                    backgroundColor: 
                      msg.role === 'user' ? 'grey.100' :
                      msg.role === 'assistant' ? '#e3f2fd' :
                      '#f3e5f5', // System messages get a light purple background
                    color: 'text.primary',
                    border: msg.role !== 'user' ? '1px solid' : 'none',
                    borderColor: 
                      msg.role === 'assistant' ? '#90caf9' :
                      msg.role === 'system' ? '#ce93d8' : 'transparent',
                    '& code': {
                      backgroundColor: 'rgba(0, 0, 0, 0.04)',
                      padding: '2px 4px',
                      borderRadius: '4px',
                      fontFamily: 'monospace'
                    },
                    '& pre': {
                      maxWidth: '360px',
                      overflow: 'auto',
                      backgroundColor: 'rgba(0, 0, 0, 0.04)',
                      padding: '8px',
                      borderRadius: '4px',
                      margin: '8px 0'
                    },
                    '& ul, & ol': {
                      marginTop: '4px',
                      marginBottom: '4px',
                      paddingLeft: '20px'
                    },
                    '& li': {
                      marginBottom: '2px'
                    },
                    '& p': {
                      marginTop: '4px',
                      marginBottom: '4px'
                    },
                    '& a': {
                      color: '#1976d2',
                      textDecoration: 'none',
                      '&:hover': {
                        textDecoration: 'underline'
                      }
                    },
                    '& table': {
                      maxWidth: '360px',
                      borderCollapse: 'collapse',
                      margin: '8px 0',
                      '& th, & td': {
                        border: '1px solid rgba(0, 0, 0, 0.12)',
                        padding: '4px 8px'
                      }
                    }
                  }}
                >
                  <Typography 
                    variant="caption" 
                    display="block" 
                    gutterBottom
                    sx={{
                      color: 
                        msg.role === 'assistant' ? '#1976d2' :
                        msg.role === 'system' ? '#7b1fa2' : 
                        'text.secondary',
                      fontWeight: 'bold'
                    }}
                  >
                    {msg.role.toUpperCase()}
                    {msg.metadata?.timestamp && !isNaN(new Date(msg.metadata.timestamp).getTime()) && (
                      <> - {new Date(msg.metadata.timestamp).toLocaleString()}</>
                    )}
                  </Typography>
                  <Box
                    sx={{
                      '& > div': {
                        overflow: 'auto',
                        maxWidth: '100%'
                      }
                    }}
                    dangerouslySetInnerHTML={{ 
                      __html: DOMPurify.sanitize(msg.content, {
                        ADD_TAGS: ['strong', 'em', 'code', 'ul', 'li', 'pre', 'a', 'table', 'tr', 'td', 'th', 'p'],
                        ADD_ATTR: ['href', 'target']
                      })
                    }}
                  />
                  {msg.metadata && (
                    <Box sx={{ mt: 1 }}>
                      <Typography variant="caption" color="text.secondary">
                        Metadata:
                      </Typography>
                      <pre style={{ 
                        fontSize: '0.75rem', 
                        margin: 0,
                        padding: '8px',
                        backgroundColor: 'rgba(0, 0, 0, 0.03)',
                        borderRadius: '4px',
                        overflowX: 'auto'
                      }}>
                        {JSON.stringify(msg.metadata, null, 2)}
                      </pre>
                    </Box>
                  )}
                  {msg.usage && (
                    <Box sx={{ mt: 1 }}>
                      <Typography variant="caption" color="text.secondary">
                        Usage:
                      </Typography>
                      <pre style={{ 
                        fontSize: '0.75rem', 
                        margin: 0,
                        padding: '8px',
                        backgroundColor: 'rgba(0, 0, 0, 0.03)',
                        borderRadius: '4px',
                        overflowX: 'auto'
                      }}>
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
  const [startDate, setStartDate] = useState<Date | null>(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));
  const [endDate, setEndDate] = useState<Date | null>(new Date());
  const [tasks, setTasks] = useState<any[]>([]);
  const [orderBy, setOrderBy] = useState<keyof any>('latestRunTime');
  const [order, setOrder] = useState<'asc' | 'desc'>('desc');
  const [message, setMessage] = useState('');
  const [title, setTitle] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [selectedUser, setSelectedUser] = useState<any>(null);
  const [deactivateDialogOpen, setDeactivateDialogOpen] = useState(false);
  const [chatSessions, setChatSessions] = useState<any[]>([]);
  const [selectedSession, setSelectedSession] = useState<any>(null);
  const [chatDialogOpen, setChatDialogOpen] = useState(false);
  const [roleDialogOpen, setRoleDialogOpen] = useState(false);
  const [selectedUserRole, setSelectedUserRole] = useState<string>('');
  const { token } = useAuth();
  
  const {
    users,
    waitlist,
    taskAnalytics,
    userAnalytics,
    loadUsers,
    loadWaitlist,
    loadAnalytics,
    updateWaitlistStatus,
    loading: adminLoading,
    error: adminError,
    setUsers
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
        format(startDate, 'yyyy-MM-dd'),
        format(endDate, 'yyyy-MM-dd')
      );
    }
  }, [startDate, endDate, tabValue]);

  useEffect(() => {
    const loadTasks = async () => {
      try {
        const response = await axios.get(
          buildApiUrl('/api/admin/tasks'),
          {
            headers: {
              Authorization: `Bearer ${token}`
            }
          }
        );
        setTasks(response.data);
      } catch (error) {
        console.error('Error loading tasks:', error);
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

  const handleResendInvitation = async (email: string) => {
    try {
      setLoading(true);
      await axios.post(
        buildApiUrl('/api/admin/waitlist/resend-invitation'),
        { email },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      setSuccess(`Invitation email resent to ${email}`);
      await loadWaitlist(); // Reload waitlist data
    } catch (error: any) {
      setError(error.response?.data?.message || 'Failed to resend invitation');
    } finally {
      setLoading(false);
    }
  };

  const getTimeAgo = (dateString?: string) => {
    if (!dateString) return 'Never';
    
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
      return `${diffMonths} month${diffMonths > 1 ? 's' : ''} ago`;
    } else if (diffDays > 0) {
      return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
    } else if (diffHours > 0) {
      return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
    } else if (diffMin > 0) {
      return `${diffMin} minute${diffMin > 1 ? 's' : ''} ago`;
    } else {
      return 'Just now';
    }
  };

  const handleSort = (property: keyof any) => {
    const isAsc = orderBy === property && order === 'asc';
    setOrder(isAsc ? 'desc' : 'asc');
    setOrderBy(property);
  };

  const sortedTasks = React.useMemo(() => {
    return [...tasks].sort((a, b) => {
      if (orderBy === 'createdAt' || orderBy === 'latestRunTime') {
        // For date fields, handle null values and sort by date
        const aValue = a[orderBy] ? new Date(a[orderBy]).getTime() : 0;
        const bValue = b[orderBy] ? new Date(b[orderBy]).getTime() : 0;
        
        return order === 'asc' 
          ? aValue - bValue
          : bValue - aValue;
      } else if (orderBy === 'completedRuns') {
        // For completedRuns, sort by completion ratio
        const aRatio = a.totalRuns > 0 ? (a.completedRuns / a.totalRuns) : 0;
        const bRatio = b.totalRuns > 0 ? (b.completedRuns / b.totalRuns) : 0;
        
        return order === 'asc'
          ? aRatio - bRatio
          : bRatio - aRatio;
      }
      
      const aValue = a[orderBy]?.toString().toLowerCase() ?? '';
      const bValue = b[orderBy]?.toString().toLowerCase() ?? '';
      
      return order === 'asc'
        ? aValue.localeCompare(bValue)
        : bValue.localeCompare(aValue);
    });
  }, [tasks, order, orderBy]);

  const SortLabel = ({ property, label }: { property: keyof any; label: string }) => (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        cursor: 'pointer',
        userSelect: 'none',
        '&:hover': {
          color: 'primary.main',
        },
      }}
      onClick={() => handleSort(property)}
    >
      {label}
      {orderBy === property ? (
        <Box component="span" sx={{ ml: 1 }}>
          {order === 'desc' ? '↓' : '↑'}
        </Box>
      ) : null}
    </Box>
  );

  const formatMessageToHtml = (text: string) => {
    return text
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .map(line => `<p>${line}</p>`)
      .join('');
  };

  const handleAnnouncementSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!message.trim() || !title.trim()) {
      setError('Please enter both title and message');
      return;
    }

    setLoading(true);
    setError('');
    setSuccess('');

    try {
      await axios.post(
        buildApiUrl('/api/admin/announcements/send'),
        { 
          title, 
          message: formatMessageToHtml(message)
        },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      setSuccess('Announcement sent successfully');
      setMessage('');
      setTitle('');
    } catch (error: any) {
      setError(error.response?.data?.message || 'Failed to send announcement');
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
      setError(error.response?.data?.message || 'Failed to deactivate user');
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
        buildApiUrl('/api/admin/chat-sessions'),
        { headers: { Authorization: `Bearer ${token}` } }
      );
      setChatSessions(response.data);
    } catch (error: any) {
      setError(error.response?.data?.message || 'Failed to load chat sessions');
    } finally {
      setLoading(false);
    }
  };

  const handleViewChat = (session: any) => {
    setSelectedSession(session);
    setChatDialogOpen(true);
  };

  const handleRoleChange = (event: SelectChangeEvent) => {
    setSelectedUserRole(event.target.value as string);
  };

  const handleRoleDialogOpen = (user: any) => {
    setSelectedUser(user);
    setSelectedUserRole(user.role || 'partner');
    setRoleDialogOpen(true);
  };

  const handleRoleDialogClose = () => {
    setRoleDialogOpen(false);
  };

  const handleUpdateRole = async () => {
    try {
      setLoading(true);
      setError('');
      
      const response = await axios.put(
        buildApiUrl(`/api/admin/users/${selectedUser?.userId}/role`),
        { role: selectedUserRole },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      
      // Update user list
      const updatedUsers = users.map(user => 
        user.userId === selectedUser?.userId 
          ? { ...user, role: selectedUserRole, isAdmin: selectedUserRole === 'admin' } 
          : user
      );
      
      setUsers(updatedUsers);
      setSuccess('User role updated successfully');
      setRoleDialogOpen(false);
    } catch (err) {
      console.error('Error updating user role:', err);
      setError('Failed to update user role. Please try again.');
    } finally {
      setLoading(false);
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

      <Paper sx={{ width: '100%', mt: 3 }}>
        <Box sx={{ borderBottom: 1, borderColor: 'divider' }}>
          <Tabs value={tabValue} onChange={handleTabChange} aria-label="admin tabs">
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
                  value={startDate ? format(startDate, 'yyyy-MM-dd') : ''}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setStartDate(new Date(e.target.value))}
                  InputLabelProps={{
                    shrink: true,
                  }}
                />
              </Grid>
              <Grid item>
                <TextField
                  type="date"
                  label="End Date"
                  value={endDate ? format(endDate, 'yyyy-MM-dd') : ''}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEndDate(new Date(e.target.value))}
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
                          <Box component="span" sx={{ color: 'success.main', ml: 1 }}>
                            +{userAnalytics.newUsers} new
                          </Box>
                        </Typography>
                        <Typography>
                          OAuth Users: {userAnalytics.oauthUsers}
                          <Box component="span" sx={{ color: 'success.main', ml: 1 }}>
                            +{userAnalytics.newOauthUsers} new
                          </Box>
                        </Typography>
                        <Typography>Admin Users: {userAnalytics.adminUsers}</Typography>
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
                          <Box component="span" sx={{ color: 'success.main', ml: 1 }}>
                            +{taskAnalytics.newTasks} new
                          </Box>
                        </Typography>
                        <Typography>
                          Total Executions: {taskAnalytics.totalExecutions}
                          <Box component="span" sx={{ color: 'success.main', ml: 1 }}>
                            +{taskAnalytics.newExecutions} new
                          </Box>
                        </Typography>
                        <Typography>Successful Executions: {taskAnalytics.successfulExecutions}</Typography>
                        <Typography>Failed Executions: {taskAnalytics.failedExecutions}</Typography>
                        <Typography>Pending/Running Executions: {
                          taskAnalytics.totalExecutions - taskAnalytics.successfulExecutions - taskAnalytics.failedExecutions
                        }</Typography>
                        <Typography>
                          Scheduled Tasks: {taskAnalytics.scheduledTasks}
                          <Box component="span" sx={{ color: 'success.main', ml: 1 }}>
                            +{taskAnalytics.newScheduledTasks} new
                          </Box>
                        </Typography>
                        <Typography>
                          Templates: {taskAnalytics.templates}
                          <Box component="span" sx={{ color: 'success.main', ml: 1 }}>
                            +{taskAnalytics.newTemplates} new
                          </Box>
                        </Typography>
                        <Typography>
                          Average Execution Time: {
                            taskAnalytics.averageExecutionTime != null 
                              ? `${(taskAnalytics.averageExecutionTime / 1000).toFixed(1)}s`
                              : 'N/A'
                          }
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
                          <Box component="span" sx={{ color: 'success.main', ml: 1 }}>
                            +{taskAnalytics.newWebsiteConfigs} new
                          </Box>
                        </Typography>
                        <Typography>
                          API Credentials: {taskAnalytics.apiConfigs}
                          <Box component="span" sx={{ color: 'success.main', ml: 1 }}>
                            +{taskAnalytics.newApiConfigs} new
                          </Box>
                        </Typography>
                        <Typography>Shared Credentials: {taskAnalytics.sharedConfigs}</Typography>
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
                          <Box component="span" sx={{ color: 'success.main', ml: 1 }}>
                            +{taskAnalytics.newWorkflows} new
                          </Box>
                        </Typography>
                        <Typography>
                          Workflow Executions: {taskAnalytics.workflowExecutions}
                          <Box component="span" sx={{ color: 'success.main', ml: 1 }}>
                            +{taskAnalytics.newWorkflowExecutions} new
                          </Box>
                        </Typography>
                        <Typography>Successful Workflow Executions: {taskAnalytics.successfulWorkflowExecutions}</Typography>
                        <Typography>Failed Workflow Executions: {taskAnalytics.failedWorkflowExecutions}</Typography>
                        <Typography>Pending/Running Workflow Executions: {taskAnalytics.pendingWorkflowExecutions}</Typography>
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
                  Supported HTML tags: <code>&lt;b&gt;</code> for bold, <code>&lt;i&gt;</code> for italic, 
                  <code>&lt;u&gt;</code> for underline, <code>&lt;font color="..."&gt;</code> for text color, 
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
                    backgroundColor: 'grey.50',
                    minHeight: '100px'
                  }}
                >
                  <div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(message) }} />
                </Paper>
              </Box>
            )}

            <Button
              type="submit"
              variant="contained"
              disabled={loading}
              sx={{ minWidth: 120 }}
            >
              {loading ? <CircularProgress size={24} /> : 'Send'}
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
                  <TableCell>Role</TableCell>
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
                  users.map((user) => (
                    <TableRow key={user.userId}>
                      <TableCell>{user.email}</TableCell>
                      <TableCell>{new Date(user.createdAt).toLocaleDateString()}</TableCell>
                      <TableCell>
                        <Chip 
                          label={user.role || 'partner'}
                          color={
                            user.role === 'customer' ? 'success' :
                            'primary' // Default to primary (partner) color
                          }
                          size="small"
                          onClick={() => handleRoleDialogOpen(user)}
                          sx={{ cursor: 'pointer' }}
                        />
                      </TableCell>
                      <TableCell>
                        <Chip 
                          label={user.taskCount || 0} 
                          size="small"
                          color={user.taskCount > 0 ? 'primary' : 'default'}
                        />
                      </TableCell>
                      <TableCell>
                        <Chip 
                          label={user.workflowCount || 0} 
                          size="small"
                          color={user.workflowCount > 0 ? 'primary' : 'default'}
                        />
                      </TableCell>
                      <TableCell>{user.isOAuthUser ? 'Yes' : 'No'}</TableCell>
                      <TableCell>{user.isAdmin ? 'Yes' : 'No'}</TableCell>
                      <TableCell>
                        <Chip 
                          label={user.isActive === false ? 'Inactive' : 'Active'} 
                          color={user.isActive === false ? 'error' : 'success'}
                          size="small"
                        />
                      </TableCell>
                      <TableCell>
                        {!user.isAdmin && user.isActive !== false && (
                          <Button
                            variant="outlined"
                            color="error"
                            size="small"
                            onClick={() => {
                              setSelectedUser(user);
                              setDeactivateDialogOpen(true);
                            }}
                          >
                            Deactivate
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))
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
                        display: 'flex',
                        alignItems: 'center',
                        gap: 0.5,
                        fontWeight: 'bold',
                      }}
                    >
                      Joined At
                      <Box component="span" sx={{ ml: 0.5, fontSize: '0.75rem' }}>
                        ↓
                      </Box>
                    </Box>
                  </TableCell>
                  <TableCell>Use Cases</TableCell>
                  <TableCell>Use Case Description</TableCell>
                  <TableCell>Last Invited</TableCell>
                  <TableCell>Request Report</TableCell>
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
                    const userExists = users.some(user => user.email === entry.email);
                    return (
                      <TableRow key={entry.email}>
                        <TableCell>{entry.email}</TableCell>
                        <TableCell>{entry.fullName || '-'}</TableCell>
                        <TableCell>{entry.companyName || '-'}</TableCell>
                        <TableCell>{entry.phoneNumber || '-'}</TableCell>
                        <TableCell>{entry.joinedAt ? new Date(entry.joinedAt).toLocaleDateString() : '-'}</TableCell>
                        <TableCell>
                          {entry.useCaseCategories && entry.useCaseCategories.length > 0 ? (
                            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                              {entry.useCaseCategories.map((category: string) => (
                                <Chip key={category} label={category} size="small" />
                              ))}
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
                                <Typography variant="body2" style={{ whiteSpace: 'pre-wrap' }}>
                                  {entry.useCaseDescription}
                                </Typography>
                              } 
                              placement="top-start"
                              arrow
                              enterDelay={500}
                              leaveDelay={200}
                              sx={{ maxWidth: 500 }}
                            >
                              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                                <Typography 
                                  variant="body2" 
                                  sx={{ 
                                    maxWidth: 220, 
                                    overflow: 'hidden', 
                                    textOverflow: 'ellipsis', 
                                    whiteSpace: 'nowrap',
                                    cursor: 'pointer'
                                  }}
                                >
                                  {entry.useCaseDescription}
                                </Typography>
                                <InfoIcon 
                                  fontSize="small" 
                                  color="action" 
                                  sx={{ 
                                    opacity: 0.7,
                                    '&:hover': { opacity: 1 }
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
                          {getTimeAgo(entry.invitedAt)}
                        </TableCell>
                        <TableCell>
                          <Chip 
                            label={entry.requestReport ? 'Yes' : 'No'} 
                            size="small"
                            color={entry.requestReport ? 'primary' : 'default'}
                          />
                        </TableCell>
                        <TableCell>
                          <Chip 
                            label={entry.status || 'pending'} 
                            color={
                              entry.status === 'invited' ? 'success' : 
                              entry.status === 'rejected' ? 'error' : 
                              'default'
                            }
                            size="small"
                          />
                        </TableCell>
                        <TableCell>
                          {!userExists && entry.status !== 'invited' && (
                            <Button
                              variant="outlined"
                              size="small"
                              onClick={() => handleWaitlistAction(entry.email, 'invited')}
                            >
                              Invite
                            </Button>
                          )}
                          {!userExists && entry.status === 'invited' && (
                            <Button
                              variant="outlined"
                              size="small"
                              onClick={() => handleResendInvitation(entry.email)}
                            >
                              Resend
                            </Button>
                          )}
                          {userExists && (
                            <Typography variant="body2" color="text.secondary">
                              Registered
                            </Typography>
                          )}
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
                    <SortLabel property="latestRunStatus" label="Latest Run Status" />
                  </TableCell>
                  <TableCell>
                    <SortLabel property="latestRunTime" label="Latest Run Time" />
                  </TableCell>
                  <TableCell>
                    <SortLabel property="completedRuns" label="Completed/Total Runs" />
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
                  sortedTasks.map((task) => (
                    <TableRow key={task.taskId}>
                      <TableCell>{task.taskId}</TableCell>
                      <TableCell>{task.name}</TableCell>
                      <TableCell>
                        {task.prompt.length > 100 
                          ? `${task.prompt.substring(0, 100)}...` 
                          : task.prompt}
                      </TableCell>
                      <TableCell>{task.userId}</TableCell>
                      <TableCell>{new Date(task.createdAt).toLocaleDateString()}</TableCell>
                      <TableCell>
                        <Chip 
                          label={task.latestRunStatus || 'none'} 
                          color={
                            task.latestRunStatus === 'completed' ? 'success' :
                            task.latestRunStatus === 'failed' ? 'error' :
                            task.latestRunStatus === 'pending' ? 'warning' :
                            task.latestRunStatus === 'running' ? 'info' : 'default'
                          }
                          size="small"
                        />
                      </TableCell>
                      <TableCell>
                        {task.latestRunTime 
                          ? new Date(task.latestRunTime).toLocaleString() 
                          : 'Never'}
                      </TableCell>
                      <TableCell>
                        {task.completedRuns || 0}/{task.totalRuns || 0}
                        {task.totalRuns > 0 && (
                          <Box component="span" sx={{ ml: 1 }}>
                            ({Math.round((task.completedRuns / task.totalRuns) * 100)}%)
                          </Box>
                        )}
                      </TableCell>
                      <TableCell>
                        <Link 
                          to={`/tasks/${task.taskId}`}
                          style={{ 
                            color: '#1976d2',
                            textDecoration: 'none'
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
                  <TableCell>User</TableCell>
                  <TableCell>Created At</TableCell>
                  <TableCell>Last Updated</TableCell>
                  <TableCell>Messages</TableCell>
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
                      <TableCell>{session.sessionId}</TableCell>
                      <TableCell>{session.userId}</TableCell>
                      <TableCell>{new Date(session.createdAt).toLocaleString()}</TableCell>
                      <TableCell>{new Date(session.updatedAt).toLocaleString()}</TableCell>
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
            Are you sure you want to deactivate the account for {selectedUser?.email}? 
            This action will prevent the user from accessing their account.
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
            {loading ? <CircularProgress size={24} /> : 'Deactivate'}
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
        <DialogTitle>Update User Role</DialogTitle>
        <DialogContent>
          <Box sx={{ mt: 2 }}>
            <Typography variant="body1" gutterBottom>
              Update role for user: <strong>{selectedUser?.email}</strong>
            </Typography>
            <FormControl fullWidth sx={{ mt: 2 }}>
              <InputLabel id="role-select-label">Role</InputLabel>
              <Select
                labelId="role-select-label"
                value={selectedUserRole}
                label="Role"
                onChange={handleRoleChange}
              >
                <MenuItem value="partner">Partner</MenuItem>
                <MenuItem value="customer">Customer</MenuItem>
              </Select>
            </FormControl>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
              <strong>Role access:</strong><br />
              - Admin: Controlled by admin flag, not role<br />
              - Partner (Default): Access to agent features (tasks, workflows)<br />
              - Customer: Access to marketing features only
            </Typography>
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleRoleDialogClose}>Cancel</Button>
          <Button 
            onClick={handleUpdateRole} 
            variant="contained" 
            color="primary"
            disabled={loading}
          >
            {loading ? <CircularProgress size={24} /> : 'Update Role'}
          </Button>
        </DialogActions>
      </Dialog>
    </Container>
  );
} 
