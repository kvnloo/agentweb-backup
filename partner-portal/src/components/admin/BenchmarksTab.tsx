import React, { useState, useEffect } from 'react';
import {
  Box,
  Typography,
  Button,
  TextField,
  Card,
  CardContent,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Paper,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Chip,
  IconButton,
  Tooltip,
  Alert,
  CircularProgress,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  FormControlLabel,
  Checkbox,
} from '@mui/material';
import {
  Add as AddIcon,
  Edit as EditIcon,
  Delete as DeleteIcon,
  PlayArrow as PlayIcon,
  Refresh as RefreshIcon,
  History as HistoryIcon,
  AttachFile as AttachFileIcon,
} from '@mui/icons-material';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { buildApiUrl } from '../../config';
import axios from 'axios';

interface BenchmarkTest {
  testId: string;
  createdBy: string;
  sessionId: string;
  userId: string;
  testName: string;
  description?: string;
  conversationHistory: {
    messages: Array<{
      role: 'user' | 'assistant' | 'system';
      content: string;
      metadata?: any;
    }>;
  };
  expectedOutput: {
    keywords?: string[];
    functionCalls?: string[];
  };
  status: 'draft' | 'active' | 'archived';
  llmModel?: string; // Selected LLM model for this test
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  lastRunModel?: string; // Model used in the last run
  runCount: number;
  successCount: number;
  failureCount: number;
  averageScore?: number;
  testHistory?: Array<{
    testId: string;
    runId: string;
    status: 'success' | 'failure';
    passed: boolean;
    actualResponse: string;
    responseMessages?: any[]; // Add response messages
    actualFunctionCalls: string[];
    keywordMatches: string[];
    keywordMisses: string[];
    functionCallMatches: string[];
    functionCallMisses: string[];
    executionTime: number;
    errorMessage?: string;
    llmModel?: string; // Model used in this test run
    createdAt: string;
  }>;
}

interface CreateBenchmarkDialogProps {
  open: boolean;
  onClose: () => void;
  sessionId?: string;
  editTest?: BenchmarkTest | null;
  onSuccess: () => void;
  onRunTest?: (testId: string, model?: string) => void;
}

