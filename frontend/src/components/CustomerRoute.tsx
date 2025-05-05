import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { CircularProgress, Box } from '@mui/material';

interface CustomerRouteProps {
  children: React.ReactNode;
}

export default function CustomerRoute({ children }: CustomerRouteProps) {
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

  // Check if user has customer role or is admin
  const isCustomer = user.isAdmin || user.role === 'customer';
  
  if (!isCustomer) {
    console.log('CustomerRoute: Access denied', { user, role: user?.role });
    return <Navigate to="/" replace />;
  }

  console.log('CustomerRoute: Access granted', { user, role: user?.role });
  return <>{children}</>;
} 