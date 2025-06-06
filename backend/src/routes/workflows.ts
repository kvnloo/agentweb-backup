import express, { Request, Response } from 'express';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import {
  listWorkflows,
  getWorkflow,
  createWorkflow,
  updateWorkflow,
  deleteWorkflow,
  getWorkflowExecutions,
  runWorkflow,
  generateWorkflow
} from '../controllers/workflows';
import { WorkflowTask } from '../services/workflow';
import { WorkflowService, WorkflowExecution } from '../services/workflowDb';
import { v4 as uuidv4 } from 'uuid';
import yaml from 'js-yaml';
import { taskDb } from '../services/db';
import { Task } from '../types/task';

// Initialize workflow service
const workflowDb = new WorkflowService();

interface WorkflowNode {
  id: string;
  data: {
    prompt: string;
    taskId?: string;
    order?: number;
  };
}

interface WorkflowEdge {
  source: string;
  target: string;
}

// Extend the WorkflowExecution interface to include the fields we need
interface ExtendedWorkflowTask {
  nodeId: string;
  taskId: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  startTime: string;
  endTime?: string;
  error?: string;
  result?: string;
  executionId?: string;
  dependsOn?: string[];
  prompt: string;
}

interface ExtendedWorkflowExecution extends Omit<WorkflowExecution, 'tasks'> {
  tasks: ExtendedWorkflowTask[];
}

type RequestHandlerAuth = (req: Request, res: Response, next: express.NextFunction) => void;

const router = express.Router();

// All routes require authentication
router.use(authenticateToken);

