import React, { createContext, useContext, useState, useCallback } from "react";
import axios from "axios";
import { useAuth } from "./AuthContext";
import { API_URL } from "../config";

interface WaitlistEntry {
  email: string;
  status: "pending" | "invited" | "rejected";
  createdAt: string;
  invitedAt?: string;
  fullName?: string;
  companyName?: string;
  phoneNumber?: string;
  joinedAt?: string;
  useCaseCategories?: string[];
  useCaseDescription?: string;
  requestReport?: boolean;
  supportNote?: string;
}

interface User {
  userId: string;
  email: string;
  isAdmin: boolean;
  isActive: boolean;
  createdAt: string;
  lastLoginTime?: string;
  supportNote?: string;
  roles?: ("partner" | "customer")[];
  taskCount?: number;
  workflowCount?: number;
  isOAuthUser?: boolean;
  stripe_customer_id?: string;
  adAccount?: string; // Meta ad account ID
  emailDomain?: string; // Email sender domain
  defaultSenderUsername?: string; // Default sender username (e.g., noreply)
  fromName?: string; // From name for emails
}

interface AdminContextType {
  users: User[];
  waitlist: WaitlistEntry[];
  taskAnalytics: any;
  userAnalytics: any;
  loadUsers: () => Promise<void>;
  loadWaitlist: () => Promise<void>;
  loadAnalytics: (startDate: string, endDate: string) => Promise<void>;
  updateWaitlistStatus: (email: string, status: string) => Promise<void>;
  updateWaitlistSupportNote: (
    email: string,
    supportNote: string
  ) => Promise<void>;
  deleteWaitlistEntry: (email: string) => Promise<void>;
  deleteUser: (userId: string) => Promise<void>;
  addToWaitlist: (
    waitlistData: Partial<WaitlistEntry> & {
      email: string;
      sendInvitation?: boolean;
    }
  ) => Promise<void>;
  loading: boolean;
  error: string | null;
  isAdmin: boolean;
  setUsers: React.Dispatch<React.SetStateAction<User[]>>;
}

const AdminContext = createContext<AdminContextType | undefined>(undefined);

// Export the hook as a named function declaration
export function useAdmin() {
  const context = useContext(AdminContext);
  if (!context) {
    throw new Error("useAdmin must be used within an AdminProvider");
  }
  return context;
}

