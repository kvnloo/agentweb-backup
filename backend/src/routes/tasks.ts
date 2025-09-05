import express, { Request, RequestHandler, Response } from 'express';
import { createTask, getTasks, getTask, updateTask, deleteTask, executeTask, getTaskExecutions, updateTaskExecution, respondToInteraction, getTaskExecution, getExecutionLog, generateShareToken, getExecutionWithToken, sendExecutionEmail, uploadFileToExecution, getPlacidEditorToken, generateFromTemplateToExecution, listPlacidTemplates, createRevisionExecution } from '../controllers/tasks';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { taskDb, subscriberDb } from '../services/db';
import multer from 'multer';
import { RequestHandler as ExpressRequestHandler } from 'express-serve-static-core';
import { isAdmin } from '../middleware/admin';
import { userDb } from '../services/db';
import { emailService } from '../services/emailService';
import { Storage, Bucket } from '@google-cloud/storage';
import OpenAI from 'openai';
import axios from 'axios';
import AWS from 'aws-sdk';
import { dynamodb } from '../config/aws';
import { TABLE_PREFIX } from '../config/constants';

interface AuthRequest extends Request {
  user?: { userId: string; email: string };
}

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

// Initialize GCS with service account credentials
import { getGCSPPrivateKey } from '../utils/secretsManager';

// For Elastic Beanstalk deployment:
// 1. Replace all newlines in the private key with [NEWLINE]
// 2. Example format:
//    -----BEGIN PRIVATE KEY-----[NEWLINE]MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC9QFi67K6Z...[NEWLINE]...[NEWLINE]-----END PRIVATE KEY-----[NEWLINE]

// Initialize storage with async function to get private key
let storage: Storage;

// Initialize storage when needed
async function initializeStorage() {
  if (!storage) {
    const privateKey = await getGCSPPrivateKey();
    storage = new Storage({
      projectId: process.env.GCS_PROJECT_ID,
      credentials: {
        client_email: process.env.GCS_CLIENT_EMAIL,
        private_key: privateKey
      }
    });
  }
  return storage;
}

// Initialize Azure OpenAI client
const openai = new OpenAI({
  apiKey: process.env.AZURE_OPENAI_API_KEY,
  baseURL: `${process.env.AZURE_OPENAI_ENDPOINT}/openai/deployments/${process.env.AZURE_OPENAI_DEPLOYMENT}`,
  defaultQuery: {
    "api-version": process.env.AZURE_OPENAI_API_VERSION || "2024-08-01-preview",
  },
  defaultHeaders: { "api-key": process.env.AZURE_OPENAI_API_KEY },
});

// Ensure bucket exists
const BUCKET_NAME = process.env.GCS_BUCKET_NAME || 'agentweb-knowledge-base-dev';
const PRIVATE_BUCKET_NAME = process.env.GCS_BUCKET_NAME_PRIVATE || 'agentweb-knowledge-base-private-dev';

type FileRequest = AuthenticatedRequest & {
  file?: Express.Multer.File;
};

interface ResultFile {
  url: string;
  filename: string;
  token: string;
  is_html?: boolean;
  is_favorited?: boolean;
  is_archived?: boolean;
  placid_config?: {
    template_uuid: string;
    layers: Record<string, Record<string, string | boolean | number>>;
    source_image_url?: string;
    original_filename?: string;
  };
}

// Public routes (no authentication required)
router.get('/execution/:executionId/token/:token', getExecutionWithToken);
router.get('/:id/executions/:executionId/log', getExecutionLog);
// Check subscriber status (public - no authentication required)
router.get('/:taskId/subscribers/:email/status', async (req, res) => {
  try {
    const { taskId, email } = req.params;
    
    // Get all subscribers for this task
    const subscribers = await subscriberDb.getAllTaskSubscribers(taskId);
    if (!subscribers) {
      return res.status(500).json({ message: 'Failed to fetch subscribers' });
    }
    
    // Find the specific subscriber
    const subscriber = subscribers.find(s => s.email === email);
    if (!subscriber) {
      return res.status(404).json({ message: 'Subscriber not found for this task' });
    }
    
    res.json({
      email: subscriber.email,
      subscribedAt: subscriber.subscribedAt,
      unsubscribed: subscriber.unsubscribed || false,
      unsubscribedAt: subscriber.unsubscribedAt,
      resubscribedAt: subscriber.resubscribedAt,
      feedback: subscriber.feedback
    });
  } catch (error: any) {
    console.error('Error checking subscriber status:', error);
    res.status(500).json({ message: error.message });
  }
});

