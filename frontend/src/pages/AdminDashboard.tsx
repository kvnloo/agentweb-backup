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
  Container
} from '@mui/material';
import { format } from 'date-fns';
import { Link } from 'react-router-dom';
import axios from 'axios';
import { useAuth } from '../contexts/AuthContext';
import { buildApiUrl } from '../config';

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

export default function AdminDashboard() {
  const [tabValue, setTabValue] = useState(0);
  const [startDate, setStartDate] = useState<Date | null>(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));
  const [endDate, setEndDate] = useState<Date | null>(new Date());
  const [tasks, setTasks] = useState<any[]>([]);
  const [orderBy, setOrderBy] = useState<keyof any>('createdAt');
  const [order, setOrder] = useState<'asc' | 'desc'>('desc');
  const [message, setMessage] = useState('');
  const [title, setTitle] = useState('');
  const [showPreview, setShowPreview] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
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
    error: adminError
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

  const handleTabChange = (_event: React.SyntheticEvent, newValue: number) => {
    setTabValue(newValue);
  };

  const handleWaitlistAction = async (email: string, status: string) => {
    await updateWaitlistStatus(email, status);
  };

  const handleSort = (property: keyof any) => {
    const isAsc = orderBy === property && order === 'asc';
    setOrder(isAsc ? 'desc' : 'asc');
    setOrderBy(property);
  };

  const sortedTasks = React.useMemo(() => {
    return [...tasks].sort((a, b) => {
      if (orderBy === 'createdAt') {
        return order === 'asc' 
          ? new Date(a[orderBy]).getTime() - new Date(b[orderBy]).getTime()
          : new Date(b[orderBy]).getTime() - new Date(a[orderBy]).getTime();
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
      component="span"
      onClick={() => handleSort(property)}
      sx={{
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        '&:hover': {
          color: 'primary.main',
        }
      }}
    >
      {label}
      {orderBy === property && (
        <Typography component="span" sx={{ ml: 0.5, fontSize: '0.75rem' }}>
          {order === 'asc' ? '↑' : '↓'}
        </Typography>
      )}
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
      setShowPreview(false);
    } catch (error: any) {
      setError(error.response?.data?.message || 'Failed to send announcement');
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
                        <Typography>Total Users: {userAnalytics.totalUsers}</Typography>
                        <Typography>New Users: {userAnalytics.newUsers}</Typography>
                        <Typography>OAuth Users: {userAnalytics.oauthUsers}</Typography>
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
                        <Typography>Total Tasks: {taskAnalytics.totalTasks}</Typography>
                        <Typography>New Tasks: {taskAnalytics.newTasks}</Typography>
                        <Typography>Total Executions: {taskAnalytics.totalExecutions}</Typography>
                        <Typography>Successful Executions: {taskAnalytics.successfulExecutions}</Typography>
                        <Typography>Failed Executions: {taskAnalytics.failedExecutions}</Typography>
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
            </Grid>
          )}
        </TabPanel>

        <TabPanel value={tabValue} index={1}>
          <Typography variant="h6" gutterBottom>
            Send Announcement
          </Typography>

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

          <Box component="form" onSubmit={handleAnnouncementSubmit}>
            <TextField
              label="Email Title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              fullWidth
              required
              sx={{ mb: 3 }}
            />
            <TextField
              label="Announcement Message"
              multiline
              rows={4}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              fullWidth
              required
              sx={{ mb: 3 }}
              helperText="Enter your message with line breaks for paragraphs"
            />

            <Box sx={{ mb: 3, display: 'flex', gap: 2 }}>
              <Button
                type="submit"
                variant="contained"
                disabled={loading}
                sx={{ minWidth: 120 }}
              >
                {loading ? <CircularProgress size={24} /> : 'Send'}
              </Button>
              
              <Button
                type="button"
                variant="outlined"
                onClick={() => setShowPreview(!showPreview)}
              >
                {showPreview ? 'Hide Preview' : 'Show Preview'}
              </Button>
            </Box>

            {showPreview && (
              <Paper sx={{ p: 3, bgcolor: 'grey.50' }}>
                <Typography variant="h6" gutterBottom>
                  Email Preview
                </Typography>
                <Paper sx={{ p: 2, mb: 2 }}>
                  <Typography variant="subtitle1" gutterBottom>
                    Subject: {title}
                  </Typography>
                  <Box sx={{ mt: 2 }}>
                    {message.split('\n').map((line, index) => (
                      line.trim() && (
                        <Typography key={index} paragraph>
                          {line}
                        </Typography>
                      )
                    ))}
                  </Box>
                </Paper>
              </Paper>
            )}
          </Box>
        </TabPanel>

        <TabPanel value={tabValue} index={2}>
          <TableContainer component={Paper}>
            <Table>
              <TableHead>
                <TableRow>
                  <TableCell>User ID</TableCell>
                  <TableCell>Email</TableCell>
                  <TableCell>Created At</TableCell>
                  <TableCell>Tasks</TableCell>
                  <TableCell>Workflows</TableCell>
                  <TableCell>OAuth User</TableCell>
                  <TableCell>Admin</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {adminLoading ? (
                  <TableRow>
                    <TableCell colSpan={7} align="center">
                      <CircularProgress />
                    </TableCell>
                  </TableRow>
                ) : (
                  users.map((user) => (
                    <TableRow key={user.userId}>
                      <TableCell>{user.userId}</TableCell>
                      <TableCell>{user.email}</TableCell>
                      <TableCell>{new Date(user.createdAt).toLocaleDateString()}</TableCell>
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
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </TableContainer>
        </TabPanel>

        <TabPanel value={tabValue} index={3}>
          <TableContainer component={Paper}>
            <Table>
              <TableHead>
                <TableRow>
                  <TableCell>Email</TableCell>
                  <TableCell>Joined At</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell>Actions</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {adminLoading ? (
                  <TableRow>
                    <TableCell colSpan={4} align="center">
                      <CircularProgress />
                    </TableCell>
                  </TableRow>
                ) : (
                  waitlist.map((entry) => {
                    const userExists = users.some(user => user.email === entry.email);
                    return (
                      <TableRow key={entry.email}>
                        <TableCell>{entry.email}</TableCell>
                        <TableCell>{new Date(entry.joinedAt).toLocaleDateString()}</TableCell>
                        <TableCell>
                          {userExists ? (
                            <Chip label="Registered" color="success" />
                          ) : (
                            entry.status
                          )}
                        </TableCell>
                        <TableCell>
                          {!userExists && entry.status === 'pending' && (
                            <Button
                              variant="contained"
                              color="primary"
                              onClick={() => handleWaitlistAction(entry.email, 'invited')}
                            >
                              Invite
                            </Button>
                          )}
                          {!userExists && entry.status === 'invited' && (
                            <Button
                              variant="outlined"
                              color="secondary"
                              onClick={() => handleWaitlistAction(entry.email, 'pending')}
                            >
                              Revoke
                            </Button>
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
                  <TableCell>Details</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {adminLoading ? (
                  <TableRow>
                    <TableCell colSpan={6} align="center">
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
                        <Link 
                          to={`/admin/tasks/${task.taskId}`}
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
      </Paper>
    </Container>
  );
} 
