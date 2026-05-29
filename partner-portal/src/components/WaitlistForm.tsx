import { useState } from 'react';
import {
  Box,
  Typography,
  TextField,
  Button,
  Grid,
  Alert,
  Chip,
  Checkbox,
  FormControlLabel,
  IconButton,
} from '@mui/material';
import { Close as CloseIcon } from '@mui/icons-material';
import axios from 'axios';
import { buildApiUrl } from '../config';

interface WaitlistFormProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function WaitlistForm({ isOpen, onClose }: WaitlistFormProps) {
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [requestReport, setRequestReport] = useState(false);
  const [useCaseCategories, setUseCaseCategories] = useState<string[]>([]);
  const [useCaseDescription, setUseCaseDescription] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsSubmitting(true);

    try {
      const useCaseInfo = {
        fullName,
        phoneNumber,
        companyName,
        requestReport,
        categories: useCaseCategories,
        description: useCaseDescription,
      };

      await axios.post(buildApiUrl('/api/waitlist'), {
        email,
        useCaseInfo: JSON.stringify(useCaseInfo),
      });
      setSubmitted(true);
    } catch (err) {
      setError('Failed to join waitlist. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const toggleCategory = (category: string) => {
    setUseCaseCategories((prev) =>
      prev.includes(category) ? prev.filter((c) => c !== category) : [...prev, category]
    );
  };

  return (
    <Box
      id="waitlist-section"
      sx={{
        position: 'fixed',
        bottom: 0,
        left: 0,
        right: 0,
        bgcolor: 'background.paper',
        boxShadow: '0 -2px 10px rgba(0,0,0,0.1)',
        zIndex: 1000,
        transition: 'transform 0.3s ease-in-out',
        transform: isOpen ? 'translateY(0)' : 'translateY(100%)',
      }}
    >
      <Box sx={{ maxWidth: 1200, mx: 'auto', p: 3 }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
          <Typography variant="h6" sx={{ fontWeight: 'bold' }}>
            Join the Waitlist
          </Typography>
          <IconButton onClick={onClose}>
            <CloseIcon />
          </IconButton>
        </Box>
        {submitted ? (
          <Alert severity="success" sx={{ mb: 2 }}>
            Thanks for joining our waitlist! We'll notify you when you're invited.
          </Alert>
        ) : (
          <form onSubmit={handleSubmit}>
            {error && (
              <Alert severity="error" sx={{ mb: 2 }}>
                {error}
              </Alert>
            )}
            <Grid container spacing={2}>
              <Grid item xs={12} sm={6}>
                <TextField
                  fullWidth
                  required
                  label="Full Name"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  variant="outlined"
                />
              </Grid>
              <Grid item xs={12} sm={6}>
                <TextField
                  fullWidth
                  label="Phone Number (Optional)"
                  value={phoneNumber}
                  onChange={(e) => setPhoneNumber(e.target.value)}
                  variant="outlined"
                />
              </Grid>
              <Grid item xs={12} sm={6}>
                <TextField
                  fullWidth
                  required
                  label="Company Name"
                  value={companyName}
                  onChange={(e) => setCompanyName(e.target.value)}
                  variant="outlined"
                />
              </Grid>
              <Grid item xs={12} sm={6}>
                <TextField
                  fullWidth
                  required
                  label="Email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  variant="outlined"
                />
              </Grid>
              <Grid item xs={12}>
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={requestReport}
                      onChange={(e) => setRequestReport(e.target.checked)}
                    />
                  }
                  label="Request a competition landscape report for my company (FREE)"
                />
              </Grid>
              <Grid item xs={12}>
                <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1 }}>
                  How do you plan to use AgentWeb? (Select all that apply)
                </Typography>
                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                  {[
                    'Market Research',
                    'Campaign Management',
                    'Performance Tracking',
                    'Social Media Management',
                    'Competitor Analysis',
                    'Budget Optimization',
                    'Other',
                  ].map((category) => (
                    <Chip
                      key={category}
                      label={category}
                      onClick={() => toggleCategory(category)}
                      color={useCaseCategories.includes(category) ? 'primary' : 'default'}
                      sx={{
                        cursor: 'pointer',
                        '&:hover': {
                          bgcolor: useCaseCategories.includes(category)
                            ? 'primary.light'
                            : 'action.hover',
                        },
                      }}
                    />
                  ))}
                </Box>
              </Grid>
              <Grid item xs={12}>
                <TextField
                  fullWidth
                  multiline
                  rows={3}
                  label="Please describe your use case in more detail (helps us prioritize)"
                  value={useCaseDescription}
                  onChange={(e) => setUseCaseDescription(e.target.value)}
                  variant="outlined"
                />
              </Grid>
              <Grid item xs={12}>
                <Button
                  type="submit"
                  variant="contained"
                  color="primary"
                  size="large"
                  fullWidth
                  disabled={isSubmitting}
                >
                  {isSubmitting ? 'Submitting...' : 'Join Waitlist'}
                </Button>
              </Grid>
            </Grid>
          </form>
        )}
      </Box>
    </Box>
  );
}
