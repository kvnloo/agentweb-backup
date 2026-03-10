/**
 * API Tools — MCP tools that wrap the backend REST API via HTTP self-calls.
 *
 * Every tool goes through authenticateToken middleware by making an HTTP
 * request to localhost with a short-lived JWT. This eliminates the IDOR
 * surface that existed when tools called agentModeService directly.
 *
 * No direct service calls — all tools route through the REST API.
 */

import { mcpToolRegistry } from './registry';
import { mcpFetch } from './httpClient';

// ─── Helpers ────────────────────────────────────────────────────────────────

function ctx(context: any) {
  return { userId: context?.userId, agentUserId: context?.agentUserId };
}

function jsonResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] };
}

// ─── Emma Chat Sessions ─────────────────────────────────────────────────────

mcpToolRegistry.register({
  name: 'emma_create_session',
  definition: {
    name: 'emma_create_session',
    description: 'Create a new Emma chat session.',
    inputSchema: {
      type: 'object',
      properties: {
        llm_model: { type: 'string', description: 'LLM model to use (optional)' }
      },
      required: []
    }
  },
  execute: async (args: any, context: any) => {
    const data = await mcpFetch({ method: 'POST', path: '/api/agent-mode/sessions', context: ctx(context), body: { llmModel: args.llm_model } });
    return jsonResult(data);
  }
});

mcpToolRegistry.register({
  name: 'emma_send_message',
  definition: {
    name: 'emma_send_message',
    description: 'Send a message to an Emma chat session and get a response.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'The chat session ID' },
        message: { type: 'string', description: 'The message to send' },
        llm_model: { type: 'string', description: 'LLM model to use (optional)' }
      },
      required: ['session_id', 'message']
    }
  },
  execute: async (args: any, context: any) => {
    const data = await mcpFetch({
      method: 'POST', path: '/api/agent-mode/generate', context: ctx(context),
      body: { sessionId: args.session_id, userMessage: args.message, llmModel: args.llm_model }
    });
    return jsonResult(data);
  }
});

mcpToolRegistry.register({
  name: 'emma_get_session',
  definition: {
    name: 'emma_get_session',
    description: 'Get details of an Emma chat session by ID.',
    inputSchema: {
      type: 'object',
      properties: { session_id: { type: 'string', description: 'The session ID' } },
      required: ['session_id']
    }
  },
  execute: async (args: any, context: any) => {
    const data = await mcpFetch({ method: 'GET', path: `/api/agent-mode/session/${args.session_id}`, context: ctx(context) });
    return jsonResult(data);
  }
});

mcpToolRegistry.register({
  name: 'emma_list_sessions',
  definition: {
    name: 'emma_list_sessions',
    description: 'List all Emma chat sessions for the authenticated user.',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  execute: async (_args: any, context: any) => {
    const data = await mcpFetch({ method: 'GET', path: '/api/agent-mode/sessions', context: ctx(context) });
    return jsonResult(data);
  }
});

// ─── Tasks ──────────────────────────────────────────────────────────────────

mcpToolRegistry.register({
  name: 'list_tasks',
  definition: {
    name: 'list_tasks',
    description: 'List all tasks owned by the authenticated user.',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  execute: async (_args: any, context: any) => {
    const data = await mcpFetch({ method: 'GET', path: '/api/tasks', context: ctx(context) });
    return jsonResult(data);
  }
});

mcpToolRegistry.register({
  name: 'manage_task',
  definition: {
    name: 'manage_task',
    description: 'Create, read, update, or delete a task. Use action: "create" (POST), "get" (GET), "update" (PUT), or "delete" (DELETE).',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'get', 'update', 'delete'], description: 'CRUD action' },
        task_id: { type: 'string', description: 'Task ID (required for get/update/delete)' },
        name: { type: 'string', description: 'Task name (create/update)' },
        prompt: { type: 'string', description: 'Task prompt (create/update)' },
        status: { type: 'string', description: 'Task status (update)' },
        category: { type: 'string', description: 'Task category (create/update)' },
        description: { type: 'string', description: 'Task description (create/update)' }
      },
      required: ['action']
    }
  },
  execute: async (args: any, context: any) => {
    const c = ctx(context);
    switch (args.action) {
      case 'create': {
        const data = await mcpFetch({ method: 'POST', path: '/api/tasks', context: c, body: { name: args.name, prompt: args.prompt, category: args.category, description: args.description } });
        return jsonResult(data);
      }
      case 'get': {
        const data = await mcpFetch({ method: 'GET', path: `/api/tasks/${args.task_id}`, context: c });
        return jsonResult(data);
      }
      case 'update': {
        const { action, task_id, ...updates } = args;
        const data = await mcpFetch({ method: 'PUT', path: `/api/tasks/${task_id}`, context: c, body: updates });
        return jsonResult(data);
      }
      case 'delete': {
        const data = await mcpFetch({ method: 'DELETE', path: `/api/tasks/${args.task_id}`, context: c });
        return jsonResult(data);
      }
      default:
        return jsonResult({ error: `Unknown action: ${args.action}` });
    }
  }
});

