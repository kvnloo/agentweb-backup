import { useState, useEffect } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  IconButton,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { Delete as DeleteIcon, PersonAdd as PersonAddIcon, Refresh as RefreshIcon } from '@mui/icons-material';
import axios from 'axios';
import { buildApiUrl } from '../../config';
import { useAuth } from '../../contexts/AuthContext';

interface UnipileAccount {
  account_id: string;
  account_name: string;
  user_email: string | null;
  user_id: string | null;
  created_at: string | null;
  updated_at: string | null;
  unipile_status: string;
  is_orphan: boolean;
}

export default function ConnectedAccountsTab() {
  const { token } = useAuth();
  const [loading, setLoading] = useState(true);
  const [accounts, setAccounts] = useState<UnipileAccount[]>([]);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<UnipileAccount | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [assignTarget, setAssignTarget] = useState<UnipileAccount | null>(null);
  const [assignEmail, setAssignEmail] = useState('');
  const [assigning, setAssigning] = useState(false);

  const headers = { Authorization: `Bearer ${token}` };

  const load = async () => {
    try {
      setLoading(true);
      setError('');
      const { data } = await axios.get(buildApiUrl('/api/admin/unipile-accounts'), { headers });
      setAccounts(data.accounts || []);
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to load connected accounts');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (success) {
      const t = setTimeout(() => setSuccess(''), 4000);
      return () => clearTimeout(t);
    }
  }, [success]);

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const params = deleteTarget.user_id ? `?userId=${encodeURIComponent(deleteTarget.user_id)}` : '';
      await axios.delete(
        buildApiUrl(`/api/admin/unipile-accounts/${deleteTarget.account_id}${params}`),
        { headers },
      );
      const label = deleteTarget.user_email
        ? `${deleteTarget.account_name} (${deleteTarget.user_email})`
        : `orphan ${deleteTarget.account_name}`;
      setSuccess(`Deleted ${label}`);
      setAccounts((prev) => prev.filter((a) => a.account_id !== deleteTarget.account_id));
      setDeleteTarget(null);
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to delete account');
    } finally {
      setDeleting(false);
    }
  };

  const handleAssign = async () => {
    if (!assignTarget || !assignEmail.trim()) return;
    setAssigning(true);
    try {
      const { data } = await axios.post(
        buildApiUrl(`/api/admin/unipile-accounts/${assignTarget.account_id}/assign`),
        { email: assignEmail.trim() },
        { headers },
      );
      setSuccess(`Assigned ${data.account_name} to ${data.user_email}`);
      setAccounts((prev) =>
        prev.map((a) =>
          a.account_id === assignTarget.account_id
            ? { ...a, user_email: data.user_email, is_orphan: false, unipile_status: 'UNKNOWN' }
            : a,
        ),
      );
      setAssignTarget(null);
      setAssignEmail('');
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to assign account');
    } finally {
      setAssigning(false);
    }
  };

  const statusColor = (status: string): 'success' | 'error' | 'warning' | 'default' => {
    if (status === 'OK') return 'success';
    if (status === 'ORPHAN') return 'error';
    if (status === 'UNKNOWN') return 'warning';
    return 'error';
  };

  const okCount = accounts.filter((a) => a.unipile_status === 'OK').length;
  const orphanCount = accounts.filter((a) => a.is_orphan).length;
  const errCount = accounts.filter((a) => !a.is_orphan && a.unipile_status !== 'OK' && a.unipile_status !== 'UNKNOWN').length;

  return (
    <Box>
      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
      {success && <Alert severity="success" sx={{ mb: 2 }}>{success}</Alert>}

      <Box display="flex" alignItems="center" justifyContent="space-between" mb={2}>
        <Box>
          <Typography variant="h6">Connected Accounts — Unipile (LinkedIn Outreach)</Typography>
          <Typography variant="body2" color="text.secondary">
            Shows all LinkedIn accounts in Unipile matched against our DB.
            <strong> ORPHAN</strong> = exists in Unipile but not in AgentWeb DB (user was deleted or disconnect failed).
            Use <strong>Assign</strong> to link an orphan to a user, or force-delete to clean up stale records.
          </Typography>
        </Box>
        <Tooltip title="Refresh">
          <IconButton onClick={load} disabled={loading}>
            <RefreshIcon />
          </IconButton>
        </Tooltip>
      </Box>

      <Box display="flex" gap={2} mb={2}>
        <Chip label={`${accounts.length} total`} size="small" />
        <Chip label={`${okCount} connected`} color="success" size="small" />
        {orphanCount > 0 && <Chip label={`${orphanCount} orphan (Unipile-only)`} color="error" size="small" />}
        {errCount > 0 && <Chip label={`${errCount} error/stale`} color="warning" size="small" />}
      </Box>

      {loading ? (
        <Box display="flex" justifyContent="center" p={4}>
          <CircularProgress />
        </Box>
      ) : accounts.length === 0 ? (
        <Typography color="text.secondary">No Unipile accounts found.</Typography>
      ) : (
        <TableContainer component={Paper} variant="outlined">
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>User Email</TableCell>
                <TableCell>Account Name</TableCell>
                <TableCell>Account ID</TableCell>
                <TableCell>Status</TableCell>
                <TableCell>Connected At</TableCell>
                <TableCell>Last Updated</TableCell>
                <TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {accounts.map((acc) => (
                <TableRow
                  key={acc.account_id}
                  hover
                  sx={acc.is_orphan ? { bgcolor: 'error.50' } : undefined}
                >
                  <TableCell>{acc.user_email ?? <em style={{ opacity: 0.5 }}>no user (orphan)</em>}</TableCell>
                  <TableCell>{acc.account_name}</TableCell>
                  <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>{acc.account_id}</TableCell>
                  <TableCell>
                    <Chip
                      label={acc.unipile_status}
                      color={statusColor(acc.unipile_status)}
                      size="small"
                    />
                  </TableCell>
                  <TableCell>{acc.created_at ? new Date(acc.created_at).toLocaleString() : '—'}</TableCell>
                  <TableCell>{acc.updated_at ? new Date(acc.updated_at).toLocaleString() : '—'}</TableCell>
                  <TableCell align="right">
                    {acc.is_orphan && (
                      <Tooltip title="Assign to a user">
                        <IconButton
                          size="small"
                          color="primary"
                          onClick={() => { setAssignTarget(acc); setAssignEmail(''); }}
                          sx={{ mr: 0.5 }}
                        >
                          <PersonAddIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    )}
                    <Tooltip title={acc.is_orphan ? 'Delete orphan from Unipile' : 'Force delete (Unipile API + DB)'}>
                      <IconButton
                        size="small"
                        color="error"
                        onClick={() => setDeleteTarget(acc)}
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

      {/* Assign orphan dialog */}
      <Dialog
        open={Boolean(assignTarget)}
        onClose={() => !assigning && setAssignTarget(null)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>Assign Orphan Account to User</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ mb: 2 }}>
            Assign <strong>{assignTarget?.account_name}</strong> ({assignTarget?.account_id}) to an AgentWeb user.
            The account will appear in their Connected Accounts list immediately.
          </DialogContentText>
          <TextField
            autoFocus
            label="User email"
            type="email"
            fullWidth
            value={assignEmail}
            onChange={(e) => setAssignEmail(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleAssign()}
            disabled={assigning}
            placeholder="user@example.com"
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setAssignTarget(null)} disabled={assigning}>Cancel</Button>
          <Button
            onClick={handleAssign}
            color="primary"
            variant="contained"
            disabled={assigning || !assignEmail.trim()}
          >
            {assigning ? 'Assigning…' : 'Assign'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Delete dialog */}
      <Dialog open={Boolean(deleteTarget)} onClose={() => !deleting && setDeleteTarget(null)}>
        <DialogTitle>
          {deleteTarget?.is_orphan ? 'Delete Orphan Unipile Account?' : 'Force Delete Unipile Account?'}
        </DialogTitle>
        <DialogContent>
          <DialogContentText>
            {deleteTarget?.is_orphan ? (
              <>
                Account <strong>{deleteTarget.account_name}</strong> ({deleteTarget.account_id}) exists in Unipile
                but has <strong>no matching AgentWeb user</strong> — it was likely left behind when the user was deleted
                or when a previous disconnect failed. This will remove it from Unipile only.
              </>
            ) : (
              <>
                This will remove <strong>{deleteTarget?.account_name}</strong> (user:{' '}
                <strong>{deleteTarget?.user_email}</strong>) from both the Unipile API and our database.
                The user will need to reconnect their LinkedIn account.
              </>
            )}
            {' '}This cannot be undone.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteTarget(null)} disabled={deleting}>Cancel</Button>
          <Button onClick={handleDelete} color="error" variant="contained" disabled={deleting}>
            {deleting ? 'Deleting…' : 'Force Delete'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
