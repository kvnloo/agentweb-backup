import { useState, useEffect } from 'react';
import {
  Box,
  Typography,
  Card,
  CardContent,
  TextField,
  Button,
  Alert,
  CircularProgress,
} from '@mui/material';
import axios from 'axios';
import { buildApiUrl } from '../../config';
import { useAuth } from '../../contexts/AuthContext';

const DEFAULT_EMMA_SYSTEM_CONTEXT = `You are Emma Chat, a helpful 24/7 support assistant for AgentWeb's Customer Portal. AgentWeb is a powerful web automation platform.

Your primary functions are to help users understand and use AgentWeb's features, answer questions about the platform, and guide them through tasks.

You have access to tools that allow you to read and update the user's marketing data directly.`;

export default function EmmaSettings() {
  const { token } = useAuth();
  const [systemContext, setSystemContext] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      setLoading(true);
      setError('');
      const response = await axios.get(
        buildApiUrl('/api/settings/emma_system_context'),
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (response.data && response.data.settingValue) {
        setSystemContext(response.data.settingValue);
      } else {
        setSystemContext(DEFAULT_EMMA_SYSTEM_CONTEXT);
      }
    } catch (err: any) {
      console.error('Error loading Emma Chat system context:', err);
      setSystemContext(DEFAULT_EMMA_SYSTEM_CONTEXT);
    } finally {
      setLoading(false);
    }
  };

  const saveSettings = async () => {
    try {
      setSaving(true);
      setError('');
      setSuccess('');
      await axios.post(
        buildApiUrl('/api/settings'),
        {
          settingName: 'emma_system_context',
          settingValue: systemContext,
          description: 'Emma Chat system context',
        },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      setSuccess('Emma Chat system context saved successfully');
    } catch (err: any) {
      console.error('Error saving Emma Chat system context:', err);
      setError(err.response?.data?.error || 'Failed to save Emma Chat system context');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <Box display="flex" justifyContent="center" p={3}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box>
      <Typography variant="h6" gutterBottom>
        Emma Chat Settings
      </Typography>
      <Typography variant="body2" color="text.secondary" paragraph>
        Configure the system context for Emma Chat, the Customer Portal support assistant.
        Changes will apply to new chat sessions (60-second cache).
      </Typography>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {success && (
        <Alert severity="success" sx={{ mb: 2 }}>
          {success}
        </Alert>
      )}

      <Card sx={{ mb: 3 }}>
        <CardContent>
          <Box display="flex" justifyContent="space-between" alignItems="center" mb={2}>
            <Typography variant="h6">
              Emma Chat System Context
            </Typography>
            <Box>
              <Button
                variant="outlined"
                onClick={() => setSystemContext(DEFAULT_EMMA_SYSTEM_CONTEXT)}
                disabled={saving}
                sx={{ mr: 1 }}
              >
                Reset to Default
              </Button>
              <Button
                variant="contained"
                onClick={saveSettings}
                disabled={saving}
              >
                {saving ? <CircularProgress size={20} /> : 'Save Changes'}
              </Button>
            </Box>
          </Box>

          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            This system context defines Emma Chat's persona, capabilities, and behavior in the Customer Portal.
          </Typography>

          <TextField
            fullWidth
            multiline
            rows={15}
            value={systemContext}
            onChange={(e) => setSystemContext(e.target.value)}
            placeholder="Enter the system context for Emma Chat..."
            variant="outlined"
            sx={{ fontFamily: 'monospace' }}
          />

          <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
            Changes apply to new sessions. Existing sessions retain their original system context.
          </Typography>
        </CardContent>
      </Card>
    </Box>
  );
}
