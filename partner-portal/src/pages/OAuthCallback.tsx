import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { Box, CircularProgress, Typography, Alert } from '@mui/material';

export default function OAuthCallback() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { setToken, loginError, clearLoginError } = useAuth();
  const [processingError, setProcessingError] = useState<string | null>(null);

  useEffect(() => {
    clearLoginError();
    const handleOAuthCallback = async () => {
      const token = searchParams.get('token');
      if (!token) {
        setProcessingError('No authentication token received. Redirecting to login...');
        setTimeout(() => navigate('/login'), 3000);
        return;
      }

      try {
        await setToken(token);
        navigate('/tasks');
      } catch (error: any) {
        console.error('Error in OAuth callback:', error.message);
        if (!loginError) {
          setProcessingError(error.message || 'Failed to complete authentication. Redirecting to login...');
        }
        setTimeout(() => navigate('/login'), 3000);
      }
    };

    handleOAuthCallback();
  }, [searchParams, navigate, setToken, clearLoginError]);

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
      {loginError ? (
        <Alert severity="error" sx={{ mb: 2 }}>
          {loginError}
        </Alert>
      ) : processingError ? (
        <Alert severity="error" sx={{ mb: 2 }}>
          {processingError}
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