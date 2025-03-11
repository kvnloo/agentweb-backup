import { useState, useEffect } from 'react';
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
  CircularProgress,
  Grid,
  Card,
  CardContent,
  CardActions,
  CardHeader,
  Chip,
  Divider,
  IconButton,
  Collapse,
  Tab,
  Tabs,
} from '@mui/material';
import {
  ExpandMore as ExpandMoreIcon,
  Check as CheckIcon,
  Description as DescriptionIcon,
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
  isComplexTask: boolean;
  published: boolean;
  userId: string;
}

export default function CreateTask() {
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [isInteractive, setIsInteractive] = useState(false);
  const [isDeepResearch, setIsDeepResearch] = useState(false);
  const [isComplexTask, setIsComplexTask] = useState(false);
  const [error, setError] = useState('');
  const [selectedTemplate, setSelectedTemplate] = useState('');
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const [parameterValues, setParameterValues] = useState<Record<string, string>>({});
  const [currentTemplateParams, setCurrentTemplateParams] = useState<string[]>([]);
  const [expandedTemplateId, setExpandedTemplateId] = useState<string | null>(null);
  const [tabValue, setTabValue] = useState(0);
  const { token } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    fetchTemplates();
  }, [token]);

  const fetchTemplates = async () => {
    setLoadingTemplates(true);
    try {
      const response = await axios.get<Template[]>(buildApiUrl('/api/templates'), {
        headers: { Authorization: `Bearer ${token}` },
      });
      setTemplates(response.data);
    } catch (err) {
      console.error('Failed to fetch templates:', err);
    } finally {
      setLoadingTemplates(false);
    }
  };

  const handleTemplateChange = (templateId: string) => {
    // If selecting the same template, deselect it
    if (selectedTemplate === templateId) {
      setSelectedTemplate('');
      setName('');
      setPrompt('');
      setIsInteractive(false);
      setIsDeepResearch(false);
      setIsComplexTask(false);
      setCurrentTemplateParams([]);
      setParameterValues({});
      return;
    }
    
    setSelectedTemplate(templateId);
    
    // Reset parameter values when template changes
    setParameterValues({});
    
    if (!templateId) {
      // Clear form if "None" is selected
      setName('');
      setPrompt('');
      setIsInteractive(false);
      setIsDeepResearch(false);
      setIsComplexTask(false);
      setCurrentTemplateParams([]);
      return;
    }
    
    // Find the selected template
    const template = templates.find(t => t.templateId === templateId);
    if (template) {
      // Populate form with template values
      setName(template.name);
      setPrompt(template.prompt);
      setIsInteractive(template.isInteractive);
      setIsDeepResearch(template.isDeepResearch);
      setIsComplexTask(template.isComplexTask);
      
      // Set current template parameters
      setCurrentTemplateParams(template.parameters || []);
      
      // Initialize parameter values object with empty strings
      const initialParamValues: Record<string, string> = {};
      if (template.parameters) {
        template.parameters.forEach(param => {
          initialParamValues[param] = '';
        });
      }
      setParameterValues(initialParamValues);
    }
  };

  const handleExpandTemplate = (templateId: string) => {
    setExpandedTemplateId(expandedTemplateId === templateId ? null : templateId);
  };

  const handleParameterChange = (param: string, value: string) => {
    setParameterValues(prev => ({
      ...prev,
      [param]: value
    }));
  };

  const handleTabChange = (_event: React.SyntheticEvent, newValue: number) => {
    setTabValue(newValue);
    
    // If switching to "From Scratch" tab, deselect any template
    if (newValue === 1) {
      setSelectedTemplate('');
      setName('');
      setPrompt('');
      setIsInteractive(false);
      setIsDeepResearch(false);
      setIsComplexTask(false);
      setCurrentTemplateParams([]);
      setParameterValues({});
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    // Validate that all parameters have values if a template is selected
    if (selectedTemplate && currentTemplateParams.length > 0) {
      const missingParams = currentTemplateParams.filter(param => !parameterValues[param]);
      if (missingParams.length > 0) {
        setError(`Please provide values for all parameters: ${missingParams.join(', ')}`);
        return;
      }
    }

    try {
      // Email notification is automatically enabled for Deep Research tasks
      const emailNotification = isDeepResearch;
      
      // Get the final prompt with parameters substituted if needed
      const finalPrompt = selectedTemplate && currentTemplateParams.length > 0 
        ? getPreviewPrompt() 
        : prompt;
      
      // Get the template if selected
      const selectedTemplateObj = selectedTemplate 
        ? templates.find(t => t.templateId === selectedTemplate) 
        : null;
      
      const taskData: any = {
        name: selectedTemplateObj ? selectedTemplateObj.name : name,
        prompt: finalPrompt,
        isInteractive: selectedTemplateObj ? selectedTemplateObj.isInteractive : isInteractive,
        isDeepResearch: selectedTemplateObj ? selectedTemplateObj.isDeepResearch : isDeepResearch,
        isComplexTask: selectedTemplateObj ? selectedTemplateObj.isComplexTask : isComplexTask,
        emailNotification
      };
      
      // If a template is selected, include its ID and parameter values
      if (selectedTemplate) {
        taskData.templateId = selectedTemplate;
        if (Object.keys(parameterValues).length > 0) {
          taskData.parameterValues = parameterValues;
        }
      }

      await axios.post(
        buildApiUrl('/api/tasks'),
        taskData,
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      navigate('/tasks');
    } catch (err) {
      setError('Failed to create task');
    }
  };

  // Preview the prompt with parameter values substituted
  const getPreviewPrompt = () => {
    if (!selectedTemplate || currentTemplateParams.length === 0) {
      return prompt;
    }

    const template = templates.find(t => t.templateId === selectedTemplate);
    if (!template) return prompt;

    let previewPrompt = template.prompt;
    currentTemplateParams.forEach(param => {
      const value = parameterValues[param] || `[${param}]`;
      const paramRegex = new RegExp(`\\[${param}\\]`, 'g');
      previewPrompt = previewPrompt.replace(paramRegex, value);
    });

    return previewPrompt;
  };

  // Get the selected template object
  const getSelectedTemplate = () => {
    if (!selectedTemplate) return null;
    return templates.find(t => t.templateId === selectedTemplate) || null;
  };

  // Get the preview task name with parameter value if applicable
  const getPreviewTaskName = () => {
    const template = getSelectedTemplate();
    if (!template) return '';
    
    let taskName = template.name;
    
    // If template has a nameParameter and the parameter has a value, append it to the name
    if (template.nameParameter && 
        parameterValues && 
        parameterValues[template.nameParameter]) {
      taskName = `${taskName} - ${parameterValues[template.nameParameter]}`;
    }
    
    return taskName;
  };

  return (
    <Container maxWidth="lg">
      <Paper sx={{ p: 4, mt: 4 }}>
        <Typography variant="h4" component="h1" gutterBottom>
          Create New Task
        </Typography>
        
        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}

        <Tabs 
          value={tabValue} 
          onChange={handleTabChange} 
          sx={{ mb: 3 }}
          variant="fullWidth"
        >
          <Tab label="From Template" />
          <Tab label="From Scratch" />
        </Tabs>

        {tabValue === 0 && (
          <>
            <Box sx={{ mb: 3 }}>
              <Typography variant="h6">
                Choose a Template
              </Typography>
            </Box>

            {loadingTemplates ? (
              <Box sx={{ display: 'flex', justifyContent: 'center', p: 3 }}>
                <CircularProgress />
              </Box>
            ) : templates.length === 0 ? (
              <Alert severity="info" sx={{ mb: 3 }}>
                No templates are available. Please check back later or create a task from scratch.
              </Alert>
            ) : (
              <Grid container spacing={3} sx={{ mb: 4 }}>
                {templates.map((template) => (
                  <Grid item xs={12} md={6} key={template.templateId}>
                    <Card 
                      variant="outlined" 
                      sx={{ 
                        height: '100%',
                        display: 'flex',
                        flexDirection: 'column',
                        borderColor: selectedTemplate === template.templateId ? 'primary.main' : 'divider',
                        borderWidth: selectedTemplate === template.templateId ? 2 : 1,
                        position: 'relative',
                        '&:hover': {
                          boxShadow: 2
                        }
                      }}
                    >
                      {selectedTemplate === template.templateId && (
                        <Chip 
                          icon={<CheckIcon />} 
                          label="Selected" 
                          color="primary" 
                          size="small"
                          sx={{ 
                            position: 'absolute', 
                            top: 8, 
                            right: 8,
                            zIndex: 1
                          }} 
                        />
                      )}
                      <CardHeader
                        title={template.name}
                        subheader={
                          <Box sx={{ mt: 1 }}>
                            {template.isInteractive && (
                              <Chip 
                                label="Interactive" 
                                size="small" 
                                sx={{ mr: 0.5, mb: 0.5 }} 
                              />
                            )}
                            {template.isDeepResearch && (
                              <Chip 
                                label="Deep Research" 
                                size="small" 
                                sx={{ mr: 0.5, mb: 0.5 }} 
                              />
                            )}
                            {template.parameters && template.parameters.length > 0 && (
                              <Chip 
                                label={`${template.parameters.length} Parameter${template.parameters.length > 1 ? 's' : ''}`} 
                                size="small" 
                                sx={{ mb: 0.5 }} 
                              />
                            )}
                          </Box>
                        }
                      />
                      <CardContent sx={{ flexGrow: 1 }}>
                        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                          {template.description || 'No description provided'}
                        </Typography>
                        <Divider sx={{ my: 1 }} />
                        <Box sx={{ display: 'flex', alignItems: 'center', mb: 1 }}>
                          <DescriptionIcon fontSize="small" sx={{ mr: 1, color: 'text.secondary' }} />
                          <Typography variant="body2" fontWeight="medium">
                            Prompt Preview
                          </Typography>
                          <IconButton
                            size="small"
                            onClick={() => handleExpandTemplate(template.templateId)}
                            sx={{
                              ml: 'auto',
                              transform: expandedTemplateId === template.templateId ? 'rotate(180deg)' : 'rotate(0deg)',
                              transition: 'transform 0.2s'
                            }}
                          >
                            <ExpandMoreIcon />
                          </IconButton>
                        </Box>
                        <Collapse in={expandedTemplateId === template.templateId}>
                          <Typography 
                            variant="body2" 
                            color="text.secondary" 
                            sx={{ 
                              whiteSpace: 'pre-wrap',
                              mb: 2,
                              p: 1,
                              backgroundColor: 'action.hover',
                              borderRadius: 1,
                              maxHeight: '150px',
                              overflow: 'auto'
                            }}
                          >
                            {template.prompt}
                          </Typography>
                          {template.parameters && template.parameters.length > 0 && (
                            <Box sx={{ mt: 1 }}>
                              <Typography variant="body2" fontWeight="medium" gutterBottom>
                                Parameters:
                              </Typography>
                              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                                {template.parameters.map(param => (
                                  <Chip key={param} label={param} size="small" />
                                ))}
                              </Box>
                            </Box>
                          )}
                        </Collapse>
                      </CardContent>
                      <CardActions>
                        <Button 
                          fullWidth 
                          variant={selectedTemplate === template.templateId ? "contained" : "outlined"}
                          onClick={() => handleTemplateChange(template.templateId)}
                        >
                          {selectedTemplate === template.templateId ? "Deselect" : "Use Template"}
                        </Button>
                      </CardActions>
                    </Card>
                  </Grid>
                ))}
              </Grid>
            )}
          </>
        )}

        <Box component="form" onSubmit={handleSubmit}>
          {/* When a template is selected, show parameter inputs and previews */}
          {selectedTemplate && tabValue === 0 && (
            <>
              {/* Parameter inputs when a template with parameters is selected */}
              {currentTemplateParams.length > 0 && (
                <Card variant="outlined" sx={{ mt: 2, mb: 4 }}>
                  <CardContent>
                    <Typography variant="h6" gutterBottom>
                      Template Parameters
                    </Typography>
                    <Typography variant="body2" color="text.secondary" paragraph>
                      Please provide values for the following parameters:
                    </Typography>
                    <Grid container spacing={2}>
                      {currentTemplateParams.map(param => (
                        <Grid item xs={12} sm={6} key={param}>
                          <TextField
                            fullWidth
                            label={param}
                            value={parameterValues[param] || ''}
                            onChange={(e) => handleParameterChange(param, e.target.value)}
                            required
                            helperText={`Value for [${param}]`}
                          />
                        </Grid>
                      ))}
                    </Grid>
                  </CardContent>
                </Card>
              )}

              {/* Preview of task name and prompt */}
              <Card variant="outlined" sx={{ mt: 2, mb: 4 }}>
                <CardContent>
                  <Typography variant="h6" gutterBottom>
                    Task Preview
                  </Typography>
                  <Typography variant="body2" color="text.secondary" paragraph>
                    This is how your task will look with the parameters applied:
                  </Typography>
                  
                  <Box sx={{ mb: 3 }}>
                    <Typography variant="subtitle2" gutterBottom>
                      Task Name:
                    </Typography>
                    <Typography variant="body1" fontWeight="medium">
                      {getPreviewTaskName()}
                    </Typography>
                    {getSelectedTemplate()?.nameParameter && (
                      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                        {parameterValues[getSelectedTemplate()?.nameParameter || ''] 
                          ? `Using parameter [${getSelectedTemplate()?.nameParameter}] in the task name`
                          : `Will include parameter [${getSelectedTemplate()?.nameParameter}] when provided`}
                      </Typography>
                    )}
                  </Box>
                  
                  <Box>
                    <Typography variant="subtitle2" gutterBottom>
                      Task Prompt:
                    </Typography>
                    <Typography 
                      variant="body1" 
                      sx={{ 
                        whiteSpace: 'pre-wrap',
                        p: 2,
                        backgroundColor: 'action.hover',
                        borderRadius: 1
                      }}
                    >
                      {getPreviewPrompt()}
                    </Typography>
                  </Box>
                  
                  <Box sx={{ mt: 3 }}>
                    <Typography variant="subtitle2" gutterBottom>
                      Task Settings:
                    </Typography>
                    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
                      {getSelectedTemplate()?.isInteractive && (
                        <Chip label="Interactive Mode" size="small" />
                      )}
                      {getSelectedTemplate()?.isDeepResearch && (
                        <Chip label="Deep Research" size="small" />
                      )}
                      {getSelectedTemplate()?.isComplexTask && (
                        <Chip label="Complex Task" size="small" />
                      )}
                      {getSelectedTemplate()?.isDeepResearch && (
                        <Chip label="Email Notifications" size="small" />
                      )}
                    </Box>
                  </Box>
                </CardContent>
              </Card>
            </>
          )}

          {/* When no template is selected or in "From Scratch" tab, show editable fields */}
          {(tabValue === 1) && (
            <>
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
                        disabled={isDeepResearch}
                      />
                    }
                    label="Interactive Mode"
                    sx={{ opacity: isDeepResearch ? 0.5 : 1 }}
                  />
                </Tooltip>
                <Tooltip title="When enabled, the task will use advanced AI to perform comprehensive research on your topic using public web data only. Currently does not use your uploads or web accounts (Config), but will support these in the future.">
                  <FormControlLabel
                    control={
                      <Switch
                        checked={isDeepResearch}
                        onChange={(e) => {
                          setIsDeepResearch(e.target.checked);
                          // If Deep Research is enabled, disable Interactive Mode and Complex Task
                          if (e.target.checked) {
                            setIsInteractive(false);
                            setIsComplexTask(false);
                          }
                        }}
                        color="primary"
                      />
                    }
                    label="Perform Deep Research"
                  />
                </Tooltip>
                <Tooltip title="When enabled, the task will use a more complex system prompt and have a higher step limit for handling complex tasks">
                  <FormControlLabel
                    control={
                      <Switch
                        checked={isComplexTask}
                        onChange={(e) => setIsComplexTask(e.target.checked)}
                        color="primary"
                        disabled={isDeepResearch}
                      />
                    }
                    label="Complex Task"
                    sx={{ opacity: isDeepResearch ? 0.5 : 1 }}
                  />
                </Tooltip>
              </Box>
              {isDeepResearch && (
                <Alert severity="info" sx={{ mt: 2 }}>
                  Deep Research Mode is enabled. When you run this task, it will use advanced AI to perform comprehensive research on your topic using public web data only. Currently does not use your uploads or web accounts (Config), but will support these in the future. Email notifications are automatically enabled for Deep Research tasks. Interactive Mode and Complex Task options are not applicable for Deep Research tasks.
                </Alert>
              )}
            </>
          )}

          {/* Show a message when on From Template tab but no template is selected */}
          {tabValue === 0 && !selectedTemplate && (
            <Alert severity="info" sx={{ mt: 2, mb: 2 }}>
              Please select a template from the options above to continue.
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
              disabled={tabValue === 0 && !selectedTemplate}
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