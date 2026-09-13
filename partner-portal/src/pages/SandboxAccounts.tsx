import { useState, useEffect, useCallback } from "react";
import {
  Container,
  Typography,
  Box,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Paper,
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
  Button,
  TextField,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  InputAdornment,
} from "@mui/material";
import {
  Add as AddIcon,
  OpenInNew as OpenInNewIcon,
  RestartAlt as ResetIcon,
  DeleteSweep as CleanIcon,
  ContentCopy as CopyIcon,
  Check as CheckIcon,
} from "@mui/icons-material";
import axios from "axios";
import { useAuth } from "../contexts/AuthContext";
import { buildApiUrl } from "../config";

interface SandboxAccount {
  userId: string;
  email: string;
  status: "active" | "revoked";
  label: string;
  datasetId?: string;
  datasetVersion?: number;
  expiresAt: number;
  lifecycleState?: "resetting" | "purging" | "purged";
}

interface DatasetSummary {
  datasetId: string;
  version: number;
  account: { name: string };
  createdAt: string;
}

interface CreateForm {
  displayName: string;
  email: string;
  label: string;
  datasetKey: string;
  expiryDays: string;
  brandName: string;
  brandDescription: string;
}

const emptyForm = (): CreateForm => ({
  displayName: "",
  email: "",
  label: "",
  datasetKey: "",
  expiryDays: "14",
  brandName: "",
  brandDescription: "",
});

/** Browser-safe random password — provisioning never sees or stores this generator, only the result. */
function generatePassword(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/[/+=]/g, "").slice(0, 20);
}

function statusChip(account: SandboxAccount) {
  if (account.lifecycleState) {
    const label = account.lifecycleState === "purged" ? "Purged" : account.lifecycleState === "purging" ? "Cleaning…" : "Resetting…";
    return <Chip size="small" label={label} color={account.lifecycleState === "purged" ? "default" : "warning"} />;
  }
  if (account.status === "revoked") return <Chip size="small" label="Revoked" color="default" />;
  if (account.expiresAt <= Date.now()) return <Chip size="small" label="Expired" color="default" variant="outlined" />;
  return <Chip size="small" label="Active" color="success" variant="outlined" />;
}

