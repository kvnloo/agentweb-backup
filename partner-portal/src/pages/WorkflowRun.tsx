import { useState, useEffect } from 'react';
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
  Tooltip,
  Link
} from '@mui/material';
import {
  Refresh as RefreshIcon,
  ArrowBack as ArrowBackIcon,
  PlayArrow as PlayArrowIcon,
  CheckCircle as CheckCircleIcon,
  Error as ErrorIcon,
  Pending as PendingIcon,
  Timeline as TimelineIcon,
  KeyboardArrowDown as KeyboardArrowDownIcon,
  KeyboardArrowUp as KeyboardArrowUpIcon,
  ContentCopy as ContentCopyIcon
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

export default function WorkflowRun() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { token } = useAuth();
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [executions, setExecutions] = useState<WorkflowExecution[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  // Effect for data fetching
  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true);
        setError(null);
        const baseUrl = API_URL;

        // Fetch workflow details
        const workflowResponse = await fetch(`${baseUrl}/api/workflows/${id}`, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });

        if (!workflowResponse.ok) {
          throw new Error('Failed to fetch workflow details');
        }

        const workflowData = await workflowResponse.json();
        setWorkflow(workflowData);

        // Fetch workflow executions
        const executionsResponse = await fetch(`${baseUrl}/api/workflows/${id}/executions`, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });

        if (!executionsResponse.ok) {
          throw new Error('Failed to fetch workflow executions');
        }

        const executionsData = await executionsResponse.json();
        
        // Only update if data has changed
        const hasChanged = JSON.stringify(executionsData) !== JSON.stringify(executions);
        if (hasChanged) {
          setExecutions(executionsData);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'An error occurred');
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [id, token, refreshKey]);

  // Separate effect for polling
  useEffect(() => {
    const hasActiveExecution = executions.some(
      exec => ['pending', 'running'].includes(exec.status)
    );

    if (!hasActiveExecution) return;

    const interval = setInterval(() => {
      setRefreshKey(prev => prev + 1);
    }, 5000);

    return () => clearInterval(interval);
  }, [executions]);

  const handleRunWorkflow = async () => {
    try {
      setError(null);
      const baseUrl = API_URL;
      const response = await fetch(`${baseUrl}/api/workflows/${id}/run`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error('Failed to start workflow execution');
      }

      // Trigger immediate refresh
      setRefreshKey(prev => prev + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start workflow');
    }
  };

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
        return <PendingIcon />;  // Default icon instead of null
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
          <IconButton onClick={() => navigate('/workflows')}>
            <ArrowBackIcon />
          </IconButton>
          <Typography variant="h5">
            {workflow?.name || 'Workflow Run'}
          </Typography>
          <Box sx={{ flexGrow: 1 }} />
          <Button
            variant="contained"
            startIcon={<PlayArrowIcon />}
            onClick={handleRunWorkflow}
          >
            Run Workflow
          </Button>
          <IconButton onClick={() => setRefreshKey(prev => prev + 1)}>
            <RefreshIcon />
          </IconButton>
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

      {/* Executions Table */}
      <TableContainer component={Paper}>
        <Table>
          <TableHead>
            <TableRow>
              <TableCell>Execution ID</TableCell>
              <TableCell>Status</TableCell>
              <TableCell>Started</TableCell>
              <TableCell>Duration</TableCell>
              <TableCell>Tasks</TableCell>
              <TableCell>Result</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {executions.map((execution) => (
              <TableRow key={execution.executionId}>
                <TableCell>{execution.executionId}</TableCell>
                <TableCell>
                  <Chip
                    icon={getStatusIcon(execution.status)}
                    label={execution.status}
                    color={getStatusColor(execution.status)}
                    size="small"
                  />
                </TableCell>
                <TableCell>
                  {formatDistanceToNow(new Date(execution.startTime), { addSuffix: true })}
                </TableCell>
                <TableCell>
                  {getDuration(execution.startTime, execution.completedAt)}
                </TableCell>
                <TableCell>
                  <Box sx={{ display: 'flex', gap: 1 }}>
                    {execution.tasks.map((task) => (
                      <Tooltip
                        key={task.taskId}
                        title={
                          <Box>
                            <Typography>Task {task.taskId}</Typography>
                            <Typography>Status: {task.status}</Typography>
                            {task.result && <Typography>Result: {task.result}</Typography>}
                            {task.error && <Typography>Error: {task.error}</Typography>}
                          </Box>
                        }
                      >
                        <Chip
                          size="small"
                          label={task.order + 1}
                          color={getStatusColor(task.status)}
                        />
                      </Tooltip>
                    ))}
                  </Box>
                </TableCell>
                <TableCell>
                  {execution.status === 'failed' ? (
                    <Box>
                      <CollapsibleText text={execution.error || 'No error details available'} />
                      <Link
                        component="button"
                        variant="body2"
                        onClick={() => navigate(`/workflows/${id}/executions/${execution.executionId}`)}
                        sx={{ display: 'block', mt: 1 }}
                      >
                        View Full Details
                      </Link>
                    </Box>
                  ) : execution.status === 'completed' ? (
                    <Box>
                      <CollapsibleText text={execution.result || 'No result available'} />
                      <Link
                        component="button"
                        variant="body2"
                        onClick={() => navigate(`/workflows/${id}/executions/${execution.executionId}`)}
                        sx={{ display: 'block', mt: 1 }}
                      >
                        View Full Details
                      </Link>
                    </Box>
                  ) : (
                    <Box>
                      <Typography variant="body2" color="text.secondary">
                        {execution.status === 'running' ? 'Execution in progress...' : ''}
                      </Typography>
                      <Link
                        component="button"
                        variant="body2"
                        onClick={() => navigate(`/workflows/${id}/executions/${execution.executionId}`)}
                        sx={{ display: 'block', mt: 1 }}
                      >
                        View Full Details
                      </Link>
                    </Box>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {executions.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} align="center">
                  No executions found
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </TableContainer>
    </Box>
  );
} 