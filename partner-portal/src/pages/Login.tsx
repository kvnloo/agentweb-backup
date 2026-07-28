import { useEffect } from 'react';
import { useLocation, useNavigate, Link as RouterLink } from 'react-router-dom';
import {
  Container,
  Box,
  Typography,
  TextField,
  Button,
  Link,
  Alert,
  Divider,
} from '@mui/material';
import { useAuth } from '../contexts/AuthContext';
import GoogleSignInButton from '../components/GoogleSignInButton';

export default function Login() {
  const { login, loginError, clearLoginError } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const returnTo = location.state?.from ?? '/tasks';

  useEffect(() => {
    clearLoginError();
  }, [clearLoginError]);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    clearLoginError();
    const submittedForm = new FormData(e.currentTarget);
    const submittedEmail = String(submittedForm.get('email') ?? '');
    const submittedPassword = String(submittedForm.get('password') ?? '');

    try {
      await login(submittedEmail, submittedPassword, 'partner');
      navigate(returnTo, { replace: true });
    } catch {
      // AuthContext exposes the user-facing login error.
    }
  };

  const handleFormKeyDown = (e: React.KeyboardEvent<HTMLFormElement>) => {
    const target = e.target;
    const isTextInput = target instanceof HTMLInputElement;
    const isSubmitButton =
      target instanceof HTMLButtonElement && target.type === 'submit';
    const isKeyboardSubmit =
      (e.key === 'Enter' && (isTextInput || isSubmitButton)) ||
      (e.key === ' ' && isSubmitButton);

    if (!isKeyboardSubmit) return;

    e.preventDefault();
    if (e.repeat || e.nativeEvent.isComposing) return;

    e.currentTarget.requestSubmit(isSubmitButton ? target : undefined);
  };

  return (
    <Container maxWidth="xs">
      <Box
        sx={{
          marginTop: 8,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
        }}
      >
        <Typography component="h1" variant="h5">
          Sign in to Partner Portal
        </Typography>
        <Box sx={{ mt: 1, width: '100%' }}>
          <GoogleSignInButton />
          <Divider sx={{ my: 2 }}>OR</Divider>
          <Box
            component="form"
            onSubmit={handleSubmit}
            onKeyDown={handleFormKeyDown}
          >
            {loginError && (
              <Alert severity="error" sx={{ mb: 2 }}>
                {loginError}
              </Alert>
            )}
            <TextField
              margin="normal"
              required
              fullWidth
              id="email"
              label="Email Address"
              name="email"
              autoComplete="email"
              autoFocus
            />
            <TextField
              margin="normal"
              required
              fullWidth
              name="password"
              label="Password"
              type="password"
              id="password"
              autoComplete="current-password"
            />
            <Button
              type="submit"
              fullWidth
              variant="contained"
              sx={{ mt: 3, mb: 2 }}
            >
              Sign In with Email
            </Button>
            <Box sx={{ textAlign: 'center' }}>
              <Link component={RouterLink} to="/register" variant="body2">
                {"Don't have an account? Sign Up"}
              </Link>
            </Box>
          </Box>
        </Box>
      </Box>
    </Container>
  );
}
