import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Container,
  Typography,
  Button,
  Box,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  IconButton,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  TextField,
  FormControlLabel,
  Switch,
  Tooltip,
  Alert,
  CircularProgress,
  Chip,
  Stack,
  Divider,
  Tabs,
  Tab
} from '@mui/material';
import { 
  Edit as EditIcon, 
  Delete as DeleteIcon, 
  Add as AddIcon,
  Public as PublicIcon,
  PublicOff as PublicOffIcon,
  Person as PersonIcon,
  AdminPanelSettings as AdminIcon
} from '@mui/icons-material';
import axios from 'axios';
import { useAuth } from '../contexts/AuthContext';
import { buildApiUrl } from '../config';

interface Template {
  templateId: string;
  name: string;
  description: string;
  prompt: string;
  parameters: string[];
  nameParameter: string | null;
  isInteractive: boolean;
  isDeepResearch: boolean;
  published: boolean;
  userId: string;
  createdAt: string;
  updatedAt: string;
}

// Helper function to extract parameters from prompt
const extractParameters = (prompt: string): string[] => {
  const paramRegex = /\[([^\]]+)\]/g;
  const matches = prompt.match(paramRegex) || [];
  
  // Extract parameter names without brackets and remove duplicates
  return [...new Set(matches.map(match => match.slice(1, -1)))];
};

