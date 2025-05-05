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
      <Box display="flex" justifyContent="center" alignItems="center" minHeight="60vh">
        <CircularProgress />
      </Box>
    );
  }

  // If not logged in, redirect to login
  if (!user) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  // Check if user has partner role or is admin (or no role, default to partner)
  const isPartner = user.isAdmin || user.role === 'partner' || !user.role;
  
  if (!isPartner) {
    console.log('PartnerRoute: Access denied', { user, role: user?.role });
    
    // Redirect based on user role
    if (hasRole('customer')) {
      return <Navigate to="/marketing" replace />;
    }
    return <Navigate to="/" replace />;
  }

  console.log('PartnerRoute: Access granted', { user, role: user?.role });
  return <>{children}</>;
} 