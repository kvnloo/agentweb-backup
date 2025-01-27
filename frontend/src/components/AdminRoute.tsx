import React from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

interface AdminRouteProps {
  children: React.ReactNode;
}

export default function AdminRoute({ children }: AdminRouteProps) {
  const { user, loading } = useAuth();

  if (loading) {
    return null; // or a loading spinner
  }

  if (!user || !user.isAdmin) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
} 