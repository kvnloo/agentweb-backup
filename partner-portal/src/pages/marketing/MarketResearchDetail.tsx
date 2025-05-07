import React, { useState, useEffect } from 'react';
import { 
  Box, 
  Typography, 
  Button, 
  Container, 
  Paper,
  CircularProgress,
  Alert,
  AlertTitle,
  IconButton
} from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import { useAuth } from '../../contexts/AuthContext';
import { getMarketResearch } from '../../services/marketingService';
import { useNavigate, useParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';

interface MarketResearchTask {
  taskId: string;
  name: string;
  status: string;
  createdAt: string;
  execution?: {
    executionId: string;
    status: string;
    startedAt: string;
    completedAt?: string;
    result?: any;
  };
}

const MarketResearchDetail: React.FC = () => {
  const { token, isAuthenticated } = useAuth();
  const { taskId } = useParams<{ taskId: string }>();
  const navigate = useNavigate();
  
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [task, setTask] = useState<MarketResearchTask | null>(null);
  const [refreshInterval, setRefreshInterval] = useState<NodeJS.Timeout | null>(null);

  // Load task details when component mounts
  useEffect(() => {
    if (isAuthenticated() && token && taskId) {
      loadTaskDetails();
    }
  }, [isAuthenticated, token, taskId]);

  // Auto-refresh if task is running
  useEffect(() => {
    if (task && task.execution?.status === 'running' && token) {
      const interval = setInterval(() => {
        refreshTaskStatus();
      }, 5000); // Check every 5 seconds
      
      setRefreshInterval(interval);
      
      return () => {
        if (interval) clearInterval(interval);
      };
    } else if (refreshInterval) {
      clearInterval(refreshInterval);
      setRefreshInterval(null);
    }
  }, [task, token]);

  const loadTaskDetails = async () => {
    if (!token || !taskId) {
      setError('Authentication token or task ID is missing');
      return;
    }

    setIsLoading(true);
    setError(null);
    
    try {
      const taskData = await getMarketResearch(taskId, token);
      setTask(taskData);
    } catch (error) {
      console.error('Error loading task details:', error);
      setError('Failed to load research details');
    } finally {
      setIsLoading(false);
    }
  };

  const refreshTaskStatus = async () => {
    if (!token || !taskId) return;

    try {
      const taskData = await getMarketResearch(taskId, token);
      setTask(taskData);
    } catch (error) {
      console.error('Error refreshing task status:', error);
    }
  };

  const goBack = () => {
    navigate('/marketing/research');
  };

  const renderTaskResult = () => {
    if (!task || !task.execution) {
      return null;
    }

    const { execution } = task;
    
    if (execution.status === 'running') {
      return (
        <Box sx={{ textAlign: 'center', py: 4 }}>
          <CircularProgress size={40} />
          <Typography variant="h6" sx={{ mt: 2 }}>
            Research in progress...
          </Typography>
          <Typography variant="body2" color="text.secondary">
            This may take a few minutes to complete.
          </Typography>
        </Box>
      );
    }
    
    if (execution.status === 'failed') {
      return (
        <Alert severity="error" sx={{ my: 2 }}>
          <AlertTitle>Research task failed</AlertTitle>
          There was an error processing your research request.
        </Alert>
      );
    }
    
    if (execution.status === 'completed' && execution.result) {
      // Get content for markdown rendering
      const resultContent = typeof execution.result === 'string' 
        ? execution.result 
        : JSON.stringify(execution.result, null, 2);
      
      return (
        <Paper sx={{ p: 3, mb: 4, maxWidth: '100%', overflow: 'auto' }}>
          <Box sx={{ 
            p: 2,
            '& a': { color: 'primary.main' },
            '& img': { maxWidth: '100%' },
            '& h1, & h2, & h3, & h4, & h5, & h6': { 
              mt: 2, 
              mb: 1,
              fontWeight: 'bold'
            },
            '& ul, & ol': { pl: 3, my: 1 },
            '& code': { 
              bgcolor: 'grey.100', 
              px: 0.5, 
              borderRadius: 0.5,
              fontFamily: 'monospace'
            },
            '& pre': { 
              bgcolor: 'grey.100', 
              p: 1.5, 
              borderRadius: 1,
              overflow: 'auto',
              fontFamily: 'monospace'
            },
            '& blockquote': {
              borderLeft: '4px solid',
              borderColor: 'grey.300',
              pl: 2,
              py: 0.5,
              my: 1,
              color: 'text.secondary'
            }
          }}>
            <ReactMarkdown>
              {resultContent}
            </ReactMarkdown>
          </Box>
        </Paper>
      );
    }
    
    return (
      <Alert severity="warning" sx={{ my: 2 }}>
        <AlertTitle>No results available</AlertTitle>
        The research task has not yet produced any results.
      </Alert>
    );
  };

  return (
    <Box sx={{ bgcolor: 'background.default', minHeight: '100vh', py: 4 }}>
      <Container maxWidth="lg">
        <Box sx={{ display: 'flex', alignItems: 'center', mb: 3 }}>
          <IconButton 
            onClick={goBack} 
            sx={{ mr: 1 }}
            aria-label="Back to research list"
          >
            <ArrowBackIcon />
          </IconButton>
          <Typography variant="h4" component="h1" fontWeight="bold">
            {isLoading ? 'Loading...' : task?.name || 'Market Research Details'}
          </Typography>
        </Box>

        {!isAuthenticated() ? (
          <Paper sx={{ p: 4, textAlign: 'center', my: 4 }}>
            <Typography variant="h6" gutterBottom>
              Authentication Required
            </Typography>
            <Typography variant="body2">
              Please sign in to view research details.
            </Typography>
          </Paper>
        ) : (
          <>
            {error && (
              <Alert severity="error" sx={{ mb: 4 }}>
                <AlertTitle>Error</AlertTitle>
                {error}
                <Box sx={{ mt: 1 }}>
                  <Button 
                    size="small" 
                    onClick={loadTaskDetails} 
                    variant="outlined"
                  >
                    Retry
                  </Button>
                </Box>
              </Alert>
            )}
            
            {isLoading && !task ? (
              <Box sx={{ display: 'flex', justifyContent: 'center', my: 8 }}>
                <CircularProgress />
              </Box>
            ) : (
              <>
                {task && (
                  <Box sx={{ mb: 3 }}>
                    <Typography variant="body2" color="text.secondary">
                      Created: {new Date(task.createdAt).toLocaleString()}
                    </Typography>
                    {task.execution?.startedAt && (
                      <Typography variant="body2" color="text.secondary">
                        Started: {new Date(task.execution.startedAt).toLocaleString()}
                      </Typography>
                    )}
                    {task.execution?.completedAt && (
                      <Typography variant="body2" color="text.secondary">
                        Completed: {new Date(task.execution.completedAt).toLocaleString()}
                      </Typography>
                    )}
                  </Box>
                )}
                
                {renderTaskResult()}
                
                {task?.execution?.status === 'running' && (
                  <Box sx={{ textAlign: 'center', mt: 2 }}>
                    <Button 
                      onClick={refreshTaskStatus}
                      variant="outlined"
                    >
                      Check Progress
                    </Button>
                  </Box>
                )}
              </>
            )}
          </>
        )}
      </Container>
    </Box>
  );
};

export default MarketResearchDetail; 