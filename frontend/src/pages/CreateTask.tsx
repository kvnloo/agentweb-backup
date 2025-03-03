import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Container,
  Typography,
  TextField,
  Button,
  Box,
  Alert,
  Paper,
  FormControlLabel,
  Switch,
  Tooltip,
} from '@mui/material';
import axios from 'axios';
import { useAuth } from '../contexts/AuthContext';
import { buildApiUrl, DEEP_RESEARCH_LLMS } from '../config';

export default function CreateTask() {
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [isInteractive, setIsInteractive] = useState(false);
  const [isDeepResearch, setIsDeepResearch] = useState(false);
  const [error, setError] = useState('');
  const { token } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    try {
      const emailNotification = isDeepResearch;

      await axios.post(
        buildApiUrl('/api/tasks'),
        {
          name,
          prompt,
          isInteractive,
          isDeepResearch,
          emailNotification
        },
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      navigate('/tasks');
    } catch (err) {
      setError('Failed to create task');
    }
  };

  return (
    <Container maxWidth="md">
      <Paper sx={{ p: 4, mt: 4 }}>
        <Typography variant="h4" component="h1" gutterBottom>
          Create New Task
        </Typography>
        <Box component="form" onSubmit={handleSubmit}>
          {error && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {error}
            </Alert>
          )}
          <TextField
            margin="normal"
            required
            fullWidth
            id="name"
            label="Task Name"
            name="name"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <TextField
            margin="normal"
            required
            fullWidth
            multiline
            rows={4}
            name="prompt"
            label="Task Prompt"
            id="prompt"
            placeholder="Describe your task in natural language. Our Web Agents will understand your request and may ask for additional information if needed."
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            helperText="Write your task instructions in natural language. The AI agent will request more information if needed."
          />
          <Box sx={{ mt: 2, display: 'flex', flexDirection: 'column', gap: 1 }}>
            <Tooltip title="When enabled, the AI agent can ask for additional information during task execution">
              <FormControlLabel
                control={
                  <Switch
                    checked={isInteractive}
                    onChange={(e) => setIsInteractive(e.target.checked)}
                    color="primary"
                  />
                }
                label="Interactive Mode"
              />
            </Tooltip>
            <Tooltip title="When enabled, the task will use advanced AI to perform comprehensive research on your topic using public web data only. Currently does not use your uploads or web accounts (Config), but will support these in the future. Email notifications are automatically enabled for Deep Research tasks.">
              <FormControlLabel
                control={
                  <Switch
                    checked={isDeepResearch}
                    onChange={(e) => setIsDeepResearch(e.target.checked)}
                    color="primary"
                  />
                }
                label="Perform Deep Research"
              />
            </Tooltip>
          </Box>
          {isDeepResearch && (
            <Alert severity="info" sx={{ mt: 2 }}>
              Deep Research Mode is enabled. When you run this task, it will use advanced AI to perform comprehensive research on your topic using public web data only. Currently does not use your uploads or web accounts (Config), but will support these in the future. Email notifications are automatically enabled for Deep Research tasks.
            </Alert>
          )}
          <Alert severity="info" sx={{ mt: 2, mb: 2 }}>
            All settings including task name, prompt, and modes can be modified later in the Task Details page.
          </Alert>
          <Box sx={{ mt: 3, display: 'flex', gap: 2 }}>
            <Button
              type="submit"
              variant="contained"
              color="primary"
              size="large"
            >
              Create Task
            </Button>
            <Button
              variant="outlined"
              size="large"
              onClick={() => navigate('/tasks')}
            >
              Cancel
            </Button>
          </Box>
        </Box>
      </Paper>
    </Container>
  );
} 