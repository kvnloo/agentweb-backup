import { Button } from '@mui/material';
import { useAuth } from '../contexts/AuthContext';

export default function LoginButton() {
  const { loginWithLogin } = useAuth();

  const handleLogin = async () => {
    try {
      await loginWithLogin();
    } catch (error) {
      console.error('Login failed:', error);
    }
  };

  return (
    <Button
      onClick={handleLogin}
      fullWidth
      variant="contained"
      color="primary"
      sx={{ mt: 1, mb: 1 }}
    >
      Sign in with Login
    </Button>
  );
} 