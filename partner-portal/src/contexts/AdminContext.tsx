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
  lastActiveAt?: string;
  supportNote?: string;
  roles?: ("partner" | "customer" | "free")[];
  taskCount?: number;
  workflowCount?: number;
  chatSessionCount?: number;
  isOAuthUser?: boolean;
  stripe_customer_id?: string;
  stripe_subscription_id?: string;
  subscription_status?: string; // active, trialing, past_due, canceled, canceling
  has_payment_method?: boolean;
  subscription_amount?: number; // Most recent invoice amount paid, in cents
  current_period_end?: string;
  adAccount?: string; // Meta ad account ID
  emailDomain?: string; // Email sender domain
  defaultSenderUsername?: string; // Default sender username (e.g., noreply)
  fromName?: string; // From name for emails
  slackChannel?: string; // @deprecated — use slackChannels
  slackChannels?: string[]; // Slack channels configured for this user
  secretNames?: string[]; // Names of configured secrets (values not exposed)
  seoDomains?: string[]; // SEO domains to track
  googleAnalyticsPropertyId?: string; // Google Analytics Property ID
  gaFilteredDomains?: string[]; // Domains to exclude from Google Analytics
  clarityProjectId?: string; // Microsoft Clarity Project ID
  productDomain?: string; // Product site domain for feature usage tracking
  cmsType?: "Basehub" | "Webflow"; // CMS Type for blog publishing
  subscriptionType?: string; // Subscription type for customer portal users
  tokenUsage?: {
    month: string;
    totalTokens: number;
    totalCost: number;
    resetDate: string;
  };
  tokenUsageHistory?: Array<{
    month: string;
    totalTokens: number;
    totalCost: number;
  }>;
  tokenAllowanceBonus?: number;
  extraCostUsage?: {
    month: string;
    totalCost: number;
    breakdown: Record<string, number>;
    resetDate: string;
  };
  extraCostUsageHistory?: Array<{
    month: string;
    totalCost: number;
    breakdown: Record<string, number>;
  }>;
  introductionEmailSent?: string; // ISO date when the team introduction email was last sent
  replayUrl?: string; // Microsoft Clarity replay session URL
  googleDriveFolders?: Array<{ folderId: string; name: string }>; // Google Drive shared folders
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmContent?: string;
  utmTerm?: string;
  orgId?: string;
  orgRole?: "owner" | "member";
  orgName?: string;
}

interface AdminContextType {
  users: User[];
  waitlist: WaitlistEntry[];
  taskAnalytics: any;
  userAnalytics: any;
  agentModeAnalytics: any;
  gtmAnalytics: any;
  crmAnalytics: any;
  loadUsers: (hideBotLike?: boolean) => Promise<void>;
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
  createUserFromWaitlist: (email: string, roles?: string[]) => Promise<{ user: any; temporaryPassword: string }>;
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
  const [agentModeAnalytics, setAgentModeAnalytics] = useState<any>(null);
  const [gtmAnalytics, setGtmAnalytics] = useState<any>(null);
  const [crmAnalytics, setCrmAnalytics] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { token, user } = useAuth();

  const api = axios.create({
    baseURL: API_URL,
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  const loadUsers = useCallback(async (hideBotLike = true) => {
    try {
      setLoading(true);
      const response = await api.get("/api/admin/users", {
        params: { hideBotLike: hideBotLike ? "true" : "false" },
      });
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
        setLoading(true);
        setError(null);
        
        const [taskResponse, userResponse, agentModeResponse, gtmResponse, crmResponse] = await Promise.all([
          api.get("/api/admin/analytics/tasks", {
            params: { startDate, endDate },
          }),
          api.get("/api/admin/analytics/users", {
            params: { startDate, endDate },
          }),
          api.get("/api/admin/analytics/agent-mode", {
            params: { startDate, endDate },
          }).catch((err) => {
            // Don't fail the whole request if agent mode analytics fails
            console.error('Error loading agent mode analytics:', err);
            return { data: null };
          }),
          api.get("/api/admin/analytics/gtm", {
            params: { startDate, endDate },
          }).catch((err) => {
            console.error('Error loading GTM analytics:', err);
            return { data: null };
          }),
          api.get("/api/admin/analytics/crm", {
            params: { startDate, endDate },
          }).catch((err) => {
            console.error('Error loading CRM analytics:', err);
            return { data: null };
          }),
        ]);

        setTaskAnalytics(taskResponse.data);
        setUserAnalytics(userResponse.data);
        setAgentModeAnalytics(agentModeResponse.data);
        setGtmAnalytics(gtmResponse.data);
        setCrmAnalytics(crmResponse.data);
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
        
        setAgentModeAnalytics({
          totalSessions: 0,
          newSessions: 0,
          totalScheduledSessions: 0,
          totalNonScheduledSessions: 0,
          newScheduledSessions: 0,
          newNonScheduledSessions: 0,
          totalUsers: 0,
          activeUsers: 0,
          newUsers: 0,
          returningUsers: 0,
          totalAnonymousUsers: 0,
          activeAnonymousUsers: 0,
          averageSessionsPerActiveUser: 0,
          sessionTypes: {},
          sessionTypesInRange: {},
          totalMessages: 0,
          messagesInRange: 0,
          averageMessagesPerSession: 0,
          averageMessagesPerActiveUser: 0,
          messagesByRole: {},
          messagesWithAttachments: 0,
          messagesWithToolCalls: 0,
          totalTokens: 0,
          totalPromptTokens: 0,
          totalCompletionTokens: 0,
          averageTokensPerMessage: 0,
          sessionsWithWorkPlans: 0,
          newSessionsWithWorkPlans: 0,
          sharedSessions: 0,
          totalToolCalls: 0,
          toolCallsInRange: 0,
          averageToolCallsPerSession: 0,
          averageToolCallsPerActiveUser: 0,
          sessionsWithToolCalls: 0,
          sessionsWithToolCallsInRange: 0,
          toolCallsByFunction: {},
          toolCallsByFunctionInRange: {},
          topTools: [],
          topToolsInRange: [],
          dailyGrowth: [],
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

  const createUserFromWaitlist = useCallback(
    async (email: string, roles: string[] = ["customer"]) => {
      try {
        setLoading(true);
        const response = await api.post(`/api/admin/waitlist/${email}/create-user`, { roles });
        await loadUsers(); // Reload users after creating
        await loadWaitlist(); // Reload waitlist to update status
        setError(null);
        return response.data;
      } catch (err: any) {
        setError(err.response?.data?.message || "Failed to create user");
        throw err; // Re-throw to allow component-level error handling
      } finally {
        setLoading(false);
      }
    },
    [api, loadUsers, loadWaitlist]
  );

  const value = {
    users,
    waitlist,
    taskAnalytics,
    userAnalytics,
    agentModeAnalytics,
    gtmAnalytics,
    crmAnalytics,
    loadUsers,
    loadWaitlist,
    loadAnalytics,
    updateWaitlistStatus,
    updateWaitlistSupportNote,
    deleteWaitlistEntry,
    deleteUser,
    addToWaitlist,
    createUserFromWaitlist,
    loading,
    error,
    isAdmin: user?.isAdmin || false,
    setUsers,
  };

  return (
    <AdminContext.Provider value={value}>{children}</AdminContext.Provider>
  );
};
