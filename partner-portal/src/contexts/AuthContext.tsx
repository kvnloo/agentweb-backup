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
  roles: ('partner' | 'customer')[];
}

interface AuthContextType {
  token: string | null;
  user: User | null;
  loading: boolean;
  loginError: string | null;
  login: (email: string, password: string, targetPortal?: UserRole) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  loginWithGoogle: (targetPortal?: UserRole) => Promise<void>;
  setToken: (token: string | null) => void;
  logout: () => void;
  isAuthenticated: () => boolean;
  hasRole: (rolesToCheck: UserRole | UserRole[]) => boolean;
  clearLoginError: () => void;
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
  const [loginError, setLoginError] = useState<string | null>(null);

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

  const clearLoginError = () => {
    setLoginError(null);
  };

  const login = async (email: string, password: string, targetPortal?: UserRole) => {
    setLoginError(null);
    try {
      setLoading(true);
      const response = await axios.post(buildApiUrl('/api/auth/login'), {
        email,
        password
      });
      const { token: newToken, user: userData } = response.data;

      if (targetPortal) {
        const effectiveRoles = (userData.roles && userData.roles.length > 0) ? userData.roles : ['partner'];
        let hasTargetRole = effectiveRoles.includes(targetPortal);
        if (userData.isAdmin) hasTargetRole = true;

        if (!hasTargetRole) {
          setLoginError(`Access denied. You do not have the required role for the ${targetPortal} portal.`);
          localStorage.removeItem('token');
          setTokenState(null);
          setUser(null);
          throw new Error(`Role check failed for ${targetPortal} portal.`);
        }
      }

      setTokenState(newToken);
      setUser(userData);
      localStorage.setItem('token', newToken);
    } catch (error: any) {
      console.error('Login error:', error);
      if (!loginError && error.message !== `Role check failed for ${targetPortal} portal.`) {
         setLoginError(error.response?.data?.message || error.message || 'Login failed. Please try again.');
      }
      throw error;
    } finally {
      setLoading(false);
    }
  };

  const loginWithGoogle = async (targetPortal?: UserRole) => {
    setLoginError(null);
    try {
      if (targetPortal) {
        localStorage.setItem('oauthTargetPortal', targetPortal);
      } else {
        localStorage.removeItem('oauthTargetPortal');
      }
      const googleAuthUrl = buildApiUrl('/api/auth/google');
      console.log('Redirecting to Google OAuth:', {
        apiUrl: API_URL,
        fullUrl: googleAuthUrl
      });
      window.location.href = googleAuthUrl;
    } catch (error) {
      setLoginError('Google sign-in failed to initiate.');
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
    setLoginError(null);
    try {
      if (newToken) {
        const response = await axios.get(buildApiUrl('/api/auth/me'), {
          headers: {
            Authorization: `Bearer ${newToken}`
          }
        });
        const userData: User = response.data;

        const targetPortal = localStorage.getItem('oauthTargetPortal') as UserRole | null;
        if (targetPortal) {
          localStorage.removeItem('oauthTargetPortal');

          const effectiveRoles = (userData.roles && userData.roles.length > 0) ? userData.roles : ['partner'];
          let hasTargetRole = effectiveRoles.includes(targetPortal);
          if (userData.isAdmin) hasTargetRole = true;

          if (!hasTargetRole) {
            setLoginError(`Access denied. You do not have the required role for the ${targetPortal} portal.`);
            setUser(null);
            setTokenState(null);
            localStorage.removeItem('token');
            throw new Error(`Role check failed for ${targetPortal} portal after OAuth.`);
          }
        }
        
        setUser(userData);
        setTokenState(newToken);
        localStorage.setItem('token', newToken);
      } else {
        setUser(null);
        setTokenState(null);
        localStorage.removeItem('token');
      }
    } catch (error) {
      console.error('Error fetching user data:', error);
      setUser(null);
      setTokenState(null);
      localStorage.removeItem('token');
      throw error;
    }
  }, []);

  const hasRole = useCallback((rolesToCheck: UserRole | UserRole[]): boolean => {
    if (!user) return false;
    
    if (user.isAdmin) return true;
    
    const currentUserRoles = (user.roles && user.roles.length > 0) ? user.roles : ['partner'];
    
    const rolesToMatch = Array.isArray(rolesToCheck) ? rolesToCheck : [rolesToCheck];
    
    return currentUserRoles.some(userRole => rolesToMatch.includes(userRole as UserRole));
  }, [user]);

  const value = {
    token,
    user,
    loading,
    loginError,
    login,
    register,
    loginWithGoogle,
    setToken,
    logout,
    isAuthenticated,
    hasRole,
    clearLoginError
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}; 