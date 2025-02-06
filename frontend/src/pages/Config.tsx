import { useState, useEffect } from 'react';
import {
  Box,
  Button,
  Container,
  Typography,
  TextField,
  Card,
  CardContent,
  IconButton,
  List,
  ListItem,
  ListItemText,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import AddIcon from '@mui/icons-material/Add';
import { useAuth } from '../contexts/AuthContext';
import axios from 'axios';
import { buildApiUrl } from '../config';

interface Config {
  configId: string;
  website: string;
  username: string;
  createdAt: string;
}

export default function Config() {
  const { token } = useAuth();
  const [configs, setConfigs] = useState<Config[]>([]);
  const [openDialog, setOpenDialog] = useState(false);
  const [newConfig, setNewConfig] = useState({
    website: '',
    username: '',
    password: '',
  });
  const [error, setError] = useState('');
  const [fieldError, setFieldError] = useState('');

  const fetchConfigs = async () => {
    try {
      const response = await axios.get(buildApiUrl('/api/config'), {
        headers: { Authorization: `Bearer ${token}` },
      });
      setConfigs(response.data);
    } catch (err) {
      console.error('Error fetching configs:', err);
      setError('Failed to fetch configurations');
    }
  };

  useEffect(() => {
    fetchConfigs();
  }, [token]);

  const handleAddConfig = async () => {
    try {
      setFieldError('');
      await axios.post(buildApiUrl('/api/config'), newConfig, {
        headers: { Authorization: `Bearer ${token}` },
      });
      setOpenDialog(false);
      setNewConfig({ website: '', username: '', password: '' });
      fetchConfigs();
    } catch (err: any) {
      console.error('Error adding config:', err);
      if (err.response?.data?.type === 'INVALID_DOMAIN') {
        setFieldError(err.response.data.error);
      } else {
        setError('Failed to add configuration');
      }
    }
  };

  const handleDeleteConfig = async (configId: string) => {
    try {
      await axios.delete(buildApiUrl(`/api/config/${configId}`), {
        headers: { Authorization: `Bearer ${token}` },
      });
      fetchConfigs();
    } catch (err) {
      console.error('Error deleting config:', err);
      setError('Failed to delete configuration');
    }
  };

  const handleWebsiteChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value.toLowerCase();
    setNewConfig({ ...newConfig, website: value });
    setFieldError('');
  };

  return (
    <Container maxWidth="md">
      <Box sx={{ mt: 4, mb: 4 }}>
        <Typography variant="h4" component="h1" gutterBottom>
          Website Configurations
        </Typography>
        
        <Button
          variant="contained"
          color="primary"
          startIcon={<AddIcon />}
          onClick={() => setOpenDialog(true)}
          sx={{ mb: 3 }}
        >
          Add New Configuration
        </Button>

        {error && (
          <Typography color="error" sx={{ mb: 2 }}>
            {error}
          </Typography>
        )}

        <Card>
          <CardContent>
            <List>
              {configs.map((config) => (
                <ListItem
                  key={config.configId}
                  divider
                  secondaryAction={
                    <IconButton
                      edge="end"
                      aria-label="delete"
                      onClick={() => handleDeleteConfig(config.configId)}
                    >
                      <DeleteIcon />
                    </IconButton>
                  }
                >
                  <ListItemText
                    primary={config.website}
                    secondary={`Username: ${config.username}`}
                  />
                </ListItem>
              ))}
              {configs.length === 0 && (
                <ListItem>
                  <ListItemText primary="No configurations added yet" />
                </ListItem>
              )}
            </List>
          </CardContent>
        </Card>

        <Dialog open={openDialog} onClose={() => setOpenDialog(false)}>
          <DialogTitle>Add New Configuration</DialogTitle>
          <DialogContent>
            <TextField
              autoFocus
              margin="dense"
              label="Website Domain"
              fullWidth
              value={newConfig.website}
              onChange={handleWebsiteChange}
              error={!!fieldError}
              helperText={fieldError || "Enter the domain name without 'http://' or 'www' (e.g., example.com)"}
              placeholder="example.com"
            />
            <TextField
              margin="dense"
              label="Username"
              fullWidth
              value={newConfig.username}
              onChange={(e) =>
                setNewConfig({ ...newConfig, username: e.target.value })
              }
            />
            <TextField
              margin="dense"
              label="Password"
              type="password"
              fullWidth
              value={newConfig.password}
              onChange={(e) =>
                setNewConfig({ ...newConfig, password: e.target.value })
              }
            />
          </DialogContent>
          <DialogActions>
            <Button onClick={() => {
              setOpenDialog(false);
              setFieldError('');
            }}>
              Cancel
            </Button>
            <Button onClick={handleAddConfig} color="primary">
              Add
            </Button>
          </DialogActions>
        </Dialog>
      </Box>
    </Container>
  );
} 