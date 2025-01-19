import { useState, useEffect } from 'react';
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

interface Task {
  taskId: string;
  userId: string;
  name: string;
  prompt: string;
  status: string;
  createdAt: string;
}

export default function Dashboard() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [error, setError] = useState('');
  const { token } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    const fetchTasks = async () => {
      try {
        const response = await axios.get('http://localhost:3001/api/tasks', {
          headers: { Authorization: `Bearer ${token}` },
        });
        setTasks(response.data);
      } catch (error: any) {
        console.error('Error fetching tasks:', error);
        setError(error.response?.data?.message || 'Failed to fetch tasks');
      }
    };

    fetchTasks();
  }, [token]);

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
    <Box>
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
        {tasks.map((task) => (
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
                  mt: 'auto'
                }}>
                  <Chip
                    label={task.status}
                    color={getStatusColor(task.status) as any}
                    size="small"
                    sx={{ fontWeight: 500 }}
                  />
                  <Typography 
                    variant="caption" 
                    color="text.secondary"
                    sx={{ fontWeight: 500 }}
                  >
                    {new Date(task.createdAt).toLocaleDateString()}
                  </Typography>
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
        {tasks.length === 0 && (
          <Grid item xs={12}>
            <Paper
              sx={{
                textAlign: 'center',
                py: 6,
                px: 3,
                bgcolor: 'background.paper',
                borderRadius: '16px',
                border: '1px dashed',
                borderColor: 'grey.300'
              }}
            >
              <Typography 
                variant="h6" 
                color="text.secondary"
                sx={{ mb: 2 }}
              >
                No tasks found
              </Typography>
              <Typography 
                variant="body2" 
                color="text.secondary"
                sx={{ mb: 3 }}
              >
                Create your first task to get started with web automation
              </Typography>
              <Button
                variant="contained"
                size="large"
                onClick={() => navigate('/tasks/create')}
                startIcon={<AddIcon />}
              >
                Create Your First Task
              </Button>
            </Paper>
          </Grid>
        )}
      </Grid>
    </Box>
  );
} 