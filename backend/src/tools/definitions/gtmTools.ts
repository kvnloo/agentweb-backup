/**
 * GTM (Go-To-Market) Tools Definitions
 * 
 * Tools for managing Go-To-Market plans.
 * 
 * UNIFIED DEFINITION: Includes schema, handler config, and intent keywords.
 */

import { ToolDefinition, CategoryConfig } from '../types';
import { registerCategoryConfig } from './utils';

/**
 * GTM category configuration
 */
export const gtmCategory: CategoryConfig = {
  name: 'gtm',
  intentPatterns: [
    /\b(gtm|go[\s-]to[\s-]market|launch\s*plan|market\s*entry)\b/i
  ],
  categoryKeywords: [
    'gtm', 'market', 'launch', 'entry', 'expansion', 'gomarket'
  ]
};

// Register the category config for aggregation
registerCategoryConfig(gtmCategory);

/**
 * GTM tools with unified definitions
 */
export const gtmTools: ToolDefinition[] = [
  {
    name: 'list_gtm_plans',
    version: '1.0.0',
    category: 'gtm',
    intentKeywords: ['gtm', 'plans', 'list', 'all', 'show'],
    schema: {
      description: 'List all GTM plans for the user. Returns plan IDs, titles, descriptions, phase counts, and creation dates.',
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    },
    handler: {
      methodName: 'listGTMPlans',
      contextArgs: ['userId']
    }
  },
  {
    name: 'read_gtm_plan',
    version: '1.0.0',
    category: 'gtm',
    intentKeywords: ['gtm', 'plan', 'read', 'get', 'details'],
    schema: {
      description: 'Read a specific GTM plan by its plan ID. Returns complete plan details including all phases and work items with their statuses.',
      parameters: {
        type: 'object',
        properties: {
          plan_id: {
            type: 'string',
            description: 'The unique identifier of the GTM plan to read'
          }
        },
        required: ['plan_id']
      }
    },
    handler: {
      methodName: 'readGTMPlan',
      contextArgs: ['userId']
    }
  },
  {
    name: 'create_gtm_plan',
    version: '1.0.0',
    category: 'gtm',
    intentKeywords: ['gtm', 'plan', 'create', 'new', 'launch'],
    schema: {
      description: 'Create a new GTM plan with a title, optional description, optional DRI, and optional phases with work items.',
      parameters: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'Title of the GTM plan'
          },
          description: {
            type: 'string',
            description: 'Optional description of the GTM plan'
          },
          dri: {
            type: 'string',
            description: 'Optional DRI (Directly Responsible Individual) email address at plan level'
          },
          phases: {
            type: 'array',
            description: 'Optional array of phases to create with the plan',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string', description: 'Phase title' },
                description: { type: 'string', description: 'Optional phase description' },
                duration: { type: 'number', description: 'Phase duration in days' },
                dri: { type: 'string', description: 'Optional DRI email for this phase' },
                workItems: {
                  type: 'array',
                  description: 'Optional array of work items for this phase',
                  items: {
                    type: 'object',
                    properties: {
                      title: { type: 'string', description: 'Work item title' },
                      description: { type: 'string', description: 'Optional description' },
                      duration: { type: 'number', description: 'Optional duration in days' },
                      dri: { type: 'string', description: 'Optional DRI email for this work item' }
                    },
                    required: ['title']
                  }
                }
              },
              required: ['title', 'duration']
            }
          }
        },
        required: ['title']
      }
    },
    handler: {
      methodName: 'createGTMPlan',
      customArgOrder: ['args.title', 'args.description', 'args.dri', 'args.phases', 'context.userId']
    }
  }
];
