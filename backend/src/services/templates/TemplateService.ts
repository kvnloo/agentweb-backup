
import { ToolService } from '../../tools/ServiceRegistry';
import { settingsService } from '../settingsService';

/**
 * Template Service
 * Manages HTML templates.
 */
export class TemplateService implements ToolService {
  readonly serviceName = 'template';

  /**
   * List all HTML templates for the user
   */
  async listHtmlTemplates(userId: string): Promise<any> {
    try {
      const settingName = `email_templates_${userId}`;
      const setting = await settingsService.getSetting(settingName);

      let templates = [];
      if (setting) {
        try {
          templates = JSON.parse(setting.settingValue);
        } catch (error) {
          console.error('TemplateService: Error parsing email templates:', error);
          templates = [];
        }
      }

      return {
        success: true,
        email_templates: templates.map((template: any) => ({
          template_name: template.template_name,
          subject: template.subject,
          variables: template.variables || [],
          arrayVariables: template.arrayVariables || [],
          created_at: template.created_at,
          updated_at: template.updated_at
        }))
      };
    } catch (error) {
      console.error('TemplateService: Error listing email templates:', error);
      return {
        success: false,
        message: 'Failed to list email templates',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }
}

// Singleton instance
export const templateService = new TemplateService();
