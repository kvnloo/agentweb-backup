import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Container,
  Typography,
  Box,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TablePagination,
  TextField,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  Chip,
  IconButton,
  Tooltip,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  DialogContentText,
  CircularProgress,
  Alert,
  Stack,
  Button,
  InputAdornment,
  FormGroup,
  FormControlLabel,
  Checkbox,
} from "@mui/material";
import {
  Visibility as VisibilityIcon,
  Search as SearchIcon,
  Close as CloseIcon,
  DesktopMac as DesktopIcon,
  TabletMac as TabletIcon,
  PhoneIphone as MobileIcon,
  Refresh as RefreshIcon,
  Close as ClearFiltersIcon,
  Add as AddIcon,
  Edit as EditIcon,
  Delete as DeleteIcon,
  Save as SaveIcon,
} from "@mui/icons-material";
import { buildPreviewSrcDoc, getPreviewBaseHref } from "../utils/templatePreview";
import axios from "axios";
import { useAuth } from "../contexts/AuthContext";
import { buildApiUrl } from "../config";

interface PublicTemplate {
  template_id: string;
  template_name: string;
  type: string[];
  subject?: string;
  html_content: string;
  variables: string[];
  arrayVariables: string[];
  isPublic: boolean;
  created_at?: string;
  updated_at?: string;
}

interface FormData {
  template_id?: string;
  template_name: string;
  subject: string;
  html_content: string;
  type: string[];
}

const PAGE_SIZE = 25;

const extractVariables = (htmlContent: string, subject?: string): { variables: string[]; arrayVariables: string[] } => {
  const variableRegex = /\{\{([^}]+)\}\}|\{([a-zA-Z0-9_]+)\}/g;
  const allVariables: string[] = [];
  const regularVariables: string[] = [];
  const arrayVariableNames = new Set<string>();
  let match;

  while ((match = variableRegex.exec(htmlContent)) !== null) {
    const variable = (match[1] ?? match[2])?.trim();
    if (!variable) continue;
    if (!allVariables.includes(variable)) allVariables.push(variable);
  }

  if (subject) {
    let subjectMatch;
    variableRegex.lastIndex = 0;
    while ((subjectMatch = variableRegex.exec(subject)) !== null) {
      const variable = (subjectMatch[1] ?? subjectMatch[2])?.trim();
      if (!variable) continue;
      if (!allVariables.includes(variable)) allVariables.push(variable);
    }
  }

  const nPatterns = new Set<string>();
  allVariables.forEach(variable => {
    const nMatch = variable.match(/^(.+)_n(?:_(.+))?$/);
    if (nMatch) {
      const suffix = nMatch[2];
      nPatterns.add(suffix ? `${nMatch[1]}_n_${suffix}` : `${nMatch[1]}_n`);
    }
  });

  const processedArrayNames = new Set<string>();
  allVariables.forEach(variable => {
    let isArrayVariable = false;
    nPatterns.forEach(nPattern => {
      const baseName = nPattern.replace(/_n.*$/, '');
      const numericMatch = variable.match(new RegExp(`^${baseName}_(\\d+)(?:_|$)`));
      if (numericMatch) {
        if (!processedArrayNames.has(nPattern)) {
          arrayVariableNames.add(nPattern);
          processedArrayNames.add(nPattern);
        }
        isArrayVariable = true;
      }
    });
    const nMatch = variable.match(/^(.+)_n(?:_(.+))?$/);
    if (nMatch) {
      const suffix = nMatch[2];
      const fullName = suffix ? `${nMatch[1]}_n_${suffix}` : `${nMatch[1]}_n`;
      if (!processedArrayNames.has(fullName)) {
        arrayVariableNames.add(fullName);
        processedArrayNames.add(fullName);
      }
      isArrayVariable = true;
    }
    if (!isArrayVariable) regularVariables.push(variable);
  });

  return { variables: regularVariables, arrayVariables: Array.from(arrayVariableNames) };
};

const emptyForm = (): FormData => ({ template_name: "", subject: "", html_content: "", type: ["email"] });

