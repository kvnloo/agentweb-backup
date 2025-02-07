import express from 'express';
import { authenticateToken } from '../middleware/auth';
import {
  listWorkflows,
  getWorkflow,
  createWorkflow,
  updateWorkflow,
  deleteWorkflow,
  getWorkflowExecutions,
  runWorkflow
} from '../controllers/workflows';

const router = express.Router();

// All routes require authentication
router.use(authenticateToken);

// Workflow routes
router.get('/', listWorkflows);
router.get('/:id', getWorkflow);
router.post('/', createWorkflow);
router.put('/:id', updateWorkflow);
router.delete('/:id', deleteWorkflow);

// Workflow execution routes
router.get('/:id/executions', getWorkflowExecutions);
router.post('/:id/run', runWorkflow);

export default router; 