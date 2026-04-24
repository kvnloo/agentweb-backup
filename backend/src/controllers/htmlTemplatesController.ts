import { Request, Response } from 'express';
import { SettingsService } from '../services/settingsService';
import { extractVariables, parseTemplateArray } from '../utils/templateParser';
import path from 'path';
import fs from 'fs';
import { AuthenticatedRequest } from '../middleware/auth';
import { randomUUID } from 'node:crypto';

const settingsService = new SettingsService();
const MAX_HTML_BYTES = 512 * 1024; // 512KB

export interface HtmlTemplate {
  template_id: string;
  template_name: string;
  type: string[];
  subject?: string;
  html_content: string;
  variables: string[];
  arrayVariables: string[];
  created_at?: string;
  updated_at?: string;
  isPublic?: boolean;
}

/**
 * HTML Templates Controller (Unified Templates System)
 * Manages Email and Landing Page templates in DynamoDB settings.
 */

// Helper to determine the target DynamoDB key
const getSettingKey = (userId: string, isPublic?: boolean) => 
  isPublic ? 'templates_public' : `templates_${userId}`;


const getAuthenticatedUser = (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  if (!authReq.user) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
  return authReq.user;
};

/**
 * GET All Templates
 * Supports filtering by 'type' (email|landing_page)
 */
export const getTemplates = async (req: Request, res: Response) => {
  try {
    const user = getAuthenticatedUser(req, res);
    if (!user) return;
    const userId = user.userId;

    const typeFilter = req.query.type as string;
    const scopePublicOnly = req.query.scope === 'public';

    const [newUserSetting, newPublicSetting] = await Promise.all([
      scopePublicOnly ? Promise.resolve(null) : settingsService.getSetting(`templates_${userId}`),
      settingsService.getSetting('templates_public'),
    ]);

    const newPublic: HtmlTemplate[] = parseTemplateArray(newPublicSetting).map((t: HtmlTemplate) =>
      t.type ? t : { ...t, type: ['email'] }
    );

    let merged: HtmlTemplate[];
    if (scopePublicOnly) {
      merged = newPublic.map((t: HtmlTemplate) => ({ ...t, isPublic: true }));
    } else {
      const newUser: HtmlTemplate[] = parseTemplateArray(newUserSetting).map((t: HtmlTemplate) =>
        t.type ? t : { ...t, type: ['email'] }
      );
      merged = [
        ...newUser,
        ...newPublic.map((t: HtmlTemplate) => ({ ...t, isPublic: true })),
      ];
    }

    const result = typeFilter
      ? merged.filter((t: HtmlTemplate) => Array.isArray(t.type) && t.type.includes(typeFilter))
      : merged;

    res.json({ templates: result });
  } catch (error) {
    console.error('[HTML TEMPLATES] Error listing templates:', error);
    res.status(500).json({ error: 'Failed to get templates' });
  }
};

/**
 * SAVE (Create or Update) Template
 * Uses template_id for updates and allows duplicate names.
 */