export default function HtmlTemplates() {
  const { token } = useAuth();
  const [templates, setTemplates] = useState<PublicTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<"all" | "email" | "landing_page">("all");

  // Pagination
  const [page, setPage] = useState(0);

  // Preview
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewSrcDoc, setPreviewSrcDoc] = useState<string>("");
  const [previewTitle, setPreviewTitle] = useState<string>("");
  const [previewViewport, setPreviewViewport] = useState<"desktop" | "tablet" | "mobile">("desktop");

  // Create / Edit dialog
  const [formOpen, setFormOpen] = useState(false);
  const [formMode, setFormMode] = useState<"create" | "edit">("create");
  const [formData, setFormData] = useState<FormData>(emptyForm());
  const [saving, setSaving] = useState(false);

  // Delete dialog
  const [deleteTarget, setDeleteTarget] = useState<PublicTemplate | null>(null);
  const [deleting, setDeleting] = useState(false);

  const headers = { Authorization: `Bearer ${token}` };

  const fetchTemplates = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await axios.get(buildApiUrl("/api/html-templates?scope=public"), { headers });
      setTemplates(res.data.templates ?? []);
    } catch {
      setError("Failed to load templates.");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { fetchTemplates(); }, [fetchTemplates]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return templates.filter(t => {
      if (q && !t.template_name.toLowerCase().includes(q)) return false;
      if (typeFilter !== "all" && !(t.type ?? []).includes(typeFilter)) return false;
      return true;
    });
  }, [templates, search, typeFilter]);

  const paginated = useMemo(() =>
    filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE),
    [filtered, page]
  );

  useEffect(() => { setPage(0); }, [search, typeFilter]);

  // Preview
  const handlePreview = (t: PublicTemplate) => {
    setPreviewTitle(t.template_name);
    setPreviewViewport("desktop");
    setPreviewOpen(true);
    setPreviewLoading(true);
    setPreviewSrcDoc(buildPreviewSrcDoc({ html_content: t.html_content }, { baseHref: getPreviewBaseHref() }));
    setPreviewLoading(false);
  };

  // Preview from form (live HTML)
  const handlePreviewFromForm = () => {
    if (!formData.html_content) return;
    setPreviewTitle(formData.template_name || "Preview");
    setPreviewViewport("desktop");
    setPreviewSrcDoc(buildPreviewSrcDoc({ html_content: formData.html_content }, { baseHref: getPreviewBaseHref() }));
    setPreviewOpen(true);
  };

  // Create
  const handleCreate = () => {
    setFormData(emptyForm());
    setFormMode("create");
    setFormOpen(true);
  };

  // Edit
  const handleEdit = (t: PublicTemplate) => {
    setFormData({
      template_id: t.template_id,
      template_name: t.template_name,
      subject: t.subject ?? "",
      html_content: t.html_content,
      type: t.type ?? ["email"],
    });
    setFormMode("edit");
    setFormOpen(true);
  };

  // Save (create or update)
  const handleSave = async () => {
    setSaving(true);
    try {
      const { variables, arrayVariables } = extractVariables(formData.html_content, formData.subject);
      await axios.post(
        buildApiUrl("/api/html-templates"),
        {
          ...(formMode === "edit" && formData.template_id ? { template_id: formData.template_id } : {}),
          template_name: formData.template_name,
          subject: formData.subject,
          html_content: formData.html_content,
          type: formData.type,
          variables,
          arrayVariables,
          isPublic: true,
        },
        { headers }
      );
      setFormOpen(false);
      await fetchTemplates();
    } catch {
      setError("Failed to save template.");
    } finally {
      setSaving(false);
    }
  };

  // Delete
  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await axios.delete(
        buildApiUrl(`/api/html-templates/${deleteTarget.template_id}?isPublic=true`),
        { headers }
      );
      setDeleteTarget(null);
      await fetchTemplates();
    } catch {
      setError("Failed to delete template.");
    } finally {
      setDeleting(false);
    }
  };

  const toggleType = (t: string) => {
    setFormData(prev => {
      if (prev.type.includes(t)) {
        if (prev.type.length === 1) return prev;
        return { ...prev, type: prev.type.filter(x => x !== t) };
      }
      return { ...prev, type: [...prev.type, t] };
    });
  };

  const detectedVars = useMemo(() => {
    if (!formData.html_content) return null;
    return extractVariables(formData.html_content, formData.type.includes("email") ? formData.subject : "");
  }, [formData.html_content, formData.subject, formData.type]);

  const saveDisabled = saving
    || !formData.template_name
    || !formData.html_content
    || formData.type.length === 0
    || (formData.type.includes("email") && !formData.subject);

  const hasFilters = search || typeFilter !== "all";

  return (
    <Container maxWidth="xl" sx={{ py: 4 }}>
      <Box sx={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", mb: 3 }}>
        <Box>
          <Typography variant="h4" gutterBottom>HTML Templates</Typography>
          <Typography variant="body2" color="text.secondary">
            Manage public HTML templates available to all users.
          </Typography>
        </Box>
        <Button variant="contained" startIcon={<AddIcon />} onClick={handleCreate}>
          New Template
        </Button>
      </Box>

      {error && <Alert severity="error" sx={{ my: 2 }} onClose={() => setError(null)}>{error}</Alert>}

      {/* Filters */}
      <Box sx={{ my: 3, display: "flex", alignItems: "center", gap: 1.5, flexWrap: "wrap" }}>
        <TextField
          size="small"
          placeholder="Search templates…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          sx={{ minWidth: 280, flexGrow: 1, maxWidth: 400 }}
          InputProps={{
            startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment>,
          }}
        />
        <FormControl size="small" sx={{ minWidth: 140 }}>
          <InputLabel>Type</InputLabel>
          <Select value={typeFilter} label="Type" onChange={e => setTypeFilter(e.target.value as typeof typeFilter)}>
            <MenuItem value="all">All Types</MenuItem>
            <MenuItem value="email">Email</MenuItem>
            <MenuItem value="landing_page">Landing Page</MenuItem>
          </Select>
        </FormControl>

        <Box sx={{ display: "flex", alignItems: "center", gap: 1, ml: "auto" }}>
          {hasFilters && (
            <Tooltip title="Clear Filters">
              <Button
                variant="outlined"
                size="small"
                color="error"
                onClick={() => { setSearch(""); setTypeFilter("all"); }}
                sx={{ minWidth: 40, height: 40, p: 0, borderColor: "divider" }}
              >
                <ClearFiltersIcon fontSize="small" />
              </Button>
            </Tooltip>
          )}
          <Tooltip title="Reload Templates">
            <Button
              variant="outlined"
              size="small"
              onClick={fetchTemplates}
              sx={{ minWidth: 40, height: 40, p: 0, color: "text.secondary", borderColor: "divider" }}
            >
              <RefreshIcon fontSize="small" />
            </Button>
          </Tooltip>
        </Box>
      </Box>

      {loading ? (
        <Box sx={{ display: "flex", justifyContent: "center", py: 8 }}>
          <CircularProgress />
        </Box>
      ) : (
        <Paper>
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Template Name</TableCell>
                  <TableCell>Type</TableCell>
                  <TableCell>Subject</TableCell>
                  <TableCell>Updated</TableCell>
                  <TableCell align="right">Actions</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {paginated.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} align="center" sx={{ py: 4, color: "text.secondary" }}>
                      No public templates found.
                    </TableCell>
                  </TableRow>
                ) : paginated.map(t => (
                  <TableRow key={t.template_id} hover>
                    <TableCell sx={{ fontWeight: 500 }}>{t.template_name}</TableCell>
                    <TableCell>
                      <Stack direction="row" spacing={0.5}>
                        {(t.type ?? []).map(ty => (
                          <Chip
                            key={ty}
                            label={ty === "landing_page" ? "LP" : "Email"}
                            size="small"
                            variant="outlined"
                            color={ty === "landing_page" ? "secondary" : "primary"}
                          />
                        ))}
                      </Stack>
                    </TableCell>
                    <TableCell sx={{ color: "text.secondary", fontSize: "0.8rem", maxWidth: 220 }}>
                      <Box sx={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {t.subject ?? "—"}
                      </Box>
                    </TableCell>
                    <TableCell sx={{ color: "text.secondary", fontSize: "0.8rem" }}>
                      {t.updated_at ? new Date(t.updated_at).toLocaleDateString() : "—"}
                    </TableCell>
                    <TableCell align="right">
                      <Stack direction="row" spacing={0.5} justifyContent="flex-end">
                        <Tooltip title="Preview">
                          <IconButton size="small" onClick={() => handlePreview(t)}>
                            <VisibilityIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                        <Tooltip title="Edit">
                          <IconButton size="small" onClick={() => handleEdit(t)}>
                            <EditIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                        <Tooltip title="Delete">
                          <IconButton size="small" color="error" onClick={() => setDeleteTarget(t)}>
                            <DeleteIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      </Stack>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
          <TablePagination
            component="div"
            count={filtered.length}
            page={page}
            rowsPerPage={PAGE_SIZE}
            rowsPerPageOptions={[PAGE_SIZE]}
            onPageChange={(_, p) => setPage(p)}
          />
        </Paper>
      )}

      {/* Create / Edit Dialog */}
      <Dialog open={formOpen} onClose={() => !saving && setFormOpen(false)} maxWidth="md" fullWidth
        PaperProps={{ sx: { height: "90vh", display: "flex", flexDirection: "column" } }}
      >
        <DialogTitle sx={{ flexShrink: 0 }}>
          {formMode === "create" ? "New Public Template" : "Edit Public Template"}
        </DialogTitle>
        <DialogContent dividers sx={{ flex: 1, overflow: "auto", display: "flex", flexDirection: "column", gap: 2 }}>
          {/* Name + Subject */}
          <Box sx={{ display: "grid", gridTemplateColumns: formData.type.includes("email") ? "1fr 1fr" : "1fr", gap: 2 }}>
            <TextField
              label="Template Name *"
              value={formData.template_name}
              onChange={e => setFormData(p => ({ ...p, template_name: e.target.value }))}
              size="small"
              fullWidth
              placeholder="e.g., welcome_email"
            />
            {formData.type.includes("email") && (
              <TextField
                label="Subject *"
                value={formData.subject}
                onChange={e => setFormData(p => ({ ...p, subject: e.target.value }))}
                size="small"
                fullWidth
                placeholder="e.g., Welcome {{user_name}}!"
              />
            )}
          </Box>

          {/* Type checkboxes */}
          <Box>
            <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5 }}>
              Template Types *
            </Typography>
            <FormGroup row sx={{ border: 1, borderColor: "divider", borderRadius: 1, px: 2, py: 0.5, mt: 0.5 }}>
              <FormControlLabel
                control={<Checkbox checked={formData.type.includes("email")} onChange={() => toggleType("email")} size="small" />}
                label="Email"
              />
              <FormControlLabel
                control={<Checkbox checked={formData.type.includes("landing_page")} onChange={() => toggleType("landing_page")} size="small" />}
                label="Landing Page"
              />
            </FormGroup>
          </Box>

          {/* HTML Content */}
          <Box sx={{ flex: 1, display: "flex", flexDirection: "column", gap: 1 }}>
            <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5 }}>
              HTML Content *
            </Typography>
            <TextField
              multiline
              value={formData.html_content}
              onChange={e => setFormData(p => ({ ...p, html_content: e.target.value }))}
              placeholder={'Enter HTML with variables like {{user_name}}, {{company_name}}…'}
              inputProps={{ style: { fontFamily: "monospace", fontSize: 13 } }}
              sx={{ flex: 1, "& .MuiInputBase-root": { alignItems: "flex-start", height: "100%", minHeight: 300 } }}
              fullWidth
            />
            <Typography variant="caption" color="text.secondary">
              Use variables in double curly braces: {`{{variable_name}}`}
            </Typography>

            {/* Detected Variables */}
            {detectedVars && (detectedVars.variables.length > 0 || detectedVars.arrayVariables.length > 0) && (
              <Box sx={{ p: 1.5, bgcolor: "grey.50", borderRadius: 1, border: 1, borderColor: "divider" }}>
                <Typography variant="caption" sx={{ fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, color: "text.secondary" }}>
                  Detected Variables
                </Typography>
                <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5, mt: 0.75 }}>
                  {detectedVars.variables.map(v => (
                    <Chip key={v} label={`{{${v}}}`} size="small" variant="outlined" sx={{ fontFamily: "monospace", fontSize: 11 }} />
                  ))}
                  {detectedVars.arrayVariables.map(v => (
                    <Chip key={v} label={`{{${v}}}`} size="small" variant="outlined" color="primary" sx={{ fontFamily: "monospace", fontSize: 11 }} />
                  ))}
                </Box>
              </Box>
            )}
          </Box>
        </DialogContent>
        <DialogActions sx={{ px: 3, py: 2, flexShrink: 0 }}>
          <Button onClick={() => setFormOpen(false)} disabled={saving}>Cancel</Button>
          <Button
            variant="outlined"
            onClick={handlePreviewFromForm}
            disabled={!formData.html_content}
            startIcon={<VisibilityIcon />}
          >
            Preview
          </Button>
          <Button
            variant="contained"
            onClick={handleSave}
            disabled={saveDisabled}
            startIcon={saving ? <CircularProgress size={16} /> : <SaveIcon />}
          >
            {saving ? (formMode === "create" ? "Creating…" : "Saving…") : (formMode === "create" ? "Create Template" : "Save Changes")}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Delete Confirmation */}
      <Dialog open={!!deleteTarget} onClose={() => !deleting && setDeleteTarget(null)}>
        <DialogTitle>Delete Template</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Delete <strong>{deleteTarget?.template_name}</strong>? This public template will be removed for all users. This cannot be undone.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteTarget(null)} disabled={deleting}>Cancel</Button>
          <Button color="error" variant="contained" onClick={handleDeleteConfirm} disabled={deleting}
            startIcon={deleting ? <CircularProgress size={16} /> : <DeleteIcon />}
          >
            {deleting ? "Deleting…" : "Delete"}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Preview Dialog — full-screen with viewport switcher */}
      <Dialog open={previewOpen} onClose={() => setPreviewOpen(false)} fullScreen>
        <Box sx={{ display: "flex", flexDirection: "column", height: "100vh" }}>
          <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", px: 2, py: 1.5, borderBottom: 1, borderColor: "divider", flexShrink: 0 }}>
            <Typography variant="subtitle1" fontWeight={600}>{previewTitle} — Preview</Typography>
            <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
              <Box sx={{ display: "flex", border: 1, borderColor: "divider", borderRadius: 1, overflow: "hidden" }}>
                {([
                  { key: "desktop", icon: <DesktopIcon fontSize="small" />, label: "Desktop" },
                  { key: "tablet",  icon: <TabletIcon  fontSize="small" />, label: "Tablet"  },
                  { key: "mobile",  icon: <MobileIcon  fontSize="small" />, label: "Mobile"  },
                ] as const).map(({ key, icon, label }) => (
                  <Tooltip key={key} title={label}>
                    <IconButton
                      size="small"
                      onClick={() => setPreviewViewport(key)}
                      sx={{ borderRadius: 0, bgcolor: previewViewport === key ? "action.selected" : "transparent", px: 1 }}
                    >
                      {icon}
                    </IconButton>
                  </Tooltip>
                ))}
              </Box>
              <Tooltip title="Close preview">
                <IconButton size="small" onClick={() => setPreviewOpen(false)}>
                  <CloseIcon />
                </IconButton>
              </Tooltip>
            </Box>
          </Box>

          <Box sx={{
            flex: 1,
            overflow: "hidden",
            display: "flex",
            justifyContent: "center",
            bgcolor: previewViewport !== "desktop" ? "grey.100" : "white",
          }}>
            {previewLoading ? (
              <Box sx={{ display: "flex", alignItems: "center", justifyContent: "center", width: "100%" }}>
                <CircularProgress />
              </Box>
            ) : (
              <iframe
                srcDoc={previewSrcDoc}
                title="Template Preview"
                sandbox="allow-scripts"
                style={{
                  border: "none",
                  height: "100%",
                  width: previewViewport === "mobile" ? 375
                       : previewViewport === "tablet" ? 768
                       : "100%",
                  boxShadow: previewViewport !== "desktop" ? "0 4px 24px rgba(0,0,0,0.15)" : "none",
                  transition: "width 0.3s ease",
                }}
              />
            )}
          </Box>
        </Box>
      </Dialog>
    </Container>
  );
}
