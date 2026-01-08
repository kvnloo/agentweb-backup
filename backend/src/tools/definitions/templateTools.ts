/**
 * Template Tools Definitions
 * 
 * Tools for HTML templates and email template management.
 * 
 * UNIFIED DEFINITION: Includes schema, handler config, and intent keywords.
 */

import { ToolDefinition, CategoryConfig } from '../types';
import { registerCategoryConfig } from './utils';

/**
 * Templates category configuration
 */
export const templatesCategory: CategoryConfig = {
  name: 'templates',
  intentPatterns: [
    /\b(html\s*template|email\s*template|newsletter|update\s*html)\b/i
  ],
  categoryKeywords: [
    'html', 'template', 'email', 'newsletter', 'layout'
  ]
};

// Register the category config for aggregation
registerCategoryConfig(templatesCategory);

/**
 * Template tools with unified definitions
 */
export const templateTools: ToolDefinition[] = [
  {
    name: 'list_html_templates',
    version: '1.0.0',
    category: 'templates',
    intentKeywords: ['templates', 'list', 'html', 'email', 'all'],
    schema: {
      description: 'Get a list of all available HTML templates for the user (including email templates)',
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    },
    handler: {
      methodName: 'listHtmlTemplates',
      contextArgs: ['userId']
    }
  },
  {
    name: 'create_html_from_template',
    version: '1.0.0',
    category: 'templates',
    intentKeywords: ['template', 'create', 'html', 'generate', 'email'],
    schema: {
      description: 'Create final HTML from a template by providing variable values and array variable values as JSON strings, then upload to S3',
      parameters: {
        type: 'object',
        properties: {
          template_name: {
            type: 'string',
            description: 'Name of the HTML template to use'
          },
          variable_values_json: {
            type: 'string',
            description: 'JSON string containing regular variable values. Example: {"title": "Hello", "company_name": "Acme Corp"}'
          },
          array_variable_values_json: {
            type: 'string',
            description: 'JSON string containing array variable values. Example: {"features_n": ["Feature 1", "Feature 2"]}'
          }
        },
        required: ['template_name', 'variable_values_json', 'array_variable_values_json']
      }
    },
    handler: {
      methodName: 'createHtmlFromTemplate',
      specialHandler: true  // Uses special handler
    }
  },
  {
    name: 'update_html_file',
    version: '1.0.0',
    category: 'templates',
    intentKeywords: ['html', 'update', 'edit', 'modify', 'replace'],
    schema: {
      description: 'Update an HTML file by replacing specific content with new content. Use update_type="full" with old_content_hash for entire file replacement, or update_type="part" for partial replacements',
      parameters: {
        type: 'object',
        properties: {
          file_url: {
            type: 'string',
            description: 'URL of the HTML file to update (S3 URL or file path)'
          },
          update_type: {
            type: 'string',
            enum: ['part', 'full'],
            description: 'Type of update: "part" for partial content replacement, "full" for entire file replacement'
          },
          replacement_json: {
            type: 'string',
            description: 'JSON string containing replacement instructions. For full: [{"old_content_hash": "...", "new_content": "..."}]. For part: [{"old_content": "...", "new_content": "..."}]'
          }
        },
        required: ['file_url', 'update_type', 'replacement_json']
      }
    },
    handler: {
      methodName: 'updateHtmlFile',
      specialHandler: true  // Uses special handler
    }
  }
];
