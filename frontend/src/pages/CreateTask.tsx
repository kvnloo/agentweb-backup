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
} from '@mui/material';
import axios from 'axios';
import { useAuth } from '../contexts/AuthContext';
import { buildApiUrl } from '../config';

export default function CreateTask() {
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [error, setError] = useState('');
  const { token } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    try {
      await axios.post(
        buildApiUrl('/api/tasks'),
        {
          name,
          prompt,
        },
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      navigate('/dashboard');
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
              onClick={() => navigate('/dashboard')}
            >
              Cancel
            </Button>
          </Box>
        </Box>
      </Paper>
    </Container>
  );
} 