mcpToolRegistry.register({
  name: 'execute_task',
  definition: {
    name: 'execute_task',
    description: 'Queue a task for execution by the agent engine.',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string', description: 'The task ID to execute' } },
      required: ['task_id']
    }
  },
  execute: async (args: any, context: any) => {
    const data = await mcpFetch({ method: 'POST', path: `/api/tasks/${args.task_id}/execute`, context: ctx(context) });
    return jsonResult(data);
  }
});

mcpToolRegistry.register({
  name: 'list_task_executions',
  definition: {
    name: 'list_task_executions',
    description: 'List execution history for a task, or get details of a specific execution.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'The task ID' },
        execution_id: { type: 'string', description: 'Specific execution ID (optional — omit to list all)' }
      },
      required: ['task_id']
    }
  },
  execute: async (args: any, context: any) => {
    const path = args.execution_id
      ? `/api/tasks/${args.task_id}/executions/${args.execution_id}`
      : `/api/tasks/${args.task_id}/executions`;
    const data = await mcpFetch({ method: 'GET', path, context: ctx(context) });
    return jsonResult(data);
  }
});

// ─── Schedules ──────────────────────────────────────────────────────────────

mcpToolRegistry.register({
  name: 'list_schedules',
  definition: {
    name: 'list_schedules',
    description: 'List schedules for a task.',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string', description: 'The task ID' } },
      required: ['task_id']
    }
  },
  execute: async (args: any, context: any) => {
    const data = await mcpFetch({ method: 'GET', path: `/api/schedules/task/${args.task_id}`, context: ctx(context) });
    return jsonResult(data);
  }
});

mcpToolRegistry.register({
  name: 'manage_schedule',
  definition: {
    name: 'manage_schedule',
    description: 'Create, update, or delete a schedule. Use action: "create" (POST), "update" (PUT), or "delete" (DELETE).',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'update', 'delete'], description: 'CRUD action' },
        schedule_id: { type: 'string', description: 'Schedule ID (required for update/delete)' },
        task_id: { type: 'string', description: 'Task ID (required for create)' },
        frequency: { type: 'string', description: 'Schedule frequency: daily, weekly, monthly, or cron expression' },
        next_run_time: { type: 'string', description: 'ISO 8601 datetime for the first/next run' },
        schedule_name: { type: 'string', description: 'Schedule name' },
        description: { type: 'string', description: 'Description' },
        timezone: { type: 'string', description: 'Timezone (e.g. America/Los_Angeles)' },
        status: { type: 'string', description: 'Status (active or inactive, update only)' }
      },
      required: ['action']
    }
  },
  execute: async (args: any, context: any) => {
    const c = ctx(context);
    switch (args.action) {
      case 'create': {
        const data = await mcpFetch({
          method: 'POST', path: '/api/schedules', context: c,
          body: {
            taskId: args.task_id, frequency: args.frequency,
            nextRunTime: args.next_run_time, scheduleName: args.schedule_name,
            description: args.description, timezone: args.timezone
          }
        });
        return jsonResult(data);
      }
      case 'update': {
        const { action, schedule_id, ...updates } = args;
        const data = await mcpFetch({ method: 'PUT', path: `/api/schedules/${schedule_id}`, context: c, body: updates });
        return jsonResult(data);
      }
      case 'delete': {
        const data = await mcpFetch({ method: 'DELETE', path: `/api/schedules/${args.schedule_id}`, context: c });
        return jsonResult(data);
      }
      default:
        return jsonResult({ error: `Unknown action: ${args.action}` });
    }
  }
});

// ─── CRM / Leads ────────────────────────────────────────────────────────────

