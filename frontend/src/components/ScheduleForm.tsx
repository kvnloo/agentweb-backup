import React, { useState } from 'react';
import {
  Box,
  Button,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Typography,
  SelectChangeEvent,
  Alert
} from '@mui/material';
import axios from 'axios';

interface ScheduleFormProps {
  taskId: string;
  onScheduleCreated?: () => void;
}

export default function ScheduleForm({ taskId, onScheduleCreated }: ScheduleFormProps) {
  const [frequency, setFrequency] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleFrequencyChange = (event: SelectChangeEvent) => {
    setFrequency(event.target.value);
    setError('');
    setSuccess('');
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    setSuccess('');
    setIsSubmitting(true);

    try {
      await axios.post('http://localhost:3001/api/schedules', {
        taskId,
        frequency
      }, {
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        }
      });

      setSuccess('Schedule created successfully');
      setFrequency('');
      console.log('Schedule created, calling onScheduleCreated callback');
      onScheduleCreated?.();
    } catch (err: any) {
      console.error('Error creating schedule:', err);
      setError(err.response?.data?.error || 'Failed to create schedule');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Box component="form" onSubmit={handleSubmit} sx={{ mt: 2 }}>
      <Typography variant="h6" gutterBottom>
        Schedule Task
      </Typography>
      
      <FormControl fullWidth sx={{ mb: 2 }}>
        <InputLabel id="frequency-label">Frequency</InputLabel>
        <Select
          labelId="frequency-label"
          value={frequency}
          label="Frequency"
          onChange={handleFrequencyChange}
          required
        >
          <MenuItem value="daily">Daily</MenuItem>
          <MenuItem value="weekly">Weekly</MenuItem>
          <MenuItem value="monthly">Monthly</MenuItem>
        </Select>
      </FormControl>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {success && (
        <Alert severity="success" sx={{ mb: 2 }}>
          {success}
        </Alert>
      )}

      <Button
        type="submit"
        variant="contained"
        disabled={isSubmitting}
        sx={{ mt: 1 }}
      >
        {isSubmitting ? 'Creating Schedule...' : 'Create Schedule'}
      </Button>
    </Box>
  );
} 