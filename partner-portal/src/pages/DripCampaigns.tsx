/**
 * Partner Portal — Drip Campaigns admin page.
 *
 * Lifecycle Drip Phase 3: configuration-only UI. CRUD against
 * /api/admin/drip-campaigns. The executor/scheduler ships in Phase 4.
 *
 * Both entry points (this page and Emma's `manage_drip_campaign` tool) write
 * to the same backend, so admins can stand up a campaign either way and see
 * it in both places.
 */

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
  Alert,
  CircularProgress,
  Chip,
  Stack,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  FormControlLabel,
  Switch,
  Tooltip,
} from "@mui/material";
import {
  Edit as EditIcon,
  Add as AddIcon,
  Delete as DeleteIcon,
  PlayArrow as PlayIcon,
  Pause as PauseIcon,
  Visibility as PreviewIcon,
} from "@mui/icons-material";
import axios from "axios";
import { useAuth } from "../contexts/AuthContext";
import { API_URL } from "../config";

// Allowed values mirror dripCampaignDb.ts — keep in lockstep.
const CADENCE_UNITS = ["hours", "days", "weeks"] as const;
type CadenceUnit = (typeof CADENCE_UNITS)[number];

const ONBOARDING_STAGES = [
  "signed_up_no_start",
  "goal_selected",
  "brand_submitted",
  "brand_skipped",
  "data_connected",
  "channel_connected",
  "onboarding_completed",
  "active",
  "stale",
] as const;

interface DripCampaign {
  campaignId: string;
  name: string;
  subjectLine: string;
  templateHtml: string;
  segmentQuery: {
    stage?: string;
    lastActivityBefore?: string;
    goal?: string;
  };
  cadenceUnit: CadenceUnit;
  cadenceValue: number;
  maxSends: number;
  isActive: boolean;
  killSwitch: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

const BASE = `${API_URL}/api/admin/drip-campaigns`;

const DEFAULT_FORM = {
  name: "",
  subjectLine: "",
  templateHtml:
    "<p>Hi {{firstName}},</p>\n<p>Emma at {{companyName}} is waiting — 2 minutes to finish setup.</p>",
  cadenceUnit: "days" as CadenceUnit,
  cadenceValue: 7,
  maxSends: 3,
  isActive: true,
  killSwitch: false,
  segmentStage: "brand_skipped",
  segmentGoal: "",
  segmentLastActivityBefore: "",
};

export default function DripCampaigns() {
  const { token } = useAuth();
  const [campaigns, setCampaigns] = useState<DripCampaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  // Dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ ...DEFAULT_FORM });

  // Preview state
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewHtml, setPreviewHtml] = useState("");

  const authHeaders = { Authorization: `Bearer ${token}` };