mcpToolRegistry.register({
  name: 'list_lead_lists',
  definition: {
    name: 'list_lead_lists',
    description: 'List all lead lists for the authenticated user.',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  execute: async (_args: any, context: any) => {
    const data = await mcpFetch({ method: 'GET', path: '/api/crm/lists', context: ctx(context) });
    return jsonResult(data);
  }
});

mcpToolRegistry.register({
  name: 'manage_lead_list',
  definition: {
    name: 'manage_lead_list',
    description: 'Create, update, or delete a lead list. Use action: "create", "get", "update", or "delete".',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'get', 'update', 'delete'], description: 'CRUD action' },
        list_id: { type: 'string', description: 'List ID (required for get/update/delete)' },
        name: { type: 'string', description: 'List name (create/update)' },
        description: { type: 'string', description: 'List description (create/update)' },
        list_type: { type: 'string', description: 'List type (create only)' }
      },
      required: ['action']
    }
  },
  execute: async (args: any, context: any) => {
    const c = ctx(context);
    switch (args.action) {
      case 'create': {
        const data = await mcpFetch({ method: 'POST', path: '/api/crm/lists', context: c, body: { name: args.name, description: args.description, listType: args.list_type } });
        return jsonResult(data);
      }
      case 'get': {
        const data = await mcpFetch({ method: 'GET', path: `/api/crm/lists/${args.list_id}`, context: c });
        return jsonResult(data);
      }
      case 'update': {
        const data = await mcpFetch({ method: 'PUT', path: `/api/crm/lists/${args.list_id}`, context: c, body: { name: args.name, description: args.description } });
        return jsonResult(data);
      }
      case 'delete': {
        const data = await mcpFetch({ method: 'DELETE', path: `/api/crm/lists/${args.list_id}`, context: c });
        return jsonResult(data);
      }
      default:
        return jsonResult({ error: `Unknown action: ${args.action}` });
    }
  }
});

mcpToolRegistry.register({
  name: 'manage_leads',
  definition: {
    name: 'manage_leads',
    description: 'Add, get, update, or delete leads in a list. Use action: "add", "get", "update", "delete", or "list".',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'add', 'get', 'update', 'delete'], description: 'Action to perform' },
        list_id: { type: 'string', description: 'The lead list ID' },
        lead_id: { type: 'string', description: 'Lead ID (for get/update)' },
        leads: { type: 'array', description: 'Array of lead objects to add (for add action)' },
        lead_ids: { type: 'array', items: { type: 'string' }, description: 'Lead IDs to delete (for delete action)' },
        updates: { type: 'object', description: 'Fields to update (for update action)' },
        limit: { type: 'number', description: 'Max leads to return (list action)' },
        last_key: { type: 'string', description: 'Pagination key (list action)' }
      },
      required: ['action', 'list_id']
    }
  },
  execute: async (args: any, context: any) => {
    const c = ctx(context);
    const listId = args.list_id;
    switch (args.action) {
      case 'list': {
        const qp: Record<string, string> = {};
        if (args.limit) qp.limit = String(args.limit);
        if (args.last_key) qp.lastKey = args.last_key;
        const data = await mcpFetch({ method: 'GET', path: `/api/crm/lists/${listId}/leads`, context: c, queryParams: qp });
        return jsonResult(data);
      }
      case 'add': {
        const data = await mcpFetch({ method: 'POST', path: `/api/crm/lists/${listId}/leads`, context: c, body: { leads: args.leads } });
        return jsonResult(data);
      }
      case 'get': {
        const data = await mcpFetch({ method: 'GET', path: `/api/crm/lists/${listId}/leads/${args.lead_id}`, context: c });
        return jsonResult(data);
      }
      case 'update': {
        const data = await mcpFetch({ method: 'PUT', path: `/api/crm/lists/${listId}/leads/${args.lead_id}`, context: c, body: args.updates });
        return jsonResult(data);
      }
      case 'delete': {
        // Delete uses the single-lead endpoint if one ID, or we need to call per-lead
        if (args.lead_ids && args.lead_ids.length === 1) {
          const data = await mcpFetch({ method: 'DELETE', path: `/api/crm/lists/${listId}/leads/${args.lead_ids[0]}`, context: c });
          return jsonResult(data);
        }
        // For multiple deletes, call individually
        const results = [];
        for (const leadId of (args.lead_ids || [])) {
          const data = await mcpFetch({ method: 'DELETE', path: `/api/crm/lists/${listId}/leads/${leadId}`, context: c });
          results.push(data);
        }
        return jsonResult({ deleted: args.lead_ids?.length || 0, results });
      }
      default:
        return jsonResult({ error: `Unknown action: ${args.action}` });
    }
  }
});

