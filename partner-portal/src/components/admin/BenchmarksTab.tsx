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
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  runCount: number;
  successCount: number;
  failureCount: number;
  averageScore?: number;
}

interface CreateBenchmarkDialogProps {
  open: boolean;
  onClose: () => void;
  sessionId?: string;
  editTest?: BenchmarkTest | null;
  onSuccess: () => void;
}

const CreateBenchmarkDialog: React.FC<CreateBenchmarkDialogProps> = ({
  open,
  onClose,
  sessionId,
  editTest,
  onSuccess,
}) => {
  const { token } = useAuth();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [sessionMessages, setSessionMessages] = useState<any[]>([]);
  const [availableFunctionCalls, setAvailableFunctionCalls] = useState<Array<{name: string; description: string}>>([]);
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

  const loadSessionMessages = async () => {
    if (!sessionId || !token) return;
    
    try {
      setLoading(true);
      const response = await axios.get(
        buildApiUrl(`/api/agent-mode/session/${sessionId}`),
        { headers: { Authorization: `Bearer ${token}` } }
      );
      
      if (response.data?.messages) {
        setSessionMessages(response.data.messages);
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

      const payload = {
        testName: formData.testName.trim(),
        description: formData.description.trim() || undefined,
        status: formData.status,
        expectedOutput: {
          keywords: formData.keywords.length > 0 ? formData.keywords : undefined,
          functionCalls: formData.functionCalls.length > 0 ? formData.functionCalls : undefined,
        },
      };

      if (editTest) {
        // Update existing test
        await axios.put(buildApiUrl(`/api/benchmark/${editTest.testId}`), payload, {
          headers: { Authorization: `Bearer ${token}` },
        });
      } else {
        // Create new test
        // Filter out the last message if it's from assistant for the conversation history
        const filteredMessages = sessionMessages.filter((message, index) => {
          if (index === sessionMessages.length - 1 && message.role === 'assistant') {
            return false;
          }
          return true;
        });

        const createPayload = {
          ...payload,
          sessionId,
          conversationHistory: {
            messages: filteredMessages
          },
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
                    <Box key={index} sx={{ mb: 1 }}>
                      <Typography variant="caption" color="text.secondary">
                        {message.role}:
                      </Typography>
                      <Typography variant="body2" sx={{ ml: 1 }}>
                        {message.content}
                      </Typography>
                    </Box>
                  ))}
              </Paper>
            </Box>
          )}
        </Box>
      </DialogContent>
      <DialogActions>
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
  const [selectedBenchmark, setSelectedBenchmark] = useState<BenchmarkTest | null>(null);

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

  const handleRun = async (testId: string) => {
    try {
      await axios.post(buildApiUrl(`/api/benchmark/${testId}/run`), {}, {
        headers: { Authorization: `Bearer ${token}` },
      });
      
      // Refresh the list to get updated stats
      loadBenchmarks();
    } catch (err: any) {
      console.error('Error running benchmark:', err);
      setError(err.response?.data?.message || 'Failed to run benchmark test');
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

  return (
    <Box>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3 }}>
        <Typography variant="h6">Benchmark Tests</Typography>
        <Box>
          <Button
            variant="outlined"
            startIcon={<RefreshIcon />}
            onClick={loadBenchmarks}
            disabled={loading}
            sx={{ mr: 1 }}
          >
            Refresh
          </Button>
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            onClick={() => setCreateDialogOpen(true)}
          >
            Create Benchmark
          </Button>
        </Box>
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
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
                <TableCell>Test Name</TableCell>
                <TableCell>Status</TableCell>
                <TableCell>Runs</TableCell>
                <TableCell>Success Rate</TableCell>
                <TableCell>Created</TableCell>
                <TableCell>Last Run</TableCell>
                <TableCell>Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {Array.isArray(benchmarks) && benchmarks.map((benchmark) => (
                <TableRow key={benchmark.testId}>
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
                    {new Date(benchmark.createdAt).toLocaleDateString()}
                  </TableCell>
                  <TableCell>
                    {benchmark.lastRunAt
                      ? new Date(benchmark.lastRunAt).toLocaleDateString()
                      : 'Never'
                    }
                  </TableCell>
                  <TableCell>
                    <Box sx={{ display: 'flex', gap: 1 }}>
                      <Tooltip title="Run Test">
                        <IconButton
                          size="small"
                          onClick={() => handleRun(benchmark.testId)}
                          disabled={benchmark.status !== 'active'}
                        >
                          <PlayIcon />
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
                  <TableCell colSpan={7} align="center">
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
      />
    </Box>
  );
};

export default BenchmarksTab;