const CreateBenchmarkDialog: React.FC<CreateBenchmarkDialogProps> = ({
  open,
  onClose,
  sessionId,
  editTest,
  onSuccess,
  onRunTest,
}) => {
  const { token } = useAuth();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [sessionMessages, setSessionMessages] = useState<any[]>([]);
  const [availableFunctionCalls, setAvailableFunctionCalls] = useState<Array<{name: string; description: string}>>([]);
  const [supportedModels, setSupportedModels] = useState<string[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [formData, setFormData] = useState({
    testName: '',
    description: '',
    keywords: [] as string[],
    functionCalls: [] as string[],
    status: 'draft' as 'draft' | 'active' | 'archived',
  });
  const [newKeyword, setNewKeyword] = useState('');

  useEffect(() => {
    if (open) {
      loadAvailableFunctionCalls();
      loadSupportedModels();
      if (editTest) {
        // Populate form with existing test data
        setFormData({
          testName: editTest.testName,
          description: editTest.description || '',
          keywords: editTest.expectedOutput.keywords || [],
          functionCalls: editTest.expectedOutput.functionCalls || [],
          status: editTest.status || 'draft',
        });
        // Load session messages if available
        if (editTest.conversationHistory?.messages) {
          setSessionMessages(editTest.conversationHistory.messages);
        }
      } else if (sessionId) {
        loadSessionMessages();
      }
    }
  }, [open, sessionId, editTest]);

  // Set selected model when supportedModels are loaded and editTest is available
  useEffect(() => {
    if (editTest && supportedModels.length > 0) {
      // Set selected model from test if available and valid
      if (editTest.llmModel && supportedModels.includes(editTest.llmModel)) {
        setSelectedModel(editTest.llmModel);
      } else if (!selectedModel) {
        // If test has no model or model is not supported, use first available
        setSelectedModel(supportedModels[0]);
      }
    }
  }, [supportedModels, editTest]);

  const loadAvailableFunctionCalls = async () => {
    if (!token) return;
    
    try {
      const response = await axios.get(
        buildApiUrl('/api/agent-mode/function-calls'),
        { headers: { Authorization: `Bearer ${token}` } }
      );
      
      if (response.data?.functionCalls) {
        setAvailableFunctionCalls(response.data.functionCalls);
      }
    } catch (err: any) {
      console.error('Error loading function calls:', err);
      // Don't show error for function calls as it's not critical
    }
  };

  const loadSupportedModels = async () => {
    try {
      const response = await axios.get(
        buildApiUrl('/api/agent-mode/public/llm-models'),
        { headers: { Authorization: token ? `Bearer ${token}` : undefined } }
      );
      
      if (response.data && Array.isArray(response.data)) {
        setSupportedModels(response.data);
        // Set default model to first available if not set and not editing
        if (!selectedModel && !editTest && response.data.length > 0) {
          setSelectedModel(response.data[0]);
        }
      }
    } catch (err: any) {
      console.error('Error loading supported models:', err);
      // Don't show error for models as it's not critical
    }
  };

  const loadSessionMessages = async () => {
    if (!sessionId || !token) return;
    
    try {
      setLoading(true);
      const response = await axios.get(
        buildApiUrl(`/api/agent-mode/session/${sessionId}`),
        { headers: { Authorization: `Bearer ${token}` } }
      );
      
      if (response.data?.messages) {
        // Apply the same filtering logic as when creating the test
        // Find the last user message and strip everything after it
        let lastUserMessageIndex = -1;
        for (let i = response.data.messages.length - 1; i >= 0; i--) {
          if (response.data.messages[i].role === 'user') {
            lastUserMessageIndex = i;
            break;
          }
        }
        
        // If we found a user message, only include messages up to and including that user message
        const filteredMessages = lastUserMessageIndex >= 0 
          ? response.data.messages.slice(0, lastUserMessageIndex + 1)
          : response.data.messages;
          
        setSessionMessages(filteredMessages);
      }
    } catch (err: any) {
      console.error('Error loading session messages:', err);
      setError('Failed to load session messages');
    } finally {
      setLoading(false);
    }
  };

  const addKeyword = () => {
    if (newKeyword.trim() && !formData.keywords.includes(newKeyword.trim())) {
      setFormData(prev => ({
        ...prev,
        keywords: [...prev.keywords, newKeyword.trim()],
      }));
      setNewKeyword('');
    }
  };

  const removeKeyword = (index: number) => {
    setFormData(prev => ({
      ...prev,
      keywords: prev.keywords.filter((_, i) => i !== index),
    }));
  };

  const handleFunctionCallChange = (functionName: string, checked: boolean) => {
    setFormData(prev => ({
      ...prev,
      functionCalls: checked
        ? [...prev.functionCalls, functionName]
        : prev.functionCalls.filter(name => name !== functionName),
    }));
  };

  const handleSubmit = async () => {
    if (!formData.testName.trim()) {
      setError('Test name is required');
      return;
    }

    try {
      setLoading(true);
      setError('');

      // Ensure we have a valid model selected
      // Priority: selectedModel > editTest.llmModel > first available model
      const modelToUse = selectedModel || 
                        (editTest?.llmModel && supportedModels.includes(editTest.llmModel) ? editTest.llmModel : null) ||
                        (supportedModels.length > 0 ? supportedModels[0] : null);
      
      if (!modelToUse) {
        setError('Please select an LLM model');
        setLoading(false);
        return;
      }
      
      const payload = {
        testName: formData.testName.trim(),
        description: formData.description.trim() || undefined,
        status: formData.status,
        expectedOutput: {
          keywords: formData.keywords.length > 0 ? formData.keywords : undefined,
          functionCalls: formData.functionCalls.length > 0 ? formData.functionCalls : undefined,
        },
        llmModel: modelToUse, // Always include the model
      };

      if (editTest) {
        // Update existing test
        await axios.put(buildApiUrl(`/api/benchmark/${editTest.testId}`), payload, {
          headers: { Authorization: `Bearer ${token}` },
        });
      } else {
        // Create new test
        // Find the last user message and strip everything after it
        let lastUserMessageIndex = -1;
        for (let i = sessionMessages.length - 1; i >= 0; i--) {
          if (sessionMessages[i].role === 'user') {
            lastUserMessageIndex = i;
            break;
          }
        }
        
        // If we found a user message, only include messages up to and including that user message
        const filteredMessages = lastUserMessageIndex >= 0 
          ? sessionMessages.slice(0, lastUserMessageIndex + 1)
          : sessionMessages;

        const createPayload = {
          ...payload,
          sessionId,
          conversationHistory: {
            messages: filteredMessages
          },
          llmModel: selectedModel || (supportedModels.length > 0 ? supportedModels[0] : undefined),
        };

        await axios.post(buildApiUrl('/api/benchmark'), createPayload, {
          headers: { Authorization: `Bearer ${token}` },
        });
      }

      onSuccess();
      onClose();
      resetForm();
    } catch (err: any) {
      console.error('Error saving benchmark test:', err);
      setError(err.response?.data?.message || `Failed to ${editTest ? 'update' : 'create'} benchmark test`);
    } finally {
      setLoading(false);
    }
  };

  const resetForm = () => {
    setFormData({
      testName: '',
      description: '',
      keywords: [],
      functionCalls: [],
      status: 'draft',
    });
    setNewKeyword('');
    setError('');
    setSelectedModel('');
    setSessionMessages([]);
  };

  const handleClose = () => {
    if (!loading) {
      onClose();
      resetForm();
    }
  };

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="md" fullWidth>
      <DialogTitle>{editTest ? 'Edit Benchmark Test' : 'Create Benchmark Test'}</DialogTitle>
      <DialogContent>
        {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
        
        {loading && sessionId && (
          <Box sx={{ display: 'flex', justifyContent: 'center', p: 2 }}>
            <CircularProgress />
          </Box>
        )}

        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3, mt: 1 }}>
          {/* Test Name */}
          <TextField
            label="Test Name"
            value={formData.testName}
            onChange={(e) => setFormData(prev => ({ ...prev, testName: e.target.value }))}
            fullWidth
            required
            disabled={loading}
          />

          {/* Description */}
          <TextField
            label="Description"
            value={formData.description}
            onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
            fullWidth
            multiline
            rows={2}
            disabled={loading}
          />

          {/* Status - Only show in edit mode */}
          {editTest && (
            <FormControl fullWidth variant="outlined">
              <InputLabel id="status-label">Status</InputLabel>
              <Select
                labelId="status-label"
                value={formData.status}
                onChange={(e) => setFormData(prev => ({ ...prev, status: e.target.value as 'draft' | 'active' | 'archived' }))}
                disabled={loading}
                label="Status"
              >
                <MenuItem value="draft">Draft</MenuItem>
                <MenuItem value="active">Live (Ready for Running)</MenuItem>
                <MenuItem value="archived">Archived</MenuItem>
              </Select>
            </FormControl>
          )}

          {/* Model Selection */}
          <FormControl fullWidth variant="outlined">
            <InputLabel id="model-label">LLM Model for Running Test</InputLabel>
            <Select
              labelId="model-label"
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
              disabled={loading || supportedModels.length === 0}
              label="LLM Model for Running Test"
            >
              {supportedModels.map((model) => (
                <MenuItem key={model} value={model}>
                  {model}
                </MenuItem>
              ))}
            </Select>
            {supportedModels.length === 0 && (
              <Typography variant="caption" color="text.secondary" sx={{ mt: 1 }}>
                Loading models...
              </Typography>
            )}
          </FormControl>

          {/* Expected Keywords */}
          <Box>
            <Typography variant="subtitle2" gutterBottom>
              Expected Keywords in Response
            </Typography>
            <Box sx={{ display: 'flex', gap: 1, mb: 1 }}>
              <TextField
                value={newKeyword}
                onChange={(e) => setNewKeyword(e.target.value)}
                placeholder="Enter a keyword"
                size="small"
                onKeyPress={(e) => e.key === 'Enter' && addKeyword()}
                disabled={loading}
              />
              <Button onClick={addKeyword} disabled={!newKeyword.trim() || loading}>
                Add
              </Button>
            </Box>
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
              {formData.keywords.map((keyword, index) => (
                <Chip
                  key={index}
                  label={keyword}
                  onDelete={() => removeKeyword(index)}
                  disabled={loading}
                />
              ))}
            </Box>
          </Box>

          {/* Expected Function Calls */}
          <Box>
            <Typography variant="subtitle2" gutterBottom>
              Expected Function Calls
            </Typography>
            <Paper sx={{ p: 2, maxHeight: 200, overflow: 'auto' }}>
              {availableFunctionCalls.map((func) => (
                <FormControlLabel
                  key={func.name}
                  control={
                    <Checkbox
                      checked={formData.functionCalls.includes(func.name)}
                      onChange={(e) => handleFunctionCallChange(func.name, e.target.checked)}
                      disabled={loading}
                    />
                  }
                  label={
                    <Box>
                      <Typography variant="body2" fontWeight="medium">
                        {func.name}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {func.description}
                      </Typography>
                    </Box>
                  }
                />
              ))}
              {availableFunctionCalls.length === 0 && (
                <Typography variant="body2" color="text.secondary">
                  Loading function calls...
                </Typography>
              )}
            </Paper>
          </Box>




          {/* Session Messages Preview */}
          {sessionMessages.length > 0 && (
            <Box>
              <Typography variant="subtitle2" gutterBottom>
                Session Messages ({sessionMessages.length})
              </Typography>
              <Paper sx={{ maxHeight: 200, overflow: 'auto', p: 2 }}>
                {sessionMessages
                  .filter((message, index) => {
                    // Remove the last message if it's from assistant
                    if (index === sessionMessages.length - 1 && message.role === 'assistant') {
                      return false;
                    }
                    return true;
                  })
                  .map((message, index) => (
                    <Box key={index} sx={{ mb: 2, p: 1, border: '1px solid #e0e0e0', borderRadius: 1 }}>
                      <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 'bold' }}>
                        {message.role?.toUpperCase() || 'UNKNOWN'}:
                      </Typography>
                      <Typography variant="body2" sx={{ mt: 1, whiteSpace: 'pre-wrap' }}>
                        {message.content}
                      </Typography>
                      
                      {/* Display attachments if present */}
                      {((message.attachments && message.attachments.length > 0) || (message.metadata?.attachments && message.metadata.attachments.length > 0)) && (
                        <Box sx={{ mt: 1 }}>
                          <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 'bold' }}>
                            Attachments:
                          </Typography>
                          <Box sx={{ mt: 0.5, display: 'flex', flexDirection: 'column', gap: 0.5 }}>
                            {(message.attachments || message.metadata?.attachments || []).map((attachment: any, attachmentIndex: number) => (
                              <Box 
                                key={attachmentIndex} 
                                sx={{ 
                                  display: 'flex', 
                                  alignItems: 'center', 
                                  gap: 1, 
                                  p: 1, 
                                  backgroundColor: 'rgba(0, 0, 0, 0.03)', 
                                  borderRadius: 0.5,
                                  fontSize: '0.75rem'
                                }}
                              >
                                <AttachFileIcon sx={{ fontSize: '0.875rem', color: 'text.secondary' }} />
                                <Typography 
                                  component="a" 
                                  href={attachment.url} 
                                  target="_blank" 
                                  rel="noopener noreferrer"
                                  sx={{ 
                                    color: 'primary.main', 
                                    textDecoration: 'none',
                                    '&:hover': { textDecoration: 'underline' },
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    whiteSpace: 'nowrap',
                                    maxWidth: '200px'
                                  }}
                                >
                                  {attachment.filename || 'Attachment'}
                                </Typography>
                                <Typography variant="caption" color="text.secondary">
                                  ({(attachment.size / 1024).toFixed(1)} KB)
                                </Typography>
                              </Box>
                            ))}
                          </Box>
                        </Box>
                      )}
                    </Box>
                  ))}
              </Paper>
            </Box>
          )}
        </Box>
      </DialogContent>
      <DialogActions>
        {editTest && onRunTest && selectedModel && (
          <Button
            onClick={() => {
              onRunTest(editTest.testId, selectedModel);
              onClose();
            }}
            variant="outlined"
            color="secondary"
            disabled={loading || !selectedModel}
            startIcon={<PlayIcon />}
          >
            Run Test with {selectedModel}
          </Button>
        )}
        <Button onClick={handleClose} disabled={loading}>
          Cancel
        </Button>
        <Button
          onClick={handleSubmit}
          variant="contained"
          disabled={loading || !formData.testName.trim()}
        >
          {loading ? (editTest ? 'Updating...' : 'Creating...') : (editTest ? 'Update Benchmark Test' : 'Create Benchmark Test')}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

