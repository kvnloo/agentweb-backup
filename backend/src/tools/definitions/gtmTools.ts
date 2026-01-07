/**
 * GTM (Go-To-Market) Tools Definitions
 * 
 * Tools for managing Go-To-Market plans.
 */

import { ToolDefinition } from '../types';

export const gtmTools: ToolDefinition[] = [
  {
    name: 'list_gtm_plans',
    version: '1.0.0',
    category: 'gtm',
    schema: {
      description: 'List all GTM plans for the user. Returns plan IDs, titles, descriptions, phase counts, and creation dates.',
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    }
  },
  {
    name: 'read_gtm_plan',
    version: '1.0.0',
    category: 'gtm',
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
    }
  },
  {
    name: 'create_gtm_plan',
    version: '1.0.0',
    category: 'gtm',
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
    }
  }
];
