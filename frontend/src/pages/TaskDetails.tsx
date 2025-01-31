import { useState, useEffect } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import {
  Container,
  Typography,
  Paper,
  Box,
  Chip,
  Button,
  Grid,
  CircularProgress,
  Alert,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Switch,
  FormControlLabel,
  TextField,
  IconButton,
  List,
  ListItem,
  ListItemText,
  ListItemSecondaryAction,
  Collapse,
  Tooltip,
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import ThumbUpIcon from '@mui/icons-material/ThumbUp';
import ThumbDownIcon from '@mui/icons-material/ThumbDown';
import ThumbsUpDownIcon from '@mui/icons-material/ThumbsUpDown';
import EditIcon from '@mui/icons-material/Edit';
import SaveIcon from '@mui/icons-material/Save';
import CancelIcon from '@mui/icons-material/Cancel';
import axios from 'axios';
import { useAuth } from '../contexts/AuthContext';
import ScheduleForm from '../components/ScheduleForm';
import ScheduleList from '../components/ScheduleList';
import { buildApiUrl } from '../config';

interface Task {
  taskId: string;
  userId: string;
  name: string;
  prompt: string;
  status: string;  // Task status: active, archived, etc.
  createdAt: string;
  summary?: string;
  error?: string;
  emailNotification?: boolean;
}

interface TaskExecution {
  executionId: string;
  taskId: string;
  userId: string;
  status: string;  // Execution status: pending, running, completed, failed
  startTime: string;
  completedAt?: string;
  result?: string;
  error?: string;
  feedback?: 'accepted' | 'rejected';
  details_gif?: string;
  prompt?: string;
}

interface Subscriber {
  email: string;
  subscribedAt: string;
}

// Add CollapsibleText component
const CollapsibleText = ({ text, maxLength = 150 }: { text: string, maxLength?: number }) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const needsCollapse = text.length > maxLength;
  
  const handleCopy = () => {
    navigator.clipboard.writeText(text);
  };

  return (
    <Box>
      <Typography 
        variant="body2" 
        sx={{ 
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {isExpanded ? text : needsCollapse ? `${text.slice(0, maxLength)}...` : text}
      </Typography>
      <Box sx={{ mt: 1, display: 'flex', gap: 1 }}>
        {needsCollapse && (
          <Button 
            size="small" 
            onClick={() => setIsExpanded(!isExpanded)}
            sx={{ minWidth: 'auto', p: 0 }}
          >
            {isExpanded ? 'Show Less' : 'Show More'}
          </Button>
        )}
        <Tooltip title="Copy to clipboard">
          <IconButton 
            size="small" 
            onClick={handleCopy}
            sx={{ p: 0 }}
          >
            <ContentCopyIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Box>
    </Box>
  );
};

export default function TaskDetails() {
  const [task, setTask] = useState<Task | null>(null);
  const [executions, setExecutions] = useState<TaskExecution[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [scheduleRefreshTrigger, setScheduleRefreshTrigger] = useState(0);
  const { taskId } = useParams<{ taskId: string }>();
  const { token, user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [subscribers, setSubscribers] = useState<Subscriber[]>([]);
  const [newSubscriberEmail, setNewSubscriberEmail] = useState('');
  const [subscriberError, setSubscriberError] = useState('');
  const [isEditingPrompt, setIsEditingPrompt] = useState(false);
  const [editedPrompt, setEditedPrompt] = useState('');

  const isAdminRoute = location.pathname.startsWith('/admin/');
  const showActions = !isAdminRoute || (task && user && task.userId === user.userId);

  const fetchTask = async () => {
    if (!taskId) return;
    try {
      const [taskResponse, executionsResponse] = await Promise.all([
        axios.get(buildApiUrl(`/api/tasks/${taskId}`), {
          headers: { Authorization: `Bearer ${token}` },
        }),
        axios.get(buildApiUrl(`/api/tasks/${taskId}/executions`), {
          headers: { Authorization: `Bearer ${token}` },
        })
      ]);
      
      const updatedTask = taskResponse.data;
      console.log('Task data fetched:', updatedTask);
      setTask(updatedTask);
      setExecutions(executionsResponse.data);
      return updatedTask;
    } catch (error: any) {
      console.error('Error fetching task details:', error);
      setError(error.response?.data?.message || 'Failed to fetch task details');
      return null;
    }
  };

  useEffect(() => {
    const fetchTaskAndExecutions = async () => {
      setLoading(true);
      await fetchTask();
      setLoading(false);
    };

    fetchTaskAndExecutions();

    // Set up polling for executions
    const intervalId = setInterval(() => {
      if (taskId) {
        axios.get(buildApiUrl(`/api/tasks/${taskId}/executions`), {
          headers: { Authorization: `Bearer ${token}` },
        })
        .then(response => setExecutions(response.data))
        .catch(error => console.error('Error polling executions:', error));
      }
    }, 5000);

    return () => clearInterval(intervalId);
  }, [taskId, token]);

  useEffect(() => {
    const fetchSubscribers = async () => {
      if (!taskId) return;
      try {
        const response = await axios.get(buildApiUrl(`/api/tasks/${taskId}/subscribers`), {
          headers: { Authorization: `Bearer ${token}` },
        });
        setSubscribers(response.data);
      } catch (error: any) {
        console.error('Error fetching subscribers:', error);
        setSubscriberError(error.response?.data?.message || 'Failed to fetch subscribers');
      }
    };

    fetchSubscribers();
  }, [taskId, token]);

  const handleDelete = async () => {
    try {
      await axios.delete(buildApiUrl(`/api/tasks/${taskId}`), {
        headers: { Authorization: `Bearer ${token}` },
      });
      navigate('/dashboard');
    } catch (error: any) {
      console.error('Error deleting task:', error);
      setError(error.response?.data?.message || 'Failed to delete task');
    }
  };

  const handleRun = async () => {
    try {
      await axios.post(
        buildApiUrl(`/api/tasks/${taskId}/execute`),
        {},
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      // Refresh executions list
      const response = await axios.get(buildApiUrl(`/api/tasks/${taskId}/executions`), {
        headers: { Authorization: `Bearer ${token}` },
      });
      setExecutions(response.data);
    } catch (error: any) {
      console.error('Error running task:', error);
      setError(error.response?.data?.message || 'Failed to run task');
    }
  };

  const handleEmailToggle = async () => {
    if (!task) return;
    
    try {
      console.log('Current task:', task);
      
      const newEmailNotification = !task.emailNotification;
      console.log('New emailNotification:', newEmailNotification, typeof newEmailNotification);
      
      const updateResponse = await axios.put(
        buildApiUrl(`/api/tasks/${taskId}`),
        {
          emailNotification: newEmailNotification
        },
        {
          headers: { Authorization: `Bearer ${token}` }
        }
      );
      console.log('Update response:', updateResponse.data);

      // Update the task state with the response
      const taskResponse = await axios.get(
        buildApiUrl(`/api/tasks/${taskId}`),
        {
          headers: { Authorization: `Bearer ${token}` }
        }
      );
      console.log('Get task response:', taskResponse.data);
      console.log('emailNotification in response:', taskResponse.data.emailNotification, typeof taskResponse.data.emailNotification);
      
      setTask(taskResponse.data);
    } catch (error: any) {
      console.error('Error updating email notification:', error);
      setError(error.response?.data?.message || 'Failed to update email notification');
    }
  };

  const handleFeedbackChange = async (executionId: string, feedback: 'accepted' | 'rejected' | null) => {
    try {
      await axios.put(
        buildApiUrl(`/api/tasks/${taskId}/executions/${executionId}`),
        { feedback },
        {
          headers: { Authorization: `Bearer ${token}` }
        }
      );
      
      // Refresh executions list
      const response = await axios.get(buildApiUrl(`/api/tasks/${taskId}/executions`), {
        headers: { Authorization: `Bearer ${token}` },
      });
      setExecutions(response.data);
    } catch (error: any) {
      console.error('Error updating feedback:', error);
      setError(error.response?.data?.message || 'Failed to update feedback');
    }
  };

  const getLatestExecution = () => {
    if (executions.length === 0) return null;
    return executions.reduce((latest, current) => {
      return new Date(current.startTime) > new Date(latest.startTime) ? current : latest;
    });
  };

  const getStatusColor = (status: string) => {
    switch (status.toLowerCase()) {
      case 'completed':
        return 'success';
      case 'failed':
        return 'error';
      case 'running':
        return 'info';
      case 'pending':
        return 'warning';
      case 'active':
        return 'success';
      case 'archived':
        return 'default';
      default:
        return 'default';
    }
  };

  const handleScheduleCreated = async () => {
    console.log('Schedule created, refreshing data');
    await fetchTask();
    setScheduleRefreshTrigger(prev => prev + 1);
  };

  const handleAddSubscriber = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSubscriberEmail.trim()) return;

    try {
      const response = await axios.post(
        buildApiUrl(`/api/tasks/${taskId}/subscribers`),
        { email: newSubscriberEmail },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      
      // Ensure the subscriber object has all required fields
      const newSubscriber: Subscriber = {
        email: response.data.email,
        subscribedAt: response.data.subscribedAt || new Date().toISOString()
      };
      
      setSubscribers([...subscribers, newSubscriber]);
      setNewSubscriberEmail('');
      setSubscriberError('');
    } catch (error: any) {
      console.error('Error adding subscriber:', error);
      // Use the server's error message if available, otherwise show a generic message
      const errorMessage = error.response?.data?.message || 
        (error.response?.status === 400 ? 'Invalid email address' : 'Failed to add subscriber');
      setSubscriberError(errorMessage);
      // Don't clear the email input if there was an error
    }
  };

  const handleRemoveSubscriber = async (email: string) => {
    try {
      await axios.delete(
        buildApiUrl(`/api/tasks/${taskId}/subscribers/${encodeURIComponent(email)}`),
        { headers: { Authorization: `Bearer ${token}` } }
      );
      setSubscribers(subscribers.filter(s => s.email !== email));
      setSubscriberError('');
    } catch (error: any) {
      console.error('Error removing subscriber:', error);
      setSubscriberError(error.response?.data?.message || 'Failed to remove subscriber');
    }
  };

  const handlePromptEdit = async () => {
    try {
      await axios.put(
        buildApiUrl(`/api/tasks/${taskId}`),
        { prompt: editedPrompt },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      
      // Refresh task data
      const updatedTask = await fetchTask();
      if (updatedTask) {
        setTask(updatedTask);
      }
      setIsEditingPrompt(false);
    } catch (error: any) {
      console.error('Error updating prompt:', error);
      setError(error.response?.data?.message || 'Failed to update prompt');
    }
  };

  const startEditing = () => {
    if (task) {
      setEditedPrompt(task.prompt);
      setIsEditingPrompt(true);
    }
  };

  const cancelEditing = () => {
    setIsEditingPrompt(false);
    setEditedPrompt('');
  };

  if (loading) {
    return (
      <Box display="flex" justifyContent="center" alignItems="center" minHeight="60vh">
        <CircularProgress />
      </Box>
    );
  }

  if (error) {
    return (
      <Container maxWidth="md">
        <Alert severity="error" sx={{ mt: 4 }}>
          {error}
        </Alert>
      </Container>
    );
  }

  if (!task) {
    return (
      <Container maxWidth="md">
        <Alert severity="info" sx={{ mt: 4 }}>
          Task not found
        </Alert>
      </Container>
    );
  }

  if (!taskId) {
    return (
      <Container maxWidth="md">
        <Alert severity="error" sx={{ mt: 4 }}>
          No task ID provided
        </Alert>
      </Container>
    );
  }

  return (
    <Container maxWidth="lg" sx={{ mt: 4, mb: 4 }}>
      <Paper sx={{ p: 4, mt: 4 }}>
        <Box sx={{ mb: 4, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <Box>
            <Typography variant="h4" component="h1" gutterBottom>
              {task.name}
            </Typography>
            <Box sx={{ display: 'flex', gap: 1, mb: 2 }}>
              <Chip
                label={`Task: ${task.status}`}
                color={getStatusColor(task.status)}
              />
              {getLatestExecution() && (
                <Chip
                  label={`Latest Run: ${getLatestExecution()?.status}`}
                  color={getStatusColor(getLatestExecution()?.status || '')}
                />
              )}
            </Box>
            {showActions && (
              <FormControlLabel
                control={
                  <Switch
                    checked={Boolean(task.emailNotification)}
                    onChange={handleEmailToggle}
                    color="primary"
                  />
                }
                label="Email Me Latest Run"
              />
            )}
          </Box>
          {showActions && (
            <Box sx={{ display: 'flex', gap: 2 }}>
              <Button
                variant="contained"
                color="primary"
                onClick={handleRun}
                disabled={getLatestExecution()?.status === 'running'}
              >
                Run Task
              </Button>
              <Button
                variant="outlined"
                color="error"
                onClick={handleDelete}
              >
                Delete Task
              </Button>
            </Box>
          )}
        </Box>

        <Grid container spacing={3}>
          <Grid item xs={12}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
              <Typography variant="h6" gutterBottom>
                Task Prompt
              </Typography>
              {showActions && !isEditingPrompt && (
                <Tooltip title="Edit prompt">
                  <IconButton onClick={startEditing} size="small">
                    <EditIcon />
                  </IconButton>
                </Tooltip>
              )}
            </Box>
            {isEditingPrompt ? (
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <TextField
                  multiline
                  rows={4}
                  fullWidth
                  value={editedPrompt}
                  onChange={(e) => setEditedPrompt(e.target.value)}
                  variant="outlined"
                />
                <Box sx={{ display: 'flex', gap: 1, justifyContent: 'flex-end' }}>
                  <Button
                    startIcon={<CancelIcon />}
                    onClick={cancelEditing}
                    variant="outlined"
                    color="inherit"
                  >
                    Cancel
                  </Button>
                  <Button
                    startIcon={<SaveIcon />}
                    onClick={handlePromptEdit}
                    variant="contained"
                    color="primary"
                    disabled={!editedPrompt.trim() || editedPrompt === task?.prompt}
                  >
                    Save
                  </Button>
                </Box>
              </Box>
            ) : (
              <Typography variant="body1" paragraph>
                {task.prompt}
              </Typography>
            )}
          </Grid>

          {task.summary && (
            <Grid item xs={12}>
              <Typography variant="h6" gutterBottom>
                Latest Summary
              </Typography>
              <Typography variant="body1" paragraph>
                {task.summary}
              </Typography>
            </Grid>
          )}

          {task.error && (
            <Grid item xs={12}>
              <Typography variant="h6" gutterBottom color="error">
                Error
              </Typography>
              <Typography variant="body1" color="error" paragraph>
                {task.error}
              </Typography>
            </Grid>
          )}

          <Grid item xs={12}>
            <Typography variant="h6" gutterBottom sx={{ mt: 2 }}>
              Execution History
            </Typography>
            <TableContainer>
              <Table>
                <TableHead>
                  <TableRow>
                    <TableCell width="100px">Status</TableCell>
                    <TableCell width="150px">Started</TableCell>
                    <TableCell width="150px">Completed</TableCell>
                    <TableCell width="25%">Prompt</TableCell>
                    <TableCell width="25%">Result</TableCell>
                    <TableCell width="250px">Details</TableCell>
                    <TableCell width="80px" align="center">Feedback</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {executions.map((execution) => (
                    <TableRow key={execution.executionId}>
                      <TableCell>
                        <Chip
                          label={execution.status}
                          color={getStatusColor(execution.status)}
                          size="small"
                        />
                      </TableCell>
                      <TableCell>
                        {new Date(execution.startTime).toLocaleString()}
                      </TableCell>
                      <TableCell>
                        {execution.completedAt ? new Date(execution.completedAt).toLocaleString() : '-'}
                      </TableCell>
                      <TableCell>
                        {execution.prompt ? (
                          <CollapsibleText text={execution.prompt} />
                        ) : '-'}
                      </TableCell>
                      <TableCell>
                        {execution.error ? (
                          <Typography color="error" variant="body2">
                            <CollapsibleText text={execution.error} />
                          </Typography>
                        ) : execution.result ? (
                          <CollapsibleText text={execution.result} />
                        ) : '-'}
                      </TableCell>
                      <TableCell>
                        {execution.details_gif ? (
                          <a href={execution.details_gif} target="_blank" rel="noopener noreferrer">
                            <img 
                              src={execution.details_gif} 
                              alt="Execution Details" 
                              style={{ 
                                maxWidth: '250px', 
                                cursor: 'pointer',
                                border: '1px solid #eee',
                                borderRadius: '4px'
                              }} 
                            />
                          </a>
                        ) : '-'}
                      </TableCell>
                      <TableCell align="center">
                        <Box sx={{ display: 'flex', justifyContent: 'center', gap: 0.5 }}>
                          <Tooltip title={execution.feedback ? `Current: ${execution.feedback}` : 'Set feedback'}>
                            <IconButton
                              size="small"
                              onClick={() => handleFeedbackChange(
                                execution.executionId,
                                execution.feedback === 'accepted' ? null : 'accepted'
                              )}
                              color={execution.feedback === 'accepted' ? 'success' : 'default'}
                            >
                              <ThumbUpIcon fontSize="small" />
                            </IconButton>
                          </Tooltip>
                          <Tooltip title={execution.feedback ? `Current: ${execution.feedback}` : 'Set feedback'}>
                            <IconButton
                              size="small"
                              onClick={() => handleFeedbackChange(
                                execution.executionId,
                                execution.feedback === 'rejected' ? null : 'rejected'
                              )}
                              color={execution.feedback === 'rejected' ? 'error' : 'default'}
                            >
                              <ThumbDownIcon fontSize="small" />
                            </IconButton>
                          </Tooltip>
                        </Box>
                      </TableCell>
                    </TableRow>
                  ))}
                  {executions.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={6} align="center">
                        <Typography variant="body2" color="text.secondary">
                          No executions yet
                        </Typography>
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </TableContainer>
          </Grid>
        </Grid>

        <Box sx={{ mt: 4 }}>
          <Typography variant="h5" gutterBottom>
            Task Scheduling
          </Typography>
          <ScheduleForm taskId={taskId} onScheduleCreated={handleScheduleCreated} />
          <ScheduleList taskId={taskId} onScheduleUpdated={handleScheduleCreated} key={scheduleRefreshTrigger} />
        </Box>
      </Paper>

      {/* Subscriber Management Section */}
      <Paper sx={{ p: 3, mt: 3 }}>
        <Typography variant="h6" gutterBottom>
          Subscribers
        </Typography>
        
        <Box component="form" onSubmit={handleAddSubscriber} sx={{ mb: 3, display: 'flex', gap: 2 }}>
          <TextField
            label="Email"
            variant="outlined"
            size="small"
            value={newSubscriberEmail}
            onChange={(e) => setNewSubscriberEmail(e.target.value)}
            error={!!subscriberError}
            helperText={subscriberError}
            sx={{ flexGrow: 1 }}
            type="email"
            placeholder="Enter email address"
          />
          <Button 
            type="submit" 
            variant="contained" 
            color="primary"
            disabled={!newSubscriberEmail.trim()}
          >
            Add Subscriber
          </Button>
        </Box>

        <List>
          {subscribers.map((subscriber) => (
            <ListItem key={subscriber.email}>
              <ListItemText
                primary={subscriber.email}
                secondary={`Subscribed on ${new Date(subscriber.subscribedAt).toLocaleDateString()}`}
              />
              <ListItemSecondaryAction>
                <IconButton
                  edge="end"
                  aria-label="delete"
                  onClick={() => handleRemoveSubscriber(subscriber.email)}
                >
                  <DeleteIcon />
                </IconButton>
              </ListItemSecondaryAction>
            </ListItem>
          ))}
        </List>
        
        {subscribers.length === 0 && (
          <Typography color="textSecondary" align="center">
            No subscribers yet
          </Typography>
        )}
      </Paper>
    </Container>
  );
} 