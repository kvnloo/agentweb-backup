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
  Divider,
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
    keywords: string[];
    functionCalls?: string[];
    responseType?: 'text' | 'html' | 'json' | 'image';
    minResponseLength?: number;
    maxResponseLength?: number;
    additionalCriteria?: string;
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
  onSuccess: () => void;
}

const CreateBenchmarkDialog: React.FC<CreateBenchmarkDialogProps> = ({
  open,
  onClose,
  sessionId,
  onSuccess,
}) => {
  const { token } = useAuth();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [sessionMessages, setSessionMessages] = useState<any[]>([]);
  const [formData, setFormData] = useState({
    testName: '',
    description: '',
    keywords: [] as string[],
    functionCalls: [] as string[],
    responseType: 'text' as 'text' | 'html' | 'json' | 'image',
    minResponseLength: '',
    maxResponseLength: '',
    additionalCriteria: '',
  });
  const [newKeyword, setNewKeyword] = useState('');
  const [newFunctionCall, setNewFunctionCall] = useState('');

  useEffect(() => {
    if (open && sessionId) {
      loadSessionMessages();
    }
  }, [open, sessionId]);

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
        setFormData(prev => ({
          ...prev,
          testName: `Benchmark from Session ${sessionId.slice(-6)}`,
        }));
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

  const addFunctionCall = () => {
    if (newFunctionCall.trim() && !formData.functionCalls.includes(newFunctionCall.trim())) {
      setFormData(prev => ({
        ...prev,
        functionCalls: [...prev.functionCalls, newFunctionCall.trim()],
      }));
      setNewFunctionCall('');
    }
  };

  const removeFunctionCall = (index: number) => {
    setFormData(prev => ({
      ...prev,
      functionCalls: prev.functionCalls.filter((_, i) => i !== index),
    }));
  };

  const handleSubmit = async () => {
    if (!formData.testName.trim()) {
      setError('Test name is required');
      return;
    }
    if (formData.keywords.length === 0) {
      setError('At least one expected keyword is required');
      return;
    }

    try {
      setLoading(true);
      setError('');

      const payload = {
        sessionId,
        testName: formData.testName.trim(),
        description: formData.description.trim() || undefined,
        expectedOutput: {
          keywords: formData.keywords,
          functionCalls: formData.functionCalls.length > 0 ? formData.functionCalls : undefined,
          responseType: formData.responseType,
          minResponseLength: formData.minResponseLength ? Number(formData.minResponseLength) : undefined,
          maxResponseLength: formData.maxResponseLength ? Number(formData.maxResponseLength) : undefined,
          additionalCriteria: formData.additionalCriteria.trim() || undefined,
        },
      };

      await axios.post(buildApiUrl('/api/benchmark'), payload, {
        headers: { Authorization: `Bearer ${token}` },
      });

      onSuccess();
      onClose();
      resetForm();
    } catch (err: any) {
      console.error('Error creating benchmark test:', err);
      setError(err.response?.data?.message || 'Failed to create benchmark test');
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
      responseType: 'text',
      minResponseLength: '',
      maxResponseLength: '',
      additionalCriteria: '',
    });
    setNewKeyword('');
    setNewFunctionCall('');
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
      <DialogTitle>Create Benchmark Test</DialogTitle>
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

          {/* Expected Keywords */}
          <Box>
            <Typography variant="subtitle2" gutterBottom>
              Expected Keywords in Response *
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
            <Box sx={{ display: 'flex', gap: 1, mb: 1 }}>
              <TextField
                value={newFunctionCall}
                onChange={(e) => setNewFunctionCall(e.target.value)}
                placeholder="Enter function call name"
                size="small"
                onKeyPress={(e) => e.key === 'Enter' && addFunctionCall()}
                disabled={loading}
              />
              <Button onClick={addFunctionCall} disabled={!newFunctionCall.trim() || loading}>
                Add
              </Button>
            </Box>
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
              {formData.functionCalls.map((functionCall, index) => (
                <Chip
                  key={index}
                  label={functionCall}
                  onDelete={() => removeFunctionCall(index)}
                  disabled={loading}
                  variant="outlined"
                />
              ))}
            </Box>
          </Box>

          {/* Response Type */}
          <FormControl fullWidth>
            <InputLabel>Expected Response Type</InputLabel>
            <Select
              value={formData.responseType}
              onChange={(e) => setFormData(prev => ({ ...prev, responseType: e.target.value as any }))}
              disabled={loading}
            >
              <MenuItem value="text">Text</MenuItem>
              <MenuItem value="html">HTML</MenuItem>
              <MenuItem value="json">JSON</MenuItem>
              <MenuItem value="image">Image</MenuItem>
            </Select>
          </FormControl>

          {/* Response Length Constraints */}
          <Box sx={{ display: 'flex', gap: 2 }}>
            <TextField
              label="Min Response Length"
              type="number"
              value={formData.minResponseLength}
              onChange={(e) => setFormData(prev => ({ ...prev, minResponseLength: e.target.value }))}
              disabled={loading}
            />
            <TextField
              label="Max Response Length"
              type="number"
              value={formData.maxResponseLength}
              onChange={(e) => setFormData(prev => ({ ...prev, maxResponseLength: e.target.value }))}
              disabled={loading}
            />
          </Box>

          {/* Additional Criteria */}
          <TextField
            label="Additional Criteria"
            value={formData.additionalCriteria}
            onChange={(e) => setFormData(prev => ({ ...prev, additionalCriteria: e.target.value }))}
            fullWidth
            multiline
            rows={3}
            disabled={loading}
          />

          {/* Session Messages Preview */}
          {sessionMessages.length > 0 && (
            <Box>
              <Typography variant="subtitle2" gutterBottom>
                Session Messages ({sessionMessages.length})
              </Typography>
              <Paper sx={{ maxHeight: 200, overflow: 'auto', p: 2 }}>
                {sessionMessages.map((message, index) => (
                  <Box key={index} sx={{ mb: 1 }}>
                    <Typography variant="caption" color="text.secondary">
                      {message.role}:
                    </Typography>
                    <Typography variant="body2" sx={{ ml: 1 }}>
                      {message.content.substring(0, 100)}
                      {message.content.length > 100 && '...'}
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
          disabled={loading || !formData.testName.trim() || formData.keywords.length === 0}
        >
          {loading ? 'Creating...' : 'Create Benchmark Test'}
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
      
      const response = await axios.get(buildApiUrl('/api/benchmark/my'), {
        headers: { Authorization: `Bearer ${token}` },
      });
      
      setBenchmarks(response.data.tests || []);
    } catch (err: any) {
      console.error('Error loading benchmarks:', err);
      setError(err.response?.data?.message || 'Failed to load benchmark tests');
    } finally {
      setLoading(false);
    }
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
              {benchmarks.map((benchmark) => (
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
                          onClick={() => setSelectedBenchmark(benchmark)}
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
              {benchmarks.length === 0 && (
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
    </Box>
  );
};

export default BenchmarksTab;


