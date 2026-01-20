import { agentModeService } from '../../services/agentModeService.js';
import { mcpToolRegistry } from '../registry.js';

mcpToolRegistry.register({
  name: 'create_task_from_template',
  definition: {
    name: 'create_task_from_template',
    description: 'Create a web automation task using a specific template.',
    inputSchema: {
      type: 'object',
      properties: {
        template_id: { type: 'string' },
        parameters_json: { type: 'string' },
        attach_previous_task_results: { type: 'boolean', default: true },
        attached_file_urls: { type: 'array', items: { type: 'string' } },
        async: { type: 'boolean', default: false }
      },
      required: ['template_id', 'parameters_json']
    }
  },
  execute: async (args: any) => {
    let parameters = args.parameters_json;
    if (typeof parameters === 'string') {
      try { parameters = JSON.parse(args.parameters_json); } catch (e) {}
    }
    return await agentModeService.createTaskFromTemplate(
      args.template_id,
      parameters,
      args.userId,
      args.sessionId,
      args.attach_previous_task_results,
      args.attached_file_urls || [],
      args.async
    );
  }
});

mcpToolRegistry.register({
  name: 'create_task_from_prompt',
  definition: {
    name: 'create_task_from_prompt',
    description: 'Create a web automation task using a raw prompt.',
    inputSchema: {
      type: 'object',
      properties: {
        task_name: { type: 'string' },
        prompt: { type: 'string' },
        category: { type: 'string' },
        attach_previous_task_results: { type: 'boolean', default: true },
        attached_file_urls: { type: 'array', items: { type: 'string' } },
        async: { type: 'boolean', default: false }
      },
      required: ['task_name', 'prompt', 'category']
    }
  },
  execute: async (args: any) => {
    return await agentModeService.createTaskFromPrompt(
      args.task_name,
      args.prompt,
      args.category,
      args.userId,
      args.sessionId,
      args.attach_previous_task_results,
      args.attached_file_urls || [],
      args.async
    );
  }
});

mcpToolRegistry.register({
  name: 'create_image_task_from_prompt',
  definition: {
    name: 'create_image_task_from_prompt',
    description: '[DEPRECATED] Create an image generation task from prompt.',
    inputSchema: {
      type: 'object',
      properties: {
        task_name: { type: 'string' },
        prompt: { type: 'string' },
        category: { type: 'string', default: 'Creatives' },
        attach_previous_task_results: { type: 'boolean', default: true }
      },
      required: ['task_name', 'prompt']
    }
  },
  execute: async (args: any) => {
    return await agentModeService.createImageTaskFromPrompt(
      args.task_name,
      args.prompt,
      args.category,
      args.userId,
      args.sessionId,
      args.attach_previous_task_results
    );
  }
});

mcpToolRegistry.register({
  name: 'create_revision',
  definition: {
    name: 'create_revision',
    description: '[DEPRECATED] Create a revision of an existing completed task execution.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        execution_id: { type: 'string' },
        revision_prompt: { type: 'string' },
        target_result_name: { type: 'string' }
      },
      required: ['task_id', 'execution_id', 'revision_prompt']
    }
  },
  execute: async (args: any) => {
    return await agentModeService.createRevision(
      args.task_id,
      args.execution_id,
      args.revision_prompt,
      args.userId,
      args.target_result_name
    );
  }
});

mcpToolRegistry.register({
  name: 'get_task_subscriber_metrics',
  definition: {
    name: 'get_task_subscriber_metrics',
    description: 'Get comprehensive email metrics for all subscribers of a specific task.',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string' } },
      required: ['task_id']
    }
  },
  execute: async (args: any) => {
    return await agentModeService.getTaskSubscriberMetrics(args.task_id, args.userId);
  }
});

mcpToolRegistry.register({
  name: 'get_task_subscriber_engagement_events',
  definition: {
    name: 'get_task_subscriber_engagement_events',
    description: 'Get email engagement events for a specific task and email subject.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        email_subject: { type: 'string' }
      },
      required: ['task_id', 'email_subject']
    }
  },
  execute: async (args: any) => {
    return await agentModeService.getTaskSubscriberEngagementEvents(args.task_id, args.email_subject, args.userId);
  }
});
