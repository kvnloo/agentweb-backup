import {
  Container,
  Paper,
  Typography,
  Box,
  Grid,
  Card,
  CardContent,
  Divider,
  Chip
} from '@mui/material';
import { useAuth } from '../contexts/AuthContext';

export default function Profile() {
  const { user } = useAuth();

  if (!user) {
    return null;
  }

  return (
    <Container maxWidth="md" sx={{ py: 4 }}>
      <Paper sx={{ p: 4 }}>
        <Typography variant="h4" gutterBottom>
          Profile
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
                  <Typography variant="body1">{user.email}</Typography>
                </Box>

                <Box sx={{ mb: 2 }}>
                  <Typography variant="subtitle2" color="text.secondary">
                    User ID
                  </Typography>
                  <Typography variant="body1">{user.userId}</Typography>
                </Box>

                <Box sx={{ mb: 2 }}>
                  <Typography variant="subtitle2" color="text.secondary">
                    Account Type
                  </Typography>
                  <Box sx={{ mt: 1 }}>
                    {user.isAdmin && (
                      <Chip
                        label="Admin"
                        color="primary"
                        sx={{ mr: 1 }}
                      />
                    )}
                    {user.isOAuthUser ? (
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
                    {new Date(user.createdAt).toLocaleDateString()}
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
