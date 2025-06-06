import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Box,
  Paper,
  Typography,
  Button,
  IconButton,
  Chip,
  CircularProgress,
  Alert,
  Link,
  Grid,
  Divider,
  Tooltip,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField
} from '@mui/material';
import {
  ArrowBack as ArrowBackIcon,
  Autorenew as AutorenewIcon,
  CheckCircle as CheckCircleIcon,
  Error as ErrorIcon,
  PowerOff as PowerOffIcon,
  Screenshot as ScreenshotIcon,
  Refresh as RefreshIcon,
  Timeline as TimelineIcon,
  HourglassEmpty as PendingIcon
} from '@mui/icons-material';
import { useAuth } from '../contexts/AuthContext';
import { intervalToDuration } from 'date-fns';
import { API_URL } from '../config';
import axios from 'axios';

interface WorkflowTask {
  taskId: string;
  status: string;
  order: number;
  dependsOn?: string[];
  error?: string;
  completedAt?: string;
  result?: string;
  executionId?: string;
  prompt?: string;
  originalPrompt?: string;
  details_gif?: string;
  browser_use_log?: string;
  startTime?: string;
  llmName?: string;
  result_files?: {
    url: string;
    filename: string;
    token: string;
    is_html?: boolean;
  }[];
}

interface WorkflowExecution {
  executionId: string;
  workflowId: string;
  userId: string;
  status: string;
  startTime: string;
  completedAt?: string;
  tasks: WorkflowTask[];
  error?: string;
  result?: string;
}

interface Workflow {
  workflowId: string;
  name: string;
  description: string;
  yaml: string;
  userId: string;
  createdAt: string;
  updatedAt: string;
}

// Add formatJsonIfValid helper function
const formatJsonIfValid = (text: string): JSX.Element => {
  // Check if text is valid JSON
  try {
    const parsed = JSON.parse(text);
    const formattedJson = JSON.stringify(parsed, null, 2);
    
    return (
      <pre
        style={{
          backgroundColor: '#f5f5f5',
          padding: '12px',
          borderRadius: '4px',
          overflow: 'auto',
          maxHeight: '500px',
          fontSize: '0.9rem',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word'
        }}
      >
        {formattedJson}
      </pre>
    );
  } catch (e) {
    // If not valid JSON, return regular text
    return (
      <Typography 
        variant="body1" 
        sx={{ 
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          overflowWrap: 'break-word'
        }}
      >
        {text}
      </Typography>
    );
  }
};

