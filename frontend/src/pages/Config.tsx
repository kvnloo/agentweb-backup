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
  Alert,
  Chip,
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import AddIcon from '@mui/icons-material/Add';
import ShareIcon from '@mui/icons-material/Share';
import { useAuth } from '../contexts/AuthContext';
import axios from 'axios';
import { buildApiUrl } from '../config';

interface Config {
  configId: string;
  website: string;
  username: string;
  createdAt: string;
  sharedBy?: string;
  sharedWith?: string[];
  shareWithEveryone?: boolean;
}

// Helper function to mask email
const maskEmail = (email: string) => {
  const [username, domain] = email.split('@');
  const maskedUsername = username.charAt(0) + '*'.repeat(username.length - 2) + username.charAt(username.length - 1);
  return `${maskedUsername}@${domain}`;
};

export default function Config() {
  const { token } = useAuth();
  const [configs, setConfigs] = useState<Config[]>([]);
  const [sharedConfigs, setSharedConfigs] = useState<Config[]>([]);
  const [openDialog, setOpenDialog] = useState(false);
  const [openShareDialog, setOpenShareDialog] = useState(false);
  const [selectedConfig, setSelectedConfig] = useState<string>('');
  const [shareEmail, setShareEmail] = useState('');
  const [newConfig, setNewConfig] = useState({
    website: '',
    username: '',
    password: '',
  });
  const [error, setError] = useState('');
  const [fieldError, setFieldError] = useState('');
  const [shareError, setShareError] = useState('');
  const [shareSuccess, setShareSuccess] = useState('');
  const [userId, setUserId] = useState<string>('');

  const fetchConfigs = async () => {
    try {
      const [configsResponse, sharedConfigsResponse, userResponse] = await Promise.all([
        axios.get(buildApiUrl('/api/config'), {
          headers: { Authorization: `Bearer ${token}` },
        }),
        axios.get(buildApiUrl('/api/config/shared'), {
          headers: { Authorization: `Bearer ${token}` },
        }),
        axios.get(buildApiUrl('/api/auth/me'), {
          headers: { Authorization: `Bearer ${token}` },
        })
      ]);
      setConfigs(configsResponse.data);
      setSharedConfigs(sharedConfigsResponse.data);
      setUserId(userResponse.data.userId);
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

  const handleShare = async () => {
    try {
      setShareError('');
      setShareSuccess('');
      await axios.post(
        buildApiUrl(`/api/config/${selectedConfig}/share`),
        shareEmail ? { email: shareEmail } : { shareWithEveryone: true },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      setShareSuccess('Configuration shared successfully');
      await fetchConfigs();
      setTimeout(() => {
        setOpenShareDialog(false);
        setShareEmail('');
        setShareSuccess('');
        setSelectedConfig('');
      }, 2000);
    } catch (err: any) {
      console.error('Error sharing config:', err);
      setShareError(err.response?.data?.error || 'Failed to share configuration');
    }
  };

  const handleOpenShare = (configId: string) => {
    setSelectedConfig(configId);
    setOpenShareDialog(true);
    setShareError('');
    setShareSuccess('');
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
            <Typography variant="h6" gutterBottom>
              My Configurations
            </Typography>
            <List>
              {configs.map((config) => (
                <ListItem
                  key={config.configId}
                  divider
                  secondaryAction={
                    <Box>
                      {!config.sharedBy && (
                        <IconButton
                          onClick={() => handleOpenShare(config.configId)}
                          sx={{ mr: 1 }}
                        >
                          <ShareIcon />
                        </IconButton>
                      )}
                      <IconButton
                        edge="end"
                        aria-label="delete"
                        onClick={() => handleDeleteConfig(config.configId)}
                      >
                        <DeleteIcon />
                      </IconButton>
                    </Box>
                  }
                >
                  <ListItemText
                    primary={
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                        <span>{config.website}</span>
                        {config.sharedBy && config.sharedBy !== userId && (
                          <Chip
                            size="small"
                            label={`Shared by ${maskEmail(config.sharedBy)}`}
                            color="info"
                            sx={{ ml: 1 }}
                          />
                        )}
                        {config.shareWithEveryone && (
                          <Chip
                            size="small"
                            label="Shared with everyone"
                            color="success"
                            sx={{ ml: 1 }}
                          />
                        )}
                        {!config.shareWithEveryone && config.sharedWith && config.sharedWith.length > 0 && (
                          <Chip
                            size="small"
                            label={`Shared with ${config.sharedWith.length} user${config.sharedWith.length > 1 ? 's' : ''}`}
                            color="success"
                            sx={{ ml: 1 }}
                            onClick={() => {
                              const users = config.sharedWith?.map(maskEmail).join('\n');
                              alert(`Shared with:\n${users}`);
                            }}
                          />
                        )}
                      </Box>
                    }
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

        {sharedConfigs.length > 0 && (
          <Card sx={{ mt: 3 }}>
            <CardContent>
              <Typography variant="h6" gutterBottom>
                Shared with Me
              </Typography>
              <List>
                {sharedConfigs.map((config) => (
                  <ListItem key={config.configId} divider>
                    <ListItemText
                      primary={
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                          {config.website}
                          {config.sharedBy && (
                            <Chip
                              size="small"
                              label={`Shared by ${maskEmail(config.sharedBy)}`}
                              color="info"
                              sx={{ ml: 1 }}
                            />
                          )}
                        </Box>
                      }
                      secondary={`Username: ${config.username}`}
                    />
                  </ListItem>
                ))}
              </List>
            </CardContent>
          </Card>
        )}

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

        <Dialog 
          open={openShareDialog} 
          onClose={() => {
            setOpenShareDialog(false);
            setShareEmail('');
            setShareError('');
            setShareSuccess('');
          }}
        >
          <DialogTitle>Share Configuration</DialogTitle>
          <DialogContent>
            {shareSuccess ? (
              <Alert severity="success" sx={{ mt: 2 }}>
                {shareSuccess}
              </Alert>
            ) : (
              <>
                {shareError && (
                  <Alert severity="error" sx={{ mb: 2 }}>
                    {shareError}
                  </Alert>
                )}
                <Box sx={{ mt: 2 }}>
                  <Button
                    variant="contained"
                    color="primary"
                    fullWidth
                    onClick={() => handleShare()}
                    sx={{ mb: 2 }}
                  >
                    Share with Everyone
                  </Button>
                  <Typography variant="body2" align="center" sx={{ mb: 2 }}>
                    - OR -
                  </Typography>
                  <TextField
                    margin="dense"
                    label="Share with Specific User"
                    type="email"
                    fullWidth
                    value={shareEmail}
                    onChange={(e) => setShareEmail(e.target.value)}
                    helperText="Enter the email of the user you want to share with"
                  />
                </Box>
              </>
            )}
          </DialogContent>
          <DialogActions>
            <Button 
              onClick={() => {
                setOpenShareDialog(false);
                setShareEmail('');
                setShareError('');
              }}
            >
              Cancel
            </Button>
            {shareEmail && (
              <Button 
                onClick={handleShare} 
                color="primary"
                disabled={!shareEmail || !!shareSuccess}
              >
                Share with User
              </Button>
            )}
          </DialogActions>
        </Dialog>
      </Box>
    </Container>
  );
} 