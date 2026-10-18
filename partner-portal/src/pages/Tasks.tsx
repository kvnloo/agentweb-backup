import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Container,
  Typography,
  Button,
  Grid,
  Card,
  CardContent,
  CardActions,
  Box,
  Chip,
  Paper,
} from '@mui/material';
import { Add as AddIcon } from '@mui/icons-material';
import axios from 'axios';
import { useAuth } from '../contexts/AuthContext';
import { API_URL } from '../config';
import { EmptyState, ErrorState } from '../components/StatusState';

interface Task {
  taskId: string;
  userId: string;
  name: string;
  prompt: string;
  status: string;
  createdAt: string;
  latestExecution?: {
    status: string;
    startTime: string;
    completedAt?: string;
    error?: string;
  };
  scheduleCount: number;
  subscriberCount: number;
  knowledgeBaseSize?: number;
}

export default function Tasks() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [fetchError, setFetchError] = useState(false);
  const { token } = useAuth();
  const navigate = useNavigate();

  const fetchTasks = useCallback(async () => {
    try {
      const response = await axios.get(`${API_URL}/api/tasks`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      setTasks(response.data);
      setFetchError(false);
    } catch (error: any) {
      console.error('Error fetching tasks:', error);
      setFetchError(true);
    } finally {
      setLoaded(true);
    }
  }, [token]);

  useEffect(() => {
    // Initial fetch
    fetchTasks();

    // Set up polling interval (every 10 seconds)
    const intervalId = setInterval(fetchTasks, 10000);

    // Cleanup interval on component unmount
    return () => clearInterval(intervalId);
  }, [fetchTasks]);

  // Filter out archived tasks
  const activeTasks = tasks.filter(task => task.status !== 'archived');

  const getStatusColor = (status: string) => {
    switch (status.toLowerCase()) {
      case 'completed':
        return 'success';
      case 'failed':
        return 'error';
      case 'running':
        return 'info';
      default:
        return 'default';
    }
  };

  return (
    <Container maxWidth="lg" sx={{ py: { xs: 3, sm: 4 }, px: { xs: 2, sm: 3 } }}>
      <Paper 
        elevation={0} 
        sx={{ 
          p: { xs: 2, sm: 3 }, 
          mb: 3, 
          bgcolor: 'primary.main', 
          color: 'white',
          borderRadius: '16px'
        }}
      >
        <Box sx={{ 
          display: 'flex', 
          justifyContent: 'space-between', 
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 2
        }}>
          <Box>
            <Typography 
              variant="h4" 
              component="h1" 
              gutterBottom
              sx={{ 
                color: 'white',
                fontSize: { xs: '1.75rem', sm: '2rem' }
              }}
            >
              My Tasks
            </Typography>
            <Typography 
              variant="body1" 
              sx={{ 
                color: 'rgba(255, 255, 255, 0.9)',
                maxWidth: '600px'
              }}
            >
              Create and manage your web automation tasks. Our AI agents will handle your requests efficiently.
            </Typography>
          </Box>
          <Button
            variant="contained"
            color="inherit"
            size="large"
            onClick={() => navigate('/tasks/create')}
            startIcon={<AddIcon />}
            sx={{ 
              color: 'primary.main',
              bgcolor: 'white',
              '&:hover': {
                bgcolor: 'rgba(255, 255, 255, 0.9)'
              }
            }}
          >
            Create Task
          </Button>
        </Box>
      </Paper>

      <Grid container spacing={3}>
        {activeTasks.map((task) => (
          <Grid item xs={12} sm={6} md={4} key={task.taskId}>
            <Card sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
              <CardContent sx={{ flexGrow: 1 }}>
                <Typography 
                  variant="h6" 
                  component="h2" 
                  gutterBottom
                  sx={{ 
                    fontSize: '1.125rem',
                    fontWeight: 600,
                    color: 'text.primary'
                  }}
                >
                  {task.name}
                </Typography>
                <Typography
                  variant="body2"
                  color="text.secondary"
                  sx={{ 
                    mb: 2,
                    display: '-webkit-box',
                    WebkitLineClamp: 3,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    minHeight: '4.5em'
                  }}
                >
                  {task.prompt}
                </Typography>
                <Box sx={{ 
                  display: 'flex', 
                  justifyContent: 'space-between', 
                  alignItems: 'center',
                  mt: 'auto',
                  flexWrap: 'wrap',
                  gap: 1
                }}>
                  <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                    <Chip
                      label={`Task: ${task.status}`}
                      color={getStatusColor(task.status) as any}
                      size="small"
                      sx={{ fontWeight: 500 }}
                    />
                    {task.latestExecution && (
                      <Chip
                        label={`Latest Run: ${task.latestExecution.status}`}
                        color={getStatusColor(task.latestExecution.status) as any}
                        size="small"
                        sx={{ fontWeight: 500 }}
                      />
                    )}
                  </Box>
                  <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
                    <Chip
                      label={`${task.scheduleCount} Schedule${task.scheduleCount !== 1 ? 's' : ''}`}
                      size="small"
                      variant="outlined"
                    />
                    <Chip
                      label={`${task.subscriberCount} Subscriber${task.subscriberCount !== 1 ? 's' : ''}`}
                      size="small"
                      variant="outlined"
                    />
                    {task.knowledgeBaseSize && task.knowledgeBaseSize > 0 && (
                      <Chip
                        label={`Knowledge: ${(task.knowledgeBaseSize / 1024).toFixed(1)} KB`}
                        size="small"
                        variant="outlined"
                      />
                    )}
                    <Typography 
                      variant="caption" 
                      color="text.secondary"
                      sx={{ fontWeight: 500 }}
                    >
                      {new Date(task.createdAt).toLocaleDateString()}
                    </Typography>
                  </Box>
                </Box>
              </CardContent>
              <CardActions sx={{ p: 2, pt: 0 }}>
                <Button
                  fullWidth
                  variant="outlined"
                  size="large"
                  onClick={() => navigate(`/tasks/${task.taskId}`)}
                  sx={{ mt: 1 }}
                >
                  View Details
                </Button>
              </CardActions>
            </Card>
          </Grid>
        ))}
        {fetchError && activeTasks.length === 0 && (
          <Grid item xs={12}>
            <ErrorState title="We couldn't load your tasks" onRetry={fetchTasks} />
          </Grid>
        )}
        {loaded && !fetchError && activeTasks.length === 0 && (
          <Grid item xs={12}>
            <EmptyState
              title="No active tasks found"
              description={tasks.length > 0
                ? `You have ${tasks.length} archived task${tasks.length > 1 ? 's' : ''}. Active tasks are shown here.`
                : 'Create your first task to get started with web automation. Archived tasks are not shown here.'}
              action={{
                label: tasks.length > 0 ? 'Create New Task' : 'Create Your First Task',
                onClick: () => navigate('/tasks/create'),
                icon: <AddIcon />,
              }}
            />
          </Grid>
        )}
      </Grid>
    </Container>
  );
} 