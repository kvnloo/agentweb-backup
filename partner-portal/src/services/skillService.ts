import axios from 'axios';
import { API_URL } from '../config';

const api = axios.create({
  baseURL: API_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

export interface Skill {
  skillId: string;
  name: string;
  description: string;
  toolNames: string[];
  systemPrompt?: string;
  isPublished: boolean;
  ownerId?: string;
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

export default {
  getAllSkills,
  getSkill,
  createSkill,
  updateSkill,
  deleteSkill,
  syncSkill,
  getSyncStatus,
};
