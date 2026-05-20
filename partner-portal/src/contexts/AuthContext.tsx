import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import axios from 'axios';
import { buildApiUrl } from '../config';

// Define the possible user roles
export type UserRole = 'partner' | 'customer' | 'contractor';

interface User {
  userId: string;
  email: string;
  isAdmin: boolean;
  isOAuthUser: boolean;
  createdAt: string;
  roles: ('partner' | 'customer' | 'contractor')[];
  subscriptionType?: string;
}

interface AuthContextType {
  token: string | null;
  user: User | null;
  loading: boolean;
  loginError: string | null;
  login: (email: string, password: string, targetPortal?: UserRole) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  loginWithGoogle: (targetPortal?: UserRole) => Promise<void>;
  setToken: (token: string | null) => Promise<void>;
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
        setLoading(true);
        try {
          const response = await axios.get(buildApiUrl('/api/auth/me'), {
            headers: { Authorization: `Bearer ${storedToken}` }
          });
          const userData: User = response.data;
          if (!userData.roles) userData.roles = [];
          setUser(userData);
          setTokenState(storedToken);
        } catch (error) {
          console.error('Error initializing auth:', error);
          localStorage.removeItem('token');
          setTokenState(null);
          setUser(null);
        }
        setLoading(false);
      } else {
        setLoading(false);
      }
    };
    initializeAuth();
  }, []);

  const clearLoginError = useCallback(() => {
    setLoginError(null);
  }, []);

  const login = async (email: string, password: string, targetPortal?: UserRole) => {
    setLoading(true);
    clearLoginError();
    try {
      const response = await axios.post(buildApiUrl('/api/auth/login'), {
        email,
        password
      });
      const { token: newToken, user: userData } = response.data;
      if (!userData.roles) userData.roles = [];

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

      localStorage.setItem('token', newToken);
      setUser(userData);
      setTokenState(newToken);
    } catch (error: any) {
      console.error('Login error:', error);
      if (!loginError && !error.message?.startsWith('Role check failed')) {
         setLoginError(error.response?.data?.message || error.message || 'Login failed. Please try again.');
      }
      throw error;
    } finally {
      setLoading(false);
    }
  };

  const loginWithGoogle = useCallback(async (targetPortal?: UserRole) => {
    clearLoginError();
    try {
      const portalHint = targetPortal || 'partner';
      localStorage.setItem('oauthTargetPortal', portalHint);
      window.location.href = `${buildApiUrl('/api/auth/google')}?portal=${portalHint}`;
    } catch (error) {
      setLoginError('Google sign-in failed to initiate.');
      console.error('Google sign-in failed to initiate:', error);
    }
  }, [clearLoginError]);

  const register = useCallback(async (email: string, password: string) => {
    setLoading(true);
    clearLoginError();
    try {
      const response = await axios.post(buildApiUrl('/api/auth/register'), {
        email,
        password,
        roles: ['partner']
      });
      const { token: newToken, user: userData } = response.data;
      if (!userData.roles) userData.roles = [];
      
      localStorage.setItem('token', newToken);
      setUser(userData);
      setTokenState(newToken);
    } catch (error: any) {
      setLoginError(error.response?.data?.message || 'Registration failed');
      console.error('Registration error:', error);
      throw error;
    } finally {
      setLoading(false);
    }
  }, [clearLoginError]);

  const logout = useCallback(() => {
    setTokenState(null);
    setUser(null);
    localStorage.removeItem('token');
    localStorage.removeItem('oauthTargetPortal');
    clearLoginError();
  }, [clearLoginError]);

  const isAuthenticated = useCallback(() => !!token && !!user, [token, user]);

  const setToken = useCallback(async (newToken: string | null) => {
    clearLoginError();
    if (!newToken) {
        logout();
        return;
    }
    setLoading(true);
    try {
      const response = await axios.get(buildApiUrl('/api/auth/me'), {
        headers: { Authorization: `Bearer ${newToken}` }
      });
      const userData: User = response.data;
      if (!userData.roles) userData.roles = [];

      const targetPortal = localStorage.getItem('oauthTargetPortal') as UserRole | null;
      localStorage.removeItem('oauthTargetPortal');

      if (targetPortal) {
        const effectiveRoles = (userData.roles && userData.roles.length > 0) ? userData.roles : ['partner'];
        let hasTargetRole = effectiveRoles.includes(targetPortal);
        if (userData.isAdmin) hasTargetRole = true;

        if (!hasTargetRole) {
          setLoginError(`Access denied. Required role missing for ${targetPortal} portal after OAuth.`);
          setTokenState(null);
          setUser(null);
          localStorage.removeItem('token');
          setLoading(false);
          return;
        }
      }
      
      localStorage.setItem('token', newToken);
      setUser(userData);
      setTokenState(newToken);
    } catch (error) {
      console.error('Error fetching user data in setToken:', error);
      logout();
      if (!loginError) {
        setLoginError('Session validation failed. Please log in again.');
      }
    } finally {
      setLoading(false);
    }
  }, [clearLoginError, logout]);

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