import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { CircularProgress, Box } from '@mui/material';

interface PartnerRouteProps {
  children: React.ReactNode;
}

export default function PartnerRoute({ children }: PartnerRouteProps) {
  const { user, loading, hasRole } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
        <CircularProgress />
      </Box>
    );
  }

  if (!user) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  if (!hasRole('partner')) {
    console.warn('Access denied to partner route for user:', user.email);
    return <Navigate to="/" state={{ from: location }} replace />;
  }

  return <>{children}</>;
} 