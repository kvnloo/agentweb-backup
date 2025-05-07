import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useAdmin } from '../contexts/AdminContext';
import { CircularProgress, Box } from '@mui/material';

interface AdminRouteProps {
  children: React.ReactNode;
}

export default function AdminRoute({ children }: AdminRouteProps) {
  const { user, loading: authLoading, hasRole } = useAuth();
  const { isAdmin } = useAdmin();
  const location = useLocation();

  if (authLoading) {
    return (
      <Box display="flex" justifyContent="center" alignItems="center" minHeight="60vh">
        <CircularProgress />
      </Box>
    );
  }

  // Check for admin access through isAdmin property
  if (!user || !isAdmin) {
    console.log('AdminRoute: Access denied', { user, isAdmin });
    
    // Redirect based on user role
    if (user) {
      if (hasRole('customer')) {
        return <Navigate to="/marketing" replace />;
      } else if (hasRole('partner')) {
        return <Navigate to="/tasks" replace />;
      }
    }
    
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  console.log('AdminRoute: Access granted', { user, isAdmin });
  return <>{children}</>;
} 