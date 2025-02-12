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
  Tooltip,
  Link,
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import ThumbUpIcon from '@mui/icons-material/ThumbUp';
import ThumbDownIcon from '@mui/icons-material/ThumbDown';
import EditIcon from '@mui/icons-material/Edit';
import SaveIcon from '@mui/icons-material/Save';
import CancelIcon from '@mui/icons-material/Cancel';
import ScreenshotIcon from '@mui/icons-material/Screenshot';
import { styled } from '@mui/material/styles';
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
  isInteractive?: boolean;
  attachments?: TaskAttachment[];
}

interface TaskAttachment {
  url: string;
  key: string;
  filename: string;
  uploadedAt: string;
}

interface UserInteraction {
  id: string;
  question: string;
  response?: string;
  status: 'pending' | 'answered';
  timestamp: number;
  screenshot_url?: string;
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
  userInteractions?: UserInteraction[];
  result_files?: {
    url: string;
    filename: string;
    token: string;
  }[];
}

interface Subscriber {
  email: string;
  subscribedAt: string;
}

const PreviewImage = styled('img')({
  maxHeight: '500px',
  maxWidth: '800px',
  objectFit: 'contain',
});

// Add this helper function before the CollapsibleText component
const truncateFilename = (filename: string, maxLength: number = 20): string => {
  if (filename.length <= maxLength) return filename;
  
  const extension = filename.includes('.') ? filename.split('.').pop() : '';
  const nameWithoutExt = filename.substring(0, filename.lastIndexOf('.'));
  
  // Calculate how much of the name we can keep
  const maxNameLength = maxLength - extension.length - 4; // 4 for "..." and "."
  const truncatedName = nameWithoutExt.substring(0, maxNameLength);
  
  return `${truncatedName}...${extension ? `.${extension}` : ''}`;
};

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

