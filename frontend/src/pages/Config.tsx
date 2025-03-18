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
  website?: string;
  username: string;
  createdAt: string;
  sharedBy?: string;
  sharedWith?: string[];
  shareWithEveryone?: boolean;
  isApiConfig?: boolean;
  appName?: string;
  integrationDocLink?: string;
}

// Helper function to mask email
const maskEmail = (email: string) => {
  const [username, domain] = email.split('@');
  const maskedUsername = username.charAt(0) + '*'.repeat(username.length - 2) + username.charAt(username.length - 1);
  return `${maskedUsername}@${domain}`;
};

// Helper function to determine if a configuration is an API configuration
const isApiConfiguration = (config: Config): boolean => {
  // More detailed logging to debug classification issues
  if (config.configId) {
    const details = {
      configId: config.configId,
      isApiConfig: config.isApiConfig,
      appName: config.appName,
      website: config.website,
      source: config.sharedBy ? 'shared' : 'owned'
    };
    console.log(`Config classification check: ${JSON.stringify(details)}`);
  }
  
  // Check explicit flag first
  if (config.isApiConfig === true) {
    return true;
  }
  
  // Otherwise, check if it has appName but no website
  if (config.appName && !config.website) {
    console.log(`Identified API config by fields: ${config.configId}`);
    return true;
  }
  
  return false;
};

