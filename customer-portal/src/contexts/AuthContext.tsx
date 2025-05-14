import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { buildApiUrl } from '@/config';
import axios from 'axios';
import { useLocation } from 'react-router-dom';

export type UserRole = 'customer' | 'partner';

// Define waitlist error code type
export type WaitlistErrorCode = 'not_in_waitlist' | 'not_invited' | 'user_not_found';

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
  errorCode: WaitlistErrorCode | null;
  landingSiteUrl: string | null;
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
  const [errorCode, setErrorCode] = useState<WaitlistErrorCode | null>(null);
  const [landingSiteUrl, setLandingSiteUrl] = useState<string | null>(null);
  
  // Get current location to reset errors on route change
  const location = useLocation();

  // Clear errors on route change
  useEffect(() => {
    setError(null);
    setErrorCode(null);
    setLandingSiteUrl(null);
  }, [location.pathname]);

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
    setErrorCode(null);
    setLandingSiteUrl(null);
    
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
      
      if (err.response?.data?.code === 'user_not_found') {
        setError(err.response.data.message);
        setErrorCode('user_not_found');
      } else if (err.response?.status === 403) {
        setError('Access denied: Only customer accounts can access this portal');
      } else if (err.response?.data?.message) {
        setError(err.response.data.message);
      } else {
        setError('Authentication failed. Please check your credentials.');
      }
      
      // Set error code if it was not specifically handled above but exists in response
      if (!errorCode && err.response?.data?.code) {
        setErrorCode(err.response.data.code as WaitlistErrorCode);
      }
      
      throw err;
    } finally {
      setLoading(false);
    }
  };

  const register = async (email: string, password: string) => {
    setLoading(true);
    setError(null);
    setErrorCode(null);
    setLandingSiteUrl(null);
    
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
      
      if (err.response?.data?.message) {
        setError(err.response.data.message);
      } else {
        setError('Registration failed. Please try again.');
      }
      
      if (err.response?.data?.code) {
        setErrorCode(err.response.data.code as WaitlistErrorCode);
      }
      
      if (err.response?.data?.code === 'not_in_waitlist') {
        const message = err.response?.data?.message || '';
        const match = message.match(/at\s(.+)$/);
        if (match && match[1]) {
          setLandingSiteUrl(match[1].trim());
        }
      }
      
      throw err;
    } finally {
      setLoading(false);
    }
  };

  const loginWithGoogle = async () => {
    setError(null);
    setErrorCode(null);
    setLandingSiteUrl(null);
    
    try {
      // Redirect to Google OAuth endpoint
      const googleAuthUrl = buildApiUrl('/api/auth/google');
      console.log('Redirecting to Google OAuth:', googleAuthUrl);
      
      // Add a customer role parameter to indicate this is from the customer portal
      const redirectUrl = `${googleAuthUrl}?portal=customer`;
      window.location.href = redirectUrl;
    } catch (error: any) {
      console.error('Google sign in failed:', error);
      
      if (error.response?.data?.message) {
        setError(error.response.data.message);
      } else {
        setError('Google sign in failed. Please try again.');
      }
      
      if (error.response?.data?.code) {
        setErrorCode(error.response.data.code as WaitlistErrorCode);
      }
      
      throw error;
    }
  };

  const setToken = async (newToken: string) => {
    setLoading(true);
    setError(null);
    setErrorCode(null);
    setLandingSiteUrl(null);
    
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
      
      if (err.response?.data?.message) {
        setError(err.response.data.message);
      } else {
        setError('Authentication failed. Please try again.');
      }
      
      if (err.response?.data?.code) {
        setErrorCode(err.response.data.code as WaitlistErrorCode);
      }
      
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
        errorCode,
        landingSiteUrl,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}; 