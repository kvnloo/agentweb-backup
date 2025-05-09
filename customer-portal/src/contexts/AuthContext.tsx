import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { buildApiUrl } from '@/config';
import axios from 'axios';

export type UserRole = 'customer' | 'partner';

interface User {
  userId: string;
  email: string;
  roles: UserRole[];
  isAdmin: boolean;
}

interface AuthContextType {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  loginWithGoogle: () => Promise<void>;
  setToken: (token: string) => Promise<void>;
  logout: () => void;
  error: string | null;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

export const AuthProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [token, setTokenState] = useState<string | null>(localStorage.getItem('token'));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const verifyToken = async () => {
      if (!token) {
        setLoading(false);
        return;
      }

      try {
        const response = await axios.get(buildApiUrl('/api/auth/me'), {
          headers: { Authorization: `Bearer ${token}` },
        });
        
        const userData = response.data;
        if (!userData.roles) userData.roles = [];
        
        // Allow admin or users with customer role
        if (!userData.isAdmin && !userData.roles.includes('customer')) {
          setError('Access denied: You do not have permission to access this portal.');
          localStorage.removeItem('token');
          setTokenState(null);
          setUser(null);
        } else {
          setUser(userData);
        }
      } catch (err) {
        console.error('Token verification failed:', err);
        localStorage.removeItem('token');
        setTokenState(null);
      } finally {
        setLoading(false);
      }
    };

    verifyToken();
  }, [token]);

  const login = async (email: string, password: string) => {
    setLoading(true);
    setError(null);
    
    try {
      const response = await axios.post(buildApiUrl('/api/auth/login'), {
        email,
        password,
      });

      const { token: newToken, user: userData } = response.data;
      if (!userData.roles) userData.roles = [];
      
      // Allow admin or users with customer role
      if (!userData.isAdmin && !userData.roles.includes('customer')) {
        setError('Access denied: You do not have permission to access this portal.');
        return;
      }
      
      localStorage.setItem('token', newToken);
      setTokenState(newToken);
      setUser(userData);
    } catch (err: any) {
      console.error('Login failed:', err);
      if (err.response?.status === 403) {
        setError('Access denied: Only customer accounts can access this portal');
      } else {
        setError(err.response?.data?.message || 'Authentication failed. Please check your credentials.');
      }
      throw err;
    } finally {
      setLoading(false);
    }
  };

  const register = async (email: string, password: string) => {
    setLoading(true);
    setError(null);
    
    try {
      const response = await axios.post(buildApiUrl('/api/auth/register'), {
        email,
        password,
        roles: ['customer'],
      });

      const { token: newToken, user: userData } = response.data;
      if (!userData.roles) userData.roles = [];
      
      // Allow admin or users with customer role (though register here implies customer)
      if (!userData.isAdmin && !userData.roles.includes('customer')) {
        setError('Access denied: Account created without customer role.');
        return;
      }
      
      localStorage.setItem('token', newToken);
      setTokenState(newToken);
      setUser(userData);
    } catch (err: any) {
      console.error('Registration failed:', err);
      setError(err.response?.data?.message || 'Registration failed. Please try again.');
      throw err;
    } finally {
      setLoading(false);
    }
  };

  const loginWithGoogle = async () => {
    setError(null);
    try {
      // Redirect to Google OAuth endpoint
      const googleAuthUrl = buildApiUrl('/api/auth/google');
      console.log('Redirecting to Google OAuth:', googleAuthUrl);
      
      // Add a customer role parameter to indicate this is from the customer portal
      const redirectUrl = `${googleAuthUrl}?portal=customer`;
      window.location.href = redirectUrl;
    } catch (error) {
      console.error('Google sign in failed:', error);
      setError('Google sign in failed. Please try again.');
      throw error;
    }
  };

  const setToken = async (newToken: string) => {
    setLoading(true);
    setError(null);
    
    try {
      // Verify the token and get user data
      const response = await axios.get(buildApiUrl('/api/auth/me'), {
        headers: { Authorization: `Bearer ${newToken}` },
      });
      
      const userData = response.data;
      if (!userData.roles) userData.roles = [];
      
      // Allow admin or users with customer role
      if (!userData.isAdmin && !userData.roles.includes('customer')) {
        setError('Access denied: You do not have permission to access this portal.');
        setLoading(false);
        // Clear token and user if access is denied
        localStorage.removeItem('token');
        setTokenState(null);
        setUser(null);
        throw new Error('Access denied: You do not have permission to access this portal.');
      }
      
      // Store the token and user data
      localStorage.setItem('token', newToken);
      setTokenState(newToken);
      setUser(userData);
    } catch (err: any) {
      console.error('Token validation failed:', err);
      setError(err.response?.data?.message || 'Authentication failed. Please try again.');
      throw err;
    } finally {
      setLoading(false);
    }
  };

  const logout = () => {
    localStorage.removeItem('token');
    setTokenState(null);
    setUser(null);
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        token,
        isAuthenticated: !!user,
        loading,
        login,
        register,
        loginWithGoogle,
        setToken,
        logout,
        error,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}; 