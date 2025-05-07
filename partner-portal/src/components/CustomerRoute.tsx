import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { CircularProgress, Box } from '@mui/material';

interface CustomerRouteProps {
  children: React.ReactElement;
}

const CustomerRoute: React.FC<CustomerRouteProps> = ({ children }) => {
  const { user, loadingAuth } = useAuth();
  const location = useLocation();

  if (loadingAuth) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
        <CircularProgress />
      </Box>
    );
  }

  if (!user) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  // User must have 'customer' role or be an admin
  const isCustomer = user.isAdmin || (user.roles && user.roles.includes('customer'));

  if (!isCustomer) {
    // Redirect to a general access denied page or tasks page if they are a partner but not customer
    // For now, redirecting to tasks, assuming non-customers might be partners.
    return <Navigate to="/tasks" state={{ from: location }} replace />;
  }

  return children;
};

export default CustomerRoute; 