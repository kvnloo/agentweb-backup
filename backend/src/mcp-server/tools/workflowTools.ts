import { agentModeService } from '../../services/agentModeService.js';
import { mcpToolRegistry } from '../registry.js';

mcpToolRegistry.register({
  name: 'create_work_plan',
  definition: {
    name: 'create_work_plan',
    description: 'Create a multi-step work plan for the current session.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              stepCount: { type: 'number' },
              title: { type: 'string' },
              description: { type: 'string' },
              requiredFunctionCalls: { type: 'array', items: { type: 'string' } }
            },
            required: ['stepCount', 'title']
          }
        }
      },
      required: ['title', 'steps']
    }
  },
  execute: async (args: any) => {
    return await agentModeService.createWorkPlan(args.title, args.steps, args.sessionId);
  }
});

mcpToolRegistry.register({
  name: 'modify_work_plan',
  definition: {
    name: 'modify_work_plan',
    description: 'Add or modify steps in the current work plan.',
    inputSchema: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              stepCount: { type: 'number' },
              title: { type: 'string' },
              description: { type: 'string' },
              requiredFunctionCalls: { type: 'array', items: { type: 'string' } }
            },
            required: ['stepCount']
          }
        },
        removeStepCounts: { type: 'array', items: { type: 'number' } }
      }
    }
  },
  execute: async (args: any) => {
    return await agentModeService.modifyWorkPlan(args.steps || [], args.removeStepCounts || [], args.sessionId);
  }
});

mcpToolRegistry.register({
  name: 'set_work_plan_status',
  definition: {
    name: 'set_work_plan_status',
    description: 'Update the status and notes for steps in the work plan.',
    inputSchema: {
      type: 'object',
      properties: {
        stepStatuses: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              stepCount: { type: 'number' },
              status: { type: 'string', enum: ['pending', 'completed', 'skipped'] },
              notes: { type: 'string' }
            },
            required: ['stepCount', 'status']
          }
        }
      },
      required: ['stepStatuses']
    }
  },
  execute: async (args: any) => {
    return await agentModeService.setWorkPlanStatus(args.stepStatuses, args.sessionId);
  }
});
