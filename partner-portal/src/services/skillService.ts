import axios from 'axios';
import { API_URL } from '../config';

const api = axios.create({
  baseURL: API_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

export type SkillTriggerMode = 'install_only' | 'on_demand' | 'scheduled' | 'both';
export type SkillCategory = 'marketing' | 'content' | 'analytics' | 'research' | 'outreach' | 'operations' | 'other';

export interface SkillSchedule {
  frequency: 'daily' | 'weekly' | 'monthly' | 'custom';
  preferredTime?: string;
  deliveryChannels?: string[];
  cronExpression?: string;
}

export interface Skill {
  skillId: string;
  name: string;
  description: string;
  toolNames: string[];
  systemPrompt?: string;
  isPublished: boolean;
  ownerId?: string;
  ownerEmail?: string;
  visibility?: 'system' | 'private' | 'public' | 'pending_review';
  reviewFeedback?: string;
  category?: SkillCategory;
  triggerMode?: SkillTriggerMode;
  schedule?: SkillSchedule;
  welcomeMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export type AssignmentStatus = 'active' | 'paused' | 'completed' | 'error';

export interface SkillAssignment {
  assignmentId: string;
  skillId: string;
  userId: string;
  status: AssignmentStatus;
  schedule?: SkillSchedule;
  nextRunTime?: string;
  lastRunTime?: string;
  lastRunResult?: string;
  config?: Record<string, any>;
  createdAt: string;
  updatedAt: string;
}

export const getAllSkills = async (token: string): Promise<Skill[]> => {
  try {
    const response = await api.get('/api/skills', {
      headers: { Authorization: `Bearer ${token}` },
    });
    return response.data;
  } catch (error) {
    console.error('Error fetching skills:', error);
    throw error;
  }
};

export const getSkill = async (skillId: string, token: string): Promise<Skill> => {
  try {
    const response = await api.get(`/api/skills/${skillId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return response.data;
  } catch (error) {
    console.error(`Error fetching skill ${skillId}:`, error);
    throw error;
  }
};

export const createSkill = async (skillData: Partial<Skill>, token: string): Promise<Skill> => {
  try {
    const response = await api.post('/api/skills', skillData, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return response.data;
  } catch (error) {
    console.error('Error creating skill:', error);
    throw error;
  }
};

export const updateSkill = async (skillId: string, updates: Partial<Skill>, token: string): Promise<Skill> => {
  try {
    const response = await api.put(`/api/skills/${skillId}`, updates, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return response.data;
  } catch (error) {
    console.error(`Error updating skill ${skillId}:`, error);
    throw error;
  }
};

export const deleteSkill = async (skillId: string, token: string): Promise<void> => {
  try {
    await api.delete(`/api/skills/${skillId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (error) {
    console.error(`Error deleting skill ${skillId}:`, error);
    throw error;
  }
};

export type SyncDirection = 'prod-to-dev' | 'dev-to-prod';

export interface SkillSyncInfo {
  inSync: boolean;
  existsInProd: boolean;
  existsInDev: boolean;
  changedFields: string[];
}

export interface SyncStatusResponse {
  skills: Record<string, SkillSyncInfo>;
  environment: 'development' | 'production';
}

export const getSyncStatus = async (token: string): Promise<SyncStatusResponse> => {
  try {
    const response = await api.get('/api/skills/sync-status', {
      headers: { Authorization: `Bearer ${token}` },
    });
    return response.data;
  } catch (error) {
    console.error('Error fetching sync status:', error);
    return { skills: {}, environment: 'production' };
  }
};

export const syncSkill = async (skillId: string, direction: SyncDirection, token: string): Promise<Skill> => {
  try {
    const response = await api.post('/api/skills/sync', { skillId, direction }, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return response.data;
  } catch (error) {
    console.error(`Error syncing skill ${skillId}:`, error);
    throw error;
  }
};

// ── Skill Assignment API calls ────────────────────────────────────────────────

export const getSkillAssignments = async (skillId: string, token: string): Promise<SkillAssignment[]> => {
  try {
    const response = await api.get(`/api/admin/skills/${skillId}/assignments`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return response.data;
  } catch (error) {
    console.error(`Error fetching assignments for skill ${skillId}:`, error);
    throw error;
  }
};

export const createSkillAssignment = async (
  skillId: string,
  data: { userId: string; status?: AssignmentStatus; schedule?: SkillSchedule; config?: Record<string, any> },
  token: string,
): Promise<SkillAssignment> => {
  try {
    const response = await api.post(`/api/admin/skills/${skillId}/assignments`, data, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return response.data;
  } catch (error) {
    console.error('Error creating skill assignment:', error);
    throw error;
  }
};

export const updateSkillAssignment = async (
  assignmentId: string,
  updates: Partial<Pick<SkillAssignment, 'status' | 'schedule' | 'nextRunTime' | 'config'>>,
  token: string,
): Promise<SkillAssignment> => {
  try {
    const response = await api.put(`/api/admin/skill-assignments/${assignmentId}`, updates, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return response.data;
  } catch (error) {
    console.error(`Error updating assignment ${assignmentId}:`, error);
    throw error;
  }
};

export const deleteSkillAssignment = async (assignmentId: string, token: string): Promise<void> => {
  try {
    await api.delete(`/api/admin/skill-assignments/${assignmentId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (error) {
    console.error(`Error deleting assignment ${assignmentId}:`, error);
    throw error;
  }
};

export default {
  getAllSkills,
  getSkill,
  createSkill,
  updateSkill,
  deleteSkill,
  syncSkill,
  getSyncStatus,
  getSkillAssignments,
  createSkillAssignment,
  updateSkillAssignment,
  deleteSkillAssignment,
};
