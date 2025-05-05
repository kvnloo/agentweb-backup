import {
  Container,
  Paper,
  Typography,
  Box,
  Grid,
  Card,
  CardContent,
  Divider,
  Chip,
  CircularProgress,
  Alert
} from '@mui/material';
import { useAuth, UserRole } from '../contexts/AuthContext';
import { useParams } from 'react-router-dom';
import { useState, useEffect } from 'react';
import axios, { AxiosError } from 'axios';
import { buildApiUrl } from '../config';

// Define the User interface
interface User {
  userId: string;
  email: string;
  isAdmin: boolean;
  isOAuthUser: boolean;
  createdAt: string;
  role?: UserRole;
  [key: string]: any; // Allow for additional properties
}

// Define the error response interface
interface ErrorResponse {
  message?: string;
  [key: string]: any;
}

export default function Profile() {
  const { user, token } = useAuth();
  const { userId } = useParams<{ userId: string }>();
  const [profileUser, setProfileUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    // If no userId is provided in the URL, show the current user's profile
    if (!userId) {
      if (user) {
        setProfileUser(user as User);
      }
      return;
    }

    // If the userId matches the current user, use the current user's data
    if (user && userId === user.userId) {
      setProfileUser(user as User);
      return;
    }

    // Only admins can view other users' profiles
    if (!user?.isAdmin) {
      setError('You do not have permission to view this profile');
      return;
    }

    // Otherwise, fetch the user profile for the specified userId
    const fetchUserProfile = async () => {
      setLoading(true);
      try {
        const response = await axios.get(buildApiUrl(`/api/admin/users/${userId}`), {
          headers: { Authorization: `Bearer ${token}` }
        });
        setProfileUser(response.data);
      } catch (err) {
        console.error('Error fetching user profile:', err);
        const error = err as AxiosError<ErrorResponse>;
        const errorMessage = error.response?.data?.message || 'Failed to fetch user profile';
        setError(errorMessage);
      } finally {
        setLoading(false);
      }
    };

    fetchUserProfile();
  }, [userId, user, token]);

  if (loading) {
    return (
      <Box display="flex" justifyContent="center" alignItems="center" minHeight="60vh">
        <CircularProgress />
      </Box>
    );
  }

  if (error) {
    return (
      <Container maxWidth="md">
        <Alert severity="error" sx={{ mt: 4 }}>
          {error}
        </Alert>
      </Container>
    );
  }

  if (!profileUser) {
    return (
      <Container maxWidth="md">
        <Alert severity="info" sx={{ mt: 4 }}>
          User not found
        </Alert>
      </Container>
    );
  }

  return (
    <Container maxWidth="md" sx={{ py: 4 }}>
      <Paper sx={{ p: 4 }}>
        <Typography variant="h4" gutterBottom>
          {userId && userId !== user?.userId ? 'User Profile' : 'My Profile'}
        </Typography>
        <Divider sx={{ mb: 4 }} />
        
        <Grid container spacing={4}>
          <Grid item xs={12}>
            <Card>
              <CardContent>
                <Box sx={{ mb: 2 }}>
                  <Typography variant="subtitle2" color="text.secondary">
                    Email
                  </Typography>
                  <Typography variant="body1">{profileUser.email}</Typography>
                </Box>

                <Box sx={{ mb: 2 }}>
                  <Typography variant="subtitle2" color="text.secondary">
                    User ID
                  </Typography>
                  <Typography variant="body1">{profileUser.userId}</Typography>
                </Box>

                <Box sx={{ mb: 2 }}>
                  <Typography variant="subtitle2" color="text.secondary">
                    Account Type
                  </Typography>
                  <Box sx={{ mt: 1 }}>
                    {profileUser.isAdmin && (
                      <Chip
                        label="Admin"
                        color="primary"
                        sx={{ mr: 1 }}
                      />
                    )}
                    <Chip
                      label={profileUser.role || 'Partner'}
                      color="success"
                      sx={{ mr: 1, textTransform: 'capitalize' }}
                    />
                    {profileUser.isOAuthUser ? (
                      <Chip
                        label="Google Account"
                        color="secondary"
                      />
                    ) : (
                      <Chip
                        label="Email Account"
                        color="default"
                      />
                    )}
                  </Box>
                </Box>

                <Box>
                  <Typography variant="subtitle2" color="text.secondary">
                    Member Since
                  </Typography>
                  <Typography variant="body1">
                    {new Date(profileUser.createdAt).toLocaleDateString()}
                  </Typography>
                </Box>
              </CardContent>
            </Card>
          </Grid>
        </Grid>
      </Paper>
    </Container>
  );
} 