  const loadCampaigns = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await axios.get(BASE, { headers: authHeaders });
      setCampaigns(res.data.campaigns ?? []);
    } catch (err: any) {
      setError(err?.response?.data?.message ?? err.message ?? "Load failed");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  useEffect(() => {
    if (token) loadCampaigns();
  }, [token, loadCampaigns]);

  const openCreate = () => {
    setEditingId(null);
    setForm({ ...DEFAULT_FORM });
    setDialogOpen(true);
  };

  const openEdit = (c: DripCampaign) => {
    setEditingId(c.campaignId);
    setForm({
      name: c.name,
      subjectLine: c.subjectLine,
      templateHtml: c.templateHtml,
      cadenceUnit: c.cadenceUnit,
      cadenceValue: c.cadenceValue,
      maxSends: c.maxSends,
      isActive: c.isActive,
      killSwitch: c.killSwitch,
      segmentStage: c.segmentQuery.stage ?? "",
      segmentGoal: c.segmentQuery.goal ?? "",
      segmentLastActivityBefore: c.segmentQuery.lastActivityBefore ?? "",
    });
    setDialogOpen(true);
  };

  const closeDialog = () => {
    setDialogOpen(false);
    setEditingId(null);
  };

  const handleSave = async () => {
    setSaving(true);
    setError("");
    try {
      const body: any = {
        name: form.name,
        subjectLine: form.subjectLine,
        templateHtml: form.templateHtml,
        cadenceUnit: form.cadenceUnit,
        cadenceValue: Number(form.cadenceValue),
        maxSends: Number(form.maxSends),
        isActive: form.isActive,
        killSwitch: form.killSwitch,
        segmentQuery: {
          ...(form.segmentStage && { stage: form.segmentStage }),
          ...(form.segmentGoal && { goal: form.segmentGoal }),
          ...(form.segmentLastActivityBefore && {
            lastActivityBefore: form.segmentLastActivityBefore,
          }),
        },
      };
      if (editingId) {
        await axios.patch(`${BASE}/${editingId}`, body, { headers: authHeaders });
        setSuccess("Campaign updated");
      } else {
        await axios.post(BASE, body, { headers: authHeaders });
        setSuccess("Campaign created");
      }
      closeDialog();
      await loadCampaigns();
    } catch (err: any) {
      setError(err?.response?.data?.message ?? err.message ?? "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (c: DripCampaign) => {
    if (!window.confirm(`Delete "${c.name}"? This cannot be undone.`)) return;
    setError("");
    try {
      await axios.delete(`${BASE}/${c.campaignId}`, { headers: authHeaders });
      setSuccess("Campaign deleted");
      await loadCampaigns();
    } catch (err: any) {
      setError(err?.response?.data?.message ?? "Delete failed");
    }
  };

  const handleKillSwitchToggle = async (c: DripCampaign) => {
    setError("");
    try {
      await axios.patch(
        `${BASE}/${c.campaignId}`,
        { killSwitch: !c.killSwitch },
        { headers: authHeaders },
      );
      setSuccess(
        !c.killSwitch ? "Kill switch ENGAGED — sends paused" : "Kill switch released",
      );
      await loadCampaigns();
    } catch (err: any) {
      setError(err?.response?.data?.message ?? "Toggle failed");
    }
  };

  const handlePreview = async (c: DripCampaign) => {
    setError("");
    try {
      const res = await axios.post(
        `${BASE}/${c.campaignId}/preview`,
        {},
        { headers: authHeaders },
      );
      setPreviewHtml(res.data.renderedHtml ?? "");
      setPreviewOpen(true);
    } catch (err: any) {
      setError(err?.response?.data?.message ?? "Preview failed");
    }
  };

  return (
    <Container maxWidth="lg" sx={{ py: 4 }}>
      <Box sx={{ display: "flex", justifyContent: "space-between", mb: 3 }}>
        <Box>
          <Typography variant="h4">Drip Campaigns</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            Configure lifecycle drip emails. Scheduler ships in Phase 4 —
            campaigns created here won't send until then.
          </Typography>
        </Box>
        <Button variant="contained" startIcon={<AddIcon />} onClick={openCreate}>
          New Campaign
        </Button>
      </Box>

      {error && (
        <Alert severity="error" onClose={() => setError("")} sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}
      {success && (
        <Alert severity="success" onClose={() => setSuccess("")} sx={{ mb: 2 }}>
          {success}
        </Alert>
      )}

      {loading ? (
        <Box sx={{ display: "flex", justifyContent: "center", p: 4 }}>
          <CircularProgress />
        </Box>
      ) : campaigns.length === 0 ? (
        <Paper sx={{ p: 4, textAlign: "center" }}>
          <Typography variant="body1" color="text.secondary">
            No drip campaigns yet. Create one, or ask Emma to create one in chat.
          </Typography>
        </Paper>
      ) : (
        <TableContainer component={Paper}>
          <Table>
            <TableHead>
              <TableRow>
                <TableCell>Name</TableCell>
                <TableCell>Segment</TableCell>
                <TableCell>Cadence</TableCell>
                <TableCell>Max sends</TableCell>
                <TableCell>Status</TableCell>
                <TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {campaigns.map((c) => (
                <TableRow key={c.campaignId} hover>
                  <TableCell>
                    <Typography variant="body2" fontWeight={500}>
                      {c.name}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {c.subjectLine}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <Stack direction="row" spacing={0.5} flexWrap="wrap">
                      {c.segmentQuery.stage && (
                        <Chip
                          label={c.segmentQuery.stage}
                          size="small"
                          variant="outlined"
                        />
                      )}
                      {c.segmentQuery.goal && (
                        <Chip
                          label={`goal: ${c.segmentQuery.goal}`}
                          size="small"
                          variant="outlined"
                        />
                      )}
                    </Stack>
                  </TableCell>
                  <TableCell>
                    every {c.cadenceValue} {c.cadenceUnit}
                  </TableCell>
                  <TableCell>{c.maxSends}</TableCell>
                  <TableCell>
                    {c.killSwitch ? (
                      <Chip label="PAUSED" size="small" color="error" />
                    ) : c.isActive ? (
                      <Chip label="Active" size="small" color="success" />
                    ) : (
                      <Chip label="Inactive" size="small" />
                    )}
                  </TableCell>
                  <TableCell align="right">
                    <Tooltip title="Preview rendered email">
                      <IconButton onClick={() => handlePreview(c)} size="small">
                        <PreviewIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                    <Tooltip
                      title={c.killSwitch ? "Release kill switch" : "Engage kill switch"}
                    >
                      <IconButton
                        onClick={() => handleKillSwitchToggle(c)}
                        size="small"
                        color={c.killSwitch ? "success" : "warning"}
                      >
                        {c.killSwitch ? (
                          <PlayIcon fontSize="small" />
                        ) : (
                          <PauseIcon fontSize="small" />
                        )}
                      </IconButton>
                    </Tooltip>
                    <Tooltip title="Edit">
                      <IconButton onClick={() => openEdit(c)} size="small">
                        <EditIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                    <Tooltip title="Delete">
                      <IconButton
                        onClick={() => handleDelete(c)}
                        size="small"
                        color="error"
                      >
                        <DeleteIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {/* Create / edit dialog */}
      <Dialog open={dialogOpen} onClose={closeDialog} maxWidth="md" fullWidth>
        <DialogTitle>{editingId ? "Edit Campaign" : "New Campaign"}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <TextField
              label="Campaign name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              fullWidth
              required
            />
            <TextField
              label="Email subject line"
              value={form.subjectLine}
              onChange={(e) => setForm({ ...form, subjectLine: e.target.value })}
              fullWidth
              required
            />
            <TextField
              label="Template HTML"
              value={form.templateHtml}
              onChange={(e) =>
                setForm({ ...form, templateHtml: e.target.value })
              }
              fullWidth
              multiline
              minRows={6}
              required
              helperText="Merge fields: {{firstName}}, {{companyName}}, {{lastStep}}, {{goal}}"
            />
            <Box sx={{ display: "flex", gap: 2 }}>
              <FormControl sx={{ minWidth: 180 }}>
                <InputLabel>Segment stage</InputLabel>
                <Select
                  label="Segment stage"
                  value={form.segmentStage}
                  onChange={(e) =>
                    setForm({ ...form, segmentStage: String(e.target.value) })
                  }
                >
                  <MenuItem value="">(any)</MenuItem>
                  {ONBOARDING_STAGES.map((s) => (
                    <MenuItem key={s} value={s}>
                      {s}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
              <TextField
                label="Goal filter (optional)"
                value={form.segmentGoal}
                onChange={(e) =>
                  setForm({ ...form, segmentGoal: e.target.value })
                }
                sx={{ flex: 1 }}
              />
            </Box>
            <TextField
              label="Only target users inactive since (ISO datetime, optional)"
              value={form.segmentLastActivityBefore}
              onChange={(e) =>
                setForm({
                  ...form,
                  segmentLastActivityBefore: e.target.value,
                })
              }
              placeholder="2026-04-01T00:00:00Z"
              fullWidth
            />
            <Box sx={{ display: "flex", gap: 2 }}>
              <TextField
                label="Cadence value"
                type="number"
                value={form.cadenceValue}
                onChange={(e) =>
                  setForm({ ...form, cadenceValue: Number(e.target.value) })
                }
                sx={{ width: 130 }}
              />
              <FormControl sx={{ minWidth: 130 }}>
                <InputLabel>Unit</InputLabel>
                <Select
                  label="Unit"
                  value={form.cadenceUnit}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      cadenceUnit: e.target.value as CadenceUnit,
                    })
                  }
                >
                  {CADENCE_UNITS.map((u) => (
                    <MenuItem key={u} value={u}>
                      {u}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
              <TextField
                label="Max sends per user"
                type="number"
                value={form.maxSends}
                onChange={(e) =>
                  setForm({ ...form, maxSends: Number(e.target.value) })
                }
                sx={{ width: 170 }}
              />
            </Box>
            <Box sx={{ display: "flex", gap: 2 }}>
              <FormControlLabel
                control={
                  <Switch
                    checked={form.isActive}
                    onChange={(e) =>
                      setForm({ ...form, isActive: e.target.checked })
                    }
                  />
                }
                label="Active"
              />
              <FormControlLabel
                control={
                  <Switch
                    checked={form.killSwitch}
                    onChange={(e) =>
                      setForm({ ...form, killSwitch: e.target.checked })
                    }
                    color="warning"
                  />
                }
                label="Kill switch (halt sends)"
              />
            </Box>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={closeDialog}>Cancel</Button>
          <Button
            variant="contained"
            onClick={handleSave}
            disabled={saving || !form.name || !form.templateHtml}
          >
            {saving ? "Saving..." : editingId ? "Save" : "Create"}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Preview dialog */}
      <Dialog
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        maxWidth="md"
        fullWidth
      >
        <DialogTitle>Email preview (sample user)</DialogTitle>
        <DialogContent>
          <Paper variant="outlined" sx={{ p: 2 }}>
            <div dangerouslySetInnerHTML={{ __html: previewHtml }} />
          </Paper>
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ mt: 2, display: "block" }}
          >
            Rendered with: firstName=Alex, companyName=Acme Co, lastStep=brand_submitted, goal=paid_ads
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPreviewOpen(false)}>Close</Button>
        </DialogActions>
      </Dialog>
    </Container>
  );
}