export default function Config() {
  const { token } = useAuth();
  const [configs, setConfigs] = useState<Config[]>([]);
  const [sharedConfigs, setSharedConfigs] = useState<Config[]>([]);
  const [openDialog, setOpenDialog] = useState(false);
  const [openApiDialog, setOpenApiDialog] = useState(false);
  const [openShareDialog, setOpenShareDialog] = useState(false);
  const [selectedConfig, setSelectedConfig] = useState<string>('');
  const [shareEmail, setShareEmail] = useState('');
  const [newConfig, setNewConfig] = useState({
    website: '',
    username: '',
    password: '',
  });
  const [newApiConfig, setNewApiConfig] = useState({
    appName: '',
    username: '',
    password: '',
    integrationDocLink: '',
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
      
      // Log the configs for debugging purposes
      console.log('My configs:', configsResponse.data);
      console.log('Shared configs:', sharedConfigsResponse.data);
      
      // Make sure API configurations have proper fields
      const processedSharedConfigs = sharedConfigsResponse.data.map((config: Config) => {
        console.log(`Processing shared config: ${config.configId}`);
        
        // Fix any API configs that are missing the isApiConfig flag
        if (config.appName && !config.website && config.isApiConfig !== true) {
          console.warn(`Fixing API config that was missing isApiConfig flag: ${config.configId}`);
          config.isApiConfig = true;
        }
        
        // Flag configs that should be API but don't have appName
        if (config.isApiConfig === true && !config.appName) {
          console.warn(`API config missing appName: ${config.configId}`);
          config.appName = 'Unknown API';
        }
        
        // Flag website configs with no website field
        if (config.isApiConfig !== true && !config.website && !config.appName) {
          console.warn(`Website config missing website field: ${config.configId}`);
          config.website = 'Unknown Website';
        }
        
        // Extra check - if no website but has appName, it must be an API config
        if (!config.website && config.appName) {
          if (!config.isApiConfig) {
            console.warn(`Fixed miscategorized API config: ${config.configId}`);
          }
          config.isApiConfig = true;
        }
        
        return config;
      });
      
      setConfigs(configsResponse.data);
      setSharedConfigs(processedSharedConfigs);
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

  const handleAddApiConfig = async () => {
    try {
      setFieldError('');
      await axios.post(buildApiUrl('/api/config'), {
        ...newApiConfig,
        isApiConfig: true
      }, {
        headers: { Authorization: `Bearer ${token}` },
      });
      setOpenApiDialog(false);
      setNewApiConfig({ appName: '', username: '', password: '', integrationDocLink: '' });
      fetchConfigs();
    } catch (err: any) {
      console.error('Error adding API config:', err);
      setError('Failed to add API configuration');
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
          Configurations
        </Typography>
        
        <Box sx={{ display: 'flex', gap: 2, mb: 3 }}>
          <Button
            variant="contained"
            color="primary"
            startIcon={<AddIcon />}
            onClick={() => setOpenDialog(true)}
          >
            Add Website Config
          </Button>
          <Button
            variant="contained"
            color="secondary"
            startIcon={<AddIcon />}
            onClick={() => setOpenApiDialog(true)}
          >
            Add API Config
          </Button>
        </Box>

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
                      <Box component="div" sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                        <Typography 
                          component="span"
                          sx={{ 
                            fontWeight: isApiConfiguration(config) ? 'bold' : 'normal',
                            color: isApiConfiguration(config) ? 'primary.main' : 'inherit'
                          }}
                        >
                          {isApiConfiguration(config)
                            ? (config.appName || 'API Configuration')
                            : (config.website || 'Website Configuration')
                          }
                        </Typography>
                        {isApiConfiguration(config) && (
                          <Chip
                            size="small"
                            label="API"
                            color="info"
                          />
                        )}
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
                    secondaryTypographyProps={{ component: 'div' }}
                    secondary={
                      <Box component="div" sx={{ mt: 0.5 }}>
                        <Typography component="span" variant="body2">
                          {isApiConfiguration(config)
                            ? `Key Name: ${config.username || 'Unknown'}` 
                            : `Username: ${config.username || 'Unknown'}`
                          }
                        </Typography>
                        {isApiConfiguration(config) && (
                          <Box component="div" mt={1}>
                            {config.integrationDocLink ? (
                              <Button 
                                variant="outlined" 
                                size="small"
                                href={config.integrationDocLink} 
                                target="_blank" 
                                rel="noopener noreferrer"
                                sx={{ textTransform: 'none' }}
                              >
                                View API Documentation
                              </Button>
                            ) : (
                              <Typography component="span" variant="caption" color="text.secondary">
                                No documentation link provided
                              </Typography>
                            )}
                          </Box>
                        )}
                      </Box>
                    }
                  />
                </ListItem>
              ))}
              {configs.length === 0 && (
                <ListItem>
                  <ListItemText 
                    primaryTypographyProps={{ component: 'div' }}
                    primary={<Typography component="span">No configurations added yet</Typography>} 
                  />
                </ListItem>
              )}
            </List>
          </CardContent>
        </Card>

        <Card sx={{ mt: 3 }}>
          <CardContent>
            <Typography variant="h6" gutterBottom>
              Shared with Me
            </Typography>
            <List>
              {sharedConfigs.length > 0 ? 
                sharedConfigs.map((config) => (
                  <ListItem key={config.configId} divider>
                    <ListItemText
                      primary={
                        <Box component="div" sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                          <Typography 
                            component="span"
                            sx={{ 
                              fontWeight: isApiConfiguration(config) ? 'bold' : 'normal',
                              color: isApiConfiguration(config) ? 'primary.main' : 'inherit'
                            }}
                          >
                            {isApiConfiguration(config)
                              ? (config.appName || 'API Configuration')
                              : (config.website || 'Website Configuration')
                            }
                          </Typography>
                          {isApiConfiguration(config) && (
                            <Chip
                              size="small"
                              label="API"
                              color="info"
                            />
                          )}
                          {config.sharedBy && (
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
                              label="Public"
                              color="success"
                              sx={{ ml: 1 }}
                            />
                          )}
                        </Box>
                      }
                      secondaryTypographyProps={{ component: 'div' }}
                      secondary={
                        <Box component="div" sx={{ mt: 0.5 }}>
                          <Typography component="span" variant="body2">
                            {isApiConfiguration(config)
                              ? `Key Name: ${config.username || 'Unknown'}` 
                              : `Username: ${config.username || 'Unknown'}`
                            }
                          </Typography>
                          {isApiConfiguration(config) && (
                            <Box component="div" mt={1}>
                              {config.integrationDocLink ? (
                                <Button 
                                  variant="outlined" 
                                  size="small"
                                  href={config.integrationDocLink} 
                                  target="_blank" 
                                  rel="noopener noreferrer"
                                  sx={{ textTransform: 'none' }}
                                >
                                  View API Documentation
                                </Button>
                              ) : (
                                <Typography component="span" variant="caption" color="text.secondary">
                                  No documentation link provided
                                </Typography>
                              )}
                            </Box>
                          )}
                        </Box>
                      }
                    />
                  </ListItem>
                )) : (
                  <ListItem>
                    <ListItemText 
                      primaryTypographyProps={{ component: 'div' }}
                      primary={<Typography component="span">No configurations have been shared with you</Typography>} 
                    />
                  </ListItem>
                )
              }
            </List>
          </CardContent>
        </Card>

        {/* Website Configuration Dialog */}
        <Dialog open={openDialog} onClose={() => setOpenDialog(false)}>
          <DialogTitle>Add Website Configuration</DialogTitle>
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

        {/* API Configuration Dialog */}
        <Dialog open={openApiDialog} onClose={() => setOpenApiDialog(false)}>
          <DialogTitle>Add API Configuration</DialogTitle>
          <DialogContent>
            <TextField
              autoFocus
              margin="dense"
              label="API/App Name"
              fullWidth
              value={newApiConfig.appName}
              onChange={(e) =>
                setNewApiConfig({ ...newApiConfig, appName: e.target.value })
              }
              helperText="Provide a name for the API integration (e.g., Stripe, GitHub)"
            />
            <TextField
              margin="dense"
              label="API Key Name"
              fullWidth
              value={newApiConfig.username}
              onChange={(e) =>
                setNewApiConfig({ ...newApiConfig, username: e.target.value })
              }
              helperText="Provide the key name or property name as required by the API"
            />
            <TextField
              margin="dense"
              label="API Key/Secret"
              type="password"
              fullWidth
              value={newApiConfig.password}
              onChange={(e) =>
                setNewApiConfig({ ...newApiConfig, password: e.target.value })
              }
              helperText="The actual API key or secret value"
            />
            <TextField
              margin="dense"
              label="Documentation URL (Optional)"
              fullWidth
              value={newApiConfig.integrationDocLink}
              onChange={(e) =>
                setNewApiConfig({ ...newApiConfig, integrationDocLink: e.target.value })
              }
              helperText="Link to integration documentation (optional)"
            />
          </DialogContent>
          <DialogActions>
            <Button onClick={() => {
              setOpenApiDialog(false);
              setFieldError('');
            }}>
              Cancel
            </Button>
            <Button 
              onClick={handleAddApiConfig} 
              color="primary"
              disabled={!newApiConfig.appName || !newApiConfig.username || !newApiConfig.password}
            >
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