export default function Templates() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [openDialog, setOpenDialog] = useState(false);
  const [deleteId, setDeleteId] = useState('');
  const [openEditDialog, setOpenEditDialog] = useState(false);
  const [currentTemplate, setCurrentTemplate] = useState<Template | null>(null);
  const [publishLoading, setPublishLoading] = useState<string | null>(null);
  const [tabValue, setTabValue] = useState(0);
  
  // Form state
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [prompt, setPrompt] = useState('');
  const [isInteractive, setIsInteractive] = useState(false);
  const [isDeepResearch, setIsDeepResearch] = useState(false);
  
  const { token, user } = useAuth();
  const navigate = useNavigate();

  // Check if user is admin and redirect if not
  useEffect(() => {
    if (user && !user.isAdmin) {
      navigate('/tasks');
    }
  }, [user, navigate]);

  useEffect(() => {
    if (user?.isAdmin) {
      fetchTemplates();
    }
  }, [token, user]);

  const fetchTemplates = async () => {
    setLoading(true);
    try {
      const response = await axios.get(buildApiUrl('/api/templates'), {
        headers: { Authorization: `Bearer ${token}` },
      });
      setTemplates(response.data);
      setError('');
    } catch (err) {
      setError('Failed to fetch templates');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleTabChange = (_event: React.SyntheticEvent, newValue: number) => {
    setTabValue(newValue);
  };

  // Filter templates based on the current tab
  const getFilteredTemplates = () => {
    if (!user) return [];
    
    if (tabValue === 0) {
      // My Templates tab - show only admin's own templates
      return templates.filter(template => template.userId === user.userId);
    } else {
      // Published Templates tab - show all published templates
      return templates.filter(template => template.published);
    }
  };

  const handleOpenDialog = (templateId: string) => {
    setDeleteId(templateId);
    setOpenDialog(true);
  };

  const handleCloseDialog = () => {
    setOpenDialog(false);
    setDeleteId('');
  };

  const handleDelete = async () => {
    try {
      await axios.delete(buildApiUrl(`/api/templates/${deleteId}`), {
        headers: { Authorization: `Bearer ${token}` },
      });
      setTemplates(templates.filter(template => template.templateId !== deleteId));
      handleCloseDialog();
    } catch (err) {
      setError('Failed to delete template');
      console.error(err);
      handleCloseDialog();
    }
  };

  const handleOpenEditDialog = (template: Template | null = null) => {
    if (template) {
      setCurrentTemplate(template);
      setName(template.name);
      setDescription(template.description || '');
      setPrompt(template.prompt);
      setIsInteractive(template.isInteractive);
      setIsDeepResearch(template.isDeepResearch);
    } else {
      setCurrentTemplate({
        templateId: '',
        userId: user?.userId || '',
        name: '',
        description: '',
        prompt: '',
        parameters: [],
        nameParameter: null,
        isInteractive: false,
        isDeepResearch: false,
        published: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
      setName('');
      setDescription('');
      setPrompt('');
      setIsInteractive(false);
      setIsDeepResearch(false);
    }
    setOpenEditDialog(true);
  };

  const handleCloseEditDialog = () => {
    setOpenEditDialog(false);
    setCurrentTemplate(null);
  };

  const handleSubmit = async () => {
    try {
      if (!name || !prompt) {
        setError('Name and prompt are required');
        return;
      }

      // Extract parameters for validation
      const extractedParams = extractParameters(prompt);
      
      const templateData: any = {
        name,
        description,
        prompt,
        isInteractive,
        isDeepResearch,
        nameParameter: currentTemplate?.nameParameter || null
      };

      let response;
      if (currentTemplate) {
        // Update existing template
        const updateResponse = await axios.put<Template>(
          buildApiUrl(`/api/templates/${currentTemplate.templateId}`),
          templateData,
          {
            headers: { Authorization: `Bearer ${token}` },
          }
        );
        
        // Update the templates list
        setTemplates(
          templates.map(template => 
            template.templateId === currentTemplate.templateId ? updateResponse.data : template
          )
        );
      } else {
        // Create new template
        const createResponse = await axios.post<Template>(
          buildApiUrl('/api/templates'),
          templateData,
          {
            headers: { Authorization: `Bearer ${token}` },
          }
        );
        
        // Add the new template to the list
        setTemplates([...templates, createResponse.data]);
      }
      
      handleCloseEditDialog();
    } catch (err) {
      setError(currentTemplate ? 'Failed to update template' : 'Failed to create template');
      console.error(err);
    }
  };

  const handlePublishToggle = async (templateId: string, currentStatus: boolean) => {
    setPublishLoading(templateId);
    try {
      const response = await axios.put(
        buildApiUrl(`/api/templates/${templateId}/publish`),
        { published: !currentStatus },
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      
      // Update the templates list
      setTemplates(
        templates.map(template => 
          template.templateId === templateId ? response.data : template
        )
      );
    } catch (err) {
      setError('Failed to update template publish status');
      console.error(err);
    } finally {
      setPublishLoading(null);
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleString();
  };

  // Check if a template belongs to the current user
  const isOwnTemplate = (template: Template) => {
    return user && template.userId === user.userId;
  };

  const renderTemplateTable = (templates: Template[]) => {
    if (templates.length === 0) {
      return (
        <Alert severity="info" sx={{ mt: 2 }}>
          {tabValue === 0 
            ? "You don't have any templates yet. Create your first template to get started."
            : "No published templates are available."
          }
        </Alert>
      );
    }

    return (
      <TableContainer>
        <Table>
          <TableHead>
            <TableRow>
              <TableCell>Name</TableCell>
              <TableCell>Description</TableCell>
              <TableCell>Parameters</TableCell>
              <TableCell>Status</TableCell>
              <TableCell>Created</TableCell>
              <TableCell>Last Updated</TableCell>
              <TableCell>Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {templates.map((template) => (
              <TableRow key={template.templateId}>
                <TableCell>
                  {template.name}
                  {template.published && (
                    <Tooltip title="This template is published and available to all users">
                      <Chip 
                        icon={<PublicIcon fontSize="small" />}
                        label="Published" 
                        color="success" 
                        size="small"
                        sx={{ ml: 1 }}
                      />
                    </Tooltip>
                  )}
                </TableCell>
                <TableCell>{template.description || '-'}</TableCell>
                <TableCell>
                  {template.parameters && template.parameters.length > 0 ? (
                    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                      {template.parameters.map(param => (
                        <Chip key={param} label={param} size="small" />
                      ))}
                    </Box>
                  ) : (
                    'None'
                  )}
                </TableCell>
                <TableCell>
                  <Button
                    variant={template.published ? "outlined" : "contained"}
                    color={template.published ? "success" : "primary"}
                    size="small"
                    startIcon={template.published ? <PublicOffIcon /> : <PublicIcon />}
                    onClick={() => handlePublishToggle(template.templateId, template.published)}
                    disabled={publishLoading === template.templateId}
                    sx={{ minWidth: '130px' }}
                  >
                    {publishLoading === template.templateId ? (
                      <CircularProgress size={20} />
                    ) : (
                      template.published ? "Unpublish" : "Publish"
                    )}
                  </Button>
                </TableCell>
                <TableCell>{formatDate(template.createdAt)}</TableCell>
                <TableCell>{formatDate(template.updatedAt)}</TableCell>
                <TableCell>
                  <Stack direction="row" spacing={1}>
                    <Tooltip title="Edit Template">
                      <IconButton onClick={() => handleOpenEditDialog(template)}>
                        <EditIcon />
                      </IconButton>
                    </Tooltip>
                    <Tooltip title="Delete Template">
                      <IconButton onClick={() => handleOpenDialog(template.templateId)}>
                        <DeleteIcon />
                      </IconButton>
                    </Tooltip>
                  </Stack>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    );
  };

  // If user is not admin, don't render the page
  if (user && !user.isAdmin) {
    return null;
  }

  return (
    <Container maxWidth="lg">
      <Paper sx={{ p: 4, mt: 4 }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3 }}>
          <Box sx={{ display: 'flex', alignItems: 'center' }}>
            <AdminIcon color="primary" sx={{ mr: 1 }} />
            <Typography variant="h4" component="h1">
              Template Management
            </Typography>
          </Box>
          <Button
            variant="contained"
            color="primary"
            startIcon={<AddIcon />}
            onClick={() => handleOpenEditDialog()}
          >
            Create Template
          </Button>
        </Box>

        <Alert severity="info" sx={{ mb: 3 }}>
          As an admin, you can create and manage templates that will be available to all users when creating tasks.
          Published templates will appear in the task creation page for all users.
        </Alert>

        {error && (
          <Alert severity="error" sx={{ mb: 3 }}>
            {error}
          </Alert>
        )}

        <Tabs 
          value={tabValue} 
          onChange={handleTabChange} 
          sx={{ mb: 3 }}
          variant="fullWidth"
        >
          <Tab label="My Templates" />
          <Tab label="Published Templates" />
        </Tabs>

        {loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', p: 3 }}>
            <CircularProgress />
          </Box>
        ) : (
          renderTemplateTable(getFilteredTemplates())
        )}
      </Paper>

      {/* Delete Confirmation Dialog */}
      <Dialog open={openDialog} onClose={handleCloseDialog}>
        <DialogTitle>Delete Template</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Are you sure you want to delete this template? This action cannot be undone.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleCloseDialog}>Cancel</Button>
          <Button onClick={handleDelete} color="error">
            Delete
          </Button>
        </DialogActions>
      </Dialog>

      {/* Create/Edit Template Dialog */}
      <Dialog open={openEditDialog} onClose={handleCloseEditDialog} maxWidth="md" fullWidth>
        <DialogTitle>
          {currentTemplate ? 'Edit Template' : 'Create Template'}
        </DialogTitle>
        <DialogContent>
          <TextField
            margin="normal"
            required
            fullWidth
            id="name"
            label="Template Name"
            name="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <TextField
            margin="normal"
            fullWidth
            id="description"
            label="Description"
            name="description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            helperText="Optional description of what this template is for"
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
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            helperText="The task instructions in natural language. You can include parameters in the format [parameter_name] that users will be prompted to fill in when creating a task from this template."
          />
          
          {/* Display detected parameters */}
          {prompt && (
            <Box sx={{ mt: 2 }}>
              <Typography variant="subtitle2" gutterBottom>
                Detected Parameters:
              </Typography>
              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                {(() => {
                  const params = extractParameters(prompt);
                  return params.length > 0 ? (
                    params.map((param: string) => (
                      <Chip key={param} label={param} size="small" color="primary" />
                    ))
                  ) : (
                    <Typography variant="body2" color="text.secondary">
                      No parameters detected. Add parameters using the format [parameter_name] in your prompt.
                    </Typography>
                  );
                })()}
              </Box>
              
              {/* Parameter for task name */}
              {extractParameters(prompt).length > 0 && (
                <Box sx={{ mt: 2 }}>
                  <Typography variant="subtitle2" gutterBottom>
                    Parameter for Task Name:
                  </Typography>
                  <Typography variant="body2" color="text.secondary" paragraph>
                    Select a parameter to include in the task name. This helps differentiate tasks created from this template.
                  </Typography>
                  <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
                    <Chip 
                      label="None" 
                      color={currentTemplate?.nameParameter === null ? "primary" : "default"}
                      onClick={() => {
                        setCurrentTemplate(prev => 
                          prev ? { ...prev, nameParameter: null } : null
                        );
                      }}
                    />
                    {extractParameters(prompt).map(param => (
                      <Chip 
                        key={param}
                        label={param}
                        color={currentTemplate?.nameParameter === param ? "primary" : "default"}
                        onClick={() => {
                          setCurrentTemplate(prev => 
                            prev ? { ...prev, nameParameter: param } : null
                          );
                        }}
                      />
                    ))}
                  </Box>
                  <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                    {currentTemplate?.nameParameter 
                      ? `Tasks will be named: "${name} - [${currentTemplate.nameParameter}]"` 
                      : "Tasks will use the template name without modification."}
                  </Typography>
                </Box>
              )}
            </Box>
          )}
          
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
            <Tooltip title="When enabled, the task will use advanced AI to perform comprehensive research">
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
          
        </DialogContent>
        <DialogActions>
          <Button onClick={handleCloseEditDialog}>Cancel</Button>
          <Button onClick={handleSubmit} color="primary">
            {currentTemplate ? 'Update' : 'Create'}
          </Button>
        </DialogActions>
      </Dialog>
    </Container>
  );
} 