import { useState, useEffect, useCallback } from 'react';
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
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  TextField,
  Snackbar,
} from '@mui/material';
import ThumbUpIcon from '@mui/icons-material/ThumbUp';
import ThumbDownIcon from '@mui/icons-material/ThumbDown';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import ShareIcon from '@mui/icons-material/Share';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import ArchiveIcon from '@mui/icons-material/Archive';
import UnarchiveIcon from '@mui/icons-material/Unarchive';
import AutorenewIcon from '@mui/icons-material/Autorenew';
import EmailIcon from '@mui/icons-material/Email';
import PowerOffIcon from '@mui/icons-material/PowerOff';
import { useAuth } from '../contexts/AuthContext';
import axios from 'axios';
import { buildApiUrl } from '../config';
import ScreenshotIcon from '@mui/icons-material/Screenshot';
import React from 'react';

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
  imageModel?: string;
  archived?: boolean;
  archivedAt?: string;
  outputAsJson?: boolean;
}

interface UserInteraction {
  id: string;
  question: string;
  response?: string;
  status: string;
  timestamp: number;
  screenshot_url?: string;
}

// Add helper function to detect JSON and format it
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

export default function ExecutionDetails() {
  const [execution, setExecution] = useState<TaskExecution | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const { executionId, taskId } = useParams<{ executionId: string; taskId: string }>();
  const { token, user } = useAuth();
  const navigate = useNavigate();
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [shareUrl, setShareUrl] = useState('');
  const [shareLoading, setShareLoading] = useState(false);
  const [shareError, setShareError] = useState('');
  const [copySuccess, setCopySuccess] = useState(false);
  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false);
  const [archiveAction, setArchiveAction] = useState<'archive' | 'unarchive'>('archive');
  const [isAutoRefreshing, setIsAutoRefreshing] = useState(false);
  const [iframeKey] = useState(Date.now()); // Used only for initial rendering
  const iframeRef = React.useRef<HTMLIFrameElement>(null);

  // Kill dialog state
  const [killDialogOpen, setKillDialogOpen] = useState(false);
  const [killLoading, setKillLoading] = useState(false);
  const [killError, setKillError] = useState('');

  // Email dialog state
  const [emailDialogOpen, setEmailDialogOpen] = useState(false);
  const [emailAddress, setEmailAddress] = useState('');
  const [sendingEmail, setSendingEmail] = useState(false);
  const [emailError, setEmailError] = useState('');
  const [emailSuccess, setEmailSuccess] = useState(false);

  const fetchExecution = useCallback(async () => {
    if (!taskId || !executionId || !token) return;
    
    try {
      console.log('Fetching execution data...', new Date().toLocaleTimeString());
      const response = await axios.get(
        buildApiUrl(`/api/tasks/${taskId}/executions/${executionId}`),
        { headers: { Authorization: `Bearer ${token}` } }
      );
      setExecution(response.data);
      
      // If we're still loading, mark loading as complete
      if (loading) {
        setLoading(false);
      }
    } catch (error: any) {
      console.error('Error fetching execution details:', error);
      setError(error.response?.data?.message || 'Failed to fetch execution details');
      setLoading(false);
    }
  }, [taskId, executionId, token, loading]);

  // Initial data load
  useEffect(() => {
    fetchExecution();
  }, [fetchExecution]);

  // Set up polling for running executions
  useEffect(() => {
    let intervalId: NodeJS.Timeout | null = null;
    
    // Only set up polling if the execution is in a running or pending state
    if (execution && ['running', 'pending'].includes(execution.status.toLowerCase())) {
      console.log('Setting up auto-refresh for running task...');
      setIsAutoRefreshing(true);
      
      // Start polling every 10 seconds - only update execution data, not iframe
      intervalId = setInterval(() => {
        console.log('Auto-refresh triggered');
        fetchExecution(); // Only refresh the execution data, not the iframe
      }, 10000);
    } else {
      setIsAutoRefreshing(false);
    }
    
    // Cleanup function to clear interval when component unmounts
    // or when execution status changes
    return () => {
      if (intervalId) {
        console.log('Clearing auto-refresh interval');
        clearInterval(intervalId);
        setIsAutoRefreshing(false);
      }
    };
  }, [execution?.status, fetchExecution]);

  const handleKillClick = () => {
    setKillError('');
    setKillDialogOpen(true);
  };

  const handleConfirmKill = async () => {
    if (!taskId || !executionId || !token) return;

    setKillLoading(true);
    setKillError('');

    try {
      await axios.put(
        buildApiUrl(`/api/tasks/${taskId}/executions/${executionId}/kill`),
        {},
        { headers: { Authorization: `Bearer ${token}` } }
      );
      // Refresh execution data
      fetchExecution();
      setKillDialogOpen(false);
    } catch (error: any) {
      console.error('Error killing execution:', error);
      setKillError(error.response?.data?.message || 'Failed to kill execution');
    } finally {
      setKillLoading(false);
    }
  };

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

  const handleShareClick = async () => {
    if (!taskId || !executionId) return;
    
    try {
      setShareLoading(true);
      setShareError('');
      
      const response = await axios.get(
        buildApiUrl(`/api/tasks/${taskId}/executions/${executionId}/share`),
        { headers: { Authorization: `Bearer ${token}` } }
      );
      
      const shareToken = response.data.shareToken;
      // Create a share URL using the current URL with the token as a query parameter
      const shareUrl = `${window.location.origin}/execution/${executionId}/token/${shareToken}`;
      
      setShareUrl(shareUrl);
      setShareDialogOpen(true);
    } catch (error: any) {
      console.error('Error generating share link:', error);
      setShareError(error.response?.data?.message || 'Failed to generate share link');
    } finally {
      setShareLoading(false);
    }
  };

  const handleCopyShareUrl = () => {
    navigator.clipboard.writeText(shareUrl).then(
      () => {
        setCopySuccess(true);
        setTimeout(() => setCopySuccess(false), 3000);
      },
      () => {
        setShareError('Failed to copy to clipboard');
      }
    );
  };

  const handleArchiveToggle = async () => {
    if (!taskId || !executionId) return;
    
    try {
      await axios.put(
        buildApiUrl(`/api/tasks/${taskId}/executions/${executionId}/${archiveAction}`),
        {},
        { headers: { Authorization: `Bearer ${token}` } }
      );
      
      // Refresh execution data
      const response = await axios.get(
        buildApiUrl(`/api/tasks/${taskId}/executions/${executionId}`),
        { headers: { Authorization: `Bearer ${token}` } }
      );
      setExecution(response.data);
      setArchiveDialogOpen(false);
    } catch (error: any) {
      console.error('Error toggling archive status:', error);
      setError(error.response?.data?.message || 'Failed to update archive status');
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
        <Box sx={{ float: 'right', display: 'flex', alignItems: 'center' }}>
          {isAutoRefreshing && (
            <Tooltip title="Real-time updates active">
              <AutorenewIcon color="info" sx={{ animation: 'spin 2s linear infinite' }} />
            </Tooltip>
          )}
        </Box>
      </Box>

      <style>
        {`
          @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
          }
        `}
      </style>

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
                {execution.imageModel && (
                  <Chip
                    label={`Image Model: ${execution.imageModel}`}
                    variant="outlined"
                    sx={{ ml: 1 }}
                  />
                )}
                {execution.archived && (
                  <Chip
                    label="Archived"
                    color="default"
                    variant="outlined"
                    sx={{ ml: 2 }}
                  />
                )}
              </Box>
              <Box sx={{ display: 'flex', gap: 1 }}>
                {(user?.userId === execution.userId || user?.isAdmin) && (
                  <Tooltip title={execution.archived ? "Unarchive execution" : "Archive execution"}>
                    <IconButton
                      onClick={() => {
                        setArchiveAction(execution.archived ? 'unarchive' : 'archive');
                        setArchiveDialogOpen(true);
                      }}
                    >
                      {execution.archived ? <UnarchiveIcon /> : <ArchiveIcon />}
                    </IconButton>
                  </Tooltip>
                )}
                <Tooltip title="Share execution details">
                  <IconButton
                    onClick={handleShareClick}
                    disabled={shareLoading}
                  >
                    <ShareIcon />
                  </IconButton>
                </Tooltip>
                {(user?.userId === execution.userId || user?.isAdmin) && execution.status.toLowerCase() === 'running' && (
                  <Tooltip title="Kill execution">
                    <IconButton
                      onClick={handleKillClick}
                      disabled={killLoading} // Disable button while kill is in progress
                    >
                      <PowerOffIcon />
                    </IconButton>
                  </Tooltip>
                )}
                <Tooltip title="Email execution details">
                  <IconButton onClick={() => setEmailDialogOpen(true)}>
                    <EmailIcon />
                  </IconButton>
                </Tooltip>
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
            {execution.archivedAt && (
              <Typography variant="body1" sx={{ mb: 1 }}>
                <strong>Archived:</strong> {new Date(execution.archivedAt).toLocaleString()}
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
              {execution.error ? (
                <Typography 
                  variant="body1" 
                  color="error"
                  sx={{ 
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    overflowWrap: 'break-word'
                  }}
                >
                  {execution.error}
                </Typography>
              ) : execution.result ? (
                (execution.outputAsJson || execution.result.trim().startsWith('{') || execution.result.trim().startsWith('[')) ? (
                  formatJsonIfValid(execution.result)
                ) : (
                  <Typography 
                    variant="body1" 
                    sx={{ 
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                      overflowWrap: 'break-word'
                    }}
                  >
                    {execution.result}
                  </Typography>
                )
              ) : (
                <Typography color="textSecondary">No result available</Typography>
              )}
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
                {isAutoRefreshing && (
                  <Tooltip title="Log auto-refreshes every 10 seconds while execution is running">
                    <AutorenewIcon 
                      fontSize="small" 
                      color="info" 
                      sx={{ ml: 1, animation: 'spin 2s linear infinite', verticalAlign: 'middle' }} 
                    />
                  </Tooltip>
                )}
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
                  {(() => {
                    // Extract token from browser_use_log URL
                    const urlRegex = new RegExp(`activities_${executionId}_([a-z0-9]{20})\\.log`);
                    const match = urlRegex.exec(execution.browser_use_log);
                    const logToken = match ? match[1] : '';
                    
                    // Create log URL with token
                    let logUrl = buildApiUrl(`/api/tasks/${taskId}/executions/${executionId}/log?token=${logToken}`);
                    
                    // Add refresh parameter if task is running or pending
                    if (execution && ['running', 'pending'].includes(execution.status.toLowerCase())) {
                      logUrl += '&refresh=10';
                    }
                    
                    return (
                      <iframe
                        ref={iframeRef}
                        key={iframeKey}
                        src={logUrl}
                        style={{
                          width: '100%',
                          height: '500px',
                          border: 'none',
                          backgroundColor: 'white',
                          overflow: 'auto'
                        }}
                        title="Execution Log"
                      />
                    );
                  })()}
                </Paper>
                <Box sx={{ mt: 1, display: 'flex', justifyContent: 'space-between' }}>
                  <div></div>
                  {(() => {
                    // Extract token from browser_use_log URL
                    const urlRegex = new RegExp(`activities_${executionId}_([a-z0-9]{20})\\.log`);
                    const match = urlRegex.exec(execution.browser_use_log);
                    const logToken = match ? match[1] : '';
                    
                    // Create log URL with token
                    let logUrl = buildApiUrl(`/api/tasks/${taskId}/executions/${executionId}/log?token=${logToken}`);
                    
                    // Add refresh parameter if task is running or pending
                    if (execution && ['running', 'pending'].includes(execution.status.toLowerCase())) {
                      logUrl += '&refresh=10';
                    }
                    
                    return (
                      <Link
                        href={logUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Open in new tab
                      </Link>
                    );
                  })()}
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

      {/* Share Dialog */}
      <Dialog open={shareDialogOpen} onClose={() => setShareDialogOpen(false)}>
        <DialogTitle>Share Execution Details</DialogTitle>
        <DialogContent>
          {shareError ? (
            <Alert severity="error" sx={{ mb: 2 }}>
              {shareError}
            </Alert>
          ) : (
            <>
              <Typography variant="body2" sx={{ mb: 2 }}>
                Share this link to allow others to view this execution without requiring login:
              </Typography>
              <Box sx={{ display: 'flex', alignItems: 'center', mb: 2 }}>
                <TextField
                  fullWidth
                  value={shareUrl}
                  variant="outlined"
                  size="small"
                  InputProps={{
                    readOnly: true,
                  }}
                />
                <IconButton onClick={handleCopyShareUrl} sx={{ ml: 1 }}>
                  <ContentCopyIcon />
                </IconButton>
              </Box>
              <Typography variant="caption" color="text.secondary">
                Anyone with this link can view the execution details.
              </Typography>
            </>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setShareDialogOpen(false)}>Close</Button>
        </DialogActions>
      </Dialog>

      {/* Copy Success Snackbar */}
      <Snackbar
        open={copySuccess}
        autoHideDuration={3000}
        onClose={() => setCopySuccess(false)}
        message="Share URL copied to clipboard"
      />

      {/* Archive Confirmation Dialog */}
      <Dialog
        open={archiveDialogOpen}
        onClose={() => setArchiveDialogOpen(false)}
      >
        <DialogTitle>
          {archiveAction === 'archive' ? 'Archive Execution' : 'Unarchive Execution'}
        </DialogTitle>
        <DialogContent>
          <Typography>
            {archiveAction === 'archive'
              ? 'Are you sure you want to archive this execution?'
              : 'Are you sure you want to unarchive this execution?'}
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setArchiveDialogOpen(false)}>Cancel</Button>
          <Button onClick={handleArchiveToggle} autoFocus>
            {archiveAction === 'archive' ? 'Archive' : 'Unarchive'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Email Dialog */}
      <Dialog open={emailDialogOpen} onClose={() => setEmailDialogOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Send Execution Details via Email</DialogTitle>
        <DialogContent>
          {emailError && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {emailError}
            </Alert>
          )}
          {emailSuccess && (
            <Alert severity="success" sx={{ mb: 2 }}>
              Execution details sent successfully!
            </Alert>
          )}
          <Typography variant="body2" sx={{ mb: 2 }}>
            Enter an email address to send the execution details to:
          </Typography>
          <TextField
            autoFocus
            margin="dense"
            id="email"
            label="Email Address"
            type="email"
            fullWidth
            value={emailAddress}
            onChange={(e) => setEmailAddress(e.target.value)}
            error={!!emailError}
            disabled={sendingEmail || emailSuccess}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => {
            setEmailDialogOpen(false);
            // Reset states when dialog is closed
            setEmailError('');
            setEmailSuccess(false);
            setEmailAddress('');
          }}>
            Close
          </Button>
          <Button 
            onClick={async () => {
              if (!emailAddress.trim()) {
                setEmailError('Please enter an email address');
                return;
              }
              
              // Simple email validation
              const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
              if (!emailRegex.test(emailAddress)) {
                setEmailError('Please enter a valid email address');
                return;
              }
              
              try {
                setSendingEmail(true);
                setEmailError('');
                
                await axios.post(
                  buildApiUrl(`/api/tasks/${taskId}/executions/${executionId}/email`),
                  { email: emailAddress },
                  { headers: { Authorization: `Bearer ${token}` } }
                );
                
                setEmailSuccess(true);
                // Clear the email address after successful send
                setEmailAddress('');
              } catch (error: any) {
                console.error('Error sending email:', error);
                setEmailError(error.response?.data?.message || 'Failed to send email');
              } finally {
                setSendingEmail(false);
              }
            }} 
            variant="contained" 
            color="primary"
            disabled={sendingEmail || emailSuccess || !emailAddress.trim()}
          >
            {sendingEmail ? <CircularProgress size={24} /> : "Send"}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Kill Dialog */}
      <Dialog
        open={killDialogOpen}
        onClose={() => setKillDialogOpen(false)}
        aria-labelledby="alert-dialog-title"
        aria-describedby="alert-dialog-description"
      >
        <DialogTitle id="alert-dialog-title">{"Kill Execution?"}</DialogTitle>
        <DialogContent>
          {killError && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {killError}
            </Alert>
          )}
          <Typography>
            Are you sure you want to send a kill command to this execution? This may not be reversible.
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
            {killLoading ? 'Killing...' : 'Kill Execution'}
          </Button>
        </DialogActions>
      </Dialog>
    </Container>
  );
} 