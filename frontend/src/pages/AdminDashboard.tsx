import React, { useEffect, useState } from 'react';
import { useAdmin } from '../contexts/AdminContext';
import {
  Box,
  Tabs,
  Tab,
  Typography,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Button,
  CircularProgress,
  Alert,
  Grid,
  Card,
  CardContent,
  TextField,
  Chip
} from '@mui/material';
import { format } from 'date-fns';

interface TabPanelProps {
  children?: React.ReactNode;
  index: number;
  value: number;
}

function TabPanel(props: TabPanelProps) {
  const { children, value, index, ...other } = props;

  return (
    <div
      role="tabpanel"
      hidden={value !== index}
      id={`admin-tabpanel-${index}`}
      aria-labelledby={`admin-tab-${index}`}
      {...other}
    >
      {value === index && <Box sx={{ p: 3 }}>{children}</Box>}
    </div>
  );
}

export default function AdminDashboard() {
  const [tabValue, setTabValue] = useState(0);
  const [startDate, setStartDate] = useState<Date | null>(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));
  const [endDate, setEndDate] = useState<Date | null>(new Date());
  
  const {
    users,
    waitlist,
    taskAnalytics,
    userAnalytics,
    loadUsers,
    loadWaitlist,
    loadAnalytics,
    updateWaitlistStatus,
    loading,
    error
  } = useAdmin();

  useEffect(() => {
    const loadData = async () => {
      await loadUsers();
      await loadWaitlist();
    };
    loadData();
  }, []);

  useEffect(() => {
    if (startDate && endDate && tabValue === 0 && !loading) {
      loadAnalytics(
        format(startDate, 'yyyy-MM-dd'),
        format(endDate, 'yyyy-MM-dd')
      );
    }
  }, [startDate, endDate, tabValue]);

  const handleTabChange = (_: React.SyntheticEvent, newValue: number) => {
    setTabValue(newValue);
  };

  const handleWaitlistAction = async (email: string, status: string) => {
    await updateWaitlistStatus(email, status);
  };

  if (error) {
    return <Alert severity="error">{error}</Alert>;
  }

  return (
    <Box sx={{ width: '100%' }}>
      <Box sx={{ borderBottom: 1, borderColor: 'divider' }}>
        <Tabs value={tabValue} onChange={handleTabChange}>
          <Tab label="Analytics" />
          <Tab label="Users" />
          <Tab label="Waitlist" />
        </Tabs>
      </Box>

      <TabPanel value={tabValue} index={0}>
        <Box sx={{ mb: 3 }}>
          <Grid container spacing={2} alignItems="center">
            <Grid item>
              <TextField
                type="date"
                label="Start Date"
                value={startDate ? format(startDate, 'yyyy-MM-dd') : ''}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setStartDate(new Date(e.target.value))}
                InputLabelProps={{
                  shrink: true,
                }}
              />
            </Grid>
            <Grid item>
              <TextField
                type="date"
                label="End Date"
                value={endDate ? format(endDate, 'yyyy-MM-dd') : ''}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEndDate(new Date(e.target.value))}
                InputLabelProps={{
                  shrink: true,
                }}
              />
            </Grid>
          </Grid>
        </Box>

        {loading ? (
          <CircularProgress />
        ) : (
          <Grid container spacing={3}>
            <Grid item xs={12} md={6}>
              <Card>
                <CardContent>
                  <Typography variant="h6" gutterBottom>
                    User Analytics
                  </Typography>
                  {userAnalytics && (
                    <>
                      <Typography>Total Users: {userAnalytics.totalUsers}</Typography>
                      <Typography>New Users: {userAnalytics.newUsers}</Typography>
                      <Typography>OAuth Users: {userAnalytics.oauthUsers}</Typography>
                      <Typography>Admin Users: {userAnalytics.adminUsers}</Typography>
                    </>
                  )}
                </CardContent>
              </Card>
            </Grid>
            <Grid item xs={12} md={6}>
              <Card>
                <CardContent>
                  <Typography variant="h6" gutterBottom>
                    Task Analytics
                  </Typography>
                  {taskAnalytics && (
                    <>
                      <Typography>Total Tasks: {taskAnalytics.totalTasks}</Typography>
                      <Typography>New Tasks: {taskAnalytics.newTasks}</Typography>
                      <Typography>Total Executions: {taskAnalytics.totalExecutions}</Typography>
                      <Typography>Successful Executions: {taskAnalytics.successfulExecutions}</Typography>
                      <Typography>Failed Executions: {taskAnalytics.failedExecutions}</Typography>
                      <Typography>
                        Average Execution Time: {Math.round(taskAnalytics.averageExecutionTime / 1000)}s
                      </Typography>
                    </>
                  )}
                </CardContent>
              </Card>
            </Grid>
          </Grid>
        )}
      </TabPanel>

      <TabPanel value={tabValue} index={1}>
        <TableContainer component={Paper}>
          <Table>
            <TableHead>
              <TableRow>
                <TableCell>User ID</TableCell>
                <TableCell>Email</TableCell>
                <TableCell>Created At</TableCell>
                <TableCell>OAuth User</TableCell>
                <TableCell>Admin</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={5} align="center">
                    <CircularProgress />
                  </TableCell>
                </TableRow>
              ) : (
                users.map((user) => (
                  <TableRow key={user.userId}>
                    <TableCell>{user.userId}</TableCell>
                    <TableCell>{user.email}</TableCell>
                    <TableCell>{new Date(user.createdAt).toLocaleDateString()}</TableCell>
                    <TableCell>{user.isOAuthUser ? 'Yes' : 'No'}</TableCell>
                    <TableCell>{user.isAdmin ? 'Yes' : 'No'}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </TableContainer>
      </TabPanel>

      <TabPanel value={tabValue} index={2}>
        <TableContainer component={Paper}>
          <Table>
            <TableHead>
              <TableRow>
                <TableCell>Email</TableCell>
                <TableCell>Joined At</TableCell>
                <TableCell>Status</TableCell>
                <TableCell>Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={4} align="center">
                    <CircularProgress />
                  </TableCell>
                </TableRow>
              ) : (
                waitlist.map((entry) => {
                  const userExists = users.some(user => user.email === entry.email);
                  return (
                    <TableRow key={entry.email}>
                      <TableCell>{entry.email}</TableCell>
                      <TableCell>{new Date(entry.joinedAt).toLocaleDateString()}</TableCell>
                      <TableCell>
                        {userExists ? (
                          <Chip label="Registered" color="success" />
                        ) : (
                          entry.status
                        )}
                      </TableCell>
                      <TableCell>
                        {!userExists && entry.status === 'pending' && (
                          <Button
                            variant="contained"
                            color="primary"
                            onClick={() => handleWaitlistAction(entry.email, 'invited')}
                          >
                            Invite
                          </Button>
                        )}
                        {!userExists && entry.status === 'invited' && (
                          <Button
                            variant="outlined"
                            color="secondary"
                            onClick={() => handleWaitlistAction(entry.email, 'pending')}
                          >
                            Revoke
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </TableContainer>
      </TabPanel>
    </Box>
  );
} 
