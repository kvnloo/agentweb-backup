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
  Checkbox,
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
  ContentPaste as ContentPasteIcon,
  SyncAlt as SyncAltIcon,
} from "@mui/icons-material";
import axios from "axios";
import { useAuth } from "../contexts/AuthContext";
import { buildApiUrl } from "../config";
import skillService, { Skill, SkillSyncInfo } from "../services/skillService";

interface SubscriptionType {
  name: string;
  allowedPages: string[];
  allowedSkills: string[];
}

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
  const [pasteDialogOpen, setPasteDialogOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [subscriptionTypes, setSubscriptionTypes] = useState<SubscriptionType[]>([]);
  const [publicAllowedSkills, setPublicAllowedSkills] = useState<string[]>([]);
  const [savingSubscriptionKey, setSavingSubscriptionKey] = useState<string | null>(null);
  const [syncDialogOpen, setSyncDialogOpen] = useState(false);
  const [skillToSync, setSkillToSync] = useState<Skill | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [successMessage, setSuccessMessage] = useState("");
  const [syncStatus, setSyncStatus] = useState<Record<string, SkillSyncInfo>>({});
  const [backendEnv, setBackendEnv] = useState<'development' | 'production'>('production');

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

  const fetchSubscriptionTypes = useCallback(async () => {
    try {
      const response = await axios.get(buildApiUrl("/api/admin/subscription-types"), {
        headers: { Authorization: `Bearer ${token}` },
      });
      setSubscriptionTypes(response.data || []);
    } catch (err) {
      console.error("Failed to fetch subscription types", err);
    }
  }, [token]);

  const fetchPublicSkills = useCallback(async () => {
    try {
      const response = await axios.get(buildApiUrl("/api/admin/public-skills"), {
        headers: { Authorization: `Bearer ${token}` },
      });
      setPublicAllowedSkills(response.data.allowedSkills || []);
    } catch (err) {
      console.error("Failed to fetch public skills", err);
    }
  }, [token]);

  const fetchSyncStatus = useCallback(async () => {
    try {
      const data = await skillService.getSyncStatus(token!);
      setSyncStatus(data.skills);
      setBackendEnv(data.environment);
    } catch (err) {
      console.error("Failed to fetch sync status", err);
    }
  }, [token]);

  const fetchTools = useCallback(async () => {
    try {
      const response = await axios.get(buildApiUrl("/api/agent-mode/function-calls"), {
        headers: { Authorization: `Bearer ${token}` },
      });
      const allTools = (response.data.functionCalls as AvailableTool[]) || [];
      setAvailableTools(allTools);
    } catch (err) {
      console.error("Failed to fetch available tools", err);
    }
  }, [token]);

  useEffect(() => {
    if (token) {
      fetchSkills();
      fetchTools();
      fetchSubscriptionTypes();
      fetchPublicSkills();
      fetchSyncStatus();
    }
  }, [token, fetchSkills, fetchTools, fetchSubscriptionTypes, fetchPublicSkills, fetchSyncStatus]);

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



  const handleOpenSyncDialog = (skill: Skill) => {
    setSkillToSync(skill);
    setSyncDialogOpen(true);
  };

  const syncDirection = backendEnv === 'development' ? 'dev-to-prod' : 'prod-to-dev';
  const syncLabel = backendEnv === 'development' ? 'Dev → Prod' : 'Prod → Dev';

  const handleSync = async () => {
    if (!skillToSync) return;
    setSyncing(true);
    try {
      await skillService.syncSkill(skillToSync.skillId, syncDirection, token!);
      setSuccessMessage(`Skill "${skillToSync.name}" synced ${syncLabel}`);
      fetchSkills();
      fetchSyncStatus();
      setSyncDialogOpen(false);
      setSkillToSync(null);
    } catch (err) {
      setError("Failed to sync skill");
      console.error(err);
    } finally {
      setSyncing(false);
    }
  };

  // Toggle a skill's membership in a subscription type
  const handleToggleSubscription = async (skillId: string, subName: string) => {
    const sub = subscriptionTypes.find((t) => t.name === subName);
    if (!sub) return;
    const hasSkill = sub.allowedSkills.includes(skillId) || sub.allowedSkills.includes("*");
    const action = hasSkill ? "remove" : "add";

    const key = `${skillId}:${subName}`;
    setSavingSubscriptionKey(key);
    try {
      const response = await axios.post(
        buildApiUrl(`/api/admin/subscription-types/${encodeURIComponent(subName)}/skills`),
        { skillId, action },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      // Update only the affected subscription type in local state
      const updated = response.data.subscriptionType as SubscriptionType;
      setSubscriptionTypes((prev) =>
        prev.map((t) => (t.name === subName ? updated : t))
      );
    } catch (err) {
      setError("Failed to update subscription");
      console.error(err);
    } finally {
      setSavingSubscriptionKey(null);
    }
  };

  // Toggle a skill's availability for public/anonymous users
  const handleTogglePublicSkill = async (skillId: string) => {
    const hasSkill = publicAllowedSkills.includes(skillId) || publicAllowedSkills.includes("*");
    const action = hasSkill ? "remove" : "add";

    const key = `${skillId}:Public`;
    setSavingSubscriptionKey(key);
    try {
      const response = await axios.post(
        buildApiUrl("/api/admin/public-skills"),
        { skillId, action },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      setPublicAllowedSkills(response.data.allowedSkills || []);
    } catch (err) {
      setError("Failed to update public skills");
      console.error(err);
    } finally {
      setSavingSubscriptionKey(null);
    }
  };

  // Paste tools helpers
  const parsePasteText = (text: string) => {
    const names = text
      .split(/[\n,]+/)
      .map(s => s.trim())
      .filter(Boolean);
    const availableNameMap = new Map(availableTools.map(t => [t.name.toLowerCase(), t.name]));
    const matched: string[] = [];
    const unmatched: string[] = [];
    for (const n of names) {
      const canonical = availableNameMap.get(n.toLowerCase());
      if (canonical) {
        matched.push(canonical);
      } else {
        unmatched.push(n);
      }
    }
    return { matched: [...new Set(matched)], unmatched };
  };

  const handlePasteConfirm = () => {
    const { matched } = parsePasteText(pasteText);
    const merged = [...new Set([...toolNames, ...matched])];
    setToolNames(merged);
    setPasteDialogOpen(false);
    setPasteText("");
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
        {successMessage && <Alert severity="success" sx={{ mb: 3 }} onClose={() => setSuccessMessage("")}>{successMessage}</Alert>}

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
                  <TableCell>Subscriptions</TableCell>
                  <TableCell>Tools</TableCell>
                  <TableCell sx={{ whiteSpace: "nowrap" }}>Actions</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {filteredSkills.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} align="center" sx={{ py: 3 }}>
                      <Typography variant="body1" color="text.secondary">
                        {searchText ? `No skills matching "${searchText}"` : "No Skills Defined"}
                      </Typography>
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredSkills.map((skill: Skill) => (
                    <TableRow key={skill.skillId}>
                      <TableCell sx={{ fontWeight: "bold" }}>{skill.name}</TableCell>
                      <TableCell sx={{ maxWidth: 200 }}>
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
                        <Stack direction="column" spacing={0}>
                          {subscriptionTypes.map((sub) => {
                            const isIncluded = sub.allowedSkills.includes(skill.skillId) || sub.allowedSkills.includes("*");
                            const isSaving = savingSubscriptionKey === `${skill.skillId}:${sub.name}`;
                            return (
                              <Tooltip key={sub.name} title={isIncluded ? `Remove from ${sub.name}` : `Add to ${sub.name}`}>
                                <FormControlLabel
                                  control={
                                    <Checkbox
                                      size="small"
                                      checked={isIncluded}
                                      disabled={isSaving || !skill.isPublished}
                                      onChange={() => handleToggleSubscription(skill.skillId, sub.name)}
                                    />
                                  }
                                  label={<Typography variant="caption">{sub.name}</Typography>}
                                  sx={{ m: 0 }}
                                />
                              </Tooltip>
                            );
                          })}
                          {(() => {
                            const isPublicIncluded = publicAllowedSkills.includes(skill.skillId) || publicAllowedSkills.includes("*");
                            const isPublicSaving = savingSubscriptionKey === `${skill.skillId}:Public`;
                            return (
                              <Tooltip title={isPublicIncluded ? "Remove from Public" : "Add to Public"}>
                                <FormControlLabel
                                  control={
                                    <Checkbox
                                      size="small"
                                      checked={isPublicIncluded}
                                      disabled={isPublicSaving || !skill.isPublished}
                                      onChange={() => handleTogglePublicSkill(skill.skillId)}
                                    />
                                  }
                                  label={<Typography variant="caption" sx={{ fontStyle: "italic" }}>Public</Typography>}
                                  sx={{ m: 0 }}
                                />
                              </Tooltip>
                            );
                          })()}
                        </Stack>
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
                          <Tooltip title={
                            syncStatus[skill.skillId]?.inSync
                              ? "Prod & Dev in sync"
                              : syncStatus[skill.skillId]?.changedFields?.length
                                ? `Out of sync: ${syncStatus[skill.skillId].changedFields.join(", ")}`
                                : !syncStatus[skill.skillId]?.existsInProd
                                  ? "Missing in Prod"
                                  : !syncStatus[skill.skillId]?.existsInDev
                                    ? "Missing in Dev"
                                    : "Sync Skill (Prod/Dev)"
                          }>
                            <span>
                              <IconButton
                                onClick={() => handleOpenSyncDialog(skill)}
                                color="info"
                                disabled={syncStatus[skill.skillId]?.inSync}
                              >
                                <SyncAltIcon />
                              </IconButton>
                            </span>
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
                {/* Virtual __admin_tools__ row */}
                {!loading && (
                  <TableRow sx={{ backgroundColor: 'action.hover' }}>
                    <TableCell sx={{ fontWeight: "bold" }}>
                      Admin Tools
                      <Typography variant="caption" color="text.secondary" display="block">
                        (virtual — admin only)
                      </Typography>
                    </TableCell>
                    <TableCell sx={{ maxWidth: 300 }}>
                      <Typography variant="body2">
                        Manage predefined work plans. Only visible to admin users in agent mode.
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Chip label="Auto" color="warning" size="small" />
                    </TableCell>
                    <TableCell>
                      <Typography variant="caption" color="text.secondary">
                        Admin-only (no subscription gating)
                      </Typography>
                    </TableCell>
                    <TableCell>
                      {["list_predefined_work_plans", "manage_predefined_work_plan"].map(tool => (
                        <Chip key={tool} label={tool} size="small" color="warning" variant="outlined" sx={{ mr: 0.5, mb: 0.5 }} />
                      ))}
                    </TableCell>
                    <TableCell />
                  </TableRow>
                )}
                {/* Virtual __other_skills__ row */}
                {!loading && unusedTools.length > 0 && (
                  <TableRow sx={{ backgroundColor: 'action.hover' }}>
                    <TableCell sx={{ fontWeight: "bold" }}>
                      Other Skills
                      <Typography variant="caption" color="text.secondary" display="block">
                        (virtual)
                      </Typography>
                    </TableCell>
                    <TableCell sx={{ maxWidth: 300 }}>
                      <Typography variant="body2">
                        {unusedTools.length} tool(s) not assigned to any named skill
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Chip label="Auto" color="warning" size="small" />
                    </TableCell>
                    <TableCell>
                      <Stack direction="column" spacing={0}>
                        {subscriptionTypes.map((sub) => {
                          const isIncluded = sub.allowedSkills.includes("__other_skills__") || sub.allowedSkills.includes("*");
                          const isSaving = savingSubscriptionKey === `__other_skills__:${sub.name}`;
                          return (
                            <Tooltip key={sub.name} title={isIncluded ? `Remove from ${sub.name}` : `Add to ${sub.name}`}>
                              <FormControlLabel
                                control={
                                  <Checkbox
                                    size="small"
                                    checked={isIncluded}
                                    disabled={isSaving}
                                    onChange={() => handleToggleSubscription("__other_skills__", sub.name)}
                                  />
                                }
                                label={<Typography variant="caption">{sub.name}</Typography>}
                                sx={{ m: 0 }}
                              />
                            </Tooltip>
                          );
                        })}
                        {(() => {
                          const isPublicIncluded = publicAllowedSkills.includes("__other_skills__") || publicAllowedSkills.includes("*");
                          const isPublicSaving = savingSubscriptionKey === `__other_skills__:Public`;
                          return (
                            <Tooltip title={isPublicIncluded ? "Remove from Public" : "Add to Public"}>
                              <FormControlLabel
                                control={
                                  <Checkbox
                                    size="small"
                                    checked={isPublicIncluded}
                                    disabled={isPublicSaving}
                                    onChange={() => handleTogglePublicSkill("__other_skills__")}
                                  />
                                }
                                label={<Typography variant="caption" sx={{ fontStyle: "italic" }}>Public</Typography>}
                                sx={{ m: 0 }}
                              />
                            </Tooltip>
                          );
                        })()}
                      </Stack>
                    </TableCell>
                    <TableCell>
                      {unusedTools.map(tool => (
                        <Tooltip key={tool.name} title={tool.description} arrow>
                          <Chip label={tool.name} size="small" color="warning" variant="outlined" sx={{ mr: 0.5, mb: 0.5 }} />
                        </Tooltip>
                      ))}
                    </TableCell>
                    <TableCell />
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </Paper>

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
              <Stack direction="row" alignItems="center" spacing={1}>
                <Typography variant="subtitle2" color="text.secondary">
                  Tools Configuration
                </Typography>
                <Button
                  size="small"
                  variant="outlined"
                  startIcon={<ContentPasteIcon />}
                  onClick={() => setPasteDialogOpen(true)}
                  sx={{ textTransform: 'none', fontSize: '0.75rem' }}
                >
                  Paste Tools
                </Button>
              </Stack>
              <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 'bold' }}>
                {toolNames.length} of {availableTools.length} tools selected
              </Typography>
            </Stack>
            <Autocomplete
              multiple
              disableCloseOnSelect
              options={[
                ...availableTools,
                ...toolNames
                  .filter(name => !availableTools.some(t => t.name === name))
                  .map(name => ({ name, description: '(tool no longer available)' })),
              ]}
              getOptionLabel={(option) => option.name}
              isOptionEqualToValue={(option, value) => option.name === value.name}
              value={toolNames.map(name => availableTools.find(t => t.name === name) || { name, description: '(tool no longer available)' })}
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
                  onPaste={(e) => {
                    const text = e.clipboardData.getData("text");
                    if (text.includes(",") || text.includes("\n")) {
                      e.preventDefault();
                      const { matched } = parsePasteText(text);
                      if (matched.length > 0) {
                        setToolNames(prev => [...new Set([...prev, ...matched])]);
                        setToolSearchText("");
                      }
                    }
                  }}
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

      {/* Sync Skill Dialog */}
      <Dialog open={syncDialogOpen} onClose={() => { setSyncDialogOpen(false); setSkillToSync(null); }}>
        <DialogTitle>Sync Skill ({syncLabel})</DialogTitle>
        <DialogContent>
          <Typography sx={{ mb: 2 }}>
            Sync <strong>{skillToSync?.name}</strong> {syncLabel}:
          </Typography>
          {skillToSync && syncStatus[skillToSync.skillId] && (() => {
            const info = syncStatus[skillToSync.skillId];
            if (!info.existsInProd) {
              return <Alert severity="info" sx={{ mb: 2 }}>This skill only exists in Dev. It will be created in Prod.</Alert>;
            }
            if (!info.existsInDev) {
              return <Alert severity="info" sx={{ mb: 2 }}>This skill only exists in Prod. It will be created in Dev.</Alert>;
            }
            if (info.changedFields.length > 0) {
              return (
                <Alert severity="info" sx={{ mb: 2 }}>
                  <strong>Fields that will change:</strong> {info.changedFields.join(", ")}
                </Alert>
              );
            }
            return null;
          })()}
          {backendEnv === 'development' && (
            <Alert severity="warning" sx={{ mt: 1 }}>
              This will overwrite the production version of this skill.
            </Alert>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => { setSyncDialogOpen(false); setSkillToSync(null); }} color="inherit">
            Cancel
          </Button>
          <Button onClick={handleSync} variant="contained" color="primary" disabled={syncing}>
            {syncing ? <CircularProgress size={20} color="inherit" /> : `Sync ${syncLabel}`}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Paste Tool Names Dialog */}
      <Dialog
        open={pasteDialogOpen}
        onClose={() => { setPasteDialogOpen(false); setPasteText(""); }}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>Paste Tool Names</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            multiline
            rows={6}
            margin="dense"
            placeholder="Paste tool names, one per line or comma-separated..."
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
          />
          {pasteText.trim() && (() => {
            const { matched, unmatched } = parsePasteText(pasteText);
            const newTools = matched.filter(m => !toolNames.includes(m));
            return (
              <Box sx={{ mt: 2 }}>
                <Typography variant="body2" color="text.secondary">
                  {matched.length} of {matched.length + unmatched.length} tool name(s) recognized
                  {newTools.length > 0 && newTools.length < matched.length
                    ? ` (${newTools.length} new, ${matched.length - newTools.length} already selected)`
                    : ""}
                </Typography>
                {unmatched.length > 0 && (
                  <Alert severity="warning" sx={{ mt: 1 }}>
                    <Typography variant="caption">
                      Unrecognized: {unmatched.join(", ")}
                    </Typography>
                  </Alert>
                )}
              </Box>
            );
          })()}
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => { setPasteDialogOpen(false); setPasteText(""); }} color="inherit">
            Cancel
          </Button>
          <Button
            onClick={handlePasteConfirm}
            variant="contained"
            disabled={!pasteText.trim() || parsePasteText(pasteText).matched.length === 0}
          >
            Add {pasteText.trim() ? parsePasteText(pasteText).matched.length : 0} Tool(s)
          </Button>
        </DialogActions>
      </Dialog>
    </Container>
  );
}
