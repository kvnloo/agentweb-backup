import React, { useState, useEffect } from 'react';
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
  Divider
} from '@mui/material';
import {
  Refresh as RefreshIcon,
  ArrowBack as ArrowBackIcon,
  PlayArrow as PlayArrowIcon,
  Stop as StopIcon,
  CheckCircle as CheckCircleIcon,
  Error as ErrorIcon,
  Pending as PendingIcon,
  Timeline as TimelineIcon
} from '@mui/icons-material';
import { useAuth } from '../contexts/AuthContext';
import { buildApiUrl } from '../config';
import { formatDistanceToNow, intervalToDuration } from 'date-fns';

interface WorkflowTask {
  taskId: string;
  status: string;
  order: number;
  dependsOn?: string[];
  error?: string;
  completedAt?: string;
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
        const baseUrl = import.meta.env.VITE_API_URL || '';

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
      const baseUrl = import.meta.env.VITE_API_URL || '';
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
              <TableCell>Error</TableCell>
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
                        title={`Task ${task.taskId}: ${task.status}`}
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
                  {execution.error && (
                    <Tooltip title={execution.error}>
                      <ErrorIcon color="error" />
                    </Tooltip>
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