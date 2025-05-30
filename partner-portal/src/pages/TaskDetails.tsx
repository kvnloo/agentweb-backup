import { useState, useEffect } from 'react';
import { useParams, useNavigate, useLocation, Link as RouterLink } from 'react-router-dom';
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
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import ArchiveIcon from '@mui/icons-material/Archive';
import UnarchiveIcon from '@mui/icons-material/Unarchive';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import ThumbUpIcon from '@mui/icons-material/ThumbUp';
import ThumbDownIcon from '@mui/icons-material/ThumbDown';
import EditIcon from '@mui/icons-material/Edit';
import SaveIcon from '@mui/icons-material/Save';
import CancelIcon from '@mui/icons-material/Cancel';
import ScreenshotIcon from '@mui/icons-material/Screenshot';
import PersonAddIcon from '@mui/icons-material/PersonAdd';
import { styled } from '@mui/material/styles';
import axios from 'axios';
import { useAuth } from '../contexts/AuthContext';
import ScheduleForm from '../components/ScheduleForm';
import ScheduleList from '../components/ScheduleList';
import { buildApiUrl, getLLMsForTask } from '../config';

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
  isDeepResearch?: boolean;
  isComplexTask?: boolean;
  extractPageContent?: boolean;  // New flag for extracting page content
  validateOutput?: boolean;  // Flag for validating agent output
  outputAsJson?: boolean;  // Flag for outputting result as JSON
  outputAsHtml?: boolean; // New flag for outputting result as HTML5
  isAgenticDevMode?: boolean;  // Flag for enabling agentic dev mode
  llmName?: string;
  attachments?: TaskAttachment[];
  selectedLLMs?: string[];
  useSharedBrowser?: boolean; // Flag for using shared browser
  turnOffHeadless?: boolean; // Flag for turning off headless mode
  useKnowledgeBase?: boolean; // Flag for using knowledge base
  knowledgeBase?: string; // The content of the task's knowledge base
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
    is_html?: boolean;
  }[];
  archived: boolean;
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
  const maxNameLength = maxLength - (extension ? extension.length + 1 : 0) - 3; // 3 for "..."
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
    <span style={{ display: 'inline-block' }}>
      <Typography 
        variant="body2" 
        component="span"
        sx={{ 
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          display: 'inline-block'
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
    </span>
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
  const [isEditingName, setIsEditingName] = useState(false);
  const [editedName, setEditedName] = useState('');
  const [uploadError, setUploadError] = useState<string>('');
  const [isUploading, setIsUploading] = useState(false);
  const [shouldPoll, setShouldPoll] = useState(true);
  const [success, setSuccess] = useState('');
  const [ownerChangeDialogOpen, setOwnerChangeDialogOpen] = useState(false);
  const [newOwnerEmail, setNewOwnerEmail] = useState('');
  const [ownerChangeError, setOwnerChangeError] = useState('');
  const [ownerChangeSuccess, setOwnerChangeSuccess] = useState('');
  const [isEditingKnowledgeBase, setIsEditingKnowledgeBase] = useState(false);
  const [editedKnowledgeBase, setEditedKnowledgeBase] = useState('');
  const [knowledgeBaseContent, setKnowledgeBaseContent] = useState('');
  const [knowledgeBaseError, setKnowledgeBaseError] = useState('');

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
      if (taskId && shouldPoll) {
        axios.get(buildApiUrl(`/api/tasks/${taskId}/executions`), {
          headers: { Authorization: `Bearer ${token}` },
        })
        .then(response => setExecutions(response.data))
        .catch(error => console.error('Error polling executions:', error));
      }
    }, 5000);

    return () => clearInterval(intervalId);
  }, [taskId, token, shouldPoll]);

  // Control polling interval based on execution status
  useEffect(() => {
    // Only poll if there are pending or running executions
    const hasActiveExecutions = executions.some(
      execution => execution.status === 'pending' || execution.status === 'running'
    );
    
    setShouldPoll(hasActiveExecutions);
    
    if (hasActiveExecutions) {
      console.log('Active executions found - polling enabled');
    } else {
      console.log('No active executions - polling disabled');
    }
  }, [executions]);

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

  const handleArchive = async () => {
    if (!task) return;
    
    try {
      if (task.status === 'archived') {
        // Unarchive the task
        await axios.put(
          buildApiUrl(`/api/tasks/${taskId}`),
          { status: 'active' },
          { headers: { Authorization: `Bearer ${token}` } }
        );
        // Refresh task data and schedules
        await fetchTask();
        // Force a refresh of schedules
        handleScheduleCreated();
        setSuccess('Task unarchived successfully');
      } else {
        // Archive the task
        await axios.delete(buildApiUrl(`/api/tasks/${taskId}`), {
          headers: { Authorization: `Bearer ${token}` },
        });
        navigate('/tasks');
      }
    } catch (error: any) {
      console.error(`Error ${task.status === 'archived' ? 'unarchiving' : 'archiving'} task:`, error);
      setError(error.response?.data?.message || `Failed to ${task.status === 'archived' ? 'unarchive' : 'archive'} task`);
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

  const handleDeepResearchToggle = async () => {
    if (!task) return;
    
    try {
      const newIsDeepResearch = !task.isDeepResearch;
      
      // If enabling deep research, also enable email notifications
      // and disable interactive mode and complex task
      const updateData: any = {
        isDeepResearch: newIsDeepResearch
      };
      
      // If enabling deep research, also enable email notifications
      if (newIsDeepResearch) {
        // Enable email notifications if not already enabled
        if (!task.emailNotification) {
          updateData.emailNotification = true;
        }
        
        // Disable interactive mode, complex task, extract page content, and validate output
        updateData.isInteractive = false;
        updateData.isComplexTask = false;
        updateData.extractPageContent = false;
        updateData.validateOutput = false;
        updateData.outputAsJson = false;
      }
      
      // Reset LLM selection when toggling deep research mode
      // This ensures the appropriate LLM list will be used
      updateData.llmName = null;
      
      await axios.put(
        buildApiUrl(`/api/tasks/${taskId}`),
        updateData,
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
      console.error('Error updating deep research mode:', error);
      setError(error.response?.data?.message || 'Failed to update deep research mode');
    }
  };

  const handleComplexTaskToggle = async () => {
    if (!task) return;
    
    try {
      const newIsComplexTask = !task.isComplexTask;
      
      await axios.put(
        buildApiUrl(`/api/tasks/${taskId}`),
        {
          isComplexTask: newIsComplexTask
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
      console.error('Error updating complex task mode:', error);
      setError(error.response?.data?.message || 'Failed to update complex task mode');
    }
  };

  const handleExtractPageContentToggle = async () => {
    try {
      await axios.put(
        buildApiUrl(`/api/tasks/${taskId}`),
        { extractPageContent: !task?.extractPageContent },
        { headers: { Authorization: `Bearer ${token}` } }
      );

      // Update the task state with the response from the server
      const taskResponse = await axios.get(
        buildApiUrl(`/api/tasks/${taskId}`),
        {
          headers: { Authorization: `Bearer ${token}` }
        }
      );
      
      setTask(taskResponse.data);
    } catch (error) {
      console.error('Error updating task:', error);
    }
  };

  const handleValidateOutputToggle = async () => {
    try {
      console.log('Toggling validateOutput from', task?.validateOutput, 'to', !task?.validateOutput);
      
      const response = await axios.put(
        buildApiUrl(`/api/tasks/${taskId}`),
        { validateOutput: !task?.validateOutput },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      
      console.log('Validate output toggle response:', response.data);

      // Update the task state with the response from the server
      const taskResponse = await axios.get(
        buildApiUrl(`/api/tasks/${taskId}`),
        {
          headers: { Authorization: `Bearer ${token}` }
        }
      );
      
      console.log('Get task after toggle:', taskResponse.data);
      console.log('validateOutput in response:', taskResponse.data.validateOutput);
      
      setTask(taskResponse.data);
    } catch (error) {
      console.error('Error updating validateOutput setting:', error);
      setError('Failed to update Validate Output setting');
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
    const nonArchivedExecutions = executions.filter(execution => !execution.archived);
    if (nonArchivedExecutions.length === 0) return null;
    return nonArchivedExecutions.reduce((latest, current) => {
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
    // Force a re-render of the ScheduleList component
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

  const handleNameEdit = async () => {
    try {
      await axios.put(
        buildApiUrl(`/api/tasks/${taskId}`),
        { name: editedName },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      
      // Refresh task data
      const updatedTask = await fetchTask();
      if (updatedTask) {
        setTask(updatedTask);
      }
      setIsEditingName(false);
    } catch (error: any) {
      console.error('Error updating name:', error);
      setError(error.response?.data?.message || 'Failed to update name');
    }
  };

  const startEditingName = () => {
    if (task) {
      setEditedName(task.name);
      setIsEditingName(true);
    }
  };

  const cancelEditingName = () => {
    setIsEditingName(false);
    setEditedName('');
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

    // Check file sizes (1MB = 1024 * 1024 bytes)
    const MAX_SIZE = 1 * 1024 * 1024; // 1MB limit for production
    const oversizedFiles = files.filter(file => file.size > MAX_SIZE);
    if (oversizedFiles.length > 0) {
      setUploadError(`Following files exceed 1MB limit: ${oversizedFiles.map(f => f.name).join(', ')}`);
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
      if (error.response?.status === 413) {
        setUploadError('File size too large. Maximum file size is 1MB.');
      } else {
        setUploadError(error.response?.data?.error || 'Failed to upload file(s)');
      }
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

  const handleLLMChange = async (newLLMName: string) => {
    if (!task) return;
    
    try {
      await axios.put(
        buildApiUrl(`/api/tasks/${taskId}`),
        {
          llmName: newLLMName || null // Send null to clear the preference
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
      console.error('Error updating LLM preference:', error);
      setError(error.response?.data?.message || 'Failed to update LLM preference');
    }
  };

  const handleOwnerChange = async () => {
    if (!newOwnerEmail.trim()) {
      setOwnerChangeError('Please enter an email address');
      return;
    }

    try {
      await axios.put(
        buildApiUrl(`/api/tasks/${taskId}/owner`),
        { newOwnerEmail: newOwnerEmail.trim() },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      
      setOwnerChangeSuccess('Task ownership updated successfully');
      setNewOwnerEmail('');
      setOwnerChangeDialogOpen(false);
      await fetchTask(); // Refresh task data
    } catch (error: any) {
      console.error('Error changing task owner:', error);
      setOwnerChangeError(error.response?.data?.message || 'Failed to change task owner');
    }
  };

  // Add JSON output toggle handler
  const handleJsonOutputToggle = async () => {
    if (!task) return;
    
    try {
      const newOutputAsJson = !task.outputAsJson;
      const updates: any = { outputAsJson: newOutputAsJson };
      // If turning JSON on, turn HTML off
      if (newOutputAsJson && task.outputAsHtml) {
        updates.outputAsHtml = false;
      }
      
      await axios.put(
        buildApiUrl(`/api/tasks/${taskId}`),
        updates,
        { headers: { Authorization: `Bearer ${token}` } }
      );

      // Update the task state with the response
      const taskResponse = await axios.get(
        buildApiUrl(`/api/tasks/${taskId}`),
        { headers: { Authorization: `Bearer ${token}` } }
      );
      
      setTask(taskResponse.data);
    } catch (error: any) {
      console.error('Error updating JSON output mode:', error);
      setError(error.response?.data?.message || 'Failed to update JSON output mode');
    }
  };

  const handleOutputAsHtmlToggle = async () => {
    if (!task) return;
    
    try {
      const newOutputAsHtml = !task.outputAsHtml;
      const updates: any = { outputAsHtml: newOutputAsHtml };
      // If turning HTML on, turn JSON off
      if (newOutputAsHtml && task.outputAsJson) {
        updates.outputAsJson = false;
      }
      
      await axios.put(
        buildApiUrl(`/api/tasks/${taskId}`),
        updates,
        { headers: { Authorization: `Bearer ${token}` } }
      );

      // Update the task state with the response
      const taskResponse = await axios.get(
        buildApiUrl(`/api/tasks/${taskId}`),
        { headers: { Authorization: `Bearer ${token}` } }
      );
      
      setTask(taskResponse.data);
    } catch (error: any) {
      console.error('Error updating HTML output mode:', error);
      setError(error.response?.data?.message || 'Failed to update HTML output mode');
    }
  };

  // Add the Agentic Dev Mode toggle handler
  const handleAgenticDevModeToggle = async () => {
    try {
      await axios.put(
        buildApiUrl(`/api/tasks/${taskId}`),
        { isAgenticDevMode: !task?.isAgenticDevMode },
        { headers: { Authorization: `Bearer ${token}` } }
      );

      // Update the task state with the response from the server
      const taskResponse = await axios.get(
        buildApiUrl(`/api/tasks/${taskId}`),
        {
          headers: { Authorization: `Bearer ${token}` }
        }
      );
      
      setTask(taskResponse.data);
    } catch (error) {
      console.error('Error updating Agentic Dev Mode setting:', error);
      setError('Failed to update Agentic Dev Mode setting');
    }
  };

  // Handler for "Use Shared Browser" toggle and dropdown
  const handleUseSharedBrowserToggle = async () => {
    if (!task || !token) return;
    const newUseSharedBrowserValue = !(task?.useSharedBrowser || false); // Calculate new value based on task state
    try {
      await axios.put(buildApiUrl(`/api/tasks/${task.taskId}`), 
        { useSharedBrowser: newUseSharedBrowserValue },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      await fetchTask(); // Re-fetch task data to update UI from source of truth
      setError(''); // Clear previous errors
    } catch (err) {
      console.error('Failed to update useSharedBrowser mode:', err);
      setError('Failed to update shared browser setting. Please try again.');
      // No need to revert UI change as it's bound to task state which hasn't changed on backend error
      // setUseSharedBrowser(!newUseSharedBrowser);
    }
  };

  const handleTurnOffHeadlessToggle = async () => {
    if (!task || !token) return;
    const newTurnOffHeadlessValue = !(task?.turnOffHeadless || false); // Calculate new value based on task state
    try {
      await axios.put(buildApiUrl(`/api/tasks/${task.taskId}`), 
        { turnOffHeadless: newTurnOffHeadlessValue },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      await fetchTask(); // Re-fetch task data to update UI from source of truth
      setError(''); // Clear previous errors
    } catch (err) {
      console.error('Failed to update turn off headless:', err);
      setError('Failed to update headless mode setting. Please try again.');
    }
  };

  const handleUseKnowledgeBaseToggle = async () => {
    if (!task || !token) return;
    const newUseKnowledgeBaseValue = !(task?.useKnowledgeBase || false);
    try {
      await axios.put(buildApiUrl(`/api/tasks/${task.taskId}`), 
        { useKnowledgeBase: newUseKnowledgeBaseValue },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      await fetchTask(); // Re-fetch task data to update UI from source of truth
      setError(''); // Clear previous errors
    } catch (err) {
      console.error('Failed to update use knowledge base:', err);
      setError('Failed to update knowledge base setting. Please try again.');
    }
  };

  const handleKnowledgeBaseEdit = async () => {
    if (task) {
      try {
        // Fetch the content from the GCS URL
        const response = await axios.get(
          buildApiUrl(`/api/tasks/${taskId}/knowledge-base`),
          { headers: { Authorization: `Bearer ${token}` } }
        );
        setEditedKnowledgeBase(response.data.content || '');
        setIsEditingKnowledgeBase(true);
      } catch (error: any) {
        console.error('Error fetching knowledge base:', error);
        setKnowledgeBaseError(error.response?.data?.message || 'Failed to fetch knowledge base');
      }
    }
  };

  const handleKnowledgeBaseCancel = () => {
    // Fetch the content again to restore it
    if (task?.knowledgeBase) {
      axios.get(
        buildApiUrl(`/api/tasks/${taskId}/knowledge-base`),
        { headers: { Authorization: `Bearer ${token}` } }
      )
      .then(response => {
        setEditedKnowledgeBase(response.data.content || '');
      })
      .catch(error => {
        console.error('Error restoring knowledge base content:', error);
      });
    }
    setIsEditingKnowledgeBase(false);
  };

  const handleKnowledgeBaseSave = async () => {
    if (!task) return;
    
    try {
      console.log('Saving knowledge base content:', editedKnowledgeBase);
      const response = await axios.put(
        buildApiUrl(`/api/tasks/${taskId}/knowledge-base`),
        { content: editedKnowledgeBase || '' },  // Allow empty string
        { headers: { Authorization: `Bearer ${token}` } }
      );
      console.log('Save response:', response.data);
      
      // Update task with the new knowledge base URL and content
      const updatedTask = { ...task, knowledgeBase: response.data.url };
      setTask(updatedTask);
      // Update both the edited content and the displayed content
      setEditedKnowledgeBase(response.data.content || '');
      setKnowledgeBaseContent(response.data.content || '');
      setIsEditingKnowledgeBase(false);
      setKnowledgeBaseError('');
    } catch (error: any) {
      console.error('Error updating knowledge base:', error);
      setKnowledgeBaseError(error.response?.data?.message || 'Failed to update knowledge base');
    }
  };

  // Load task and knowledge base on mount
  useEffect(() => {
    const loadData = async () => {
      setLoading(true);
      try {
        const taskData = await fetchTask();
        if (taskData) {
          // Always try to load knowledge base content
          try {
            console.log('Loading knowledge base for task:', taskId);
            const response = await axios.get(
              buildApiUrl(`/api/tasks/${taskId}/knowledge-base`),
              { headers: { Authorization: `Bearer ${token}` } }
            );
            console.log('Knowledge base response:', response.data);
            // Set both the edited content and the displayed content
            setEditedKnowledgeBase(response.data.content || '');
            setKnowledgeBaseContent(response.data.content || '');
            // Update task with the knowledge base URL if it's new
            if (response.data.url && !taskData.knowledgeBase) {
              const updatedTask = { ...taskData, knowledgeBase: response.data.url };
              setTask(updatedTask);
            }
          } catch (error: any) {
            console.error('Error loading knowledge base:', error);
            // Only show error if it's not a 404 (file doesn't exist yet)
            if (error.response?.status !== 404) {
              setKnowledgeBaseError(error.response?.data?.message || 'Failed to load knowledge base');
            }
          }
        }
      } catch (error: any) {
        console.error('Error loading task:', error);
        setError(error.response?.data?.message || 'Failed to load task');
      } finally {
        setLoading(false);
      }
    };
    loadData();
  }, [taskId, token]);

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
        {/* Admin viewing indicator */}
        {user?.isAdmin && user?.userId !== task.userId && (
          <Alert severity="info" sx={{ mb: 3 }}>
            You are viewing another user's task as an administrator.
          </Alert>
        )}

        {/* Task header with owner change button */}
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            {isEditingName ? (
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <TextField
                  value={editedName}
                  onChange={(e) => setEditedName(e.target.value)}
                  variant="outlined"
                  size="small"
                  autoFocus
                  sx={{ minWidth: '300px' }}
                />
                <IconButton
                  onClick={handleNameEdit}
                  size="small"
                  color="primary"
                  disabled={!editedName.trim() || editedName === task?.name}
                >
                  <SaveIcon />
                </IconButton>
                <IconButton
                  onClick={cancelEditingName}
                  size="small"
                >
                  <CancelIcon />
                </IconButton>
              </Box>
            ) : (
              <>
                <Typography variant="h4" component="h1">
                  {task.name}
                </Typography>
                {showActions && (
                  <Tooltip title="Edit name">
                    <IconButton onClick={startEditingName} size="small">
                      <EditIcon />
                    </IconButton>
                  </Tooltip>
                )}
                {user?.isAdmin && (
                  <Tooltip title="Change Owner">
                    <IconButton 
                      color="primary" 
                      onClick={() => setOwnerChangeDialogOpen(true)}
                      size="small"
                    >
                      <PersonAddIcon />
                    </IconButton>
                  </Tooltip>
                )}
              </>
            )}
          </Box>
        </Box>

        {/* Change Owner Dialog */}
        <Dialog 
          open={ownerChangeDialogOpen} 
          onClose={() => {
            setOwnerChangeDialogOpen(false);
            setOwnerChangeError('');
            setOwnerChangeSuccess('');
          }}
        >
          <DialogTitle>Change Task Owner</DialogTitle>
          <DialogContent>
            <Box sx={{ pt: 2 }}>
              <TextField
                label="New Owner Email"
                variant="outlined"
                fullWidth
                value={newOwnerEmail}
                onChange={(e) => setNewOwnerEmail(e.target.value)}
                error={!!ownerChangeError}
                helperText={ownerChangeError}
                type="email"
                placeholder="Enter new owner's email address"
              />
              {ownerChangeSuccess && (
                <Alert severity="success" sx={{ mt: 2 }}>
                  {ownerChangeSuccess}
                </Alert>
              )}
            </Box>
          </DialogContent>
          <DialogActions>
            <Button 
              onClick={() => {
                setOwnerChangeDialogOpen(false);
                setOwnerChangeError('');
                setOwnerChangeSuccess('');
              }}
            >
              Cancel
            </Button>
            <Button 
              variant="contained" 
              color="primary" 
              onClick={handleOwnerChange}
              disabled={!newOwnerEmail.trim()}
            >
              Change Owner
            </Button>
          </DialogActions>
        </Dialog>

        <Box sx={{ 
          mb: 4, 
          display: 'flex', 
          flexDirection: { xs: 'column', md: 'row' },
          justifyContent: 'space-between', 
          alignItems: { xs: 'stretch', md: 'flex-start' },
          gap: 2
        }}>
          <Box sx={{ flex: 1 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
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
            {/* Only show Owner if the current user is not the owner */}
            {user?.userId !== task.userId && (
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                Owner: {user?.isAdmin ? (
                  <RouterLink to={`/profile/${task.userId}`} style={{ textDecoration: 'none' }}>
                    {task.userId}
                  </RouterLink>
                ) : (
                  task.userId
                )}
              </Typography>
            )}
            {showActions && (
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                <Box sx={{ 
                  display: 'grid', 
                  gridTemplateColumns: {
                    xs: '1fr',
                    sm: 'repeat(2, 1fr)'
                  }, 
                  gap: 1, 
                  mb: 2 
                }}>
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
                  <Tooltip title="When enabled, the agent can pause execution to request additional information from you">
                    <FormControlLabel
                      control={
                        <Switch
                          checked={Boolean(task.isInteractive)}
                          onChange={handleInteractiveModeToggle}
                          color="primary"
                          disabled={Boolean(task.isDeepResearch)}
                        />
                      }
                      label="Interactive Mode"
                      sx={{ opacity: Boolean(task.isDeepResearch) ? 0.5 : 1 }}
                    />
                  </Tooltip>
                  <Tooltip title="When enabled, the task will use advanced AI to perform comprehensive research on your topic using public web data only. Currently does not use your uploads or web accounts (Config), but will support these in the future.">
                    <FormControlLabel
                      control={
                        <Switch
                          checked={Boolean(task.isDeepResearch)}
                          onChange={handleDeepResearchToggle}
                          color="primary"
                        />
                      }
                      label="Perform Deep Research"
                    />
                  </Tooltip>
                  <Tooltip title="When enabled, the task will allow the agent to take up to 100 steps (instead of the default 25) to complete complex tasks that require more actions">
                    <FormControlLabel
                      control={
                        <Switch
                          checked={Boolean(task.isComplexTask)}
                          onChange={handleComplexTaskToggle}
                          color="primary"
                          disabled={Boolean(task.isDeepResearch)}
                        />
                      }
                      label="Complex Task"
                      sx={{ opacity: Boolean(task.isDeepResearch) ? 0.5 : 1 }}
                    />
                  </Tooltip>
                  <Tooltip title="When enabled, the agent will extract structured content from web pages and save it as JSON files">
                    <FormControlLabel
                      control={
                        <Switch
                          checked={task?.extractPageContent || false}
                          onChange={handleExtractPageContentToggle}
                          disabled={loading || Boolean(task.isDeepResearch)}
                        />
                      }
                      label="Extract Page Content"
                      sx={{ mt: 1, opacity: Boolean(task.isDeepResearch) ? 0.5 : 1 }}
                    />
                  </Tooltip>
                  <Tooltip title="When enabled, the agent will validate its output to ensure accuracy">
                    <FormControlLabel
                      control={
                        <Switch
                          checked={task?.validateOutput || false}
                          onChange={handleValidateOutputToggle}
                          disabled={loading || Boolean(task.isDeepResearch)}
                          color="primary"
                        />
                      }
                      label="Validate Output"
                      sx={{ mt: 1, opacity: Boolean(task.isDeepResearch) ? 0.5 : 1 }}
                    />
                  </Tooltip>
                  <Tooltip title="When enabled, the agent will output its final result in JSON format. This is useful for structured data extraction.">
                    <FormControlLabel
                      control={
                        <Switch
                          checked={Boolean(task.outputAsJson)}
                          onChange={handleJsonOutputToggle}
                          color="primary"
                          disabled={Boolean(task.isDeepResearch)}
                        />
                      }
                      label="Output as JSON"
                      sx={{ opacity: Boolean(task.isDeepResearch) ? 0.5 : 1 }}
                    />
                  </Tooltip>
                  <Tooltip title="When enabled, the agent will output its final result in HTML5 format. This is useful for rich text or formatted content.">
                    <FormControlLabel
                      control={
                        <Switch
                          checked={Boolean(task.outputAsHtml)}
                          onChange={handleOutputAsHtmlToggle}
                          color="primary"
                          disabled={Boolean(task.isDeepResearch)}
                        />
                      }
                      label="Output as HTML5"
                      sx={{ opacity: Boolean(task.isDeepResearch) ? 0.5 : 1 }}
                    />
                  </Tooltip>
                  <Tooltip title="When enabled, the agent can access the current page's content and run JavaScript on the page, providing more developer-oriented capabilities.">
                    <FormControlLabel
                      control={
                        <Switch
                          checked={task?.isAgenticDevMode || false}
                          onChange={handleAgenticDevModeToggle}
                          disabled={loading || Boolean(task.isDeepResearch)}
                          color="primary"
                        />
                      }
                      label="Agentic Dev Mode"
                      sx={{ mt: 1, opacity: Boolean(task.isDeepResearch) ? 0.5 : 1 }}
                    />
                  </Tooltip>
                  <Tooltip title="Enable to use a shared browser session for this task. This will use the website configs shared publicly.">
                    <FormControlLabel
                      control={<Switch checked={task?.useSharedBrowser || false} onChange={handleUseSharedBrowserToggle} />}
                      label="Use Shared Browser"
                    />
                  </Tooltip>
                  <Tooltip title="When enabled, the browser will not be headless during task execution. This is needed for accessing some websites that require a visible browser such as x.com, circle.so, etc.">
                    <FormControlLabel
                      control={<Switch checked={task?.turnOffHeadless || false} onChange={handleTurnOffHeadlessToggle} />}
                      label="Turn Off Headless"
                    />
                  </Tooltip>
                  <Tooltip title="When enabled, the agent can search the knowledge base for relevant information during task execution">
                    <FormControlLabel
                      control={<Switch checked={task?.useKnowledgeBase || false} onChange={handleUseKnowledgeBaseToggle} />}
                      label="Use Knowledge Base"
                    />
                  </Tooltip>
                </Box>
                <Tooltip title={
                  <div>
                    <p>If selected, this LLM will be used first to run the task. If it fails, other LLMs will be tried as backup.</p>
                    <p>LLM format: {`<deployment>${'>'}<provider>${'>'}<version>`}</p>
                    <p>Example: "azure-{'>'}-openai-{'>'}-gpt-4o" means GPT-4 model deployed on Azure, provided by OpenAI</p>
                  </div>
                } placement="right">
                  <FormControl sx={{ width: '100%' }}>
                    <InputLabel id="llm-select-label">Preferred LLM</InputLabel>
                    <Select
                      labelId="llm-select-label"
                      value={task.llmName || ''}
                      onChange={(e) => handleLLMChange(e.target.value)}
                      label="Preferred LLM"
                    >
                      <MenuItem value="">
                        <em>System Default Order</em>
                      </MenuItem>
                      {( (task && task.selectedLLMs && task.selectedLLMs.length > 0) 
                          ? task.selectedLLMs 
                          : getLLMsForTask(Boolean(task?.isDeepResearch)) 
                       ).map((llm: string) => (
                        <MenuItem key={llm} value={llm}>
                          {llm}
                        </MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                </Tooltip>
              </Box>
            )}
          </Box>
          {showActions && (
            <Box sx={{ 
              display: 'flex', 
              gap: 2, 
              flexShrink: 0,
              justifyContent: { xs: 'flex-start', md: 'flex-end' },
              mt: { xs: 2, md: 0 }
            }}>
              <Button
                variant="contained"
                color="primary"
                onClick={handleRun}
                disabled={getLatestExecution()?.status === 'running' || task?.status === 'archived'}
              >
                Run Task
              </Button>
              <Button
                variant="outlined"
                color={task?.status === 'archived' ? "info" : "warning"}
                onClick={handleArchive}
                startIcon={task?.status === 'archived' ? <UnarchiveIcon /> : <ArchiveIcon />}
              >
                {task?.status === 'archived' ? 'Unarchive Task' : 'Archive Task'}
              </Button>
            </Box>
          )}
        </Box>

        {task.isDeepResearch && (
          <Alert severity="info" sx={{ mt: 1, mb: 3 }}>
            Deep Research Mode is enabled. When you run this task, it will use advanced AI to perform comprehensive research on your topic using public web data only. Currently does not use your uploads or web accounts (Config), but will support these in the future. Email notifications are automatically enabled for Deep Research tasks.
          </Alert>
        )}

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

          {/* Knowledge Base Section */}
          <Grid item xs={12}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
              <Typography variant="h6" gutterBottom>
                Knowledge Base
              </Typography>
              {showActions && !isEditingKnowledgeBase && (
                <Tooltip title="Edit knowledge base">
                  <IconButton onClick={handleKnowledgeBaseEdit} size="small">
                    <EditIcon />
                  </IconButton>
                </Tooltip>
              )}
            </Box>
            {knowledgeBaseError && (
              <Alert severity="error" sx={{ mb: 2 }}>
                {knowledgeBaseError}
              </Alert>
            )}
            {isEditingKnowledgeBase ? (
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <TextField
                  multiline
                  rows={10}
                  fullWidth
                  value={editedKnowledgeBase}
                  onChange={(e) => setEditedKnowledgeBase(e.target.value)}
                  variant="outlined"
                  placeholder="Enter knowledge base content..."
                />
                <Box sx={{ display: 'flex', gap: 1, justifyContent: 'flex-end' }}>
                  <Button
                    startIcon={<CancelIcon />}
                    onClick={handleKnowledgeBaseCancel}
                    variant="outlined"
                    color="inherit"
                  >
                    Cancel
                  </Button>
                  <Button
                    startIcon={<SaveIcon />}
                    onClick={handleKnowledgeBaseSave}
                    variant="contained"
                    color="primary"
                  >
                    Save
                  </Button>
                </Box>
              </Box>
            ) : (
              <Box sx={{ 
                backgroundColor: '#f5f5f5',
                padding: 2,
                borderRadius: 1,
                height: '300px',
                overflow: 'auto'
              }}>
                {editedKnowledgeBase ? (
                  <Typography variant="body1" component="pre" sx={{ 
                    whiteSpace: 'pre-wrap',
                    fontFamily: 'monospace',
                    margin: 0
                  }}>
                    {editedKnowledgeBase}
                  </Typography>
                ) : (
                  <Typography variant="body1" component="pre" sx={{ 
                    whiteSpace: 'pre-wrap',
                    fontFamily: 'monospace',
                    margin: 0
                  }}>
                    No knowledge base content yet. Click the edit button to add content.
                  </Typography>
                )}
              </Box>
            )}
          </Grid>

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
                  {executions.filter(execution => !execution.archived).map((execution) => (
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
                              <Box sx={{ color: 'error.main' }}>
                                <CollapsibleText text={execution.error} />
                              </Box>
                            ) : (
                              <CollapsibleText text={execution.result || '-'} />
                            )}
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
                                      icon={file.is_html ? <ScreenshotIcon fontSize="small" /> : undefined}
                                    />
                                  ))}
                                </Box>
                              </Box>
                            )}
                            <Box sx={{ mt: 1 }}>
                              <Link
                                component="button"
                                variant="body2"
                                onClick={() => navigate(`/tasks/${taskId}/executions/${execution.executionId}`)}
                                sx={{ display: 'block' }}
                              >
                                View Full Details
                              </Link>
                            </Box>
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

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}

      {success && (
        <Alert severity="success" sx={{ mb: 2 }} onClose={() => setSuccess('')}>
          {success}
        </Alert>
      )}
    </Container>
  );
} 