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

interface ResultEndpointConfig {
  name: string;
  resultTitle?: string;
  prompt: string;
  outputFormat: 'html' | 'image' | 'video';
  reviewerEmail: string;
  skipReview?: boolean;
}

const EMPTY_FORM: ResultEndpointConfig = {
  name: '',
  resultTitle: '',
  prompt: '',
  outputFormat: 'html',
  reviewerEmail: '',
  skipReview: false,
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
              <TableCell>Reviewer Email</TableCell>
              <TableCell>Prompt</TableCell>
              <TableCell>Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {configs.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} align="center">
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
