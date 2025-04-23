import React, { useState, useEffect } from 'react';
import { 
  Box, 
  Typography, 
  Button, 
  Container, 
  Paper, 
  TextField,
  Grid,
  Card,
  CardContent,
  CircularProgress,
  Divider,
  Alert,
  AlertTitle,
  IconButton,
  Snackbar,
  Link
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import RefreshIcon from '@mui/icons-material/Refresh';
import SaveIcon from '@mui/icons-material/Save';
import CloseIcon from '@mui/icons-material/Close';
import { useAuth } from '../../contexts/AuthContext';
import { 
  createMarketResearch, 
  getMarketResearch, 
  getAllMarketResearch 
} from '../../services/marketingService';
import { Link as RouterLink } from 'react-router-dom';
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

const MarketResearch: React.FC = () => {
  // Get auth context
  const { user, token, isAuthenticated } = useAuth();
  
  // Research form state
  const [target, setTarget] = useState('');
  const [industry, setIndustry] = useState('');
  const [competitors, setCompetitors] = useState('');
  const [audience, setAudience] = useState('');
  const [customPrompt, setCustomPrompt] = useState('');
  const [useCustomPrompt, setUseCustomPrompt] = useState(false);
  
  // Task state
  const [isLoading, setIsLoading] = useState(false);
  const [currentTask, setCurrentTask] = useState<MarketResearchTask | null>(null);
  const [recentTasks, setRecentTasks] = useState<MarketResearchTask[]>([]);
  const [refreshInterval, setRefreshInterval] = useState<NodeJS.Timeout | null>(null);
  
  // Error state
  const [error, setError] = useState<string | null>(null);
  
  // UI state
  const [snackbar, setSnackbar] = useState({ open: false, message: '', severity: 'info' as 'info' | 'error' | 'success' });

  // Log authentication state on mount
  useEffect(() => {
    console.log('Auth state:', { 
      isAuthenticated: isAuthenticated(), 
      hasToken: !!token,
      tokenFirstChars: token ? token.substring(0, 10) + '...' : 'none' 
    });
  }, [isAuthenticated, token]);

  // Load recent tasks when component mounts and user is authenticated
  useEffect(() => {
    if (isAuthenticated() && token) {
      loadRecentTasks();
    }
  }, [isAuthenticated, token]);

  // Auto-refresh current task status
  useEffect(() => {
    if (currentTask && currentTask.execution?.status === 'running' && token) {
      const interval = setInterval(() => {
        refreshTaskStatus(currentTask.taskId);
      }, 5000); // Check every 5 seconds
      
      setRefreshInterval(interval);
      
      return () => {
        if (interval) clearInterval(interval);
      };
    } else if (refreshInterval) {
      clearInterval(refreshInterval);
      setRefreshInterval(null);
    }
  }, [currentTask, token]);

  const loadRecentTasks = async () => {
    if (!token) {
      console.error('Cannot load tasks: No authentication token available');
      setError('Authentication token is missing. Please try logging out and logging back in.');
      return;
    }

    setIsLoading(true);
    setError(null);
    
    try {
      console.log('Loading recent tasks...');
      const tasks = await getAllMarketResearch(token);
      console.log(`Loaded ${tasks?.length || 0} tasks`);
      setRecentTasks(tasks || []);
    } catch (error) {
      console.error('Error loading tasks:', error);
      
      let errorMessage = 'Failed to load recent research tasks';
      
      if (error instanceof Error) {
        if (error.message.includes('401') || error.message.includes('auth')) {
          errorMessage = 'Authentication error. Please try logging out and logging back in.';
        } else if (error.message.includes('404')) {
          errorMessage = 'API endpoint not found. Please check server configuration.';
        } else {
          errorMessage += `: ${error.message}`;
        }
      }
      
      setError(errorMessage);
      
      setSnackbar({
        open: true,
        message: errorMessage,
        severity: 'error'
      });
    } finally {
      setIsLoading(false);
    }
  };

  const refreshTaskStatus = async (taskId: string) => {
    if (!token) {
      console.error('Cannot refresh task: No authentication token available');
      return;
    }

    try {
      const task = await getMarketResearch(taskId, token);
      setCurrentTask(task);
      
      // If task is completed, refresh the recent tasks list
      if (task.execution?.status === 'completed' && refreshInterval) {
        clearInterval(refreshInterval);
        setRefreshInterval(null);
        loadRecentTasks();
      }
    } catch (error) {
      console.error('Error refreshing task status:', error);
      // Don't show error for refresh failures to avoid spamming the user
    }
  };

  const handleSubmitResearch = async () => {
    if (!token) {
      setSnackbar({
        open: true,
        message: 'Authentication error. Please try logging out and logging back in.',
        severity: 'error'
      });
      return;
    }

    if (!target && !customPrompt) {
      setSnackbar({
        open: true,
        message: 'Please provide either a research target or a custom prompt',
        severity: 'error'
      });
      return;
    }

    setIsLoading(true);
    setError(null);
    
    try {
      const competitorsArray = competitors.split(',').map(c => c.trim()).filter(Boolean);
      
      const params = {
        target,
        industry,
        competitors: competitorsArray,
        audience,
        prompt: useCustomPrompt ? customPrompt : undefined
      };
      
      const result = await createMarketResearch(params, token);
      
      if (result && result.task) {
        setCurrentTask(result.task);
        
        // If task is executed, start monitoring
        if (result.execution) {
          // Immediately load task details to get initial status
          refreshTaskStatus(result.task.taskId);
        }
        
        setSnackbar({
          open: true,
          message: 'Market research task started successfully',
          severity: 'success'
        });
      }
    } catch (error) {
      console.error('Error creating market research task:', error);
      
      let errorMessage = 'Failed to create market research task';
      
      if (error instanceof Error) {
        errorMessage += `: ${error.message}`;
      }
      
      setError(errorMessage);
      
      setSnackbar({
        open: true,
        message: errorMessage,
        severity: 'error'
      });
    } finally {
      setIsLoading(false);
    }
  };

  const loadTask = async (taskId: string) => {
    if (!token) {
      console.error('Cannot load task: No authentication token available');
      return;
    }

    setIsLoading(true);
    setError(null);
    
    try {
      const task = await getMarketResearch(taskId, token);
      setCurrentTask(task);
    } catch (error) {
      console.error('Error loading task:', error);
      
      let errorMessage = 'Failed to load task details';
      
      if (error instanceof Error) {
        errorMessage += `: ${error.message}`;
      }
      
      setError(errorMessage);
      
      setSnackbar({
        open: true,
        message: errorMessage,
        severity: 'error'
      });
    } finally {
      setIsLoading(false);
    }
  };

  const renderTaskResult = () => {
    if (!currentTask || !currentTask.execution) {
      return null;
    }

    const { execution } = currentTask;
    
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
        <Box>
          <Box sx={{ mb: 2 }}>
            <Typography variant="h5" gutterBottom>
              Research Results for {currentTask.name}
            </Typography>
          </Box>
          
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
        </Box>
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
        <Typography variant="h4" component="h1" fontWeight="bold" gutterBottom>
          Market Research
        </Typography>
        <Typography variant="body1" color="text.secondary" paragraph>
          Use AI to analyze markets, competitors, and discover opportunities for your business.
        </Typography>

        {!isAuthenticated() ? (
          <Paper sx={{ p: 4, textAlign: 'center', my: 4 }}>
            <Typography variant="h6" gutterBottom>
              Authentication Required
            </Typography>
            <Typography variant="body2" paragraph>
              Please <Link component={RouterLink} to="/login">sign in</Link> to use the Market Research tools.
            </Typography>
          </Paper>
        ) : (
          <>
            {error && (
              <Alert severity="error" sx={{ mb: 4 }}>
                <AlertTitle>Error</AlertTitle>
                {error}
                {error.includes('Authentication') && (
                  <Box sx={{ mt: 1 }}>
                    <Button 
                      component={RouterLink} 
                      to="/login" 
                      size="small" 
                      variant="outlined" 
                      color="error"
                      sx={{ mr: 1 }}
                    >
                      Sign in again
                    </Button>
                    <Button 
                      size="small" 
                      onClick={loadRecentTasks} 
                      startIcon={<RefreshIcon />}
                    >
                      Retry
                    </Button>
                  </Box>
                )}
              </Alert>
            )}
            
            <Paper sx={{ p: 3, mb: 4 }}>
              <Typography variant="h6" gutterBottom>
                Research Parameters
              </Typography>
              <Grid container spacing={2}>
                <Grid item xs={12} md={6}>
                  <TextField
                    fullWidth
                    label="Research Target"
                    placeholder="e.g., AI Marketing Tools"
                    variant="outlined"
                    value={target}
                    onChange={(e) => setTarget(e.target.value)}
                    disabled={isLoading || useCustomPrompt}
                    required={!useCustomPrompt}
                    margin="normal"
                  />
                </Grid>
                <Grid item xs={12} md={6}>
                  <TextField
                    fullWidth
                    label="Industry"
                    placeholder="e.g., Marketing Technology"
                    variant="outlined"
                    value={industry}
                    onChange={(e) => setIndustry(e.target.value)}
                    disabled={isLoading || useCustomPrompt}
                    margin="normal"
                  />
                </Grid>
                <Grid item xs={12} md={6}>
                  <TextField
                    fullWidth
                    label="Competitors"
                    placeholder="e.g., Competitor A, Competitor B"
                    variant="outlined"
                    value={competitors}
                    onChange={(e) => setCompetitors(e.target.value)}
                    disabled={isLoading || useCustomPrompt}
                    margin="normal"
                  />
                </Grid>
                <Grid item xs={12} md={6}>
                  <TextField
                    fullWidth
                    label="Target Audience"
                    placeholder="e.g., Small business owners"
                    variant="outlined"
                    value={audience}
                    onChange={(e) => setAudience(e.target.value)}
                    disabled={isLoading || useCustomPrompt}
                    margin="normal"
                  />
                </Grid>
                <Grid item xs={12}>
                  <Button
                    color="primary"
                    onClick={() => setUseCustomPrompt(!useCustomPrompt)}
                    disabled={isLoading}
                    sx={{ mb: 1 }}
                  >
                    {useCustomPrompt ? "Use Structured Form" : "Use Custom Prompt"}
                  </Button>
                  
                  {useCustomPrompt && (
                    <TextField
                      fullWidth
                      label="Custom Research Prompt"
                      placeholder="Enter your detailed research request here..."
                      variant="outlined"
                      multiline
                      rows={4}
                      value={customPrompt}
                      onChange={(e) => setCustomPrompt(e.target.value)}
                      disabled={isLoading}
                      required
                      margin="normal"
                    />
                  )}
                </Grid>
                <Grid item xs={12}>
                  <Button 
                    fullWidth
                    variant="contained" 
                    color="primary"
                    size="large"
                    startIcon={<SearchIcon />}
                    onClick={handleSubmitResearch}
                    disabled={isLoading || (!target && !customPrompt)}
                    sx={{ height: '56px', mt: 2 }}
                  >
                    {isLoading ? <CircularProgress size={24} color="inherit" /> : 'Start Research'}
                  </Button>
                </Grid>
              </Grid>
            </Paper>

            {currentTask && (
              <Paper sx={{ p: 3, mb: 4 }}>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
                  <Typography variant="h6">Current Research Task</Typography>
                  <Button 
                    startIcon={<RefreshIcon />}
                    onClick={() => refreshTaskStatus(currentTask.taskId)}
                    disabled={isLoading}
                  >
                    Refresh
                  </Button>
                </Box>
                {renderTaskResult()}
              </Paper>
            )}

            {!isLoading && (
              <Box sx={{ display: 'flex', justifyContent: 'center', mb: 4 }}>
                <Button 
                  onClick={loadRecentTasks} 
                  startIcon={<RefreshIcon />}
                  disabled={isLoading}
                >
                  Refresh Task List
                </Button>
              </Box>
            )}

            {isLoading && !recentTasks.length && (
              <Box sx={{ display: 'flex', justifyContent: 'center', my: 8 }}>
                <CircularProgress />
              </Box>
            )}

            {recentTasks.length > 0 && (
              <Paper sx={{ p: 3 }}>
                <Typography variant="h6" gutterBottom>
                  Recent Research Tasks
                </Typography>
                <Grid container spacing={2}>
                  {recentTasks.map((task) => (
                    <Grid item xs={12} key={task.taskId}>
                      <Card variant="outlined">
                        <CardContent>
                          <Grid container spacing={2}>
                            <Grid item xs={10}>
                              <Typography variant="subtitle1">{task.name}</Typography>
                              <Typography variant="body2" color="text.secondary">
                                Created: {new Date(task.createdAt).toLocaleString()}
                              </Typography>
                            </Grid>
                            <Grid item xs={2} sx={{ display: 'flex', justifyContent: 'flex-end' }}>
                              <Button 
                                size="small" 
                                onClick={() => loadTask(task.taskId)}
                                disabled={isLoading}
                              >
                                View
                              </Button>
                            </Grid>
                          </Grid>
                        </CardContent>
                      </Card>
                    </Grid>
                  ))}
                </Grid>
              </Paper>
            )}

            {!isLoading && !recentTasks.length && !error && (
              <Paper sx={{ p: 4, textAlign: 'center', my: 4 }}>
                <Typography variant="h6" color="text.secondary" gutterBottom>
                  No research tasks found
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  Start by creating a new market research task above.
                </Typography>
              </Paper>
            )}
          </>
        )}
      </Container>
      
      {/* Snackbar for notifications */}
      <Snackbar
        open={snackbar.open}
        autoHideDuration={6000}
        onClose={() => setSnackbar(prev => ({ ...prev, open: false }))}
        message={snackbar.message}
        action={
          <IconButton
            size="small"
            color="inherit"
            onClick={() => setSnackbar(prev => ({ ...prev, open: false }))}
          >
            <CloseIcon fontSize="small" />
          </IconButton>
        }
      />
    </Box>
  );
};

export default MarketResearch; 