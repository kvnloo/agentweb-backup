import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import axios from 'axios';
import { API_URL, buildApiUrl } from '../config';

// Define the possible user roles
export type UserRole = 'partner' | 'customer';

interface User {
  userId: string;
  email: string;
  isAdmin: boolean;
  isOAuthUser: boolean;
  createdAt: string;
  role: UserRole;
}

interface AuthContextType {
  token: string | null;
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  loginWithGoogle: () => Promise<void>;
  setToken: (token: string | null) => void;
  logout: () => void;
  isAuthenticated: () => boolean;
  hasRole: (roles: UserRole | UserRole[]) => boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

// Export the hook as a named function declaration
export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [token, setTokenState] = useState<string | null>(localStorage.getItem('token'));
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const initializeAuth = async () => {
      const storedToken = localStorage.getItem('token');
      if (storedToken) {
        try {
          const response = await axios.get(buildApiUrl('/api/auth/me'), {
            headers: {
              Authorization: `Bearer ${storedToken}`
            }
          });
          setUser(response.data);
          setTokenState(storedToken);
        } catch (error) {
          console.error('Error initializing auth:', error);
          localStorage.removeItem('token');
          setTokenState(null);
          setUser(null);
        }
      }
      setLoading(false);
    };

    initializeAuth();
  }, []);

  const login = async (email: string, password: string) => {
    try {
      setLoading(true);
      const response = await axios.post(buildApiUrl('/api/auth/login'), {
        email,
        password
      });
      const { token: newToken, user: userData } = response.data;
      setTokenState(newToken);
      setUser(userData);
      localStorage.setItem('token', newToken);
    } catch (error) {
      console.error('Login error:', error);
      throw error;
    } finally {
      setLoading(false);
    }
  };

  const loginWithGoogle = async () => {
    try {
      // Redirect to Google OAuth endpoint
      const googleAuthUrl = buildApiUrl('/api/auth/google');
      console.log('Redirecting to Google OAuth:', {
        apiUrl: API_URL,
        fullUrl: googleAuthUrl
      });
      window.location.href = googleAuthUrl;
    } catch (error) {
      throw new Error('Google sign in failed');
    }
  };

  const register = async (email: string, password: string) => {
    try {
      setLoading(true);
      const response = await axios.post(buildApiUrl('/api/auth/register'), {
        email,
        password,
      });
      const { token: newToken, user: userData } = response.data;
      setTokenState(newToken);
      setUser(userData);
      localStorage.setItem('token', newToken);
    } catch (error) {
      throw new Error('Registration failed');
    } finally {
      setLoading(false);
    }
  };

  const logout = () => {
    setTokenState(null);
    setUser(null);
    localStorage.removeItem('token');
  };

  const isAuthenticated = () => !!token;

  const setToken = useCallback(async (newToken: string | null) => {
    try {
      if (newToken) {
        // Get user data using the token
        const response = await axios.get(buildApiUrl('/api/auth/me'), {
          headers: {
            Authorization: `Bearer ${newToken}`
          }
        });
        
        // Set both user data and token
        setUser(response.data);
        setTokenState(newToken);
        localStorage.setItem('token', newToken);
      } else {
        setUser(null);
        setTokenState(null);
        localStorage.removeItem('token');
      }
    } catch (error) {
      console.error('Error fetching user data:', error);
      // On error, clear everything
      setUser(null);
      setTokenState(null);
      localStorage.removeItem('token');
      throw error; // Re-throw to handle in the component
    }
  }, []);

  const hasRole = useCallback((roles: UserRole | UserRole[]): boolean => {
    if (!user) return false;
    
    // Admin users have access to everything
    if (user.isAdmin) return true;
    
    // Use 'partner' as default role if not defined
    const userRole = user.role || 'partner';
    
    // Check if user has the specified role
    if (Array.isArray(roles)) {
      return roles.includes(userRole);
    }
    
    return roles === userRole;
  }, [user]);

  const value = {
    token,
    user,
    loading,
    login,
    register,
    loginWithGoogle,
    setToken,
    logout,
    isAuthenticated,
    hasRole
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}; 