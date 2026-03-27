import { scheduleTemplateDb } from './db';

export type ScheduleTemplateVisibility = 'system' | 'private' | 'public' | 'pending_review';

export interface ScheduleTemplate {
  templateId: string;
  createdBy: string;
  name: string;
  description?: string;
  category: string;
  visibility: ScheduleTemplateVisibility;
  startingMessage: string;
  variables?: Array<{ name: string; description?: string; type?: 'text' | 'long_text' | 'file' }>;
  keywords?: string[];
  requiredFunctionCalls?: string[];
  functionCallMinCalls?: { [functionName: string]: number };
  suggestedFrequency?: string;
  frequencyIntervalDays?: number;
  emailNotifications?: string[];
  dailyDigest?: boolean;
  llmModel?: string;
  usageCount?: number;
  reviewFeedback?: string;
  createdAt: string;
  updatedAt: string;
}

/** Normalize legacy 'platform' visibility to 'system' */
function normalizeVisibility(template: any): any {
  if (template && template.visibility === 'platform') {
    template.visibility = 'system';
  }
  return template;
}

class ScheduleTemplateService {
  async getAllTemplates(): Promise<ScheduleTemplate[]> {
    const templates = await scheduleTemplateDb.getAllTemplates();
    return (templates || []).map(normalizeVisibility);
  }

  async getTemplateById(templateId: string): Promise<ScheduleTemplate | null> {
    const template = await scheduleTemplateDb.getTemplateById(templateId);
    return template ? normalizeVisibility(template) : null;
  }

  async getTemplatesByVisibility(visibility: ScheduleTemplateVisibility): Promise<ScheduleTemplate[]> {
    const templates = await scheduleTemplateDb.getTemplatesByVisibility(visibility);
    return (templates || []).map(normalizeVisibility);
  }

  async getTemplatesByCreator(createdBy: string): Promise<ScheduleTemplate[]> {
    const templates = await scheduleTemplateDb.getTemplatesByCreator(createdBy);
    return (templates || []).map(normalizeVisibility);
  }

  /** Get templates visible to regular users: system + public */
  async getPublicTemplatesForUsers(): Promise<ScheduleTemplate[]> {
    const [systemTemplates, publicTemplates] = await Promise.all([
      this.getTemplatesByVisibility('system'),
      this.getTemplatesByVisibility('public'),
    ]);
    return [...systemTemplates, ...publicTemplates];
  }

  async submitForReview(templateId: string, ownerId: string): Promise<ScheduleTemplate> {
    const template = await this.getTemplateById(templateId);
    if (!template) throw new Error('Template not found');
    if (template.createdBy !== ownerId) throw new Error('Not authorized');
    if (template.visibility !== 'private') throw new Error('Only private templates can be submitted for review');

    const updated = await scheduleTemplateDb.updateTemplate(templateId, {
      visibility: 'pending_review',
      reviewFeedback: '',
      updatedAt: new Date().toISOString(),
    });
    return normalizeVisibility(updated || template);
  }

  async approveTemplate(templateId: string): Promise<ScheduleTemplate> {
    const template = await this.getTemplateById(templateId);
    if (!template) throw new Error('Template not found');
    if (template.visibility !== 'pending_review') throw new Error('Template is not pending review');

    const updated = await scheduleTemplateDb.updateTemplate(templateId, {
      visibility: 'public',
      updatedAt: new Date().toISOString(),
    });
    return normalizeVisibility(updated || template);
  }

  async rejectTemplate(templateId: string, feedback: string): Promise<ScheduleTemplate> {
    const template = await this.getTemplateById(templateId);
    if (!template) throw new Error('Template not found');
    if (template.visibility !== 'pending_review') throw new Error('Template is not pending review');

    const updated = await scheduleTemplateDb.updateTemplate(templateId, {
      visibility: 'private',
      reviewFeedback: feedback,
      updatedAt: new Date().toISOString(),
    });
    return normalizeVisibility(updated || template);
  }
}

export const scheduleTemplateService = new ScheduleTemplateService();
