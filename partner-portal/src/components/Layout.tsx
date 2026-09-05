import React from 'react';
import { Link as RouterLink, Outlet, useLocation } from 'react-router-dom';
import {
  AppBar,
  Avatar,
  Box,
  Button,
  Container,
  IconButton,
  Menu,
  MenuItem,
  Toolbar,
  Typography,
  Alert
} from '@mui/material';
import ExpandMoreRoundedIcon from '@mui/icons-material/ExpandMoreRounded';
import { useAuth } from '../contexts/AuthContext';
import logo from '../assets/logo.svg';
import ChatSupport from './ChatSupport';
import { getGroupedHeaderNavigation, getPortalRoute } from '../navigation/catalog';

type HeaderEntry = ReturnType<typeof getGroupedHeaderNavigation>['direct'][number];

// Header item treatment from the approved ENG-1707 round-2 design: quiet
// slate text, a soft blue pill for the active destination, no filled buttons.
const NAV_ITEM_SX = {
  px: 1.5,
  py: 0.75,
  minWidth: 0,
  flexShrink: 0,
  borderRadius: '7px',
  fontSize: '0.84rem',
  fontWeight: 600,
  lineHeight: 1.4,
  color: 'text.secondary',
  '&:hover': { bgcolor: 'background.default', color: 'text.primary' },
} as const;

const NAV_ITEM_ACTIVE_SX = {
  bgcolor: '#eff6ff',
  color: 'primary.dark',
  '&:hover': { bgcolor: '#eff6ff', color: 'primary.dark' },
} as const;

const MENU_PAPER_SX = {
  mt: 0.5,
  minWidth: 220,
  borderRadius: '10px',
  border: '1px solid',
  borderColor: 'divider',
  boxShadow: '0 12px 32px rgba(15, 23, 42, 0.12)',
  '& .MuiMenuItem-root': {
    mx: 0.75,
    my: 0.25,
    borderRadius: '6px',
    fontSize: '0.84rem',
    fontWeight: 500,
    py: 0.75,
  },
} as const;

