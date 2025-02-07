import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Box,
  Paper,
  Typography,
  Button,
  IconButton,
  Tabs,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Chip
} from '@mui/material';
import {
  Timeline,
  TimelineItem,
  TimelineSeparator,
  TimelineConnector,
  TimelineContent,
  TimelineDot,
  TimelineOppositeContent
} from '@mui/lab';

import {
  ArrowBack as ArrowBackIcon,
  Edit as EditIcon,
  PlayArrow as RunIcon,
  CheckCircle as SuccessIcon,
  Error as ErrorIcon,
  Schedule as PendingIcon,
  AccessTime as DurationIcon
} from '@mui/icons-material';

interface WorkflowExecution {
  id: string;
  startTime: string;
  endTime?: string;
  status: 'success' | 'failed' | 'running' | 'pending';
  duration: string;
  tasks: {
    id: string;
    name: string;
    status: 'success' | 'failed' | 'running' | 'pending';
    startTime: string;
    endTime?: string;
    error?: string;
  }[];
}

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
      {...other}
    >
      {value === index && (
        <Box sx={{ p: 3 }}>
          {children}
        </Box>
      )}
    </div>
  );
}

export default function WorkflowDetails() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [tabValue, setTabValue] = useState(0);
  const [workflow, setWorkflow] = useState({
    id: '',
    name: '',
    description: '',
    status: 'active' as const
  });
  const [executions, setExecutions] = useState<WorkflowExecution[]>([]);

  useEffect(() => {
    // TODO: Fetch workflow and execution data from API
    const mockWorkflow = {
      id: id || '',
      name: 'Sample Workflow',
      description: 'A sample workflow description',
      status: 'active' as const
    };

    const mockExecutions: WorkflowExecution[] = [
      {
        id: '1',
        startTime: '2024-02-06T10:00:00',
        endTime: '2024-02-06T10:05:00',
        status: 'success',
        duration: '5m',
        tasks: [
          {
            id: 't1',
            name: 'Task 1',
            status: 'success',
            startTime: '2024-02-06T10:00:00',
            endTime: '2024-02-06T10:02:00'
          },
          {
            id: 't2',
            name: 'Task 2',
            status: 'success',
            startTime: '2024-02-06T10:02:00',
            endTime: '2024-02-06T10:05:00'
          }
        ]
      },
      // Add more mock executions as needed
    ];

    setWorkflow(mockWorkflow);
    setExecutions(mockExecutions);
  }, [id]);

  const handleTabChange = (event: React.SyntheticEvent, newValue: number) => {
    setTabValue(newValue);
  };

  const getChipColor = (status: string): 'success' | 'error' | 'info' | 'default' => {
    switch (status) {
      case 'success':
        return 'success';
      case 'failed':
        return 'error';
      case 'running':
        return 'info';
      default:
        return 'default';
    }
  };

  const getTimelineDotColor = (status: string): 'success' | 'error' | 'primary' | 'secondary' => {
    switch (status) {
      case 'success':
        return 'success';
      case 'failed':
        return 'error';
      case 'running':
        return 'primary';
      default:
        return 'secondary';
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'success':
        return <SuccessIcon fontSize="small" />;
      case 'failed':
        return <ErrorIcon fontSize="small" />;
      case 'running':
      case 'pending':
        return <PendingIcon fontSize="small" />;
      default:
        return undefined;
    }
  };

  return (
    <Box sx={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <Paper sx={{ p: 2, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <IconButton onClick={() => navigate('/workflows')}>
            <ArrowBackIcon />
          </IconButton>
          <Box>
            <Typography variant="h6">{workflow.name}</Typography>
            <Typography variant="body2" color="text.secondary">
              {workflow.description}
            </Typography>
          </Box>
        </Box>
        <Box sx={{ display: 'flex', gap: 1 }}>
          <Button
            variant="contained"
            startIcon={<RunIcon />}
            onClick={() => {/* TODO: Implement run workflow */}}
          >
            Run Now
          </Button>
          <Button
            variant="outlined"
            startIcon={<EditIcon />}
            onClick={() => navigate(`/workflows/${id}/edit`)}
          >
            Edit
          </Button>
        </Box>
      </Paper>

      {/* Tabs */}
      <Box sx={{ borderBottom: 1, borderColor: 'divider' }}>
        <Tabs value={tabValue} onChange={handleTabChange}>
          <Tab label="Executions" />
          <Tab label="Tasks" />
          <Tab label="Settings" />
        </Tabs>
      </Box>

      {/* Executions Tab */}
      <TabPanel value={tabValue} index={0}>
        <TableContainer component={Paper}>
          <Table>
            <TableHead>
              <TableRow>
                <TableCell>Execution ID</TableCell>
                <TableCell>Start Time</TableCell>
                <TableCell>Duration</TableCell>
                <TableCell>Status</TableCell>
                <TableCell>Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {executions.map((execution) => (
                <TableRow key={execution.id}>
                  <TableCell>{execution.id}</TableCell>
                  <TableCell>{new Date(execution.startTime).toLocaleString()}</TableCell>
                  <TableCell>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      <DurationIcon fontSize="small" />
                      {execution.duration}
                    </Box>
                  </TableCell>
                  <TableCell>
                    <Chip
                      label={execution.status}
                      color={getChipColor(execution.status)}
                      size="small"
                      icon={getStatusIcon(execution.status)}
                    />
                  </TableCell>
                  <TableCell>
                    <Button size="small" onClick={() => setTabValue(1)}>
                      View Details
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      </TabPanel>

      {/* Tasks Tab */}
      <TabPanel value={tabValue} index={1}>
        {executions[0] && (
          <Timeline>
            {executions[0].tasks.map((task, index) => (
              <TimelineItem key={task.id}>
                <TimelineOppositeContent color="text.secondary">
                  {new Date(task.startTime).toLocaleString()}
                </TimelineOppositeContent>
                <TimelineSeparator>
                  <TimelineDot color={getTimelineDotColor(task.status)}>
                    {getStatusIcon(task.status)}
                  </TimelineDot>
                  {index < executions[0].tasks.length - 1 && <TimelineConnector />}
                </TimelineSeparator>
                <TimelineContent>
                  <Typography variant="h6" component="span">
                    {task.name}
                  </Typography>
                  <Typography>Status: {task.status}</Typography>
                  {task.error && (
                    <Typography color="error">{task.error}</Typography>
                  )}
                </TimelineContent>
              </TimelineItem>
            ))}
          </Timeline>
        )}
      </TabPanel>

      {/* Settings Tab */}
      <TabPanel value={tabValue} index={2}>
        {/* TODO: Add workflow settings */}
        <Typography>Workflow settings coming soon...</Typography>
      </TabPanel>
    </Box>
  );
} 