mcpToolRegistry.register({
  name: 'search_leads',
  definition: {
    name: 'search_leads',
    description: 'Search leads across lists using structured filters.',
    inputSchema: {
      type: 'object',
      properties: {
        list_id: { type: 'string', description: 'The lead list ID to search in' },
        filters: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              field: { type: 'string' },
              operator: { type: 'string' },
              value: {}
            },
            required: ['field', 'operator']
          },
          description: 'Array of filter conditions'
        },
        limit: { type: 'number', description: 'Max results (default 20, max 50)' }
      },
      required: ['list_id', 'filters']
    }
  },
  execute: async (args: any, context: any) => {
    const data = await mcpFetch({
      method: 'POST', path: '/api/emma/search-leads', context: ctx(context),
      body: { list_id: args.list_id, filters: args.filters, limit: args.limit }
    });
    return jsonResult(data);
  }
});

// ─── GTM Plans ──────────────────────────────────────────────────────────────

mcpToolRegistry.register({
  name: 'list_gtm_plans',
  definition: {
    name: 'list_gtm_plans',
    description: 'List all GTM plans for the authenticated user.',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  execute: async (_args: any, context: any) => {
    const data = await mcpFetch({ method: 'GET', path: '/api/gtm-plan', context: ctx(context) });
    return jsonResult(data);
  }
});

mcpToolRegistry.register({
  name: 'manage_gtm_plan',
  definition: {
    name: 'manage_gtm_plan',
    description: 'Create, read, update, or delete a GTM plan. Use action: "create", "get", "update", or "delete".',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'get', 'update', 'delete'], description: 'CRUD action' },
        plan_id: { type: 'string', description: 'Plan ID (required for get/update/delete)' },
        title: { type: 'string', description: 'Plan title (create/update)' },
        description: { type: 'string', description: 'Plan description (create/update)' },
        goals: { type: 'array', items: { type: 'string' }, description: 'Plan goals (create/update)' },
        target_audience: { type: 'string', description: 'Target audience (create/update)' },
        timeline: { type: 'string', description: 'Timeline (create/update)' },
        budget: { type: 'string', description: 'Budget (create/update)' },
        status: { type: 'string', description: 'Plan status (update)' }
      },
      required: ['action']
    }
  },
  execute: async (args: any, context: any) => {
    const c = ctx(context);
    switch (args.action) {
      case 'create': {
        const { action, plan_id, ...body } = args;
        const data = await mcpFetch({ method: 'POST', path: '/api/gtm-plan', context: c, body });
        return jsonResult(data);
      }
      case 'get': {
        const data = await mcpFetch({ method: 'GET', path: `/api/gtm-plan/${args.plan_id}`, context: c });
        return jsonResult(data);
      }
      case 'update': {
        const { action, plan_id, ...body } = args;
        const data = await mcpFetch({ method: 'PUT', path: `/api/gtm-plan/${plan_id}`, context: c, body });
        return jsonResult(data);
      }
      case 'delete': {
        const data = await mcpFetch({ method: 'DELETE', path: `/api/gtm-plan/${args.plan_id}`, context: c });
        return jsonResult(data);
      }
      default:
        return jsonResult({ error: `Unknown action: ${args.action}` });
    }
  }
});

