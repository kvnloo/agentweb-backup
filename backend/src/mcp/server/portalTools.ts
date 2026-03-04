/**
 * Portal MCP Tools — CRUD operations for tasks, executions, and schedules.
 *
 * These tools let external AI agents (authenticated via aw_ API keys)
 * manage portal resources on behalf of the user who owns the key.
 *
 * All tools use the `portal_` prefix to distinguish them from Emma's
 * AI-powered tools (e.g. `create_task_from_prompt`).
 */

import { v4 as uuidv4 } from "uuid";
import { mcpToolRegistry } from "./registry";
import { taskDb, scheduleDb } from "../../services/db";

// ─── Helpers ────────────────────────────────────────────────────────────────

function jsonResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function requireUserId(context: any): string {
  if (!context?.userId) {
    throw new Error("Authentication required: no userId in context");
  }
  return context.userId;
}

async function requireTaskOwnership(taskId: string, userId: string) {
  const task = await taskDb.getTaskById(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  if (task.userId !== userId) throw new Error("Access denied: you do not own this task");
  return task;
}

async function requireScheduleOwnership(scheduleId: string, userId: string) {
  const schedule = await scheduleDb.getScheduleById(scheduleId);
  if (!schedule) throw new Error(`Schedule not found: ${scheduleId}`);
  if (schedule.userId !== userId) throw new Error("Access denied: you do not own this schedule");
  return schedule;
}

// ─── Task Management (8 tools) ─────────────────────────────────────────────

mcpToolRegistry.register({
  name: "portal_list_tasks",
  definition: {
    name: "portal_list_tasks",
    description: "List all tasks owned by the authenticated user.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  execute: async (_args: any, context: any) => {
    const userId = requireUserId(context);
    const tasks = await taskDb.getTasksByUserId(userId);
    return jsonResult(
      (tasks || []).map((t: any) => ({
        taskId: t.taskId,
        name: t.name,
        status: t.status,
        createdAt: t.createdAt,
        category: t.category,
      }))
    );
  },
});

mcpToolRegistry.register({
  name: "portal_get_task",
  definition: {
    name: "portal_get_task",
    description: "Get full details of a specific task by ID.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "The task ID to retrieve" },
      },
      required: ["taskId"],
    },
  },
  execute: async (args: any, context: any) => {
    const userId = requireUserId(context);
    const task = await requireTaskOwnership(args.taskId, userId);
    return jsonResult(task);
  },
});

mcpToolRegistry.register({
  name: "portal_create_task",
  definition: {
    name: "portal_create_task",
    description:
      "Create a new automation task. Returns the created task with its ID.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Task name" },
        prompt: { type: "string", description: "Task prompt / instructions" },
        category: { type: "string", description: "Optional category" },
        description: { type: "string", description: "Optional description" },
      },
      required: ["name", "prompt"],
    },
  },
  execute: async (args: any, context: any) => {
    const userId = requireUserId(context);
    const task = await taskDb.createTask({
      taskId: uuidv4(),
      userId,
      name: args.name,
      prompt: args.prompt,
      status: "active",
      createdAt: new Date().toISOString(),
      ...(args.category && { category: args.category }),
      ...(args.description && { description: args.description }),
    });
    return jsonResult(task);
  },
});

mcpToolRegistry.register({
  name: "portal_update_task",
  definition: {
    name: "portal_update_task",
    description: "Update an existing task. Only supply the fields you want to change.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "The task ID to update" },
        name: { type: "string", description: "New task name" },
        prompt: { type: "string", description: "New task prompt" },
        status: { type: "string", description: "New status" },
        category: { type: "string", description: "New category" },
        description: { type: "string", description: "New description" },
      },
      required: ["taskId"],
    },
  },
  execute: async (args: any, context: any) => {
    const userId = requireUserId(context);
    await requireTaskOwnership(args.taskId, userId);

    const { taskId, ...updates } = args;
    const updated = await taskDb.updateTask(taskId, updates);
    return jsonResult(updated);
  },
});

mcpToolRegistry.register({
  name: "portal_delete_task",
  definition: {
    name: "portal_delete_task",
    description: "Delete a task by ID. This is irreversible.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "The task ID to delete" },
      },
      required: ["taskId"],
    },
  },
  execute: async (args: any, context: any) => {
    const userId = requireUserId(context);
    await requireTaskOwnership(args.taskId, userId);
    await taskDb.deleteTask(args.taskId);
    return jsonResult({ deleted: true, taskId: args.taskId });
  },
});

mcpToolRegistry.register({
  name: "portal_execute_task",
  definition: {
    name: "portal_execute_task",
    description:
      "Queue a task for execution. Creates a pending task execution that the agent engine will pick up.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "The task ID to execute" },
      },
      required: ["taskId"],
    },
  },
  execute: async (args: any, context: any) => {
    const userId = requireUserId(context);
    await requireTaskOwnership(args.taskId, userId);

    const execution = await taskDb.createTaskExecution({
      executionId: uuidv4(),
      taskId: args.taskId,
      userId,
      status: "pending",
      startTime: new Date().toISOString(),
    });
    return jsonResult(execution);
  },
});

