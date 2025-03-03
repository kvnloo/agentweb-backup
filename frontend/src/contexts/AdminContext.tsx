import React, { createContext, useContext, useState, useCallback } from 'react';
import axios from 'axios';
import { useAuth } from './AuthContext';
import { API_URL } from '../config';

interface AdminContextType {
  users: any[];
  waitlist: any[];
  taskAnalytics: any;
  userAnalytics: any;
  loadUsers: () => Promise<void>;
  loadWaitlist: () => Promise<void>;
  loadAnalytics: (startDate: string, endDate: string) => Promise<void>;
  updateWaitlistStatus: (email: string, status: string) => Promise<void>;
  loading: boolean;
  error: string | null;
  isAdmin: boolean;
}

const AdminContext = createContext<AdminContextType | undefined>(undefined);

// Export the hook as a named function declaration
export function useAdmin() {
  const context = useContext(AdminContext);
  if (!context) {
    throw new Error('useAdmin must be used within an AdminProvider');
  }
  return context;
}

export const AdminProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [users, setUsers] = useState<any[]>([]);
  const [waitlist, setWaitlist] = useState<any[]>([]);
  const [taskAnalytics, setTaskAnalytics] = useState<any>(null);
  const [userAnalytics, setUserAnalytics] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { token, user } = useAuth();

  const api = axios.create({
    baseURL: API_URL,
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  const loadUsers = useCallback(async () => {
    try {
      setLoading(true);
      const response = await api.get('/api/admin/users');
      setUsers(response.data);
      setError(null);
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to load users');
    } finally {
      setLoading(false);
    }
  }, [api]);

  const loadWaitlist = useCallback(async () => {
    try {
      setLoading(true);
      const response = await api.get('/api/admin/waitlist');
      setWaitlist(response.data.items);
      setError(null);
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to load waitlist');
    } finally {
      setLoading(false);
    }
  }, [api]);

  const loadAnalytics = useCallback(async (startDate: string, endDate: string) => {
    try {
      setLoading(true);
      const [taskResponse, userResponse] = await Promise.all([
        api.get('/api/admin/analytics/tasks', {
          params: { startDate, endDate }
        }),
        api.get('/api/admin/analytics/users', {
          params: { startDate, endDate }
        })
      ]);
      setTaskAnalytics(taskResponse.data);
      setUserAnalytics(userResponse.data);
      setError(null);
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to load analytics');
    } finally {
      setLoading(false);
    }
  }, [api]);

  const updateWaitlistStatus = useCallback(async (email: string, status: string) => {
    try {
      setLoading(true);
      await api.put(`/api/admin/waitlist/${email}/status`, { status });
      await loadWaitlist();
      setError(null);
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to update waitlist status');
    } finally {
      setLoading(false);
    }
  }, [api, loadWaitlist]);

  const value = {
    users,
    waitlist,
    taskAnalytics,
    userAnalytics,
    loadUsers,
    loadWaitlist,
    loadAnalytics,
    updateWaitlistStatus,
    loading,
    error,
    isAdmin: user?.isAdmin || false
  };

  return <AdminContext.Provider value={value}>{children}</AdminContext.Provider>;
}; 