export default function Layout() {
  const { user, logout, hasRole } = useAuth();
  const [anchorEl, setAnchorEl] = React.useState<null | HTMLElement>(null);
  const [buildAnchor, setBuildAnchor] = React.useState<null | HTMLElement>(null);
  const [operateAnchor, setOperateAnchor] = React.useState<null | HTMLElement>(null);
  const location = useLocation();
  const isHomePage = location.pathname === '/';
  // The admin operating surface owns its own two-pane shell and runs edge to edge.
  const isFullBleedRoute = location.pathname.startsWith('/admin');
  const headerNavigation = getGroupedHeaderNavigation({
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

  // Approved order: Home, Tasks, Workflows, Build, Operate, Admin — Release sits
  // alone on the right as a utility link. Grouping is presentational only.
  const primaryEntries = headerNavigation.direct.filter((entry) => entry.id !== 'admin' && entry.id !== 'release');
  const adminEntry = headerNavigation.direct.find((entry) => entry.id === 'admin');
  const releaseEntry = headerNavigation.direct.find((entry) => entry.id === 'release');
  const buildActive = headerNavigation.build.some((entry) => isActivePath(entry.destination));
  const operateActive = headerNavigation.operate.some((entry) => isActivePath(entry.destination));
  const avatarInitial = (user?.email ?? '').trim().charAt(0).toUpperCase() || 'A';

  const renderNavLink = (entry: HeaderEntry) => (
    <Button
      key={entry.id}
      component={RouterLink}
      to={entry.destination}
      aria-current={isActivePath(entry.destination) ? 'page' : undefined}
      sx={{ ...NAV_ITEM_SX, ...(isActivePath(entry.destination) ? NAV_ITEM_ACTIVE_SX : {}) }}
    >
      {entry.label}
    </Button>
  );

  const renderGroupMenu = (
    id: string,
    label: string,
    entries: readonly HeaderEntry[],
    anchor: HTMLElement | null,
    setAnchor: (value: HTMLElement | null) => void,
    active: boolean,
  ) => (
    <React.Fragment key={id}>
      <Button
        aria-controls={anchor ? `${id}-navigation-menu` : undefined}
        aria-haspopup="true"
        aria-expanded={anchor ? 'true' : undefined}
        onClick={(event) => setAnchor(event.currentTarget)}
        endIcon={<ExpandMoreRoundedIcon sx={{ fontSize: '1rem !important', color: '#94a3b8' }} />}
        sx={{ ...NAV_ITEM_SX, ...(active ? NAV_ITEM_ACTIVE_SX : {}), '& .MuiButton-endIcon': { ml: 0.25, mr: -0.5 } }}
      >
        {label}
      </Button>
      <Menu
        id={`${id}-navigation-menu`}
        anchorEl={anchor}
        open={Boolean(anchor)}
        onClose={() => setAnchor(null)}
        MenuListProps={{ dense: true }}
        slotProps={{ paper: { sx: MENU_PAPER_SX } }}
      >
        {entries.map((entry) => (
          <MenuItem
            key={entry.id}
            component={RouterLink}
            to={entry.destination}
            onClick={() => setAnchor(null)}
            selected={isActivePath(entry.destination)}
          >
            {entry.label}
          </MenuItem>
        ))}
      </Menu>
    </React.Fragment>
  );

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
          <Toolbar disableGutters sx={{ minHeight: { xs: 56, sm: 58 }, px: { xs: 1.5, sm: 2.5 }, gap: 0.75 }}>
            <Box
              component={RouterLink}
              to="/"
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 1,
                mr: 1.5,
                flexShrink: 0,
                textDecoration: 'none',
                color: 'primary.main'
              }}
            >
              <img src={logo} alt="" style={{ height: 28, width: 28 }} />
              <Typography component="span" sx={{ fontWeight: 800, fontSize: '1rem', letterSpacing: '-0.01em' }}>
                AgentWeb
              </Typography>
            </Box>
            <Box
              component="nav"
              aria-label="Primary"
              sx={{
                flexGrow: 1,
                minWidth: 0,
                display: 'flex',
                alignItems: 'center',
                gap: 0.5,
                overflowX: 'auto',
                scrollbarWidth: 'none',
                '&::-webkit-scrollbar': { display: 'none' }
              }}
            >
              {primaryEntries.map(renderNavLink)}
              {headerNavigation.build.length > 0 &&
                renderGroupMenu('build', 'Build', headerNavigation.build, buildAnchor, setBuildAnchor, buildActive)}
              {headerNavigation.operate.length > 0 &&
                renderGroupMenu('operate', 'Operate', headerNavigation.operate, operateAnchor, setOperateAnchor, operateActive)}
              {adminEntry && renderNavLink(adminEntry)}
            </Box>
            {releaseEntry && (
              <Button
                component={RouterLink}
                to={releaseEntry.destination}
                aria-current={isActivePath(releaseEntry.destination) ? 'page' : undefined}
                sx={{
                  ...NAV_ITEM_SX,
                  fontWeight: 500,
                  display: { xs: 'none', sm: 'inline-flex' },
                  ...(isActivePath(releaseEntry.destination) ? NAV_ITEM_ACTIVE_SX : {})
                }}
              >
                {releaseEntry.label}
              </Button>
            )}
            {user ? (
              <div>
                <IconButton
                  size="small"
                  aria-label="account of current user"
                  aria-controls="menu-appbar"
                  aria-haspopup="true"
                  onClick={handleMenu}
                  sx={{ ml: 0.5, p: 0.5 }}
                >
                  <Avatar sx={{ width: 28, height: 28, bgcolor: '#dbeafe', color: 'primary.dark', fontSize: '0.75rem', fontWeight: 700 }}>
                    {avatarInitial}
                  </Avatar>
                </IconButton>
                <Menu
                  id="menu-appbar"
                  anchorEl={anchorEl}
                  anchorOrigin={{
                    vertical: 'bottom',
                    horizontal: 'right',
                  }}
                  keepMounted
                  transformOrigin={{
                    vertical: 'top',
                    horizontal: 'right',
                  }}
                  open={Boolean(anchorEl)}
                  onClose={handleClose}
                  MenuListProps={{ dense: true }}
                  slotProps={{ paper: { sx: { ...MENU_PAPER_SX, minWidth: 180 } } }}
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
                component={RouterLink}
                to={loginRoute.destination}
                variant={isActivePath(loginRoute.destination) ? 'contained' : 'outlined'}
                size="small"
                sx={{ flexShrink: 0 }}
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
      {isFullBleedRoute ? (
        <Box component="main" sx={{ flexGrow: 1, display: 'flex', flexDirection: 'column' }}>
          <Outlet />
        </Box>
      ) : (
        <Container component="main" sx={{ mt: 4, mb: 4, flexGrow: 1 }}>
          <Outlet />
        </Container>
      )}
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
