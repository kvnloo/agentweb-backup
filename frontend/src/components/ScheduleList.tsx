import React, { useState, useEffect } from 'react';
import {
  Box,
  Typography,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Paper,
  IconButton,
  Switch,
  Alert,
  Button
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import axios from 'axios';

interface Schedule {
  scheduleId: string;
  taskId: string;
  frequency: string;
  status: string;
  nextRunTime: string;
  createdAt: string;
}

interface ScheduleListProps {
  taskId: string;
  onScheduleUpdated?: () => void;
}

export default function ScheduleList({ taskId, onScheduleUpdated }: ScheduleListProps) {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const fetchSchedules = async () => {
    try {
      const response = await axios.get(
        `http://localhost:3001/api/schedules/task/${taskId}`,
        {
          headers: {
            'Authorization': `Bearer ${localStorage.getItem('token')}`
          }
        }
      );
      setSchedules(response.data);
      setError('');
    } catch (err: any) {
      console.error('Error fetching schedules:', err);
      setError(err.response?.data?.error || 'Failed to load schedules');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSchedules();
  }, [taskId]);

  const handleStatusToggle = async (scheduleId: string, currentStatus: string) => {
    try {
      await axios.put(
        `http://localhost:3001/api/schedules/${scheduleId}`,
        {
          status: currentStatus === 'active' ? 'paused' : 'active'
        },
        {
          headers: {
            'Authorization': `Bearer ${localStorage.getItem('token')}`
          }
        }
      );
      await fetchSchedules();
      onScheduleUpdated?.();
      setError('');
    } catch (err: any) {
      console.error('Error updating schedule status:', err);
      setError(err.response?.data?.error || 'Failed to update schedule status');
    }
  };

  const handleDelete = async (scheduleId: string) => {
    try {
      await axios.delete(
        `http://localhost:3001/api/schedules/${scheduleId}`,
        {
          headers: {
            'Authorization': `Bearer ${localStorage.getItem('token')}`
          }
        }
      );
      await fetchSchedules();
      onScheduleUpdated?.();
      setError('');
    } catch (err: any) {
      console.error('Error deleting schedule:', err);
      setError(err.response?.data?.error || 'Failed to delete schedule');
    }
  };

  if (loading) {
    return <Typography>Loading schedules...</Typography>;
  }

  if (error) {
    return (
      <Box sx={{ mt: 2 }}>
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
        <Button variant="outlined" onClick={fetchSchedules}>
          Retry
        </Button>
      </Box>
    );
  }

  if (schedules.length === 0) {
    return <Typography sx={{ mt: 2 }}>No schedules found</Typography>;
  }

  return (
    <Box sx={{ mt: 3 }}>
      <Typography variant="h6" gutterBottom>
        Schedules
      </Typography>
      <TableContainer component={Paper}>
        <Table>
          <TableHead>
            <TableRow>
              <TableCell>Frequency</TableCell>
              <TableCell>Next Run</TableCell>
              <TableCell>Status</TableCell>
              <TableCell>Created</TableCell>
              <TableCell>Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {schedules.map((schedule) => (
              <TableRow key={schedule.scheduleId}>
                <TableCell>{schedule.frequency}</TableCell>
                <TableCell>
                  {new Date(schedule.nextRunTime).toLocaleString()}
                </TableCell>
                <TableCell>
                  <Switch
                    checked={schedule.status === 'active'}
                    onChange={() => handleStatusToggle(schedule.scheduleId, schedule.status)}
                    color="primary"
                  />
                </TableCell>
                <TableCell>
                  {new Date(schedule.createdAt).toLocaleString()}
                </TableCell>
                <TableCell>
                  <IconButton
                    onClick={() => handleDelete(schedule.scheduleId)}
                    color="error"
                    size="small"
                  >
                    <DeleteIcon />
                  </IconButton>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Box>
  );
} 