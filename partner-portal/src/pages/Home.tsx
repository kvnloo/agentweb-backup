import { useState, useEffect } from 'react';
import {
  Box,
  Container,
  Typography,
  Button,
  Paper,
  Grid,
  Stack,
  Link,
  Toolbar,
  Chip,
  IconButton,
  Drawer,
  List,
  ListItem,
  useMediaQuery,
  useTheme
} from '@mui/material';
import { Link as RouterLink, useLocation } from 'react-router-dom';
import {
  Bolt as BoltIcon,
  Security as SecurityIcon,
  AutoGraph as AutoGraphIcon,
  IntegrationInstructions as IntegrationIcon,
  SmartToy as SmartToyIcon,
  Category as CategoryIcon,
  Close as CloseIcon,
  Menu as MenuIcon,
} from '@mui/icons-material';
import WaitlistForm from '../components/WaitlistForm';
import logo from '../assets/logo.svg';
import margenticLogo from '../assets/partners/logo-margentic.png';
import havnlyLogo from '../assets/partners/logo-havnly.png';
import ai2030Logo from '../assets/partners/logo-ai2030.png';
import storyWithAiLogo from '../assets/partners/logo-storywithai.png';
import facetoonLogo from '../assets/partners/logo-facetoon.png';
import awsLogo from '../assets/partners/logo-aws.png';
import azureLogo from '../assets/partners/logo-azure.png';
import googleCloudLogo from '../assets/partners/logo-google-cloud.png';
import ag2Logo from '../assets/partners/logo-ag2.png';