// Add UserInteractionDialog component
const UserInteractionDialog = ({ 
  execution,
  onRespond
}: { 
  execution: TaskExecution;
  onRespond: (executionId: string, interactionId: string, response: string) => Promise<void>;
}) => {
  const [response, setResponse] = useState('');
  const [selectedInteraction, setSelectedInteraction] = useState<UserInteraction | null>(null);
  const [error, setError] = useState('');

  const handleRespond = async () => {
    if (!selectedInteraction || !response.trim()) return;
    
    try {
      await onRespond(execution.executionId, selectedInteraction.id, response.trim());
      setResponse('');
      setSelectedInteraction(null);
      setError('');
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to send response');
    }
  };

  if (!execution.userInteractions?.length || execution.status !== 'running') return null;

  // Count pending questions
  const pendingCount = execution.userInteractions.filter(i => i.status === 'pending').length;

  return (
    <Box sx={{ mt: 2, bgcolor: 'background.paper', borderRadius: 1, overflow: 'hidden' }}>
      <Box sx={{ p: 2, bgcolor: 'primary.main', color: 'primary.contrastText', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 'medium' }}>
          Agent Questions
        </Typography>
        {pendingCount > 0 ? (
          <Chip 
            label={`${pendingCount} Pending`}
            color="warning" 
            size="small"
            sx={{ ml: 2 }}
          />
        ) : (
          <Chip 
            label="All Answered"
            color="success" 
            size="small"
            sx={{ ml: 2 }}
          />
        )}
      </Box>
      
      <List sx={{ p: 0 }}>
        {execution.userInteractions.map((interaction, index) => (
          <ListItem 
            key={interaction.id}
            sx={{ 
              borderBottom: index < execution.userInteractions!.length - 1 ? '1px solid rgba(0, 0, 0, 0.12)' : 'none',
              bgcolor: selectedInteraction?.id === interaction.id ? 'action.selected' : 'transparent',
              transition: 'background-color 0.2s',
              p: 2
            }}
          >
            <Box sx={{ width: '100%' }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                <Typography variant="body1" sx={{ fontWeight: 'medium' }}>
                  {interaction.question}
                </Typography>
                {interaction.screenshot_url && (
                  <Tooltip
                    title={
                      <PreviewImage
                        src={interaction.screenshot_url}
                        alt="Screenshot"
                      />
                    }
                    placement="right"
                    arrow
                  >
                    <IconButton size="small">
                      <ScreenshotIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                )}
              </Box>
              
              {interaction.response ? (
                <Box sx={{ 
                  ml: 2, 
                  p: 1.5,
                  bgcolor: 'success.light',
                  color: 'success.contrastText',
                  borderRadius: 1,
                  position: 'relative'
                }}>
                  <Typography variant="body2">
                    {interaction.response}
                  </Typography>
                </Box>
              ) : interaction.status === 'pending' && (
                <Box sx={{ display: 'flex', gap: 2, alignItems: 'center' }}>
                  {selectedInteraction?.id === interaction.id ? (
                    <Box sx={{ width: '100%' }}>
                      <TextField
                        fullWidth
                        multiline
                        rows={2}
                        placeholder="Type your response here..."
                        value={response}
                        onChange={(e) => setResponse(e.target.value)}
                        error={!!error}
                        helperText={error}
                        sx={{ mb: 1 }}
                        autoFocus
                      />
                      <Box sx={{ display: 'flex', gap: 1, justifyContent: 'flex-end' }}>
                        <Button
                          variant="outlined"
                          size="small"
                          onClick={() => {
                            setSelectedInteraction(null);
                            setResponse('');
                            setError('');
                          }}
                        >
                          Cancel
                        </Button>
                        <Button
                          variant="contained"
                          size="small"
                          onClick={handleRespond}
                          disabled={!response.trim()}
                        >
                          Send Response
                        </Button>
                      </Box>
                    </Box>
                  ) : (
                    <Button
                      variant="outlined"
                      size="small"
                      onClick={() => setSelectedInteraction(interaction)}
                      startIcon={<EditIcon />}
                      sx={{ ml: 2 }}
                    >
                      Respond
                    </Button>
                  )}
                </Box>
              )}
            </Box>
          </ListItem>
        ))}
      </List>
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
  const [uploadError, setUploadError] = useState<string>('');
  const [isUploading, setIsUploading] = useState(false);

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
      navigate('/tasks');
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

  const handleInteractiveModeToggle = async () => {
    if (!task) return;
    
    try {
      const newIsInteractive = !task.isInteractive;
      
      await axios.put(
        buildApiUrl(`/api/tasks/${taskId}`),
        {
          isInteractive: newIsInteractive
        },
        {
          headers: { Authorization: `Bearer ${token}` }
        }
      );

      // Update the task state with the response
      const taskResponse = await axios.get(
        buildApiUrl(`/api/tasks/${taskId}`),
        {
          headers: { Authorization: `Bearer ${token}` }
        }
      );
      
      setTask(taskResponse.data);
    } catch (error: any) {
      console.error('Error updating interactive mode:', error);
      setError(error.response?.data?.message || 'Failed to update interactive mode');
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

  const handleUserResponse = async (executionId: string, interactionId: string, userResponse: string) => {
    try {
      await axios.put(
        buildApiUrl(`/api/tasks/${taskId}/executions/${executionId}/interactions/${interactionId}`),
        { response: userResponse },
        {
          headers: { Authorization: `Bearer ${token}` }
        }
      );
      
      // Refresh executions list
      const executionsResponse = await axios.get(buildApiUrl(`/api/tasks/${taskId}/executions`), {
        headers: { Authorization: `Bearer ${token}` },
      });
      setExecutions(executionsResponse.data);
    } catch (error: any) {
      console.error('Error responding to interaction:', error);
      throw error;
    }
  };

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    if (files.length === 0) return;

    // Check number of files
    if (files.length > 5) {
      setUploadError('You can only upload up to 5 files at once');
      return;
    }

    // Check file sizes (20MB = 20 * 1024 * 1024 bytes)
    const MAX_SIZE = 20 * 1024 * 1024;
    const oversizedFiles = files.filter(file => file.size > MAX_SIZE);
    if (oversizedFiles.length > 0) {
      setUploadError(`Following files exceed 20MB limit: ${oversizedFiles.map(f => f.name).join(', ')}`);
      return;
    }

    // Check total number of attachments
    const currentAttachments = task?.attachments?.length || 0;
    if (currentAttachments + files.length > 5) {
      setUploadError(`You can only have up to 5 attachments total. You currently have ${currentAttachments} attachments.`);
      return;
    }

    setIsUploading(true);
    setUploadError('');

    try {
      // Upload files sequentially to avoid overwhelming the server
      for (const file of files) {
        const formData = new FormData();
        formData.append('file', file);

        await axios.post(buildApiUrl(`/api/tasks/${taskId}/attachments`), formData, {
          headers: {
            'Content-Type': 'multipart/form-data',
            Authorization: `Bearer ${token}`
          }
        });
      }
      await fetchTask(); // Refresh task to get updated attachments
    } catch (error: any) {
      setUploadError(error.response?.data?.error || 'Failed to upload file(s)');
    } finally {
      setIsUploading(false);
      // Clear the input value to allow uploading the same file again
      if (event.target) {
        event.target.value = '';
      }
    }
  };

  const handleDeleteAttachment = async (key: string) => {
    try {
      await axios.delete(buildApiUrl(`/api/tasks/${taskId}/attachments/${encodeURIComponent(key)}`), {
        headers: { Authorization: `Bearer ${token}` }
      });
      await fetchTask(); // Refresh task to get updated attachments
    } catch (error: any) {
      console.error('Failed to delete attachment:', error);
    }
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
              <Box sx={{ display: 'flex', gap: 2, alignItems: 'center' }}>
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
                <FormControlLabel
                  control={
                    <Switch
                      checked={Boolean(task.isInteractive)}
                      onChange={handleInteractiveModeToggle}
                      color="primary"
                    />
                  }
                  label="Interactive Mode"
                />
              </Box>
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

          {/* Attachments Section */}
          <Grid item xs={12}>
            <Typography variant="h6" gutterBottom>
              Attachments
            </Typography>
            
            <Box sx={{ mb: 2 }}>
              <input
                accept="*/*"
                style={{ display: 'none' }}
                id="file-upload"
                type="file"
                onChange={handleFileUpload}
                multiple
              />
              <label htmlFor="file-upload">
                <Button
                  variant="contained"
                  component="span"
                  disabled={isUploading || (task?.attachments?.length || 0) >= 5}
                  startIcon={isUploading ? <CircularProgress size={20} /> : undefined}
                >
                  {isUploading ? 'Uploading...' : 'Upload Files'}
                </Button>
              </label>
              {(task?.attachments?.length || 0) >= 5 && (
                <Typography color="error" variant="caption" sx={{ display: 'block', mt: 1 }}>
                  Maximum number of attachments (5) reached
                </Typography>
              )}
              {uploadError && (
                <Alert severity="error" sx={{ mt: 1 }}>
                  {uploadError}
                </Alert>
              )}
            </Box>

            <List>
              {task?.attachments?.map((attachment) => (
                <ListItem
                  key={attachment.key}
                  secondaryAction={
                    <IconButton
                      edge="end"
                      aria-label="delete"
                      onClick={() => handleDeleteAttachment(attachment.key)}
                    >
                      <DeleteIcon />
                    </IconButton>
                  }
                >
                  <ListItemText
                    primary={
                      <Link href={attachment.url} target="_blank" rel="noopener noreferrer">
                        {attachment.filename}
                      </Link>
                    }
                    secondary={new Date(attachment.uploadedAt).toLocaleString()}
                  />
                </ListItem>
              ))}
              {(!task?.attachments || task.attachments.length === 0) && (
                <Typography color="textSecondary">
                  No attachments yet
                </Typography>
              )}
            </List>
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
                        {execution.status === 'running' && execution.userInteractions && execution.userInteractions.length > 0 ? (
                          <Box>
                            <UserInteractionDialog
                              execution={execution}
                              onRespond={handleUserResponse}
                            />
                          </Box>
                        ) : (
                          <Box>
                            {execution.error ? (
                              <Typography color="error" variant="body2">
                                <CollapsibleText text={execution.error} />
                              </Typography>
                            ) : (
                              <>
                                <CollapsibleText text={execution.result || '-'} />
                                {execution.result_files && execution.result_files.length > 0 && (
                                  <Box mt={1}>
                                    <Typography variant="subtitle2" color="textSecondary">
                                      Result Files:
                                    </Typography>
                                    <Box display="flex" gap={1} flexWrap="wrap">
                                      {execution.result_files.map((file, index) => (
                                        <Chip
                                          key={index}
                                          label={truncateFilename(file.filename)}
                                          component="a"
                                          href={file.url}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          clickable
                                          color="primary"
                                          variant="outlined"
                                          size="small"
                                          sx={{ mt: 1 }}
                                        />
                                      ))}
                                    </Box>
                                  </Box>
                                )}
                              </>
                            )}
                          </Box>
                        )}
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