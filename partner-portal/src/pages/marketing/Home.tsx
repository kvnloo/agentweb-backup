import React from 'react';
import { Link } from 'react-router-dom';
import { 
  Box, 
  Typography, 
  Card, 
  CardContent, 
  CardHeader, 
  Button, 
  Grid, 
  Container,
  Avatar,
  Chip,
  useTheme,
  Stack
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import RadioIcon from '@mui/icons-material/Radio';
import LightbulbIcon from '@mui/icons-material/Lightbulb';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import FormatQuoteIcon from '@mui/icons-material/FormatQuote';
import BrushIcon from '@mui/icons-material/Brush';

const testimonials = [
  {
    quote: "This platform has revolutionized our marketing strategy. The AI insights are incredibly accurate.",
    author: "Sarah Chen",
    role: "Marketing Director, TechCorp"
  },
  {
    quote: "Overall, AgentWeb demonstrated superior task comprehension and completion rates compared to Manus, while performing on par with DeepSeek R1.",
    author: "Haggard Wei",
    role: "CEO, Salebrate.com"
  },
  {
    quote: "Creative research tools save us countless hours of market analysis. Highly recommended!",
    author: "Emma Thompson",
    role: "Brand Strategist, InnovateCo"
  }
];

const Home: React.FC = () => {
  const theme = useTheme();
  
  return (
    <Box sx={{ 
      minHeight: '100vh', 
      bgcolor: 'background.paper',
      pb: 8 
    }}>
      <Container maxWidth="lg" sx={{ py: 8 }}>
        <Box sx={{ textAlign: 'center', mb: 8 }}>
          <Chip 
            label="AI-Powered Marketing" 
            sx={{ 
              bgcolor: 'grey.100', 
              color: 'grey.700',
              mb: 2,
              px: 1
            }} 
          />
          <Typography 
            variant="h2" 
            component="h1" 
            sx={{ 
              mb: 3, 
              fontWeight: 'bold',
              background: 'linear-gradient(to right, #1a1a1a, #666)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
            }}
          >
            Unified Marketing Hub
          </Typography>
          <Typography 
            variant="h5" 
            color="text.secondary" 
            sx={{ 
              maxWidth: '600px', 
              mx: 'auto' 
            }}
          >
            A mighty AI-powered marketing team at your fingertips
          </Typography>
        </Box>

        <Grid container spacing={3} sx={{ mb: 6 }}>
          <Grid item xs={12} md={6} lg={3}>
            <Card sx={{ 
              height: '100%',
              border: `1px solid ${theme.palette.divider}`,
              transition: 'box-shadow 0.3s',
              '&:hover': {
                boxShadow: theme.shadows[10]
              }
            }}>
              <CardHeader
                avatar={
                  <Avatar sx={{ bgcolor: 'primary.light' }}>
                    <SearchIcon />
                  </Avatar>
                }
                title={
                  <Typography variant="h6">Market Research</Typography>
                }
              />
              <CardContent>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
                  AI-driven market analysis and competitive intelligence for data-backed decisions.
                </Typography>
                <Button 
                  component={Link} 
                  to="/marketing/research"
                  endIcon={<ChevronRightIcon />}
                  sx={{ 
                    '&:hover .MuiSvgIcon-root': { transform: 'translateX(4px)' },
                    '& .MuiSvgIcon-root': { transition: 'transform 0.2s' }
                  }}
                >
                  Learn More
                </Button>
              </CardContent>
            </Card>
          </Grid>

          <Grid item xs={12} md={6} lg={3}>
            <Card sx={{ 
              height: '100%',
              border: `1px solid ${theme.palette.divider}`,
              transition: 'box-shadow 0.3s',
              '&:hover': {
                boxShadow: theme.shadows[10]
              }
            }}>
              <CardHeader
                avatar={
                  <Avatar sx={{ bgcolor: 'warning.light' }}>
                    <LightbulbIcon />
                  </Avatar>
                }
                title={
                  <Typography variant="h6">Creative Research</Typography>
                }
              />
              <CardContent>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
                  Generate and validate creative concepts with AI-powered research tools.
                </Typography>
                <Button 
                  component={Link} 
                  to="/marketing/creative"
                  endIcon={<ChevronRightIcon />}
                  sx={{ 
                    '&:hover .MuiSvgIcon-root': { transform: 'translateX(4px)' },
                    '& .MuiSvgIcon-root': { transition: 'transform 0.2s' }
                  }}
                >
                  Learn More
                </Button>
              </CardContent>
            </Card>
          </Grid>

          <Grid item xs={12} md={6} lg={3}>
            <Card sx={{ 
              height: '100%',
              border: `1px solid ${theme.palette.divider}`,
              transition: 'box-shadow 0.3s',
              '&:hover': {
                boxShadow: theme.shadows[10]
              }
            }}>
              <CardHeader
                avatar={
                  <Avatar sx={{ bgcolor: 'info.light' }}>
                    <BrushIcon />
                  </Avatar>
                }
                title={
                  <Stack direction="row" spacing={1} alignItems="center">
                    <Typography variant="h6">Creative Generation</Typography>
                    <Chip
                      label="Coming Soon"
                      size="small"
                      color="secondary"
                      sx={{ height: 20, fontSize: '0.7rem' }}
                    />
                  </Stack>
                }
              />
              <CardContent>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
                  Produce compelling advertising copy, visuals, and video/script assets with AI.
                </Typography>
                <Button 
                  component={Link} 
                  to="/marketing/creative-generation"
                  endIcon={<ChevronRightIcon />}
                  sx={{ 
                    '&:hover .MuiSvgIcon-root': { transform: 'translateX(4px)' },
                    '& .MuiSvgIcon-root': { transition: 'transform 0.2s' }
                  }}
                >
                  Learn More
                </Button>
              </CardContent>
            </Card>
          </Grid>

          <Grid item xs={12} md={6} lg={3}>
            <Card sx={{ 
              height: '100%',
              border: `1px solid ${theme.palette.divider}`,
              transition: 'box-shadow 0.3s',
              '&:hover': {
                boxShadow: theme.shadows[10]
              }
            }}>
              <CardHeader
                avatar={
                  <Avatar sx={{ bgcolor: 'secondary.light' }}>
                    <RadioIcon />
                  </Avatar>
                }
                title={
                  <Stack direction="row" spacing={1} alignItems="center">
                    <Typography variant="h6">Social Listening</Typography>
                    <Chip
                      label="Coming Soon"
                      size="small"
                      color="secondary"
                      sx={{ height: 20, fontSize: '0.7rem' }}
                    />
                  </Stack>
                }
              />
              <CardContent>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
                  Monitor and analyze social media trends and conversations in real-time.
                </Typography>
                <Button 
                  component={Link} 
                  to="/marketing/social-listening"
                  endIcon={<ChevronRightIcon />}
                  sx={{ 
                    '&:hover .MuiSvgIcon-root': { transform: 'translateX(4px)' },
                    '& .MuiSvgIcon-root': { transition: 'transform 0.2s' }
                  }}
                >
                  Learn More
                </Button>
              </CardContent>
            </Card>
          </Grid>
        </Grid>

        <Box sx={{ mt: 12, mb: 8 }}>
          <Box sx={{ textAlign: 'center', mb: 6 }}>
            <Typography variant="h4" component="h2" fontWeight="bold" sx={{ mb: 2 }}>
              What Our Clients Say
            </Typography>
            <Typography variant="body1" color="text.secondary">
              Trusted by marketing teams worldwide
            </Typography>
          </Box>
          
          <Grid container spacing={4} justifyContent="center">
            {testimonials.map((testimonial, index) => (
              <Grid item xs={12} md={4} key={index}>
                <Card sx={{ 
                  height: '100%',
                  display: 'flex',
                  flexDirection: 'column',
                  boxShadow: 'none',
                  border: `1px solid ${theme.palette.divider}`
                }}>
                  <CardContent sx={{ 
                    display: 'flex', 
                    flexDirection: 'column',
                    alignItems: 'center',
                    textAlign: 'center',
                    flexGrow: 1,
                    p: 4
                  }}>
                    <FormatQuoteIcon 
                      sx={{ 
                        fontSize: 40, 
                        color: 'grey.300',
                        mb: 2 
                      }} 
                    />
                    <Typography variant="body1" sx={{ mb: 3, fontStyle: 'italic' }}>
                      "{testimonial.quote}"
                    </Typography>
                    <Box sx={{ mt: 'auto' }}>
                      <Typography variant="subtitle1" fontWeight="bold">
                        {testimonial.author}
                      </Typography>
                      <Typography variant="body2" color="text.secondary">
                        {testimonial.role}
                      </Typography>
                    </Box>
                  </CardContent>
                </Card>
              </Grid>
            ))}
          </Grid>
        </Box>

        <Box sx={{ textAlign: 'center' }}>
          <Button 
            variant="contained" 
            color="primary"
            size="large"
            component={Link}
            to="/marketing/get-started"
            sx={{ px: 4, py: 1.5 }}
          >
            Get Started Now
          </Button>
        </Box>
      </Container>
    </Box>
  );
};

export default Home; 