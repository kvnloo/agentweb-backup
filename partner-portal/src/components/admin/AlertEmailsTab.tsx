import { useState, useEffect } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  IconButton,
  Paper,
  TextField,
  Typography,
} from '@mui/material';
import { Add as AddIcon, Delete as DeleteIcon } from '@mui/icons-material';
import axios from 'axios';
import { buildApiUrl } from '../../config';
import { useAuth } from '../../contexts/AuthContext';

const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function AlertEmailsTab() {
  const { token } = useAuth();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const [oncallEmails, setOncallEmails] = useState<string[]>([]);
  const [productIssueEmails, setProductIssueEmails] = useState<string[]>([]);
  const [newOncall, setNewOncall] = useState('');
  const [newProduct, setNewProduct] = useState('');

  const headers = { Authorization: `Bearer ${token}` };

  const load = async () => {
    try {
      setLoading(true);
      const { data } = await axios.get(buildApiUrl('/api/admin/alert-emails'), { headers });
      setOncallEmails(data.oncallEmails || []);
      setProductIssueEmails(data.productIssueEmails || []);
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to load alert emails');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (error || success) {
      const t = setTimeout(() => { setError(''); setSuccess(''); }, 4000);
      return () => clearTimeout(t);
    }
  }, [error, success]);

  const addEmail = (
    newValue: string,
    list: string[],
    setList: (v: string[]) => void,
    setNew: (v: string) => void,
  ) => {
    const email = newValue.trim().toLowerCase();
    if (!emailRegex.test(email)) { setError('Invalid email address'); return; }
    if (list.includes(email)) { setError('Email already in list'); return; }
    setList([...list, email]);
    setNew('');
  };

  const handleSave = async () => {
    if (oncallEmails.length === 0 || productIssueEmails.length === 0) {
      setError('Each list must have at least one email');
      return;
    }
    try {
      setSaving(true);
      await axios.put(buildApiUrl('/api/admin/alert-emails'), { oncallEmails, productIssueEmails }, { headers });
      setSuccess('Alert emails saved');
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to save alert emails');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <Box display="flex" justifyContent="center" p={4}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box>
      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
      {success && <Alert severity="success" sx={{ mb: 2 }}>{success}</Alert>}

      <Typography variant="h6" gutterBottom>Alert Email Configuration</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        Configure where system alerts and support messages are sent.
      </Typography>

      <Box display="flex" gap={3} flexWrap="wrap">
        {/* Oncall Emails */}
        <Paper variant="outlined" sx={{ p: 3, flex: '1 1 300px' }}>
          <Typography variant="subtitle1" fontWeight={600} gutterBottom>
            Oncall Alert Emails
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Receives system oncall alerts and user error reports.
          </Typography>

          <Box display="flex" flexWrap="wrap" gap={1} mb={2} minHeight={32}>
            {oncallEmails.map((email) => (
              <Chip
                key={email}
                label={email}
                onDelete={() => setOncallEmails(oncallEmails.filter((e) => e !== email))}
                deleteIcon={<DeleteIcon />}
                size="small"
              />
            ))}
          </Box>

          <Box display="flex" gap={1}>
            <TextField
              size="small"
              label="Add email"
              type="email"
              value={newOncall}
              onChange={(e) => setNewOncall(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addEmail(newOncall, oncallEmails, setOncallEmails, setNewOncall)}
              fullWidth
            />
            <IconButton
              onClick={() => addEmail(newOncall, oncallEmails, setOncallEmails, setNewOncall)}
              color="primary"
              disabled={!newOncall.trim()}
            >
              <AddIcon />
            </IconButton>
          </Box>
        </Paper>

        {/* Product Issue Emails */}
        <Paper variant="outlined" sx={{ p: 3, flex: '1 1 300px' }}>
          <Typography variant="subtitle1" fontWeight={600} gutterBottom>
            Product Issue Emails
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Receives help messages and product issue reports from users.
          </Typography>

          <Box display="flex" flexWrap="wrap" gap={1} mb={2} minHeight={32}>
            {productIssueEmails.map((email) => (
              <Chip
                key={email}
                label={email}
                onDelete={() => setProductIssueEmails(productIssueEmails.filter((e) => e !== email))}
                deleteIcon={<DeleteIcon />}
                size="small"
              />
            ))}
          </Box>

          <Box display="flex" gap={1}>
            <TextField
              size="small"
              label="Add email"
              type="email"
              value={newProduct}
              onChange={(e) => setNewProduct(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addEmail(newProduct, productIssueEmails, setProductIssueEmails, setNewProduct)}
              fullWidth
            />
            <IconButton
              onClick={() => addEmail(newProduct, productIssueEmails, setProductIssueEmails, setNewProduct)}
              color="primary"
              disabled={!newProduct.trim()}
            >
              <AddIcon />
            </IconButton>
          </Box>
        </Paper>
      </Box>

      <Box mt={3}>
        <Button variant="contained" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving...' : 'Save Changes'}
        </Button>
      </Box>
    </Box>
  );
}