const BenchmarksTab: React.FC = () => {
  const { token } = useAuth();
  const [searchParams] = useSearchParams();
  const [benchmarks, setBenchmarks] = useState<BenchmarkTest[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [historyDialogOpen, setHistoryDialogOpen] = useState(false);
  const [selectedBenchmark, setSelectedBenchmark] = useState<BenchmarkTest | null>(null);
  const [runningTests, setRunningTests] = useState<Set<string>>(new Set());
  const [runningAllTests, setRunningAllTests] = useState(false);

  useEffect(() => {
    loadBenchmarks();
    
    // Check if we should open create dialog from URL params
    const createFromSession = searchParams.get('createFromSession');
    if (createFromSession) {
      setCreateDialogOpen(true);
    }
  }, [searchParams]);

  const loadBenchmarks = async () => {
    try {
      setLoading(true);
      setError('');
      
      const response = await axios.get(buildApiUrl('/api/benchmark'), {
        headers: { Authorization: `Bearer ${token}` },
      });
      
      // The API returns { tests: [...], count: ... }
      const benchmarksData = response.data;
      if (benchmarksData && Array.isArray(benchmarksData.tests)) {
        setBenchmarks(benchmarksData.tests);
      } else if (Array.isArray(benchmarksData)) {
        setBenchmarks(benchmarksData);
      } else {
        console.warn('Unexpected API response format:', benchmarksData);
        setBenchmarks([]);
      }
    } catch (err: any) {
      console.error('Error loading benchmarks:', err);
      setError(err.response?.data?.message || 'Failed to load benchmark tests');
      setBenchmarks([]); // Ensure benchmarks is always an array
    } finally {
      setLoading(false);
    }
  };

  const handleEdit = (benchmark: BenchmarkTest) => {
    setSelectedBenchmark(benchmark);
    setEditDialogOpen(true);
  };

  const handleViewHistory = (benchmark: BenchmarkTest) => {
    setSelectedBenchmark(benchmark);
    setHistoryDialogOpen(true);
  };

  const handleDelete = async (testId: string) => {
    if (!window.confirm('Are you sure you want to delete this benchmark test?')) return;
    
    try {
      await axios.delete(buildApiUrl(`/api/benchmark/${testId}`), {
        headers: { Authorization: `Bearer ${token}` },
      });
      
      setBenchmarks(prev => prev.filter(b => b.testId !== testId));
    } catch (err: any) {
      console.error('Error deleting benchmark:', err);
      setError(err.response?.data?.message || 'Failed to delete benchmark test');
    }
  };

  const handleRun = async (testId: string, llmModel?: string) => {
    try {
      // Add test to running set
      setRunningTests(prev => new Set(prev).add(testId));
      
      const payload = llmModel ? { llmName: llmModel } : {};
      
      await axios.post(buildApiUrl(`/api/benchmark/${testId}/run`), payload, {
        headers: { Authorization: `Bearer ${token}` },
      });
      
      // Refresh the list to get updated stats
      await loadBenchmarks();
    } catch (err: any) {
      console.error('Error running benchmark:', err);
      setError(err.response?.data?.message || 'Failed to run benchmark test');
    } finally {
      // Remove test from running set
      setRunningTests(prev => {
        const newSet = new Set(prev);
        newSet.delete(testId);
        return newSet;
      });
    }
  };

  const handleRunAllTests = async () => {
    if (benchmarks.length === 0) return;
    
    setRunningAllTests(true);
    setError('');
    
    try {
      // Run tests one by one (using default model from backend)
      for (const benchmark of benchmarks) {
        try {
          // Add test to running set
          setRunningTests(prev => new Set(prev).add(benchmark.testId));
          
          await axios.post(buildApiUrl(`/api/benchmark/${benchmark.testId}/run`), {}, {
            headers: { Authorization: `Bearer ${token}` },
          });
          
          // Small delay between tests to avoid overwhelming the system
          await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (err: any) {
          console.error(`Error running benchmark ${benchmark.testId}:`, err);
          // Continue with next test even if one fails
        } finally {
          // Remove test from running set
          setRunningTests(prev => {
            const newSet = new Set(prev);
            newSet.delete(benchmark.testId);
            return newSet;
          });
        }
      }
      
      // Refresh the list to get updated stats for all tests
      await loadBenchmarks();
    } catch (err: any) {
      console.error('Error running all benchmarks:', err);
      setError('Some tests failed to run. Check individual test results.');
    } finally {
      setRunningAllTests(false);
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'active': return 'success';
      case 'draft': return 'warning';
      case 'archived': return 'default';
      default: return 'default';
    }
  };

  const getSuccessRate = (benchmark: BenchmarkTest) => {
    if (benchmark.runCount === 0) return 'N/A';
    return `${Math.round((benchmark.successCount / benchmark.runCount) * 100)}%`;
  };

  const getLastRunResult = (benchmark: BenchmarkTest) => {
    if (!benchmark.testHistory || benchmark.testHistory.length === 0) {
      return null;
    }
    // Get the last (most recent) test result
    return benchmark.testHistory[benchmark.testHistory.length - 1];
  };

  const getTestSummary = () => {
    if (benchmarks.length === 0) return null;

    const testResults = benchmarks.map(benchmark => {
      const lastRun = getLastRunResult(benchmark);
      
      return {
        testId: benchmark.testId,
        testName: benchmark.testName,
        lastRun: lastRun,
        passed: lastRun ? lastRun.passed : false,
        executionTime: lastRun ? lastRun.executionTime : 0,
        hasRun: !!lastRun
      };
    });

    const runTests = testResults.filter(result => result.hasRun);
    const passedTests = runTests.filter(result => result.passed);
    const failedTests = runTests.filter(result => !result.passed);
    
    const executionTimes = runTests.map(result => result.executionTime).sort((a, b) => a - b);
    
    const passRate = runTests.length > 0 ? (passedTests.length / runTests.length) * 100 : 0;
    const averageRunTime = executionTimes.length > 0 
      ? executionTimes.reduce((sum, time) => sum + time, 0) / executionTimes.length 
      : 0;
    const medianRunTime = executionTimes.length > 0 
      ? executionTimes[Math.floor(executionTimes.length / 2)] 
      : 0;
    const minRunTime = executionTimes.length > 0 ? Math.min(...executionTimes) : 0;
    const maxRunTime = executionTimes.length > 0 ? Math.max(...executionTimes) : 0;

    return {
      totalTests: benchmarks.length,
      runTests: runTests.length,
      passedTests: passedTests.length,
      failedTests: failedTests.length,
      passRate: Math.round(passRate * 100) / 100,
      averageRunTime: Math.round(averageRunTime),
      medianRunTime: Math.round(medianRunTime),
      minRunTime: Math.round(minRunTime),
      maxRunTime: Math.round(maxRunTime),
      executionTimes
    };
  };

  return (
    <Box>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3 }}>
        <Typography variant="h6">Benchmark Tests</Typography>
        <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
          <Box sx={{ display: 'flex', gap: 1, mb: 1 }}>
            <Button
              variant="outlined"
              startIcon={<RefreshIcon />}
              onClick={loadBenchmarks}
              disabled={loading || runningAllTests}
            >
              Refresh
            </Button>
            <Button
              variant="outlined"
              startIcon={runningAllTests ? <CircularProgress size={16} /> : <PlayIcon />}
              onClick={handleRunAllTests}
              disabled={runningAllTests || benchmarks.length === 0}
              color="secondary"
            >
              {runningAllTests ? 'Running All...' : 'Run All Tests'}
            </Button>
            <Button
              variant="contained"
              startIcon={<AddIcon />}
              onClick={() => setCreateDialogOpen(true)}
              disabled={!searchParams.get('createFromSession')}
            >
              Create Benchmark
            </Button>
          </Box>
          
          {!searchParams.get('createFromSession') && (
            <Typography variant="caption" color="text.secondary" sx={{ textAlign: 'right' }}>
              💡 Click "Add to Benchmark" in Agent Mode to add a session to benchmark test.
            </Typography>
          )}
        </Box>
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {getTestSummary() && (
        <Card sx={{ mb: 3, bgcolor: 'grey.50' }}>
          <CardContent>
            <Typography variant="h6" gutterBottom>
              Test Summary (Last Run Analysis)
            </Typography>
            <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 2 }}>
              <Box>
                <Typography variant="body2" color="text.secondary">
                  Total Tests
                </Typography>
                <Typography variant="h4" color="primary">
                  {getTestSummary()?.totalTests}
                </Typography>
              </Box>
              <Box>
                <Typography variant="body2" color="text.secondary">
                  Tests Run
                </Typography>
                <Typography variant="h4" color="info.main">
                  {getTestSummary()?.runTests}
                </Typography>
              </Box>
              <Box>
                <Typography variant="body2" color="text.secondary">
                  Pass Rate
                </Typography>
                <Typography variant="h4" color={getTestSummary()?.passRate && getTestSummary()!.passRate >= 80 ? 'success.main' : getTestSummary()?.passRate && getTestSummary()!.passRate >= 60 ? 'warning.main' : 'error.main'}>
                  {getTestSummary()?.passRate}%
                </Typography>
              </Box>
              <Box>
                <Typography variant="body2" color="text.secondary">
                  Passed
                </Typography>
                <Typography variant="h4" color="success.main">
                  {getTestSummary()?.passedTests}
                </Typography>
              </Box>
              <Box>
                <Typography variant="body2" color="text.secondary">
                  Failed
                </Typography>
                <Typography variant="h4" color="error.main">
                  {getTestSummary()?.failedTests}
                </Typography>
              </Box>
            </Box>
            
            <Box sx={{ mt: 3 }}>
              <Typography variant="h6" gutterBottom>
                Execution Time Statistics (ms)
              </Typography>
              <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 2 }}>
                <Box>
                  <Typography variant="body2" color="text.secondary">
                    Average
                  </Typography>
                  <Typography variant="h5">
                    {getTestSummary()?.averageRunTime}ms
                  </Typography>
                </Box>
                <Box>
                  <Typography variant="body2" color="text.secondary">
                    Median
                  </Typography>
                  <Typography variant="h5">
                    {getTestSummary()?.medianRunTime}ms
                  </Typography>
                </Box>
                <Box>
                  <Typography variant="body2" color="text.secondary">
                    Min
                  </Typography>
                  <Typography variant="h5" color="success.main">
                    {getTestSummary()?.minRunTime}ms
                  </Typography>
                </Box>
                <Box>
                  <Typography variant="body2" color="text.secondary">
                    Max
                  </Typography>
                  <Typography variant="h5" color="error.main">
                    {getTestSummary()?.maxRunTime}ms
                  </Typography>
                </Box>
              </Box>
            </Box>
          </CardContent>
        </Card>
      )}

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}>
          <CircularProgress />
        </Box>
      ) : (
        <TableContainer component={Paper}>
          <Table>
            <TableHead>
              <TableRow>
                <TableCell>Test ID</TableCell>
                <TableCell>Test Name</TableCell>
                <TableCell>Status</TableCell>
                <TableCell>Runs</TableCell>
                <TableCell>Success Rate</TableCell>
                <TableCell>Last Run Result</TableCell>
                <TableCell>Created</TableCell>
                <TableCell>Last Run</TableCell>
                <TableCell>Last Run Model</TableCell>
                <TableCell>Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {Array.isArray(benchmarks) && benchmarks.map((benchmark) => (
                <TableRow key={benchmark.testId}>
                  <TableCell>
                    <Typography variant="body2" sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>
                      {benchmark.testId}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <Box>
                      <Typography variant="subtitle2">{benchmark.testName}</Typography>
                      {benchmark.description && (
                        <Typography variant="caption" color="text.secondary">
                          {benchmark.description}
                        </Typography>
                      )}
                    </Box>
                  </TableCell>
                  <TableCell>
                    <Chip
                      label={benchmark.status}
                      color={getStatusColor(benchmark.status) as any}
                      size="small"
                    />
                  </TableCell>
                  <TableCell>{benchmark.runCount}</TableCell>
                  <TableCell>{getSuccessRate(benchmark)}</TableCell>
                  <TableCell>
                    {(() => {
                      const lastRun = getLastRunResult(benchmark);
                      if (!lastRun) {
                        return <Typography variant="body2" color="text.secondary">Never run</Typography>;
                      }
                      return (
                        <Chip
                          label={lastRun.passed ? 'PASSED' : 'FAILED'}
                          color={lastRun.passed ? 'success' : 'error'}
                          size="small"
                        />
                      );
                    })()}
                  </TableCell>
                  <TableCell>
                    {new Date(benchmark.createdAt).toLocaleString()}
                  </TableCell>
                  <TableCell>
                    {benchmark.lastRunAt
                      ? new Date(benchmark.lastRunAt).toLocaleString()
                      : 'Never'
                    }
                  </TableCell>
                  <TableCell>
                    {benchmark.lastRunModel ? (
                      <Chip label={benchmark.lastRunModel} size="small" variant="outlined" />
                    ) : (
                      <Typography variant="body2" color="text.secondary">-</Typography>
                    )}
                  </TableCell>
                  <TableCell>
                    <Box sx={{ display: 'flex', gap: 1 }}>
                      <Tooltip title={runningTests.has(benchmark.testId) ? "Running..." : "Run Test"}>
                        <IconButton
                          size="small"
                          onClick={() => handleRun(benchmark.testId)}
                          disabled={benchmark.status !== 'active' || runningTests.has(benchmark.testId)}
                        >
                          {runningTests.has(benchmark.testId) ? (
                            <CircularProgress size={16} />
                          ) : (
                            <PlayIcon />
                          )}
                        </IconButton>
                      </Tooltip>
                      <Tooltip title="Edit">
                        <IconButton
                          size="small"
                          onClick={() => handleEdit(benchmark)}
                        >
                          <EditIcon />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title="View History">
                        <IconButton
                          size="small"
                          onClick={() => handleViewHistory(benchmark)}
                          disabled={!benchmark.testHistory || benchmark.testHistory.length === 0}
                        >
                          <HistoryIcon />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title="Delete">
                        <IconButton
                          size="small"
                          onClick={() => handleDelete(benchmark.testId)}
                          color="error"
                        >
                          <DeleteIcon />
                        </IconButton>
                      </Tooltip>
                    </Box>
                  </TableCell>
                </TableRow>
              ))}
              {(!Array.isArray(benchmarks) || benchmarks.length === 0) && (
                <TableRow>
                  <TableCell colSpan={10} align="center">
                    <Typography color="text.secondary">
                      No benchmark tests found. Create your first one!
                    </Typography>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      <CreateBenchmarkDialog
        open={createDialogOpen}
        onClose={() => setCreateDialogOpen(false)}
        sessionId={searchParams.get('createFromSession') || undefined}
        onSuccess={loadBenchmarks}
      />

      <CreateBenchmarkDialog
        open={editDialogOpen}
        onClose={() => {
          setEditDialogOpen(false);
          setSelectedBenchmark(null);
        }}
        editTest={selectedBenchmark}
        onSuccess={loadBenchmarks}
        onRunTest={(testId, model) => handleRun(testId, model)}
      />

      {/* History Dialog */}
      <Dialog open={historyDialogOpen} onClose={() => setHistoryDialogOpen(false)} maxWidth="lg" fullWidth>
        <DialogTitle>
          Test Execution History
          {selectedBenchmark && (
            <Typography variant="subtitle2" color="text.secondary" sx={{ mt: 1 }}>
              {selectedBenchmark.testName}
            </Typography>
          )}
        </DialogTitle>
        <DialogContent>
          {selectedBenchmark?.testHistory && selectedBenchmark.testHistory.length > 0 ? (
            <Box>
              {selectedBenchmark.testHistory
                .slice()
                .reverse() // Show most recent first
                .map((result, index) => (
                  <Card key={result.runId} sx={{ mb: 2 }}>
                    <CardContent>
                      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                          <Chip
                            label={result.passed ? 'PASSED' : 'FAILED'}
                            color={result.passed ? 'success' : 'error'}
                            size="small"
                          />
                          <Typography variant="body2" color="text.secondary">
                            Run #{selectedBenchmark.testHistory!.length - index}
                          </Typography>
                          <Typography variant="body2" color="text.secondary">
                            {new Date(result.createdAt).toLocaleString()}
                          </Typography>
                          {result.llmModel && (
                            <Chip label={result.llmModel} size="small" variant="outlined" />
                          )}
                        </Box>
                        <Typography variant="body2" color="text.secondary">
                          {result.executionTime}ms
                        </Typography>
                      </Box>

                      {result.actualResponse && (
                        <Box sx={{ mb: 2 }}>
                          <Typography variant="subtitle2" gutterBottom>
                            Response:
                          </Typography>
                          <Paper sx={{ p: 2, bgcolor: 'grey.50', maxHeight: 200, overflow: 'auto' }}>
                            <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
                              {result.actualResponse}
                            </Typography>
                          </Paper>
                        </Box>
                      )}

                      {result.responseMessages && result.responseMessages.length > 0 && (
                        <Box sx={{ mb: 2 }}>
                          <Typography variant="subtitle2" gutterBottom>
                            Response Messages:
                          </Typography>
                          <Paper sx={{ p: 2, bgcolor: 'grey.50', maxHeight: 300, overflow: 'auto' }}>
                            {result.responseMessages.map((msg: any, msgIndex: number) => {
                              // Helper to safely extract text from content
                              const getContent = (content: any): string => {
                                if (!content) return '';
                                if (typeof content === 'string') return content;
                                if (Array.isArray(content)) {
                                  return content.map(item => item?.text || item?.content || '').filter(Boolean).join('\n');
                                }
                                if (typeof content === 'object' && content.text) return content.text;
                                return JSON.stringify(content);
                              };

                              const contentText = getContent(msg.content);

                              return (
                                <Box key={msgIndex} sx={{ mb: 2, p: 1, border: '1px solid #e0e0e0', borderRadius: 1 }}>
                                  <Typography variant="caption" sx={{ fontWeight: 'bold', color:
                                    msg.role === 'assistant' ? '#1976d2' :
                                    msg.role === 'tool' ? '#f57c00' :
                                    'text.secondary'
                                  }}>
                                    {msg.role?.toUpperCase() || 'UNKNOWN'}
                                  </Typography>

                                  {contentText && (
                                    <Typography variant="body2" sx={{ mt: 1, whiteSpace: 'pre-wrap' }}>
                                      {contentText}
                                    </Typography>
                                  )}
                                
                                {msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0 && (
                                  <Box sx={{ mt: 1 }}>
                                    <Typography variant="caption" sx={{ fontWeight: 'bold' }}>
                                      Tool Calls:
                                    </Typography>
                                    {msg.tool_calls.map((toolCall: any, toolIndex: number) => (
                                      <Box key={toolIndex} sx={{ mt: 1, p: 1, backgroundColor: 'rgba(0, 0, 0, 0.03)', borderRadius: 1 }}>
                                        <Typography variant="caption" sx={{ fontWeight: 'bold' }}>
                                          {toolCall.function?.name || toolCall.name}
                                        </Typography>
                                        {toolCall.function?.arguments && (
                                          <pre style={{ fontSize: '0.75rem', margin: '4px 0 0 0', overflowX: 'auto' }}>
                                            {JSON.stringify(JSON.parse(toolCall.function.arguments), null, 2)}
                                          </pre>
                                        )}
                                      </Box>
                                    ))}
                                  </Box>
                                )}
                                
                                  {msg.role === 'tool' && (
                                    <Box sx={{ mt: 1 }}>
                                      <Typography variant="caption" sx={{ fontWeight: 'bold' }}>
                                        Tool Response ({msg.name}):
                                      </Typography>
                                      <pre style={{ fontSize: '0.75rem', margin: '4px 0 0 0', overflowX: 'auto', whiteSpace: 'pre-wrap' }}>
                                        {contentText}
                                      </pre>
                                    </Box>
                                  )}
                                </Box>
                              );
                            })}
                          </Paper>
                        </Box>
                      )}

                      {result.actualFunctionCalls && result.actualFunctionCalls.length > 0 && (
                        <Box sx={{ mb: 2 }}>
                          <Typography variant="subtitle2" gutterBottom>
                            Function Calls:
                          </Typography>
                          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
                            {result.actualFunctionCalls.map((call, callIndex) => (
                              <Chip key={callIndex} label={call} size="small" variant="outlined" />
                            ))}
                          </Box>
                        </Box>
                      )}

                      <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 2 }}>
                        <Box>
                          <Typography variant="subtitle2" gutterBottom>
                            Keyword Matches:
                          </Typography>
                          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
                            {result.keywordMatches.map((keyword, keywordIndex) => (
                              <Chip key={keywordIndex} label={keyword} size="small" color="success" />
                            ))}
                            {result.keywordMatches.length === 0 && (
                              <Typography variant="body2" color="text.secondary">None</Typography>
                            )}
                          </Box>
                        </Box>

                        <Box>
                          <Typography variant="subtitle2" gutterBottom>
                            Keyword Misses:
                          </Typography>
                          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
                            {result.keywordMisses.map((keyword, keywordIndex) => (
                              <Chip key={keywordIndex} label={keyword} size="small" color="error" />
                            ))}
                            {result.keywordMisses.length === 0 && (
                              <Typography variant="body2" color="text.secondary">None</Typography>
                            )}
                          </Box>
                        </Box>

                        <Box>
                          <Typography variant="subtitle2" gutterBottom>
                            Function Call Matches:
                          </Typography>
                          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
                            {result.functionCallMatches.map((call, callIndex) => (
                              <Chip key={callIndex} label={call} size="small" color="success" />
                            ))}
                            {result.functionCallMatches.length === 0 && (
                              <Typography variant="body2" color="text.secondary">None</Typography>
                            )}
                          </Box>
                        </Box>

                        <Box>
                          <Typography variant="subtitle2" gutterBottom>
                            Function Call Misses:
                          </Typography>
                          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
                            {result.functionCallMisses.map((call, callIndex) => (
                              <Chip key={callIndex} label={call} size="small" color="error" />
                            ))}
                            {result.functionCallMisses.length === 0 && (
                              <Typography variant="body2" color="text.secondary">None</Typography>
                            )}
                          </Box>
                        </Box>
                      </Box>

                      {result.errorMessage && (
                        <Box sx={{ mt: 2 }}>
                          <Typography variant="subtitle2" gutterBottom color="error">
                            Error:
                          </Typography>
                          <Typography variant="body2" color="error">
                            {result.errorMessage}
                          </Typography>
                        </Box>
                      )}
                    </CardContent>
                  </Card>
                ))}
            </Box>
          ) : (
            <Box sx={{ textAlign: 'center', py: 4 }}>
              <Typography color="text.secondary">
                No execution history available for this test.
              </Typography>
            </Box>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setHistoryDialogOpen(false)}>
            Close
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default BenchmarksTab;


