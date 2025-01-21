import { useState } from 'react';
import {
  Box,
  Container,
  Typography,
  TextField,
  Button,
  Paper,
  Grid,
  Alert,
  Chip,
  List,
  ListItem,
  ListItemIcon,
  ListItemText,
  Divider,
  Stack,
  Link,
  Toolbar,
} from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';
import {
  AutoAwesome as AutoAwesomeIcon,
  Speed as SpeedIcon,
  Lock as LockIcon,
  Check as CheckIcon,
  Code as CodeIcon,
  Psychology as PsychologyIcon,
  Timer as TimerIcon,
  Bolt as BoltIcon,
  Security as SecurityIcon,
} from '@mui/icons-material';
import axios from 'axios';

export default function Home() {
  const [email, setEmail] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    
    try {
      await axios.post('http://localhost:3001/api/waitlist', { email });
      setSubmitted(true);
    } catch (err) {
      setError('Failed to join waitlist. Please try again.');
    }
  };

  const scrollToSection = (id: string) => {
    const element = document.getElementById(id);
    if (element) {
      element.scrollIntoView({ behavior: 'smooth' });
    }
  };

  return (
    <Box sx={{ bgcolor: 'background.default' }}>
      <Box sx={{ 
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bgcolor: 'rgba(255, 255, 255, 0.9)',
        backdropFilter: 'blur(8px)',
        borderBottom: '1px solid',
        borderColor: 'divider',
        zIndex: 1000,
      }}>
        <Container maxWidth="lg">
          <Toolbar sx={{ 
            px: { xs: 0 },
            display: 'flex',
            justifyContent: 'space-between'
          }}>
            <Typography 
              variant="h6" 
              component="div" 
              sx={{ 
                color: 'primary.main',
                fontWeight: 600,
                fontSize: { xs: '1.25rem', sm: '1.5rem' }
              }}
            >
              <Link
                component={RouterLink}
                to="/"
                color="inherit"
                underline="none"
              >
                AgentWeb
              </Link>
            </Typography>
            <Stack
              direction="row"
              spacing={3}
              alignItems="center"
            >
              <Button
                color="primary"
                onClick={() => scrollToSection('benefits')}
              >
                Benefits
              </Button>
              <Button
                color="primary"
                onClick={() => scrollToSection('features')}
              >
                Features
              </Button>
              <Button
                color="primary"
                onClick={() => scrollToSection('use-cases')}
              >
                Use Cases
              </Button>
              <Button
                variant="contained"
                onClick={() => scrollToSection('join')}
                sx={{ 
                  boxShadow: 'none',
                  '&:hover': { boxShadow: 'none' }
                }}
              >
                Join Waitlist
              </Button>
            </Stack>
          </Toolbar>
        </Container>
      </Box>

      <Box sx={{ height: '64px' }} />

      <Box id="hero" sx={{ 
        background: 'linear-gradient(45deg, #1a237e 30%, #0d47a1 90%)',
        color: 'white',
        pt: { xs: 8, sm: 12 },
        pb: { xs: 8, sm: 12 },
        width: '100%'
      }}>
        <Container maxWidth="lg" sx={{ px: { xs: 2, sm: 3 } }}>
          <Grid container spacing={4} alignItems="center" justifyContent="center">
            <Grid item xs={12} md={7}>
              <Typography
                variant="h1"
                sx={{
                  mb: 3,
                  fontWeight: 800,
                  fontSize: { xs: '2.5rem', sm: '3.5rem', md: '4rem' },
                }}
              >
                Transform Your Web Tasks with AI
              </Typography>
              <Typography
                variant="h5"
                sx={{ 
                  mb: 4,
                  opacity: 0.9,
                  fontSize: { xs: '1.2rem', sm: '1.5rem' }
                }}
              >
                Let our intelligent agents handle your web automation needs with simple natural language instructions.
              </Typography>

              {/* Waitlist Form */}
              <Paper 
                elevation={2}
                sx={{ 
                  p: 3,
                  maxWidth: 500,
                  bgcolor: 'background.paper',
                  borderRadius: 2
                }}
              >
                {submitted ? (
                  <Alert severity="success" sx={{ mb: 2 }}>
                    Thanks for joining our waitlist! We'll notify you when you're invited.
                  </Alert>
                ) : (
                  <Box component="form" onSubmit={handleSubmit}>
                    {error && (
                      <Alert severity="error" sx={{ mb: 2 }}>
                        {error}
                      </Alert>
                    )}
                    <Typography variant="h6" gutterBottom color="text.primary">
                      Join Waitlist
                    </Typography>
                    <Box sx={{ display: 'flex', gap: 1 }}>
                      <TextField
                        required
                        fullWidth
                        type="email"
                        placeholder="Enter your email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        sx={{ bgcolor: 'background.default' }}
                      />
                      <Button
                        type="submit"
                        variant="contained"
                        size="large"
                        sx={{ 
                          px: 3,
                          whiteSpace: 'nowrap',
                          bgcolor: 'primary.main',
                          '&:hover': {
                            bgcolor: 'primary.dark'
                          }
                        }}
                      >
                        Join Now
                      </Button>
                    </Box>
                  </Box>
                )}
              </Paper>
            </Grid>
            <Grid item xs={12} md={5} sx={{ display: { xs: 'none', md: 'block' } }}>
              <Box
                component="img"
                src="/automation-illustration.svg"
                alt="Web Automation Illustration"
                sx={{ width: '100%', maxWidth: 500 }}
              />
            </Grid>
          </Grid>
        </Container>
      </Box>

      <Container id="benefits" maxWidth="lg" sx={{ 
        py: { xs: 8, sm: 12 },
        px: { xs: 2, sm: 3 }
      }}>
        <Typography
          variant="h3"
          align="center"
          sx={{ mb: 6, fontWeight: 700 }}
        >
          Why Choose AgentWeb?
        </Typography>
        <Grid container spacing={4} justifyContent="center">
          <Grid item xs={12} md={6}>
            <List>
              <ListItem>
                <ListItemIcon>
                  <CheckIcon color="primary" />
                </ListItemIcon>
                <ListItemText 
                  primary="Natural Language Instructions" 
                  secondary="Simply describe what you want in plain English - no coding required"
                />
              </ListItem>
              <ListItem>
                <ListItemIcon>
                  <CheckIcon color="primary" />
                </ListItemIcon>
                <ListItemText 
                  primary="Advanced AI Technology" 
                  secondary="Powered by state-of-the-art language models for intelligent automation"
                />
              </ListItem>
              <ListItem>
                <ListItemIcon>
                  <CheckIcon color="primary" />
                </ListItemIcon>
                <ListItemText 
                  primary="Time-Saving Automation" 
                  secondary="Reduce manual work and focus on what matters most"
                />
              </ListItem>
            </List>
          </Grid>
          <Grid item xs={12} md={6}>
            <List>
              <ListItem>
                <ListItemIcon>
                  <CheckIcon color="primary" />
                </ListItemIcon>
                <ListItemText 
                  primary="Secure & Private" 
                  secondary="Enterprise-grade security with end-to-end encryption"
                />
              </ListItem>
              <ListItem>
                <ListItemIcon>
                  <CheckIcon color="primary" />
                </ListItemIcon>
                <ListItemText 
                  primary="24/7 Operation" 
                  secondary="Your automated tasks run reliably around the clock"
                />
              </ListItem>
              <ListItem>
                <ListItemIcon>
                  <CheckIcon color="primary" />
                </ListItemIcon>
                <ListItemText 
                  primary="Detailed Reporting" 
                  secondary="Track and monitor your automation performance"
                />
              </ListItem>
            </List>
          </Grid>
        </Grid>
      </Container>

      <Box id="features" sx={{ 
        bgcolor: 'grey.50', 
        py: { xs: 8, sm: 12 },
        width: '100%'
      }}>
        <Container maxWidth="lg" sx={{ px: { xs: 2, sm: 3 } }}>
          <Typography
            variant="h3"
            align="center"
            sx={{ mb: 6, fontWeight: 700 }}
          >
            Powerful Features
          </Typography>
          <Grid container spacing={4} justifyContent="center">
            <Grid item xs={12} md={4}>
              <Paper 
                sx={{ 
                  p: 4, 
                  height: '100%',
                  textAlign: 'center',
                  transition: 'transform 0.2s',
                  '&:hover': {
                    transform: 'translateY(-4px)'
                  }
                }}
              >
                <PsychologyIcon sx={{ fontSize: 48, color: 'primary.main', mb: 2 }} />
                <Typography variant="h5" gutterBottom fontWeight={600}>
                  AI-Powered Automation
                </Typography>
                <Typography variant="body1" color="text.secondary">
                  Our intelligent agents understand context and handle complex web tasks with ease.
                </Typography>
              </Paper>
            </Grid>
            <Grid item xs={12} md={4}>
              <Paper 
                sx={{ 
                  p: 4, 
                  height: '100%',
                  textAlign: 'center',
                  transition: 'transform 0.2s',
                  '&:hover': {
                    transform: 'translateY(-4px)'
                  }
                }}
              >
                <BoltIcon sx={{ fontSize: 48, color: 'primary.main', mb: 2 }} />
                <Typography variant="h5" gutterBottom fontWeight={600}>
                  Lightning Fast
                </Typography>
                <Typography variant="body1" color="text.secondary">
                  Execute tasks in minutes that would take hours to do manually.
                </Typography>
              </Paper>
            </Grid>
            <Grid item xs={12} md={4}>
              <Paper 
                sx={{ 
                  p: 4, 
                  height: '100%',
                  textAlign: 'center',
                  transition: 'transform 0.2s',
                  '&:hover': {
                    transform: 'translateY(-4px)'
                  }
                }}
              >
                <SecurityIcon sx={{ fontSize: 48, color: 'primary.main', mb: 2 }} />
                <Typography variant="h5" gutterBottom fontWeight={600}>
                  Enterprise Security
                </Typography>
                <Typography variant="body1" color="text.secondary">
                  Bank-grade encryption and security protocols protect your data.
                </Typography>
              </Paper>
            </Grid>
          </Grid>
        </Container>
      </Box>

      <Container id="use-cases" maxWidth="lg" sx={{ 
        py: { xs: 8, sm: 12 },
        px: { xs: 2, sm: 3 }
      }}>
        <Typography
          variant="h3"
          align="center"
          sx={{ mb: 6, fontWeight: 700 }}
        >
          What You Can Automate
        </Typography>
        <Grid container spacing={4} justifyContent="center">
          <Grid item xs={12} md={6} lg={4}>
            <Paper sx={{ p: 3 }}>
              <Typography variant="h6" gutterBottom color="primary">
                Data Collection
              </Typography>
              <Typography variant="body1" paragraph>
                Automatically gather data from websites, forms, and databases.
              </Typography>
            </Paper>
          </Grid>
          <Grid item xs={12} md={6} lg={4}>
            <Paper sx={{ p: 3 }}>
              <Typography variant="h6" gutterBottom color="primary">
                Form Automation
              </Typography>
              <Typography variant="body1" paragraph>
                Fill out web forms automatically with high accuracy.
              </Typography>
            </Paper>
          </Grid>
          <Grid item xs={12} md={6} lg={4}>
            <Paper sx={{ p: 3 }}>
              <Typography variant="h6" gutterBottom color="primary">
                Content Management
              </Typography>
              <Typography variant="body1" paragraph>
                Update and manage content across multiple platforms.
              </Typography>
            </Paper>
          </Grid>
          <Grid item xs={12} md={6} lg={4}>
            <Paper sx={{ p: 3 }}>
              <Typography variant="h6" gutterBottom color="primary">
                Monitoring & Alerts
              </Typography>
              <Typography variant="body1" paragraph>
                Monitor websites and receive alerts for changes.
              </Typography>
            </Paper>
          </Grid>
          <Grid item xs={12} md={6} lg={4}>
            <Paper sx={{ p: 3 }}>
              <Typography variant="h6" gutterBottom color="primary">
                Report Generation
              </Typography>
              <Typography variant="body1" paragraph>
                Create automated reports from web data sources.
              </Typography>
            </Paper>
          </Grid>
          <Grid item xs={12} md={6} lg={4}>
            <Paper sx={{ p: 3 }}>
              <Typography variant="h6" gutterBottom color="primary">
                Testing & QA
              </Typography>
              <Typography variant="body1" paragraph>
                Automate web testing and quality assurance tasks.
              </Typography>
            </Paper>
          </Grid>
        </Grid>
      </Container>

      <Box id="join" sx={{ 
        bgcolor: 'primary.main',
        color: 'white',
        py: { xs: 8, sm: 12 },
        textAlign: 'center',
        width: '100%'
      }}>
        <Container maxWidth="md" sx={{ px: { xs: 2, sm: 3 } }}>
          <Typography variant="h3" gutterBottom fontWeight={700}>
            Ready to Transform Your Workflow?
          </Typography>
          <Typography variant="h6" paragraph sx={{ mb: 4, opacity: 0.9 }}>
            Join our exclusive beta and be among the first to experience the future of web automation.
          </Typography>
          <Button
            variant="contained"
            size="large"
            onClick={() => {
              const form = document.querySelector('form');
              if (form) {
                form.scrollIntoView({ behavior: 'smooth' });
              }
            }}
            sx={{ 
              bgcolor: 'white',
              color: 'primary.main',
              px: 4,
              py: 1.5,
              fontSize: '1.1rem',
              '&:hover': {
                bgcolor: 'grey.100'
              }
            }}
          >
            Join the Waitlist Now
          </Button>
        </Container>
      </Box>
    </Box>
  );
} 