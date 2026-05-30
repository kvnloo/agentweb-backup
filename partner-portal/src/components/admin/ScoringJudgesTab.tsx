import { useState, useEffect } from 'react';
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
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
  Tooltip,
  Chip,
} from '@mui/material';
import {
  Add as AddIcon,
  Edit as EditIcon,
  Delete as DeleteIcon,
  RestartAlt as ResetIcon,
} from '@mui/icons-material';
import axios from 'axios';
import { buildApiUrl } from '../../config';
import { useAuth } from '../../contexts/AuthContext';

interface ScoringJudge {
  id: string;
  name: string;
  systemPrompt: string;
  llmModel?: string;
  createdAt: string;
  updatedAt: string;
}

export default function ScoringJudgesTab() {
  const { token } = useAuth();
  const [judges, setJudges] = useState<ScoringJudge[]>([]);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingJudge, setEditingJudge] = useState<ScoringJudge | null>(null);
  const [editingDefault, setEditingDefault] = useState(false);
  const [name, setName] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [llmModel, setLlmModel] = useState('');
  const [saving, setSaving] = useState(false);

  // Default judge prompt state
  const [defaultPrompt, setDefaultPrompt] = useState('');
  const [defaultPromptIsCustom, setDefaultPromptIsCustom] = useState(false);
  const [defaultModel, setDefaultModel] = useState('');

  const headers = { Authorization: `Bearer ${token}` };

  const fetchJudges = async () => {
    try {
      setLoading(true);
      const [judgesRes, defaultRes] = await Promise.all([
        axios.get(buildApiUrl('/api/settings/scoring-judges'), { headers }),
        axios.get(buildApiUrl('/api/settings/scoring-judges/default-prompt'), { headers }),
      ]);
      setJudges(judgesRes.data.judges || []);
      setAvailableModels(judgesRes.data.availableModels || []);
      setDefaultPrompt(defaultRes.data.systemPrompt || '');
      setDefaultPromptIsCustom(defaultRes.data.isCustom || false);
      setDefaultModel(defaultRes.data.llmModel || '');
    } catch (err) {
      console.error('Error fetching judges:', err);
      setError('Failed to load scoring judges');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (token) fetchJudges();
  }, [token]);

  const handleOpenCreate = () => {
    setEditingJudge(null);
    setEditingDefault(false);
    setName('');
    setSystemPrompt('');
    setLlmModel('');
    setDialogOpen(true);
  };

  const handleOpenEdit = (judge: ScoringJudge) => {
    setEditingJudge(judge);
    setEditingDefault(false);
    setName(judge.name);
    setSystemPrompt(judge.systemPrompt);
    setLlmModel(judge.llmModel || '');
    setDialogOpen(true);
  };

  const handleOpenEditDefault = () => {
    setEditingJudge(null);
    setEditingDefault(true);
    setName('Default');
    setSystemPrompt(defaultPrompt);
    setLlmModel(defaultModel || '');
    setDialogOpen(true);
  };

  const handleSave = async () => {
    if (!systemPrompt.trim()) return;
    if (!editingDefault && !name.trim()) return;
    setSaving(true);
    setError('');
    try {
      if (editingDefault) {
        const res = await axios.put(
          buildApiUrl('/api/settings/scoring-judges/default-prompt'),
          { systemPrompt, llmModel: llmModel || null },
          { headers }
        );
        setDefaultPrompt(res.data.systemPrompt);
        setDefaultPromptIsCustom(true);
        setDefaultModel(res.data.llmModel || '');
      } else if (editingJudge) {
        const res = await axios.put(
          buildApiUrl(`/api/settings/scoring-judges/${editingJudge.id}`),
          { name, systemPrompt, llmModel: llmModel || null },
          { headers }
        );
        setJudges((prev) => prev.map((j) => (j.id === editingJudge.id ? res.data.judge : j)));
      } else {
        const res = await axios.post(
          buildApiUrl('/api/settings/scoring-judges'),
          { name, systemPrompt, llmModel: llmModel || undefined },
          { headers }
        );
        setJudges((prev) => [...prev, res.data.judge]);
      }
      setDialogOpen(false);
    } catch (err) {
      console.error('Error saving judge:', err);
      setError('Failed to save judge');
    } finally {
      setSaving(false);
    }
  };

  const handleResetDefault = async () => {
    if (!confirm('Reset the default judge prompt to the built-in default?')) return;
    try {
      const res = await axios.delete(buildApiUrl('/api/settings/scoring-judges/default-prompt'), { headers });
      setDefaultPrompt(res.data.systemPrompt);
      setDefaultPromptIsCustom(false);
      setDefaultModel('');
    } catch (err) {
      console.error('Error resetting default prompt:', err);
      setError('Failed to reset default prompt');
    }
  };

  const handleDelete = async (judgeId: string) => {
    if (!confirm('Delete this scoring judge?')) return;
    try {
      await axios.delete(buildApiUrl(`/api/settings/scoring-judges/${judgeId}`), { headers });
      setJudges((prev) => prev.filter((j) => j.id !== judgeId));
    } catch (err) {
      console.error('Error deleting judge:', err);
      setError('Failed to delete judge');
    }
  };

  if (loading) return <CircularProgress />;

  return (
    <Box>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
        <Typography variant="h6">Scoring Judges</Typography>
        <Button variant="contained" startIcon={<AddIcon />} onClick={handleOpenCreate}>
          Add Judge
        </Button>
      </Box>

      {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>{error}</Alert>}

      <TableContainer component={Paper}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Name</TableCell>
              <TableCell>System Prompt</TableCell>
              <TableCell>Model</TableCell>
              <TableCell>Updated</TableCell>
              <TableCell width={120}>Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {/* Default judge row */}
            <TableRow>
              <TableCell sx={{ fontWeight: 500 }}>
                Default{' '}
                {defaultPromptIsCustom && (
                  <Chip label="customized" size="small" color="info" sx={{ ml: 1 }} />
                )}
              </TableCell>
              <TableCell>
                <Tooltip title={defaultPrompt}>
                  <Typography
                    variant="body2"
                    sx={{
                      maxWidth: 400,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {defaultPrompt}
                  </Typography>
                </Tooltip>
              </TableCell>
              <TableCell>
                <Typography variant="body2" color={defaultModel ? 'text.primary' : 'text.secondary'}>
                  {defaultModel || 'gemini-3.1-flash-lite'}
                </Typography>
              </TableCell>
              <TableCell>—</TableCell>
              <TableCell>
                <IconButton size="small" onClick={handleOpenEditDefault}>
                  <EditIcon fontSize="small" />
                </IconButton>
                {defaultPromptIsCustom && (
                  <Tooltip title="Reset to built-in default">
                    <IconButton size="small" color="warning" onClick={handleResetDefault}>
                      <ResetIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                )}
              </TableCell>
            </TableRow>
            {/* Custom judges */}
            {judges.map((judge) => (
              <TableRow key={judge.id}>
                <TableCell sx={{ fontWeight: 500 }}>{judge.name}</TableCell>
                <TableCell>
                  <Tooltip title={judge.systemPrompt}>
                    <Typography
                      variant="body2"
                      sx={{
                        maxWidth: 400,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {judge.systemPrompt}
                    </Typography>
                  </Tooltip>
                </TableCell>
                <TableCell>
                  <Typography variant="body2" color={judge.llmModel ? 'text.primary' : 'text.secondary'}>
                    {judge.llmModel || 'gemini-3.1-flash-lite'}
                  </Typography>
                </TableCell>
                <TableCell>{new Date(judge.updatedAt).toLocaleDateString()}</TableCell>
                <TableCell>
                  <IconButton size="small" onClick={() => handleOpenEdit(judge)}>
                    <EditIcon fontSize="small" />
                  </IconButton>
                  <IconButton size="small" color="error" onClick={() => handleDelete(judge.id)}>
                    <DeleteIcon fontSize="small" />
                  </IconButton>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>

      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} maxWidth="md" fullWidth>
        <DialogTitle>
          {editingDefault ? 'Edit Default Judge Prompt' : editingJudge ? 'Edit Judge' : 'Create Judge'}
        </DialogTitle>
        <DialogContent>
          {!editingDefault && (
            <TextField
              label="Name"
              fullWidth
              value={name}
              onChange={(e) => setName(e.target.value)}
              sx={{ mt: 1, mb: 2 }}
              placeholder="e.g. fangfang judge"
            />
          )}
          <FormControl fullWidth size="small" sx={{ mt: editingDefault ? 1 : 0, mb: 2 }}>
            <InputLabel>LLM Model</InputLabel>
            <Select
              value={llmModel}
              label="LLM Model"
              onChange={(e) => setLlmModel(e.target.value)}
            >
              <MenuItem value="">
                <em>Default (gemini-3.1-flash-lite)</em>
              </MenuItem>
              {availableModels.map((m) => (
                <MenuItem key={m} value={m}>{m}</MenuItem>
              ))}
            </Select>
          </FormControl>
          <TextField
            label="System Prompt"
            fullWidth
            multiline
            minRows={8}
            maxRows={20}
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            placeholder="You are an expert at evaluating user satisfaction..."
            helperText={'The LLM will use this prompt to evaluate chat sessions. It must instruct the model to respond with JSON: {"score": 1-5, "reason": "..."}'}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialogOpen(false)}>Cancel</Button>
          <Button
            variant="contained"
            onClick={handleSave}
            disabled={saving || !systemPrompt.trim() || (!editingDefault && !name.trim())}
          >
            {saving ? <CircularProgress size={20} /> : 'Save'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
