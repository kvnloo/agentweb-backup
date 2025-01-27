import { Button } from '@mui/material';
import { useAuth } from '../contexts/AuthContext';
import { useNavigate } from 'react-router-dom';

export default function GoogleSignInButton() {
  const { loginWithGoogle } = useAuth();
  const navigate = useNavigate();

  const handleGoogleSignIn = async () => {
    try {
      await loginWithGoogle();
      navigate('/dashboard');
    } catch (error) {
      console.error('Google sign-in failed:', error);
    }
  };

  return (
    <Button
      fullWidth
      variant="outlined"
      onClick={handleGoogleSignIn}
      sx={{
        mt: 3,
        mb: 2,
        borderColor: '#4285f4',
        color: '#4285f4',
        '&:hover': {
          borderColor: '#357ABD',
          backgroundColor: 'rgba(66, 133, 244, 0.04)',
        },
      }}
    >
      Continue with Google
    </Button>
  );
} 