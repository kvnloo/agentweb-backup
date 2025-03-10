import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Container,
  Typography,
  Paper,
  Box,
  Chip,
  Grid,
  CircularProgress,
  Alert,
  Link,
  IconButton,
  Tooltip,
  Divider,
} from '@mui/material';
import ThumbUpIcon from '@mui/icons-material/ThumbUp';
import ThumbDownIcon from '@mui/icons-material/ThumbDown';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import { useAuth } from '../contexts/AuthContext';
import axios from 'axios';
import { buildApiUrl } from '../config';
import ScreenshotIcon from '@mui/icons-material/Screenshot';

interface TaskExecution {
  executionId: string;
  taskId: string;
  userId: string;
  status: string;
  startTime: string;
  completedAt?: string;
  result?: string;
  error?: string;
  feedback?: 'accepted' | 'rejected';
  details_gif?: string;
  prompt?: string;
  browser_use_log?: string;
  userInteractions?: UserInteraction[];
  result_files?: {
    url: string;
    filename: string;
    token: string;
    is_html?: boolean;
  }[];
  llmName?: string;
}

interface UserInteraction {
  id: string;
  question: string;
  response?: string;
  status: string;
  timestamp: number;
  screenshot_url?: string;
}

export default function ExecutionDetails() {
  const [execution, setExecution] = useState<TaskExecution | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const { executionId, taskId } = useParams<{ executionId: string; taskId: string }>();
  const { token } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    const fetchExecution = async () => {
      if (!taskId || !executionId) return;
      
      try {
        const response = await axios.get(
          buildApiUrl(`/api/tasks/${taskId}/executions/${executionId}`),
          { headers: { Authorization: `Bearer ${token}` } }
        );
        setExecution(response.data);
      } catch (error: any) {
        console.error('Error fetching execution details:', error);
        setError(error.response?.data?.message || 'Failed to fetch execution details');
      } finally {
        setLoading(false);
      }
    };

    fetchExecution();
  }, [taskId, executionId, token]);

  const handleFeedbackChange = async (feedback: 'accepted' | 'rejected' | null) => {
    if (!taskId || !executionId) return;
    
    try {
      await axios.put(
        buildApiUrl(`/api/tasks/${taskId}/executions/${executionId}`),
        { feedback },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      
      // Refresh execution data
      const response = await axios.get(
        buildApiUrl(`/api/tasks/${taskId}/executions/${executionId}`),
        { headers: { Authorization: `Bearer ${token}` } }
      );
      setExecution(response.data);
    } catch (error: any) {
      console.error('Error updating feedback:', error);
      setError(error.response?.data?.message || 'Failed to update feedback');
    }
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

  if (!execution) {
    return (
      <Container maxWidth="md">
        <Alert severity="info" sx={{ mt: 4 }}>
          Execution not found
        </Alert>
      </Container>
    );
  }

  return (
    <Container maxWidth="lg" sx={{ mt: 4, mb: 4 }}>
      <Box sx={{ mb: 3 }}>
        <IconButton onClick={() => navigate(`/tasks/${taskId}`)} sx={{ mr: 2 }}>
          <ArrowBackIcon />
        </IconButton>
        <Typography variant="h4" component="h1" display="inline">
          Execution Details
        </Typography>
      </Box>

      <Paper sx={{ p: 4 }}>
        <Grid container spacing={3}>
          {/* Status and Timing Section */}
          <Grid item xs={12}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
              <Box>
                <Chip
                  label={execution.status}
                  color={getStatusColor(execution.status)}
                  sx={{ mr: 2 }}
                />
                {execution.llmName && (
                  <Chip
                    label={`LLM: ${execution.llmName}`}
                    variant="outlined"
                  />
                )}
              </Box>
              <Box sx={{ display: 'flex', gap: 1 }}>
                <Tooltip title={execution.feedback ? `Current: ${execution.feedback}` : 'Set feedback'}>
                  <IconButton
                    onClick={() => handleFeedbackChange(
                      execution.feedback === 'accepted' ? null : 'accepted'
                    )}
                    color={execution.feedback === 'accepted' ? 'success' : 'default'}
                  >
                    <ThumbUpIcon />
                  </IconButton>
                </Tooltip>
                <Tooltip title={execution.feedback ? `Current: ${execution.feedback}` : 'Set feedback'}>
                  <IconButton
                    onClick={() => handleFeedbackChange(
                      execution.feedback === 'rejected' ? null : 'rejected'
                    )}
                    color={execution.feedback === 'rejected' ? 'error' : 'default'}
                  >
                    <ThumbDownIcon />
                  </IconButton>
                </Tooltip>
              </Box>
            </Box>
            <Typography variant="body1" sx={{ mb: 1 }}>
              <strong>Started:</strong> {new Date(execution.startTime).toLocaleString()}
            </Typography>
            {execution.completedAt && (
              <Typography variant="body1" sx={{ mb: 1 }}>
                <strong>Completed:</strong> {new Date(execution.completedAt).toLocaleString()}
              </Typography>
            )}
          </Grid>

          <Grid item xs={12}>
            <Divider sx={{ my: 2 }} />
          </Grid>

          {/* Prompt Section */}
          <Grid item xs={12}>
            <Typography variant="h6" gutterBottom>
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
                {execution.prompt || 'No prompt available'}
              </Typography>
            </Paper>
          </Grid>

          {/* Result Section */}
          <Grid item xs={12}>
            <Typography variant="h6" gutterBottom>
              Result
            </Typography>
            <Paper variant="outlined" sx={{ p: 2, bgcolor: execution.error ? 'error.50' : 'success.50' }}>
              <Typography 
                variant="body1" 
                color={execution.error ? 'error' : 'inherit'}
                sx={{ 
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  overflowWrap: 'break-word'
                }}
              >
                {execution.error || execution.result || 'No result available'}
              </Typography>
            </Paper>
          </Grid>

          {/* Result Files Section */}
          {execution.result_files && execution.result_files.length > 0 && (
            <Grid item xs={12}>
              <Typography variant="h6" gutterBottom>
                Result Files
              </Typography>
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                {execution.result_files.map((file, index) => (
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
            </Grid>
          )}

          {/* Browser Use Log Section */}
          {execution?.browser_use_log && (
            <Grid item xs={12}>
              <Typography variant="h6" gutterBottom>
                Execution Log
              </Typography>
              <Box sx={{ position: 'relative' }}>
                <Paper 
                  variant="outlined" 
                  sx={{ 
                    bgcolor: 'background.paper',
                    overflow: 'hidden',
                    borderRadius: 1
                  }}
                >
                  <iframe
                    src={execution.browser_use_log}
                    style={{
                      width: '100%',
                      height: '500px',
                      border: 'none',
                      backgroundColor: 'white',
                      overflow: 'auto'
                    }}
                    title="Execution Log"
                  />
                </Paper>
                <Box sx={{ mt: 1, display: 'flex', justifyContent: 'space-between' }}>
                  <Typography variant="caption" color="text.secondary">
                    Note: HTML content in logs is escaped to prevent display issues.
                  </Typography>
                  <Link
                    href={execution.browser_use_log}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Open in new tab
                  </Link>
                </Box>
              </Box>
            </Grid>
          )}

          {/* Execution GIF Section */}
          {execution.details_gif && (
            <Grid item xs={12}>
              <Typography variant="h6" gutterBottom>
                Execution Recording
              </Typography>
              <Box sx={{ maxWidth: '100%', overflow: 'hidden' }}>
                <Link href={execution.details_gif} target="_blank" rel="noopener noreferrer">
                  <img
                    src={execution.details_gif}
                    alt="Execution Recording"
                    style={{
                      maxWidth: '100%',
                      height: 'auto',
                      border: '1px solid #eee',
                      borderRadius: '4px'
                    }}
                  />
                </Link>
              </Box>
            </Grid>
          )}

          {/* User Interactions Section */}
          {execution.userInteractions && execution.userInteractions.length > 0 && (
            <Grid item xs={12}>
              <Typography variant="h6" gutterBottom>
                User Interactions
              </Typography>
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                {execution.userInteractions.map((interaction, index) => (
                  <Paper key={index} variant="outlined" sx={{ p: 2 }}>
                    <Typography variant="subtitle1" gutterBottom>
                      Question {index + 1}
                    </Typography>
                    <Typography variant="body1" sx={{ mb: 2 }}>
                      {interaction.question}
                    </Typography>
                    {interaction.response && (
                      <>
                        <Typography variant="subtitle2" gutterBottom>
                          Response:
                        </Typography>
                        <Typography variant="body1" sx={{ mb: 2 }}>
                          {interaction.response}
                        </Typography>
                      </>
                    )}
                    {interaction.screenshot_url && (
                      <Link href={interaction.screenshot_url} target="_blank" rel="noopener noreferrer">
                        <img
                          src={interaction.screenshot_url}
                          alt={`Screenshot for question ${index + 1}`}
                          style={{
                            maxWidth: '100%',
                            height: 'auto',
                            border: '1px solid #eee',
                            borderRadius: '4px'
                          }}
                        />
                      </Link>
                    )}
                  </Paper>
                ))}
              </Box>
            </Grid>
          )}
        </Grid>
      </Paper>
    </Container>
  );
} 