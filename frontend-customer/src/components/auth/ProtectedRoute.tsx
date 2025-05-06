import { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { Loader2 } from 'lucide-react';

interface ProtectedRouteProps {
  children: ReactNode;
}

const ProtectedRoute = ({ children }: ProtectedRouteProps) => {
  const { isAuthenticated, loading, user } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-[#7E69AB]" />
      </div>
    );
  }

  if (!isAuthenticated) {
    // Redirect to login page with a return path
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  // Make sure the user is a customer
  if (user?.role !== 'customer') {
    return (
      <div className="flex h-screen items-center justify-center flex-col">
        <div className="text-xl font-semibold mb-2">Access Denied</div>
        <p className="text-muted-foreground">
          Only customer accounts can access this portal.
        </p>
      </div>
    );
  }

  return <>{children}</>;
};

export default ProtectedRoute; 