// Helper function to wrap async handlers
const asyncHandler = (fn: (req: Request, res: Response, next: express.NextFunction) => Promise<any>) => {
  return (req: Request, res: Response, next: express.NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

// Workflow routes
router.get('/', listWorkflows as unknown as RequestHandlerAuth);
router.get('/:id', getWorkflow as unknown as RequestHandlerAuth);
router.post('/', createWorkflow as unknown as RequestHandlerAuth);
router.put('/:id', updateWorkflow as unknown as RequestHandlerAuth);
router.delete('/:id', deleteWorkflow as unknown as RequestHandlerAuth);

// Workflow generation route
router.post('/generate', generateWorkflow as unknown as RequestHandlerAuth);

// Workflow execution routes
router.get('/:id/executions', getWorkflowExecutions as unknown as RequestHandlerAuth);
router.get('/:id/executions/:executionId', getWorkflowExecutions as unknown as RequestHandlerAuth);
router.post('/:id/run', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.user?.userId;

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    console.log(`Running workflow ${id} for user ${userId}`);

    // Get workflow
    const workflow = await workflowDb.getWorkflow(id);
    if (!workflow) {
      console.error(`Workflow ${id} not found`);
      return res.status(404).json({ error: 'Workflow not found' });
    }

    console.log('Retrieved workflow:', JSON.stringify(workflow, null, 2));

    // Parse YAML to get nodes and edges
    const workflowData = yaml.load(workflow.yaml) as { nodes: WorkflowNode[]; edges: WorkflowEdge[] };
    console.log('Parsed workflow data:', JSON.stringify(workflowData, null, 2));

    if (!workflowData?.nodes || !Array.isArray(workflowData.nodes)) {
      console.error(`Workflow ${id} has no valid nodes array in YAML:`, workflowData?.nodes);
      return res.status(400).json({ error: 'Workflow has no tasks defined' });
    }

    // Create workflow execution
    const executionId = Date.now().toString();
    const execution: Omit<WorkflowExecution, 'executionId'> = {
      workflowId: id,
      userId,
      status: 'pending',
      startTime: new Date().toISOString(),
      tasks: await Promise.all(workflowData.nodes.map(async (node: WorkflowNode) => {
        if (!node.data?.prompt && !node.data?.taskId) {
          console.error(`Node missing both prompt and taskId:`, node);
          throw new Error(`Invalid workflow node: missing both prompt and taskId`);
        }

        // If taskId is provided, validate it exists
        let taskId = node.data.taskId;
        if (taskId) {
          const existingTask = await taskDb.getTaskById(taskId);
          if (!existingTask) {
            throw new Error(`Referenced task ${taskId} not found`);
          }
        } else {
          // Create a new task ID if none exists
          taskId = `task-${uuidv4()}`;
        }
        
        // Store the taskId in the node data for dependency resolution
        node.data.taskId = taskId;

        const dependsOn = workflowData.edges
          ? workflowData.edges
              .filter((edge: WorkflowEdge) => edge.target === node.id)
              .map((edge: WorkflowEdge) => {
                const sourceNode = workflowData.nodes.find((n: WorkflowNode) => n.id === edge.source);
                return sourceNode?.data?.taskId;
              })
              .filter((taskId: string | undefined): taskId is string => taskId !== undefined)
          : [];

        return {
          nodeId: node.id,
          taskId,
          status: 'pending' as const,
          startTime: new Date().toISOString(),
          order: node.data.order || 0,
          dependsOn: dependsOn.length > 0 ? dependsOn : undefined,
          prompt: node.data.prompt
        };
      }))
    };

    console.log('Creating workflow execution:', JSON.stringify(execution, null, 2));
    await workflowDb.createWorkflowExecution(execution);

    res.json({ executionId });
  } catch (error) {
    console.error('Error running workflow:', error);
    res.status(500).json({ error: 'Failed to run workflow', details: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// Kill workflow execution
router.put('/:workflowId/executions/:executionId/kill', authenticateToken, async (req, res) => {
  try {
    const { workflowId, executionId } = req.params;
    const userId = req.user?.userId;

    // Get the workflow execution
    const execution = await workflowDb.getWorkflowExecution(executionId);
    if (!execution) {
      return res.status(404).json({ message: 'Workflow execution not found' });
    }

    // Check if user has permission
    if (execution.userId !== userId) {
      return res.status(403).json({ message: 'Not authorized to kill this workflow execution' });
    }

    // Update the workflow execution to set killRequested
    await workflowDb.updateWorkflowExecution(executionId, {
      killRequested: new Date().toISOString()
    });

    res.json({ message: 'Workflow execution kill request sent' });
  } catch (error) {
    console.error('Error killing workflow execution:', error);
    res.status(500).json({ message: 'Failed to kill workflow execution' });
  }
});

router.put('/:workflowId/executions/:executionId/tasks/:taskId/rerun', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { workflowId, executionId, taskId } = req.params;
    const userId = (req as AuthenticatedRequest).user?.userId;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    // Get workflow execution
    const workflowExecution = await workflowDb.getWorkflowExecution(executionId) as ExtendedWorkflowExecution;
    if (!workflowExecution) {
      return res.status(404).json({ message: 'Workflow execution not found' });
    }

    // Check if workflow execution is in a state that allows rerunning tasks
    if (['pending', 'running'].includes(workflowExecution.status)) {
      return res.status(400).json({ message: 'Cannot rerun tasks while workflow is pending or running' });
    }

    // Find the task to rerun
    const taskToRerun = workflowExecution.tasks.find(t => t.taskId === taskId);
    if (!taskToRerun) {
      return res.status(404).json({ message: 'Task not found in workflow execution' });
    }

    // Check if all dependent tasks are completed
    if (taskToRerun.dependsOn) {
      const dependentTasks = workflowExecution.tasks.filter(t => taskToRerun.dependsOn?.includes(t.taskId));
      const allDependenciesCompleted = dependentTasks.every(t => t.status === 'completed');
      if (!allDependenciesCompleted) {
        return res.status(400).json({ message: 'Cannot rerun task: not all dependent tasks are completed' });
      }
    }

    // Get dependent task results and files for the prompt
    const dependentResults = [];
    if (taskToRerun.dependsOn) {
      for (const depTaskId of taskToRerun.dependsOn) {
        const depTask = workflowExecution.tasks.find(t => t.taskId === depTaskId);
        if (!depTask) continue;

        const resultParts = [];
        
        // Add task result if available
        if (depTask.result) {
          resultParts.push(depTask.result);
        }

        // Get result files from the task execution if available
        if (depTask.executionId) {
          const depExecution = await taskDb.getTaskExecutionById(depTask.executionId);
          if (depExecution?.result_files) {
            for (const fileInfo of depExecution.result_files) {
              try {
                const response = await fetch(fileInfo.url);
                if (response.ok) {
                  const content = await response.text();
                  resultParts.push(`Result file content:\n${content}`);
                }
              } catch (error) {
                console.error(`Error downloading file from ${fileInfo.url}:`, error);
              }
            }
          }
        }

        if (resultParts.length > 0) {
          dependentResults.push(`Task ${depTaskId}:\n${resultParts.join('\n\n')}`);
        }
      }
    }

    // Create the prompt with dependent results
    let taskPrompt;
    if (!taskToRerun.taskId.startsWith('task-')) {
      const task = await taskDb.getTaskById(taskToRerun.taskId);
      if (!task) {
        return res.status(404).json({ message: 'Referenced task not found' });
      }
      taskPrompt = task.prompt;
    } else {
      taskPrompt = taskToRerun.prompt;
    }
    // Remove any previous dependent task results from the prompt
    if (taskPrompt.includes('Dependent task results:')) {
      taskPrompt = taskPrompt.split('Dependent task results:')[0].trim();
    }
    if (dependentResults.length > 0) {
      taskPrompt = `Current task:
${taskPrompt}

Dependent task results:
${dependentResults.join('\n\n')}`;
    }

    // Create a new task execution
    const newExecution = {
      executionId: Date.now().toString(),
      taskId,
      userId: workflowExecution.userId,
      run_user_id: userId,
      status: 'pending',
      startTime: new Date().toISOString(),
      workflowExecutionId: executionId,
      prompt: taskPrompt
    };

    await taskDb.createTaskExecution(newExecution);

    // Update the task in the workflow execution
    const updatedTasks = workflowExecution.tasks.map(t => {
      if (t.taskId === taskId) {
        return {
          ...t,
          status: 'pending' as const,
          executionId: newExecution.executionId,
          error: undefined,
          result: undefined,
          completedAt: undefined
        };
      }
      return t;
    });

    // Update workflow execution
    const updatedExecution = await workflowDb.updateWorkflowExecution(executionId, {
      tasks: updatedTasks
    });

    res.json(updatedExecution);
  } catch (error) {
    console.error('Error rerunning task:', error);
    res.status(500).json({ message: 'Error rerunning task' });
  }
});

export default router; 