import React, { useEffect, useState } from 'react';
import axios from 'axios';
import {
  Box,
  Typography,
  Card,
  CardContent,
  CardActions,
  Button,
  CircularProgress,
  Alert,
  Grid,
} from '@mui/material';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import { useAuth } from '../contexts/AuthContext';
import { buildApiUrl } from '../config';

interface AssignedUser {
  userId: string;
  email: string;
  displayName?: string;
}

export default function ContractorAccesses() {
  const { token } = useAuth();
  const [users, setUsers] = useState<AssignedUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [accessLoading, setAccessLoading] = useState<string | null>(null);

  useEffect(() => {
    const fetchAssignedUsers = async () => {
      try {
        const response = await axios.get(buildApiUrl('/api/contractor/assigned-users'), {
          headers: { Authorization: `Bearer ${token}` },
        });
        setUsers(response.data.users || []);
      } catch (err: any) {
        setError(err.response?.data?.message || 'Failed to load assigned accounts');
      } finally {
        setLoading(false);
      }
    };
    fetchAssignedUsers();
  }, [token]);

  const handleAccessPortal = async (userId: string) => {
    try {
      setAccessLoading(userId);
      const response = await axios.post(
        buildApiUrl(`/api/contractor/assigned-users/${userId}/delegate-access`),
        {},
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const { customerPortalUrl } = response.data;
      window.open(customerPortalUrl, '_blank');
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to create portal access');
    } finally {
      setAccessLoading(null);
    }
  };

  return (
    <Box sx={{ p: 4, maxWidth: 900, mx: 'auto' }}>
      <Typography variant="h4" gutterBottom>
        Contractor Accesses
      </Typography>
      <Typography variant="body1" color="text.secondary" sx={{ mb: 3 }}>
        Access the customer portal accounts assigned to you.
      </Typography>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', mt: 6 }}>
          <CircularProgress />
        </Box>
      ) : users.length === 0 ? (
        <Alert severity="info">No accounts have been assigned to you yet.</Alert>
      ) : (
        <Grid container spacing={2}>
          {users.map((user) => (
            <Grid item xs={12} sm={6} md={4} key={user.userId}>
              <Card variant="outlined">
                <CardContent>
                  <Typography variant="subtitle1" fontWeight={600} noWrap>
                    {user.displayName || user.email}
                  </Typography>
                  {user.displayName && (
                    <Typography variant="body2" color="text.secondary" noWrap>
                      {user.email}
                    </Typography>
                  )}
                </CardContent>
                <CardActions>
                  <Button
                    size="small"
                    variant="contained"
                    startIcon={
                      accessLoading === user.userId ? (
                        <CircularProgress size={14} color="inherit" />
                      ) : (
                        <OpenInNewIcon />
                      )
                    }
                    disabled={accessLoading === user.userId}
                    onClick={() => handleAccessPortal(user.userId)}
                  >
                    Access Portal
                  </Button>
                </CardActions>
              </Card>
            </Grid>
          ))}
        </Grid>
      )}
    </Box>
  );
}
