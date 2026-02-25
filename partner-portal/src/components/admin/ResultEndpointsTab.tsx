import { useState, useEffect } from 'react';
import {
  Box,
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  FormControlLabel,
  IconButton,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
  Alert,
  CircularProgress,
} from '@mui/material';
import {
  Add as AddIcon,
  Edit as EditIcon,
  Delete as DeleteIcon,
} from '@mui/icons-material';
import axios from 'axios';
import { buildApiUrl, CUSTOMER_FRONTEND_URL } from '../../config';
import { useAuth } from '../../contexts/AuthContext';

interface WaitingContent {
  type: 'youtube' | 'url' | 'html';
  value: string;
  title?: string;
}

interface ResultEndpointConfig {
  name: string;
  resultTitle?: string;
  prompt: string;
  outputFormat: 'html' | 'image' | 'video';
  reviewerEmail: string;
  skipReview?: boolean;
  waitingContent?: WaitingContent;
}

const EMPTY_FORM: ResultEndpointConfig = {
  name: '',
  resultTitle: '',
  prompt: '',
  outputFormat: 'html',
  reviewerEmail: '',
  skipReview: false,
  waitingContent: undefined,
};

const WAITING_CONTENT_LABELS: Record<string, string> = {
  youtube: 'YouTube Video',
  url: 'External URL',
  html: 'Custom HTML',
};

