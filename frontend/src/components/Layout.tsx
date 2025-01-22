import { ReactNode } from 'react';
import { useNavigate, Link as RouterLink } from 'react-router-dom';
import {
  AppBar,
  Box,
  Toolbar,
  Typography,
  Button,
  Container,
  Link,
  useTheme,
  useMediaQuery,
} from '@mui/material';
import { useAuth } from '../contexts/AuthContext';

interface LayoutProps {
  children: ReactNode;
}

export default function Layout({ children }: LayoutProps) {
  const { isAuthenticated, userEmail, logout } = useAuth();
  const navigate = useNavigate();
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  return (
    <Box sx={{ 
      display: 'flex', 
      flexDirection: 'column', 
      minHeight: '100vh',
      bgcolor: 'grey.50'
    }}>
      <AppBar position="static" elevation={1} sx={{ bgcolor: 'white' }}>
        <Container maxWidth="lg">
          <Toolbar sx={{ px: { xs: 0 } }}>
            <Typography 
              variant="h6" 
              component="div" 
              sx={{ 
                flexGrow: 1,
                color: 'primary.main',
                fontWeight: 600,
                fontSize: { xs: '1.25rem', sm: '1.5rem' }
              }}
            >
              <Link
                component={RouterLink}
                to="/"
                color="inherit"
                underline="none"
              >
                AgentWeb
              </Link>
            </Typography>
            <Box sx={{ 
              display: 'flex', 
              gap: { xs: 1, sm: 2 },
              alignItems: 'center',
              '& .MuiButton-root': {
                minWidth: isMobile ? 'auto' : undefined,
                px: isMobile ? 2 : 3
              }
            }}>
              {isAuthenticated ? (
                <>
                  <Button
                    color="primary"
                    component={RouterLink}
                    to="/dashboard"
                    variant="text"
                  >
                    Dashboard
                  </Button>
                  <Button
                    color="primary"
                    component={RouterLink}
                    to="/tasks/create"
                    variant="contained"
                    sx={{ 
                      boxShadow: 'none',
                      '&:hover': { boxShadow: 'none' }
                    }}
                  >
                    Create Task
                  </Button>
                  <Typography 
                    variant="body2" 
                    sx={{ 
                      color: 'text.secondary',
                      display: { xs: 'none', sm: 'block' }
                    }}
                  >
                    {userEmail}
                  </Typography>
                  <Button 
                    color="primary" 
                    onClick={handleLogout}
                    variant="outlined"
                  >
                    Logout
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    color="primary"
                    component={RouterLink}
                    to="/login"
                    variant="outlined"
                  >
                    Login
                  </Button>
                  <Button
                    color="primary"
                    component={RouterLink}
                    to="/register"
                    variant="contained"
                    sx={{ 
                      boxShadow: 'none',
                      '&:hover': { boxShadow: 'none' }
                    }}
                  >
                    Register
                  </Button>
                </>
              )}
            </Box>
          </Toolbar>
        </Container>
      </AppBar>
      
      <Box component="main" sx={{ flexGrow: 1 }}>
        {children}
      </Box>

      <Box
        component="footer"
        sx={{
          py: 3,
          px: 2,
          mt: 'auto',
          backgroundColor: 'white',
          borderTop: 1,
          borderColor: 'grey.200'
        }}
      >
        <Container maxWidth="lg">
          <Typography 
            variant="body2" 
            color="text.secondary" 
            align="center"
            sx={{ fontWeight: 500 }}
          >
            © {new Date().getFullYear()} AgentWeb. All rights reserved.
          </Typography>
        </Container>
      </Box>
    </Box>
  );
} 