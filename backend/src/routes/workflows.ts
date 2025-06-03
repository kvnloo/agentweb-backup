import express, { Request, Response } from 'express';
import { authenticateToken } from '../middleware/auth';
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
import { workflowDb, WorkflowExecution, WorkflowTask } from '../services/workflow';
import { v4 as uuidv4 } from 'uuid';
import yaml from 'js-yaml';

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
    const execution: WorkflowExecution = {
      executionId,
      workflowId: id,
      userId,
      status: 'pending',
      startTime: new Date().toISOString(),
      tasks: workflowData.nodes.map((node: WorkflowNode) => {
        if (!node.data?.prompt) {
          console.error(`Node missing prompt:`, node);
          throw new Error(`Invalid workflow node: missing prompt`);
        }

        // Create a task ID for this node if it doesn't exist
        const taskId = node.data.taskId || `task-${uuidv4()}`;
        
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

        const task: WorkflowTask = {
          taskId,
          status: 'pending',
          order: node.data.order || 0,
          dependsOn: dependsOn.length > 0 ? dependsOn : undefined,
          prompt: node.data.prompt
        };

        return task;
      })
    };

    console.log('Creating workflow execution:', JSON.stringify(execution, null, 2));
    await workflowDb.createWorkflowExecution(execution);

    res.json({ executionId });
  } catch (error) {
    console.error('Error running workflow:', error);
    res.status(500).json({ error: 'Failed to run workflow', details: error instanceof Error ? error.message : 'Unknown error' });
  }
});

export default router; 