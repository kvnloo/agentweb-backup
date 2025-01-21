import { BrowserRouter as Router, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { Box, AppBar, Toolbar, Button, Typography, ThemeProvider, CssBaseline, Container } from '@mui/material';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import theme from './theme';
import Home from './pages/Home';
import Login from './pages/Login';
import Register from './pages/Register';
import Dashboard from './pages/Dashboard';
import CreateTask from './pages/CreateTask';
import TaskDetails from './pages/TaskDetails';
import Layout from './components/Layout';

function Header() {
  const { isAuthenticated, logout } = useAuth();
  const location = useLocation();

  // Don't show header on home page
  if (location.pathname === '/') {
    return null;
  }

  return (
    <AppBar position="static" color="transparent" elevation={0}>
      <Toolbar>
        <Typography variant="h6" component="div" sx={{ flexGrow: 1 }}>
          AgentWeb
        </Typography>
        {isAuthenticated ? (
          <>
            <Button color="inherit" onClick={logout}>Logout</Button>
          </>
        ) : (
          <>
            <Button color="inherit" href="/login">Login</Button>
            <Button color="inherit" href="/register">Register</Button>
          </>
        )}
      </Toolbar>
    </AppBar>
  );
}

function RequireAuth({ children }: { children: JSX.Element }) {
  const { isAuthenticated } = useAuth();
  const location = useLocation();

  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return children;
}

function Footer() {
  return (
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
  );
}

function App() {
  const location = useLocation();
  const isHomePage = location.pathname === '/';

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <AuthProvider>
        <Box sx={{ 
          display: 'flex', 
          flexDirection: 'column', 
          minHeight: '100vh',
          bgcolor: 'grey.50'
        }}>
          <Box sx={{ flexGrow: 1 }}>
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/login" element={<Login />} />
              <Route path="/register" element={<Register />} />
              <Route path="/dashboard" element={
                <RequireAuth>
                  <Dashboard />
                </RequireAuth>
              } />
              <Route path="/tasks/create" element={
                <RequireAuth>
                  <CreateTask />
                </RequireAuth>
              } />
              <Route path="/tasks/:taskId" element={
                <RequireAuth>
                  <TaskDetails />
                </RequireAuth>
              } />
            </Routes>
          </Box>
          <Footer />
        </Box>
      </AuthProvider>
    </ThemeProvider>
  );
}

export default function AppWrapper() {
  return (
    <Router>
      <App />
    </Router>
  );
}