export default function WorkflowExecutionDetails() {
  const { id: workflowId, executionId } = useParams();
  const navigate = useNavigate();
  const { token } = useAuth();
  
  console.log('Component initialized with:', { 
    workflowId, 
    executionId, 
    hasToken: !!token,
    params: useParams()
  });

  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [execution, setExecution] = useState<WorkflowExecution | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isAutoRefreshing, setIsAutoRefreshing] = useState(false);
  const [killDialogOpen, setKillDialogOpen] = useState(false);
  const [killLoading, setKillLoading] = useState(false);
  const [rerunLoading, setRerunLoading] = useState<string | null>(null);
  const [rerunDialogOpen, setRerunDialogOpen] = useState(false);
  const [selectedTask, setSelectedTask] = useState<WorkflowTask | null>(null);
  const [editedPrompt, setEditedPrompt] = useState('');
  const [isPromptChanged, setIsPromptChanged] = useState(false);
  const [killTaskDialogOpen, setKillTaskDialogOpen] = useState(false);
  const [selectedTaskToKill, setSelectedTaskToKill] = useState<any>(null);
  const [killTaskLoading, setKillTaskLoading] = useState(false);

  const fetchData = useCallback(async () => {
    console.log('fetchData called with:', { workflowId, executionId });
    if (!workflowId || !executionId || !token) {
      console.log('Missing required params:', { workflowId, executionId, hasToken: !!token });
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      setError(null);
      const baseUrl = API_URL;
      console.log('Fetching workflow details from:', `${baseUrl}/api/workflows/${workflowId}`);

      // Fetch workflow details
      const workflowResponse = await fetch(`${baseUrl}/api/workflows/${workflowId}`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (!workflowResponse.ok) {
        console.error('Workflow fetch failed:', await workflowResponse.text());
        throw new Error('Failed to fetch workflow details');
      }

      const workflowData = await workflowResponse.json();
      console.log('Workflow data received:', workflowData);
      setWorkflow(workflowData);

      console.log('Fetching execution details from:', `${baseUrl}/api/workflows/${workflowId}/executions/${executionId}`);
      // Fetch execution details
      const executionResponse = await fetch(`${baseUrl}/api/workflows/${workflowId}/executions/${executionId}`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (!executionResponse.ok) {
        console.error('Execution fetch failed:', await executionResponse.text());
        throw new Error('Failed to fetch execution details');
      }

      const executionData = await executionResponse.json();
      console.log('Workflow execution data:', executionData);

      // Fetch task execution details for each task
      const tasksWithDetails = await Promise.all(
        (executionData.tasks || []).map(async (task: WorkflowTask) => {
          console.log('Processing task:', task);
          if (!task.executionId) {
            console.log('No executionId for task:', task.taskId);
            return {
              ...task,
              originalPrompt: task.taskId.startsWith('task-') ? task.prompt : ''
            };
          }

          try {
            console.log('Fetching task execution details for:', task.executionId);
            const taskExecutionResponse = await fetch(`${baseUrl}/api/tasks/${task.taskId}/executions/${task.executionId}`, {
              headers: {
                Authorization: `Bearer ${token}`,
              },
            });

            if (taskExecutionResponse.ok) {
              const taskExecutionData = await taskExecutionResponse.json();
              console.log('Task execution data received:', taskExecutionData);
              return {
                ...task,
                status: taskExecutionData.status,
                prompt: taskExecutionData.prompt,
                originalPrompt: task.taskId.startsWith('task-') ? task.prompt : '',
                details_gif: taskExecutionData.details_gif,
                browser_use_log: taskExecutionData.browser_use_log,
                result: taskExecutionData.result,
                error: taskExecutionData.error,
                completedAt: taskExecutionData.completedAt,
                startTime: taskExecutionData.startTime,
                llmName: taskExecutionData.llmName,
                result_files: taskExecutionData.result_files
              };
            } else {
              console.error('Failed to fetch task execution:', await taskExecutionResponse.text());
            }
          } catch (error) {
            console.error(`Error fetching task execution details for task ${task.taskId}:`, error);
          }
          return {
            ...task,
            originalPrompt: task.taskId.startsWith('task-') ? task.prompt : ''
          };
        })
      );

      setExecution({
        ...executionData,
        tasks: tasksWithDetails || []
      });
    } catch (err) {
      console.error('Error fetching workflow execution details:', err);
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, [workflowId, executionId, token]);

  useEffect(() => {
    console.log('useEffect triggered with:', { workflowId, executionId, hasToken: !!token });
    fetchData();
  }, [fetchData, workflowId, executionId, token]);

  // Set up polling for running executions
  useEffect(() => {
    console.log('Polling useEffect triggered with execution status:', execution?.status);
    let intervalId: NodeJS.Timeout | null = null;
    
    // Check if any task is in pending or running state
    const hasActiveTasks = execution?.tasks.some(task => 
      ['pending', 'running'].includes(task.status.toLowerCase())
    );
    
    if (execution && (['running', 'pending'].includes(execution.status.toLowerCase()) || hasActiveTasks)) {
      setIsAutoRefreshing(true);
      intervalId = setInterval(fetchData, 5000);
    } else {
      setIsAutoRefreshing(false);
    }
    
    return () => {
      if (intervalId) {
        clearInterval(intervalId);
        setIsAutoRefreshing(false);
      }
    };
  }, [execution?.status, execution?.tasks, fetchData]);

  const getStatusColor = (status: string) => {
    switch (status.toLowerCase()) {
      case 'completed':
        return 'success';
      case 'failed':
        return 'error';
      case 'running':
        return 'primary';
      case 'pending':
        return 'warning';
      default:
        return 'default';
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status.toLowerCase()) {
      case 'completed':
        return <CheckCircleIcon />;
      case 'failed':
        return <ErrorIcon />;
      case 'running':
        return <TimelineIcon />;
      case 'pending':
        return <PendingIcon />;
      default:
        return <PendingIcon />;
    }
  };

  const getDuration = (startTime: string, completedAt?: string, status?: string) => {
    if (!completedAt || status === 'killed') return 'In progress';

    const end = completedAt ? new Date(completedAt) : new Date();
    const start = new Date(startTime);
    const duration = intervalToDuration({ start, end });
    
    const parts = [];
    if (duration.hours) parts.push(`${duration.hours}h`);
    if (duration.minutes) parts.push(`${duration.minutes}m`);
    if (duration.seconds) parts.push(`${duration.seconds}s`);
    
    return parts.join(' ') || '< 1s';
  };

  const handleKillClick = () => {
    setError(null);
    setKillDialogOpen(true);
  };

  const handleConfirmKill = async () => {
    if (!workflowId || !executionId || !token) return;

    setKillLoading(true);
    setError(null);

    try {
      await axios.put(
        `${API_URL}/api/workflows/${workflowId}/executions/${executionId}/kill`,
        {},
        {
          headers: {
            Authorization: `Bearer ${token}`
          }
        }
      );

      // Refresh execution data
      fetchData();
      setKillDialogOpen(false);
    } catch (error: any) {
      console.error('Error killing workflow execution:', error);
      setError(error.response?.data?.message || 'Failed to kill workflow execution');
    } finally {
      setKillLoading(false);
    }
  };

  const canRerunTask = (task: WorkflowTask) => {
    if (!execution) return false;
    
    // Check if workflow execution is in a state that allows rerunning tasks
    if (['pending', 'running'].includes(execution.status)) {
      return false;
    }

    // Check if the task itself is in pending or running state
    if (['pending', 'running'].includes(task.status.toLowerCase())) {
      return false;
    }

    // Check if all dependent tasks are completed
    if (task.dependsOn) {
      const dependentTasks = execution.tasks.filter(t => task.dependsOn?.includes(t.taskId));
      return dependentTasks.every(t => t.status === 'completed');
    }

    return true;
  };

  const handleRerunTask = async (taskId: string) => {
    if (!workflowId || !executionId || !token) {
      setError('Missing required parameters');
      return;
    }

    const task = execution?.tasks.find(t => t.taskId === taskId);
    if (!task) {
      setError('Task not found in execution');
      return;
    }

    setSelectedTask(task);
    
    // If taskId doesn't start with "task-" and originalPrompt is not set, fetch the task details
    if (!taskId.startsWith('task-') && !task.originalPrompt) {
      try {
        const baseUrl = API_URL;
        const response = await fetch(`${baseUrl}/api/tasks/${taskId}`, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });

        if (!response.ok) {
          throw new Error('Failed to fetch task details');
        }

        const taskData = await response.json();
        const prompt = taskData.prompt || '';
        // Store the loaded prompt in originalPrompt
        task.originalPrompt = prompt;
        setEditedPrompt(prompt);
      } catch (error) {
        console.error('Error fetching task details:', error);
        setError(error instanceof Error ? error.message : 'Failed to fetch task details');
        return;
      }
    } else {
      setEditedPrompt(task.originalPrompt || '');
    }
    
    setIsPromptChanged(false);
    setRerunDialogOpen(true);
  };

  const handlePromptChange = (newPrompt: string) => {
    setEditedPrompt(newPrompt);
    setIsPromptChanged(newPrompt !== selectedTask?.originalPrompt);
  };

  const handleConfirmRerun = async () => {
    if (!workflowId || !executionId || !token || !selectedTask) return;

    setRerunLoading(selectedTask.taskId);
    try {
      const baseUrl = API_URL;
      const body: any = {};
      
      if (isPromptChanged) {
        body.prompt = editedPrompt;
      }

      const response = await fetch(
        `${baseUrl}/api/workflows/${workflowId}/executions/${executionId}/tasks/${selectedTask.taskId}/rerun`,
        {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: Object.keys(body).length > 0 ? JSON.stringify(body) : undefined
        }
      );

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Failed to rerun task');
      }

      // Refresh the execution data
      await fetchData();
      setRerunDialogOpen(false);
    } catch (error) {
      console.error('Error rerunning task:', error);
      setError(error instanceof Error ? error.message : 'Failed to rerun task');
    } finally {
      setRerunLoading(null);
    }
  };

  const handleKillTaskClick = (task: any) => {
    setSelectedTaskToKill(task);
    setKillTaskDialogOpen(true);
  };

  const handleConfirmKillTask = async () => {
    if (!selectedTaskToKill?.taskId || !selectedTaskToKill?.executionId || !token) return;

    setKillTaskLoading(true);
    setError(null);

    try {
      await axios.put(
        `${API_URL}/api/tasks/${selectedTaskToKill.taskId}/executions/${selectedTaskToKill.executionId}/kill`,
        {},
        {
          headers: {
            Authorization: `Bearer ${token}`
          }
        }
      );

      // Refresh execution data
      fetchData();
      setKillTaskDialogOpen(false);
    } catch (error: any) {
      console.error('Error killing task:', error);
      setError(error.response?.data?.message || 'Failed to kill task');
    } finally {
      setKillTaskLoading(false);
    }
  };

  const canKillTask = (task: any) => {
    // Only allow killing tasks when workflow is completed or failed
    return task.status === 'running' && 
           execution?.status && 
           ['completed', 'failed'].includes(execution.status.toLowerCase());
  };

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box sx={{ p: 3 }}>
      {/* Header */}
      <Paper sx={{ p: 2, mb: 3 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 2 }}>
          <IconButton onClick={() => navigate(`/workflows/${workflowId}/run`)}>
            <ArrowBackIcon />
          </IconButton>
          <Typography variant="h5">
            {workflow?.name || 'Workflow Execution Details'}
          </Typography>
          <Box sx={{ flexGrow: 1 }} />
          {isAutoRefreshing && (
            <Tooltip title="Real-time updates active">
              <AutorenewIcon color="info" sx={{ animation: 'spin 2s linear infinite' }} />
            </Tooltip>
          )}
          {execution?.status.toLowerCase() === 'running' && (
            <Tooltip title="Kill all running tasks">
              <IconButton
                onClick={handleKillClick}
                disabled={killLoading}
                color="error"
              >
                <PowerOffIcon />
              </IconButton>
            </Tooltip>
          )}
        </Box>
        <Typography variant="body1" color="text.secondary">
          {workflow?.description}
        </Typography>
      </Paper>

      {error && (
        <Alert severity="error" sx={{ mb: 3 }}>
          {error}
        </Alert>
      )}

      {/* Execution Details */}
      <Paper sx={{ p: 2, mb: 3 }}>
        <Typography variant="h6" gutterBottom>
          Execution Details
        </Typography>
        <Grid container spacing={2}>
          <Grid item xs={12}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
              <Box>
                <Chip
                  icon={getStatusIcon(execution?.status || '')}
                  label={execution?.status || 'Unknown'}
                  color={getStatusColor(execution?.status || '')}
                  sx={{ mr: 2 }}
                />
              </Box>
            </Box>
            <Typography variant="body1" sx={{ mb: 1 }}>
              <strong>Started:</strong> {execution?.startTime ? new Date(execution.startTime).toLocaleString() : '-'}
            </Typography>
            {execution?.completedAt && (
              <Typography variant="body1" sx={{ mb: 1 }}>
                <strong>Completed:</strong> {new Date(execution.completedAt).toLocaleString()}
              </Typography>
            )}
            <Typography variant="body1" sx={{ mb: 1 }}>
              <strong>Duration:</strong> {execution ? getDuration(execution.startTime, execution.completedAt, execution.status) : '-'}
            </Typography>
          </Grid>
        </Grid>
      </Paper>

      {/* Tasks Section */}
      <Paper sx={{ p: 2 }}>
        <Typography variant="h6" gutterBottom>
          Tasks
        </Typography>
        {execution?.tasks?.map((task, index) => (
          <Box key={task.taskId} sx={{ mb: 3 }}>
            <Paper sx={{ p: 2, mb: 2 }}>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
                <Typography variant="h6">Task {index + 1}</Typography>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <Chip
                    icon={getStatusIcon(task.status)}
                    label={task.status}
                    color={getStatusColor(task.status)}
                    size="small"
                  />
                  {task.llmName && (
                    <Chip
                      label={`LLM: ${task.llmName}`}
                      variant="outlined"
                      size="small"
                    />
                  )}
                  {canKillTask(task) && (
                    <Tooltip title="Kill task">
                      <IconButton
                        onClick={() => handleKillTaskClick(task)}
                        color="error"
                        size="small"
                      >
                        <PowerOffIcon />
                      </IconButton>
                    </Tooltip>
                  )}
                  {canRerunTask(task) && (
                    <Tooltip title="Rerun Task">
                      <IconButton
                        onClick={() => handleRerunTask(task.taskId)}
                        disabled={rerunLoading === task.taskId}
                        color="primary"
                      >
                        {rerunLoading === task.taskId ? (
                          <CircularProgress size={24} />
                        ) : (
                          <RefreshIcon />
                        )}
                      </IconButton>
                    </Tooltip>
                  )}
                </Box>
              </Box>

              {/* Task Timing Details */}
              <Box sx={{ 
                display: 'flex', 
                gap: 3, 
                mb: 2, 
                flexWrap: 'wrap',
                '& > div': {
                  display: 'flex',
                  alignItems: 'center',
                  gap: 1
                }
              }}>
                <Box>
                  <Typography variant="body2" color="text.secondary" component="span">
                    <strong>Started:</strong>
                  </Typography>
                  <Typography variant="body2" component="span">
                    {task.startTime ? new Date(task.startTime).toLocaleString() : '-'}
                  </Typography>
                </Box>
                <Box>
                  <Typography variant="body2" color="text.secondary" component="span">
                    <strong>Completed:</strong>
                  </Typography>
                  <Typography variant="body2" component="span">
                    {task.completedAt ? new Date(task.completedAt).toLocaleString() : '-'}
                  </Typography>
                </Box>
                <Box>
                  <Typography variant="body2" color="text.secondary" component="span">
                    <strong>Duration:</strong>
                  </Typography>
                  <Typography variant="body2" component="span">
                    {task.startTime && task.completedAt ? getDuration(task.startTime, task.completedAt, task.status) : '-'}
                  </Typography>
                </Box>
              </Box>

              {/* Task Details */}
              <Grid container spacing={2}>
                {/* Prompt Section */}
                {task.prompt && (
                  <Grid item xs={12}>
                    <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                      Prompt
                    </Typography>
                    <Paper variant="outlined" sx={{ p: 2, bgcolor: 'grey.50' }}>
                      <Typography 
                        variant="body1" 
                        sx={{ 
                          whiteSpace: 'pre-wrap',
                          wordBreak: 'break-word',
                          overflowWrap: 'break-word'
                        }}
                      >
                        {task.prompt}
                      </Typography>
                    </Paper>
                  </Grid>
                )}

                {/* Result/Error Section */}
                {(task.result || task.error) && (
                  <Grid item xs={12}>
                    <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                      {task.status === 'failed' ? 'Error' : 'Result'}
                    </Typography>
                    <Paper variant="outlined" sx={{ p: 2, bgcolor: task.error ? 'error.50' : 'success.50' }}>
                      {task.error ? (
                        <Typography 
                          variant="body1" 
                          color="error"
                          sx={{ 
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-word',
                            overflowWrap: 'break-word'
                          }}
                        >
                          {task.error}
                        </Typography>
                      ) : task.result ? (
                        (task.result.trim().startsWith('{') || task.result.trim().startsWith('[')) ? (
                          formatJsonIfValid(task.result)
                        ) : (
                          <Typography 
                            variant="body1" 
                            sx={{ 
                              whiteSpace: 'pre-wrap',
                              wordBreak: 'break-word',
                              overflowWrap: 'break-word'
                            }}
                          >
                            {task.result}
                          </Typography>
                        )
                      ) : (
                        <Typography color="textSecondary">No result available</Typography>
                      )}
                    </Paper>
                  </Grid>
                )}

                {/* Result Files Section */}
                {task.result_files && task.result_files.length > 0 && (
                  <Grid item xs={12}>
                    <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                      Result Files
                    </Typography>
                    <Paper sx={{ p: 2, bgcolor: 'background.default' }}>
                      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                        {task.result_files.map((file, index) => (
                          <Link
                            key={index}
                            href={file.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            sx={{ display: 'flex', alignItems: 'center' }}
                          >
                            {file.is_html ? (
                              <>
                                <ScreenshotIcon sx={{ mr: 1, fontSize: '1.2rem' }} />
                                {file.filename} <Typography variant="caption" sx={{ ml: 1, color: 'text.secondary' }}>(View in browser)</Typography>
                              </>
                            ) : (
                              file.filename
                            )}
                          </Link>
                        ))}
                      </Box>
                    </Paper>
                  </Grid>
                )}

                {/* Execution Log Section */}
                {task.browser_use_log && (
                  <Grid item xs={12}>
                    <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                      Execution Log
                    </Typography>
                    <Paper sx={{ p: 2, bgcolor: 'background.default' }}>
                      <iframe
                        src={`${API_URL}/api/tasks/${task.taskId}/executions/${task.executionId}/log?token=${task.browser_use_log.split('_').pop()?.replace('.log', '')}`}
                        style={{
                          width: '100%',
                          height: '400px',
                          border: 'none',
                          backgroundColor: 'white'
                        }}
                        title="Execution Log"
                      />
                    </Paper>
                  </Grid>
                )}

                {/* Execution Recording Section */}
                {task.details_gif && (
                  <Grid item xs={12}>
                    <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                      Execution Recording
                    </Typography>
                    <Paper sx={{ p: 2, bgcolor: 'background.default' }}>
                      <Box sx={{ display: 'flex', justifyContent: 'center' }}>
                        <img
                          src={task.details_gif}
                          alt="Task Execution Recording"
                          style={{ maxWidth: '100%', maxHeight: '400px' }}
                        />
                      </Box>
                    </Paper>
                  </Grid>
                )}
              </Grid>
            </Paper>
            {index < (execution.tasks.length - 1) && <Divider sx={{ my: 2 }} />}
          </Box>
        ))}
        {(!execution?.tasks || execution.tasks.length === 0) && (
          <Typography align="center" color="text.secondary">
            No tasks found
          </Typography>
        )}
      </Paper>

      {/* Kill Dialog */}
      <Dialog
        open={killDialogOpen}
        onClose={() => setKillDialogOpen(false)}
        aria-labelledby="alert-dialog-title"
        aria-describedby="alert-dialog-description"
      >
        <DialogTitle id="alert-dialog-title">{"Kill Running Tasks?"}</DialogTitle>
        <DialogContent>
          {error && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {error}
            </Alert>
          )}
          <Typography>
            Are you sure you want to kill all running tasks in this workflow execution? This action cannot be undone.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setKillDialogOpen(false)} color="primary">
            Cancel
          </Button>
          <Button
            onClick={handleConfirmKill}
            color="error" 
            variant="contained" 
            disabled={killLoading}
            startIcon={killLoading ? <CircularProgress size={20} color="inherit" /> : <PowerOffIcon />}
            autoFocus
          >
            {killLoading ? 'Killing Tasks...' : 'Kill All Tasks'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Rerun Task Dialog */}
      <Dialog
        open={rerunDialogOpen}
        onClose={() => setRerunDialogOpen(false)}
        maxWidth="md"
        fullWidth
      >
        <DialogTitle>Rerun Task</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" gutterBottom>
            You can modify the task prompt before rerunning. The task will be executed with the updated prompt.
          </Typography>
          <TextField
            fullWidth
            multiline
            rows={6}
            value={editedPrompt}
            onChange={(e) => handlePromptChange(e.target.value)}
            variant="outlined"
            label="Task Prompt"
            sx={{ mt: 2 }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRerunDialogOpen(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleConfirmRerun}
            variant="contained"
            disabled={rerunLoading === selectedTask?.taskId}
            startIcon={rerunLoading === selectedTask?.taskId ? <CircularProgress size={20} /> : null}
          >
            {rerunLoading === selectedTask?.taskId ? 'Rerunning...' : 'Rerun Task'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Kill Task Dialog */}
      <Dialog
        open={killTaskDialogOpen}
        onClose={() => setKillTaskDialogOpen(false)}
        aria-labelledby="kill-task-dialog-title"
        aria-describedby="kill-task-dialog-description"
      >
        <DialogTitle id="kill-task-dialog-title">{"Kill Task?"}</DialogTitle>
        <DialogContent>
          {error && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {error}
            </Alert>
          )}
          <Typography>
            Are you sure you want to kill this task? This action cannot be undone.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setKillTaskDialogOpen(false)} color="primary">
            Cancel
          </Button>
          <Button
            onClick={handleConfirmKillTask}
            color="error" 
            variant="contained" 
            disabled={killTaskLoading}
            startIcon={killTaskLoading ? <CircularProgress size={20} color="inherit" /> : <PowerOffIcon />}
            autoFocus
          >
            {killTaskLoading ? 'Killing...' : 'Kill Task'}
          </Button>
        </DialogActions>
      </Dialog>

      <style>
        {`
          @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
          }
        `}
      </style>
    </Box>
  );
} 