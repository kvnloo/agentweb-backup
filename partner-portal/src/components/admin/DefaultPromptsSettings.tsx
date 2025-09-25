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

export default function DefaultPromptsSettings() {
  const { token } = useAuth();
  const [reportRevisionPrompt, setReportRevisionPrompt] = useState('');
  const [loading, setLoading] = useState(true);
  const [savingReportRevision, setSavingReportRevision] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  useEffect(() => {
    loadAllSettings();
  }, []);

  const loadAllSettings = async () => {
    try {
      setLoading(true);
      setError('');
      
      // Load report revision system instruction
      await loadReportRevisionPrompt();
    } catch (error) {
      console.error('Error loading settings:', error);
      setError('Failed to load settings');
    } finally {
      setLoading(false);
    }
  };

  const loadReportRevisionPrompt = async () => {
    try {
      const response = await axios.get(
        buildApiUrl('/api/settings/report_revision_system_instruction'),
        { headers: { Authorization: `Bearer ${token}` } }
      );
      
      if (response.data && response.data.settingValue) {
        setReportRevisionPrompt(response.data.settingValue);
      } else {
        // Load default prompt if no custom one exists
        setReportRevisionPrompt(getDefaultReportRevisionPrompt());
      }
    } catch (error: any) {
      console.error('Error loading report revision prompt:', error);
      // Load default prompt on error
      setReportRevisionPrompt(getDefaultReportRevisionPrompt());
    }
  };

  const getDefaultReportRevisionPrompt = () => {
    return `You are an expert web developer and content editor. You will be given an HTML report and revision instructions. 
Your task is to revise the report according to the instructions, which may include content changes, style modifications, or both.

Guidelines:
- Follow the revision instructions exactly - they may ask for content changes, style changes, etc.
- Maintain professional formatting and readability
- Preserve data tables, charts, and structured content unless specifically asked to modify them
- Keep the overall HTML structure intact unless specifically asked to change it
- If adding new styles, use appropriate CSS classes or inline styles
- Ensure any new styles are consistent with the existing design

You MUST use the write_revised_report function to provide the complete revised HTML report with a filename.`;
  };

  const saveReportRevisionPrompt = async () => {
    try {
      setSavingReportRevision(true);
      setError('');
      
      await axios.post(
        buildApiUrl('/api/settings'),
        {
          settingName: 'report_revision_system_instruction',
          settingValue: reportRevisionPrompt,
          description: 'System instruction for AI when revising HTML reports',
        },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      
      setSuccess('Report revision system instruction saved successfully');
    } catch (error: any) {
      console.error('Error saving report revision prompt:', error);
      setError(error.response?.data?.error || 'Failed to save report revision system instruction');
    } finally {
      setSavingReportRevision(false);
    }
  };

  const resetToDefault = (settingType: string) => {
    if (settingType === 'reportRevision') {
      setReportRevisionPrompt(getDefaultReportRevisionPrompt());
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
        Default Prompts Configuration
      </Typography>
      <Typography variant="body2" color="text.secondary" paragraph>
        Configure default system instructions used by AI agents for various tasks. 
        Changes will apply to new task executions.
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

      {/* Report Revision System Instruction */}
      <Card sx={{ mb: 3 }}>
        <CardContent>
          <Box display="flex" justifyContent="space-between" alignItems="center" mb={2}>
            <Typography variant="h6">
              Report Revision System Instruction
            </Typography>
            <Box>
              <Button
                variant="outlined"
                onClick={() => resetToDefault('reportRevision')}
                disabled={savingReportRevision}
                sx={{ mr: 1 }}
              >
                Reset to Default
              </Button>
              <Button
                variant="contained"
                onClick={saveReportRevisionPrompt}
                disabled={savingReportRevision}
              >
                {savingReportRevision ? <CircularProgress size={20} /> : 'Save Changes'}
              </Button>
            </Box>
          </Box>
          
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            This system instruction is used when AI agents revise HTML reports. It defines how the AI should approach 
            report revisions, including guidelines for content changes, style modifications, and maintaining professional formatting.
          </Typography>
          
          <TextField
            fullWidth
            multiline
            rows={15}
            value={reportRevisionPrompt}
            onChange={(e) => setReportRevisionPrompt(e.target.value)}
            placeholder="Enter the system instruction for report revision..."
            variant="outlined"
            sx={{ fontFamily: 'monospace' }}
          />
          
          <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
            This instruction is used by the report revision service when generating revised HTML reports.
          </Typography>
        </CardContent>
      </Card>
    </Box>
  );
}
