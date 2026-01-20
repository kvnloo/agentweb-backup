import { agentModeService } from '../../services/agentModeService.js';
import { mcpToolRegistry } from '../registry.js';

mcpToolRegistry.register({
  name: 'list_gtm_plans',
  definition: {
    name: 'list_gtm_plans',
    description: 'List all existing Go-to-Market (GTM) strategy plans.',
    inputSchema: { type: 'object', properties: {} }
  },
  execute: async (args: any) => {
    return await agentModeService.listGTMPlans(args.userId);
  }
});

mcpToolRegistry.register({
  name: 'read_gtm_plan',
  definition: {
    name: 'read_gtm_plan',
    description: 'Read a specific GTM plan details by ID.',
    inputSchema: {
      type: 'object',
      properties: { plan_id: { type: 'string' } },
      required: ['plan_id']
    }
  },
  execute: async (args: any) => {
    return await agentModeService.readGTMPlan(args.plan_id, args.userId);
  }
});

mcpToolRegistry.register({
  name: 'create_gtm_plan',
  definition: {
    name: 'create_gtm_plan',
    description: 'Create a new Go-to-Market (GTM) plan.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        description: { type: 'string' },
        dri: { type: 'string' },
        phases: { type: 'array', items: { type: 'object' } }
      },
      required: ['title', 'description', 'dri']
    }
  },
  execute: async (args: any) => {
    return await agentModeService.createGTMPlan(args.title, args.description, args.dri, args.phases || [], args.userId);
  }
});

mcpToolRegistry.register({
  name: 'get_lead_lists',
  definition: {
    name: 'get_lead_lists',
    description: 'Get all lead lists owned by the current user.',
    inputSchema: { type: 'object', properties: {} }
  },
  execute: async (args: any) => {
    return await agentModeService.getLeadLists(args.userId);
  }
});

mcpToolRegistry.register({
  name: 'create_lead_list',
  definition: {
    name: 'create_lead_list',
    description: 'Create a new, empty lead list.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' }
      },
      required: ['name']
    }
  },
  execute: async (args: any) => {
    return await agentModeService.createLeadList(args.name, args.description, args.userId);
  }
});

mcpToolRegistry.register({
  name: 'add_leads_to_list',
  definition: {
    name: 'add_leads_to_list',
    description: 'Add multiple prospects/leads to an existing lead list.',
    inputSchema: {
      type: 'object',
      properties: {
        listId: { type: 'string' },
        leads: { type: 'array', items: { type: 'object' } }
      },
      required: ['listId', 'leads']
    }
  },
  execute: async (args: any) => {
    return await agentModeService.addLeadsToList(args.listId, args.leads, args.userId);
  }
});

mcpToolRegistry.register({
  name: 'update_email_draft_for_lead',
  definition: {
    name: 'update_email_draft_for_lead',
    description: 'Generate or update a personalized email draft for a specific lead.',
    inputSchema: {
      type: 'object',
      properties: {
        listId: { type: 'string' },
        leadId: { type: 'string' },
        instruction: { type: 'string' },
        emailFormat: { type: 'string' }
      },
      required: ['listId', 'leadId', 'instruction']
    }
  },
  execute: async (args: any) => {
    return await agentModeService.updateEmailDraftForLead(args.listId, args.leadId, args.instruction, args.sessionId, args.userId, args.emailFormat);
  }
});

mcpToolRegistry.register({
  name: 'list_connected_accounts',
  definition: {
    name: 'list_connected_accounts',
    description: 'List all social media accounts connected by the user.',
    inputSchema: {
      type: 'object',
      properties: {
        platform: { type: 'string', enum: ['linkedin', 'twitter', 'meta'] }
      }
    }
  },
  execute: async (args: any) => {
    return await agentModeService.listConnectedAccounts(args.userId, args.platform);
  }
});

mcpToolRegistry.register({
  name: 'list_connected_account_posts',
  definition: {
    name: 'list_connected_account_posts',
    description: 'Retrieve recent posts from a connected social media account.',
    inputSchema: {
      type: 'object',
      properties: {
        account_id: { type: 'string' },
        limit: { type: 'number', default: 10 },
        include_metrics: { type: 'boolean', default: true }
      },
      required: ['account_id']
    }
  },
  execute: async (args: any) => {
    return await agentModeService.loadConnectedAccountPosts(args.userId, args.account_id, { limit: args.limit, include_metrics: args.include_metrics });
  }
});

mcpToolRegistry.register({
  name: 'load_connected_account_metrics',
  definition: {
    name: 'load_connected_account_metrics',
    description: 'Get overall performance metrics for a connected social media account.',
    inputSchema: {
      type: 'object',
      properties: { account_id: { type: 'string' } },
      required: ['account_id']
    }
  },
  execute: async (args: any) => {
    return await agentModeService.loadConnectedAccountMetrics(args.userId, args.account_id);
  }
});

mcpToolRegistry.register({
  name: 'post_on_connected_account',
  definition: {
    name: 'post_on_connected_account',
    description: 'Publish a new post to a connected social media account.',
    inputSchema: {
      type: 'object',
      properties: {
        account_id: { type: 'string' },
        content: { type: 'string' },
        media_urls: { type: 'array', items: { type: 'string' } }
      },
      required: ['account_id', 'content']
    }
  },
  execute: async (args: any) => {
    return await agentModeService.postOnConnectedAccount(args.userId, args.account_id, args.content, args.media_urls);
  }
});
