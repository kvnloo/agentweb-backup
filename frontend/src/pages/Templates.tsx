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
  Chip
} from '@mui/material';
import { Edit as EditIcon, Delete as DeleteIcon, Add as AddIcon } from '@mui/icons-material';
import axios from 'axios';
import { useAuth } from '../contexts/AuthContext';
import { buildApiUrl } from '../config';

interface Template {
  templateId: string;
  name: string;
  description: string;
  prompt: string;
  parameters: string[];
  isInteractive: boolean;
  isDeepResearch: boolean;
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
  
  // Form state
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [prompt, setPrompt] = useState('');
  const [isInteractive, setIsInteractive] = useState(false);
  const [isDeepResearch, setIsDeepResearch] = useState(false);
  
  const { token } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    fetchTemplates();
  }, [token]);

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
      setCurrentTemplate(null);
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

      const templateData = {
        name,
        description,
        prompt,
        isInteractive,
        isDeepResearch
      };

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

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleString();
  };

  return (
    <Container maxWidth="lg">
      <Paper sx={{ p: 4, mt: 4 }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3 }}>
          <Typography variant="h4" component="h1">
            Task Templates
          </Typography>
          <Button
            variant="contained"
            color="primary"
            startIcon={<AddIcon />}
            onClick={() => handleOpenEditDialog()}
          >
            Create Template
          </Button>
        </Box>

        {error && (
          <Alert severity="error" sx={{ mb: 3 }}>
            {error}
          </Alert>
        )}

        {loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', p: 3 }}>
            <CircularProgress />
          </Box>
        ) : templates.length === 0 ? (
          <Alert severity="info">
            You don't have any templates yet. Create your first template to get started.
          </Alert>
        ) : (
          <TableContainer>
            <Table>
              <TableHead>
                <TableRow>
                  <TableCell>Name</TableCell>
                  <TableCell>Description</TableCell>
                  <TableCell>Parameters</TableCell>
                  <TableCell>Created</TableCell>
                  <TableCell>Last Updated</TableCell>
                  <TableCell>Actions</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {templates.map((template) => (
                  <TableRow key={template.templateId}>
                    <TableCell>{template.name}</TableCell>
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
                    <TableCell>{formatDate(template.createdAt)}</TableCell>
                    <TableCell>{formatDate(template.updatedAt)}</TableCell>
                    <TableCell>
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
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
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