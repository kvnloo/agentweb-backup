import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
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
} from '@mui/material';
import axios from 'axios';
import { useAuth } from '../contexts/AuthContext';

interface Task {
  taskId: string;
  userId: string;
  name: string;
  prompt: string;
  status: string;  // Task status: active, archived, etc.
  createdAt: string;
  summary?: string;
  error?: string;
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
}

export default function TaskDetails() {
  const [task, setTask] = useState<Task | null>(null);
  const [executions, setExecutions] = useState<TaskExecution[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const { taskId } = useParams<{ taskId: string }>();
  const { token } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    const fetchTaskAndExecutions = async () => {
      try {
        const [taskResponse, executionsResponse] = await Promise.all([
          axios.get(`http://localhost:3001/api/tasks/${taskId}`, {
            headers: { Authorization: `Bearer ${token}` },
          }),
          axios.get(`http://localhost:3001/api/tasks/${taskId}/executions`, {
            headers: { Authorization: `Bearer ${token}` },
          })
        ]);
        
        setTask(taskResponse.data);
        setExecutions(executionsResponse.data);
      } catch (error: any) {
        console.error('Error fetching task details:', error);
        setError(error.response?.data?.message || 'Failed to fetch task details');
      } finally {
        setLoading(false);
      }
    };

    fetchTaskAndExecutions();

    // Set up polling for executions
    const intervalId = setInterval(() => {
      if (taskId) {
        axios.get(`http://localhost:3001/api/tasks/${taskId}/executions`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        .then(response => setExecutions(response.data))
        .catch(error => console.error('Error polling executions:', error));
      }
    }, 5000);

    return () => clearInterval(intervalId);
  }, [taskId, token]);

  const handleDelete = async () => {
    try {
      await axios.delete(`http://localhost:3001/api/tasks/${taskId}`, {
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
        `http://localhost:3001/api/tasks/${taskId}/execute`,
        {},
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      // Refresh executions list
      const response = await axios.get(`http://localhost:3001/api/tasks/${taskId}/executions`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      setExecutions(response.data);
    } catch (error: any) {
      console.error('Error running task:', error);
      setError(error.response?.data?.message || 'Failed to run task');
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

  return (
    <Container maxWidth="md">
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
          </Box>
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
        </Box>

        <Grid container spacing={3}>
          <Grid item xs={12}>
            <Typography variant="h6" gutterBottom>
              Task Prompt
            </Typography>
            <Typography variant="body1" paragraph>
              {task.prompt}
            </Typography>
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
                    <TableCell>Status</TableCell>
                    <TableCell>Started</TableCell>
                    <TableCell>Completed</TableCell>
                    <TableCell>Result</TableCell>
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
                        {execution.error ? (
                          <Typography color="error" variant="body2">
                            {execution.error}
                          </Typography>
                        ) : execution.result ? (
                          <Typography variant="body2">
                            {execution.result}
                          </Typography>
                        ) : '-'}
                      </TableCell>
                    </TableRow>
                  ))}
                  {executions.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={4} align="center">
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
      </Paper>
    </Container>
  );
} 