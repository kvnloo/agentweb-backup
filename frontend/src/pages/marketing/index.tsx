import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import Box from '@mui/material/Box';
import { useTheme } from '@mui/material/styles';

// Import actual components
import Home from './Home';
import SocialListening from './SocialListening';
import NotFound from './NotFound';
import MarketResearch from './MarketResearch';
import MarketResearchDetail from './MarketResearchDetail';

// Placeholders for components we haven't implemented yet
const ReportDetail = () => <div>Report Detail</div>;
const Blog = () => <div>Blog</div>;

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
        <Route path="/social-listening" element={<SocialListening />} />
        <Route path="/research" element={<MarketResearch />} />
        <Route path="/research/:taskId" element={<MarketResearchDetail />} />
        <Route path="/market-research" element={<Navigate to="/marketing/research" replace />} />
        <Route path="/report/:id" element={<ReportDetail />} />
        <Route path="/blog" element={<Blog />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </Box>
  );
};

export default Marketing; 