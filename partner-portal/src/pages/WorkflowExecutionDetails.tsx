import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Box,
  Paper,
  Typography,
  Button,
  IconButton,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Chip,
  CircularProgress,
  Alert,
  Link,
  Grid,
  Divider,
  Tooltip,
  Collapse
} from '@mui/material';
import {
  ArrowBack as ArrowBackIcon,
  CheckCircle as CheckCircleIcon,
  Error as ErrorIcon,
  Pending as PendingIcon,
  Timeline as TimelineIcon,
  KeyboardArrowDown as KeyboardArrowDownIcon,
  KeyboardArrowUp as KeyboardArrowUpIcon,
  ContentCopy as ContentCopyIcon,
  Autorenew as AutorenewIcon
} from '@mui/icons-material';
import { useAuth } from '../contexts/AuthContext';
import { formatDistanceToNow, intervalToDuration } from 'date-fns';
import { API_URL } from '../config';

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
  details_gif?: string;
  browser_use_log?: string;
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

// Add CollapsibleText component
const CollapsibleText = ({ text, maxLength = 150 }: { text: string, maxLength?: number }) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const [isCopied, setIsCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(text);
    setIsCopied(true);
    setTimeout(() => setIsCopied(false), 2000);
  };

  if (!text) return null;
  if (text.length <= maxLength) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Typography>{text}</Typography>
        <Tooltip title={isCopied ? "Copied!" : "Copy to clipboard"}>
          <IconButton size="small" onClick={handleCopy}>
            <ContentCopyIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Box>
    );
  }

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Typography>
          {isExpanded ? text : `${text.slice(0, maxLength)}...`}
        </Typography>
        <Box sx={{ display: 'flex', gap: 0.5 }}>
          <Tooltip title={isExpanded ? "Show less" : "Show more"}>
            <IconButton size="small" onClick={() => setIsExpanded(!isExpanded)}>
              {isExpanded ? <KeyboardArrowUpIcon /> : <KeyboardArrowDownIcon />}
            </IconButton>
          </Tooltip>
          <Tooltip title={isCopied ? "Copied!" : "Copy to clipboard"}>
            <IconButton size="small" onClick={handleCopy}>
              <ContentCopyIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Box>
      </Box>
    </Box>
  );
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
  const [expandedTask, setExpandedTask] = useState<string | null>(null);

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
            return task;
          }

          try {
            console.log('Fetching task execution details for:', task.executionId);
            const taskExecutionResponse = await fetch(`${baseUrl}/api/task-executions/${task.executionId}`, {
              headers: {
                Authorization: `Bearer ${token}`,
              },
            });

            if (taskExecutionResponse.ok) {
              const taskExecutionData = await taskExecutionResponse.json();
              console.log('Task execution data received:', taskExecutionData);
              return {
                ...task,
                prompt: taskExecutionData.prompt,
                details_gif: taskExecutionData.details_gif,
                browser_use_log: taskExecutionData.browser_use_log,
                result: taskExecutionData.result,
                error: taskExecutionData.error,
                completedAt: taskExecutionData.completedAt
              };
            } else {
              console.error('Failed to fetch task execution:', await taskExecutionResponse.text());
            }
          } catch (error) {
            console.error(`Error fetching task execution details for task ${task.taskId}:`, error);
          }
          return task;
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
    
    if (execution && ['running', 'pending'].includes(execution.status.toLowerCase())) {
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
  }, [execution?.status, fetchData]);

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

  const getDuration = (startTime: string, completedAt?: string) => {
    if (!completedAt) return 'In progress';
    
    const start = new Date(startTime);
    const end = new Date(completedAt);
    const duration = intervalToDuration({ start, end });
    
    const parts = [];
    if (duration.hours) parts.push(`${duration.hours}h`);
    if (duration.minutes) parts.push(`${duration.minutes}m`);
    if (duration.seconds) parts.push(`${duration.seconds}s`);
    
    return parts.join(' ') || '< 1s';
  };

  const handleTaskExpand = (taskId: string) => {
    setExpandedTask(expandedTask === taskId ? null : taskId);
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
              <strong>Duration:</strong> {execution ? getDuration(execution.startTime, execution.completedAt) : '-'}
            </Typography>
          </Grid>
        </Grid>
      </Paper>

      {/* Tasks Section */}
      <Paper sx={{ p: 2 }}>
        <Typography variant="h6" gutterBottom>
          Tasks
        </Typography>
        {execution?.tasks.map((task, index) => (
          <Box key={task.taskId} sx={{ mb: 3 }}>
            <Paper sx={{ p: 2, mb: 2 }}>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
                <Typography variant="h6">
                  Task {task.order + 1}
                </Typography>
                <Chip
                  icon={getStatusIcon(task.status)}
                  label={task.status}
                  color={getStatusColor(task.status)}
                />
              </Box>

              {/* Task Details */}
              <Grid container spacing={2}>
                {/* Prompt Section */}
                {task.prompt && (
                  <Grid item xs={12}>
                    <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                      Prompt
                    </Typography>
                    <Paper sx={{ p: 2, bgcolor: 'background.default' }}>
                      <CollapsibleText text={task.prompt} />
                    </Paper>
                  </Grid>
                )}

                {/* Result/Error Section */}
                {(task.result || task.error) && (
                  <Grid item xs={12}>
                    <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                      {task.status === 'failed' ? 'Error' : 'Result'}
                    </Typography>
                    <Paper sx={{ p: 2, bgcolor: 'background.default' }}>
                      <CollapsibleText text={task.status === 'failed' ? (task.error || 'No error details available') : (task.result || 'No result available')} />
                    </Paper>
                  </Grid>
                )}

                {/* Execution GIF Section */}
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

                {/* Browser Log Section */}
                {task.browser_use_log && (
                  <Grid item xs={12}>
                    <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                      Browser Log
                    </Typography>
                    <Paper sx={{ p: 2, bgcolor: 'background.default' }}>
                      <iframe
                        src={`${API_URL}/api/tasks/${task.taskId}/executions/${task.executionId}/log`}
                        style={{
                          width: '100%',
                          height: '400px',
                          border: 'none',
                          backgroundColor: 'white'
                        }}
                        title="Browser Log"
                      />
                    </Paper>
                  </Grid>
                )}

                {/* Task Execution Details Link */}
                {task.executionId && (
                  <Grid item xs={12}>
                    <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
                      <Link
                        component="button"
                        variant="body2"
                        onClick={() => navigate(`/tasks/${task.taskId}/executions/${task.executionId}`)}
                      >
                        View Full Task Details
                      </Link>
                    </Box>
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