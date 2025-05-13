import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { Box, ThemeProvider, CssBaseline } from '@mui/material';
import { LocalizationProvider } from '@mui/x-date-pickers';
import { AdapterDateFns } from '@mui/x-date-pickers/AdapterDateFns';
import { AuthProvider } from './contexts/AuthContext';
import { AdminProvider } from './contexts/AdminContext';
import theme from './theme';
import Login from './pages/Login';
import Register from './pages/Register';
import Tasks from './pages/Tasks';
import CreateTask from './pages/CreateTask';
import TaskDetails from './pages/TaskDetails';
import ExecutionDetails from './pages/ExecutionDetails';
import SharedExecution from './pages/SharedExecution';
import Layout from './components/Layout';
import OAuthCallback from './pages/OAuthCallback';
import AdminDashboard from './pages/AdminDashboard';
import PrivateRoute from './components/PrivateRoute';
import AdminRoute from './components/AdminRoute';
import PartnerRoute from './components/PartnerRoute';
import CustomerRoute from './components/CustomerRoute';
import Profile from './pages/Profile';
import Config from './pages/Config';
import Workflows from './pages/Workflows';
import WorkflowBuilder from './pages/WorkflowBuilder';
import WorkflowDetails from './pages/WorkflowDetails';
import WorkflowRun from './pages/WorkflowRun';
import Release from './pages/Release';
import Guide from './pages/Guide';
import Templates from './pages/Templates';
import Api from './pages/Api';
import Marketing from './pages/marketing';
import { useEffect } from 'react';

const RedirectToAgentWeb = () => {
  useEffect(() => {
    window.location.href = 'https://www.agentweb.pro';
  }, []);

  return null;
};

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
                    <Route index element={<RedirectToAgentWeb />} />
                    <Route path="login" element={<Login />} />
                    <Route path="register" element={<Register />} />
                    <Route path="oauth-callback" element={<OAuthCallback />} />
                    <Route path="release" element={<Release />} />
                    <Route path="guide" element={<Guide />} />
                    <Route path="api" element={<Api />} />
                    <Route path="execution/:executionId/token/:token" element={<SharedExecution />} />
                    <Route
                      path="tasks"
                      element={
                        <PartnerRoute>
                          <Tasks />
                        </PartnerRoute>
                      }
                    />
                    <Route
                      path="templates"
                      element={
                        <PartnerRoute>
                          <Templates />
                        </PartnerRoute>
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
                        <PartnerRoute>
                          <CreateTask />
                        </PartnerRoute>
                      }
                    />
                    <Route
                      path="tasks/:taskId"
                      element={
                        <PartnerRoute>
                          <TaskDetails />
                        </PartnerRoute>
                      }
                    />
                    <Route
                      path="tasks/:taskId/executions/:executionId"
                      element={
                        <PartnerRoute>
                          <ExecutionDetails />
                        </PartnerRoute>
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
                        <PartnerRoute>
                          <Workflows />
                        </PartnerRoute>
                      }
                    />
                    <Route
                      path="workflows/new"
                      element={
                        <PartnerRoute>
                          <WorkflowBuilder />
                        </PartnerRoute>
                      }
                    />
                    <Route
                      path="workflows/:id"
                      element={
                        <PartnerRoute>
                          <WorkflowDetails />
                        </PartnerRoute>
                      }
                    />
                    <Route
                      path="workflows/:id/edit"
                      element={
                        <PartnerRoute>
                          <WorkflowBuilder />
                        </PartnerRoute>
                      }
                    />
                    <Route
                      path="workflows/:id/run"
                      element={
                        <PartnerRoute>
                          <WorkflowRun />
                        </PartnerRoute>
                      }
                    />
                    <Route 
                      path="marketing/*" 
                      element={
                        <CustomerRoute>
                          <Marketing />
                        </CustomerRoute>
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
