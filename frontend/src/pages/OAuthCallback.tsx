import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { Box, CircularProgress, Typography, Alert } from '@mui/material';

export default function OAuthCallback() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { setToken } = useAuth();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const handleOAuthCallback = async () => {
      const token = searchParams.get('token');
      if (!token) {
        setError('No authentication token received');
        setTimeout(() => navigate('/login'), 3000);
        return;
      }

      try {
        await setToken(token);
        navigate('/tasks');
      } catch (error) {
        console.error('Error in OAuth callback:', error);
        setError('Failed to complete authentication');
        setTimeout(() => navigate('/login'), 3000);
      }
    };

    handleOAuthCallback();
  }, [searchParams, navigate, setToken]);

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        gap: 2
      }}
    >
      {error ? (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      ) : (
        <>
          <CircularProgress />
          <Typography>Completing sign in...</Typography>
        </>
      )}
    </Box>
  );
} 