export default function SandboxAccounts() {
  const { token } = useAuth();
  const headers = { Authorization: `Bearer ${token}` };

  const [accounts, setAccounts] = useState<SandboxAccount[]>([]);
  const [datasets, setDatasets] = useState<DatasetSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null); // `${userId}:${action}`

  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState<CreateForm>(emptyForm());
  const [creating, setCreating] = useState(false);
  const [createdPassword, setCreatedPassword] = useState<{ email: string; password: string } | null>(null);
  const [passwordCopied, setPasswordCopied] = useState(false);

  const [confirmClean, setConfirmClean] = useState<SandboxAccount | null>(null);
  const [confirmReset, setConfirmReset] = useState<SandboxAccount | null>(null);

  const [delegatedPortalUrl, setDelegatedPortalUrl] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const [accountsRes, datasetsRes] = await Promise.all([
        axios.get(buildApiUrl("/api/admin/evaluations"), { headers }),
        axios.get(buildApiUrl("/api/admin/evaluations/datasets"), { headers }),
      ]);
      setAccounts(accountsRes.data.accounts ?? []);
      setDatasets(datasetsRes.data.datasets ?? []);
    } catch {
      setError("Failed to load sandbox accounts.");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const openCreate = () => {
    setForm(emptyForm());
    setCreateOpen(true);
  };

  const handleCreate = async () => {
    const [datasetId, versionStr] = form.datasetKey.split("@");
    setCreating(true);
    setError(null);
    try {
      const password = generatePassword();
      await axios.post(
        buildApiUrl("/api/admin/evaluations"),
        {
          email: form.email,
          displayName: form.displayName,
          password,
          expiresAt: Date.now() + Number(form.expiryDays) * 86400000,
          label: form.label || undefined,
          datasetId,
          datasetVersion: Number(versionStr),
          brandGuidelines: { brandName: form.brandName, description: form.brandDescription || undefined },
        },
        { headers },
      );
      setCreateOpen(false);
      setCreatedPassword({ email: form.email, password });
      setPasswordCopied(false);
      await load();
    } catch (err: any) {
      setError(err.response?.data?.error || "Failed to create sandbox account.");
    } finally {
      setCreating(false);
    }
  };

  const handleCopyPassword = async () => {
    if (!createdPassword) return;
    try {
      await navigator.clipboard.writeText(createdPassword.password);
      setPasswordCopied(true);
    } catch {
      setPasswordCopied(false);
    }
  };

  // Mirrors AdminDashboard's existing customer-portal delegation flow — the route already
  // recognizes an eval_ target and mints the evaluation-scoped delegate token; nothing new here.
  const handleDelegateAccess = async (userId: string) => {
    const placeholderTab = window.open("", "_blank");
    setActionLoading(`${userId}:delegate`);
    try {
      const res = await axios.post(buildApiUrl(`/api/admin/users/${userId}/delegate-access`), {}, { headers });
      const url = res.data?.customerPortalUrl;
      if (url && placeholderTab && !placeholderTab.closed) {
        placeholderTab.location.href = url;
      } else if (url) {
        setDelegatedPortalUrl(url);
      } else {
        placeholderTab?.close();
        setError("Delegate access did not return a portal URL.");
      }
    } catch (err: any) {
      placeholderTab?.close();
      setError(err.response?.data?.message || "Failed to open this account.");
    } finally {
      setActionLoading(null);
    }
  };

  const handleReset = async () => {
    if (!confirmReset) return;
    const userId = confirmReset.userId;
    setActionLoading(`${userId}:reset`);
    try {
      await axios.post(buildApiUrl(`/api/admin/evaluations/${userId}/reset`), {}, { headers });
      setSuccess("Account restored to its original seed.");
      await load();
    } catch (err: any) {
      setError(err.response?.data?.error || "Failed to reset this account.");
    } finally {
      setActionLoading(null);
      setConfirmReset(null);
    }
  };

  // One click from the admin's side: revoke ends every live session/token immediately,
  // then purge removes everything the account produced. Policy + audit are never touched.
  const handleClean = async () => {
    if (!confirmClean) return;
    const userId = confirmClean.userId;
    setActionLoading(`${userId}:clean`);
    try {
      await axios.post(buildApiUrl(`/api/admin/evaluations/${userId}/revoke`), {}, { headers });
      await axios.post(buildApiUrl(`/api/admin/evaluations/${userId}/purge`), {}, { headers });
      setSuccess("Account revoked and cleaned — only the policy and audit trail remain.");
      await load();
    } catch (err: any) {
      setError(err.response?.data?.error || "Failed to clean this account.");
    } finally {
      setActionLoading(null);
      setConfirmClean(null);
    }
  };

  const createDisabled = creating || !form.displayName || !form.email || !form.datasetKey || !form.brandName || Number(form.expiryDays) < 1 || Number(form.expiryDays) > 30;

  return (
    <Container maxWidth="lg" sx={{ py: 4 }}>
      <Box sx={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", mb: 3 }}>
        <Box>
          <Typography variant="h4" gutterBottom>Sandbox Accounts</Typography>
          <Typography variant="body2" color="text.secondary">
            Real portal accounts with a fully simulated Meta connection — for candidate take-homes, demos, or anything else that needs hands-on access without touching a real customer or Meta.
          </Typography>
        </Box>
        <Button variant="contained" startIcon={<AddIcon />} onClick={openCreate}>
          Create sandbox account
        </Button>
      </Box>

      {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>{error}</Alert>}
      {success && <Alert severity="success" sx={{ mb: 2 }} onClose={() => setSuccess(null)}>{success}</Alert>}

      <TableContainer component={Paper} variant="outlined">
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Email</TableCell>
              <TableCell>Label</TableCell>
              <TableCell>Dataset</TableCell>
              <TableCell>Status</TableCell>
              <TableCell>Expires</TableCell>
              <TableCell align="right">Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {loading ? (
              <TableRow><TableCell colSpan={6} align="center" sx={{ py: 4 }}><CircularProgress size={24} /></TableCell></TableRow>
            ) : accounts.length === 0 ? (
              <TableRow><TableCell colSpan={6} align="center" sx={{ py: 4 }}>
                <Typography color="text.secondary">No sandbox accounts yet. Create one to get started.</Typography>
              </TableCell></TableRow>
            ) : accounts.map((account) => {
              const cleaned = account.lifecycleState === "purged";
              return (
                <TableRow key={account.userId} hover>
                  <TableCell>{account.email}</TableCell>
                  <TableCell>{account.label}</TableCell>
                  <TableCell>{account.datasetId ? `${account.datasetId}@${account.datasetVersion}` : "—"}</TableCell>
                  <TableCell>{statusChip(account)}</TableCell>
                  <TableCell>{new Date(account.expiresAt).toLocaleDateString()}</TableCell>
                  <TableCell align="right">
                    <Tooltip title="Open as this account">
                      <span>
                        <IconButton size="small" color="primary" aria-label="Open as this account" disabled={cleaned || actionLoading === `${account.userId}:delegate`} onClick={() => handleDelegateAccess(account.userId)}>
                          {actionLoading === `${account.userId}:delegate` ? <CircularProgress size={16} /> : <OpenInNewIcon fontSize="small" />}
                        </IconButton>
                      </span>
                    </Tooltip>
                    <Tooltip title="Reset to original seed">
                      <span>
                        <IconButton size="small" aria-label="Reset to original seed" disabled={cleaned || actionLoading === `${account.userId}:reset`} onClick={() => setConfirmReset(account)}>
                          {actionLoading === `${account.userId}:reset` ? <CircularProgress size={16} /> : <ResetIcon fontSize="small" />}
                        </IconButton>
                      </span>
                    </Tooltip>
                    <Tooltip title="Clean (revoke + purge)">
                      <span>
                        <IconButton size="small" color="error" aria-label="Clean (revoke + purge)" disabled={cleaned || actionLoading === `${account.userId}:clean`} onClick={() => setConfirmClean(account)}>
                          {actionLoading === `${account.userId}:clean` ? <CircularProgress size={16} /> : <CleanIcon fontSize="small" />}
                        </IconButton>
                      </span>
                    </Tooltip>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>

      {/* Create dialog */}
      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Create sandbox account</DialogTitle>
        <DialogContent sx={{ display: "flex", flexDirection: "column", gap: 2, pt: 1 }}>
          <TextField label="Display name" value={form.displayName} onChange={e => setForm({ ...form, displayName: e.target.value })} fullWidth autoFocus />
          <TextField label="Email" type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} fullWidth />
          <FormControl fullWidth>
            <InputLabel id="dataset-select-label">Dataset</InputLabel>
            <Select labelId="dataset-select-label" label="Dataset" value={form.datasetKey} onChange={e => setForm({ ...form, datasetKey: e.target.value })}>
              {datasets.map(d => (
                <MenuItem key={`${d.datasetId}@${d.version}`} value={`${d.datasetId}@${d.version}`}>
                  {d.datasetId}@{d.version} — {d.account.name}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <TextField
            label="Expires in"
            type="number"
            value={form.expiryDays}
            onChange={e => setForm({ ...form, expiryDays: e.target.value })}
            InputProps={{ endAdornment: <InputAdornment position="end">days</InputAdornment> }}
            helperText="Up to 30 days"
          />
          <TextField label="Label" placeholder="e.g. Ryan Christmas take-home, or Acme demo" value={form.label} onChange={e => setForm({ ...form, label: e.target.value })} fullWidth />
          <TextField label="Brand name" value={form.brandName} onChange={e => setForm({ ...form, brandName: e.target.value })} fullWidth />
          <TextField label="Brand description (optional)" value={form.brandDescription} onChange={e => setForm({ ...form, brandDescription: e.target.value })} fullWidth multiline minRows={2} />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCreateOpen(false)}>Cancel</Button>
          <Button variant="contained" disabled={createDisabled} onClick={handleCreate}>
            {creating ? <CircularProgress size={18} /> : "Create"}
          </Button>
        </DialogActions>
      </Dialog>

      {/* One-time password reveal */}
      <Dialog open={Boolean(createdPassword)} onClose={() => setCreatedPassword(null)} maxWidth="sm" fullWidth>
        <DialogTitle>Sandbox account created</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ mb: 2 }}>
            {createdPassword?.email} can log in with the password below — it won't be shown again.
          </DialogContentText>
          <TextField
            fullWidth
            value={createdPassword?.password ?? ""}
            InputProps={{
              readOnly: true,
              endAdornment: (
                <InputAdornment position="end">
                  <Tooltip title={passwordCopied ? "Copied!" : "Copy password"}>
                    <IconButton onClick={handleCopyPassword} edge="end">
                      {passwordCopied ? <CheckIcon fontSize="small" color="success" /> : <CopyIcon fontSize="small" />}
                    </IconButton>
                  </Tooltip>
                </InputAdornment>
              ),
            }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCreatedPassword(null)}>Done</Button>
        </DialogActions>
      </Dialog>

      {/* Popup-blocked recovery, mirroring AdminDashboard's own delegate-link dialog */}
      <Dialog open={Boolean(delegatedPortalUrl)} onClose={() => setDelegatedPortalUrl(null)} maxWidth="sm" fullWidth>
        <DialogTitle>Open sandbox account</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ mb: 2 }}>Your browser blocked the popup. Use this link instead:</DialogContentText>
          <TextField fullWidth value={delegatedPortalUrl ?? ""} InputProps={{ readOnly: true }} />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDelegatedPortalUrl(null)}>Close</Button>
          {delegatedPortalUrl && <Button variant="contained" href={delegatedPortalUrl} target="_blank" rel="noopener">Open</Button>}
        </DialogActions>
      </Dialog>

      {/* Reset confirmation */}
      <Dialog open={Boolean(confirmReset)} onClose={() => setConfirmReset(null)}>
        <DialogTitle>Reset this account?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {confirmReset?.email} will be restored to its exact original seed. Anything created inside it is discarded.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmReset(null)}>Cancel</Button>
          <Button variant="contained" color="warning" onClick={handleReset}>Reset</Button>
        </DialogActions>
      </Dialog>

      {/* Clean confirmation */}
      <Dialog open={Boolean(confirmClean)} onClose={() => setConfirmClean(null)}>
        <DialogTitle>Clean this account?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {confirmClean?.email}'s sessions and tokens are revoked immediately, and everything it produced is removed. The policy record and audit trail are kept. This ends the account's active life — create a new one for the next candidate or demo.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmClean(null)}>Cancel</Button>
          <Button variant="contained" color="error" onClick={handleClean}>Clean</Button>
        </DialogActions>
      </Dialog>
    </Container>
  );
}
