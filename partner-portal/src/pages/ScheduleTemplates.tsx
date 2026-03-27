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
  FormControlLabel,
  Switch,
  Autocomplete,
} from "@mui/material";
import {
  Edit as EditIcon,
  Add as AddIcon,
  Delete as DeleteIcon,
  ExpandMore as ExpandMoreIcon,
  ExpandLess as ExpandLessIcon,
  Lock as LockIcon,
} from "@mui/icons-material";
import axios from "axios";
import { useAuth } from "../contexts/AuthContext";
import { buildApiUrl } from "../config";

interface ScheduleTemplate {
  templateId: string;
  createdBy: string;
  name: string;
  description?: string;
  category: string;
  visibility: string;
  startingMessage: string;
  variables?: Array<{ name: string; description?: string; type?: string }>;
  keywords?: string[];
  requiredFunctionCalls?: string[];
  functionCallMinCalls?: { [fn: string]: number };
  suggestedFrequency?: string;
  frequencyIntervalDays?: number;
  emailNotifications?: string[];
  dailyDigest?: boolean;
  llmModel?: string;
  usageCount?: number;
  reviewFeedback?: string;
  createdAt: string;
  updatedAt: string;
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

export default function ScheduleTemplates() {
  const { token } = useAuth();
  const [templates, setTemplates] = useState<ScheduleTemplate[]>([]);
  const [pendingTemplates, setPendingTemplates] = useState<ScheduleTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  // Dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<ScheduleTemplate | null>(null);
  const [saving, setSaving] = useState(false);

  // Form state
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("General");
  const [visibility, setVisibility] = useState("system");
  const [startingMessage, setStartingMessage] = useState("");
  const [keywords, setKeywords] = useState<string[]>([]);
  const [requiredFunctionCalls, setRequiredFunctionCalls] = useState<string[]>([]);
  const [suggestedFrequency, setSuggestedFrequency] = useState("daily");
  const [frequencyIntervalDays, setFrequencyIntervalDays] = useState<number | "">("");
  const [dailyDigest, setDailyDigest] = useState(false);
  const [llmModel, setLlmModel] = useState("");

  // Reject dialog
  const [rejectDialogOpen, setRejectDialogOpen] = useState(false);
  const [rejectTarget, setRejectTarget] = useState<ScheduleTemplate | null>(null);
  const [rejectFeedback, setRejectFeedback] = useState("");

  // Expanded rows
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Delete confirmation
  const [deleteTarget, setDeleteTarget] = useState<ScheduleTemplate | null>(null);

  // Available function calls for autocomplete
  const [availableFunctionCalls, setAvailableFunctionCalls] = useState<string[]>([]);

  const fetchTemplates = useCallback(async () => {
    try {
      const res = await axios.get(buildApiUrl("/api/admin/schedule-templates"), {
        headers: { Authorization: `Bearer ${token}` },
      });
      const all = res.data || [];
      setPendingTemplates(all.filter((t: ScheduleTemplate) => t.visibility === "pending_review"));
      setTemplates(all.filter((t: ScheduleTemplate) => t.visibility !== "pending_review"));
    } catch {
      setError("Failed to load schedule templates");
    } finally {
      setLoading(false);
    }
  }, [token]);

  const fetchAvailableFunctionCalls = useCallback(async () => {
    try {
      const res = await axios.get(buildApiUrl("/api/agent-mode/function-calls"), {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.data?.functionCalls) {
        const names = res.data.functionCalls.map((fc: { name: string }) => fc.name);
        setAvailableFunctionCalls(names);
      }
    } catch {
      // Non-critical
    }
  }, [token]);

  useEffect(() => { fetchTemplates(); fetchAvailableFunctionCalls(); }, [fetchTemplates, fetchAvailableFunctionCalls]);

  const openCreateDialog = () => {
    setEditingTemplate(null);
    setName("");
    setDescription("");
    setCategory("General");
    setVisibility("system");
    setStartingMessage("");
    setKeywords([]);
    setRequiredFunctionCalls([]);
    setSuggestedFrequency("daily");
    setFrequencyIntervalDays("");
    setDailyDigest(false);
    setLlmModel("");
    setDialogOpen(true);
  };

  const openEditDialog = (tpl: ScheduleTemplate) => {
    setEditingTemplate(tpl);
    setName(tpl.name);
    setDescription(tpl.description || "");
    setCategory(tpl.category || "General");
    setVisibility(tpl.visibility);
    setStartingMessage(tpl.startingMessage);
    setKeywords(tpl.keywords || []);
    setRequiredFunctionCalls(tpl.requiredFunctionCalls || []);
    setSuggestedFrequency(tpl.suggestedFrequency || "daily");
    setFrequencyIntervalDays(tpl.frequencyIntervalDays || "");
    setDailyDigest(tpl.dailyDigest || false);
    setLlmModel(tpl.llmModel || "");
    setDialogOpen(true);
  };

  const handleSave = async () => {
    if (!name.trim()) { setError("Name is required"); return; }
    if (!startingMessage.trim()) { setError("Starting message is required"); return; }
    setSaving(true);
    setError("");
    try {
      const body: any = {
        name, description, category, visibility, startingMessage,
        keywords, requiredFunctionCalls, suggestedFrequency, dailyDigest, llmModel,
      };
      if (suggestedFrequency === "every_n_days" && frequencyIntervalDays) {
        body.frequencyIntervalDays = Number(frequencyIntervalDays);
      }
      if (editingTemplate) {
        await axios.put(buildApiUrl(`/api/admin/schedule-templates/${editingTemplate.templateId}`), body, {
          headers: { Authorization: `Bearer ${token}` },
        });
        setSuccess("Template updated");
      } else {
        await axios.post(buildApiUrl("/api/admin/schedule-templates"), body, {
          headers: { Authorization: `Bearer ${token}` },
        });
        setSuccess("Template created");
      }
      setDialogOpen(false);
      fetchTemplates();
    } catch (err: any) {
      setError(err.response?.data?.message || "Failed to save template");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await axios.delete(buildApiUrl(`/api/admin/schedule-templates/${deleteTarget.templateId}`), {
        headers: { Authorization: `Bearer ${token}` },
      });
      setSuccess("Template deleted");
      setDeleteTarget(null);
      fetchTemplates();
    } catch {
      setError("Failed to delete template");
    }
  };

  const handleApprove = async (templateId: string) => {
    try {
      await axios.post(buildApiUrl(`/api/admin/schedule-templates/${templateId}/approve`), {}, {
        headers: { Authorization: `Bearer ${token}` },
      });
      setSuccess("Template approved!");
      fetchTemplates();
    } catch {
      setError("Failed to approve template");
    }
  };

  const handleReject = async () => {
    if (!rejectTarget || !rejectFeedback.trim()) return;
    try {
      await axios.post(buildApiUrl(`/api/admin/schedule-templates/${rejectTarget.templateId}/reject`), {
        feedback: rejectFeedback,
      }, { headers: { Authorization: `Bearer ${token}` } });
      setSuccess("Template rejected");
      setRejectDialogOpen(false);
      setRejectTarget(null);
      setRejectFeedback("");
      fetchTemplates();
    } catch {
      setError("Failed to reject template");
    }
  };

  // Extract variables from message for preview
  const extractedVars = startingMessage.match(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g)
    ?.map(m => m.replace(/[{}]/g, "").trim()) || [];

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
          <Typography variant="h4" gutterBottom>Schedule Templates</Typography>
          <Typography variant="body2" color="text.secondary">
            Manage reusable templates for scheduled chats and review user-submitted templates.
          </Typography>
        </Box>
        <Button variant="contained" startIcon={<AddIcon />} onClick={openCreateDialog}>
          Create Template
        </Button>
      </Box>

      {/* Pending Review Queue */}
      {pendingTemplates.length > 0 && (
        <Paper variant="outlined" sx={{ p: 2, mb: 3, borderColor: "warning.main", bgcolor: "warning.light", opacity: 0.9 }}>
          <Typography variant="h6" sx={{ mb: 1 }}>
            Pending Review ({pendingTemplates.length})
          </Typography>
          <Stack spacing={1}>
            {pendingTemplates.map((tpl) => (
              <Box key={tpl.templateId} sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", p: 1, bgcolor: "background.paper", borderRadius: 1 }}>
                <Box>
                  <strong>{tpl.name}</strong>
                  <Typography variant="body2" color="text.secondary" component="span" sx={{ ml: 1 }}>
                    {tpl.category} | {tpl.suggestedFrequency || "daily"}
                  </Typography>
                  {tpl.description && (
                    <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                      {tpl.description}
                    </Typography>
                  )}
                  <Typography variant="caption" color="text.secondary" sx={{ ml: 1 }}>
                    (by {tpl.createdBy?.substring(0, 8)}...)
                  </Typography>
                </Box>
                <Stack direction="row" spacing={1}>
                  <Button variant="contained" color="success" size="small" onClick={() => handleApprove(tpl.templateId)}>
                    Approve
                  </Button>
                  <Button variant="outlined" color="error" size="small" onClick={() => { setRejectTarget(tpl); setRejectDialogOpen(true); }}>
                    Reject
                  </Button>
                </Stack>
              </Box>
            ))}
          </Stack>
        </Paper>
      )}

      {/* Templates Table */}
      <TableContainer component={Paper}>
        <Table>
          <TableHead>
            <TableRow>
              <TableCell width={40} />
              <TableCell>Name</TableCell>
              <TableCell>Category</TableCell>
              <TableCell>Frequency</TableCell>
              <TableCell>Visibility</TableCell>
              <TableCell>Usage</TableCell>
              <TableCell>Owner</TableCell>
              <TableCell align="right">Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {templates.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} align="center" sx={{ py: 4 }}>
                  <Typography color="text.secondary">No schedule templates yet. Create one to get started.</Typography>
                </TableCell>
              </TableRow>
            ) : (
              templates.map((tpl) => (
                <React.Fragment key={tpl.templateId}>
                  <TableRow hover sx={{ cursor: "pointer" }} onClick={() => setExpandedId(expandedId === tpl.templateId ? null : tpl.templateId)}>
                    <TableCell>
                      <IconButton size="small">
                        {expandedId === tpl.templateId ? <ExpandLessIcon /> : <ExpandMoreIcon />}
                      </IconButton>
                    </TableCell>
                    <TableCell>
                      <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
                        {tpl.visibility === "private" && (
                          <Tooltip title="Private — only visible to you">
                            <LockIcon fontSize="small" sx={{ color: "text.secondary", fontSize: 16 }} />
                          </Tooltip>
                        )}
                        <Typography variant="body2" fontWeight="medium">{tpl.name}</Typography>
                      </Box>
                      {tpl.description && (
                        <Typography variant="caption" color="text.secondary" sx={{ display: "block", ml: tpl.visibility === "private" ? 2.5 : 0 }}>
                          {tpl.description.length > 80 ? tpl.description.substring(0, 80) + "..." : tpl.description}
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell><Chip label={tpl.category} size="small" variant="outlined" /></TableCell>
                    <TableCell>{tpl.suggestedFrequency || "daily"}</TableCell>
                    <TableCell>
                      <Chip label={tpl.visibility} size="small" color={visibilityColor(tpl.visibility) as any} />
                    </TableCell>
                    <TableCell>{tpl.usageCount || 0}</TableCell>
                    <TableCell>
                      <Typography variant="caption" color="text.secondary">
                        {tpl.createdBy ? tpl.createdBy.substring(0, 8) + "..." : "--"}
                      </Typography>
                    </TableCell>
                    <TableCell align="right">
                      <Tooltip title="Edit">
                        <IconButton size="small" onClick={(e) => { e.stopPropagation(); openEditDialog(tpl); }}>
                          <EditIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title="Delete">
                        <IconButton size="small" onClick={(e) => { e.stopPropagation(); setDeleteTarget(tpl); }} color="error">
                          <DeleteIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    </TableCell>
                  </TableRow>
                  <TableRow key={`${tpl.templateId}-expand`}>
                    <TableCell colSpan={8} sx={{ p: 0, border: expandedId === tpl.templateId ? undefined : "none" }}>
                      <Collapse in={expandedId === tpl.templateId}>
                        <Box sx={{ p: 2, bgcolor: "grey.50" }}>
                          <Typography variant="body2" sx={{ mb: 1 }}>
                            <strong>Starting Message:</strong> {tpl.startingMessage}
                          </Typography>
                          {tpl.variables && tpl.variables.length > 0 && (
                            <Box sx={{ mb: 1 }}>
                              <Typography variant="body2"><strong>Variables:</strong></Typography>
                              {tpl.variables.map((v, i) => (
                                <Chip key={i} label={`{{${v.name}}}${v.description ? ` - ${v.description}` : ""}`} size="small" variant="outlined" sx={{ mr: 0.5, mb: 0.5, fontFamily: "monospace", fontSize: "0.75rem" }} />
                              ))}
                            </Box>
                          )}
                          {tpl.keywords && tpl.keywords.length > 0 && (
                            <Box sx={{ mb: 1 }}>
                              <Typography variant="body2" component="span"><strong>Keywords:</strong> </Typography>
                              {tpl.keywords.map((kw, i) => (
                                <Chip key={i} label={kw} size="small" sx={{ mr: 0.5 }} />
                              ))}
                            </Box>
                          )}
                          {tpl.requiredFunctionCalls && tpl.requiredFunctionCalls.length > 0 && (
                            <Box sx={{ mb: 1 }}>
                              <Typography variant="body2" component="span"><strong>Required Functions:</strong> </Typography>
                              {tpl.requiredFunctionCalls.map((fc, i) => (
                                <Chip key={i} label={fc} size="small" variant="outlined" sx={{ mr: 0.5, fontFamily: "monospace", fontSize: "0.7rem" }} />
                              ))}
                            </Box>
                          )}
                          <Typography variant="body2">
                            <strong>Settings:</strong>{" "}
                            {tpl.llmModel && <Chip label={`Model: ${tpl.llmModel}`} size="small" sx={{ mr: 0.5 }} />}
                            {tpl.dailyDigest && <Chip label="Daily Digest" size="small" sx={{ mr: 0.5 }} />}
                            {tpl.emailNotifications && tpl.emailNotifications.length > 0 && (
                              <Chip label={`${tpl.emailNotifications.length} email(s)`} size="small" sx={{ mr: 0.5 }} />
                            )}
                          </Typography>
                          {tpl.reviewFeedback && (
                            <Alert severity="info" sx={{ mt: 1 }}>
                              <strong>Review Feedback:</strong> {tpl.reviewFeedback}
                            </Alert>
                          )}
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
        <DialogTitle>{editingTemplate ? "Edit Schedule Template" : "Create Schedule Template"}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} fullWidth required />
            <TextField label="Description" value={description} onChange={(e) => setDescription(e.target.value)} fullWidth multiline rows={2} />

            <Box sx={{ display: "flex", gap: 2, flexWrap: "wrap" }}>
              <FormControl size="small" sx={{ minWidth: 150 }}>
                <InputLabel>Category</InputLabel>
                <Select value={category} label="Category" onChange={(e) => setCategory(e.target.value)}>
                  {["General", "SEO", "Social", "Email", "Content", "Analytics", "Ads", "CRM", "Other"].map((c) => (
                    <MenuItem key={c} value={c}>{c}</MenuItem>
                  ))}
                </Select>
              </FormControl>
              <FormControl size="small" sx={{ minWidth: 150 }}>
                <InputLabel>Visibility</InputLabel>
                <Select value={visibility} label="Visibility" onChange={(e) => setVisibility(e.target.value)}>
                  <MenuItem value="system">System</MenuItem>
                  <MenuItem value="public">Public</MenuItem>
                  <MenuItem value="private">Private</MenuItem>
                </Select>
              </FormControl>
              <FormControl size="small" sx={{ minWidth: 150 }}>
                <InputLabel>Frequency</InputLabel>
                <Select value={suggestedFrequency} label="Frequency" onChange={(e) => setSuggestedFrequency(e.target.value)}>
                  {["hourly", "daily", "weekly", "monthly", "every_n_days"].map((f) => (
                    <MenuItem key={f} value={f}>{f.replace(/_/g, " ")}</MenuItem>
                  ))}
                </Select>
              </FormControl>
              {suggestedFrequency === "every_n_days" && (
                <TextField
                  label="Interval (days)"
                  type="number"
                  size="small"
                  sx={{ width: 130 }}
                  value={frequencyIntervalDays}
                  onChange={(e) => setFrequencyIntervalDays(e.target.value ? Number(e.target.value) : "")}
                />
              )}
            </Box>

            <TextField
              label="Starting Message"
              value={startingMessage}
              onChange={(e) => setStartingMessage(e.target.value)}
              fullWidth
              multiline
              rows={4}
              required
              helperText={`Use {{variable_name}} for variables.${extractedVars.length > 0 ? ` Detected: ${extractedVars.join(", ")}` : ""}`}
            />

            <Autocomplete
              multiple
              freeSolo
              size="small"
              options={[]}
              value={keywords}
              onChange={(_e, newValue) => setKeywords(newValue)}
              renderTags={(value, getTagProps) =>
                value.map((option, index) => {
                  const { key, ...rest } = getTagProps({ index });
                  return <Chip key={key} label={option} size="small" {...rest} />;
                })
              }
              renderInput={(params) => (
                <TextField {...params} label="Keywords" placeholder="Type and press Enter" helperText="Keywords to verify in scheduled chat output" />
              )}
            />

            <Autocomplete
              multiple
              freeSolo
              size="small"
              options={availableFunctionCalls}
              value={requiredFunctionCalls}
              onChange={(_e, newValue) => setRequiredFunctionCalls(newValue)}
              renderTags={(value, getTagProps) =>
                value.map((option, index) => {
                  const { key, ...rest } = getTagProps({ index });
                  return <Chip key={key} label={option} size="small" variant="outlined" sx={{ fontFamily: "monospace", fontSize: "0.75rem" }} {...rest} />;
                })
              }
              renderInput={(params) => (
                <TextField {...params} label="Required Function Calls" placeholder="Select or type function names" helperText="Functions required in each scheduled run" />
              )}
            />

            <Box sx={{ display: "flex", gap: 2, flexWrap: "wrap" }}>
              <TextField label="LLM Model" value={llmModel} onChange={(e) => setLlmModel(e.target.value)} size="small" sx={{ minWidth: 200 }} placeholder="Leave blank for default" />
              <FormControlLabel control={<Switch checked={dailyDigest} onChange={(e) => setDailyDigest(e.target.checked)} />} label="Daily Digest" />
            </Box>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialogOpen(false)}>Cancel</Button>
          <Button onClick={handleSave} variant="contained" disabled={saving}>
            {saving ? <CircularProgress size={20} /> : editingTemplate ? "Update" : "Create"}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Reject Dialog */}
      <Dialog open={rejectDialogOpen} onClose={() => { setRejectDialogOpen(false); setRejectTarget(null); setRejectFeedback(""); }} maxWidth="sm" fullWidth>
        <DialogTitle>Reject Template: {rejectTarget?.name}</DialogTitle>
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
        <DialogTitle>Delete Schedule Template</DialogTitle>
        <DialogContent>
          <Typography>
            Are you sure you want to delete "{deleteTarget?.name}"? This action cannot be undone.
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
