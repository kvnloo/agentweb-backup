import express, { Request, RequestHandler, Response } from 'express';
import { createTask, getTasks, getTask, updateTask, deleteTask, executeTask, getTaskExecutions, updateTaskExecution, respondToInteraction, getTaskExecution, getExecutionLog, generateShareToken, getExecutionWithToken } from '../controllers/tasks';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { taskDb, subscriberDb } from '../services/db';
import multer from 'multer';
import { RequestHandler as ExpressRequestHandler } from 'express-serve-static-core';
import { isAdmin } from '../middleware/admin';
import { userDb } from '../services/db';
import { emailService } from '../services/emailService';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

type FileRequest = AuthenticatedRequest & {
  file?: Express.Multer.File;
};

// Public routes (no authentication required)
router.get('/execution/:executionId/token/:token', getExecutionWithToken);

// All other task routes require authentication
router.use(authenticateToken);

router.post('/', createTask);
router.get('/', getTasks);
router.get('/:id', getTask);
router.get('/:id/executions', getTaskExecutions);
router.get('/:id/executions/:executionId', getTaskExecution);
router.get('/:id/executions/:executionId/log', getExecutionLog);
router.get('/:id/executions/:executionId/share', generateShareToken);
router.put('/:id', updateTask);
router.delete('/:id', deleteTask);
router.post('/:id/execute', executeTask);
router.put('/:id/executions/:executionId', updateTaskExecution);
router.put('/:id/executions/:executionId/interactions/:interactionId', respondToInteraction);

// Get task subscribers
router.get('/:taskId/subscribers', async (req, res) => {
  try {
    const { taskId } = req.params;
    const subscribers = await subscriberDb.getTaskSubscribers(taskId);
    res.json(subscribers);
  } catch (error: any) {
    console.error('Error getting task subscribers:', error);
    res.status(500).json({ message: error.message });
  }
});

// Add subscriber to task
router.post('/:taskId/subscribers', async (req, res) => {
  try {
    const { taskId } = req.params;
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ message: 'Email is required' });
    }

    const subscriber = await subscriberDb.addSubscriber(taskId, email);
    res.status(201).json(subscriber);
  } catch (error: any) {
    console.error('Error adding subscriber:', error);
    res.status(500).json({ message: error.message });
  }
});

// Remove subscriber from task
router.delete('/:taskId/subscribers/:email', async (req, res) => {
  try {
    const { taskId, email } = req.params;
    await subscriberDb.removeSubscriber(taskId, email);
    res.status(204).send();
  } catch (error: any) {
    console.error('Error removing subscriber:', error);
    res.status(500).json({ message: error.message });
  }
});

// Upload attachment
router.post('/:taskId/attachments', upload.single('file'), (async (req, res) => {
  try {
    const { taskId } = req.params;
    const file = (req as FileRequest).file;

    if (!file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    // Check if user has access to task
    const task = await taskDb.getTaskById(taskId);
    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }
    if (task.userId !== (req as AuthenticatedRequest).user.userId) {
      return res.status(403).json({ error: 'Not authorized to modify this task' });
    }

    const attachment = await taskDb.addAttachment(taskId, file);
    res.json(attachment);
  } catch (error) {
    console.error('Error uploading attachment:', error);
    res.status(500).json({ error: 'Failed to upload attachment' });
  }
}) as ExpressRequestHandler);

// Delete attachment
router.delete('/:taskId/attachments/:key', authenticateToken, (async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { taskId, key } = req.params;

    // Check if user has access to task
    const task = await taskDb.getTaskById(taskId);
    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }
    if (task.userId !== req.user.userId) {
      return res.status(403).json({ error: 'Not authorized to modify this task' });
    }

    await taskDb.deleteAttachment(taskId, key);
    res.status(204).send();
  } catch (error) {
    console.error('Error deleting attachment:', error);
    res.status(500).json({ error: 'Failed to delete attachment' });
  }
}) as unknown as RequestHandler);

