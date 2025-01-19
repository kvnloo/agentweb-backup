import express from 'express';
import { createTask, getTasks, getTask, updateTask, deleteTask } from '../controllers/tasks';
import { authMiddleware } from '../middleware/auth';

const router = express.Router();

// All task routes require authentication
router.use(authMiddleware);

router.post('/', createTask);
router.get('/', getTasks);
router.get('/:id', getTask);
router.put('/:id', updateTask);
router.delete('/:id', deleteTask);

export default router; 