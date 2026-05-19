/**
 * htmlTemplateService.ts
 *
 * Manages HTML templates stored in AW-Settings (no separate table).
 *
 * Storage keys:
 *   templates_<userId>   — per-user private templates (JSON-stringified array)
 *   templates_public     — admin-published public templates
 *
 * This keeps full backward compatibility with the legacy controller
 * (htmlTemplatesController.ts) field names.
 */
import { settingsService } from "./settingsService";
import { v4 as uuidv4 } from "uuid";

export interface HtmlTemplate {
  template_id: string;
  template_name: string;
  type: ("email" | "landing_page")[];
  subject?: string;
  html_content: string;
  variables?: string[];
  arrayVariables?: string[];
  created_at: string;
  updated_at: string;
}

const USER_KEY = (userId: string): string => `templates_${userId}`;
const PUBLIC_KEY = "templates_public";

async function readRow(key: string): Promise<HtmlTemplate[]> {
  const row = await settingsService.getSetting(key);
  if (!row?.settingValue) return [];
  try {
    const parsed = JSON.parse(row.settingValue);
    return Array.isArray(parsed) ? parsed.map(normalize) : [];
  } catch {
    return [];
  }
}

function normalize(t: any): HtmlTemplate {
  return {
    ...t,
    type: Array.isArray(t.type) ? t.type : t.type ? [t.type] : ["email"],
    template_id: t.template_id || uuidv4(),
  } as HtmlTemplate;
}

async function writeRow(
  key: string,
  templates: HtmlTemplate[],
  updatedBy: string,
): Promise<void> {
  await settingsService.setSetting(
    key,
    JSON.stringify(templates),
    "User templates",
    updatedBy,
  );
}

export const htmlTemplateService = {
  async getTemplatesByOwner(userId: string): Promise<HtmlTemplate[]> {
    return readRow(USER_KEY(userId));
  },

  async getPublicTemplates(): Promise<HtmlTemplate[]> {
    return readRow(PUBLIC_KEY);
  },

  async getTemplate(
    templateId: string,
    ownerUserId: string,
  ): Promise<HtmlTemplate | null> {
    const all = await readRow(USER_KEY(ownerUserId));
    return all.find((t) => t.template_id === templateId) ?? null;
  },

  async getPublicTemplate(templateId: string): Promise<HtmlTemplate | null> {
    const all = await readRow(PUBLIC_KEY);
    return all.find((t) => t.template_id === templateId) ?? null;
  },

  async createTemplate(
    ownerUserId: string,
    input: Omit<HtmlTemplate, "template_id" | "created_at" | "updated_at">,
    updatedBy: string,
  ): Promise<HtmlTemplate> {
    const all = await readRow(USER_KEY(ownerUserId));
    const now = new Date().toISOString();
    const tpl: HtmlTemplate = {
      ...input,
      template_id: uuidv4(),
      created_at: now,
      updated_at: now,
    };
    all.push(tpl);
    await writeRow(USER_KEY(ownerUserId), all, updatedBy);
    return tpl;
  },

  async updateTemplate(
    templateId: string,
    ownerUserId: string,
    fields: Partial<Omit<HtmlTemplate, "template_id" | "created_at">>,
    updatedBy: string,
  ): Promise<HtmlTemplate | null> {
    const all = await readRow(USER_KEY(ownerUserId));
    const idx = all.findIndex((t) => t.template_id === templateId);
    if (idx === -1) return null;
    const next: HtmlTemplate = {
      ...all[idx],
      ...fields,
      updated_at: new Date().toISOString(),
    };
    all[idx] = next;
    await writeRow(USER_KEY(ownerUserId), all, updatedBy);
    return next;
  },

  async deleteTemplate(
    templateId: string,
    ownerUserId: string,
    updatedBy: string,
  ): Promise<boolean> {
    const all = await readRow(USER_KEY(ownerUserId));
    const next = all.filter((t) => t.template_id !== templateId);
    if (next.length === all.length) return false;
    await writeRow(USER_KEY(ownerUserId), next, updatedBy);
    return true;
  },

  /**
   * Move ALL templates from one user's row to another's.
   * Used by member-removal "transfer" decision (bulk, single call).
   */
  async transferAllTemplates(
    fromUserId: string,
    toUserId: string,
    updatedBy: string,
  ): Promise<number> {
    const fromAll = await readRow(USER_KEY(fromUserId));
    if (fromAll.length === 0) return 0;
    const toAll = await readRow(USER_KEY(toUserId));
    await writeRow(USER_KEY(toUserId), [...toAll, ...fromAll], updatedBy);
    await writeRow(USER_KEY(fromUserId), [], updatedBy);
    return fromAll.length;
  },

  /**
   * Delete ALL templates for a user.
   * Used by member-removal "delete" decision (bulk, single call).
   */
  async deleteAllTemplates(userId: string, updatedBy: string): Promise<number> {
    const all = await readRow(USER_KEY(userId));
    if (all.length === 0) return 0;
    await writeRow(USER_KEY(userId), [], updatedBy);
    return all.length;
  },
};