// Change task owner
router.put('/:id/owner', isAdmin, async (req: Request, res: Response) => {
  try {
    const { newOwnerEmail } = req.body;
    const taskId = req.params.id;
    const currentUserId = (req as AuthenticatedRequest).user?.userId;

    if (!newOwnerEmail) {
      return res.status(400).json({ message: 'New owner email is required' });
    }

    // Get the task
    const task = await taskDb.getTaskById(taskId);
    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    // Get the new owner
    const newOwner = await userDb.getUserByEmail(newOwnerEmail);
    if (!newOwner) {
      return res.status(404).json({ message: 'New owner not found' });
    }

    // Get the current owner
    const currentOwner = await userDb.getUserById(task.userId);
    if (!currentOwner) {
      return res.status(404).json({ message: 'Current owner not found' });
    }

    // Check if new owner is the same as current owner
    if (currentOwner.email === newOwnerEmail) {
      return res.status(400).json({ message: 'Cannot change ownership to the same owner' });
    }

    // Get the admin who made the change
    const adminUser = await userDb.getUserById(currentUserId);
    if (!adminUser) {
      return res.status(404).json({ message: 'Admin user not found' });
    }

    // Update task owner
    await taskDb.updateTaskOwner(taskId, newOwner.userId);

    // Send email notifications
    const siteDomain = process.env.FRONTEND_URL || 'https://agentweb.pro';
    
    // Send to admin with both users CCed
    await emailService.sendTaskOwnershipChangeEmail(
      process.env.ADMIN_EMAIL || '',
      task.name,
      taskId,
      currentOwner.email,
      newOwnerEmail,
      adminUser.email,
      siteDomain
    );

    // Send to old owner
    await emailService.sendTaskOwnershipChangeEmail(
      currentOwner.email,
      task.name,
      taskId,
      currentOwner.email,
      newOwnerEmail,
      adminUser.email,
      siteDomain
    );

    // Send to new owner
    await emailService.sendTaskOwnershipChangeEmail(
      newOwnerEmail,
      task.name,
      taskId,
      currentOwner.email,
      newOwnerEmail,
      adminUser.email,
      siteDomain
    );

    res.json({ message: 'Task ownership updated successfully' });
  } catch (error) {
    console.error('Error changing task owner:', error);
    res.status(500).json({ message: 'Error changing task owner' });
  }
});

// Archive execution
router.put('/:taskId/executions/:executionId/archive', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { taskId, executionId } = req.params;
    const userId = (req as AuthenticatedRequest).user?.userId;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    // Get the task to check ownership
    const task = await taskDb.getTaskById(taskId);
    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    // Check if user is owner or admin
    if (task.userId !== userId && !(req as AuthenticatedRequest).user?.isAdmin) {
      return res.status(403).json({ message: 'Not authorized to modify this task' });
    }

    // Archive the execution
    const updatedExecution = await taskDb.archiveExecution(taskId, executionId);
    res.json(updatedExecution);
  } catch (error) {
    console.error('Error archiving execution:', error);
    res.status(500).json({ message: 'Error archiving execution' });
  }
});

// Unarchive execution
router.put('/:taskId/executions/:executionId/unarchive', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { taskId, executionId } = req.params;
    const userId = (req as AuthenticatedRequest).user?.userId;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    // Get the task to check ownership
    const task = await taskDb.getTaskById(taskId);
    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    // Check if user is owner or admin
    if (task.userId !== userId && !(req as AuthenticatedRequest).user?.isAdmin) {
      return res.status(403).json({ message: 'Not authorized to modify this task' });
    }

    // Unarchive the execution
    const updatedExecution = await taskDb.unarchiveExecution(taskId, executionId);
    res.json(updatedExecution);
  } catch (error) {
    console.error('Error unarchiving execution:', error);
    res.status(500).json({ message: 'Error unarchiving execution' });
  }
});

export default router; 