import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { Box, ThemeProvider, CssBaseline } from '@mui/material';
import { LocalizationProvider } from '@mui/x-date-pickers';
import { AdapterDateFns } from '@mui/x-date-pickers/AdapterDateFns';
import { AuthProvider } from './contexts/AuthContext';
import { AdminProvider } from './contexts/AdminContext';
import theme from './theme';
import Home from './pages/Home';
import Login from './pages/Login';
import Register from './pages/Register';
import Tasks from './pages/Tasks';
import CreateTask from './pages/CreateTask';
import TaskDetails from './pages/TaskDetails';
import ExecutionDetails from './pages/ExecutionDetails';
import Layout from './components/Layout';
import OAuthCallback from './pages/OAuthCallback';
import AdminDashboard from './pages/AdminDashboard';
import PrivateRoute from './components/PrivateRoute';
import AdminRoute from './components/AdminRoute';
import Profile from './pages/Profile';
import Config from './pages/Config';
import Workflows from './pages/Workflows';
import WorkflowBuilder from './pages/WorkflowBuilder';
import WorkflowDetails from './pages/WorkflowDetails';
import WorkflowRun from './pages/WorkflowRun';
import Release from './pages/Release';

export default function App() {
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <LocalizationProvider dateAdapter={AdapterDateFns}>
        <AuthProvider>
          <AdminProvider>
            <Router>
              <Box sx={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
                <Routes>
                  <Route path="/" element={<Layout />}>
                    <Route index element={<Home />} />
                    <Route path="login" element={<Login />} />
                    <Route path="register" element={<Register />} />
                    <Route path="oauth-callback" element={<OAuthCallback />} />
                    <Route path="release" element={<Release />} />
                    <Route
                      path="tasks"
                      element={
                        <PrivateRoute>
                          <Tasks />
                        </PrivateRoute>
                      }
                    />
                    <Route
                      path="admin"
                      element={
                        <AdminRoute>
                          <AdminDashboard />
                        </AdminRoute>
                      }
                    />
                    <Route
                      path="tasks/create"
                      element={
                        <PrivateRoute>
                          <CreateTask />
                        </PrivateRoute>
                      }
                    />
                    <Route
                      path="tasks/:taskId"
                      element={
                        <PrivateRoute>
                          <TaskDetails />
                        </PrivateRoute>
                      }
                    />
                    <Route
                      path="tasks/:taskId/executions/:executionId"
                      element={
                        <PrivateRoute>
                          <ExecutionDetails />
                        </PrivateRoute>
                      }
                    />
                    <Route
                      path="admin/tasks/:taskId"
                      element={
                        <AdminRoute>
                          <TaskDetails />
                        </AdminRoute>
                      }
                    />
                    <Route
                      path="profile"
                      element={
                        <PrivateRoute>
                          <Profile />
                        </PrivateRoute>
                      }
                    />
                    <Route
                      path="profile/:userId"
                      element={
                        <PrivateRoute>
                          <Profile />
                        </PrivateRoute>
                      }
                    />
                    <Route path="/config" element={<Config />} />
                    <Route
                      path="workflows"
                      element={
                        <PrivateRoute>
                          <Workflows />
                        </PrivateRoute>
                      }
                    />
                    <Route
                      path="workflows/new"
                      element={
                        <PrivateRoute>
                          <WorkflowBuilder />
                        </PrivateRoute>
                      }
                    />
                    <Route
                      path="workflows/:id"
                      element={
                        <PrivateRoute>
                          <WorkflowDetails />
                        </PrivateRoute>
                      }
                    />
                    <Route
                      path="workflows/:id/edit"
                      element={
                        <PrivateRoute>
                          <WorkflowBuilder />
                        </PrivateRoute>
                      }
                    />
                    <Route
                      path="workflows/:id/run"
                      element={
                        <PrivateRoute>
                          <WorkflowRun />
                        </PrivateRoute>
                      }
                    />
                  </Route>
                </Routes>
              </Box>
            </Router>
          </AdminProvider>
        </AuthProvider>
      </LocalizationProvider>
    </ThemeProvider>
  );
}
