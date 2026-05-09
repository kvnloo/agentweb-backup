import React, { useState, useEffect, useCallback } from "react";
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
  DialogTitle,
  TextField,
  FormControlLabel,
  Switch,
  Tooltip,
  Alert,
  CircularProgress,
  Chip,
  Stack,
  Collapse,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  Autocomplete,
} from "@mui/material";
import {
  Edit as EditIcon,
  Add as AddIcon,
  Delete as DeleteIcon,
  ExpandMore as ExpandMoreIcon,
  ExpandLess as ExpandLessIcon,
  Close as CloseIcon,
  Visibility as VisibilityIcon,
  VisibilityOff as VisibilityOffIcon,
} from "@mui/icons-material";
import axios from "axios";
import { useAuth } from "../contexts/AuthContext";
import { buildApiUrl } from "../config";

/** Backend-enforced cap. Keep in sync with USER_INSTRUCTIONS_MAX_LENGTH in
 *  backend/src/services/workPlanService.ts. */
const USER_INSTRUCTIONS_MAX_LENGTH = 500;

interface WorkPlanStep {
  stepCount: number;
  title: string;
  description?: string;
  /** User-facing guidance shown when a customer expands this step in the
   *  Agent Mode plan view. The legacy `description` field is the LLM's
   *  raw system prompt and must NEVER be rendered to end users. */
  userInstructions?: string;
  requiredFunctionCalls?: string[];
}

const PLAN_CATEGORIES = ["Paid Ads", "Strategy", "Content", "Other"];

interface WorkPlan {
  planId: string;
  title: string;
  description?: string;
  welcomeMessage?: string;
  steps: WorkPlanStep[];
  visibility: string;
  isBuiltIn: boolean;
  ownerId?: string;
  showInAgentMode?: boolean;
  autocomplete?: boolean;
  requireLogin?: boolean;
  showLoginSignup?: string;
  defaultModel?: string;
  category?: string;
  reviewFeedback?: string;
  createdAt: string;
  updatedAt: string;
  thumbnail_url?: string;
  thumbnail_source?: 'ai' | 'upload' | 'none';
  thumbnail_alt_text?: string;
}

const visibilityColor = (v: string) => {
  switch (v) {
    case "system": return "primary";
    case "public": return "success";
    case "private": return "default";
    case "pending_review": return "warning";
    default: return "default";
  }
};

