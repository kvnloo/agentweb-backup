import React from 'react';
import { Link as RouterLink, Outlet, useLocation } from 'react-router-dom';
import {
  AppBar,
  Box,
  Button,
  Container,
  IconButton,
  Menu,
  MenuItem,
  Toolbar,
  Typography,
  Chip,
  Alert
} from '@mui/material';
import AccountCircle from '@mui/icons-material/AccountCircle';
import { useAuth } from '../contexts/AuthContext';
import logo from '../assets/logo.svg';
import ChatSupport from './ChatSupport';
import { getHeaderNavigation, getPortalRoute } from '../navigation/catalog';

export default function Layout() {
  const { user, logout, hasRole } = useAuth();
  const [anchorEl, setAnchorEl] = React.useState<null | HTMLElement>(null);
  const location = useLocation();
  const isHomePage = location.pathname === '/';
  const headerNavigation = getHeaderNavigation({
    authenticated: Boolean(user),
    isAdmin: Boolean(user?.isAdmin),
    isContractor: Boolean(user && hasRole('contractor')),
  });
  const loginRoute = getPortalRoute('login');
  const profileRoute = getPortalRoute('profile');

  const handleMenu = (event: React.MouseEvent<HTMLElement>) => {
    setAnchorEl(event.currentTarget);
  };

  const handleClose = () => {
    setAnchorEl(null);
  };

  const handleLogout = () => {
    handleClose();
    logout();
  };

  const isActivePath = (path: string) => {
    if (path === '/') {
      return location.pathname === '/';
    }
    return location.pathname.startsWith(path);
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
      {!isHomePage && (
        <AppBar 
          position="static" 
          sx={{ 
            bgcolor: 'background.paper',
            borderBottom: '1px solid',
            borderColor: 'divider',
            boxShadow: 'none'
          }}
        >
          <Toolbar>
            <Box
              component={RouterLink}
              to="/"
              sx={{
                display: 'flex',
                alignItems: 'center',
                textDecoration: 'none',
                color: 'primary.main'
              }}
            >
              <img src={logo} alt="AgentWeb Logo" style={{ height: 32, width: 32, marginRight: 8 }} />
              <Typography 
                variant="h6" 
                component="div" 
                sx={{ 
                  flexGrow: 0, 
                  mr: 1,
                  fontWeight: 600,
                  fontSize: { xs: '1.25rem', sm: '1.5rem' },
                  display: 'flex',
                  alignItems: 'center',
                  gap: 1
                }}
              >
                AgentWeb
                <Typography
                  component="span"
                  sx={{
                    fontSize: '0.9rem',
                    fontWeight: 500,
                    opacity: 0.9,
                    ml: 1,
                    display: { xs: 'none', sm: 'block' }
                  }}
                >
                  Your Marketing Operator 24/7
                </Typography>
              </Typography>
              <Chip
                label="BETA"
                sx={{
                  bgcolor: 'rgba(25, 118, 210, 0.08)',
                  color: 'primary.main',
                  fontWeight: 600,
                  height: 'auto',
                  py: 0.5,
                  px: 1
                }}
              />
            </Box>
            <Box sx={{ flexGrow: 1, ml: 3 }}>
              {headerNavigation.map((entry) => (
                <Button
                  key={entry.id}
                  color="primary"
                  component={RouterLink}
                  to={entry.destination}
                  variant={isActivePath(entry.destination) ? 'contained' : 'text'}
                >
                  {entry.label}
                </Button>
              ))}
            </Box>
            {user ? (
              <div>
                <IconButton
                  size="large"
                  aria-label="account of current user"
                  aria-controls="menu-appbar"
                  aria-haspopup="true"
                  onClick={handleMenu}
                  color="primary"
                >
                  <AccountCircle />
                </IconButton>
                <Menu
                  id="menu-appbar"
                  anchorEl={anchorEl}
                  anchorOrigin={{
                    vertical: 'top',
                    horizontal: 'right',
                  }}
                  keepMounted
                  transformOrigin={{
                    vertical: 'top',
                    horizontal: 'right',
                  }}
                  open={Boolean(anchorEl)}
                  onClose={handleClose}
                >
                  <MenuItem 
                    component={RouterLink} 
                    to={profileRoute.destination}
                    onClick={handleClose}
                    selected={isActivePath(profileRoute.destination)}
                  >
                    {profileRoute.label}
                  </MenuItem>
                  <MenuItem onClick={handleLogout}>Logout</MenuItem>
                </Menu>
              </div>
            ) : (
              <Button 
                color="primary" 
                component={RouterLink} 
                to={loginRoute.destination}
                variant={isActivePath(loginRoute.destination) ? 'contained' : 'text'}
              >
                {loginRoute.label}
              </Button>
            )}
          </Toolbar>
        </AppBar>
      )}
      {user && location.pathname !== '/' && (
        <Alert 
          severity="info" 
          sx={{ 
            borderRadius: 0,
            '& .MuiAlert-message': {
              width: '100%',
              textAlign: 'center'
            }
          }}
        >
          🚧 Private Beta: This is a beta version - bugs and issues may arise. Please report them to{' '}
          <a href="mailto:support@agentweb.pro" style={{ color: 'inherit', fontWeight: 'bold' }}>
            support@agentweb.pro
          </a>
        </Alert>
      )}
      <Container component="main" sx={{ mt: 4, mb: 4, flexGrow: 1 }}>
        <Outlet />
      </Container>
      <Box
        component="footer"
        sx={{
          py: 3,
          px: 2,
          mt: 'auto',
          backgroundColor: (theme) =>
            theme.palette.mode === 'light'
              ? theme.palette.grey[100]
              : theme.palette.grey[900],
        }}
      >
        <Container maxWidth="lg">
          <Typography variant="body2" color="text.secondary" align="center">
            {'© '}
            {new Date().getFullYear()}
            {' AgentWeb. All rights reserved.'}
          </Typography>
        </Container>
      </Box>
      
      {user && <ChatSupport />}
    </Box>
  );
} 
