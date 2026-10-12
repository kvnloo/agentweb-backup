import { Request, Response } from 'express';
import { WorkflowService, Workflow } from '../services/workflowDb';
import { AuthenticatedRequest } from '../middleware/auth';
import { generateWorkflowFromDescription } from '../services/workflowGenerator';
import { userDb } from '../services/db';

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

    // Check if user is admin or workflow owner
    const user = await userDb.getUserById(req.user.userId);
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    if (!user.isAdmin && workflow.userId !== req.user.userId) {
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
    const { id: workflowId, executionId } = req.params;

    // Check workflow exists and user has access
    const workflow = await workflowService.getWorkflow(workflowId);
    if (!workflow) {
      return res.status(404).json({ error: 'Workflow not found' });
    }

    // Check if user is admin or workflow owner
    const user = await userDb.getUserById(req.user.userId);
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    if (!user.isAdmin && workflow.userId !== req.user.userId) {
      return res.status(403).json({ error: 'Not authorized to view this workflow' });
    }

    if (executionId) {
      // Get specific execution
      const executions = await workflowService.getWorkflowExecutions(workflowId);
      const execution = executions.find(e => e.executionId === executionId);
      if (!execution) {
        return res.status(404).json({ error: 'Workflow execution not found' });
      }
      return res.json(execution);
    } else {
      // List all executions
      const executions = await workflowService.getWorkflowExecutions(workflowId);
      return res.json(executions);
    }
  } catch (error) {
    console.error('Error getting workflow executions:', error);
    res.status(500).json({ error: 'Failed to get workflow executions' });
  }
}

export async function generateWorkflow(req: AuthenticatedRequest, res: Response) {
  try {
    const { message, currentYaml } = req.body;
    const userId = req.user?.userId;

    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { yaml, nodes, edges, message: responseMessage } = await generateWorkflowFromDescription(
      message,
      userId,
      currentYaml
    );

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