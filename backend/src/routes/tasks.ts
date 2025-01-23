import express from 'express';
import { createTask, getTasks, getTask, updateTask, deleteTask, executeTask, getTaskExecutions, updateTaskExecution } from '../controllers/tasks';
import { authenticateToken } from '../middleware/auth';

const router = express.Router();

// All task routes require authentication
router.use(authenticateToken);

router.post('/', createTask);
router.get('/', getTasks);
router.get('/:id', getTask);
router.get('/:id/executions', getTaskExecutions);
router.put('/:id', updateTask);
router.delete('/:id', deleteTask);
router.post('/:id/execute', executeTask);
router.put('/:id/executions/:executionId', updateTaskExecution);

export default router; 