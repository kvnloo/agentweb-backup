import { useState, useEffect } from 'react';
import {
  Box,
  Button,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
  Alert,
  CircularProgress,
  Chip,
  IconButton,
  Switch,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Tooltip,
} from '@mui/material';
import {
  Add as AddIcon,
  Delete as DeleteIcon,
} from '@mui/icons-material';
import axios from 'axios';
import { buildApiUrl } from '../../config';
import { useAuth } from '../../contexts/AuthContext';

interface UnipileAccount {
  account_id: string;
  account_name: string;
  user_email: string;
  user_id: string;
  created_at: string;
  updated_at: string;
}

interface SiteWideAccount {
  account_id: string;
  account_name: string;
  user_email: string | null;
  added_by: string;
  added_at: string;
  enabled: boolean;
}

export default function CrmTab() {
  const { token } = useAuth();
  const [siteWideAccounts, setSiteWideAccounts] = useState<SiteWideAccount[]>([]);
  const [allUnipileAccounts, setAllUnipileAccounts] = useState<UnipileAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [addingAccountId, setAddingAccountId] = useState<string | null>(null);

  const headers = { Authorization: `Bearer ${token}` };

  const fetchData = async () => {
    try {
      setLoading(true);
      const [siteWideRes, allAccountsRes] = await Promise.all([
        axios.get(buildApiUrl('/api/settings/site-wide-unipile-accounts'), { headers }),
        axios.get(buildApiUrl('/api/admin/unipile-accounts'), { headers }),
      ]);
      setSiteWideAccounts(siteWideRes.data.accounts || []);
      setAllUnipileAccounts(allAccountsRes.data.accounts || []);
    } catch (err) {
      console.error('Error fetching data:', err);
      setError('Failed to load data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (token) fetchData();
  }, [token]);

  const handleAddAccount = async (account: UnipileAccount) => {
    setAddingAccountId(account.account_id);
    setError('');
    try {
      const res = await axios.post(
        buildApiUrl('/api/settings/site-wide-unipile-accounts'),
        {
          account_id: account.account_id,
          account_name: account.account_name,
          user_email: account.user_email,
        },
        { headers },
      );
      setSiteWideAccounts((prev) => [...prev, res.data.account]);
      setSuccess(`Added ${account.account_name || account.account_id} as site-wide enrichment account`);
      setAddDialogOpen(false);
    } catch (err: any) {
      if (err.response?.status === 409) {
        setError('This account is already added');
      } else {
        setError('Failed to add account');
      }
    } finally {
      setAddingAccountId(null);
    }
  };

  const handleToggleEnabled = async (accountId: string, enabled: boolean) => {
    try {
      const res = await axios.patch(
        buildApiUrl(`/api/settings/site-wide-unipile-accounts/${accountId}`),
        { enabled },
        { headers },
      );
      setSiteWideAccounts((prev) =>
        prev.map((a) => (a.account_id === accountId ? res.data.account : a)),
      );
    } catch (err) {
      console.error('Error toggling account:', err);
      setError('Failed to update account');
    }
  };

  const handleRemoveAccount = async (accountId: string) => {
    if (!confirm('Remove this account from site-wide enrichment?')) return;
    try {
      await axios.delete(
        buildApiUrl(`/api/settings/site-wide-unipile-accounts/${accountId}`),
        { headers },
      );
      setSiteWideAccounts((prev) => prev.filter((a) => a.account_id !== accountId));
      setSuccess('Account removed from site-wide enrichment');
    } catch (err) {
      console.error('Error removing account:', err);
      setError('Failed to remove account');
    }
  };

  // Filter out accounts already added as site-wide
  const siteWideIds = new Set(siteWideAccounts.map((a) => a.account_id));
  const availableAccounts = allUnipileAccounts.filter((a) => !siteWideIds.has(a.account_id));

  if (loading) return <CircularProgress />;

  return (
    <Box>
      <Typography variant="h6" sx={{ mb: 1 }}>
        Site-Wide LinkedIn Enrichment Accounts
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        These Unipile accounts are used for LinkedIn enrichment when a client does not have their own connected account. Multiple accounts provide redundancy if one expires.
      </Typography>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}
      {success && (
        <Alert severity="success" sx={{ mb: 2 }} onClose={() => setSuccess('')}>
          {success}
        </Alert>
      )}

      <Box sx={{ display: 'flex', justifyContent: 'flex-end', mb: 2 }}>
        <Button
          variant="contained"
          startIcon={<AddIcon />}
          onClick={() => setAddDialogOpen(true)}
          disabled={availableAccounts.length === 0}
        >
          Add Account
        </Button>
      </Box>

      {siteWideAccounts.length === 0 ? (
        <Alert severity="info">
          No site-wide enrichment accounts configured. Add a Unipile account to enable LinkedIn enrichment for all clients.
        </Alert>
      ) : (
        <TableContainer component={Paper}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Account Name</TableCell>
                <TableCell>Account ID</TableCell>
                <TableCell>Owner</TableCell>
                <TableCell>Added By</TableCell>
                <TableCell>Added At</TableCell>
                <TableCell>Enabled</TableCell>
                <TableCell width={80}>Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {siteWideAccounts.map((account) => (
                <TableRow key={account.account_id}>
                  <TableCell sx={{ fontWeight: 500 }}>
                    {account.account_name}
                  </TableCell>
                  <TableCell>
                    <Tooltip title={account.account_id}>
                      <Typography variant="body2" sx={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>
                        {account.account_id.length > 20
                          ? `${account.account_id.slice(0, 20)}...`
                          : account.account_id}
                      </Typography>
                    </Tooltip>
                  </TableCell>
                  <TableCell>{account.user_email || '—'}</TableCell>
                  <TableCell>{account.added_by}</TableCell>
                  <TableCell>
                    {account.added_at
                      ? new Date(account.added_at).toLocaleDateString()
                      : '—'}
                  </TableCell>
                  <TableCell>
                    <Switch
                      checked={account.enabled}
                      onChange={(e) => handleToggleEnabled(account.account_id, e.target.checked)}
                      size="small"
                    />
                    <Chip
                      label={account.enabled ? 'Active' : 'Disabled'}
                      size="small"
                      color={account.enabled ? 'success' : 'default'}
                      sx={{ ml: 1 }}
                    />
                  </TableCell>
                  <TableCell>
                    <IconButton
                      size="small"
                      color="error"
                      onClick={() => handleRemoveAccount(account.account_id)}
                    >
                      <DeleteIcon fontSize="small" />
                    </IconButton>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {/* Add Account Dialog - shows all Unipile accounts from users */}
      <Dialog open={addDialogOpen} onClose={() => setAddDialogOpen(false)} maxWidth="md" fullWidth>
        <DialogTitle>Add Site-Wide Enrichment Account</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Select a LinkedIn Outreach (Unipile) account from the list below. These are accounts connected by users across the platform.
          </Typography>

          {availableAccounts.length === 0 ? (
            <Alert severity="info">
              No available Unipile accounts to add. All connected accounts are already designated as site-wide, or no users have connected LinkedIn Outreach accounts.
            </Alert>
          ) : (
            <TableContainer component={Paper} variant="outlined">
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Account Name</TableCell>
                    <TableCell>Account ID</TableCell>
                    <TableCell>User</TableCell>
                    <TableCell>Connected At</TableCell>
                    <TableCell width={100}>Action</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {availableAccounts.map((account) => (
                    <TableRow key={account.account_id}>
                      <TableCell sx={{ fontWeight: 500 }}>
                        {account.account_name}
                      </TableCell>
                      <TableCell>
                        <Typography variant="body2" sx={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>
                          {account.account_id.length > 20
                            ? `${account.account_id.slice(0, 20)}...`
                            : account.account_id}
                        </Typography>
                      </TableCell>
                      <TableCell>{account.user_email}</TableCell>
                      <TableCell>
                        {account.created_at
                          ? new Date(account.created_at).toLocaleDateString()
                          : '—'}
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="outlined"
                          size="small"
                          onClick={() => handleAddAccount(account)}
                          disabled={addingAccountId === account.account_id}
                        >
                          {addingAccountId === account.account_id ? (
                            <CircularProgress size={16} />
                          ) : (
                            'Add'
                          )}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setAddDialogOpen(false)}>Close</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