// Get task name (public)
router.get('/:id/name', async (req, res) => {
  try {
    const { id: taskId } = req.params;
    const task = await taskDb.getTaskById(taskId);
    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }
    res.json({ name: task.name });
  } catch (error: any) {
    console.error('Error getting task name:', error);
    res.status(500).json({ message: error.message });
  }
});

// Soft unsubscribe from task (public)
router.post('/:taskId/unsubscribe', async (req, res) => {
  try {
    const { taskId } = req.params;
    const { email, feedback } = req.body;

    if (!email) {
      return res.status(400).json({ message: 'Email is required' });
    }

    // Check if subscriber exists
    const subscribers = await subscriberDb.getAllTaskSubscribers(taskId);
    if (!subscribers) {
      return res.status(500).json({ message: 'Failed to fetch subscribers' });
    }
    const subscriber = subscribers.find(s => s.email === email);
    
    if (!subscriber) {
      return res.status(404).json({ message: 'Subscriber not found for this task' });
    }

    await subscriberDb.softUnsubscribe(taskId, email, feedback);
    res.json({ message: 'Successfully unsubscribed' });
  } catch (error: any) {
    console.error('Error unsubscribing:', error);
    res.status(500).json({ message: error.message });
  }
});

// Resubscribe to task (public)
router.post('/:taskId/resubscribe', async (req, res) => {
  try {
    const { taskId } = req.params;
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ message: 'Email is required' });
    }

    // Check if subscriber exists
    const subscribers = await subscriberDb.getAllTaskSubscribers(taskId);
    if (!subscribers) {
      return res.status(500).json({ message: 'Failed to fetch subscribers' });
    }
    const subscriber = subscribers.find(s => s.email === email);
    
    if (!subscriber) {
      return res.status(404).json({ message: 'Subscriber not found for this task' });
    }

    await subscriberDb.resubscribe(taskId, email);
    res.json({ message: 'Successfully resubscribed' });
  } catch (error: any) {
    console.error('Error resubscribing:', error);
    res.status(500).json({ message: error.message });
  }
});

// Resubscribe subscriber (admin only - requires authentication)
router.post('/:taskId/subscribers/:email/resubscribe', authenticateToken, async (req, res) => {
  try {
    const { taskId, email } = req.params;
    const userId = (req as AuthenticatedRequest).user?.userId;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    // Get task to verify ownership
    const task = await taskDb.getTaskById(taskId);
    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    // Verify task belongs to user or user is admin
    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(401).json({ message: 'User not found' });
    }

    if (!user.isAdmin && task.userId !== userId) {
      return res.status(403).json({ message: 'Access denied' });
    }

    // Check if subscriber exists
    const subscribers = await subscriberDb.getAllTaskSubscribers(taskId);
    if (!subscribers) {
      return res.status(500).json({ message: 'Failed to fetch subscribers' });
    }
    const subscriber = subscribers.find(s => s.email === email);
    
    if (!subscriber) {
      return res.status(404).json({ message: 'Subscriber not found for this task' });
    }

    await subscriberDb.resubscribe(taskId, email);
    res.json({ message: 'Successfully resubscribed' });
  } catch (error: any) {
    console.error('Error resubscribing:', error);
    res.status(500).json({ message: error.message });
  }
});

// All other task routes require authentication
router.use(authenticateToken);

router.post('/', createTask);
router.get('/', getTasks);
router.get('/:id', getTask);
router.get('/:id/executions', getTaskExecutions);
router.get('/:id/executions/:executionId', getTaskExecution);
router.get('/:id/executions/:executionId/share', generateShareToken);
router.post('/:id/executions/:executionId/email', sendExecutionEmail);
router.put('/:id', updateTask);
router.delete('/:id', deleteTask);
router.post('/:id/execute', executeTask);
router.put('/:id/executions/:executionId', updateTaskExecution);
router.put('/:id/executions/:executionId/interactions/:interactionId', respondToInteraction);

// Upload file directly to latest execution
router.post('/:id/upload-file', upload.single('file'), uploadFileToExecution);

// Create revision execution
router.post('/:id/executions/revision', authenticateToken, createRevisionExecution);

// Placid Editor SDK token
router.get('/:id/placid/editor-token', authenticateToken, getPlacidEditorToken);