mcpToolRegistry.register({
  name: 'manage_gtm_items',
  definition: {
    name: 'manage_gtm_items',
    description: 'Manage GTM plan phases and work items. Use action: "add_phase", "update_phase", "delete_phase", "add_work_items", "update_work_item", "delete_work_item", "get_common_items", "add_common_items", or "send_status_report".',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'Action to perform' },
        plan_id: { type: 'string', description: 'Plan ID' },
        phase_id: { type: 'string', description: 'Phase ID' },
        work_item_id: { type: 'string', description: 'Work item ID' },
        name: { type: 'string', description: 'Phase/item name' },
        description: { type: 'string', description: 'Description' },
        status: { type: 'string', description: 'Status' },
        work_items: { type: 'array', description: 'Array of work item objects' },
        items: { type: 'array', description: 'Common items to add' },
        target_phase_id: { type: 'string', description: 'Target phase for common items' },
        new_phase_name: { type: 'string', description: 'New phase name for common items' },
        include_summary: { type: 'boolean', description: 'Include summary in status report' },
        include_details: { type: 'boolean', description: 'Include details in status report' }
      },
      required: ['action', 'plan_id']
    }
  },
  execute: async (args: any, context: any) => {
    const c = ctx(context);
    const { plan_id, phase_id, work_item_id } = args;
    switch (args.action) {
      case 'add_phase': {
        const data = await mcpFetch({
          method: 'POST', path: `/api/gtm-plan/${plan_id}/phases`, context: c,
          body: { name: args.name, description: args.description, status: args.status }
        });
        return jsonResult(data);
      }
      case 'update_phase': {
        const data = await mcpFetch({
          method: 'PUT', path: `/api/gtm-plan/${plan_id}/phases/${phase_id}`, context: c,
          body: { name: args.name, description: args.description, status: args.status }
        });
        return jsonResult(data);
      }
      case 'delete_phase': {
        const data = await mcpFetch({ method: 'DELETE', path: `/api/gtm-plan/${plan_id}/phases/${phase_id}`, context: c });
        return jsonResult(data);
      }
      case 'add_work_items': {
        const data = await mcpFetch({
          method: 'POST', path: `/api/gtm-plan/${plan_id}/phases/${phase_id}/work-items`, context: c,
          body: { workItems: args.work_items }
        });
        return jsonResult(data);
      }
      case 'update_work_item': {
        const { action: _a, plan_id: _p, phase_id: _ph, work_item_id: _w, ...updates } = args;
        const data = await mcpFetch({
          method: 'PUT', path: `/api/gtm-plan/${plan_id}/phases/${phase_id}/work-items/${work_item_id}`, context: c,
          body: updates
        });
        return jsonResult(data);
      }
      case 'delete_work_item': {
        const data = await mcpFetch({
          method: 'DELETE', path: `/api/gtm-plan/${plan_id}/phases/${phase_id}/work-items/${work_item_id}`, context: c
        });
        return jsonResult(data);
      }
      case 'get_common_items': {
        const data = await mcpFetch({ method: 'GET', path: '/api/gtm-plan/common-items', context: c });
        return jsonResult(data);
      }
      case 'add_common_items': {
        const data = await mcpFetch({
          method: 'POST', path: `/api/gtm-plan/${plan_id}/add-common-items`, context: c,
          body: { items: args.items, targetPhaseId: args.target_phase_id, newPhaseName: args.new_phase_name }
        });
        return jsonResult(data);
      }
      case 'send_status_report': {
        const path = phase_id
          ? `/api/gtm-plan/${plan_id}/phases/${phase_id}/send-status-report`
          : `/api/gtm-plan/${plan_id}/send-status-report`;
        const data = await mcpFetch({
          method: 'POST', path, context: c,
          body: { includeSummary: args.include_summary, includeDetails: args.include_details }
        });
        return jsonResult(data);
      }
      default:
        return jsonResult({ error: `Unknown action: ${args.action}` });
    }
  }
});

// ─── Knowledge Base ─────────────────────────────────────────────────────────

mcpToolRegistry.register({
  name: 'list_knowledge_bases',
  definition: {
    name: 'list_knowledge_bases',
    description: 'List all knowledge base files for the authenticated user.',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  execute: async (_args: any, context: any) => {
    const data = await mcpFetch({ method: 'GET', path: '/api/emma/knowledge-bases', context: ctx(context) });
    return jsonResult(data);
  }
});

mcpToolRegistry.register({
  name: 'search_knowledge_base',
  definition: {
    name: 'search_knowledge_base',
    description: 'Search the knowledge base for relevant information.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        max_results: { type: 'number', description: 'Max results (default 5)', default: 5 }
      },
      required: ['query']
    }
  },
  execute: async (args: any, context: any) => {
    const data = await mcpFetch({
      method: 'POST', path: '/api/emma/search-knowledge-base', context: ctx(context),
      body: { query: args.query, max_results: args.max_results || 5 }
    });
    return jsonResult(data);
  }
});