export default function ResultEndpointsTab() {
  const { token } = useAuth();
  const [configs, setConfigs] = useState<ResultEndpointConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [formData, setFormData] = useState<ResultEndpointConfig>(EMPTY_FORM);
  const [deleteConfirmName, setDeleteConfirmName] = useState<string | null>(null);

  const headers = { Authorization: `Bearer ${token}` };

  const loadConfigs = async () => {
    try {
      setLoading(true);
      const response = await axios.get(buildApiUrl('/api/admin/result-endpoints'), { headers });
      setConfigs(response.data.data || []);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to load result endpoints');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadConfigs();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (error || success) {
      const timer = setTimeout(() => { setError(''); setSuccess(''); }, 3000);
      return () => clearTimeout(timer);
    }
  }, [error, success]);

  const openCreateDialog = () => {
    setFormData(EMPTY_FORM);
    setEditing(false);
    setDialogOpen(true);
  };

  const openEditDialog = (config: ResultEndpointConfig) => {
    setFormData({ ...config });
    setEditing(true);
    setDialogOpen(true);
  };

  const handleSave = async () => {
    try {
      const body = {
        ...formData,
        resultTitle: formData.resultTitle || undefined,
      };
      await axios.post(buildApiUrl('/api/admin/result-endpoints'), body, { headers });
      setSuccess(editing ? 'Result endpoint updated' : 'Result endpoint created');
      setDialogOpen(false);
      await loadConfigs();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to save result endpoint');
    }
  };

  const handleDelete = async (name: string) => {
    try {
      await axios.delete(buildApiUrl(`/api/admin/result-endpoints/${encodeURIComponent(name)}`), { headers });
      setSuccess('Result endpoint deleted');
      setDeleteConfirmName(null);
      await loadConfigs();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to delete result endpoint');
    }
  };

  if (loading) {
    return (
      <Box display="flex" justifyContent="center" p={4}>
        <CircularProgress />
      </Box>
    );
  }

  const customerUrl = (CUSTOMER_FRONTEND_URL || '').replace(/\/$/, '');

  return (
    <Box>
      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
      {success && <Alert severity="success" sx={{ mb: 2 }}>{success}</Alert>}

      <Box display="flex" justifyContent="space-between" alignItems="center" mb={2}>
        <Typography variant="h6">Result Endpoints</Typography>
        <Button variant="contained" startIcon={<AddIcon />} onClick={openCreateDialog}>
          Add Result Endpoint
        </Button>
      </Box>

      <TableContainer component={Paper}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Name</TableCell>
              <TableCell>Result Title</TableCell>
              <TableCell>Output Format</TableCell>
              <TableCell>Review</TableCell>
              <TableCell>Waiting Content</TableCell>
              <TableCell>Reviewer Email</TableCell>
              <TableCell>Prompt</TableCell>
              <TableCell>Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {configs.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} align="center">
                  No result endpoints configured
                </TableCell>
              </TableRow>
            ) : (
              configs.map((config) => (
                <TableRow key={config.name}>
                  <TableCell>{config.name}</TableCell>
                  <TableCell>{config.resultTitle || '-'}</TableCell>
                  <TableCell>{config.outputFormat}</TableCell>
                  <TableCell>
                    <Chip
                      label={config.skipReview ? 'Auto-send' : 'Required'}
                      color={config.skipReview ? 'warning' : 'primary'}
                      size="small"
                    />
                  </TableCell>
                  <TableCell>
                    {config.waitingContent ? (
                      <Chip
                        label={WAITING_CONTENT_LABELS[config.waitingContent.type] || config.waitingContent.type}
                        color="info"
                        size="small"
                        variant="outlined"
                      />
                    ) : '-'}
                  </TableCell>
                  <TableCell>{config.reviewerEmail}</TableCell>
                  <TableCell sx={{ maxWidth: 300 }}>
                    {config.prompt.length > 80
                      ? config.prompt.substring(0, 80) + '...'
                      : config.prompt}
                  </TableCell>
                  <TableCell>
                    <IconButton size="small" onClick={() => openEditDialog(config)}>
                      <EditIcon fontSize="small" />
                    </IconButton>
                    <IconButton size="small" onClick={() => setDeleteConfirmName(config.name)}>
                      <DeleteIcon fontSize="small" />
                    </IconButton>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </TableContainer>

      <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
        Usage: <code>{customerUrl}/r/{'<name>'}/new?leadEmail=...&param=value</code>
      </Typography>

      {/* Create / Edit Dialog */}
      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>{editing ? 'Edit Result Endpoint' : 'Create Result Endpoint'}</DialogTitle>
        <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, mt: 1 }}>
          <TextField
            label="Name"
            value={formData.name}
            onChange={(e) => setFormData({ ...formData, name: e.target.value })}
            disabled={editing}
            fullWidth
            required
          />
          <TextField
            label="Result Title"
            value={formData.resultTitle || ''}
            onChange={(e) => setFormData({ ...formData, resultTitle: e.target.value })}
            fullWidth
            placeholder="Display title shown to users (defaults to name)"
            helperText="Shown on the confirmation page, e.g. 'GTM Strategy Report'"
          />
          <TextField
            label="Prompt"
            value={formData.prompt}
            onChange={(e) => setFormData({ ...formData, prompt: e.target.value })}
            multiline
            rows={6}
            fullWidth
            required
            helperText="Use {{variable}} syntax for dynamic values from URL params"
          />
          <FormControl fullWidth>
            <InputLabel>Output Format</InputLabel>
            <Select
              value={formData.outputFormat}
              label="Output Format"
              onChange={(e) =>
                setFormData({ ...formData, outputFormat: e.target.value as 'html' | 'image' | 'video' })
              }
            >
              <MenuItem value="html">HTML</MenuItem>
              <MenuItem value="image">Image</MenuItem>
              <MenuItem value="video">Video</MenuItem>
            </Select>
          </FormControl>
          <TextField
            label="Reviewer Email"
            value={formData.reviewerEmail}
            onChange={(e) => setFormData({ ...formData, reviewerEmail: e.target.value })}
            fullWidth
            required
          />
          <FormControlLabel
            control={
              <Checkbox
                checked={!!formData.skipReview}
                onChange={(e) => setFormData({ ...formData, skipReview: e.target.checked })}
              />
            }
            label="No review required (auto-send directly to lead, reviewer gets notified only)"
          />

          {/* While You Are Waiting section */}
          <Typography variant="subtitle2" sx={{ mt: 2, mb: 0.5 }}>
            While You Are Waiting (optional)
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            Content shown to the user on the status page while the result is being generated.
          </Typography>
          <FormControl fullWidth>
            <InputLabel>Waiting Content Type</InputLabel>
            <Select
              value={formData.waitingContent?.type || ''}
              label="Waiting Content Type"
              onChange={(e) => {
                const type = e.target.value as 'youtube' | 'url' | 'html' | '';
                if (!type) {
                  setFormData({ ...formData, waitingContent: undefined });
                } else {
                  setFormData({
                    ...formData,
                    waitingContent: {
                      type,
                      value: formData.waitingContent?.value || '',
                      title: formData.waitingContent?.title,
                    },
                  });
                }
              }}
            >
              <MenuItem value="">None</MenuItem>
              <MenuItem value="youtube">YouTube Video</MenuItem>
              <MenuItem value="url">External URL (iframe)</MenuItem>
              <MenuItem value="html">Custom HTML</MenuItem>
            </Select>
          </FormControl>
          {formData.waitingContent?.type && (
            <>
              <TextField
                label="Title (optional)"
                value={formData.waitingContent.title || ''}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    waitingContent: { ...formData.waitingContent!, title: e.target.value || undefined },
                  })
                }
                fullWidth
                placeholder="e.g. Watch this while we prepare your report"
              />
              <TextField
                label={
                  formData.waitingContent.type === 'youtube'
                    ? 'YouTube URL'
                    : formData.waitingContent.type === 'url'
                    ? 'URL to embed'
                    : 'HTML content'
                }
                value={formData.waitingContent.value}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    waitingContent: { ...formData.waitingContent!, value: e.target.value },
                  })
                }
                multiline={formData.waitingContent.type === 'html'}
                rows={formData.waitingContent.type === 'html' ? 4 : 1}
                fullWidth
                required
                placeholder={
                  formData.waitingContent.type === 'youtube'
                    ? 'https://www.youtube.com/watch?v=...'
                    : formData.waitingContent.type === 'url'
                    ? 'https://example.com/page'
                    : '<div>Your custom HTML here</div>'
                }
              />
            </>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialogOpen(false)}>Cancel</Button>
          <Button
            variant="contained"
            onClick={handleSave}
            disabled={!formData.name.trim() || !formData.prompt.trim() || !formData.reviewerEmail.trim()}
          >
            {editing ? 'Update' : 'Create'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={!!deleteConfirmName} onClose={() => setDeleteConfirmName(null)}>
        <DialogTitle>Delete Result Endpoint</DialogTitle>
        <DialogContent>
          <Typography>
            Are you sure you want to delete &quot;{deleteConfirmName}&quot;?
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteConfirmName(null)}>Cancel</Button>
          <Button color="error" variant="contained" onClick={() => deleteConfirmName && handleDelete(deleteConfirmName)}>
            Delete
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