// Generate image from a template (after editor save/test), add to execution
router.post('/:id/executions/:executionId/generate-from-template', authenticateToken, generateFromTemplateToExecution);

// List Placid templates (for selection)
router.get('/:id/placid/templates', authenticateToken, listPlacidTemplates);

// Kill execution
router.put('/:taskId/executions/:executionId/kill', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { taskId, executionId } = req.params;
    const userId = (req as AuthenticatedRequest).user?.userId;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const task = await taskDb.getTaskById(taskId);
    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    if (task.userId !== userId && !(req as AuthenticatedRequest).user?.isAdmin) {
      return res.status(403).json({ message: 'Not authorized to modify this execution' });
    }

    const execution = await taskDb.getTaskExecutionById(executionId);
    if (!execution) {
      return res.status(404).json({ message: 'Execution not found' });
    }

    if (execution.status.toLowerCase() !== 'running') {
      return res.status(400).json({ message: 'Execution is not in a running state and cannot be killed.' });
    }

    const updatedExecution = await taskDb.killTaskExecution(executionId);
    res.json(updatedExecution);
  } catch (error) {
    console.error('Error killing execution:', error);
    res.status(500).json({ message: 'Error killing execution' });
  }
});

// Get task subscribers (active only - public)
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

// Get all task subscribers including unsubscribed (admin only - requires authentication)
router.get('/:taskId/subscribers/all', authenticateToken, async (req, res) => {
  try {
    const { taskId } = req.params;
    const userId = (req as AuthenticatedRequest).user?.userId;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    // Get task to verify ownership
    const task = await taskDb.getTaskById(taskId);
    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    // Verify task belongs to user or user is admin
    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(401).json({ message: 'User not found' });
    }

    if (!user.isAdmin && task.userId !== userId) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const subscribers = await subscriberDb.getAllTaskSubscribers(taskId);
    console.log(`Admin endpoint: Found ${subscribers?.length || 0} subscribers for task ${taskId}:`, subscribers);
    res.json(subscribers);
  } catch (error: any) {
    console.error('Error getting all subscribers:', error);
    res.status(500).json({ message: error.message });
  }
});

