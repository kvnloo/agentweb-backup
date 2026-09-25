/**
 * ENG-2103 (F2) — shared HTML-template storage reader.
 *
 * Extracted verbatim from `AgentModeService.prototype.getTemplatesForUser`.
 * Shared by `emma/impl/htmlTools.ts`'s `listHtmlTemplates` (this extraction)
 * and `AgentModeService.prototype.findTemplateById` (used internally by
 * `createHtmlFromTemplate`, a different, not-yet-extracted cluster — deferred
 * because it calls `this.callLLM` directly, the core LLM gateway, which needs
 * its own design decision rather than the "promote a pure helper" treatment
 * every other extraction so far has used).
 */

export async function getTemplatesForUser(userId: string): Promise<{ userTemplates: any[], publicTemplates: any[] }> {
  // Lazy require, not a top-level import: settingsService.ts constructs a real
  // AWS.DynamoDB.DocumentClient at module load. A static import here would
  // drag that into every importer of this standalone module (ENG-1816 F1's
  // lesson-lazy-require-aws-sdk-modules postmortem) — same treatment as every
  // other emma/impl/shared/* module that touches settingsService.
  const { settingsService } = require('../../../services/settingsService') as typeof import('../../../services/settingsService');
  const [newUserSetting, newPublicSetting] = await Promise.all([
    settingsService.getSetting(`templates_${userId}`),
    settingsService.getSetting('templates_public'),
  ]);

  const parse = (s: any): any[] => {
    if (!s?.settingValue) return [];
    try { return JSON.parse(s.settingValue); } catch { return []; }
  };

  const userTemplates = parse(newUserSetting);
  const publicTemplates = parse(newPublicSetting);

  return { userTemplates, publicTemplates };
}
