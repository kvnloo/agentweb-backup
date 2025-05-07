import React from 'react';
import { Button } from '@mui/material';
import { useAuth } from '../contexts/AuthContext';

const LoginButton: React.FC = () => {
  const { loginWithGoogle } = useAuth();

  const handleLogin = async () => {
    try {
      await loginWithGoogle();
    } catch (error) {
      console.error('Login failed:', error);
    }
  };

  return (
    <Button variant="contained" onClick={handleLogin}>
      Login with Google
    </Button>
  );
};

export default LoginButton; 