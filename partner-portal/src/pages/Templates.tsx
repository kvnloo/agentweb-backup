import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
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
  InputLabel,
  Select,
  MenuItem,
  FormControl,
} from "@mui/material";
import {
  Edit as EditIcon,
  Delete as DeleteIcon,
  Add as AddIcon,
  Public as PublicIcon,
  PublicOff as PublicOffIcon,
  AdminPanelSettings as AdminIcon,
  ArrowUpward as ArrowUpwardIcon,
  ArrowDownward as ArrowDownwardIcon,
} from "@mui/icons-material";
import axios from "axios";
import { useAuth } from "../contexts/AuthContext";
import { buildApiUrl } from "../config";
import { AVAILABLE_LLMS } from "../config";

// Define supported categories
const SUPPORTED_CATEGORIES = [
  "Market Research",
  "Creative Research",
  "Social Listening",
  "Productivity",
  "Life",
  "Data Analysis",
  "Custom", // Allows free text input
];

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
  createdAt: string;
  updatedAt: string;
  category?: string; // Added category
  outputAsJson?: boolean; // Added for JSON output
  outputAsHtml?: boolean; // Added for HTML output
  selectedLLMs?: string[]; // Added for LLM selection
  useSharedBrowser?: boolean; // ADDED: Flag for using shared browser
  turnOffHeadless?: boolean;
  isAgenticDevMode?: boolean;
}

// Helper function to extract parameters from prompt
const extractParameters = (prompt: string): string[] => {
  const paramRegex = /\[([^\]]+)\]/g;
  const matches = prompt.match(paramRegex) || [];

  // Extract parameter names without brackets and remove duplicates
  return [...new Set(matches.map((match) => match.slice(1, -1)))];
};

