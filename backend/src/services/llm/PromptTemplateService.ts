/**
 * Prompt Template Service
 * 
 * Manages prompt templates with versioning and A/B testing support.
 * Templates can be loaded from configuration or database.
 */

import { PromptTemplate, PromptContext, PromptVariable, PromptSection } from './PromptTypes';
import { ALL_PROMPT_SECTIONS, composePrompt, getRequiredSections } from './PromptSections';
import { settingsService } from '../settingsService';

/**
 * Version info for prompts
 */
export interface PromptVersion {
  version: string;
  createdAt: Date;
  description?: string;
  isActive: boolean;
}

/**
 * Prompt Template Service
 */
export class PromptTemplateService {
  private templates = new Map<string, PromptTemplate>();
  private customPromptCache: Map<string, { content: string; timestamp: number }> = new Map();
  private readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  constructor() {
    this.initializeDefaultTemplates();
  }

  /**
   * Initialize default prompt templates
   */
  private initializeDefaultTemplates(): void {
    // Emma marketing assistant template
    const emmaTemplate: PromptTemplate = {
      id: 'emma-marketing',
      name: 'Emma Marketing Assistant',
      version: '2.0.0',
      description: 'Default system prompt for Emma marketing assistant',
      baseContent: composePrompt(ALL_PROMPT_SECTIONS),
      sections: ALL_PROMPT_SECTIONS,
      variables: [
        { name: 'currentDate', description: 'Current date in ISO format', required: true, type: 'date' },
        { name: 'templatesContext', description: 'Available templates context', required: false, type: 'string' },
        { name: 'workPlanContext', description: 'Current work plan context', required: false, type: 'string' }
      ],
      active: true,
      createdAt: new Date('2024-01-01'),
      updatedAt: new Date()
    };

    this.templates.set(emmaTemplate.id, emmaTemplate);

    // Minimal template for quick responses
    const minimalTemplate: PromptTemplate = {
      id: 'emma-minimal',
      name: 'Emma Minimal',
      version: '1.0.0',
      description: 'Minimal prompt for simple queries',
      baseContent: composePrompt(getRequiredSections()),
      sections: getRequiredSections(),
      variables: [
        { name: 'currentDate', description: 'Current date', required: true, type: 'date' }
      ],
      active: true,
      createdAt: new Date('2024-01-01'),
      updatedAt: new Date()
    };

    this.templates.set(minimalTemplate.id, minimalTemplate);
  }

  /**
   * Get a template by ID
   */
  getTemplate(templateId: string): PromptTemplate | undefined {
    return this.templates.get(templateId);
  }

  /**
   * Get default Emma template
   */
  getDefaultTemplate(): PromptTemplate {
    return this.templates.get('emma-marketing')!;
  }

  /**
   * Register a custom template
   */
  registerTemplate(template: PromptTemplate): void {
    this.templates.set(template.id, template);
  }

  /**
   * Render a prompt with context
   */
  renderPrompt(templateId: string, context: PromptContext): string {
    const template = this.templates.get(templateId);
    if (!template) {
      throw new Error(`Template not found: ${templateId}`);
    }

    let content = template.baseContent;

    // Replace variables
    for (const variable of template.variables) {
      const value = context[variable.name] ?? variable.defaultValue ?? '';
      const pattern = new RegExp(`\\{\\{${variable.name}\\}\\}`, 'g');
      content = content.replace(pattern, String(value));
    }

    // Add current date if not already in content
    if (context.currentDate && !content.includes('Current date:')) {
      content += `\n\nCurrent date: ${context.currentDate}`;
    }

    return content;
  }

  /**
   * Get prompt with custom overrides from settings
   */
  async getCustomOrDefaultPrompt(settingName: string, defaultContent: string): Promise<string> {
    // Check cache
    const cached = this.customPromptCache.get(settingName);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL_MS) {
      return cached.content;
    }

    try {
      const setting = await settingsService.getSetting(settingName);
      if (setting?.settingValue) {
        this.customPromptCache.set(settingName, {
          content: setting.settingValue,
          timestamp: Date.now()
        });
        return setting.settingValue;
      }
    } catch (error) {
      console.error(`PromptTemplateService: Error getting setting ${settingName}:`, error);
    }

    return defaultContent;
  }

  /**
   * Get the full Emma system prompt (with custom override support)
   */
  async getEmmaSystemPrompt(): Promise<string> {
    const defaultPrompt = this.getDefaultTemplate().baseContent;
    return this.getCustomOrDefaultPrompt('agent_mode_system_prompt', defaultPrompt);
  }

  /**
   * Get prompt with context (full render)
   */
  async getEmmaSystemPromptWithContext(context: PromptContext): Promise<string> {
    const basePrompt = await this.getEmmaSystemPrompt();
    
    let finalPrompt = basePrompt;
    
    // Add current date
    if (context.currentDate) {
      finalPrompt += `\n\nCurrent date: ${context.currentDate}`;
    }
    
    return finalPrompt;
  }

  /**
   * List all registered templates
   */
  listTemplates(): PromptTemplate[] {
    return Array.from(this.templates.values());
  }

  /**
   * Get template versions (for future versioning support)
   */
  getTemplateVersions(_templateId: string): PromptVersion[] {
    // Placeholder for future versioning support
    // Would query database for version history
    return [{
      version: '2.0.0',
      createdAt: new Date(),
      description: 'Current version',
      isActive: true
    }];
  }

  /**
   * Clear prompt cache
   */
  clearCache(): void {
    this.customPromptCache.clear();
  }
}

// Singleton instance
export const promptTemplateService = new PromptTemplateService();