// Update subscriber details
router.put('/:taskId/subscribers/:email', authenticateToken, async (req, res) => {
  try {
    const { taskId, email } = req.params;
    const userId = (req as AuthenticatedRequest).user?.userId;
    const { customFields } = req.body;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    // Get task to verify ownership
    const task = await taskDb.getTaskById(taskId);
    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    // Verify task belongs to user or user is admin
    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(401).json({ message: 'User not found' });
    }

    if (!user.isAdmin && task.userId !== userId) {
      return res.status(403).json({ message: 'Access denied' });
    }

    // Update subscriber custom fields only
    const updatedSubscriber = await subscriberDb.updateSubscriberCustomFields(
      taskId, 
      email, 
      customFields || {}
    );
    
    if (!updatedSubscriber) {
      return res.status(404).json({ message: 'Subscriber not found' });
    }

    res.json(updatedSubscriber);
  } catch (error: any) {
    console.error('Error updating subscriber:', error);
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
    if (error.message.includes('already subscribed')) {
      res.status(409).json({ message: error.message });
    } else {
      res.status(500).json({ message: error.message });
    }
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

    // Update task owner and all associated executions
    await taskDb.updateTaskOwner(taskId, newOwner.userId);
    await taskDb.updateTaskExecutionOwnership(taskId, newOwner.userId);

    // Send email notifications
    const siteDomain = process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174';
    
    // Prepare CC list - include old owner and admin if they're different from each other
    const ccList = [currentOwner.email];
    if (adminUser.email !== currentOwner.email) {
      ccList.push(adminUser.email);
    }
    const cc = ccList.join(', ');

    // Send single email to new owner with CCs
    try {
      await emailService.sendTaskOwnershipChangeEmail(
        newOwnerEmail,
        task.name,
        taskId,
        currentOwner.email,
        newOwnerEmail,
        adminUser.email,
        siteDomain,
        cc
      );
    } catch (error) {
      console.error('Failed to send ownership change email:', error);
    }

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

// Helper function to check file size
async function getFileSize(bucket: Bucket, filePath: string): Promise<number> {
  const file = bucket.file(filePath);
  const [exists] = await file.exists();
  if (!exists) return 0;
  
  const [metadata] = await file.getMetadata();
  if (!metadata || !metadata.size) {
    return 0;
  }
  return parseInt(String(metadata.size));
}

// Knowledge Base routes
router.get('/:taskId/knowledge-base', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { taskId } = req.params;
    const userId = (req as AuthenticatedRequest).user?.userId;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const task = await taskDb.getTaskById(taskId);
    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    if (task.userId !== userId && !(req as AuthenticatedRequest).user?.isAdmin) {
      return res.status(403).json({ message: 'Not authorized to access this task' });
    }

    // If knowledgeBaseType is not set, determine it based on file content
    if (!task.knowledgeBaseType) {
      const storageInstance = await initializeStorage();
      const publicBucket = storageInstance.bucket(BUCKET_NAME);
      const privateBucket = storageInstance.bucket(PRIVATE_BUCKET_NAME);
      const filePath = `tasks/${taskId}/knowledge-base.txt`;

      const publicSize = await getFileSize(publicBucket, filePath);
      const privateSize = await getFileSize(privateBucket, filePath);

      // Set type based on file content
      const type = publicSize > 0 ? 'public' : 'private';
      const size = type === 'public' ? publicSize : privateSize;

      await taskDb.updateTask(taskId, { 
        knowledgeBaseType: type,
        knowledgeBaseSize: size
      });
      task.knowledgeBaseType = type;
    }

    // Use the appropriate bucket based on knowledgeBaseType
    const storageInstance = await initializeStorage();
    const bucket = storageInstance.bucket(task.knowledgeBaseType === 'public' ? BUCKET_NAME : PRIVATE_BUCKET_NAME);
    const filePath = `tasks/${taskId}/knowledge-base.txt`;
    const file = bucket.file(filePath);

    // Check if file exists
    const [exists] = await file.exists();
    let contentStr = '';
    let url = '';
    let size = 0;
    if (exists) {
      // If file exists, get its content and size
      const [content] = await file.download();
      contentStr = content.toString();
      size = await getFileSize(bucket, filePath);
      
      // Generate signed URL
      const [url] = await file.getSignedUrl({
        action: 'read',
        expires: '03-01-2500' // Far future expiration
      });
    }
    // Update size if it doesn't match
    if (size !== task.knowledgeBaseSize) {
      await taskDb.updateTask(taskId, { 
        knowledgeBaseSize: size,
        knowledgeBaseUpdatedAt: new Date().toISOString()
      });
    }
    
    res.json({ 
      content: contentStr, 
      url: task.knowledgeBase || url,
      knowledgeBaseUpdatedAt: task.knowledgeBaseUpdatedAt
    });
  } catch (error) {
    console.error('Error in knowledge base GET:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

router.put('/:taskId/knowledge-base', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { taskId } = req.params;
    const { content } = req.body;
    const userId = (req as AuthenticatedRequest).user?.userId;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    // Allow empty content
    const contentToSave = content || '';

    const task = await taskDb.getTaskById(taskId);
    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    if (task.userId !== userId && !(req as AuthenticatedRequest).user?.isAdmin) {
      return res.status(403).json({ message: 'Not authorized to modify this task' });
    }

    if (!task.knowledgeBaseType) {
      return res.status(400).json({ message: 'Knowledge base type not defined' });
    }

    // Use the appropriate bucket based on knowledgeBaseType
    const storageInstance = await initializeStorage();
    const bucket = storageInstance.bucket(task.knowledgeBaseType === 'public' ? BUCKET_NAME : PRIVATE_BUCKET_NAME);
    const filePath = `tasks/${taskId}/knowledge-base.txt`;
    const file = bucket.file(filePath);

    // Save content to bucket
    await file.save(contentToSave, {
      contentType: 'text/plain',
      metadata: {
        taskId,
        userId,
        updatedAt: new Date().toISOString()
      }
    });

    // Get the public URL
    const [url] = await file.getSignedUrl({
      action: 'read',
      expires: '03-01-2500' // Far future expiration
    });
    
    // Update task with the new knowledge base size
    await taskDb.updateTask(taskId, { 
      knowledgeBaseSize: Buffer.byteLength(contentToSave, 'utf8'),
      knowledgeBase: url,
      knowledgeBaseUpdatedAt: new Date().toISOString()
    });
    
    res.json({ 
      content: contentToSave, 
      url: task.knowledgeBase || url,
      knowledgeBaseUpdatedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error in knowledge base PUT:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Update knowledge base from execution
router.post('/:taskId/executions/:executionId/update-knowledge-base', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { taskId, executionId } = req.params;
    const userId = (req as AuthenticatedRequest).user?.userId;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    if (!taskId || !executionId) {
      return res.status(400).json({ message: 'Task ID and Execution ID are required' });
    }

    const task = await taskDb.getTaskById(taskId);
    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    if (task.userId !== userId && !(req as AuthenticatedRequest).user?.isAdmin) {
      return res.status(403).json({ message: 'Not authorized to modify this task' });
    }

    const execution = await taskDb.getTaskExecutionById(executionId);
    if (!execution) {
      return res.status(404).json({ message: 'Execution not found' });
    }

    // Determine which bucket to use based on knowledgeBaseType
    let bucketType = task.knowledgeBaseType;
    const storageInstance = await initializeStorage();
    const bucket = storageInstance.bucket(bucketType === 'public' ? BUCKET_NAME : PRIVATE_BUCKET_NAME);
    const filePath = `tasks/${taskId}/knowledge-base.txt`;
    const file = bucket.file(filePath);
    const [exists] = await file.exists();
    
    let currentContent = '';
    if (exists) {
      const [content] = await file.download();
      currentContent = content.toString();
    }

    // Download and process result files
    let resultFilesContent = '';
    if (execution.result_files && execution.result_files.length > 0) {
      const textFiles = execution.result_files.filter((file: ResultFile) => 
        file.filename.endsWith('.html') || 
        file.filename.endsWith('.txt') || 
        file.filename.endsWith('.md')
      );

      for (const file of textFiles) {
        try {
          const response = await axios.get(file.url);
          resultFilesContent += `\n\nContent from ${file.filename}:\n${response.data}`;
        } catch (error) {
          console.error(`Error downloading file ${file.filename}:`, error);
        }
      }
    }

    // Use OpenAI to analyze the execution and suggest knowledge base updates
    const prompt = `Analyze the following task execution and suggest updates to the knowledge base. 
    Current knowledge base content:
    ${currentContent}
    
    Task execution details:
    Task: ${task.name}
    Prompt: ${task.prompt}
    Result: ${execution.result}
    Error: ${execution.error || 'None'}
    ${resultFilesContent ? `\nResult Files Content:${resultFilesContent}` : ''}
    
    Based on the above information, provide ONLY the updated markdown content for the knowledge base. Do not include any explanations, notes, or additional text. Output only the markdown content that should replace the current knowledge base content.`;

    // Call OpenAI to get the updated content
    const completion = await openai.chat.completions.create({
      messages: [{ role: "user", content: prompt }],
      model: process.env.AZURE_OPENAI_DEPLOYMENT || "gpt-4",
      temperature: 0.4,
      max_tokens: 32768,
    });

    const updatedContent = completion.choices[0].message.content || '';

    // Calculate knowledge base size in bytes
    const knowledgeBaseSize = Buffer.byteLength(updatedContent, 'utf8');

    // Save the updated content
    await file.save(updatedContent, {
      contentType: 'text/plain',
      metadata: {
        taskId,
        userId,
        updatedAt: new Date().toISOString(),
        sourceExecutionId: executionId
      }
    });

    // Get the public URL
    const [url] = await file.getSignedUrl({
      action: 'read',
      expires: '03-01-2500'
    });

    // Update the task with knowledge base size, type, and URL
    await taskDb.updateTask(taskId, {
      knowledgeBaseSize,
      knowledgeBase: url,
      knowledgeBaseUpdatedAt: new Date().toISOString()
    });

    // Update the execution record with knowledge base update info
    await taskDb.updateTaskExecution(executionId, {
      knowledge_base_updated_at: new Date().toISOString()
    });

    res.json({ 
      content: updatedContent,
      url,
      message: 'Knowledge base updated successfully',
      size: knowledgeBaseSize
    });
  } catch (error) {
    console.error('Error updating knowledge base from execution:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Add the knowledge base type toggle endpoint
router.put('/:id/knowledge-base-type', authenticateToken, async (req: Request, res: Response) => {
  const taskId = req.params.id;
  const { knowledgeBaseType } = req.body;
  const userId = (req as AuthenticatedRequest).user?.userId;

  if (!userId) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  if (!knowledgeBaseType || !['public', 'private'].includes(knowledgeBaseType)) {
    return res.status(400).json({ message: 'Invalid knowledge base type' });
  }

  try {
    // Get the task to check ownership
    const task = await taskDb.getTaskById(taskId);
    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    // Check if user owns the task
    if (task.userId !== userId && !(req as AuthenticatedRequest).user?.isAdmin) {
      return res.status(403).json({ message: 'Not authorized to modify this task' });
    }

    // Only move file if type is actually changing
    if (task.knowledgeBaseType !== knowledgeBaseType) {
      const filePath = `tasks/${taskId}/knowledge-base.txt`;
      const storageInstance = await initializeStorage();
      const currentBucket = storageInstance.bucket(task.knowledgeBaseType === 'public' ? BUCKET_NAME : PRIVATE_BUCKET_NAME);
      const newBucket = storageInstance.bucket(knowledgeBaseType === 'public' ? BUCKET_NAME : PRIVATE_BUCKET_NAME);
      const currentFile = currentBucket.file(filePath);
      const newFile = newBucket.file(filePath);
      // Check if current file exists
      const [exists] = await currentFile.exists();
      if (exists) {
        // Download current content
        const [content] = await currentFile.download();
        // Upload to new bucket
        await newFile.save(content, {
          contentType: 'text/plain',
          metadata: {
            taskId,
            userId,
            updatedAt: new Date().toISOString(),
            sourceBucket: task.knowledgeBaseType
          }
        });
        // Get the new URL
        const [url] = await newFile.getSignedUrl({
          action: 'read',
          expires: '03-01-2500'
        });
        // Update task with new bucket type and URL
        await taskDb.updateTask(taskId, {
          knowledgeBaseType,
          knowledgeBase: url,
          knowledgeBaseUpdatedAt: new Date().toISOString()
        });
        // Delete the old file
        await currentFile.delete();
        return res.json({ message: 'Knowledge base type and file moved successfully', knowledgeBaseType, url });
      } else {
        // If no file exists, just update the type
        await taskDb.updateTask(taskId, { 
          knowledgeBaseType,
          knowledgeBaseUpdatedAt: new Date().toISOString()
        });
        return res.json({ message: 'Knowledge base type updated (no file to move)', knowledgeBaseType });
      }
    } else {
      // If type is not changing, just return success
      return res.json({ message: 'Knowledge base type unchanged', knowledgeBaseType });
    }
  } catch (error) {
    console.error('Error updating knowledge base type:', error);
    res.status(500).json({ message: 'Failed to update knowledge base type' });
  }
});

// Get task lead list
router.get("/:taskId/lead-list", authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const taskId = req.params.taskId;
    const task = await taskDb.getTaskById(taskId);

    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    // Check if user is admin or task owner
    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(401).json({ message: 'User not found' });
    }

    if (!user.isAdmin && task.userId !== userId) {
      return res.status(403).json({ message: 'Access denied' });
    }

    // Query the lead list table
    const params = {
      TableName: `${TABLE_PREFIX}AW-TaskLeadList`,
      KeyConditionExpression: 'taskId = :taskId',
      ExpressionAttributeValues: {
        ':taskId': taskId
      }
    };

    const result = await dynamodb.query(params).promise();
    res.json({ records: result.Items || [] });
  } catch (error) {
    console.error('Error in getTaskLeadList:', error);
    res.status(500).json({ message: 'Error fetching lead list' });
  }
});

// Update lead list
router.put("/:taskId/lead-list", authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { taskId } = req.params;
    const { records } = req.body;

    if (!Array.isArray(records)) {
      return res.status(400).json({ message: 'Records must be an array' });
    }

    const task = await taskDb.getTaskById(taskId);
    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    // Check if user is admin or task owner
    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(401).json({ message: 'User not found' });
    }

    if (!user.isAdmin && task.userId !== userId) {
      return res.status(403).json({ message: 'Access denied' });
    }

    // Get existing records
    const existingParams = {
      TableName: `${TABLE_PREFIX}AW-TaskLeadList`,
      KeyConditionExpression: 'taskId = :taskId',
      ExpressionAttributeValues: {
        ':taskId': taskId
      }
    };

    const existingResult = await dynamodb.query(existingParams).promise();
    const existingRecords = existingResult.Items || [];

    // Create a map of existing records by identifier for easy lookup
    const existingRecordsMap = new Map(
      existingRecords.map(record => [record.identifier, record])
    );

    // Process each record in the request
    const updatedRecords = [];
    const now = new Date().toISOString();

    for (const record of records) {
      const identifier = record[task.leadListIdentifier];
      if (!identifier) {
        return res.status(400).json({ 
          message: `Each record must have a ${task.leadListIdentifier || 'leadListIdentifier'} field` 
        });
      }

      const existingRecord = existingRecordsMap.get(identifier);
      let updatedRecord;

      // Only update if the data has changed
      if (!existingRecord || JSON.stringify(existingRecord.data) !== JSON.stringify(record)) {
        updatedRecord = {
          taskId,
          identifier,
          data: record,
          updatedAt: now,
          ...(existingRecord ? {} : { createdAt: now })
        };

        const params = {
          TableName: `${TABLE_PREFIX}AW-TaskLeadList`,
          Item: updatedRecord
        };

        await dynamodb.put(params).promise();
      } else {
        // Use existing record if no changes
        updatedRecord = existingRecord;
      }

      updatedRecords.push(updatedRecord);
    }

    // Delete records that are no longer in the list
    const newIdentifiers = new Set(records.map(r => r[task.leadListIdentifier]));
    for (const existingRecord of existingRecords) {
      if (!newIdentifiers.has(existingRecord.identifier)) {
        await dynamodb.delete({
          TableName: `${TABLE_PREFIX}AW-TaskLeadList`,
          Key: {
            taskId,
            identifier: existingRecord.identifier
          }
        }).promise();
      }
    }

    res.json({ records: updatedRecords });
  } catch (error) {
    console.error('Error in updateLeadList:', error);
    res.status(500).json({ message: 'Error updating lead list' });
  }
});

// Common function to get executions with specific asset types
async function getExecutionsWithAssets(
  userId: string, 
  assetType: 'images' | 'videos' | 'html-reports',
  errorMessage: string
): Promise<Record<string, any>> {
  // Get all task executions for the user
  const allExecutions = await taskDb.getAllTaskExecutionsByUserId(userId) || [];
  
  // Define file filter functions for each asset type
  const fileFilters = {
    'images': (file: ResultFile) => {
      const filename = file.filename.toLowerCase();
      return filename.endsWith('.jpg') || 
             filename.endsWith('.jpeg') || 
             filename.endsWith('.png') || 
             filename.endsWith('.gif') || 
             filename.endsWith('.webp') || 
             filename.endsWith('.svg');
    },
    'videos': (file: ResultFile) => {
      const filename = file.filename.toLowerCase();
      return filename.endsWith('.mp4');
    },
    'html-reports': (file: ResultFile) => {
      const filename = file.filename.toLowerCase();
      return filename.endsWith('.html') || 
             filename.endsWith('.htm') ||
             (file.is_html === true);
    }
  };
  
  const fileFilter = fileFilters[assetType];
  
  // Filter executions that have result_files with the specified asset type and are not archived
  const executionsWithAssets = allExecutions.filter((execution: any) => {
    if (!execution.result_files || execution.result_files.length === 0) {
      return false;
    }
    
    // Skip archived executions
    if (execution.archived === true) {
      return false;
    }
    
    // Check if any result file matches the asset type
    return execution.result_files.some(fileFilter);
  });

  // Get all non-archived tasks for the user to match with executions
  const allTasks = await taskDb.getTasksByUserId(userId);
  const nonArchivedTasks = allTasks?.filter((task: any) => task.status !== 'archived') || [];
  const taskMap = new Map(nonArchivedTasks.map((task: any) => [task.taskId, task]));

  // Group executions by taskId, but only for non-archived tasks
  const result: Record<string, any> = {};
  
  executionsWithAssets.forEach((execution: any) => {
    const task = taskMap.get(execution.taskId);
    const taskId = execution.taskId;
    
    // Only include executions from non-archived tasks
    if (task) {
      if (!result[taskId]) {
        result[taskId] = {
          taskId: taskId,
          taskName: task.name,
          createdAt: task.createdAt,
          executions: []
        };
      }
      
      result[taskId].executions.push({
        executionId: execution.executionId,
        startTime: execution.startTime || null,
        result_files: execution.result_files?.filter(fileFilter) || []
      });
    }
  });

  // Calculate latest execution time and find latest pending/running execution for each task
  Object.keys(result).forEach(taskId => {
    const task = result[taskId];
    const executionTimes = task.executions
      .map((execution: any) => execution.startTime)
      .filter((time: string) => time !== null);
    
    if (executionTimes.length > 0) {
      task.latestExecutionTime = executionTimes.sort().pop(); // Get the latest time
    } else {
      task.latestExecutionTime = null;
    }

    // Find the most recent pending or running execution for this task
    const allTaskExecutions = allExecutions.filter((execution: any) => execution.taskId === taskId);
    const pendingOrRunningExecutions = allTaskExecutions.filter((execution: any) => 
      (execution.status === 'pending' || execution.status === 'running') && execution.archived !== true
    );
    
    if (pendingOrRunningExecutions.length > 0) {
      // Sort by startTime and get the most recent one
      const latestPendingOrRunning = pendingOrRunningExecutions.sort((a: any, b: any) => 
        new Date(b.startTime || 0).getTime() - new Date(a.startTime || 0).getTime()
      )[0];
      
      task.latestPendingOrRunningExecution = {
        executionId: latestPendingOrRunning.executionId,
        status: latestPendingOrRunning.status,
        startTime: latestPendingOrRunning.startTime || null
      };
    } else {
      task.latestPendingOrRunningExecution = null;
    }
  });

  return result;
}

// Get all executions with images for the current user
router.get('/executions/with-images', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthenticatedRequest).user?.userId;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const result = await getExecutionsWithAssets(userId, 'images', 'Error getting executions with images');
    res.json(result);
  } catch (error) {
    console.error('Error getting executions with images:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Get all executions with videos for the current user
router.get('/executions/with-videos', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthenticatedRequest).user?.userId;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const result = await getExecutionsWithAssets(userId, 'videos', 'Error getting executions with videos');
    res.json(result);
  } catch (error) {
    console.error('Error getting executions with videos:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Get all executions with HTML reports for the current user
router.get('/executions/with-html-reports', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthenticatedRequest).user?.userId;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const result = await getExecutionsWithAssets(userId, 'html-reports', 'Error getting executions with HTML reports');
    res.json(result);
  } catch (error) {
    console.error('Error getting executions with HTML reports:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Toggle favorite status for an image in a task execution
router.post('/executions/:executionId/favorite-image', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { executionId } = req.params;
    const { imageUrl } = req.body;
    const userId = (req as AuthenticatedRequest).user?.userId;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    if (!executionId || !imageUrl) {
      return res.status(400).json({ message: 'Execution ID and image URL are required' });
    }

    // Get the execution to verify ownership and get current result_files
    const execution = await taskDb.getTaskExecutionById(executionId);
    if (!execution) {
      return res.status(404).json({ message: 'Execution not found' });
    }

    // Verify the user owns this execution
    if (execution.userId !== userId && !(req as AuthenticatedRequest).user?.isAdmin) {
      return res.status(403).json({ message: 'Not authorized to modify this execution' });
    }

    // Find the image in result_files and toggle its favorite status
    const updatedResultFiles = execution.result_files?.map((file: ResultFile) => {
      if (file.url === imageUrl) {
        return {
          ...file,
          is_favorited: !file.is_favorited
        };
      }
      return file;
    }) || [];

    // Update the execution with the modified result_files
    await taskDb.updateTaskExecution(executionId, {
      result_files: updatedResultFiles
    });

    // Find the updated file to return its new favorite status
    const updatedFile = updatedResultFiles.find((file: ResultFile) => file.url === imageUrl);
    
    res.json({ 
      success: true, 
      is_favorited: updatedFile?.is_favorited || false 
    });

  } catch (error) {
    console.error('Error toggling image favorite status:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Archive an image in a task execution
router.post('/executions/:executionId/archive-image', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { executionId } = req.params;
    const { imageUrl } = req.body;
    const userId = (req as AuthenticatedRequest).user?.userId;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    if (!executionId || !imageUrl) {
      return res.status(400).json({ message: 'Execution ID and image URL are required' });
    }

    // Get the execution to verify ownership and get current result_files
    const execution = await taskDb.getTaskExecutionById(executionId);
    if (!execution) {
      return res.status(404).json({ message: 'Execution not found' });
    }

    // Verify the user owns this execution
    if (execution.userId !== userId && !(req as AuthenticatedRequest).user?.isAdmin) {
      return res.status(403).json({ message: 'Not authorized to modify this execution' });
    }

    // Find the image in result_files and mark it as archived
    const updatedResultFiles = execution.result_files?.map((file: ResultFile) => {
      if (file.url === imageUrl) {
        return {
          ...file,
          is_archived: true
        };
      }
      return file;
    }) || [];

    // Update the execution with the modified result_files
    await taskDb.updateTaskExecution(executionId, {
      result_files: updatedResultFiles
    });

    res.json({ 
      success: true, 
      message: 'Image archived successfully' 
    });

  } catch (error) {
    console.error('Error archiving image:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

export default router; 