export default function Templates() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [openDialog, setOpenDialog] = useState(false);
  const [deleteId, setDeleteId] = useState("");
  const [openEditDialog, setOpenEditDialog] = useState(false);
  const [currentTemplate, setCurrentTemplate] = useState<Template | null>(null);
  const [publishLoading, setPublishLoading] = useState<string | null>(null);
  const [selectedNameParameter, setSelectedNameParameter] = useState<
    string | null
  >(null);
  const [category, setCategory] = useState(""); // Added category state for form
  const [customCategory, setCustomCategory] = useState(""); // Added for custom category input

  // Form state
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [prompt, setPrompt] = useState("");
  const [isInteractive, setIsInteractive] = useState(false);
  const [isDeepResearch, setIsDeepResearch] = useState(false);
  const [isComplexTask, setIsComplexTask] = useState(false);
  const [outputAsJson, setOutputAsJson] = useState(false); // New state for JSON output
  const [outputAsHtml, setOutputAsHtml] = useState(false); // New state for HTML output
  const [selectedLLMs, setSelectedLLMs] = useState<string[]>([]); // New state for selected LLMs
  const [useSharedBrowser, setUseSharedBrowser] = useState(false); // ADDED: State for the toggle
  const [turnOffHeadless, setTurnOffHeadless] = useState(false);
  const [isAgenticDevMode, setIsAgenticDevMode] = useState(false);

  const { token, user } = useAuth();
  const navigate = useNavigate();

  // Check if user is admin and redirect if not
  useEffect(() => {
    if (user && !user.isAdmin) {
      navigate("/tasks");
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
      const response = await axios.get(buildApiUrl("/api/templates"), {
        headers: { Authorization: `Bearer ${token}` },
      });
      setTemplates(response.data);
      setError("");
    } catch (err) {
      setError("Failed to fetch templates");
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
    setDeleteId("");
  };

  const handleDelete = async () => {
    try {
      await axios.delete(buildApiUrl(`/api/templates/${deleteId}`), {
        headers: { Authorization: `Bearer ${token}` },
      });
      setTemplates(
        templates.filter((template) => template.templateId !== deleteId)
      );
      handleCloseDialog();
    } catch (err) {
      setError("Failed to delete template");
      console.error(err);
      handleCloseDialog();
    }
  };

  const handleOpenEditDialog = (template: Template | null = null) => {
    if (template) {
      setCurrentTemplate(template);
      setName(template.name);
      setDescription(template.description || "");
      setPrompt(template.prompt);
      setIsInteractive(template.isInteractive);
      setIsDeepResearch(template.isDeepResearch);
      setIsComplexTask(template.isComplexTask);
      setSelectedNameParameter(template.nameParameter);
      setCategory(template.category || "");
      setOutputAsJson(template.outputAsJson || false);
      setOutputAsHtml(template.outputAsHtml || false);
      setSelectedLLMs(template.selectedLLMs || []);
      setUseSharedBrowser(template.useSharedBrowser || false);
      setTurnOffHeadless(template.turnOffHeadless || false);
      setIsAgenticDevMode(template.isAgenticDevMode || false);
      if (template.category && !SUPPORTED_CATEGORIES.includes(template.category)) {
        setCustomCategory(template.category);
        setCategory("Custom");
      } else {
        setCustomCategory("");
      }
    } else {
      setCurrentTemplate(null);
      setName("");
      setDescription("");
      setPrompt("");
      setIsInteractive(false);
      setIsDeepResearch(false);
      setIsComplexTask(false);
      setSelectedNameParameter(null);
      setCategory("");
      setCustomCategory("");
      setOutputAsJson(false);
      setOutputAsHtml(false);
      setSelectedLLMs([]);
      setUseSharedBrowser(false);
      setTurnOffHeadless(false);
      setIsAgenticDevMode(false);
    }
    setOpenEditDialog(true);
  };

  const handleCloseEditDialog = () => {
    setOpenEditDialog(false);
    setCurrentTemplate(null);
    setSelectedNameParameter(null);
    setCategory("");
    setCustomCategory("");
    setSelectedLLMs([]); // Clear selected LLMs on close
  };

  const handleSubmit = async () => {
    try {
      if (!name || !prompt) {
        setError("Name and prompt are required");
        return;
      }

      const finalCategory = category === "Custom" ? customCategory : category;

      const templateData: any = {
        name,
        description,
        prompt,
        isInteractive,
        isDeepResearch,
        isComplexTask,
        nameParameter: selectedNameParameter,
        outputAsJson: outputAsJson,
        outputAsHtml: outputAsHtml,
        selectedLLMs: selectedLLMs,
        useSharedBrowser: useSharedBrowser,
        turnOffHeadless: turnOffHeadless,
        isAgenticDevMode: isAgenticDevMode,
      };

      // Set category - if empty, set to empty string
      templateData.category = finalCategory || '';

      // Check if we're updating an existing template (has a valid templateId)
      if (
        currentTemplate &&
        currentTemplate.templateId &&
        currentTemplate.templateId.length > 0
      ) {
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
          templates.map((template) =>
            template.templateId === currentTemplate.templateId
              ? updateResponse.data
              : template
          )
        );
      } else {
        // Create new template
        const createResponse = await axios.post<Template>(
          buildApiUrl("/api/templates"),
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
      setError(
        currentTemplate
          ? "Failed to update template"
          : "Failed to create template"
      );
      console.error(err);
    }
  };

  const handleMoveLLM = (index: number, direction: "up" | "down") => {
    if (direction === "up" && index > 0) {
      const newLLMs = [...selectedLLMs];
      [newLLMs[index - 1], newLLMs[index]] = [
        newLLMs[index],
        newLLMs[index - 1],
      ];
      setSelectedLLMs(newLLMs);
    } else if (direction === "down" && index < selectedLLMs.length - 1) {
      const newLLMs = [...selectedLLMs];
      [newLLMs[index + 1], newLLMs[index]] = [
        newLLMs[index],
        newLLMs[index + 1],
      ];
      setSelectedLLMs(newLLMs);
    }
  };

  const handlePublishToggle = async (
    templateId: string,
    currentStatus: boolean
  ) => {
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
        templates.map((template) =>
          template.templateId === templateId ? response.data : template
        )
      );
    } catch (err) {
      setError("Failed to update template publish status");
      console.error(err);
    } finally {
      setPublishLoading(null);
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleString();
  };

  // If user is not admin, don't render the page
  if (user && !user.isAdmin) {
    return null;
  }

  const renderTemplateTable = () => {
    if (templates.length === 0) {
      return (
        <Alert severity="info" sx={{ mt: 2 }}>
          You don't have any templates yet. Create your first template to get
          started.
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
              <TableCell>Category</TableCell>
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
                  {template.nameParameter && (
                    <Tooltip
                      title={`Uses parameter [${template.nameParameter}] in task name`}
                    >
                      <Chip label="Named" size="small" sx={{ ml: 1 }} />
                    </Tooltip>
                  )}
                </TableCell>
                <TableCell>{template.description || "-"}</TableCell>
                <TableCell>
                  {template.category ? (
                    <Chip label={template.category} size="small" />
                  ) : (
                    "-"
                  )}
                </TableCell>
                <TableCell>
                  {template.parameters && template.parameters.length > 0 ? (
                    <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5 }}>
                      {template.parameters.map((param) => (
                        <Chip key={param} label={param} size="small" />
                      ))}
                    </Box>
                  ) : (
                    "None"
                  )}
                </TableCell>
                <TableCell>
                  <Button
                    variant={template.published ? "outlined" : "contained"}
                    color={template.published ? "success" : "primary"}
                    size="small"
                    startIcon={
                      template.published ? <PublicOffIcon /> : <PublicIcon />
                    }
                    onClick={() =>
                      handlePublishToggle(
                        template.templateId,
                        template.published
                      )
                    }
                    disabled={publishLoading === template.templateId}
                    sx={{ minWidth: "130px" }}
                  >
                    {publishLoading === template.templateId ? (
                      <CircularProgress size={20} />
                    ) : template.published ? (
                      "Unpublish"
                    ) : (
                      "Publish"
                    )}
                  </Button>
                </TableCell>
                <TableCell>{formatDate(template.createdAt)}</TableCell>
                <TableCell>{formatDate(template.updatedAt)}</TableCell>
                <TableCell>
                  <Stack direction="row" spacing={1}>
                    <Tooltip title="Edit Template">
                      <IconButton
                        onClick={() => handleOpenEditDialog(template)}
                      >
                        <EditIcon />
                      </IconButton>
                    </Tooltip>
                    <Tooltip title="Delete Template">
                      <IconButton
                        onClick={() => handleOpenDialog(template.templateId)}
                      >
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

  return (
    <Container maxWidth="lg">
      <Paper sx={{ p: 4, mt: 4 }}>
        <Box
          sx={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            mb: 3,
          }}
        >
          <Box sx={{ display: "flex", alignItems: "center" }}>
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
          As an admin, you can create and manage templates that will be
          available to all users when creating tasks. Published templates will
          appear in the task creation page for all users.
        </Alert>

        {error && (
          <Alert severity="error" sx={{ mb: 3 }}>
            {error}
          </Alert>
        )}

        {loading ? (
          <Box sx={{ display: "flex", justifyContent: "center", p: 3 }}>
            <CircularProgress />
          </Box>
        ) : (
          renderTemplateTable()
        )}
      </Paper>

      {/* Delete Confirmation Dialog */}
      <Dialog open={openDialog} onClose={handleCloseDialog}>
        <DialogTitle>Delete Template</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Are you sure you want to delete this template? This action cannot be
            undone.
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
      <Dialog
        open={openEditDialog}
        onClose={handleCloseEditDialog}
        maxWidth="md"
        fullWidth
      >
        <DialogTitle>
          {currentTemplate ? "Edit Template" : "Create Template"}
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
          <FormControl fullWidth margin="dense">
            <InputLabel id="category-select-label">Category</InputLabel>
            <Select
              labelId="category-select-label"
              value={category}
              label="Category"
              onChange={(e) => setCategory(e.target.value as string)}
            >
              <MenuItem value="">
                <em>(None)</em>
              </MenuItem>
              {SUPPORTED_CATEGORIES.map((cat) => (
                <MenuItem key={cat} value={cat}>
                  {cat}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          {category === "Custom" && (
            <TextField
              margin="dense"
              label="Custom Category Name"
              type="text"
              fullWidth
              variant="outlined"
              value={customCategory}
              onChange={(e) => setCustomCategory(e.target.value)}
              required
            />
          )}
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

          {/* LLM Selection */}
          <FormControl fullWidth margin="normal">
            <InputLabel id="llm-select-label">
              Allowed LLMs (Optional)
            </InputLabel>
            <Select
              labelId="llm-select-label"
              id="llm-select"
              multiple
              value={selectedLLMs}
              onChange={(event) =>
                setSelectedLLMs(event.target.value as string[])
              }
              label="Allowed LLMs (Optional)"
              renderValue={(selected) => (
                <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5 }}>
                  {(selected as string[]).map((value) => (
                    <Chip
                      key={value}
                      label={value.split("->").pop() || value}
                    /> // Display only the model name part
                  ))}
                </Box>
              )}
            >
              {AVAILABLE_LLMS.map((llm: string) => {
                const [provider, vendor, modelName] = llm.split("->");
                const displayName = modelName || llm; // Fallback to full name if parsing fails
                return (
                  <MenuItem
                    key={llm}
                    value={llm}
                    selected={selectedLLMs.includes(llm)}
                  >
                    {`${displayName} (${provider}/${vendor})`}
                  </MenuItem>
                );
              })}
            </Select>
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ mt: 0.5 }}
            >
              Select specific LLMs to be available for tasks created from this
              template. If none are selected, all allowed LLMs for the task type
              will be available.
            </Typography>
          </FormControl>

          {/* UI for reordering selected LLMs */}
          {selectedLLMs.length > 0 && (
            <Box
              sx={{
                mt: 2,
                p: 2,
                border: "1px solid",
                borderColor: "divider",
                borderRadius: 1,
              }}
            >
              <Typography variant="subtitle2" gutterBottom>
                Selected LLMs Order (Drag to reorder coming soon)
              </Typography>
              {selectedLLMs.map((llm, index) => {
                const [, , modelName] = llm.split("->");
                const displayName = modelName || llm;
                return (
                  <Box
                    key={llm}
                    sx={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      mb: 1,
                      p: 1,
                      backgroundColor: "action.hover",
                      borderRadius: 1,
                    }}
                  >
                    <Typography variant="body2">{`${
                      index + 1
                    }. ${displayName}`}</Typography>
                    <Box>
                      <IconButton
                        size="small"
                        onClick={() => handleMoveLLM(index, "up")}
                        disabled={index === 0}
                      >
                        <ArrowUpwardIcon fontSize="inherit" />
                      </IconButton>
                      <IconButton
                        size="small"
                        onClick={() => handleMoveLLM(index, "down")}
                        disabled={index === selectedLLMs.length - 1}
                      >
                        <ArrowDownwardIcon fontSize="inherit" />
                      </IconButton>
                    </Box>
                  </Box>
                );
              })}
            </Box>
          )}

          {/* Display detected parameters */}
          {prompt && (
            <Box sx={{ mt: 2 }}>
              <Typography variant="subtitle2" gutterBottom>
                Detected Parameters:
              </Typography>
              <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5 }}>
                {(() => {
                  const params = extractParameters(prompt);
                  return params.length > 0 ? (
                    params.map((param: string) => (
                      <Chip
                        key={param}
                        label={param}
                        size="small"
                        color="primary"
                      />
                    ))
                  ) : (
                    <Typography variant="body2" color="text.secondary">
                      No parameters detected. Add parameters using the format
                      [parameter_name] in your prompt.
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
                    Select a parameter to include in the task name. This helps
                    differentiate tasks created from this template.
                  </Typography>
                  <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1 }}>
                    <Chip
                      label="None"
                      color={
                        selectedNameParameter === null ? "primary" : "default"
                      }
                      onClick={() => setSelectedNameParameter(null)}
                    />
                    {extractParameters(prompt).map((param) => (
                      <Chip
                        key={param}
                        label={param}
                        color={
                          selectedNameParameter === param
                            ? "primary"
                            : "default"
                        }
                        onClick={() => setSelectedNameParameter(param)}
                      />
                    ))}
                  </Box>
                  <Typography
                    variant="body2"
                    color="text.secondary"
                    sx={{ mt: 1 }}
                  >
                    {selectedNameParameter
                      ? `Tasks will be named: "${name} - [${selectedNameParameter}]"`
                      : "Tasks will use the template name without modification."}
                  </Typography>
                </Box>
              )}
            </Box>
          )}

          <Box sx={{ mt: 2, display: "flex", flexDirection: "column", gap: 1 }}>
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
            <Tooltip title="When enabled, the task will use advanced AI to perform comprehensive research">
              <FormControlLabel
                control={
                  <Switch
                    checked={isDeepResearch}
                    onChange={(e) => {
                      setIsDeepResearch(e.target.checked);
                      // If Deep Research is enabled, disable Interactive Mode
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
            <Tooltip title="When enabled, the task will allow the agent to take up to 100 steps (instead of the default 25) to complete complex tasks that require more actions">
              <FormControlLabel
                control={
                  <Switch
                    checked={isComplexTask}
                    onChange={(e) => setIsComplexTask(e.target.checked)}
                    color="primary"
                    disabled={isDeepResearch}
                  />
                }
                label="Complex Task (more steps)"
              />
            </Tooltip>
            <FormControlLabel
              control={
                <Switch
                  checked={outputAsJson}
                  onChange={(e) => {
                    setOutputAsJson(e.target.checked);
                    if (e.target.checked) setOutputAsHtml(false);
                  }}
                />
              }
              label="Output as JSON"
              disabled={isDeepResearch}
            />
            <FormControlLabel
              control={
                <Switch
                  checked={outputAsHtml}
                  onChange={(e) => {
                    setOutputAsHtml(e.target.checked);
                    if (e.target.checked) setOutputAsJson(false);
                  }}
                />
              }
              label="Output as HTML5"
              disabled={isDeepResearch}
            />
            <FormControlLabel
              control={
                <Switch
                  checked={useSharedBrowser}
                  onChange={(e) => setUseSharedBrowser(e.target.checked)}
                />
              }
              label="Use Shared Browser"
              disabled={isDeepResearch}
            />
            <FormControlLabel
              control={
                <Switch
                  checked={turnOffHeadless}
                  onChange={(e) => setTurnOffHeadless(e.target.checked)}
                />
              }
              label="Turn Off Headless"
              disabled={isDeepResearch}
            />
            <Tooltip title="Enable Agentic Dev Mode for running templated tasks successfully">
              <FormControlLabel
                control={
                  <Switch
                    checked={isAgenticDevMode}
                    onChange={(e) => setIsAgenticDevMode(e.target.checked)}
                  />
                }
                label="Agentic Dev Mode"
              />
            </Tooltip>
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleCloseEditDialog}>Cancel</Button>
          <Button onClick={handleSubmit} color="primary">
            {currentTemplate ? "Update" : "Create"}
          </Button>
        </DialogActions>
      </Dialog>
    </Container>
  );
}
