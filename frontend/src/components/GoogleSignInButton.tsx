import { Button } from '@mui/material';
import GoogleIcon from '@mui/icons-material/Google';
import { useAuth } from '../contexts/AuthContext';

export default function GoogleSignInButton() {
  const { loginWithGoogle } = useAuth();

  const handleGoogleSignIn = async () => {
    try {
      await loginWithGoogle();
    } catch (error) {
      console.error('Google sign in failed:', error);
    }
  };

  return (
    <Button
      onClick={handleGoogleSignIn}
      fullWidth
      variant="outlined"
      startIcon={<GoogleIcon />}
      sx={{
        mt: 1,
        mb: 1,
        borderColor: '#4285f4',
        color: '#4285f4',
        '&:hover': {
          borderColor: '#2b6cd4',
          backgroundColor: 'rgba(66, 133, 244, 0.04)'
        }
      }}
    >
      Sign in with Google
    </Button>
  );
} 