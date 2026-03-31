import { Request, Response } from 'express';
import { SettingsService } from '../services/settingsService';
import { extractVariables, parseTemplateArray } from '../utils/templateParser';
import path from 'path';
import fs from 'fs';
import { AuthenticatedRequest } from '../middleware/auth';

const settingsService = new SettingsService();
const MAX_HTML_BYTES = 512 * 1024; // 512KB

export interface HtmlTemplate {
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

// Helper to check old keys during migration
const getOldSettingKey = (userId: string, isPublic?: boolean) => 
  isPublic ? 'email_templates_public' : `email_templates_${userId}`;

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

    const includeLegacyEmail = !typeFilter || typeFilter === 'email';
    const [newUserSetting, newPublicSetting, oldUserSetting, oldPublicSetting] = await Promise.all([
      settingsService.getSetting(`templates_${userId}`),
      settingsService.getSetting('templates_public'),
      includeLegacyEmail ? settingsService.getSetting(`email_templates_${userId}`) : null,
      includeLegacyEmail ? settingsService.getSetting('email_templates_public') : null,
    ]);

    const newUser = parseTemplateArray(newUserSetting);
    const newPublic = parseTemplateArray(newPublicSetting);
    const oldUser: HtmlTemplate[] = parseTemplateArray(oldUserSetting).map((t: HtmlTemplate) =>
      t.type ? t : { ...t, type: ['email'] }
    );
    const oldPublic: HtmlTemplate[] = parseTemplateArray(oldPublicSetting).map((t: HtmlTemplate) =>
      t.type ? t : { ...t, type: ['email'] }
    );

    // Merge logic: new keys win over old keys, user wins over public
    const seen = new Set<string>();
    const merged: HtmlTemplate[] = [];

    // Prioritize newest user-specific templates
    newUser.forEach(t => {
      seen.add(t.template_name);
      merged.push(t);
    });

    // Add new public templates if not overwritten
    newPublic.forEach(t => {
      if (!seen.has(t.template_name)) {
        seen.add(t.template_name);
        merged.push({ ...t, isPublic: true });
      }
    });

    // Fallback to legacy user templates
    oldUser.forEach(t => {
      if (!seen.has(t.template_name)) {
        seen.add(t.template_name);
        merged.push(t);
      }
    });

    // Fallback to legacy public templates
    oldPublic.forEach(t => {
      if (!seen.has(t.template_name)) {
        seen.add(t.template_name);
        merged.push({ ...t, isPublic: true });
      }
    });

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
 * Specifically handles uniqueness checks and renames via original_template_name.
 */
export const saveTemplate = async (req: Request, res: Response) => {
  try {
    const user = getAuthenticatedUser(req, res);
    if (!user) return;
    const userId = user.userId;

    const { 
      template_name, 
      type, 
      html_content, 
      subject, 
      variables, 
      arrayVariables, 
      isPublic,
      original_template_name 
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

    // UNIQNESS & COLLISION CHECK
    if (original_template_name) {
      // It's a Rename or existing update. New name must not clash with OTHER templates.
      if (original_template_name !== template_name) {
        const conflict = templates.find((t: HtmlTemplate) => t.template_name === template_name);
        if (conflict) {
          return res.status(400).json({ error: `A template named "${template_name}" already exists.` });
        }
      }
    } else {
      // New Create. Must not clash with any existing name.
      const conflict = templates.find((t: HtmlTemplate) => t.template_name === template_name);
      if (conflict) {
        return res.status(400).json({ error: `A template named "${template_name}" already exists.` });
      }
    }

    const now = new Date().toISOString();
    const isEmail = Array.isArray(type) && type.includes('email');
    let createdAt = now;
    let existingIdx = -1;

    // FIND EXISTING ENTRY FOR UPDATE
    if (original_template_name) {
      existingIdx = templates.findIndex((t: any) => t.template_name === original_template_name);
      if (existingIdx >= 0) {
        createdAt = templates[existingIdx].created_at || now;
      } else {
        // Migration: check legacy keys (email_templates_*)
        const oldKey = getOldSettingKey(userId, isPublic);
        const oldSetting = await settingsService.getSetting(oldKey);
        const oldTemplates = parseTemplateArray(oldSetting);
        const oldIdx = oldTemplates.findIndex((t: any) => t.template_name === original_template_name);
        if (oldIdx >= 0) {
          createdAt = oldTemplates[oldIdx].created_at || now;
        }
      }
    } else {
      // Safety check if original_template_name wasn't sent but it exists anyway
      existingIdx = templates.findIndex((t: any) => t.template_name === template_name);
      if (existingIdx >= 0) {
        createdAt = templates[existingIdx].created_at || now;
      }
    }

    const newTemplate = {
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

    const { templateName } = req.params;
    const isPublic = req.query.isPublic === 'true';

    if (isPublic && !user.isAdmin) {
      return res.status(403).json({ error: 'Only admins can delete public templates' });
    }

    const targetKey = getSettingKey(userId, isPublic);
    const existingSetting = await settingsService.getSetting(targetKey);
    let templates = parseTemplateArray(existingSetting);

    const filtered = templates.filter((t: HtmlTemplate) => t.template_name !== templateName);

    if (filtered.length !== templates.length) {
      await settingsService.setSetting(
        targetKey,
        JSON.stringify(filtered),
        isPublic ? 'Public templates' : 'User templates',
        user.email || 'system'
      );
      return res.json({ success: true, message: 'Template deleted' });
    }

    // Try deleting from legacy keys if not in new key
    const oldKey = getOldSettingKey(userId, isPublic);
    const oldSetting = await settingsService.getSetting(oldKey);
    let oldTemplates = parseTemplateArray(oldSetting);
    const oldFiltered = oldTemplates.filter((t: any) => t.template_name !== templateName);
    
    if (oldFiltered.length !== oldTemplates.length) {
      await settingsService.setSetting(
        oldKey,
        JSON.stringify(oldFiltered),
        isPublic ? 'Legacy public email templates' : 'Legacy user email templates',
        user.email || 'system'
      );
      return res.json({ success: true, message: 'Template deleted from legacy storage' });
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
    const { templateName } = req.params;
    const user = getAuthenticatedUser(req, res);
    if (!user) return;
    const userId = user.userId;

    // 1. Try DynamoDB (New + Old keys)
    const [userNew, pubNew, userOld, pubOld] = await Promise.all([
      settingsService.getSetting(`templates_${userId}`),
      settingsService.getSetting('templates_public'),
      settingsService.getSetting(`email_templates_${userId}`),
      settingsService.getSetting('email_templates_public'),
    ]);

    const all = [
      ...parseTemplateArray(userNew),
      ...parseTemplateArray(pubNew),
      ...parseTemplateArray(userOld),
      ...parseTemplateArray(pubOld),
    ];

    const found = all.find(t => t.template_name === templateName);
    if (found) {
      res.setHeader('Content-Type', 'text/html');
      return res.send(found.html_content);
    }

    // 2. Legacy Filesystem Fallback
    if (templateName === 'default-v2' || templateName === 'landing-page-v2') {
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