mcpToolRegistry.register({
  name: 'read_knowledge_base_files',
  definition: {
    name: 'read_knowledge_base_files',
    description: 'Read specific files from the knowledge base.',
    inputSchema: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              kb_identifier: { type: 'string', description: 'Knowledge base task ID' },
              file_name: { type: 'string', description: 'File name to read' }
            },
            required: ['kb_identifier', 'file_name']
          }
        }
      },
      required: ['files']
    }
  },
  execute: async (args: any, context: any) => {
    const data = await mcpFetch({
      method: 'POST', path: '/api/emma/read-knowledge-base-files', context: ctx(context),
      body: { files: args.files }
    });
    return jsonResult(data);
  }
});

// ─── Brand & Strategy ───────────────────────────────────────────────────────

mcpToolRegistry.register({
  name: 'manage_brand',
  definition: {
    name: 'manage_brand',
    description: 'Read or update brand guidelines. Use action: "read" or "update".',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['read', 'update'], description: 'Action' },
        company_name: { type: 'string', description: 'Company name (update)' },
        mission: { type: 'string', description: 'Mission statement (update)' },
        tone_of_voice: { type: 'string', description: 'Tone of voice (update)' },
        target_audience: { type: 'string', description: 'Target audience (update)' },
        key_messages: { type: 'array', items: { type: 'string' }, description: 'Key messages (update)' },
        visual_identity: { type: 'object', description: 'Visual identity settings (update)' }
      },
      required: ['action']
    }
  },
  execute: async (args: any, context: any) => {
    const c = ctx(context);
    if (args.action === 'read') {
      const data = await mcpFetch({ method: 'GET', path: '/api/brand/guidelines', context: c });
      return jsonResult(data);
    }
    const { action, ...body } = args;
    const data = await mcpFetch({ method: 'POST', path: '/api/brand/guidelines', context: c, body });
    return jsonResult(data);
  }
});

mcpToolRegistry.register({
  name: 'manage_market_strategy',
  definition: {
    name: 'manage_market_strategy',
    description: 'Read or update market strategy. Use action: "read" or "update".',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['read', 'update'], description: 'Action' },
        positioning: { type: 'string', description: 'Market positioning (update)' },
        competitors: { type: 'array', description: 'Competitor list (update)' },
        differentiators: { type: 'array', items: { type: 'string' }, description: 'Key differentiators (update)' },
        channels: { type: 'array', items: { type: 'string' }, description: 'Marketing channels (update)' }
      },
      required: ['action']
    }
  },
  execute: async (args: any, context: any) => {
    const c = ctx(context);
    if (args.action === 'read') {
      const data = await mcpFetch({ method: 'GET', path: '/api/market-strategy', context: c });
      return jsonResult(data);
    }
    const { action, ...body } = args;
    const data = await mcpFetch({ method: 'POST', path: '/api/market-strategy', context: c, body });
    return jsonResult(data);
  }
});

// ─── Content (internal tools — call agentModeService directly) ──────────────

mcpToolRegistry.register({
  name: 'create_blog_article',
  internal: true,
  definition: {
    name: 'create_blog_article',
    description: 'Create a complete blog article with content, images, and HTML file. Takes a title draft and content draft in markdown format, creates a hero image, and produces a complete HTML file uploaded to S3.',
    inputSchema: {
      type: 'object',
      properties: {
        title_draft: { type: 'string', description: 'A draft title for the blog article.' },
        content_draft: { type: 'string', description: 'The blog article content in markdown format' },
        length: { type: 'string', enum: ['short', 'medium', 'long'], description: 'Desired article length', default: 'medium' },
        researchContext: { type: 'string', description: 'Optional research context or background information' },
        requirements: { type: 'string', description: 'Specific requirements (e.g., internal links, CTAs, branding)' },
        style: { type: 'string', enum: ['default', 'substack'], description: 'Writing style. "substack" for newsletter-like personal tone.', default: 'default' },
        deep_research: { type: 'boolean', description: 'When true, performs deep research and includes inline images. Takes several minutes.', default: false }
      },
      required: ['title_draft', 'content_draft']
    }
  },
  execute: async (args: any, context: any) => {
    const { agentModeService } = await import('../../services/agentModeService');
    return await agentModeService.createBlogArticle(
      args.title_draft, args.content_draft, args.length || 'medium',
      args.researchContext || '', args.requirements || '',
      context?.userId, context?.sessionId,
      args.style || 'default', args.deep_research || false
    );
  }
});

