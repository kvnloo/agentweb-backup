import { useState, useEffect } from 'react';
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Chip,
  CircularProgress,
  IconButton,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import axios from 'axios';
import { useAuth } from '../../contexts/AuthContext';
import { buildApiUrl } from '../../config';

interface AssignedUser {
  userId: string;
  email: string;
  displayName?: string;
}

interface Contractor {
  userId: string;
  email: string;
  displayName?: string;
  assignedUsers: AssignedUser[];
}

interface AllUser {
  userId: string;
  email: string;
  displayName?: string;
  roles?: string[];
}

export default function ContractorsTab() {
  const { token } = useAuth();
  const [contractors, setContractors] = useState<Contractor[]>([]);
  const [allUsers, setAllUsers] = useState<AllUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [assignLoading, setAssignLoading] = useState<string | null>(null);
  const [removeLoading, setRemoveLoading] = useState<string | null>(null);
  // keyed by contractorId
  const [selectedUsers, setSelectedUsers] = useState<Record<string, AllUser | null>>({});

  const headers = { Authorization: `Bearer ${token}` };

  const fetchData = async () => {
    try {
      setLoading(true);
      const [contractorsRes, usersRes] = await Promise.all([
        axios.get(buildApiUrl('/api/contractor/contractors'), { headers }),
        axios.get(buildApiUrl('/api/admin/users'), { headers }),
      ]);
      setContractors(contractorsRes.data.contractors || []);
      setAllUsers(usersRes.data || []);
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to load data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const handleAssign = async (contractorId: string) => {
    const user = selectedUsers[contractorId];
    if (!user) return;
    try {
      setAssignLoading(contractorId);
      await axios.post(
        buildApiUrl(`/api/contractor/contractors/${contractorId}/assigned-users/${user.userId}`),
        {},
        { headers }
      );
      setSuccess(`Assigned ${user.email} successfully`);
      setSelectedUsers((prev) => ({ ...prev, [contractorId]: null }));
      await fetchData();
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to assign user');
    } finally {
      setAssignLoading(null);
    }
  };

  const handleRemove = async (contractorId: string, userId: string, userEmail: string) => {
    try {
      setRemoveLoading(`${contractorId}-${userId}`);
      await axios.delete(
        buildApiUrl(`/api/contractor/contractors/${contractorId}/assigned-users/${userId}`),
        { headers }
      );
      setSuccess(`Removed ${userEmail} successfully`);
      await fetchData();
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to remove user');
    } finally {
      setRemoveLoading(null);
    }
  };

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', mt: 4 }}>
        <CircularProgress />
      </Box>
    );
  }

  const customerUsers = allUsers.filter((u) => u.roles?.includes('customer'));

  return (
    <Box>
      <Typography variant="h6" gutterBottom>
        Contractors
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Users with the Contractor role are listed here. Assign customer accounts to each contractor so they can access those accounts via the Contractor Accesses page.
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

      {contractors.length === 0 ? (
        <Alert severity="info">
          No contractors yet. Grant a user the Contractor role in the Users tab to get started.
        </Alert>
      ) : (
        contractors.map((contractor) => {
          const assignedIds = contractor.assignedUsers.map((u) => u.userId);
          const available = customerUsers.filter((u) => !assignedIds.includes(u.userId));

          return (
            <Paper key={contractor.userId} variant="outlined" sx={{ mb: 3, p: 2 }}>
              <Typography variant="subtitle1" fontWeight={600} gutterBottom>
                {contractor.displayName || contractor.email}
              </Typography>
              {contractor.displayName && (
                <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                  {contractor.email}
                </Typography>
              )}

              <TableContainer sx={{ mb: 2 }}>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>Assigned Customer</TableCell>
                      <TableCell>Email</TableCell>
                      <TableCell align="right">Remove</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {contractor.assignedUsers.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={3} sx={{ color: 'text.disabled', fontStyle: 'italic' }}>
                          No users assigned
                        </TableCell>
                      </TableRow>
                    ) : (
                      contractor.assignedUsers.map((u) => (
                        <TableRow key={u.userId}>
                          <TableCell>{u.displayName || '—'}</TableCell>
                          <TableCell>{u.email}</TableCell>
                          <TableCell align="right">
                            <IconButton
                              size="small"
                              color="error"
                              disabled={removeLoading === `${contractor.userId}-${u.userId}`}
                              onClick={() => handleRemove(contractor.userId, u.userId, u.email)}
                            >
                              {removeLoading === `${contractor.userId}-${u.userId}` ? (
                                <CircularProgress size={16} />
                              ) : (
                                <DeleteIcon fontSize="small" />
                              )}
                            </IconButton>
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </TableContainer>

              <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                <Autocomplete
                  size="small"
                  sx={{ flex: 1, maxWidth: 360 }}
                  options={available}
                  getOptionLabel={(u) => u.email}
                  value={selectedUsers[contractor.userId] ?? null}
                  onChange={(_e, val) =>
                    setSelectedUsers((prev) => ({ ...prev, [contractor.userId]: val }))
                  }
                  renderInput={(params) => (
                    <TextField {...params} label="Add customer account" placeholder="Search by email" />
                  )}
                />
                <Button
                  variant="contained"
                  size="small"
                  disabled={!selectedUsers[contractor.userId] || assignLoading === contractor.userId}
                  onClick={() => handleAssign(contractor.userId)}
                >
                  {assignLoading === contractor.userId ? <CircularProgress size={18} color="inherit" /> : 'Assign'}
                </Button>
              </Box>
            </Paper>
          );
        })
      )}
    </Box>
  );
}
