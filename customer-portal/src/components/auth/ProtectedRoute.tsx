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

  // Check if the user is an admin or has the 'customer' role
  const roles = user?.roles || [];
  if (!user?.isAdmin && !roles.includes('customer')) {
    return (
      <div className="flex h-screen items-center justify-center flex-col">
        <div className="text-xl font-semibold mb-2">Access Denied</div>
        <p className="text-muted-foreground">
          You do not have the required 'customer' role to access this portal.
        </p>
      </div>
    );
  }

  return <>{children}</>;
};

export default ProtectedRoute; 