mcpToolRegistry.register({
  name: 'publish_blog_article',
  internal: true,
  definition: {
    name: 'publish_blog_article',
    description: 'Publish a blog article to CMS (Basehub or Webflow). Takes title, description, hero image URL, and blog HTML URL from create_blog_article. CRITICAL: Always review with user before publishing.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Article title' },
        description: { type: 'string', description: 'Article description/meta description' },
        hero_image_url: { type: 'string', description: 'URL of the hero image' },
        blog_html_url: { type: 'string', description: 'URL of the HTML file from create_blog_article' },
        status: { type: 'string', enum: ['draft', 'published'], description: 'Publication status', default: 'draft' },
        author: { type: 'string', description: 'Optional author name or ID' },
        categories: { type: 'array', items: { type: 'string' }, description: 'Blog categories (required when status is "published")' },
        inline_image_urls: { type: 'array', items: { type: 'string' }, description: 'Array of image URLs to embed inline within the article body (e.g., screenshots, diagrams)' }
      },
      required: ['title', 'description', 'hero_image_url', 'blog_html_url']
    }
  },
  execute: async (args: any, context: any) => {
    const { agentModeService } = await import('../../services/agentModeService');
    return await agentModeService.publishBlogArticle(
      args.title, args.description, args.hero_image_url, args.blog_html_url,
      context?.userId, context?.sessionId,
      args.status, args.author, args.categories, args.inline_image_urls || []
    );
  }
});

// ─── Connected Accounts ─────────────────────────────────────────────────────

mcpToolRegistry.register({
  name: 'list_connected_accounts',
  definition: {
    name: 'list_connected_accounts',
    description: 'List all connected social media and integration accounts.',
    inputSchema: {
      type: 'object',
      properties: {
        platform: { type: 'string', description: 'Filter by platform (e.g., "linkedin", "meta", "unipile")' }
      },
      required: []
    }
  },
  execute: async (args: any, context: any) => {
    const qp: Record<string, string> = {};
    if (args.platform) qp.platform = args.platform;
    const data = await mcpFetch({ method: 'GET', path: '/api/oauth/connected-accounts', context: ctx(context), queryParams: qp });
    return jsonResult(data);
  }
});

mcpToolRegistry.register({
  name: 'post_on_account',
  definition: {
    name: 'post_on_account',
    description: 'Post content on a connected social media account.',
    inputSchema: {
      type: 'object',
      properties: {
        account_id: { type: 'string', description: 'Connected account ID' },
        content: { type: 'string', description: 'Post content' },
        media_urls: { type: 'array', items: { type: 'string' }, description: 'Optional media URLs' }
      },
      required: ['account_id', 'content']
    }
  },
  execute: async (args: any, context: any) => {
    const data = await mcpFetch({
      method: 'POST', path: '/api/emma/post-on-account', context: ctx(context),
      body: { account_id: args.account_id, content: args.content, media_urls: args.media_urls || [] }
    });
    return jsonResult(data);
  }
});

// ─── Internal-only tools (hidden from external MCP clients) ─────────────────
// These tools are registered with internal: true so Emma can use them in chat,
// but they are NOT listed to external MCP clients.

// Session-state tools: install_skills and list_available_skills manipulate
// chat session state (associatedSkills). They call agentModeService directly
// because they're part of Emma's skill-first chat flow, same as customer portal.

mcpToolRegistry.register({
  name: 'install_skills',
  internal: true,
  definition: {
    name: 'install_skills',
    description: 'Install one or more skills by their IDs. This makes the tools associated with the skills available for use. Use __other_skills__ to install tools that are not part of any specific skill.',
    inputSchema: {
      type: 'object',
      properties: {
        skillIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of skill IDs to install.'
        }
      },
      required: ['skillIds']
    }
  },
  execute: async (args: any, context: any) => {
    const userId = context?.userId || context?.agentUserId;
    if (!userId) throw new Error('Authentication required: no user context');
    if (!Array.isArray(args.skillIds) || args.skillIds.length === 0) {
      return { message: 'skillIds must be a non-empty array of skill IDs.' };
    }
    if (!context?.sessionId) throw new Error('Missing session context');
    const { agentModeService } = await import('../../services/agentModeService');
    return await agentModeService.installSkills(args.skillIds, userId, context.sessionId);
  }
});

