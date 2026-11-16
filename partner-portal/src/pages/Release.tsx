import { useState, useEffect } from 'react';
import { Container, Typography, Paper, Box, Divider, CircularProgress } from '@mui/material';
import { EmptyState, ErrorState } from '../components/StatusState';
import axios from 'axios';

interface Release {
  date: string;
  changes: string[];
}

export default function Release() {
  const [releases, setReleases] = useState<Release[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  
  useEffect(() => {
    const fetchReleaseData = async () => {
      try {
        setLoading(true);
        setError(null);
        const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:3001';
        const response = await axios.get(`${apiUrl}/api/docs/release`);
        
        if (response.data.success) {
          setReleases(response.data.data);
        } else {
          setError('Failed to load release data');
        }
      } catch (err) {
        console.error('Error fetching release data:', err);
        setError('Error loading release data. Please try again later.');
      } finally {
        setLoading(false);
      }
    };
    
    fetchReleaseData();
  }, [reloadKey]);
  
  if (loading) {
    return (
      <Container sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '50vh' }}>
        <CircularProgress />
      </Container>
    );
  }
  
  if (error) {
    return (
      <Container sx={{ mt: 4 }}>
        <ErrorState title="We couldn't load the release history" onRetry={() => setReloadKey((k) => k + 1)} />
      </Container>
    );
  }

  if (releases.length === 0) {
    return (
      <Container sx={{ mt: 4 }}>
        <EmptyState
          title="No releases published yet"
          description="Release notes will appear here after the next deploy. Check back later."
        />
      </Container>
    );
  }

  return (
    <Container maxWidth="lg" sx={{ mt: 4, mb: 4 }}>
      <Typography variant="h4" component="h1" gutterBottom>
        Release History
      </Typography>
      
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        {releases.map((release, index) => (
          <Paper key={index} sx={{ p: 3 }}>
            <Box sx={{ display: 'flex', justifyContent: 'flex-end', mb: 2 }}>
              <Typography variant="subtitle1" color="text.secondary">
                {new Date(`${release.date}T12:00:00Z`).toLocaleDateString('en-US', {
                  year: 'numeric',
                  month: 'long',
                  day: 'numeric',
                  timeZone: 'UTC'
                })}
              </Typography>
            </Box>
            
            <Divider sx={{ mb: 2 }} />
            
            <Box component="ul" sx={{ m: 0, pl: 3 }}>
              {release.changes.map((change, changeIndex) => {
                const isSubItem = change.startsWith('- ');
                return (
                  <Typography 
                    key={changeIndex} 
                    component="li" 
                    variant="body1" 
                    sx={{ 
                      mb: 1,
                      ...(isSubItem && {
                        listStyleType: 'none',
                        pl: 2,
                        position: 'relative',
                        '&::before': {
                          content: '"•"',
                          position: 'absolute',
                          left: 0,
                          color: 'text.secondary'
                        }
                      })
                    }}
                  >
                    {isSubItem ? change.substring(2) : change}
                  </Typography>
                );
              })}
            </Box>
          </Paper>
        ))}
      </Box>
    </Container>
  );
} 