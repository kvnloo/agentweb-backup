import { useState, useEffect, useCallback, ChangeEvent } from "react";
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
  InputAdornment,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  TextField,
  FormControlLabel,
  Switch,
  Tooltip,
  Alert,
  CircularProgress,
  Chip,
  Stack,
  Autocomplete,
  Divider,
} from "@mui/material";
import {
  Edit as EditIcon,
  Add as AddIcon,
  AdminPanelSettings as AdminIcon,

  Close as CloseIcon,
  Delete as DeleteIcon,
  CheckBoxOutlineBlank as CheckBoxOutlineBlankIcon,
  CheckBox as CheckBoxIcon,
  Search as SearchIcon,
} from "@mui/icons-material";
import axios from "axios";
import { useAuth } from "../contexts/AuthContext";
import { buildApiUrl } from "../config";
import skillService, { Skill } from "../services/skillService";

interface ToolParameter {
  type: string;
  properties?: Record<string, { type: string; description?: string }>;
  required?: string[];
  [key: string]: unknown;
}

interface AvailableTool {
  name: string;
  description: string;
  parameters?: ToolParameter;
}

export default function Skills() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [availableTools, setAvailableTools] = useState<AvailableTool[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [openEditDialog, setOpenEditDialog] = useState(false);
  const [openDeleteDialog, setOpenDeleteDialog] = useState(false);
  const [currentSkill, setCurrentSkill] = useState<Partial<Skill> | null>(null);
  const [skillToDelete, setSkillToDelete] = useState<Skill | null>(null);
  const [searchText, setSearchText] = useState("");
  
  // Form state
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [toolNames, setToolNames] = useState<string[]>([]);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [isPublished, setIsPublished] = useState(false);
  const [toolSearchText, setToolSearchText] = useState("");
  const [saving, setSaving] = useState(false);

  const { token } = useAuth();

  const fetchSkills = useCallback(async () => {
    setLoading(true);
    try {
      const data = await skillService.getAllSkills(token!);
      setSkills(data);
    } catch (err) {
      setError("Failed to fetch skills");
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [token]);

  const fetchTools = useCallback(async () => {
    try {
      const response = await axios.get(buildApiUrl("/api/agent-mode/function-calls?forSkillConfig=true"), {
        headers: { Authorization: `Bearer ${token}` },
      });
      const allTools = (response.data.functionCalls as AvailableTool[]) || [];
      // Filter out internal/infrastructure tools
      setAvailableTools(allTools.filter(t => t.name !== 'explore_skills' && t.name !== 'mcpservers_fetch' && t.name !== 'install_skills'));
    } catch (err) {
      console.error("Failed to fetch available tools", err);
    }
  }, [token]);

  useEffect(() => {
    if (token) {
      fetchSkills();
      fetchTools();
    }
  }, [token, fetchSkills, fetchTools]);

  const handleOpenEditDialog = (skill: Skill | null = null) => {
    if (skill) {
      setCurrentSkill(skill);
      setName(skill.name);
      setDescription(skill.description);
      setToolNames(skill.toolNames || []);
      setSystemPrompt(skill.systemPrompt || "");
      setIsPublished(skill.isPublished);
    } else {
      setCurrentSkill(null);
      setName("");
      setDescription("");
      setToolNames([]);
      setSystemPrompt("");
      setIsPublished(false);
    }
    setToolSearchText("");
    setOpenEditDialog(true);
  };

  const handleCloseEditDialog = () => {
    setOpenEditDialog(false);
    setCurrentSkill(null);
  };

  const handleSubmit = async () => {
    if (!name || !description) {
      setError("Name and description are required");
      return;
    }

    setSaving(true);
    try {
      const skillData = {
        name,
        description,
        toolNames,
        systemPrompt,
        isPublished,
      };

      if (currentSkill && currentSkill.skillId) {
        await skillService.updateSkill(currentSkill.skillId, skillData, token!);
      } else {
        await skillService.createSkill(skillData, token!);
      }
      fetchSkills();
      handleCloseEditDialog();
    } catch (err) {
      setError("Failed to save skill");
      console.error(err);
    } finally {
      setSaving(false);
    }
  };

  const handleOpenDeleteDialog = (skill: Skill) => {
    setSkillToDelete(skill);
    setOpenDeleteDialog(true);
  };

  const handleCloseDeleteDialog = () => {
    setOpenDeleteDialog(false);
    setSkillToDelete(null);
  };

  const handleDelete = async () => {
    if (!skillToDelete) return;

    try {
      await skillService.deleteSkill(skillToDelete.skillId, token!);
      setSkills((prev: Skill[]) => prev.filter((s: Skill) => s.skillId !== skillToDelete.skillId));
      handleCloseDeleteDialog();
    } catch (err) {
      setError("Failed to delete skill");
      console.error(err);
    }
  };



  const filteredSkills = skills.filter(skill => 
    skill.name.toLowerCase().includes(searchText.toLowerCase()) || 
    skill.description.toLowerCase().includes(searchText.toLowerCase()) ||
    (skill.toolNames && skill.toolNames.some(tool => tool.toLowerCase().includes(searchText.toLowerCase())))
  );

  // Compute unused tools (tools not assigned to any skill)
  const usedToolNames = new Set<string>();
  skills.forEach(skill => {
    skill.toolNames?.forEach(t => usedToolNames.add(t));
  });
  const unusedTools = availableTools.filter(t => !usedToolNames.has(t.name));

  return (
    <Container maxWidth="lg">
      <Paper sx={{ p: 4, mt: 4 }}>
        <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", mb: 3 }}>
          <Box sx={{ display: "flex", alignItems: "center" }}>
            <AdminIcon color="primary" sx={{ mr: 1 }} />
            <Typography variant="h4" component="h1">
              Skill Management
            </Typography>
          </Box>
          <Button
            variant="contained"
            color="primary"
            startIcon={<AddIcon />}
            onClick={() => handleOpenEditDialog()}
          >
            Create Skill
          </Button>
        </Box>

        {error && <Alert severity="error" sx={{ mb: 3 }} onClose={() => setError("")}>{error}</Alert>}

        <Box sx={{ mb: 3, display: 'flex', justifyContent: 'flex-start' }}>
          <TextField
            size="small"
            sx={{ maxWidth: 400, width: '100%' }}
            variant="outlined"
            placeholder="Search skills by name, description or tools..."
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon color="action" />
                </InputAdornment>
              ),
              endAdornment: searchText && (
                <InputAdornment position="end">
                  <IconButton size="small" onClick={() => setSearchText("")}>
                    <CloseIcon />
                  </IconButton>
                </InputAdornment>
              )
            }}
          />
        </Box>

        {loading ? (
          <Box sx={{ display: "flex", justifyContent: "center", p: 3 }}>
            <CircularProgress />
          </Box>
        ) : (
          <TableContainer>
            <Table>
              <TableHead>
                <TableRow>
                  <TableCell>Name</TableCell>
                  <TableCell>Description</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell>Tools</TableCell>
                  <TableCell>Actions</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {filteredSkills.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} align="center" sx={{ py: 3 }}>
                      <Typography variant="body1" color="text.secondary">
                        {searchText ? `No skills matching "${searchText}"` : "No Skills Defined"}
                      </Typography>
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredSkills.map((skill: Skill) => (
                    <TableRow key={skill.skillId}>
                      <TableCell sx={{ fontWeight: "bold" }}>{skill.name}</TableCell>
                      <TableCell sx={{ maxWidth: 300 }}>
                        <Tooltip 
                          title={skill.description} 
                          arrow 
                          placement="top-start"
                          slotProps={{
                            tooltip: {
                              sx: {
                                fontSize: '0.9rem',
                                maxWidth: 400,
                                padding: '6px 10px'
                              }
                            }
                          }}
                        >
                          <Typography variant="body2" noWrap sx={{ overflow: "hidden", textOverflow: "ellipsis", cursor: 'default' }}>
                            {skill.description}
                          </Typography>
                        </Tooltip>
                      </TableCell>
                      <TableCell>
                        <Chip 
                          label={skill.isPublished ? "Published" : "Draft"} 
                          color={skill.isPublished ? "success" : "default"}
                          size="small"
                        />
                      </TableCell>
                      <TableCell>
                        {skill.toolNames?.map((tool: string) => (
                          <Chip key={tool} label={tool} size="small" sx={{ mr: 0.5, mb: 0.5 }} />
                        )) || "None"}
                      </TableCell>
                      <TableCell>
                        <Stack direction="row" spacing={1}>
                          <Tooltip title="Edit Skill">
                            <IconButton onClick={() => handleOpenEditDialog(skill)}>
                              <EditIcon />
                            </IconButton>
                          </Tooltip>
                          <Tooltip title="Delete Skill">
                            <IconButton onClick={() => handleOpenDeleteDialog(skill)} color="error">
                              <DeleteIcon />
                            </IconButton>
                          </Tooltip>
                        </Stack>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </Paper>

      {!loading && unusedTools.length > 0 && (
        <Alert severity="warning" sx={{ mt: 3, mb: 4 }}>
          <Typography variant="subtitle2" sx={{ mb: 1, fontWeight: 'bold' }}>
            {unusedTools.length} tool(s) not assigned to any skill:
          </Typography>
          <Typography variant="body2" sx={{ mb: 1.5 }}>
            These tools are automatically grouped into a virtual "other_skills" skill, making them available to Emma even without an explicit skill assignment.
          </Typography>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
            {unusedTools.map(tool => (
              <Tooltip key={tool.name} title={tool.description} arrow>
                <Chip label={tool.name} size="small" color="warning" variant="outlined" />
              </Tooltip>
            ))}
          </Box>
        </Alert>
      )}

      {/* Create/Edit Skill Dialog */}
      <Dialog open={openEditDialog} onClose={handleCloseEditDialog} maxWidth="md" fullWidth>
        <DialogTitle sx={{ m: 0, p: 2, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          {currentSkill ? "Edit Skill" : "Create Skill"}
          <IconButton
            aria-label="close"
            onClick={handleCloseEditDialog}
            sx={{
              color: (theme) => theme.palette.grey[500],
            }}
          >
            <CloseIcon />
          </IconButton>
        </DialogTitle>
        <DialogContent sx={{ pt: 1 }}>
          <TextField
            margin="dense"
            required
            fullWidth
            label="Skill Name"
            value={name}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
          />
          <TextField
            margin="normal"
            required
            fullWidth
            label="Description"
            multiline
            rows={2}
            value={description}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setDescription(e.target.value)}
          />

          <TextField
            margin="normal"
            fullWidth
            label="System Prompt (Modular Instructions)"
            multiline
            rows={6}
            value={systemPrompt}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setSystemPrompt(e.target.value)}
            helperText="Detailed instructions and SOPs to be injected into Emma's prompt when this skill is associated."
          />

          <Divider sx={{ my: 3 }} />
          
          <Box sx={{ mb: 2 }}>
            <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
              <Typography variant="subtitle2" color="text.secondary">
                Tools Configuration
              </Typography>
              <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 'bold' }}>
                {toolNames.length} of {availableTools.length} tools selected
              </Typography>
            </Stack>
            <Autocomplete
              multiple
              disableCloseOnSelect
              options={availableTools}
              getOptionLabel={(option) => option.name}
              value={availableTools.filter(t => toolNames.includes(t.name))}
              inputValue={toolSearchText}
              onInputChange={(_, newInputValue, reason) => {
                if (reason === 'input') {
                  setToolSearchText(newInputValue);
                }
              }}
              onChange={(_, newValue) => {
                setToolNames(newValue.map(v => v.name));
              }}
              onClose={() => setToolSearchText("")}
              // Removed filterSelectedOptions to keep the list stable with search
              slotProps={{
                paper: {
                  sx: {
                    mt: 1,
                    backgroundColor: '#f5f7ff',
                    boxShadow: '0px 10px 30px rgba(0,0,0,0.2)',
                    border: '1px solid rgba(144, 156, 255, 0.2)',
                    '& .MuiAutocomplete-listbox': {
                      maxHeight: '400px'
                    }
                  }
                }
              }}
              renderInput={(params) => (
                <TextField
                  {...params}
                  label="Select Tools"
                  placeholder="Search tools..."
                  helperText="Search and assign tools that this skill provides access to."
                />
              )}
              renderOption={(props, option, { selected }) => (
                <li {...props}>
                  <Box 
                    component="span" 
                    sx={{ 
                      display: 'flex', 
                      alignItems: 'center', 
                      width: '100%',
                      py: 0.5 
                    }}
                  >
                    <Stack direction="row" spacing={1} alignItems="center" sx={{ width: '100%' }}>
                      <Box sx={{ display: 'flex', alignItems: 'center', mr: 1 }}>
                        {selected ? (
                          <CheckBoxIcon color="primary" fontSize="small" />
                        ) : (
                          <CheckBoxOutlineBlankIcon fontSize="small" color="action" />
                        )}
                      </Box>
                      <Box sx={{ flexGrow: 1 }}>
                        <Typography variant="subtitle2" sx={{ fontWeight: selected ? 'bold' : 'normal' }}>
                          {option.name}
                        </Typography>
                        <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                          {option.description}
                        </Typography>
                      </Box>
                    </Stack>
                  </Box>
                </li>
              )}
              renderTags={(tagValue, getTagProps) =>
                tagValue.map((option, index) => (
                  <Chip
                    label={option.name}
                    {...getTagProps({ index })}
                    color="primary"
                    variant="outlined"
                    size="small"
                  />
                ))
              }
            />
          </Box>

          <Box sx={{ mt: 3 }}>
            <FormControlLabel
              control={<Switch checked={isPublished} onChange={(e: ChangeEvent<HTMLInputElement>) => setIsPublished(e.target.checked)} />}
              label={isPublished ? "Published (Available to Emma)" : "Draft (Not available to Emma)"}
            />
          </Box>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={handleCloseEditDialog} color="inherit">Cancel</Button>
          <Button onClick={handleSubmit} variant="contained" color="primary" sx={{ minWidth: 120 }} disabled={saving}>
            {saving ? <CircularProgress size={20} color="inherit" /> : (currentSkill ? "Save Changes" : "Create Skill")}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={openDeleteDialog} onClose={handleCloseDeleteDialog}>
        <DialogTitle>Confirm Delete</DialogTitle>
        <DialogContent>
          <Typography>
            Are you sure you want to delete the skill <strong>{skillToDelete?.name}</strong>? This action cannot be undone.
          </Typography>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={handleCloseDeleteDialog} color="inherit">Cancel</Button>
          <Button onClick={handleDelete} variant="contained" color="error">
            Delete Skill
          </Button>
        </DialogActions>
      </Dialog>
    </Container>
  );
}
