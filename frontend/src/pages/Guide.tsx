import { useState, useEffect } from 'react';
import { Container, Typography, Paper, Box, Accordion, AccordionSummary, AccordionDetails, useTheme, CircularProgress } from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import axios from 'axios';

interface GuideSubsection {
  title: string;
  content: string[];
}

interface GuideSection {
  title: string;
  content: string[];
  subsections?: GuideSubsection[];
}

export default function Guide() {
  const theme = useTheme();
  const [guideSections, setGuideSections] = useState<GuideSection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  useEffect(() => {
    const fetchGuideData = async () => {
      try {
        setLoading(true);
        const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:3001';
        const response = await axios.get(`${apiUrl}/api/guide`);
        
        if (response.data.success) {
          setGuideSections(response.data.data);
        } else {
          setError('Failed to load guide data');
        }
      } catch (err) {
        console.error('Error fetching guide data:', err);
        setError('Error loading guide data. Please try again later.');
      } finally {
        setLoading(false);
      }
    };
    
    fetchGuideData();
  }, []);
  
  if (loading) {
    return (
      <Container sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '50vh' }}>
        <CircularProgress />
      </Container>
    );
  }
  
  if (error) {
    return (
      <Container>
        <Paper elevation={3} sx={{ p: 4, mt: 4, textAlign: 'center' }}>
          <Typography color="error" variant="h6">{error}</Typography>
        </Paper>
      </Container>
    );
  }
  
  return (
    <Container maxWidth="lg" sx={{ mt: 4, mb: 4 }}>
      <Paper elevation={3} sx={{ p: 4, mb: 4, borderRadius: 2 }}>
        <Typography 
          variant="h4" 
          component="h1" 
          gutterBottom
          sx={{ 
            color: theme.palette.primary.main,
            fontWeight: 600,
            textAlign: 'center',
            mb: 3
          }}
        >
          AgentWeb User Guide
        </Typography>
        
        <Typography 
          variant="body1" 
          sx={{ 
            textAlign: 'center', 
            maxWidth: '800px', 
            mx: 'auto',
            mb: 4,
            color: theme.palette.text.secondary
          }}
        >
          Welcome to AgentWeb! This guide will help you understand all the features and get the most out of the platform.
        </Typography>
      </Paper>
      
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        {guideSections.map((section, index) => (
          <Paper 
            key={index} 
            sx={{ 
              p: 3, 
              borderRadius: 2,
              boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
              transition: 'all 0.2s ease-in-out',
              '&:hover': {
                boxShadow: '0 4px 12px rgba(0,0,0,0.12)'
              }
            }}
          >
            <Typography 
              variant="h5" 
              component="h2" 
              gutterBottom
              sx={{ 
                color: theme.palette.primary.main,
                fontWeight: 600,
                pb: 1,
                borderBottom: `1px solid ${theme.palette.divider}`
              }}
            >
              {section.title}
            </Typography>
            
            <Box sx={{ mb: 2, mt: 2 }}>
              {section.content.map((paragraph, paragraphIndex) => {
                const isListItem = paragraph.startsWith('-') || paragraph.match(/^\d+\./);
                return (
                  <Typography 
                    key={paragraphIndex} 
                    variant="body1" 
                    component={isListItem ? 'li' : 'p'} 
                    sx={{ 
                      mb: 1.5,
                      lineHeight: 1.6,
                      ...(isListItem && paragraph.startsWith('-') && {
                        listStyleType: 'none',
                        pl: 2,
                        position: 'relative',
                        '&::before': {
                          content: '"•"',
                          position: 'absolute',
                          left: 0,
                          color: theme.palette.primary.main,
                          fontWeight: 'bold'
                        }
                      })
                    }}
                  >
                    {isListItem && paragraph.startsWith('-') ? paragraph.substring(2) : paragraph}
                  </Typography>
                );
              })}
            </Box>
            
            {section.subsections && section.subsections.map((subsection, subIndex) => (
              <Accordion 
                key={subIndex} 
                sx={{ 
                  mb: 1, 
                  '&:before': { display: 'none' },
                  boxShadow: 'none',
                  border: `1px solid ${theme.palette.divider}`,
                  borderRadius: '8px !important',
                  overflow: 'hidden',
                  '&.Mui-expanded': {
                    margin: 0,
                    mt: 1,
                    mb: 1
                  }
                }}
              >
                <AccordionSummary
                  expandIcon={<ExpandMoreIcon color="primary" />}
                  aria-controls={`panel${index}-${subIndex}-content`}
                  id={`panel${index}-${subIndex}-header`}
                  sx={{
                    backgroundColor: 'rgba(0, 0, 0, 0.02)',
                    '&.Mui-expanded': {
                      minHeight: 48,
                      borderBottom: `1px solid ${theme.palette.divider}`
                    }
                  }}
                >
                  <Typography 
                    variant="h6"
                    sx={{ 
                      fontSize: '1.1rem',
                      fontWeight: 500,
                      color: theme.palette.text.primary
                    }}
                  >
                    {subsection.title}
                  </Typography>
                </AccordionSummary>
                <AccordionDetails sx={{ p: 3, pt: 2 }}>
                  <Box component={subsection.content.some(p => p.startsWith('-')) ? 'ul' : 'div'} sx={{ m: 0, pl: subsection.content.some(p => p.startsWith('-')) ? 3 : 0 }}>
                    {subsection.content.map((paragraph, paragraphIndex) => {
                      const isListItem = paragraph.startsWith('-') || paragraph.match(/^\d+\./);
                      return (
                        <Typography 
                          key={paragraphIndex} 
                          variant="body1" 
                          component={isListItem ? 'li' : 'p'} 
                          sx={{ 
                            mb: 1.5,
                            lineHeight: 1.6,
                            ...(isListItem && paragraph.startsWith('-') && {
                              listStyleType: 'none',
                              pl: 2,
                              position: 'relative',
                              '&::before': {
                                content: '"•"',
                                position: 'absolute',
                                left: 0,
                                color: theme.palette.primary.main,
                                fontWeight: 'bold'
                              }
                            })
                          }}
                        >
                          {isListItem && paragraph.startsWith('-') ? paragraph.substring(2) : paragraph}
                        </Typography>
                      );
                    })}
                  </Box>
                </AccordionDetails>
              </Accordion>
            ))}
          </Paper>
        ))}
      </Box>
    </Container>
  );
} 