export const AdminProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [users, setUsers] = useState<User[]>([]);
  const [waitlist, setWaitlist] = useState<WaitlistEntry[]>([]);
  const [taskAnalytics, setTaskAnalytics] = useState<any>(null);
  const [userAnalytics, setUserAnalytics] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { token, user } = useAuth();

  const api = axios.create({
    baseURL: API_URL,
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  const loadUsers = useCallback(async () => {
    try {
      setLoading(true);
      const response = await api.get("/api/admin/users");
      setUsers(response.data);
      setError(null);
    } catch (err: any) {
      setError(err.response?.data?.message || "Failed to load users");
    } finally {
      setLoading(false);
    }
  }, [api]);

  const loadWaitlist = useCallback(async () => {
    try {
      setLoading(true);
      const response = await api.get("/api/admin/waitlist");
      // Sort waitlist by joinedAt in descending order (newest first)
      const sortedWaitlist = [...response.data.items].sort((a, b) => {
        const aDate = new Date(a.joinedAt).getTime();
        const bDate = new Date(b.joinedAt).getTime();
        return bDate - aDate; // descending order
      });
      setWaitlist(sortedWaitlist);
      setError(null);
    } catch (err: any) {
      setError(err.response?.data?.message || "Failed to load waitlist");
    } finally {
      setLoading(false);
    }
  }, [api]);

  const loadAnalytics = useCallback(
    async (startDate: string, endDate: string) => {
      try {
        console.log(`Loading analytics for date range: ${startDate} to ${endDate}`);
        setLoading(true);
        setError(null);
        
        const [taskResponse, userResponse] = await Promise.all([
          api.get("/api/admin/analytics/tasks", {
            params: { startDate, endDate },
          }),
          api.get("/api/admin/analytics/users", {
            params: { startDate, endDate },
          }),
        ]);
        
        console.log('Task analytics response:', taskResponse.data);
        console.log('User analytics response:', userResponse.data);
        
        setTaskAnalytics(taskResponse.data);
        setUserAnalytics(userResponse.data);
        setError(null);
      } catch (err: any) {
        console.error('Error loading analytics:', err);
        const errorMessage = err.response?.data?.message || err.message || "Failed to load analytics";
        setError(errorMessage);
        
        // Set fallback data to prevent UI crashes
        setTaskAnalytics({
          totalTasks: 0,
          newTasks: 0,
          totalExecutions: 0,
          successfulExecutions: 0,
          failedExecutions: 0,
          newExecutions: 0,
          scheduledTasks: 0,
          newScheduledTasks: 0,
          templates: 0,
          newTemplates: 0,
          websiteConfigs: 0,
          newWebsiteConfigs: 0,
          apiConfigs: 0,
          newApiConfigs: 0,
          sharedConfigs: 0,
          totalWorkflows: 0,
          newWorkflows: 0,
          workflowExecutions: 0,
          newWorkflowExecutions: 0,
          successfulWorkflowExecutions: 0,
          failedWorkflowExecutions: 0,
          pendingWorkflowExecutions: 0,
          averageExecutionTime: null,
        });
        
        setUserAnalytics({
          totalUsers: 0,
          newUsers: 0,
          oauthUsers: 0,
          newOauthUsers: 0,
          adminUsers: 0,
        });
      } finally {
        setLoading(false);
      }
    },
    [api]
  );

  const updateWaitlistStatus = useCallback(
    async (email: string, status: string) => {
      try {
        setLoading(true);
        await api.put(`/api/admin/waitlist/${email}/status`, { status });
        await loadWaitlist();
        setError(null);
      } catch (err: any) {
        setError(
          err.response?.data?.message || "Failed to update waitlist status"
        );
      } finally {
        setLoading(false);
      }
    },
    [api, loadWaitlist]
  );

  const updateWaitlistSupportNote = useCallback(
    async (email: string, supportNote: string) => {
      try {
        setLoading(true);
        await api.put(`/api/admin/waitlist/${email}/support-note`, {
          supportNote,
        });
        await loadWaitlist();
        setError(null);
      } catch (err: any) {
        setError(
          err.response?.data?.message || "Failed to update support note"
        );
        throw err;
      } finally {
        setLoading(false);
      }
    },
    [api, loadWaitlist]
  );

  const deleteWaitlistEntry = useCallback(
    async (email: string) => {
      try {
        setLoading(true);
        await api.delete(`/api/admin/waitlist/${email}`);
        await loadWaitlist();
        setError(null);
      } catch (err: any) {
        setError(
          err.response?.data?.message || "Failed to delete waitlist entry"
        );
        throw err;
      } finally {
        setLoading(false);
      }
    },
    [api, loadWaitlist]
  );

  const deleteUser = useCallback(
    async (userId: string) => {
      try {
        setLoading(true);
        await api.delete(`/api/admin/users/${userId}`);
        await loadUsers(); // Reload users after deletion
        setError(null);
      } catch (err: any) {
        setError(err.response?.data?.message || "Failed to delete user");
        throw err; // Re-throw to allow component-level error handling
      } finally {
        setLoading(false);
      }
    },
    [api, loadUsers]
  );

  const addToWaitlist = useCallback(
    async (
      waitlistData: Partial<WaitlistEntry> & {
        email: string;
        sendInvitation?: boolean;
      }
    ) => {
      try {
        setLoading(true);
        await api.post("/api/admin/waitlist/invite", waitlistData);
        await loadWaitlist(); // Reload waitlist after adding
        setError(null);
      } catch (err: any) {
        setError(err.response?.data?.message || "Failed to add to waitlist");
        throw err; // Re-throw to allow component-level error handling
      } finally {
        setLoading(false);
      }
    },
    [api, loadWaitlist]
  );

  const value = {
    users,
    waitlist,
    taskAnalytics,
    userAnalytics,
    loadUsers,
    loadWaitlist,
    loadAnalytics,
    updateWaitlistStatus,
    updateWaitlistSupportNote,
    deleteWaitlistEntry,
    deleteUser,
    addToWaitlist,
    loading,
    error,
    isAdmin: user?.isAdmin || false,
    setUsers,
  };

  return (
    <AdminContext.Provider value={value}>{children}</AdminContext.Provider>
  );
};
