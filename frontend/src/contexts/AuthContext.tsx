import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import axios from 'axios';
import { jwtDecode } from 'jwt-decode';

interface AuthContextType {
  token: string | null;
  userEmail: string | null;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  loginWithGoogle: () => Promise<void>;
  setToken: (token: string | null) => void;
  logout: () => void;
  isAuthenticated: boolean;
}

interface JwtPayload {
  email: string;
  userId: string;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(localStorage.getItem('token'));
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(!!token);

  useEffect(() => {
    if (token) {
      localStorage.setItem('token', token);
      setIsAuthenticated(true);
      // Decode token to get user email
      try {
        console.log('Token:', token);
        const decoded = jwtDecode<JwtPayload>(token);
        console.log('Decoded token:', decoded);
        setUserEmail(decoded.email);
      } catch (error) {
        console.error('Error decoding token:', error);
      }
    } else {
      localStorage.removeItem('token');
      setIsAuthenticated(false);
      setUserEmail(null);
    }
  }, [token]);

  const login = async (email: string, password: string) => {
    try {
      const response = await axios.post('http://localhost:3001/api/auth/login', {
        email,
        password,
      });
      setToken(response.data.token);
    } catch (error) {
      throw new Error('Login failed');
    }
  };

  const loginWithGoogle = async () => {
    try {
      // Redirect to Google OAuth endpoint
      window.location.href = 'http://localhost:3001/api/auth/google';
    } catch (error) {
      throw new Error('Google sign in failed');
    }
  };

  const register = async (email: string, password: string) => {
    try {
      const response = await axios.post('http://localhost:3001/api/auth/register', {
        email,
        password,
      });
      setToken(response.data.token);
    } catch (error) {
      throw new Error('Registration failed');
    }
  };

  const logout = () => {
    setToken(null);
  };

  return (
    <AuthContext.Provider value={{ token, userEmail, login, register, loginWithGoogle, setToken, logout, isAuthenticated }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
} 