mcpToolRegistry.register({
  name: 'list_available_skills',
  internal: true,
  definition: {
    name: 'list_available_skills',
    description: 'List all available skills with their descriptions and tool lists. Use this to discover what capabilities Emma offers before installing skills.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  execute: async (args: any, context: any) => {
    const userId = context?.userId || context?.agentUserId;
    if (!userId) throw new Error('Authentication required');
    if (!context?.sessionId) throw new Error('Missing session context');
    const { agentModeService } = await import('../../services/agentModeService');
    return await agentModeService.listSkills(userId, context.sessionId);
  }
});

// Infrastructure tools: use backend APIs (search, image gen, email, storage).

mcpToolRegistry.register({
  name: 'search_web',
  internal: true,
  definition: {
    name: 'search_web',
    description: 'Search the web for information.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        max_results: { type: 'number', description: 'Max results (default 5, max 10)', default: 5 }
      },
      required: ['query']
    }
  },
  execute: async (args: any, context: any) => {
    const data = await mcpFetch({
      method: 'POST', path: '/api/emma/search-web', context: ctx(context),
      body: { query: args.query, max_results: args.max_results || 10 }
    });
    return jsonResult(data);
  }
});

mcpToolRegistry.register({
  name: 'generate_image',
  internal: true,
  definition: {
    name: 'generate_image',
    description: 'Generate images using AI image generation models.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Detailed description of the image to generate' },
        filename: { type: 'string', description: 'Filename for the generated image' },
        size: { type: 'string', description: 'Image size (e.g., 1024x1024, auto)', default: 'auto' },
        quality: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Quality', default: 'medium' },
        input_images: { type: 'array', items: { type: 'string' }, description: 'Input images for editing' },
        logo_image: { type: 'string', description: 'Logo image URL to add' },
        image_model: { type: 'string', description: 'Model to use' }
      },
      required: ['prompt', 'filename']
    }
  },
  execute: async (args: any, context: any) => {
    const data = await mcpFetch({
      method: 'POST', path: '/api/emma/generate-image', context: ctx(context),
      body: {
        prompt: args.prompt, filename: args.filename,
        size: args.size || '1024x1024', quality: args.quality || 'medium',
        input_images: args.input_images || [],
        image_model: args.image_model, logo_image: args.logo_image
      }
    });
    return jsonResult(data);
  }
});

mcpToolRegistry.register({
  name: 'send_email',
  internal: true,
  definition: {
    name: 'send_email',
    description: 'Read, search, and send emails across connected email accounts (Gmail, etc.).',
    inputSchema: {
      type: 'object',
      properties: {
        account_id: { type: 'string', description: 'Email account ID from list_connected_accounts' },
        action: { type: 'string', enum: ['search', 'list', 'get', 'send'], description: 'Action to perform' },
        query: { type: 'string', description: 'Search query (search action)' },
        folder: { type: 'string', description: 'Folder to list (list action)', default: 'INBOX' },
        message_ids: { type: 'array', items: { type: 'string' }, description: 'Message IDs (get action)' },
        max_results: { type: 'number', description: 'Max results (search/list)', default: 10 },
        to: { type: ['string', 'array'], description: 'Recipient(s) (send action)' },
        subject: { type: 'string', description: 'Email subject (send action)' },
        body: { type: 'string', description: 'Email body (send action)' },
        cc: { type: ['string', 'array'], description: 'CC recipients (send action)' },
        bcc: { type: ['string', 'array'], description: 'BCC recipients (send action)' },
        reply_to_message_id: { type: 'string', description: 'Message ID to reply to (send action)' },
        is_html: { type: 'boolean', description: 'Body is HTML (send action)', default: false }
      },
      required: ['account_id', 'action']
    }
  },
  execute: async (args: any, context: any) => {
    const data = await mcpFetch({
      method: 'POST', path: '/api/emma/email', context: ctx(context),
      body: args
    });
    return jsonResult(data);
  }
});

mcpToolRegistry.register({
  name: 'save_file',
  internal: true,
  definition: {
    name: 'save_file',
    description: 'Save a file to cloud storage.',
    inputSchema: {
      type: 'object',
      properties: {
        file_name: { type: 'string', description: 'Name for the file' },
        file_content: { type: 'string', description: 'File content to save' }
      },
      required: ['file_name', 'file_content']
    }
  },
  execute: async (args: any, context: any) => {
    const data = await mcpFetch({
      method: 'POST', path: '/api/emma/save-file', context: ctx(context),
      body: { file_name: args.file_name, file_content: args.file_content }
    });
    return jsonResult(data);
  }
});
