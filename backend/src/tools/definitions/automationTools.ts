/**
 * Automation Tools Definitions
 * 
 * Tools for task creation, work plans, and automation workflows.
 * 
 * UNIFIED DEFINITION: Includes schema, handler config, and intent keywords.
 */

import { ToolDefinition, CategoryConfig } from '../types';
import { registerCategoryConfig } from './utils';

/**
 * Automation category configuration
 */
export const automationCategory: CategoryConfig = {
  name: 'automation',
  intentPatterns: [
    /\b(task|template|work\s*plan|schedule|revision|automate|automation|workflow)\b/i
  ],
  categoryKeywords: [
    'task', 'template', 'work', 'plan', 'schedule', 'revision',
    'automate', 'automation', 'workflow', 'process'
  ]
};

// Register the category config for aggregation
registerCategoryConfig(automationCategory);

/**
 * Automation tools with unified definitions
 */
export const automationTools: ToolDefinition[] = [
  {
    name: 'create_task_from_template',
    version: '1.0.0',
    category: 'automation',
    intentKeywords: ['task', 'template', 'create', 'automation'],
    schema: {
      description: 'Create a web automation task using a specific template with the provided parameters',
      parameters: {
        type: 'object',
        properties: {
          template_id: {
            type: 'string',
            description: 'The ID of the template to use for creating the task'
          },
          parameters_json: {
            type: 'string',
            description: 'JSON string containing parameter values where keys are parameter names and values are the actual values. Example: {"site_url": "example.com", "business_area": "e-commerce"}'
          },
          attach_previous_task_results: {
            type: 'boolean',
            description: 'Whether to attach previous task results to this task.',
            default: true
          },
          attached_file_urls: {
            type: 'array',
            items: { type: 'string' },
            description: 'Array of file URLs to attach to this task.',
            default: []
          },
          async: {
            type: 'boolean',
            description: 'Whether to execute the task asynchronously. If false, the function will wait for task completion.',
            default: false
          }
        },
        required: ['template_id', 'parameters_json']
      }
    },
    handler: {
      methodName: 'createTaskFromTemplate',
      specialHandler: true  // Uses special handler in specialHandlers.ts
    }
  },
  {
    name: 'create_task_from_prompt',
    version: '1.0.0',
    category: 'automation',
    intentKeywords: ['task', 'prompt', 'create', 'custom'],
    schema: {
      description: 'Create a web automation task using a raw prompt when no suitable template is available',
      parameters: {
        type: 'object',
        properties: {
          task_name: {
            type: 'string',
            description: 'Name for the task'
          },
          prompt: {
            type: 'string',
            description: 'The raw prompt/instructions for the task'
          },
          category: {
            type: 'string',
            description: 'Category for the task (e.g., Research, Marketing, Analysis)'
          },
          attach_previous_task_results: {
            type: 'boolean',
            description: 'Whether to attach previous task results to this task.',
            default: true
          },
          attached_file_urls: {
            type: 'array',
            items: { type: 'string' },
            description: 'Array of file URLs to attach to this task.',
            default: []
          },
          async: {
            type: 'boolean',
            description: 'Whether to execute the task asynchronously.',
            default: false
          }
        },
        required: ['task_name', 'prompt', 'category']
      }
    },
    handler: {
      methodName: 'createTaskFromPrompt',
      specialHandler: true  // Uses special handler in specialHandlers.ts
    }
  },
  {
    name: 'create_image_task_from_prompt',
    version: '1.0.0',
    category: 'automation',
    deprecated: true,
    deprecatedMessage: "Use 'generate_image' instead for creating and revising images.",
    intentKeywords: ['image', 'task', 'create'],
    schema: {
      description: "[DEPRECATED] Create an image generation task using a raw prompt. Use 'generate_image' instead.",
      parameters: {
        type: 'object',
        properties: {
          task_name: {
            type: 'string',
            description: 'Name for the image generation task'
          },
          prompt: {
            type: 'string',
            description: 'The detailed prompt describing what images to generate'
          },
          category: {
            type: 'string',
            description: 'Category for the task',
            default: 'Creatives'
          },
          attach_previous_task_results: {
            type: 'boolean',
            description: 'Whether to attach previous task results to this task.',
            default: true
          }
        },
        required: ['task_name', 'prompt']
      }
    },
    handler: {
      methodName: 'createImageTaskFromPrompt',
      specialHandler: true  // Uses special handler in specialHandlers.ts
    }
  },
  {
    name: 'create_revision',
    version: '1.0.0',
    category: 'automation',
    deprecated: true,
    deprecatedMessage: "For image revision, use 'generate_image' with the original image as input. For HTML report revision, use 'update_html_file'.",
    intentKeywords: ['revision', 'revise', 'update', 'modify'],
    schema: {
      description: "[DEPRECATED] Create a revision of an existing completed task execution. Use 'generate_image' or 'update_html_file' instead.",
      parameters: {
        type: 'object',
        properties: {
          task_id: {
            type: 'string',
            description: 'The ID of the task to revise'
          },
          execution_id: {
            type: 'string',
            description: 'The ID of the execution to revise'
          },
          revision_prompt: {
            type: 'string',
            description: 'Detailed instructions for the revision'
          },
          target_result_name: {
            type: 'string',
            description: 'Name of the specific result file to revise',
            default: null
          }
        },
        required: ['task_id', 'execution_id', 'revision_prompt']
      }
    },
    handler: {
      methodName: 'createRevision',
      specialHandler: true  // Uses special handler in specialHandlers.ts
    }
  },
  {
    name: 'create_work_plan',
    version: '1.0.0',
    category: 'automation',
    intentKeywords: ['work', 'plan', 'create', 'steps', 'project'],
    schema: {
      description: 'Create a multi-step work plan for the current chat session. Use this to organize complex projects. IMPORTANT: Check if a work plan already exists before creating a new one.',
      parameters: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'Title of the work plan'
          },
          steps: {
            type: 'array',
            description: 'Array of steps in the plan',
            items: {
              type: 'object',
              properties: {
                stepCount: { type: 'number', description: 'Step number starting from 1' },
                title: { type: 'string', description: 'Step title' },
                description: { type: 'string', description: 'Optional detailed description' },
                requiredFunctionCalls: {
                  type: 'array',
                  description: 'Optional array of function names that must be called before marking this step as completed',
                  items: { type: 'string' }
                }
              },
              required: ['stepCount', 'title']
            }
          }
        },
        required: ['title', 'steps']
      }
    },
    handler: {
      methodName: 'createWorkPlan',
      contextArgs: ['sessionId']
    }
  },
  {
    name: 'modify_work_plan',
    version: '1.0.0',
    category: 'automation',
    intentKeywords: ['work', 'plan', 'modify', 'update', 'add', 'remove'],
    schema: {
      description: 'Add new steps or modify existing step details in the current work plan. Does not change step status.',
      parameters: {
        type: 'object',
        properties: {
          steps: {
            type: 'array',
            description: 'Array of steps to add or update',
            items: {
              type: 'object',
              properties: {
                stepCount: { type: 'number', description: 'Step number' },
                title: { type: 'string', description: 'Step title' },
                description: { type: 'string', description: 'Optional detailed description' },
                requiredFunctionCalls: {
                  type: 'array',
                  description: 'Optional array of function names that must be called',
                  items: { type: 'string' }
                }
              },
              required: ['stepCount', 'title']
            }
          },
          removeStepCounts: {
            type: 'array',
            description: 'Optional array of step numbers to remove',
            items: { type: 'number' }
          }
        },
        required: ['steps']
      }
    },
    handler: {
      methodName: 'modifyWorkPlan',
      contextArgs: ['sessionId']
    }
  },
  {
    name: 'set_work_plan_status',
    version: '1.0.0',
    category: 'automation',
    intentKeywords: ['work', 'plan', 'status', 'complete', 'skip', 'update'],
    schema: {
      description: 'Update the status of one or more steps in the work plan.',
      parameters: {
        type: 'object',
        properties: {
          updates: {
            type: 'array',
            description: 'Array of step status updates',
            items: {
              type: 'object',
              properties: {
                stepCount: { type: 'number', description: 'Step number to update' },
                status: {
                  type: 'string',
                  enum: ['pending', 'completed', 'skipped'],
                  description: 'New status for the step'
                },
                notes: { type: 'string', description: 'Optional notes about what was accomplished' }
              },
              required: ['stepCount', 'status']
            }
          }
        },
        required: ['updates']
      }
    },
    handler: {
      methodName: 'setWorkPlanStatus',
      contextArgs: ['sessionId']
    }
  }
];
