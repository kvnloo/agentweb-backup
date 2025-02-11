import { Request, Response } from 'express';
import { WorkflowService, Workflow } from '../services/workflowDb';
import { AuthenticatedRequest } from '../middleware/auth';
import { generateWorkflowFromDescription } from '../services/workflowGenerator';

const workflowService = new WorkflowService();

export async function listWorkflows(req: AuthenticatedRequest, res: Response) {
  try {
    const workflows = await workflowService.listUserWorkflows(req.user.userId);
    res.json(workflows);
  } catch (error) {
    console.error('Error listing workflows:', error);
    res.status(500).json({ error: 'Failed to list workflows' });
  }
}

export async function getWorkflow(req: AuthenticatedRequest, res: Response) {
  try {
    const { id } = req.params;
    const workflow = await workflowService.getWorkflow(id);
    
    if (!workflow) {
      return res.status(404).json({ error: 'Workflow not found' });
    }

    if (workflow.userId !== req.user.userId) {
      return res.status(403).json({ error: 'Not authorized to access this workflow' });
    }

    res.json({
      ...workflow,
      messages: workflow.chatHistory
    });
  } catch (error) {
    console.error('Error getting workflow:', error);
    res.status(500).json({ error: 'Failed to get workflow' });
  }
}

export async function createWorkflow(req: AuthenticatedRequest, res: Response) {
  try {
    const { name, description, yaml, messages, taskCount } = req.body;

    // Create workflow
    const workflow = await workflowService.createWorkflow({
      userId: req.user.userId,
      name,
      description,
      status: 'active',
      yaml: yaml || '',
      taskCount: taskCount || 0,
      chatHistory: messages || []
    });

    res.status(201).json(workflow);
  } catch (error) {
    console.error('Error creating workflow:', error);
    res.status(500).json({ error: 'Failed to create workflow' });
  }
}

export async function updateWorkflow(req: AuthenticatedRequest, res: Response) {
  try {
    const { id } = req.params;
    const { name, description, status, yaml, messages, taskCount } = req.body;

    // Check workflow exists and user has access
    const workflow = await workflowService.getWorkflow(id);
    if (!workflow) {
      return res.status(404).json({ error: 'Workflow not found' });
    }
    if (workflow.userId !== req.user.userId) {
      return res.status(403).json({ error: 'Not authorized to update this workflow' });
    }

    // Update workflow details
    const updates: Partial<Workflow> = {};
    if (name) updates.name = name;
    if (description) updates.description = description;
    if (status) updates.status = status;
    if (yaml) updates.yaml = yaml;
    if (messages) updates.chatHistory = messages;
    if (typeof taskCount === 'number') updates.taskCount = taskCount;

    const updatedWorkflow = await workflowService.updateWorkflow(id, updates);
    res.json(updatedWorkflow);
  } catch (error) {
    console.error('Error updating workflow:', error);
    res.status(500).json({ error: 'Failed to update workflow' });
  }
}

export async function deleteWorkflow(req: AuthenticatedRequest, res: Response) {
  try {
    const { id } = req.params;

    // Check workflow exists and user has access
    const workflow = await workflowService.getWorkflow(id);
    if (!workflow) {
      return res.status(404).json({ error: 'Workflow not found' });
    }
    if (workflow.userId !== req.user.userId) {
      return res.status(403).json({ error: 'Not authorized to delete this workflow' });
    }

    await workflowService.deleteWorkflow(id);
    res.status(204).send();
  } catch (error) {
    console.error('Error deleting workflow:', error);
    res.status(500).json({ error: 'Failed to delete workflow' });
  }
}

export async function getWorkflowExecutions(req: AuthenticatedRequest, res: Response) {
  try {
    const { id } = req.params;

    // Check workflow exists and user has access
    const workflow = await workflowService.getWorkflow(id);
    if (!workflow) {
      return res.status(404).json({ error: 'Workflow not found' });
    }
    if (workflow.userId !== req.user.userId) {
      return res.status(403).json({ error: 'Not authorized to view this workflow' });
    }

    const executions = await workflowService.getWorkflowExecutions(id);
    res.json(executions);
  } catch (error) {
    console.error('Error getting workflow executions:', error);
    res.status(500).json({ error: 'Failed to get workflow executions' });
  }
}

export async function runWorkflow(req: AuthenticatedRequest, res: Response) {
  try {
    const { id } = req.params;

    // Check workflow exists and user has access
    const workflow = await workflowService.getWorkflow(id);
    if (!workflow) {
      return res.status(404).json({ error: 'Workflow not found' });
    }
    if (workflow.userId !== req.user.userId) {
      return res.status(403).json({ error: 'Not authorized to run this workflow' });
    }

    // Create execution record
    const execution = await workflowService.createWorkflowExecution({
      workflowId: id,
      userId: req.user.userId,
      status: 'pending',
      startTime: new Date().toISOString(),
      tasks: []
    });

    // TODO: Implement actual workflow execution logic
    // This should be handled by a separate service that:
    // 1. Parses the YAML to determine execution steps
    // 2. Executes tasks in sequence/parallel as defined
    // 3. Updates execution status and task statuses
    // 4. Handles errors and retries

    res.json(execution);
  } catch (error) {
    console.error('Error running workflow:', error);
    res.status(500).json({ error: 'Failed to run workflow' });
  }
}

export async function generateWorkflow(req: AuthenticatedRequest, res: Response) {
  try {
    const { message, currentYaml } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    const { yaml, nodes, edges, message: responseMessage } = await generateWorkflowFromDescription(message, currentYaml);

    res.json({
      yaml,
      nodes,
      edges,
      message: responseMessage
    });
  } catch (error) {
    console.error('Error generating workflow:', error);
    res.status(500).json({ error: 'Failed to generate workflow' });
  }
} 