export default function WorkPlans() {
  const { token } = useAuth();
  const [plans, setPlans] = useState<WorkPlan[]>([]);
  const [pendingPlans, setPendingPlans] = useState<WorkPlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  // Dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingPlan, setEditingPlan] = useState<WorkPlan | null>(null);
  const [saving, setSaving] = useState(false);

  // Form state
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [welcomeMessage, setWelcomeMessage] = useState("");
  const [steps, setSteps] = useState<WorkPlanStep[]>([{ stepCount: 1, title: "" }]);
  const [showInAgentMode, setShowInAgentMode] = useState(true);
  const [autocomplete, setAutocomplete] = useState(false);
  const [requireLogin, setRequireLogin] = useState(false);
  const [visibility, setVisibility] = useState("system");
  const [defaultModel, setDefaultModel] = useState("");
  const [category, setCategory] = useState("");
  const [supportedModels, setSupportedModels] = useState<string[]>([]);

  // Reject dialog
  const [rejectDialogOpen, setRejectDialogOpen] = useState(false);
  const [rejectTarget, setRejectTarget] = useState<WorkPlan | null>(null);
  const [rejectFeedback, setRejectFeedback] = useState("");

  // Expanded rows
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [expandedPendingId, setExpandedPendingId] = useState<string | null>(null);

  // Delete confirmation
  const [deleteTarget, setDeleteTarget] = useState<WorkPlan | null>(null);

  // Available function calls for autocomplete
  const [availableFunctionCalls, setAvailableFunctionCalls] = useState<string[]>([]);

  // Thumbnail state (edit mode only)
  const [thumbnailUrl, setThumbnailUrl] = useState<string | undefined>(undefined);
  const [thumbnailSource, setThumbnailSource] = useState<string>("none");
  const [thumbnailLoading, setThumbnailLoading] = useState(false);
  const [thumbnailError, setThumbnailError] = useState("");

  const fetchPlans = useCallback(async () => {
    try {
      const res = await axios.get(buildApiUrl("/api/admin/work-plans"), {
        headers: { Authorization: `Bearer ${token}` },
      });
      const all = res.data || [];
      // Separate pending from rest
      setPendingPlans(all.filter((p: WorkPlan) => p.visibility === "pending_review"));
      setPlans(all.filter((p: WorkPlan) => p.visibility !== "pending_review"));
    } catch (err) {
      setError("Failed to load work plans");
    } finally {
      setLoading(false);
    }
  }, [token]);

  const fetchSupportedModels = useCallback(async () => {
    try {
      const res = await axios.get(buildApiUrl("/api/agent-mode/public/llm-models"), {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (Array.isArray(res.data) && res.data.length > 0) {
        setSupportedModels(res.data);
      }
    } catch {
      // Non-critical — model dropdown will be empty
    }
  }, [token]);

  const fetchAvailableFunctionCalls = useCallback(async () => {
    try {
      const res = await axios.get(buildApiUrl("/api/agent-mode/function-calls"), {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.data?.functionCalls) {
        const workPlanFunctions = ["create_work_plan", "modify_work_plan", "set_work_plan_status"];
        const names = res.data.functionCalls
          .filter((fc: { name: string }) => !workPlanFunctions.includes(fc.name))
          .map((fc: { name: string }) => fc.name);
        setAvailableFunctionCalls(names);
      }
    } catch {
      // Non-critical — autocomplete just won't have suggestions
    }
  }, [token]);

  useEffect(() => { fetchPlans(); fetchAvailableFunctionCalls(); fetchSupportedModels(); }, [fetchPlans, fetchAvailableFunctionCalls, fetchSupportedModels]);

  const openCreateDialog = () => {
    setEditingPlan(null);
    setTitle("");
    setDescription("");
    setWelcomeMessage("");
    setSteps([{ stepCount: 1, title: "" }]);
    setShowInAgentMode(true);
    setAutocomplete(false);
    setRequireLogin(false);
    setVisibility("system");
    setDefaultModel("");
    setCategory("");
    setThumbnailUrl(undefined);
    setThumbnailSource("none");
    setThumbnailError("");
    setDialogOpen(true);
  };

  const openEditDialog = (plan: WorkPlan) => {
    setEditingPlan(plan);
    setTitle(plan.title);
    setDescription(plan.description || "");
    setWelcomeMessage(plan.welcomeMessage || "");
    setSteps(plan.steps.length > 0 ? plan.steps : [{ stepCount: 1, title: "" }]);
    setShowInAgentMode(plan.showInAgentMode !== false);
    setAutocomplete(plan.autocomplete || false);
    setRequireLogin(plan.requireLogin || false);
    setVisibility(plan.visibility);
    setDefaultModel(plan.defaultModel || "");
    setCategory(plan.category || "");
    setThumbnailUrl(plan.thumbnail_url);
    setThumbnailSource(plan.thumbnail_source || "none");
    setThumbnailError("");
    setDialogOpen(true);
  };

  const handleThumbnailGenerate = async () => {
    if (!editingPlan) return;
    setThumbnailLoading(true);
    setThumbnailError("");
    try {
      const res = await axios.post(
        buildApiUrl(`/api/admin/work-plans/${editingPlan.planId}/thumbnail/generate`),
        {},
        { headers: { Authorization: `Bearer ${token}` } },
      );
      setThumbnailUrl(res.data.thumbnail_url);
      setThumbnailSource(res.data.thumbnail_source || "ai");
    } catch (err: any) {
      setThumbnailError(err.response?.data?.message || "Failed to generate thumbnail");
    } finally {
      setThumbnailLoading(false);
    }
  };

  const handleThumbnailUpload = async (file: File) => {
    if (!editingPlan) return;

    // Client-side validation
    const accepted = ["image/jpeg", "image/jpg", "image/png", "image/webp"];
    if (!accepted.includes(file.type)) {
      setThumbnailError("Unsupported format. Use JPG, PNG, or WebP.");
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setThumbnailError("File exceeds 2 MB limit.");
      return;
    }

    setThumbnailLoading(true);
    setThumbnailError("");
    try {
      const formData = new FormData();
      formData.append("thumbnail", file);
      const res = await axios.post(
        buildApiUrl(`/api/admin/work-plans/${editingPlan.planId}/thumbnail/upload`),
        formData,
        { headers: { Authorization: `Bearer ${token}`, "Content-Type": "multipart/form-data" } },
      );
      setThumbnailUrl(res.data.thumbnail_url);
      setThumbnailSource(res.data.thumbnail_source || "upload");
    } catch (err: any) {
      setThumbnailError(err.response?.data?.message || "Failed to upload thumbnail");
    } finally {
      setThumbnailLoading(false);
    }
  };

  const handleThumbnailRemove = async () => {
    if (!editingPlan) return;
    setThumbnailLoading(true);
    setThumbnailError("");
    try {
      const res = await axios.delete(
        buildApiUrl(`/api/admin/work-plans/${editingPlan.planId}/thumbnail`),
        { headers: { Authorization: `Bearer ${token}` } },
      );
      setThumbnailUrl(res.data.thumbnail_url);
      setThumbnailSource(res.data.thumbnail_source || "none");
    } catch (err: any) {
      setThumbnailError(err.response?.data?.message || "Failed to remove thumbnail");
    } finally {
      setThumbnailLoading(false);
    }
  };

  const handleSave = async () => {
    if (!title.trim()) {
      setError("Title is required");
      return;
    }
    const validSteps = steps.filter(s => s.title.trim());
    if (validSteps.length === 0) {
      setError("At least one step with a title is required");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const body = {
        title, description, welcomeMessage,
        steps: validSteps.map((s, i) => ({ ...s, stepCount: i + 1 })),
        showInAgentMode, autocomplete, requireLogin, visibility,
        ...(defaultModel && { defaultModel }),
        ...(category && { category }),
      };
      if (editingPlan) {
        await axios.put(buildApiUrl(`/api/admin/work-plans/${editingPlan.planId}`), body, {
          headers: { Authorization: `Bearer ${token}` },
        });
        setSuccess("Work plan updated");
      } else {
        await axios.post(buildApiUrl("/api/admin/work-plans"), body, {
          headers: { Authorization: `Bearer ${token}` },
        });
        setSuccess("Work plan created");
      }
      setDialogOpen(false);
      fetchPlans();
    } catch (err: any) {
      setError(err.response?.data?.message || "Failed to save work plan");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await axios.delete(buildApiUrl(`/api/admin/work-plans/${deleteTarget.planId}`), {
        headers: { Authorization: `Bearer ${token}` },
      });
      setSuccess("Work plan deleted");
      setDeleteTarget(null);
      fetchPlans();
    } catch (err) {
      setError("Failed to delete work plan");
    }
  };

  const handleApprove = async (planId: string) => {
    try {
      await axios.post(buildApiUrl(`/api/admin/work-plans/${planId}/approve`), {}, {
        headers: { Authorization: `Bearer ${token}` },
      });
      setSuccess("Work plan approved!");
      fetchPlans();
    } catch (err) {
      setError("Failed to approve work plan");
    }
  };

  const handleReject = async () => {
    if (!rejectTarget || !rejectFeedback.trim()) return;
    try {
      await axios.post(buildApiUrl(`/api/admin/work-plans/${rejectTarget.planId}/reject`), {
        feedback: rejectFeedback,
      }, { headers: { Authorization: `Bearer ${token}` } });
      setSuccess("Work plan rejected");
      setRejectDialogOpen(false);
      setRejectTarget(null);
      setRejectFeedback("");
      fetchPlans();
    } catch (err) {
      setError("Failed to reject work plan");
    }
  };

  const addStep = () => {
    setSteps([...steps, { stepCount: steps.length + 1, title: "" }]);
  };

  const removeStep = (index: number) => {
    if (steps.length <= 1) return;
    setSteps(steps.filter((_, i) => i !== index).map((s, i) => ({ ...s, stepCount: i + 1 })));
  };

  const updateStep = (index: number, field: string, value: string | string[]) => {
    const updated = [...steps];
    updated[index] = { ...updated[index], [field]: value };
    setSteps(updated);
  };

  const toggleVisibility = async (plan: WorkPlan) => {
    try {
      await axios.put(buildApiUrl(`/api/admin/work-plans/${plan.planId}`), {
        showInAgentMode: !plan.showInAgentMode,
      }, { headers: { Authorization: `Bearer ${token}` } });
      fetchPlans();
    } catch (err) {
      setError("Failed to update visibility");
    }
  };

  if (loading) {
    return (
      <Container maxWidth="lg" sx={{ mt: 4, textAlign: "center" }}>
        <CircularProgress />
      </Container>
    );
  }

  return (
    <Container maxWidth="lg" sx={{ mt: 4, mb: 4 }}>
      {error && <Alert severity="error" onClose={() => setError("")} sx={{ mb: 2 }}>{error}</Alert>}
      {success && <Alert severity="success" onClose={() => setSuccess("")} sx={{ mb: 2 }}>{success}</Alert>}

      <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", mb: 3 }}>
        <Box>
          <Typography variant="h4" gutterBottom>Work Plans</Typography>
          <Typography variant="body2" color="text.secondary">
            Manage predefined work plans and review user-submitted plans.
          </Typography>
        </Box>
        <Button variant="contained" startIcon={<AddIcon />} onClick={openCreateDialog}>
          Create Work Plan
        </Button>
      </Box>

      {/* Review Queue */}
      {pendingPlans.length > 0 && (
        <Paper variant="outlined" sx={{ p: 2, mb: 3, borderColor: "warning.main", bgcolor: "warning.light", opacity: 0.9 }}>
          <Typography variant="h6" sx={{ mb: 1 }}>
            Pending Review ({pendingPlans.length})
          </Typography>
          <Stack spacing={1}>
            {pendingPlans.map((plan) => (
              <Box key={plan.planId} sx={{ bgcolor: "background.paper", borderRadius: 1, overflow: "hidden" }}>
                <Box
                  sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", p: 1, cursor: "pointer" }}
                  onClick={() => setExpandedPendingId(expandedPendingId === plan.planId ? null : plan.planId)}
                >
                  <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
                    <IconButton size="small">
                      {expandedPendingId === plan.planId ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
                    </IconButton>
                    <Box>
                      <strong>{plan.title}</strong>
                      <Typography variant="body2" color="text.secondary" component="span" sx={{ ml: 1 }}>
                        — {plan.steps?.length || 0} steps
                      </Typography>
                      {plan.ownerId && (
                        <Typography variant="caption" color="text.secondary" sx={{ ml: 1 }}>
                          (by {plan.ownerId})
                        </Typography>
                      )}
                    </Box>
                  </Box>
                  <Stack direction="row" spacing={1}>
                    <Button variant="contained" color="success" size="small" onClick={(e) => { e.stopPropagation(); handleApprove(plan.planId); }}>
                      Approve
                    </Button>
                    <Button variant="outlined" color="error" size="small" onClick={(e) => { e.stopPropagation(); setRejectTarget(plan); setRejectDialogOpen(true); }}>
                      Reject
                    </Button>
                  </Stack>
                </Box>
                <Collapse in={expandedPendingId === plan.planId}>
                  <Box sx={{ px: 2, pb: 2, pt: 1, borderTop: "1px solid", borderColor: "divider" }}>
                    {plan.description && (
                      <Typography variant="body2" sx={{ mb: 1 }}>
                        <strong>Description:</strong> {plan.description}
                      </Typography>
                    )}
                    {plan.welcomeMessage && (
                      <Typography variant="body2" sx={{ mb: 1 }}>
                        <strong>Welcome:</strong> {plan.welcomeMessage}
                      </Typography>
                    )}
                    <Typography variant="body2" sx={{ mb: 1 }}>
                      <strong>Settings:</strong>{" "}
                      {plan.autocomplete && <Chip label="Autocomplete" size="small" sx={{ mr: 0.5 }} />}
                      {plan.requireLogin && <Chip label="Login Required" size="small" sx={{ mr: 0.5 }} />}
                      {plan.defaultModel && <Chip label={`Model: ${plan.defaultModel}`} size="small" sx={{ mr: 0.5 }} />}
                      {!plan.autocomplete && !plan.requireLogin && !plan.defaultModel && <span>None</span>}
                    </Typography>
                    <Typography variant="body2" sx={{ mb: 0.5 }}><strong>Steps:</strong></Typography>
                    {plan.steps?.map((step, i) => (
                      <Box key={i} sx={{ ml: 2, mb: 0.5 }}>
                        <Typography variant="body2">
                          {step.stepCount}. <strong>{step.title}</strong>
                          {step.description && <span> — {step.description}</span>}
                        </Typography>
                        {step.requiredFunctionCalls && step.requiredFunctionCalls.length > 0 && (
                          <Box sx={{ ml: 2 }}>
                            {step.requiredFunctionCalls.map((fc, j) => (
                              <Chip key={j} label={fc} size="small" variant="outlined" sx={{ mr: 0.5, mb: 0.5, fontFamily: "monospace", fontSize: "0.7rem" }} />
                            ))}
                          </Box>
                        )}
                      </Box>
                    ))}
                  </Box>
                </Collapse>
              </Box>
            ))}
          </Stack>
        </Paper>
      )}

      {/* Work Plans Table */}
      <TableContainer component={Paper}>
        <Table>
          <TableHead>
            <TableRow>
              <TableCell width={40} />
              <TableCell width={56}>Thumb</TableCell>
              <TableCell>Title</TableCell>
              <TableCell>Category</TableCell>
              <TableCell>Steps</TableCell>
              <TableCell>Visibility</TableCell>
              <TableCell>Model</TableCell>
              <TableCell>Agent Mode</TableCell>
              <TableCell>Owner</TableCell>
              <TableCell align="right">Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {plans.length === 0 ? (
              <TableRow>
                <TableCell colSpan={10} align="center" sx={{ py: 4 }}>
                  <Typography color="text.secondary">No work plans yet. Create one to get started.</Typography>
                </TableCell>
              </TableRow>
            ) : (
              plans.map((plan) => (
                <React.Fragment key={plan.planId}>
                  <TableRow hover sx={{ cursor: "pointer" }} onClick={() => setExpandedId(expandedId === plan.planId ? null : plan.planId)}>
                    <TableCell>
                      <IconButton size="small">
                        {expandedId === plan.planId ? <ExpandLessIcon /> : <ExpandMoreIcon />}
                      </IconButton>
                    </TableCell>
                    <TableCell sx={{ p: 0.5 }}>
                      {plan.thumbnail_url ? (
                        <Box
                          component="img"
                          src={plan.thumbnail_url}
                          alt=""
                          sx={{ width: 40, height: 40, borderRadius: 1, objectFit: "cover", display: "block" }}
                        />
                      ) : (
                        <Box
                          sx={{
                            width: 40, height: 40, borderRadius: 1,
                            bgcolor: "grey.200", display: "flex", alignItems: "center", justifyContent: "center",
                          }}
                        >
                          <Typography variant="caption" color="text.disabled" fontWeight="bold">
                            {plan.title.charAt(0).toUpperCase()}
                          </Typography>
                        </Box>
                      )}
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" fontWeight="medium">{plan.title}</Typography>
                      {plan.description && (
                        <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
                          {plan.description.length > 80 ? plan.description.substring(0, 80) + "..." : plan.description}
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell>
                      {plan.category ? (
                        <Chip label={plan.category} size="small" variant="outlined" />
                      ) : (
                        <Typography variant="caption" color="text.disabled">—</Typography>
                      )}
                    </TableCell>
                    <TableCell>{plan.steps?.length || 0}</TableCell>
                    <TableCell>
                      <Chip label={plan.visibility} size="small" color={visibilityColor(plan.visibility) as any} />
                    </TableCell>
                    <TableCell>
                      <Typography variant="caption" color={plan.defaultModel ? "inherit" : "text.disabled"} sx={{ fontFamily: "monospace" }}>
                        {plan.defaultModel || "default"}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Tooltip title={plan.showInAgentMode ? "Visible in Agent Mode" : "Hidden from Agent Mode"}>
                        <IconButton size="small" onClick={(e) => { e.stopPropagation(); toggleVisibility(plan); }}>
                          {plan.showInAgentMode ? <VisibilityIcon color="success" /> : <VisibilityOffIcon color="disabled" />}
                        </IconButton>
                      </Tooltip>
                    </TableCell>
                    <TableCell>
                      <Typography variant="caption" color="text.secondary">
                        {plan.isBuiltIn ? "System" : plan.ownerId ? plan.ownerId.substring(0, 8) + "..." : "—"}
                      </Typography>
                    </TableCell>
                    <TableCell align="right">
                      <Tooltip title="Edit">
                        <IconButton size="small" onClick={(e) => { e.stopPropagation(); openEditDialog(plan); }}>
                          <EditIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title="Delete">
                        <IconButton size="small" onClick={(e) => { e.stopPropagation(); setDeleteTarget(plan); }} color="error">
                          <DeleteIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    </TableCell>
                  </TableRow>
                  <TableRow key={`${plan.planId}-expand`}>
                    <TableCell colSpan={10} sx={{ p: 0, border: expandedId === plan.planId ? undefined : "none" }}>
                      <Collapse in={expandedId === plan.planId}>
                        <Box sx={{ p: 2, bgcolor: "grey.50" }}>
                          {plan.welcomeMessage && (
                            <Typography variant="body2" sx={{ mb: 1 }}>
                              <strong>Welcome:</strong> {plan.welcomeMessage}
                            </Typography>
                          )}
                          <Typography variant="body2" sx={{ mb: 1 }}>
                            <strong>Settings:</strong>{" "}
                            {plan.autocomplete && <Chip label="Autocomplete" size="small" sx={{ mr: 0.5 }} />}
                            {plan.requireLogin && <Chip label="Login Required" size="small" sx={{ mr: 0.5 }} />}
                            {plan.defaultModel && <Chip label={`Model: ${plan.defaultModel}`} size="small" sx={{ mr: 0.5 }} />}
                            {!plan.autocomplete && !plan.requireLogin && !plan.defaultModel && <span>None</span>}
                          </Typography>
                          <Typography variant="body2" sx={{ mb: 0.5 }}><strong>Steps:</strong></Typography>
                          {plan.steps?.map((step, i) => (
                            <Box key={i} sx={{ ml: 2, mb: 0.5 }}>
                              <Typography variant="body2">
                                {step.stepCount}. <strong>{step.title}</strong>
                                {step.description && <span> — {step.description}</span>}
                              </Typography>
                              {step.requiredFunctionCalls && step.requiredFunctionCalls.length > 0 && (
                                <Box sx={{ ml: 2 }}>
                                  {step.requiredFunctionCalls.map((fc, j) => (
                                    <Chip key={j} label={fc} size="small" variant="outlined" sx={{ mr: 0.5, mb: 0.5, fontFamily: "monospace", fontSize: "0.7rem" }} />
                                  ))}
                                </Box>
                              )}
                            </Box>
                          ))}
                        </Box>
                      </Collapse>
                    </TableCell>
                  </TableRow>
                </React.Fragment>
              ))
            )}
          </TableBody>
        </Table>
      </TableContainer>

      {/* Create/Edit Dialog */}
      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} maxWidth="md" fullWidth>
        <DialogTitle>{editingPlan ? "Edit Work Plan" : "Create Work Plan"}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <TextField label="Title" value={title} onChange={(e) => setTitle(e.target.value)} fullWidth required />
            <TextField label="Description" value={description} onChange={(e) => setDescription(e.target.value)} fullWidth multiline rows={2} />
            <TextField label="Welcome Message" value={welcomeMessage} onChange={(e) => setWelcomeMessage(e.target.value)} fullWidth multiline rows={2} helperText="Greeting shown when the plan starts. Supports HTML." />

            <Box sx={{ display: "flex", gap: 2, flexWrap: "wrap" }}>
              <FormControl size="small" sx={{ minWidth: 150 }}>
                <InputLabel>Visibility</InputLabel>
                <Select value={visibility} label="Visibility" onChange={(e) => setVisibility(e.target.value)}>
                  <MenuItem value="system">System</MenuItem>
                  <MenuItem value="public">Public</MenuItem>
                  <MenuItem value="private">Private</MenuItem>
                </Select>
              </FormControl>
              <FormControl size="small" sx={{ minWidth: 160 }}>
                <InputLabel>Category (Optional)</InputLabel>
                <Select value={category} label="Category (Optional)" onChange={(e) => setCategory(e.target.value)}>
                  <MenuItem value=""><em>None</em></MenuItem>
                  {PLAN_CATEGORIES.map((c) => (
                    <MenuItem key={c} value={c}>{c}</MenuItem>
                  ))}
                </Select>
              </FormControl>
              <FormControl size="small" sx={{ minWidth: 220 }}>
                <InputLabel>Default Model (Optional)</InputLabel>
                <Select value={defaultModel} label="Default Model (Optional)" onChange={(e) => setDefaultModel(e.target.value)}>
                  <MenuItem value=""><em>Use Agent Mode Default</em></MenuItem>
                  {supportedModels.map((m) => (
                    <MenuItem key={m} value={m}>{m}</MenuItem>
                  ))}
                </Select>
              </FormControl>
              <FormControlLabel control={<Switch checked={showInAgentMode} onChange={(e) => setShowInAgentMode(e.target.checked)} />} label="Show in Agent Mode" />
              <FormControlLabel control={<Switch checked={autocomplete} onChange={(e) => setAutocomplete(e.target.checked)} />} label="Autocomplete" />
              <FormControlLabel control={<Switch checked={requireLogin} onChange={(e) => setRequireLogin(e.target.checked)} />} label="Require Login" />
            </Box>

            <Box>
              <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", mb: 1 }}>
                <Typography variant="subtitle2">Steps</Typography>
                <Button size="small" startIcon={<AddIcon />} onClick={addStep}>Add Step</Button>
              </Box>
              {steps.map((step, i) => (
                <Box key={i} sx={{ display: "flex", gap: 1, mb: 1, alignItems: "flex-start" }}>
                  <Chip label={i + 1} size="small" sx={{ mt: 1 }} />
                  <Box sx={{ flex: 1 }}>
                    <TextField
                      value={step.title}
                      onChange={(e) => updateStep(i, "title", e.target.value)}
                      placeholder={`Step ${i + 1} title`}
                      size="small"
                      fullWidth
                      sx={{ mb: 0.5 }}
                    />
                    <TextField
                      value={step.description || ""}
                      onChange={(e) => updateStep(i, "description", e.target.value)}
                      placeholder="LLM prompt for this step (not shown to users)"
                      size="small"
                      fullWidth
                      sx={{ mb: 0.5 }}
                    />
                    <TextField
                      value={step.userInstructions || ""}
                      onChange={(e) => {
                        const next = e.target.value.slice(0, USER_INSTRUCTIONS_MAX_LENGTH);
                        updateStep(i, "userInstructions", next);
                      }}
                      placeholder="User Instructions: what should the user do at this step? What should they expect? (Shown to users when they expand this step.)"
                      size="small"
                      fullWidth
                      multiline
                      minRows={2}
                      maxRows={4}
                      inputProps={{ maxLength: USER_INSTRUCTIONS_MAX_LENGTH }}
                      helperText={`${step.userInstructions?.length ?? 0} / ${USER_INSTRUCTIONS_MAX_LENGTH}`}
                      FormHelperTextProps={{
                        sx: {
                          textAlign: "right",
                          m: 0,
                          color:
                            (step.userInstructions?.length ?? 0) >= USER_INSTRUCTIONS_MAX_LENGTH
                              ? "error.main"
                              : "text.secondary",
                        },
                      }}
                      sx={{ mb: 0.5 }}
                    />
                    <Autocomplete
                      multiple
                      freeSolo
                      size="small"
                      options={availableFunctionCalls}
                      value={step.requiredFunctionCalls || []}
                      onChange={(_e, newValue) => {
                        updateStep(i, "requiredFunctionCalls", newValue as string[]);
                      }}
                      renderTags={(value, getTagProps) =>
                        value.map((option, index) => {
                          const { key, ...rest } = getTagProps({ index });
                          return (
                            <Chip
                              key={key}
                              label={option}
                              size="small"
                              variant="outlined"
                              sx={{ fontFamily: "monospace", fontSize: "0.75rem" }}
                              {...rest}
                            />
                          );
                        })
                      }
                      renderInput={(params) => (
                        <TextField
                          {...params}
                          placeholder={step.requiredFunctionCalls?.length ? "" : "Select required function calls..."}
                          helperText="Functions that must be called to complete this step"
                        />
                      )}
                    />
                  </Box>
                  {steps.length > 1 && (
                    <IconButton size="small" onClick={() => removeStep(i)} sx={{ mt: 0.5 }}>
                      <CloseIcon fontSize="small" />
                    </IconButton>
                  )}
                </Box>
              ))}
            </Box>
          </Stack>

            {editingPlan && (
              <Box>
                <Typography variant="subtitle2" sx={{ mb: 1 }}>Thumbnail</Typography>
                {thumbnailError && (
                  <Alert severity="error" sx={{ mb: 1 }} onClose={() => setThumbnailError("")}>
                    {thumbnailError}
                  </Alert>
                )}
                <Box sx={{ display: "flex", gap: 2, alignItems: "flex-start", flexWrap: "wrap" }}>
                  {/* Preview */}
                  <Box
                    sx={{
                      width: 120,
                      height: 120,
                      borderRadius: 1,
                      border: "1px solid",
                      borderColor: "divider",
                      overflow: "hidden",
                      flexShrink: 0,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      bgcolor: "grey.100",
                      position: "relative",
                    }}
                  >
                    {thumbnailLoading ? (
                      <CircularProgress size={32} />
                    ) : thumbnailUrl ? (
                      <Box
                        component="img"
                        src={thumbnailUrl}
                        alt="Thumbnail preview"
                        sx={{ width: "100%", height: "100%", objectFit: "cover" }}
                      />
                    ) : (
                      <Typography variant="h4" color="text.disabled">
                        {title.charAt(0).toUpperCase()}
                      </Typography>
                    )}
                  </Box>

                  {/* Actions */}
                  <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
                    <Button
                      size="small"
                      variant="outlined"
                      disabled={thumbnailLoading}
                      onClick={handleThumbnailGenerate}
                    >
                      {thumbnailSource === "none" ? "Generate with AI" : "Regenerate with AI"}
                    </Button>

                    <Button
                      size="small"
                      variant="outlined"
                      component="label"
                      disabled={thumbnailLoading}
                    >
                      Upload Custom Image
                      <input
                        type="file"
                        hidden
                        accept="image/jpeg,image/png,image/webp"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) handleThumbnailUpload(file);
                          e.target.value = "";
                        }}
                      />
                    </Button>

                    {thumbnailUrl && (
                      <Button
                        size="small"
                        variant="text"
                        color="error"
                        disabled={thumbnailLoading}
                        onClick={handleThumbnailRemove}
                      >
                        Remove
                      </Button>
                    )}

                    {thumbnailSource && thumbnailSource !== "none" && (
                      <Typography variant="caption" color="text.secondary">
                        Source: {thumbnailSource === "ai" ? "AI generated" : "Custom upload"}
                      </Typography>
                    )}
                  </Box>
                </Box>
                <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: "block" }}>
                  Accepted: JPG, PNG, WebP · Max 2 MB · Square or vertical (not landscape)
                </Typography>
              </Box>
            )}

            {!editingPlan && (
              <Box sx={{ p: 1.5, bgcolor: "info.light", borderRadius: 1, opacity: 0.85 }}>
                <Typography variant="caption" color="info.dark">
                  A thumbnail will be automatically generated with AI after the work plan is created.
                </Typography>
              </Box>
            )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialogOpen(false)}>Cancel</Button>
          <Button onClick={handleSave} variant="contained" disabled={saving}>
            {saving ? <CircularProgress size={20} /> : editingPlan ? "Update" : "Create"}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Reject Dialog */}
      <Dialog open={rejectDialogOpen} onClose={() => { setRejectDialogOpen(false); setRejectTarget(null); setRejectFeedback(""); }} maxWidth="sm" fullWidth>
        <DialogTitle>Reject Work Plan: {rejectTarget?.title}</DialogTitle>
        <DialogContent>
          <TextField
            fullWidth multiline rows={3}
            label="Feedback (required)"
            placeholder="Explain why this was rejected..."
            value={rejectFeedback}
            onChange={(e) => setRejectFeedback(e.target.value)}
            sx={{ mt: 1 }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => { setRejectDialogOpen(false); setRejectTarget(null); setRejectFeedback(""); }}>Cancel</Button>
          <Button onClick={handleReject} variant="contained" color="error" disabled={!rejectFeedback.trim()}>Reject</Button>
        </DialogActions>
      </Dialog>

      {/* Delete Confirmation */}
      <Dialog open={!!deleteTarget} onClose={() => setDeleteTarget(null)} maxWidth="xs" fullWidth>
        <DialogTitle>Delete Work Plan</DialogTitle>
        <DialogContent>
          <Typography>
            Are you sure you want to delete "{deleteTarget?.title}"? This action cannot be undone.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteTarget(null)}>Cancel</Button>
          <Button onClick={handleDelete} variant="contained" color="error">Delete</Button>
        </DialogActions>
      </Dialog>
    </Container>
  );
}