export default function Home() {
  const location = useLocation();
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('md'));
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [isWaitlistOpen, setIsWaitlistOpen] = useState(false);

  useEffect(() => {
    if (location.state?.openWaitlist) {
      setIsWaitlistOpen(true);
      // Clear the state to prevent reopening on refresh
      window.history.replaceState({}, document.title);
    }
  }, [location.state]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const waitlistSection = document.getElementById('waitlist-section');
      if (waitlistSection && !waitlistSection.contains(event.target as Node)) {
        setIsWaitlistOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

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
                fontSize: { xs: '1.25rem', sm: '1.5rem' },
                display: 'flex',
                alignItems: 'center',
                gap: 1
              }}
            >
              <Link
                component={RouterLink}
                to="/"
                color="inherit"
                underline="none"
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 1
                }}
              >
                <img src={logo} alt="AgentWeb Logo" style={{ height: 32, width: 32 }} />
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  AgentWeb
                  <Typography
                    component="span"
                    sx={{
                      fontSize: '0.9rem',
                      fontWeight: 500,
                      opacity: 0.9,
                      ml: 1,
                      display: { xs: 'none', sm: 'block' }
                    }}
                  >
                    Your Marketing Operator 24/7
                  </Typography>
                </Box>
              </Link>
            </Typography>
            
            {isMobile ? (
              <IconButton
                edge="end"
                color="inherit"
                aria-label="menu"
                onClick={() => setMobileMenuOpen(true)}
                sx={{ ml: 2 }}
              >
                <MenuIcon />
              </IconButton>
            ) : (
              <Stack
                direction="row"
                spacing={3}
                alignItems="center"
              >
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
                  color="primary"
                  onClick={() => scrollToSection('partners')}
                >
                  Customers & Partners
                </Button>
                <Button
                  variant="contained"
                  onClick={() => setIsWaitlistOpen(true)}
                  sx={{ 
                    boxShadow: 'none',
                    '&:hover': { boxShadow: 'none' }
                  }}
                >
                  Join Waitlist
                </Button>
              </Stack>
            )}
          </Toolbar>
        </Container>
      </Box>

      <Drawer
        anchor="right"
        open={mobileMenuOpen}
        onClose={() => setMobileMenuOpen(false)}
        sx={{
          '& .MuiDrawer-paper': {
            width: 250,
            boxSizing: 'border-box',
            backgroundColor: theme.palette.background.paper,
          },
        }}
      >
        <Box sx={{ width: 250, pt: 2 }}>
          <List>
            <ListItem>
              <Button 
                onClick={() => {
                  scrollToSection('features');
                  setMobileMenuOpen(false);
                }}
                color="inherit"
                fullWidth
                sx={{ justifyContent: 'flex-start' }}
              >
                Features
              </Button>
            </ListItem>
            <ListItem>
              <Button 
                onClick={() => {
                  scrollToSection('use-cases');
                  setMobileMenuOpen(false);
                }}
                color="inherit"
                fullWidth
                sx={{ justifyContent: 'flex-start' }}
              >
                Use Cases
              </Button>
            </ListItem>
            <ListItem>
              <Button 
                onClick={() => {
                  scrollToSection('partners');
                  setMobileMenuOpen(false);
                }}
                color="inherit"
                fullWidth
                sx={{ justifyContent: 'flex-start' }}
              >
                Customers & Partners
              </Button>
            </ListItem>
            <ListItem>
              <Button 
                onClick={() => {
                  setIsWaitlistOpen(true);
                  setMobileMenuOpen(false);
                }}
                variant="contained"
                fullWidth
                sx={{ justifyContent: 'flex-start' }}
              >
                Join Waitlist
              </Button>
            </ListItem>
          </List>
        </Box>
      </Drawer>

      <Box sx={{ height: '32px' }} />

      <Box id="hero" sx={{ 
        background: 'linear-gradient(45deg, #1a237e 30%, #0d47a1 90%)',
        color: 'white',
        pt: { xs: 4, sm: 6 },
        pb: { xs: 4, sm: 6 },
        width: '100%'
      }}>
        <Container maxWidth="lg" sx={{ px: { xs: 2, sm: 3 } }}>
          <Grid container spacing={4} alignItems="center" justifyContent="center">
            <Grid item xs={12} md={7}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 4 }}>
                <img src={logo} alt="AgentWeb Logo" style={{ height: 64, width: 64 }} />
                <Typography
                  variant="h1"
                  sx={{
                    fontWeight: 800,
                    fontSize: { xs: '2.5rem', sm: '3.5rem', md: '4rem' },
                    display: 'flex',
                    alignItems: 'center',
                    gap: 2
                  }}
                >
                  AgentWeb
                  <Chip
                    label="BETA"
                    sx={{
                      bgcolor: 'rgba(255, 255, 255, 0.15)',
                      color: 'white',
                      fontSize: { xs: '1rem', sm: '1.25rem' },
                      height: 'auto',
                      py: 0.5,
                      px: 1,
                      fontWeight: 600
                    }}
                  />
                </Typography>
              </Box>
              <Typography
                variant="h2"
                sx={{
                  mb: 3,
                  fontWeight: 800,
                  fontSize: { xs: '2rem', sm: '2.5rem', md: '3rem' },
                }}
              >
                End-to-End Online Marketing Automation for SMBs and Startups
              </Typography>
              <Typography
                variant="h5"
                sx={{
                  mb: 4,
                  fontWeight: 400,
                  opacity: 0.9,
                  fontSize: { xs: '1.25rem', sm: '1.5rem' }
                }}
              >
                Transform your marketing operations with AI-powered automation. From market research to campaign execution and performance tracking, AgentWeb handles it all.
              </Typography>

              <Grid container spacing={3} sx={{ mb: 2 }}>
                <Grid item xs={6}>
                  <Paper 
                    elevation={0}
                    sx={{ 
                      p: 3,
                      height: '100%',
                      bgcolor: 'rgba(255, 255, 255, 0.1)',
                      color: 'white',
                      textAlign: 'center',
                      borderRadius: 2,
                      backdropFilter: 'blur(8px)'
                    }}
                  >
                    <Typography variant="h2" sx={{ fontWeight: 800, mb: 1 }}>
                      10x
                    </Typography>
                    <Typography variant="h6">
                      Cost Reduction
                    </Typography>
                    <Typography variant="body2" sx={{ mt: 1, opacity: 0.9 }}>
                      Reduce marketing operation costs through automation
                    </Typography>
                  </Paper>
                </Grid>
                <Grid item xs={6}>
                  <Paper 
                    elevation={0}
                    sx={{ 
                      p: 3,
                      height: '100%',
                      bgcolor: 'rgba(255, 255, 255, 0.1)',
                      color: 'white',
                      textAlign: 'center',
                      borderRadius: 2,
                      backdropFilter: 'blur(8px)'
                    }}
                  >
                    <Typography variant="h2" sx={{ fontWeight: 800, mb: 1 }}>
                      3x
                    </Typography>
                    <Typography variant="h6">
                      Performance Boost
                    </Typography>
                    <Typography variant="body2" sx={{ mt: 1, opacity: 0.9 }}>
                      Improve campaign performance with AI optimization
                    </Typography>
                  </Paper>
                </Grid>
              </Grid>

              <Button
                variant="contained"
                size="large"
                onClick={() => setIsWaitlistOpen(true)}
                sx={{ 
                  bgcolor: 'primary.main',
                  color: 'white',
                  px: 6,
                  py: 2,
                  fontSize: '1.2rem',
                  fontWeight: 600,
                  borderRadius: 2,
                  boxShadow: '0 4px 14px rgba(0,0,0,0.2)',
                  '&:hover': {
                    bgcolor: 'primary.dark',
                    boxShadow: '0 6px 20px rgba(0,0,0,0.25)',
                    transform: 'translateY(-2px)'
                  },
                  transition: 'all 0.3s ease'
                }}
              >
                Click to Join Waitlist
              </Button>
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
            Key Features
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
                <AutoGraphIcon sx={{ fontSize: 48, color: 'primary.main', mb: 2 }} />
                <Typography variant="h5" gutterBottom fontWeight={600}>
                  Market Research
                </Typography>
                <Typography variant="body1" color="text.secondary">
                  Automated competitor analysis, creative strategy research, and omni-channel social listening.
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
                  Campaign Builder
                </Typography>
                <Typography variant="body1" color="text.secondary">
                  One-click campaign setup with automated audience targeting and budget optimization.
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
                  KPI Tracker
                </Typography>
                <Typography variant="body1" color="text.secondary">
                  Real-time performance monitoring with automated alerts and centralized dashboard.
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
                <SmartToyIcon sx={{ fontSize: 48, color: 'primary.main', mb: 2 }} />
                <Typography variant="h5" gutterBottom fontWeight={600}>
                  AI Playbooks
                </Typography>
                <Typography variant="body1" color="text.secondary">
                  Expert-built marketing workflows with task-specific AI optimization.
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
                <IntegrationIcon sx={{ fontSize: 48, color: 'primary.main', mb: 2 }} />
                <Typography variant="h5" gutterBottom fontWeight={600}>
                  Platform Integration
                </Typography>
                <Typography variant="body1" color="text.secondary">
                  Connect with major marketing platforms and tools without coding.
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
                <CategoryIcon sx={{ fontSize: 48, color: 'primary.main', mb: 2 }} />
                <Typography variant="h5" gutterBottom fontWeight={600}>
                  Smart Templates
                </Typography>
                <Typography variant="body1" color="text.secondary">
                  Pre-configured marketing workflows with customizable parameters.
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
          Marketing Automation Use Cases
        </Typography>
        <Grid container spacing={4} justifyContent="center">
          <Grid item xs={12} md={6} lg={4}>
            <Paper sx={{ p: 3 }}>
              <Typography variant="h6" gutterBottom color="primary">
                Competitor Analysis
              </Typography>
              <Typography variant="body1" paragraph>
                Automated research on competitor strategies, creative approaches, and market positioning.
              </Typography>
            </Paper>
          </Grid>
          <Grid item xs={12} md={6} lg={4}>
            <Paper sx={{ p: 3 }}>
              <Typography variant="h6" gutterBottom color="primary">
                Campaign Setup
              </Typography>
              <Typography variant="body1" paragraph>
                One-click campaign creation with optimized targeting and budget allocation.
              </Typography>
            </Paper>
          </Grid>
          <Grid item xs={12} md={6} lg={4}>
            <Paper sx={{ p: 3 }}>
              <Typography variant="h6" gutterBottom color="primary">
                Performance Tracking
              </Typography>
              <Typography variant="body1" paragraph>
                Real-time KPI monitoring with automated alerts and reporting.
              </Typography>
            </Paper>
          </Grid>
          <Grid item xs={12} md={6} lg={4}>
            <Paper sx={{ p: 3 }}>
              <Typography variant="h6" gutterBottom color="primary">
                Social Listening
              </Typography>
              <Typography variant="body1" paragraph>
                Automated monitoring of brand mentions and industry trends across platforms.
              </Typography>
            </Paper>
          </Grid>
          <Grid item xs={12} md={6} lg={4}>
            <Paper sx={{ p: 3 }}>
              <Typography variant="h6" gutterBottom color="primary">
                Creative Research
              </Typography>
              <Typography variant="body1" paragraph>
                AI-powered analysis of creative strategies and content performance.
              </Typography>
            </Paper>
          </Grid>
          <Grid item xs={12} md={6} lg={4}>
            <Paper sx={{ p: 3 }}>
              <Typography variant="h6" gutterBottom color="primary">
                Budget Optimization
              </Typography>
              <Typography variant="body1" paragraph>
                Automated budget allocation and performance-based adjustments.
              </Typography>
            </Paper>
          </Grid>
        </Grid>
      </Container>

      {/* Partners Section */}
      <Box id="partners" sx={{ 
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
            Valued Partners/Customers
          </Typography>
          <Grid container spacing={4} justifyContent="center" alignItems="center">
            <Grid item xs={12} md={4}>
              <Box sx={{ 
                display: 'flex', 
                justifyContent: 'center',
                alignItems: 'center',
                height: '100%'
              }}>
                <Link
                  href="https://margentic.com/"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Box
                    component="img"
                    src={margenticLogo} 
                    alt="Margentic AI" 
                    sx={{ 
                      maxWidth: '200px',
                      height: 'auto',
                      opacity: 0.8,
                      transition: 'opacity 0.3s ease',
                      '&:hover': {
                        opacity: 1
                      }
                    }}
                  />
                </Link>
              </Box>
            </Grid>
            <Grid item xs={12} md={4}>
              <Box sx={{ 
                display: 'flex', 
                justifyContent: 'center',
                alignItems: 'center',
                height: '100%'
              }}>
                <Link
                  href="https://havnly.ai/"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Box
                    component="img"
                    src={havnlyLogo} 
                    alt="Havnly AI" 
                    sx={{ 
                      maxWidth: '200px',
                      height: 'auto',
                      opacity: 0.8,
                      transition: 'opacity 0.3s ease',
                      '&:hover': {
                        opacity: 1
                      }
                    }}
                  />
                </Link>
              </Box>
            </Grid>
            <Grid item xs={12} md={4}>
              <Box sx={{ 
                display: 'flex', 
                justifyContent: 'center',
                alignItems: 'center',
                height: '100%'
              }}>
                <Link
                  href="https://ai2030.org/"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Box
                    component="img"
                    src={ai2030Logo} 
                    alt="AI 2030" 
                    sx={{ 
                      maxWidth: '200px',
                      height: 'auto',
                      opacity: 0.8,
                      transition: 'opacity 0.3s ease',
                      '&:hover': {
                        opacity: 1
                      }
                    }}
                  />
                </Link>
              </Box>
            </Grid>
            <Grid item xs={12} md={4}>
              <Box sx={{ 
                display: 'flex', 
                justifyContent: 'center',
                alignItems: 'center',
                height: '100%'
              }}>
                <Link
                  href="https://storywithai.info/"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Box
                    component="img"
                    src={storyWithAiLogo} 
                    alt="StoryWithAI" 
                    sx={{ 
                      maxWidth: '200px',
                      height: 'auto',
                      opacity: 0.8,
                      transition: 'opacity 0.3s ease',
                      '&:hover': {
                        opacity: 1
                      }
                    }}
                  />
                </Link>
              </Box>
            </Grid>
            <Grid item xs={12} md={4}>
              <Box sx={{ 
                display: 'flex', 
                justifyContent: 'center',
                alignItems: 'center',
                height: '100%'
              }}>
                <Link
                  href="https://facetoonshop.com/"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Box
                    component="img"
                    src={facetoonLogo} 
                    alt="Facetoon" 
                    sx={{ 
                      maxWidth: '200px',
                      height: 'auto',
                      opacity: 0.8,
                      transition: 'opacity 0.3s ease',
                      '&:hover': {
                        opacity: 1
                      }
                    }}
                  />
                </Link>
              </Box>
            </Grid>
            <Grid item xs={12} md={4}>
              <Box sx={{ 
                display: 'flex', 
                justifyContent: 'center',
                alignItems: 'center',
                height: '100%'
              }}>
                <Link
                  href="https://aws.amazon.com/"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Box
                    component="img"
                    src={awsLogo} 
                    alt="AWS" 
                    sx={{ 
                      maxWidth: '200px',
                      height: 'auto',
                      opacity: 0.8,
                      transition: 'opacity 0.3s ease',
                      '&:hover': {
                        opacity: 1
                      }
                    }}
                  />
                </Link>
              </Box>
            </Grid>
            <Grid item xs={12} md={4}>
              <Box sx={{ 
                display: 'flex', 
                justifyContent: 'center',
                alignItems: 'center',
                height: '100%'
              }}>
                <Link
                  href="https://azure.microsoft.com/"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Box
                    component="img"
                    src={azureLogo} 
                    alt="Azure" 
                    sx={{ 
                      maxWidth: '200px',
                      height: 'auto',
                      opacity: 0.8,
                      transition: 'opacity 0.3s ease',
                      '&:hover': {
                        opacity: 1
                      }
                    }}
                  />
                </Link>
              </Box>
            </Grid>
            <Grid item xs={12} md={4}>
              <Box sx={{ 
                display: 'flex', 
                justifyContent: 'center',
                alignItems: 'center',
                height: '100%'
              }}>
                <Link
                  href="https://cloud.google.com/"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Box
                    component="img"
                    src={googleCloudLogo} 
                    alt="Google Cloud" 
                    sx={{ 
                      maxWidth: '200px',
                      height: 'auto',
                      opacity: 0.8,
                      transition: 'opacity 0.3s ease',
                      '&:hover': {
                        opacity: 1
                      }
                    }}
                  />
                </Link>
              </Box>
            </Grid>
            <Grid item xs={12} md={4}>
              <Box sx={{ 
                display: 'flex', 
                justifyContent: 'center',
                alignItems: 'center',
                height: '100%'
              }}>
                <Link
                  href="https://ag2.ai/"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Box
                    component="img"
                    src={ag2Logo} 
                    alt="AG2.ai" 
                    sx={{ 
                      maxWidth: '200px',
                      height: 'auto',
                      opacity: 0.8,
                      transition: 'opacity 0.3s ease',
                      '&:hover': {
                        opacity: 1
                      }
                    }}
                  />
                </Link>
              </Box>
            </Grid>
          </Grid>
        </Container>
      </Box>

      {/* Final CTA Section */}
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
            onClick={() => setIsWaitlistOpen(true)}
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

      <WaitlistForm isOpen={isWaitlistOpen} onClose={() => setIsWaitlistOpen(false)} />
    </Box>
  );
} 