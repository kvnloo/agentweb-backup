import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useAdmin } from '../contexts/AdminContext';
import { CircularProgress, Box } from '@mui/material';

interface AdminRouteProps {
  children: React.ReactNode;
}

export default function AdminRoute({ children }: AdminRouteProps) {
  const { user, loading: authLoading } = useAuth();
  const { isAdmin } = useAdmin();
  const location = useLocation();

  if (authLoading) {
    return (
      <Box display="flex" justifyContent="center" alignItems="center" minHeight="60vh">
        <CircularProgress />
      </Box>
    );
  }

  if (!user || !isAdmin) {
    console.log('AdminRoute: Access denied', { user, isAdmin });
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  console.log('AdminRoute: Access granted', { user, isAdmin });
  return <>{children}</>;
} 