export const saveTemplate = async (req: Request, res: Response) => {
  try {
    const user = getAuthenticatedUser(req, res);
    if (!user) return;
    const userId = user.userId;

    const { 
      template_id,
      template_name,
      type,
      html_content,
      subject,
      variables,
      arrayVariables,
      isPublic
    } = req.body;

    // validation
    if (!template_name || !type || !html_content) {
      return res.status(400).json({ error: 'template_name, type, and html_content are required' });
    }
    if (!Array.isArray(type) || type.length === 0) {
      return res.status(400).json({ error: 'type must be a non-empty array' });
    }
    if (isPublic && !user.isAdmin) {
      return res.status(403).json({ error: 'Only admins can manage public templates' });
    }
    if (Buffer.byteLength(html_content, 'utf-8') > MAX_HTML_BYTES) {
      return res.status(413).json({ error: 'html_content exceeds 512KB limit' });
    }

    // Extraction fallback
    let finalVariables = variables;
    let finalArrayVariables = arrayVariables;
    if (!finalVariables || !finalArrayVariables) {
      const extracted = extractVariables(html_content, subject);
      finalVariables = extracted.variables;
      finalArrayVariables = extracted.arrayVariables;
    }

    const targetKey = getSettingKey(userId, isPublic);
    const existingSetting = await settingsService.getSetting(targetKey);
    let templates = parseTemplateArray(existingSetting);

    const now = new Date().toISOString();
    const isEmail = Array.isArray(type) && type.includes('email');
    let createdAt = now;
    let existingIdx = -1;

    if (template_id) {
      existingIdx = templates.findIndex((t: any) => t.template_id === template_id);
      if (existingIdx >= 0) {
        createdAt = templates[existingIdx].created_at || now;
      } else {
        // Template not found in the target key.
        // Only admins may move a template between user/public by toggling isPublic.
        // Non-admins get a plain 404 — they cannot trigger a cross-key move.
        if (!user.isAdmin) {
          return res.status(404).json({ error: 'Template not found' });
        }
        // Admin cross-key move: template lives in the opposite key.
        // e.g. moving to public → source is templates_{userId}, and vice versa.
        const sourceKey = getSettingKey(userId, !isPublic);
        const sourceSetting = await settingsService.getSetting(sourceKey);
        const sourceTemplates = parseTemplateArray(sourceSetting);
        const sourceIdx = sourceTemplates.findIndex((t: any) => t.template_id === template_id);
        if (sourceIdx < 0) {
          return res.status(404).json({ error: 'Template not found' });
        }
        createdAt = sourceTemplates[sourceIdx].created_at || now;
        // Keep a copy so we can write to target first (avoid data loss on failure).
        const sourceTemplate = sourceTemplates[sourceIdx];

        // Write sourceTemplate to target first (safety write — ensures the template
        // exists in the target key even if the process crashes before the final write).
        // If a stale copy with the same ID already exists in target, overwrite it.
        const targetIdx = templates.findIndex((t: any) => t.template_id === template_id);
        if (targetIdx >= 0) {
          templates[targetIdx] = sourceTemplate;
          existingIdx = targetIdx;
        } else {
          templates.push(sourceTemplate);
          existingIdx = templates.length - 1;
        }
        await settingsService.setSetting(
          targetKey,
          JSON.stringify(templates),
          isPublic ? 'Public templates' : 'User templates',
          user.email
        );

        // Now remove from source so the template doesn't exist in both places.
        sourceTemplates.splice(sourceIdx, 1);
        await settingsService.setSetting(
          sourceKey,
          JSON.stringify(sourceTemplates),
          isPublic ? 'User templates' : 'Public templates',
          user.email
        );
        // existingIdx is now set — the final write below will correctly overwrite
        // the sourceTemplate entry with the fully updated newTemplate.
      }
    }

    const newTemplate = {
      template_id: template_id || randomUUID(),
      template_name,
      type,
      ...(isEmail ? { subject: subject || '' } : {}),
      html_content,
      variables: finalVariables,
      arrayVariables: finalArrayVariables,
      created_at: createdAt,
      updated_at: now,
      ...(isPublic ? { isPublic: true } : {}),
    };

    if (existingIdx >= 0) {
      templates[existingIdx] = newTemplate;
    } else {
      templates.push(newTemplate);
    }

    await settingsService.setSetting(
      targetKey,
      JSON.stringify(templates),
      isPublic ? 'Public templates' : 'User templates',
      user.email
    );

    res.json({ success: true, message: 'Template saved successfully', template: newTemplate });
  } catch (error) {
    console.error('[HTML TEMPLATES] Error saving template:', error);
    res.status(500).json({ error: 'Failed to save template' });
  }
};

/**
 * DELETE Template
 */
export const deleteTemplate = async (req: Request, res: Response) => {
  try {
    const user = getAuthenticatedUser(req, res);
    if (!user) return;
    const userId = user.userId;

    const { templateId } = req.params;
    const isPublic = req.query.isPublic === 'true';

    if (isPublic && !user.isAdmin) {
      return res.status(403).json({ error: 'Only admins can delete public templates' });
    }

    const key = getSettingKey(userId, isPublic);
    const setting = await settingsService.getSetting(key);
    const list = parseTemplateArray(setting);
    const filtered = list.filter((t: HtmlTemplate) => t.template_id !== templateId);

    if (filtered.length !== list.length) {
      await settingsService.setSetting(key, JSON.stringify(filtered), key, user.email || 'system');
      return res.json({ success: true, message: 'Template deleted' });
    }

    res.status(404).json({ error: 'Template not found' });
  } catch (error) {
    console.error('[HTML TEMPLATES] Error deleting template:', error);
    res.status(500).json({ error: 'Failed to delete template' });
  }
};

/**
 * PREVIEW Template (GET)
 * Supports filesystem fallback for legacy compatibility.
 */
export const getPreviewTemplate = async (req: Request, res: Response) => {
  try {
    const { templateId } = req.params;
    const user = getAuthenticatedUser(req, res);
    if (!user) return;
    const userId = user.userId;

    // 1. Try DynamoDB (New keys only)
    const [userNew, pubNew] = await Promise.all([
      settingsService.getSetting(`templates_${userId}`),
      settingsService.getSetting('templates_public'),
    ]);

    const all = [
      ...parseTemplateArray(userNew),
      ...parseTemplateArray(pubNew),
    ];

    const found = all.find(t => t.template_id === templateId);
    if (found) {
      res.setHeader('Content-Type', 'text/html');
      return res.send(found.html_content);
    }

    // 2. Legacy Filesystem Fallback
    if (templateId === 'default-v2' || templateId === 'landing-page-v2') {
      try {
        const filePath = path.join(__dirname, '..', 'templates', 'landing-page-v2.html');
        if (fs.existsSync(filePath)) {
          const html = await fs.promises.readFile(filePath, 'utf-8');
          res.setHeader('Content-Type', 'text/html');
          return res.send(html);
        }
      } catch (err) {
        console.error('[HTML TEMPLATES] FS fallback failed:', err);
      }
    }

    res.status(404).json({ error: 'Template not found' });
  } catch (error) {
    console.error('[HTML TEMPLATES] Preview error:', error);
    res.status(500).json({ error: 'Failed to load preview' });
  }
};
