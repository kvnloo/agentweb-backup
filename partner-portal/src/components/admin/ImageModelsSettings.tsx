import { useState, useEffect } from 'react';
import {
  Box,
  Typography,
  Paper,
  Grid,
  TextField,
  Button,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  IconButton,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Alert,
  CircularProgress,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Chip,
  Tooltip,
} from '@mui/material';
import {
  Add as AddIcon,
  Edit as EditIcon,
  Delete as DeleteIcon,
  Save as SaveIcon,
  Cancel as CancelIcon,
} from '@mui/icons-material';
import axios from 'axios';
import { buildApiUrl } from '../../config';
import { useAuth } from '../../contexts/AuthContext';

interface ImageModel {
  value: string;
  label: string;
  description: string;
  provider: string;
}

interface ImageModelConfig {
  defaultImageModel: string;
  supportedImageModels: ImageModel[];
}

export default function ImageModelsSettings() {
  const { token } = useAuth();
  const [config, setConfig] = useState<ImageModelConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [editingModel, setEditingModel] = useState<ImageModel | null>(null);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [formData, setFormData] = useState<ImageModel>({
    value: '',
    label: '',
    description: '',
    provider: '',
  });

  // Initialize default image model settings if they don't exist
  const initializeSettings = async () => {
    try {
      const defaultModels = [
        {
          value: "openai-image-1",
          label: "openai-image-1 (OpenAI)",
          description: "Default OpenAI image generation model",
          provider: "OpenAI"
        },
        {
          value: "FLUX.1-Kontext-pro",
          label: "FLUX.1-Kontext-pro (Azure)",
          description: "Advanced image generation and editing model",
          provider: "Azure"
        },
        {
          value: "gemini-2.5-flash-image",
          label: "Nano Banana (Google Gemini)",
          description: "gemini-2.5-flash-image for image + text",
          provider: "Google"
        }
      ];

      // Set default image model
      await axios.post(
        buildApiUrl('/api/settings'),
        {
          settingName: 'default_image_model',
          settingValue: 'openai-image-1',
          description: 'Default image model used for image generation tasks',
        },
        { headers: { Authorization: `Bearer ${token}` } }
      );

      // Set supported image models
      await axios.post(
        buildApiUrl('/api/settings'),
        {
          settingName: 'supported_image_models',
          settingValue: JSON.stringify(defaultModels),
          description: 'List of supported image models with their metadata',
        },
        { headers: { Authorization: `Bearer ${token}` } }
      );

      setSuccess('Image model settings initialized successfully');
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to initialize image model settings');
    }
  };

  // Fetch image model configuration
  const fetchConfig = async () => {
    try {
      setLoading(true);
      const response = await axios.get(buildApiUrl('/api/image-models'), {
        headers: { Authorization: `Bearer ${token}` },
      });
      
      // Check if we have any supported models
      if (response.data.supportedImageModels.length === 0) {
        // No models exist, initialize with defaults
        await initializeSettings();
        // Fetch again after initialization
        const newResponse = await axios.get(buildApiUrl('/api/image-models'), {
          headers: { Authorization: `Bearer ${token}` },
        });
        setConfig(newResponse.data);
      } else {
        setConfig(response.data);
      }
      setError('');
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to fetch image model configuration');
    } finally {
      setLoading(false);
    }
  };

  // Update default image model
  const updateDefaultModel = async (newDefault: string) => {
    try {
      await axios.post(
        buildApiUrl('/api/settings'),
        {
          settingName: 'default_image_model',
          settingValue: newDefault,
          description: 'Default image model used for image generation tasks',
        },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      setSuccess('Default image model updated successfully');
      fetchConfig();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to update default image model');
    }
  };

  // Update supported image models
  const updateSupportedModels = async (models: ImageModel[]) => {
    try {
      await axios.post(
        buildApiUrl('/api/settings'),
        {
          settingName: 'supported_image_models',
          settingValue: JSON.stringify(models),
          description: 'List of supported image models with their metadata',
        },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      setSuccess('Supported image models updated successfully');
      fetchConfig();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to update supported image models');
    }
  };

  // Add new model
  const handleAddModel = () => {
    setEditingModel(null);
    setIsEditing(false);
    setFormData({ value: '', label: '', description: '', provider: '' });
    setIsDialogOpen(true);
  };

  // Edit existing model
  const handleEditModel = (model: ImageModel) => {
    setEditingModel(model);
    setIsEditing(true);
    setFormData(model);
    setIsDialogOpen(true);
  };

  // Delete model
  const handleDeleteModel = async (modelValue: string) => {
    if (!config) return;
    
    const updatedModels = config.supportedImageModels.filter(m => m.value !== modelValue);
    await updateSupportedModels(updatedModels);
  };

  // Save model
  const handleSaveModel = async () => {
    if (!config) return;

    const { value, label, description, provider } = formData;
    if (!value || !label || !description || !provider) {
      setError('All fields are required');
      return;
    }

    let updatedModels;
    if (isEditing && editingModel) {
      // Update existing model
      updatedModels = config.supportedImageModels.map(m =>
        m.value === editingModel.value ? { value, label, description, provider } : m
      );
    } else {
      // Add new model
      if (config.supportedImageModels.some(m => m.value === value)) {
        setError('A model with this value already exists');
        return;
      }
      updatedModels = [...config.supportedImageModels, { value, label, description, provider }];
    }

    await updateSupportedModels(updatedModels);
    setIsDialogOpen(false);
    setFormData({ value: '', label: '', description: '', provider: '' });
  };

  // Cancel editing
  const handleCancel = () => {
    setIsDialogOpen(false);
    setFormData({ value: '', label: '', description: '', provider: '' });
    setError('');
  };

  useEffect(() => {
    fetchConfig();
  }, []);

  if (loading) {
    return (
      <Box display="flex" justifyContent="center" p={3}>
        <CircularProgress />
      </Box>
    );
  }

  if (!config) {
    return (
      <Box sx={{ p: 3 }}>
        <Alert severity="error" sx={{ mb: 2 }}>
          Failed to load image model configuration
        </Alert>
        <Button
          variant="contained"
          onClick={initializeSettings}
          disabled={loading}
        >
          Initialize Default Settings
        </Button>
      </Box>
    );
  }

  return (
    <Box sx={{ p: 3 }}>
      <Alert severity="warning" sx={{ mb: 3 }}>
        <strong>Legacy feature — Web Automation Image Models</strong>
        <br />
        This tab manages image models for the web automation (task-based) agent engine. For configuring the default image generation API model used in Agent Mode chat sessions, use the <strong>Image API Default Model</strong> setting in the <strong>Agent Mode</strong> tab instead.
      </Alert>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}
      {success && (
        <Alert severity="success" sx={{ mb: 2 }} onClose={() => setSuccess('')}>
          {success}
        </Alert>
      )}

      <Grid container spacing={3}>
        {/* Default Image Model Section */}
        <Grid item xs={12}>
          <Paper sx={{ p: 3 }}>
            <Typography variant="h6" gutterBottom>
              Default Image Model
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Select the default image model that will be used for new tasks
            </Typography>
            <Alert severity="info" sx={{ mb: 2 }}>
              <Typography variant="body2">
                <strong>Important:</strong> When you change the default image model, make sure to update the{' '}
                <code>DEFAULT_IMAGE_MODEL</code>{' '}
                environment variable in the agent-engine to match this value. 
                The agent-engine uses this environment variable as a fallback when no specific model is selected for a task.
              </Typography>
            </Alert>
            <FormControl fullWidth>
              <InputLabel>Default Model</InputLabel>
              <Select
                value={config.defaultImageModel || ''}
                onChange={(e) => updateDefaultModel(e.target.value)}
                label="Default Model"
                disabled={config.supportedImageModels.length === 0}
              >
                {config.supportedImageModels.length === 0 ? (
                  <MenuItem disabled>
                    <em>No models available</em>
                  </MenuItem>
                ) : (
                  config.supportedImageModels.map((model) => (
                    <MenuItem key={model.value} value={model.value}>
                      {model.label}
                    </MenuItem>
                  ))
                )}
              </Select>
            </FormControl>
            {config.supportedImageModels.length === 0 && (
              <Typography variant="caption" color="text.secondary" sx={{ mt: 1 }}>
                Add some image models first to set a default
              </Typography>
            )}
          </Paper>
        </Grid>

        {/* Supported Image Models Section */}
        <Grid item xs={12}>
          <Paper sx={{ p: 3 }}>
            <Box display="flex" justifyContent="space-between" alignItems="center" mb={2}>
              <Typography variant="h6">
                Supported Image Models
              </Typography>
              <Button
                variant="contained"
                startIcon={<AddIcon />}
                onClick={handleAddModel}
              >
                Add Model
              </Button>
            </Box>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Manage the list of available image models for task creation
            </Typography>
            
            {config.supportedImageModels.length === 0 ? (
              <Box sx={{ textAlign: 'center', py: 4 }}>
                <Typography variant="h6" color="text.secondary" gutterBottom>
                  No image models configured
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
                  Get started by adding your first image model or initializing with default settings.
                </Typography>
                <Button
                  variant="contained"
                  startIcon={<AddIcon />}
                  onClick={handleAddModel}
                  sx={{ mr: 2 }}
                >
                  Add First Model
                </Button>
                <Button
                  variant="outlined"
                  onClick={initializeSettings}
                >
                  Initialize Defaults
                </Button>
              </Box>
            ) : (
              <TableContainer>
                <Table>
                  <TableHead>
                    <TableRow>
                      <TableCell>Model Value</TableCell>
                      <TableCell>Label</TableCell>
                      <TableCell>Provider</TableCell>
                      <TableCell>Description</TableCell>
                      <TableCell align="right">Actions</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {config.supportedImageModels.map((model) => (
                      <TableRow key={model.value}>
                        <TableCell>
                          <Chip label={model.value} size="small" />
                        </TableCell>
                        <TableCell>{model.label}</TableCell>
                        <TableCell>
                          <Chip label={model.provider} size="small" color="primary" variant="outlined" />
                        </TableCell>
                        <TableCell>{model.description}</TableCell>
                        <TableCell align="right">
                          <Tooltip title="Edit model">
                            <IconButton
                              size="small"
                              onClick={() => handleEditModel(model)}
                            >
                              <EditIcon />
                            </IconButton>
                          </Tooltip>
                          <Tooltip title="Delete model">
                            <IconButton
                              size="small"
                              onClick={() => handleDeleteModel(model.value)}
                              color="error"
                            >
                              <DeleteIcon />
                            </IconButton>
                          </Tooltip>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            )}
          </Paper>
        </Grid>
      </Grid>

      {/* Add/Edit Model Dialog */}
      <Dialog open={isDialogOpen} onClose={handleCancel} maxWidth="sm" fullWidth>
        <DialogTitle>
          {isEditing ? 'Edit Image Model' : 'Add Image Model'}
        </DialogTitle>
        <DialogContent>
          <Grid container spacing={2} sx={{ mt: 1 }}>
            <Grid item xs={12}>
              <TextField
                fullWidth
                label="Model Value"
                value={formData.value}
                onChange={(e) => setFormData({ ...formData, value: e.target.value })}
                placeholder="e.g., openai-image-1"
                disabled={isEditing}
                helperText="Unique identifier for the model (cannot be changed after creation)"
              />
            </Grid>
            <Grid item xs={12}>
              <TextField
                fullWidth
                label="Display Label"
                value={formData.label}
                onChange={(e) => setFormData({ ...formData, label: e.target.value })}
                placeholder="e.g., openai-image-1 (OpenAI)"
              />
            </Grid>
            <Grid item xs={12}>
              <TextField
                fullWidth
                label="Provider"
                value={formData.provider}
                onChange={(e) => setFormData({ ...formData, provider: e.target.value })}
                placeholder="e.g., OpenAI, Google, Azure"
              />
            </Grid>
            <Grid item xs={12}>
              <TextField
                fullWidth
                label="Description"
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                placeholder="Brief description of the model"
                multiline
                rows={2}
              />
            </Grid>
          </Grid>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleCancel} startIcon={<CancelIcon />}>
            Cancel
          </Button>
          <Button
            onClick={handleSaveModel}
            variant="contained"
            startIcon={<SaveIcon />}
          >
            {isEditing ? 'Update' : 'Add'} Model
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
