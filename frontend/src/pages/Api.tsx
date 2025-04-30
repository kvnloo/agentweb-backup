import { useState, useEffect } from 'react';
import { Container, Typography, Paper, Box, Accordion, AccordionSummary, AccordionDetails, CircularProgress } from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import axios from 'axios';

interface ApiSubsection {
  title: string;
  content: string[];
}

interface ApiSection {
  title: string;
  content: string[];
  subsections?: ApiSubsection[];
}

export default function Api() {
  const [apiSections, setApiSections] = useState<ApiSection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  useEffect(() => {
    const fetchApiData = async () => {
      try {
        setLoading(true);
        const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:3001';
        const response = await axios.get(`${apiUrl}/api/docs`);
        
        if (response.data.success) {
          setApiSections(response.data.data);
        } else {
          setError('Failed to load API documentation');
        }
      } catch (err) {
        console.error('Error fetching API documentation:', err);
        setError('Error loading API documentation. Please try again later.');
      } finally {
        setLoading(false);
      }
    };
    
    fetchApiData();
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
    <Container maxWidth="lg" sx={{ py: 4 }}>
      <Typography variant="h3" component="h1" gutterBottom>
        API Documentation
      </Typography>
      
      {apiSections.map((section, index) => (
        <Paper key={index} sx={{ mt: 3 }}>
          <Box p={3}>
            <Typography variant="h5" gutterBottom>
              {section.title}
            </Typography>
            
            {section.content.map((text, i) => (
              <Typography key={i} paragraph>
                {text}
              </Typography>
            ))}

            {section.subsections && section.subsections.map((subsection, subIndex) => (
              <Accordion key={subIndex} sx={{ mt: 2 }}>
                <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                  <Typography variant="h6">
                    {subsection.title}
                  </Typography>
                </AccordionSummary>
                <AccordionDetails>
                  {subsection.content.map((text, i) => (
                    <Typography key={i} paragraph sx={{
                      fontFamily: text.startsWith('-') ? 'monospace' : 'inherit',
                      pl: text.startsWith('-') ? 2 : 0
                    }}>
                      {text}
                    </Typography>
                  ))}
                </AccordionDetails>
              </Accordion>
            ))}
          </Box>
        </Paper>
      ))}
    </Container>
  );
} 