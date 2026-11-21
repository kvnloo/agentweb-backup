import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import Box from '@mui/material/Box';
import { useTheme } from '@mui/material/styles';

// Import actual components
import Home from './Home';
import NotFound from './NotFound';
import MarketResearch from './MarketResearch';
import MarketResearchDetail from './MarketResearchDetail';

const Marketing: React.FC = () => {
  const theme = useTheme();
  
  return (
    <Box sx={{ 
      minHeight: '100vh',
      backgroundColor: theme.palette.background.default,
      paddingTop: 2,
      paddingBottom: 4
    }}>
      <Routes>
        <Route path="/" element={<Home />} />
        {/* ENG-3141: unbuilt pages redirect to the marketing home instead of a placeholder. */}
        <Route path="/social-listening" element={<Navigate to="/marketing" replace />} />
        <Route path="/creative-generation" element={<Navigate to="/marketing" replace />} />
        <Route path="/research" element={<MarketResearch />} />
        <Route path="/research/:taskId" element={<MarketResearchDetail />} />
        <Route path="/market-research" element={<Navigate to="/marketing/research" replace />} />
        <Route path="/report/:id" element={<Navigate to="/marketing" replace />} />
        <Route path="/blog" element={<Navigate to="/marketing" replace />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </Box>
  );
};

export default Marketing; 