mcpToolRegistry.register({
  name: "portal_get_task_executions",
  definition: {
    name: "portal_get_task_executions",
    description: "List all executions for a specific task.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "The task ID" },
      },
      required: ["taskId"],
    },
  },
  execute: async (args: any, context: any) => {
    const userId = requireUserId(context);
    await requireTaskOwnership(args.taskId, userId);

    const executions = await taskDb.getTaskExecutions(args.taskId);
    return jsonResult(
      (executions || []).map((e: any) => ({
        executionId: e.executionId,
        status: e.status,
        startTime: e.startTime,
        completedAt: e.completedAt,
        error: e.error,
      }))
    );
  },
});

mcpToolRegistry.register({
  name: "portal_get_execution_details",
  definition: {
    name: "portal_get_execution_details",
    description: "Get full details of a specific task execution.",
    inputSchema: {
      type: "object",
      properties: {
        executionId: { type: "string", description: "The execution ID" },
      },
      required: ["executionId"],
    },
  },
  execute: async (args: any, context: any) => {
    const userId = requireUserId(context);
    const execution = await taskDb.getTaskExecutionById(args.executionId);
    if (!execution) throw new Error(`Execution not found: ${args.executionId}`);
    if (execution.userId !== userId)
      throw new Error("Access denied: you do not own this execution");

    return jsonResult(execution);
  },
});

// ─── Scheduling (4 tools) ───────────────────────────────────────────────────

mcpToolRegistry.register({
  name: "portal_list_schedules",
  definition: {
    name: "portal_list_schedules",
    description: "List all schedules for a specific task.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "The task ID" },
      },
      required: ["taskId"],
    },
  },
  execute: async (args: any, context: any) => {
    const userId = requireUserId(context);
    await requireTaskOwnership(args.taskId, userId);

    const schedules = await scheduleDb.getSchedulesByTaskId(args.taskId);
    return jsonResult(
      (schedules || []).map((s: any) => ({
        scheduleId: s.scheduleId,
        scheduleName: s.scheduleName,
        frequency: s.frequency,
        nextRunTime: s.nextRunTime,
        status: s.status,
      }))
    );
  },
});

mcpToolRegistry.register({
  name: "portal_create_schedule",
  definition: {
    name: "portal_create_schedule",
    description:
      "Create a recurring schedule for a task. Frequency can be daily, weekly, monthly, or a cron expression.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "The task ID to schedule" },
        frequency: {
          type: "string",
          description: "Schedule frequency: daily, weekly, monthly, or cron expression",
        },
        nextRunTime: {
          type: "string",
          description: "ISO 8601 datetime for the first run",
        },
        scheduleName: { type: "string", description: "Optional schedule name" },
        description: { type: "string", description: "Optional description" },
        timezone: { type: "string", description: "Optional timezone (e.g. America/Los_Angeles)" },
      },
      required: ["taskId", "frequency", "nextRunTime"],
    },
  },
  execute: async (args: any, context: any) => {
    const userId = requireUserId(context);
    await requireTaskOwnership(args.taskId, userId);

    const schedule = await scheduleDb.createSchedule({
      scheduleId: uuidv4(),
      taskId: args.taskId,
      userId,
      frequency: args.frequency,
      nextRunTime: args.nextRunTime,
      status: "active",
      createdAt: new Date().toISOString(),
      ...(args.scheduleName && { scheduleName: args.scheduleName }),
      ...(args.description && { description: args.description }),
      ...(args.timezone && { timezone: args.timezone }),
    });
    return jsonResult(schedule);
  },
});

mcpToolRegistry.register({
  name: "portal_update_schedule",
  definition: {
    name: "portal_update_schedule",
    description:
      "Update an existing schedule. Only supply the fields you want to change.",
    inputSchema: {
      type: "object",
      properties: {
        scheduleId: { type: "string", description: "The schedule ID to update" },
        frequency: { type: "string", description: "New frequency" },
        nextRunTime: { type: "string", description: "New next run time (ISO 8601)" },
        status: { type: "string", description: "New status (active or inactive)" },
        scheduleName: { type: "string", description: "New schedule name" },
        description: { type: "string", description: "New description" },
        timezone: { type: "string", description: "New timezone" },
      },
      required: ["scheduleId"],
    },
  },
  execute: async (args: any, context: any) => {
    const userId = requireUserId(context);
    await requireScheduleOwnership(args.scheduleId, userId);

    const { scheduleId, ...updates } = args;
    const updated = await scheduleDb.updateSchedule(scheduleId, updates);
    return jsonResult(updated);
  },
});

mcpToolRegistry.register({
  name: "portal_delete_schedule",
  definition: {
    name: "portal_delete_schedule",
    description: "Delete a schedule by ID. This is irreversible.",
    inputSchema: {
      type: "object",
      properties: {
        scheduleId: { type: "string", description: "The schedule ID to delete" },
      },
      required: ["scheduleId"],
    },
  },
  execute: async (args: any, context: any) => {
    const userId = requireUserId(context);
    await requireScheduleOwnership(args.scheduleId, userId);
    await scheduleDb.deleteSchedule(args.scheduleId);
    return jsonResult({ deleted: true, scheduleId: args.scheduleId });
  },
});
