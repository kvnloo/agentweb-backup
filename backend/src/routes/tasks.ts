import express, { Request, RequestHandler, Response } from 'express';
import cors from 'cors';
import { createTask, getTasks, getTask, updateTask, deleteTask, executeTask, getTaskExecutions, updateTaskExecution, respondToInteraction, getTaskExecution, getExecutionLog, generateShareToken, getExecutionWithToken, sendExecutionEmail, uploadFileToExecution, getPlacidEditorToken, generateFromTemplateToExecution, listPlacidTemplates, createRevisionExecution, updateReport, getTaskExecutionPublic } from '../controllers/tasks';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { taskDb, subscriberDb, orgDb } from '../services/db';
import multer from 'multer';
import { RequestHandler as ExpressRequestHandler } from 'express-serve-static-core';
import { isAdmin } from '../middleware/admin';
import { userDb } from '../services/db';
import { canViewItem, canEditItem } from '../services/orgShareService';
import { emailService } from '../services/emailService';
import { Storage, Bucket } from '@google-cloud/storage';
import OpenAI from 'openai';
import axios from 'axios';
import AWS from 'aws-sdk';
import { dynamodb } from '../config/aws';
import { paginatedQuery } from '../utils/dynamoPagination';
import { TABLE_PREFIX } from '../config/constants';
import { ChatbotDB, ChatSession } from '../services/chatbotService';
import { MAX_FILE_SIZE } from '../config';
import { isSupportedFileType, getContentType } from '../utils/fileProcessor';
import { uploadFileToS3 } from '../utils/s3Utils';
import { classifyReport, ReportType } from '../services/reportClassificationService';

interface AuthRequest extends Request {
  user?: { userId: string; email: string };
}

const router = express.Router();
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_SIZE, // 100MB limit to support larger video uploads
  },
});

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
const s3 = new AWS.S3({
  region: process.env.AWS_REGION || 'us-west-2',
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
});

const S3_KEY_PREFIX = 's3:';

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
  reportType?: 'creative' | 'research' | 'performance';
  searchableText?: string;
  feedback?: {
    type: 'like' | 'dislike';
    reasons?: string[];
    comment?: string;
    timestamp: string;
    userId: string;
  };
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
router.get('/:id/executions/:executionId/public', getTaskExecutionPublic);
// Check subscriber status (public - no authentication required)
router.get('/:taskId/subscribers/:email/status', async (req, res) => {
  try {
    const { taskId, email } = req.params;
    
    // Get the specific subscriber
    const subscriber = await subscriberDb.getTaskSubscriberByEmail(taskId, email);
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
    const subscriber = await subscriberDb.getTaskSubscriberByEmail(taskId, email);
    
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
    const subscriber = await subscriberDb.getTaskSubscriberByEmail(taskId, email);
    
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

// Public endpoint for embed code/widget subscriptions (sends welcome email)
// Use CORS middleware to allow requests from any origin (for embed code)
router.post('/:taskId/subscribers/join', cors({
  origin: '*',
  methods: ['POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  credentials: false
}), async (req, res) => {
  try {
    const { taskId } = req.params;
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ message: 'Email is required' });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ message: 'Invalid email format' });
    }

    // Add subscriber
    const subscriber = await subscriberDb.addSubscriber(taskId, email);
    
    // Send welcome email asynchronously (don't wait for it to complete)
    // Pass taskId instead of task name so the function can get task and user config
    emailService.sendSubscriberWelcomeEmail(email, taskId).catch((emailError) => {
      console.error('Failed to send welcome email (subscription still succeeded):', emailError);
    });

    res.status(201).json(subscriber);
  } catch (error: any) {
    console.error('Error adding subscriber:', error);
    if (error.message.includes('already subscribed') || error.message.includes('already in the subscriber list')) {
      res.status(409).json({ message: error.message });
    } else {
      res.status(500).json({ message: error.message });
    }
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
    const subscriber = await subscriberDb.getTaskSubscriberByEmail(taskId, email);
    
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
router.put('/:id/email-sender', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { id: taskId } = req.params;
    const { emailSender, fromName } = req.body;
    const userId = req.user?.userId;

    if (!userId) {
      return res.status(401).json({ message: 'User not authenticated' });
    }

    // Validate email sender format if provided
    if (emailSender && !/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(emailSender)) {
      return res.status(400).json({ message: 'Invalid email sender format' });
    }

    // Check if task exists and user owns it
    const task = await taskDb.getTaskById(taskId);
    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    if (task.userId !== userId) {
      return res.status(403).json({ message: 'Access denied' });
    }

    // Update the task's email sender and from name
    await taskDb.updateTask(taskId, { emailSender, fromName });
    
    res.json({ message: 'Email sender updated successfully', emailSender, fromName });
  } catch (error) {
    console.error('Error updating email sender:', error);
    res.status(500).json({ message: 'Error updating email sender' });
  }
});

// Check if user has email domain configured
router.get('/:id/email-domain-status', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { id: taskId } = req.params;
    const userId = req.user?.userId;

    if (!userId) {
      return res.status(401).json({ message: 'User not authenticated' });
    }

    // Check if task exists and user owns it
    const task = await taskDb.getTaskById(taskId);
    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    if (task.userId !== userId) {
      return res.status(403).json({ message: 'Access denied' });
    }

    // Get user's email domain
    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const hasEmailDomain = !!(user.emailDomain && user.emailDomain.trim() !== '');
    
    res.json({ 
      hasEmailDomain,
      emailDomain: user.emailDomain || null
    });
  } catch (error) {
    console.error('Error checking email domain status:', error);
    res.status(500).json({ message: 'Error checking email domain status' });
  }
});

router.delete('/:id', deleteTask);
router.post('/:id/execute', executeTask);
router.put('/:id/executions/:executionId', updateTaskExecution);
router.put('/:id/executions/:executionId/interactions/:interactionId', respondToInteraction);

// Upload file directly to latest execution
router.post('/:id/upload-file', upload.single('file'), uploadFileToExecution);

// Create revision execution
router.post('/:id/executions/revision', authenticateToken, createRevisionExecution);

// Update existing report
router.post('/executions/update-report', authenticateToken, updateReport);

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
    console.log(`Admin endpoint: Found ${subscribers?.length || 0} subscribers for task ${taskId}`);
    res.json(subscribers);
  } catch (error: any) {
    console.error('Error getting all subscribers:', error);
    res.status(500).json({ message: error.message });
  }
});

// Add email history to subscriber
router.post('/:taskId/subscribers/:email/email-history', authenticateToken, async (req, res) => {
  try {
    const { taskId, email } = req.params;
    const userId = (req as AuthenticatedRequest).user?.userId;
    const { subject, taskExecutionId, htmlContentUrl, senderType, emailId } = req.body;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    if (!subject) {
      return res.status(400).json({ message: 'Subject is required' });
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

    // Add email history
    const sentAt = new Date().toISOString();
    const emailHistory = {
      sentAt: sentAt,
      subject,
      status: 'sent' as const,
      taskExecutionId,
      htmlContentUrl,
      senderType: senderType || 'SMTP',
      emailId: emailId || undefined
    };

    const updatedSubscriber = await subscriberDb.addEmailHistory(taskId, email, emailHistory);
    
    if (!updatedSubscriber) {
      return res.status(404).json({ message: 'Subscriber not found' });
    }

    res.json(updatedSubscriber);
  } catch (error: any) {
    console.error('Error adding email history:', error);
    res.status(500).json({ message: error.message });
  }
});

// Update email status
router.put('/:taskId/subscribers/:email/email-history/:emailId', authenticateToken, async (req, res) => {
  try {
    const { taskId, email, emailId } = req.params;
    const userId = (req as AuthenticatedRequest).user?.userId;
    const { status } = req.body;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    if (!status || !['delivered', 'opened', 'clicked', 'bounced', 'failed'].includes(status)) {
      return res.status(400).json({ message: 'Valid status is required' });
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

    // Update email status
    const updatedSubscriber = await subscriberDb.updateEmailStatus(taskId, email, emailId, status);
    
    if (!updatedSubscriber) {
      return res.status(404).json({ message: 'Subscriber or email not found' });
    }

    res.json(updatedSubscriber);
  } catch (error: any) {
    console.error('Error updating email status:', error);
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

// Batch upload subscribers from CSV
router.post('/:taskId/subscribers/batch', authenticateToken, async (req, res) => {
  try {
    const { taskId } = req.params;
    const userId = (req as AuthenticatedRequest).user?.userId;
    const { subscribers } = req.body;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    if (!subscribers || !Array.isArray(subscribers)) {
      return res.status(400).json({ message: 'Subscribers array is required' });
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

    // Process batch upload
    const results = await subscriberDb.batchAddSubscribers(taskId, subscribers);
    
    res.json({
      successCount: results.successCount,
      errorCount: results.errorCount,
      errors: results.errors
    });
  } catch (error: any) {
    console.error('Error batch uploading subscribers:', error);
    res.status(500).json({ message: error.message });
  }
});

// Get email events for a subscriber
router.get('/:taskId/subscribers/:email/email-events', authenticateToken, async (req, res) => {
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

    // Get subscriber details to access email history
    const subscriber = await subscriberDb.getTaskSubscriberByEmail(taskId, email);
    
    if (!subscriber || !subscriber.emailHistory) {
      return res.json({
        email,
        events: [],
        count: 0
      });
    }

    // Import emailEventsDb here to avoid circular dependency
    const { emailEventsDb } = await import('../services/emailEventsDb');
    
    // Collect all Resend email IDs from email history
    const resendEmailIds = subscriber.emailHistory
      .filter((emailHistory: any) => 
        emailHistory.senderType === 'resend' && emailHistory.emailId
      )
      .map((emailHistory: any) => emailHistory.emailId);

    // Fetch events for each Resend email ID
    const allEvents = [];
    for (const emailId of resendEmailIds) {
      const events = await emailEventsDb.getEventsByEmailId(emailId);
      allEvents.push(...events);
    }

    // Sort events by creation time (newest first)
    allEvents.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    
    res.json({
      email,
      events: allEvents,
      count: allEvents.length
    });
  } catch (error: any) {
    console.error('Error fetching subscriber email events:', error);
    res.status(500).json({ message: 'Failed to fetch subscriber email events' });
  }
});

// Get email metrics for all subscribers in a task
router.get('/:taskId/subscribers/metrics', authenticateToken, async (req, res) => {
  try {
    const { taskId } = req.params;
    const userId = (req as AuthenticatedRequest).user?.userId;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    // Use the common service to get metrics
    const { TaskSubscriberMetricsService } = await import('../services/taskSubscriberMetricsService');
    const metrics = await TaskSubscriberMetricsService.getTaskSubscriberMetrics(taskId, userId);
    
    res.json(metrics);
  } catch (error: any) {
    console.error('Error fetching subscriber metrics:', error);
    if (error.message === 'Task not found') {
      return res.status(404).json({ message: 'Task not found' });
    }
    if (error.message === 'User not found') {
      return res.status(401).json({ message: 'User not found' });
    }
    if (error.message === 'Access denied') {
      return res.status(403).json({ message: 'Access denied' });
    }
    res.status(500).json({ message: 'Failed to fetch subscriber metrics' });
  }
});

// Add subscriber to task (requires authentication - for customer-portal)
router.post('/:taskId/subscribers', authenticateToken, async (req, res) => {
  try {
    const { taskId } = req.params;
    const { email } = req.body;
    const userId = (req as AuthenticatedRequest).user?.userId;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    if (!email) {
      return res.status(400).json({ message: 'Email is required' });
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

    const subscriber = await subscriberDb.addSubscriber(taskId, email);
    res.status(201).json(subscriber);
  } catch (error: any) {
    console.error('Error adding subscriber:', error);
    if (error.message.includes('already subscribed') || error.message.includes('already in the subscriber list')) {
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

// ─── KB auth helper ──────────────────────────────────────────────────────────
// Resolves the caller + owner org context once and returns canView/canEdit
// helpers pre-bound to the "knowledgeBase" feature.
async function resolveKbAuthContext(callerId: string, ownerUserId: string) {
  const caller = await userDb.getUserById(callerId);
  let ownerOrgId: string | undefined;
  let org = null;
  if (ownerUserId === callerId) {
    ownerOrgId = caller?.orgId;
    if (caller?.orgId) org = await orgDb.getOrgById(caller.orgId);
  } else {
    const owner = await userDb.getUserById(ownerUserId);
    ownerOrgId = owner?.orgId;
    if (caller?.orgId && ownerOrgId === caller.orgId) {
      org = await orgDb.getOrgById(caller.orgId);
    }
  }
  return {
    caller,
    org,
    ownerOrgId,
    canView: () =>
      canViewItem(
        { userId: ownerUserId },
        { userId: callerId, orgId: caller?.orgId, orgRole: caller?.orgRole },
        org,
        ownerOrgId,
        'knowledgeBase',
      ),
    canEdit: () =>
      canEditItem(
        { userId: ownerUserId },
        { userId: callerId, orgId: caller?.orgId, orgRole: caller?.orgRole },
        org,
        ownerOrgId,
        'knowledgeBase',
      ),
  };
}

// Knowledge Base routes
// Get all knowledge bases for the authenticated user (+ org members when sharing enabled)
router.get('/knowledge-base/all', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthenticatedRequest).user?.userId;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    // Always fetch caller's own KB-tasks
    const ownTasks = await taskDb.getTasksWithKnowledgeBase(userId);

    // Check if org sharing is enabled for knowledgeBase
    const caller = await userDb.getUserById(userId);
    let allTasks = [...ownTasks];

    if (caller?.orgId) {
      const org = await orgDb.getOrgById(caller.orgId);
      const kbEnabled = org?.shareSettings?.knowledgeBase?.enabled === true;
      if (kbEnabled) {
        // Fanout: fetch KB-tasks for each org member (excluding caller)
        const members = await orgDb.getOrgMembers(caller.orgId);
        const otherMemberIds = members
          .map((m: any) => m.userId)
          .filter((uid: string) => uid !== userId);

        const perMember = await Promise.all(
          otherMemberIds.map((uid: string) => taskDb.getTasksWithKnowledgeBase(uid))
        );
        allTasks = [...ownTasks, ...perMember.flat()];
      }
    }

    // Dedupe by taskId
    const seen = new Set<string>();
    const deduped = allTasks.filter((task: any) => {
      if (seen.has(task.taskId)) return false;
      seen.add(task.taskId);
      return true;
    });

    // Map to return only necessary fields; include userId so the frontend can
    // show "Shared by" and correctly target PATCH/DELETE requests.
    const response = deduped.map((task: any) => ({
      taskId: task.taskId,
      userId: task.userId,
      name: task.name,
      knowledgeBaseSize: task.knowledgeBaseSize,
      knowledgeBaseType: task.knowledgeBaseType,
      knowledgeBaseFiles: task.knowledgeBaseFiles || [],
      knowledgeBaseUpdatedAt: task.knowledgeBaseUpdatedAt,
    }));

    res.json(response);
  } catch (error) {
    console.error('Error in knowledge base all GET:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

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

    const isAdminUser = (req as AuthenticatedRequest).user?.isAdmin;
    if (!isAdminUser) {
      const auth = await resolveKbAuthContext(userId, task.userId);
      if (!auth.canView()) {
        return res.status(403).json({ message: 'Not authorized to access this task' });
      }
    }

    // Include knowledgeBaseFiles in the response
    const knowledgeBaseFiles = (task as any).knowledgeBaseFiles || [];
    
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
    let signedUrl = '';
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
      signedUrl = url;
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
      url: task.knowledgeBase || signedUrl,
      knowledgeBaseFiles: knowledgeBaseFiles,
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

    const isAdminUser = (req as AuthenticatedRequest).user?.isAdmin;
    if (!isAdminUser) {
      const auth = await resolveKbAuthContext(userId, task.userId);
      if (!auth.canEdit()) {
        return res.status(403).json({ message: 'Not authorized to modify this task' });
      }
    }

    // Set knowledgeBaseType to 'private' if not defined
    const knowledgeBaseType = task.knowledgeBaseType || 'private';
    if (!task.knowledgeBaseType) {
      await taskDb.updateTask(taskId, { knowledgeBaseType: 'private' });
    }

    // Use the appropriate bucket based on knowledgeBaseType
    const storageInstance = await initializeStorage();
    const bucket = storageInstance.bucket(knowledgeBaseType === 'public' ? BUCKET_NAME : PRIVATE_BUCKET_NAME);
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
// NOTE: This is a machine-to-machine endpoint called by the agent engine after an
// execution completes. It uses owner-only (or admin) access intentionally —
// org editors should not be able to trigger automated KB rewrites on foreign tasks.
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

// Upload files to knowledge base endpoint
router.post('/:taskId/knowledge-base/files', authenticateToken, upload.array('files', 100), async (req: Request, res: Response) => {
  try {
    const { taskId } = req.params;
    const files = (req as FileRequest & { files?: Express.Multer.File[] }).files || [];
    const userId = (req as AuthenticatedRequest).user?.userId;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    if (!files || files.length === 0) {
      return res.status(400).json({ message: 'No files uploaded' });
    }

    const task = await taskDb.getTaskById(taskId);
    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    const isAdminUserFiles = (req as AuthenticatedRequest).user?.isAdmin;
    if (!isAdminUserFiles) {
      const auth = await resolveKbAuthContext(userId, task.userId);
      if (!auth.canEdit()) {
        return res.status(403).json({ message: 'Not authorized to modify this task' });
      }
    }

    // File processor functions are imported at the top

    // Set knowledgeBaseType to 'private' if not defined
    const knowledgeBaseType = task.knowledgeBaseType || 'private';
    if (!task.knowledgeBaseType) {
      await taskDb.updateTask(taskId, { knowledgeBaseType: 'private' });
    }

    // Use the appropriate bucket based on knowledgeBaseType
    const storageInstance = await initializeStorage();
    const bucket = storageInstance.bucket(knowledgeBaseType === 'public' ? BUCKET_NAME : PRIVATE_BUCKET_NAME);

    // Get existing knowledge base files
    const currentKnowledgeBaseFiles = (task as any).knowledgeBaseFiles || [];

    // Process each uploaded file
    const uploadedFiles: Array<{ filename: string; size: number; url: string; key: string; uploadedAt: string }> = [];

    for (const file of files) {
      const isMediaFile =
        file.mimetype?.startsWith('image/') ||
        file.mimetype?.startsWith('video/');

      // Validate file type
      if (!isSupportedFileType(file.originalname, file.mimetype)) {
        return res.status(400).json({ 
          message: `Unsupported file type: ${file.originalname}. Supported document types: TXT, PDF, HTML, DOCX, PPTX, XLSX, XLSM. Image types: JPG, JPEG, PNG, GIF, WEBP, BMP, SVG. Video types: MP4, MOV, WEBM, OGG, M4V, AVI.` 
        });
      }

      // Validate file size (matches multer limit and frontend MAX_FILE_SIZE)
      if (file.size > MAX_FILE_SIZE) {
        return res.status(400).json({ 
          message: `File ${file.originalname} exceeds maximum size of ${MAX_FILE_SIZE / (1024 * 1024)}MB` 
        });
      }

      try {
        if (isMediaFile) {
          const uploadResult = await uploadFileToS3(
            file.buffer,
            file.originalname,
            userId,
            file.mimetype || getContentType(file.originalname, file.mimetype)
          );

          if (!uploadResult.success || !uploadResult.url || !uploadResult.key) {
            return res.status(400).json({ 
              message: `Failed to upload file ${file.originalname}: ${uploadResult.error || 'Unknown error'}` 
            });
          }

          uploadedFiles.push({
            filename: file.originalname,
            size: file.size,
            url: uploadResult.url,
            key: `${S3_KEY_PREFIX}${uploadResult.key}`,
            uploadedAt: new Date().toISOString()
          });
          continue;
        }

        // Store the file in GCS
        const timestamp = Date.now();
        const sanitizedFilename = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
        const filePath = `tasks/${taskId}/knowledge-base-files/${timestamp}_${sanitizedFilename}`;
        const gcsFile = bucket.file(filePath);
        
        const buffer = Buffer.from(file.buffer);
        await gcsFile.save(buffer, {
          contentType: getContentType(file.originalname, file.mimetype),
          metadata: {
            taskId,
            userId,
            originalName: file.originalname,
            uploadedAt: new Date().toISOString()
          }
        });

        // Get signed URL for the file
        const [url] = await gcsFile.getSignedUrl({
          action: 'read',
          expires: '03-01-2500' // Far future expiration
        });

        uploadedFiles.push({
          filename: file.originalname,
          size: file.size,
          url,
          key: filePath,
          uploadedAt: new Date().toISOString()
        });
      } catch (error: any) {
        console.error(`Error uploading file ${file.originalname}:`, error);
        return res.status(400).json({ 
          message: `Failed to upload file ${file.originalname}: ${error.message}` 
        });
      }
    }

    // Update task with new knowledge base files
    const updatedKnowledgeBaseFiles = [...currentKnowledgeBaseFiles, ...uploadedFiles];
    
    console.log('Uploading files:', {
      taskId,
      currentFiles: currentKnowledgeBaseFiles.length,
      newFiles: uploadedFiles.length,
      totalFiles: updatedKnowledgeBaseFiles.length,
      filesArray: JSON.stringify(updatedKnowledgeBaseFiles)
    });
    
    await taskDb.updateTask(taskId, {
      knowledgeBaseFiles: updatedKnowledgeBaseFiles,
      knowledgeBaseUpdatedAt: new Date().toISOString()
    });

    // Verify the update by fetching the task again
    const updatedTask = await taskDb.getTaskById(taskId);
    const savedFiles = (updatedTask as any)?.knowledgeBaseFiles || [];
    
    console.log('After update, retrieved task:', {
      taskId,
      savedFilesCount: savedFiles.length,
      savedFiles: JSON.stringify(savedFiles)
    });

    res.json({
      message: `Successfully uploaded ${uploadedFiles.length} file(s)`,
      files: uploadedFiles,
      knowledgeBaseFiles: savedFiles.length > 0 ? savedFiles : updatedKnowledgeBaseFiles,
      knowledgeBaseUpdatedAt: new Date().toISOString()
    });
  } catch (error: any) {
    console.error('Error uploading files to knowledge base:', error);
    res.status(500).json({ 
      message: 'Internal server error',
      error: error.message 
    });
  }
});

// Delete knowledge base file endpoint
router.delete('/:taskId/knowledge-base/files/:fileKey', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { taskId, fileKey } = req.params;
    const userId = (req as AuthenticatedRequest).user?.userId;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const task = await taskDb.getTaskById(taskId);
    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    const isAdminUserFileDelete = (req as AuthenticatedRequest).user?.isAdmin;
    if (!isAdminUserFileDelete) {
      const auth = await resolveKbAuthContext(userId, task.userId);
      if (!auth.canEdit()) {
        return res.status(403).json({ message: 'Not authorized to modify this task' });
      }
    }

    // Decode the file key (it's URL encoded)
    const decodedKey = decodeURIComponent(fileKey);
    if (decodedKey.startsWith(S3_KEY_PREFIX)) {
      try {
        await s3
          .deleteObject({
            Bucket: process.env.AWS_S3_BUCKET || 'agentweb-user-files',
            Key: decodedKey.slice(S3_KEY_PREFIX.length),
          })
          .promise();
      } catch (s3Error) {
        console.warn('Failed to delete from S3:', s3Error);
      }

      const currentFiles = (task as any).knowledgeBaseFiles || [];
      const updatedFiles = currentFiles.filter((f: any) => f.key !== decodedKey);

      await taskDb.updateTask(taskId, {
        knowledgeBaseFiles: updatedFiles,
        knowledgeBaseUpdatedAt: new Date().toISOString()
      });

      return res.json({ 
        message: 'File deleted successfully',
        knowledgeBaseFiles: updatedFiles
      });
    }

    // Delete file from GCS
    const storageInstance = await initializeStorage();
    const bucket = storageInstance.bucket(task.knowledgeBaseType === 'public' ? BUCKET_NAME : PRIVATE_BUCKET_NAME);
    const file = bucket.file(decodedKey);
    
    const [exists] = await file.exists();
    if (exists) {
      await file.delete();
    }

    // Update task to remove the file from knowledgeBaseFiles
    const currentFiles = (task as any).knowledgeBaseFiles || [];
    const updatedFiles = currentFiles.filter((f: any) => f.key !== decodedKey);
    
    await taskDb.updateTask(taskId, {
      knowledgeBaseFiles: updatedFiles,
      knowledgeBaseUpdatedAt: new Date().toISOString()
    });

    res.json({ 
      message: 'File deleted successfully',
      knowledgeBaseFiles: updatedFiles
    });
  } catch (error) {
    console.error('Error deleting knowledge base file:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Delete knowledge base endpoint (clear entire KB content)
// Access: owner OR org admin (orgRole==="owner") only. Editors CANNOT wipe a foreign KB.
router.delete('/:taskId/knowledge-base', authenticateToken, async (req: Request, res: Response) => {
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

    const isAdminUser = (req as AuthenticatedRequest).user?.isAdmin;
    if (!isAdminUser) {
      // Only the task owner or an org admin (orgRole==="owner") may clear the KB.
      // Editors can upload/edit files but cannot wipe the entire KB.
      if (task.userId !== userId) {
        const auth = await resolveKbAuthContext(userId, task.userId);
        const callerOrgRole = auth.caller?.orgRole;
        if (!auth.canView() || callerOrgRole !== 'owner') {
          return res.status(403).json({ message: 'Not authorized to modify this task' });
        }
      }
    }

    if (!task.knowledgeBaseType) {
      return res.status(400).json({ message: 'Knowledge base does not exist for this task' });
    }

    // Delete file from GCS bucket
    const storageInstance = await initializeStorage();
    const bucket = storageInstance.bucket(task.knowledgeBaseType === 'public' ? BUCKET_NAME : PRIVATE_BUCKET_NAME);
    const filePath = `tasks/${taskId}/knowledge-base.txt`;
    const file = bucket.file(filePath);
    
    // Check if file exists and delete it
    const [exists] = await file.exists();
    if (exists) {
      await file.delete();
    }

    // Update task to remove knowledge base information
    await taskDb.updateTask(taskId, {
      knowledgeBaseSize: 0,
      knowledgeBase: undefined,
      knowledgeBaseType: undefined,
      knowledgeBaseUpdatedAt: undefined
    });

    res.json({ message: 'Knowledge base deleted successfully' });
  } catch (error) {
    console.error('Error deleting knowledge base:', error);
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

    // Check if user owns the task (or is an org editor / admin)
    const isAdminUserKbType = (req as AuthenticatedRequest).user?.isAdmin;
    if (!isAdminUserKbType) {
      const auth = await resolveKbAuthContext(userId, task.userId);
      if (!auth.canEdit()) {
        return res.status(403).json({ message: 'Not authorized to modify this task' });
      }
    }

    // Only move files if type is actually changing
    if (task.knowledgeBaseType !== knowledgeBaseType) {
      const storageInstance = await initializeStorage();
      const currentBucket = storageInstance.bucket(task.knowledgeBaseType === 'public' ? BUCKET_NAME : PRIVATE_BUCKET_NAME);
      const newBucket = storageInstance.bucket(knowledgeBaseType === 'public' ? BUCKET_NAME : PRIVATE_BUCKET_NAME);
      
      // Move knowledge base text file
      const filePath = `tasks/${taskId}/knowledge-base.txt`;
      const currentFile = currentBucket.file(filePath);
      const newFile = newBucket.file(filePath);
      
      // Get existing knowledge base files
      const knowledgeBaseFiles = (task as any).knowledgeBaseFiles || [];
      const updatedFiles: Array<{ filename: string; size: number; url: string; key: string; uploadedAt: string }> = [];
      
      // Move all knowledge base files to the new bucket
      for (const fileInfo of knowledgeBaseFiles) {
        try {
          const oldFileKey = fileInfo.key;
          if (typeof oldFileKey !== 'string' || oldFileKey.startsWith(S3_KEY_PREFIX)) {
            updatedFiles.push(fileInfo);
            continue;
          }
          const oldFile = currentBucket.file(oldFileKey);
          const [fileExists] = await oldFile.exists();
          
          if (fileExists) {
            // Download file from old bucket
            const [fileContent] = await oldFile.download();
            
            // Get file metadata to preserve content type
            const [metadata] = await oldFile.getMetadata();
            const contentType = metadata.contentType || 'application/octet-stream';
            
            // Upload to new bucket (same path)
            const newFileObj = newBucket.file(oldFileKey);
            await newFileObj.save(fileContent, {
              contentType: contentType,
              metadata: {
                ...metadata.metadata,
                taskId,
                userId,
                movedAt: new Date().toISOString(),
                sourceBucket: task.knowledgeBaseType
              }
            });
            
            // Get new signed URL
            const [newUrl] = await newFileObj.getSignedUrl({
              action: 'read',
              expires: '03-01-2500'
            });
            
            // Delete old file
            await oldFile.delete();
            
            // Update file info with new URL
            updatedFiles.push({
              ...fileInfo,
              url: newUrl
            });
          } else {
            // File doesn't exist in old bucket, keep as is (might have been deleted)
            updatedFiles.push(fileInfo);
          }
        } catch (error: any) {
          console.error(`Error moving file ${fileInfo.filename}:`, error);
          // Keep the old file info if move fails
          updatedFiles.push(fileInfo);
        }
      }
      
      // Check if knowledge base text file exists
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
        // Update task with new bucket type, URL, and moved files
        await taskDb.updateTask(taskId, {
          knowledgeBaseType,
          knowledgeBase: url,
          knowledgeBaseFiles: updatedFiles,
          knowledgeBaseUpdatedAt: new Date().toISOString()
        });
        // Delete the old file
        await currentFile.delete();
        return res.json({ 
          message: 'Knowledge base type and files moved successfully', 
          knowledgeBaseType, 
          url,
          filesMoved: updatedFiles.length
        });
      } else {
        // If no text file exists, just update the type and files
        await taskDb.updateTask(taskId, { 
          knowledgeBaseType,
          knowledgeBaseFiles: updatedFiles,
          knowledgeBaseUpdatedAt: new Date().toISOString()
        });
        return res.json({ 
          message: 'Knowledge base type updated', 
          knowledgeBaseType,
          filesMoved: updatedFiles.length
        });
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

    const records = await paginatedQuery(dynamodb, params);
    res.json({ records });
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

    const existingRecords = await paginatedQuery(dynamodb, existingParams);

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
      const filename = (file.filename || '').toLowerCase();
      return filename.endsWith('.jpg') ||
             filename.endsWith('.jpeg') ||
             filename.endsWith('.png') ||
             filename.endsWith('.gif') ||
             filename.endsWith('.webp') ||
             filename.endsWith('.svg');
    },
    'videos': (file: ResultFile) => {
      const filename = (file.filename || '').toLowerCase();
      return filename.endsWith('.mp4');
    },
    'html-reports': (file: ResultFile) => {
      const filename = (file.filename || '').toLowerCase();
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
          source: 'task',
          executions: []
        };
      }

      result[taskId].executions.push({
        executionId: execution.executionId,
        startTime: execution.startTime || null,
        result_files: execution.result_files?.filter(fileFilter).map((file: ResultFile) => ({
          ...file,
          source: 'task'
        })) || []
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

  // Search Agent Mode sessions for assets using incremental caching
  const chatbotDbForEnrich = new ChatbotDB();
  try {
    const chatbotDb = chatbotDbForEnrich;
    // Load sessions metadata only (no messages) — single DynamoDB query
    const agentSessions = await chatbotDb.getSessionsWithoutMessages(userId, 'agent');

    // Phase 1: Load messages in parallel batches (avoid DynamoDB throttling).
    // For html-reports: sessions without assetCache are skipped in the main path
    // (they have no known assets) and warmed in the background so future loads pick
    // them up. For images/videos we retain the original eager-scan behavior.
    const BATCH_SIZE = 15;
    const activeSessions = agentSessions.filter(s => !s.archived);

    let sessionsToScan: typeof activeSessions;

    if (assetType === 'html-reports') {
      const cachedSessions = activeSessions.filter(s => s.assetCache !== undefined && s.assetScanIndex !== undefined);
      const uncachedSessions = activeSessions.filter(s => s.assetCache === undefined || s.assetScanIndex === undefined);

      // Background-warm uncached sessions (fire-and-forget)
      if (uncachedSessions.length > 0) {
        (async () => {
          try {
            for (let i = 0; i < uncachedSessions.length; i += BATCH_SIZE) {
              const batch = uncachedSessions.slice(i, i + BATCH_SIZE);
              await Promise.all(batch.map(async (session) => {
                try {
                  const messages = await chatbotDb.getMessagesFromMessagesTable(session.sessionId);
                  const newAssets = scanMessagesForAssets(messages, session);
                  const cache = { images: newAssets.images, videos: newAssets.videos, htmlReports: newAssets.htmlReports };
                  const maxIndex = messages.reduce((max: number, m: any) => {
                    const idx = m.messageIndex ?? 0;
                    return idx > max ? idx : max;
                  }, 0);
                  chatbotDb.updateAssetCache(session.sessionId, cache, maxIndex + 1);
                } catch { /* non-fatal */ }
              }));
            }
          } catch { /* non-fatal */ }
        })();
      }

      sessionsToScan = cachedSessions;
    } else {
      sessionsToScan = activeSessions;
    }

    const sessionResults: Array<{ session: typeof activeSessions[0]; messages: any[]; existingCache: any }> = [];

    for (let i = 0; i < sessionsToScan.length; i += BATCH_SIZE) {
      const batch = sessionsToScan.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(batch.map(async (session) => {
        const cachedScanIndex = session.assetScanIndex ?? 0;
        const cachedMessageCount = session.messageCount ?? 0;
        const hasCache = session.assetCache !== undefined && session.assetScanIndex !== undefined;

        let messages: any[];
        let existingCache = session.assetCache || { images: [], videos: [], htmlReports: [] };

        if (hasCache && cachedMessageCount > 0 && cachedScanIndex >= cachedMessageCount) {
          messages = [];
        } else if (hasCache && cachedMessageCount === 0) {
          messages = [];
        } else if (hasCache && cachedScanIndex > 0 && cachedScanIndex < cachedMessageCount) {
          messages = await chatbotDb.getMessagesFromIndex(session.sessionId, cachedScanIndex);
        } else {
          messages = await chatbotDb.getMessagesFromMessagesTable(session.sessionId);
          existingCache = { images: [], videos: [], htmlReports: [] };
        }

        return { session, messages, existingCache };
      }));
      sessionResults.push(...batchResults);
    }

    // Phase 2: Process results sequentially (fast, no I/O)
    for (const { session, messages, existingCache } of sessionResults) {
      if (messages.length > 0) {
        const newAssets = scanMessagesForAssets(messages, session);
        existingCache.images.push(...newAssets.images);
        existingCache.videos.push(...newAssets.videos);
        existingCache.htmlReports.push(...newAssets.htmlReports);

        const maxIndex = messages.reduce((max: number, m: any) => {
          const idx = m.messageIndex ?? 0;
          return idx > max ? idx : max;
        }, 0);
        const newScanIndex = maxIndex + 1;

        chatbotDb.updateAssetCache(session.sessionId, existingCache, newScanIndex);
      }

      const sessionKey = `agent-mode-${session.sessionId}`;

      if (assetType === 'images') {
        addCachedAssetsToResult(result, sessionKey, session, existingCache.images, 'images');
      } else if (assetType === 'videos') {
        addCachedAssetsToResult(result, sessionKey, session, existingCache.videos, 'videos');
      } else if (assetType === 'html-reports') {
        addCachedHtmlReportsToResult(result, sessionKey, session, existingCache.htmlReports, messages);
      }
    }

    // Calculate latest execution time for agent mode sessions
    Object.keys(result).forEach(key => {
      if (result[key].source === 'agent-mode') {
        const task = result[key];
        const executionTimes = task.executions
          .map((execution: any) => execution.startTime)
          .filter((time: string) => time !== null);

        task.latestExecutionTime = executionTimes.length > 0 ? executionTimes.sort().pop() : null;
        task.latestPendingOrRunningExecution = null;
      }
    });
  } catch (error) {
    console.error(`Error fetching Agent Mode ${assetType}:`, error);
  }

  // Enrich HTML report result files with searchable text content (fire-and-forget —
  // the result object is mutated in-place, but we don't block the response on it;
  // cached values are already populated so this only runs for brand-new reports).
  if (assetType === 'html-reports') {
    // Run searchableText enrichment first (populates content used by classifier), then classify.
    enrichHtmlReportsWithSearchableText(result, chatbotDbForEnrich)
      .then(() => classifyUnlabeledReports(result, chatbotDbForEnrich))
      .catch(() => {/* non-fatal */});
  }

  return result;
}

/**
 * Fetch HTML content for report files that lack searchableText and attach extracted plain text.
 * Persists newly-fetched searchableText back to DynamoDB (session assetCache or task execution
 * result_files) so subsequent loads skip the S3 fetch entirely.
 * Runs concurrently (up to 10 at a time) so it doesn't block the response for long.
 */
async function enrichHtmlReportsWithSearchableText(result: Record<string, any>, chatbotDb: ChatbotDB): Promise<void> {
  const CONCURRENCY = 10;
  const MAX_TEXT_LENGTH = 3000;

  // Collect all result files that need enrichment, tagging each with its execution context
  const filesToEnrich: Array<{ file: any; executionId: string; sessionId?: string }> = [];
  for (const task of Object.values(result) as any[]) {
    for (const execution of task.executions || []) {
      for (const file of execution.result_files || []) {
        if (!file.searchableText && file.url && (file.is_html || (file.filename || '').toLowerCase().endsWith('.html'))) {
          filesToEnrich.push({ file, executionId: execution.executionId, sessionId: file.sessionId });
        }
      }
    }
  }

  // Process in batches
  for (let i = 0; i < filesToEnrich.length; i += CONCURRENCY) {
    const batch = filesToEnrich.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async ({ file }) => {
      try {
        const response = await axios.get(file.url, { timeout: 5000, responseType: 'text' });
        const html: string = typeof response.data === 'string' ? response.data : '';
        // Strip tags, collapse whitespace, truncate
        const text = html
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, MAX_TEXT_LENGTH);
        file.searchableText = text;
      } catch {
        // Non-fatal — leave searchableText absent if fetch fails
      }
    }));
  }

  // Persist newly-fetched searchableTexts back to DynamoDB so future loads skip S3 fetches.
  // Group successful enrichments by sessionId (agent-mode) or executionId (task).
  // For agent-mode sessions, cap at MAX_CACHE_PER_SESSION most-recent reports to keep
  // assetCache item size bounded; older reports are fetched live on demand.
  const MAX_CACHE_PER_SESSION = 10;
  const sessionUpdates = new Map<string, Array<{ url: string; searchableText: string; generatedAt?: string }>>();
  const executionUpdates = new Map<string, any[]>();

  for (const { file, executionId, sessionId } of filesToEnrich) {
    if (!file.searchableText) continue; // fetch failed, skip

    if (sessionId) {
      if (!sessionUpdates.has(sessionId)) sessionUpdates.set(sessionId, []);
      sessionUpdates.get(sessionId)!.push({ url: file.url, searchableText: file.searchableText, generatedAt: file.generatedAt });
    } else {
      if (!executionUpdates.has(executionId)) executionUpdates.set(executionId, []);
      executionUpdates.get(executionId)!.push(file);
    }
  }

  // Fire-and-forget persistence (non-critical, don't delay the response)
  for (const [sessionId, updates] of sessionUpdates) {
    // Keep only the most recent MAX_CACHE_PER_SESSION entries to bound item size
    const toCache = updates
      .sort((a, b) => (b.generatedAt || '').localeCompare(a.generatedAt || ''))
      .slice(0, MAX_CACHE_PER_SESSION)
      .map(({ url, searchableText }) => ({ url, searchableText }));
    chatbotDb.persistSearchableTexts(sessionId, toCache).catch(() => {/* already logged inside */});
  }
  for (const [execId, files] of executionUpdates) {
    for (const task of Object.values(result) as any[]) {
      const exec = (task.executions || []).find((e: any) => e.executionId === execId);
      if (exec) {
        taskDb.updateTaskExecutionResultFiles(execId, exec.result_files).catch(() => {/* non-critical */});
        break;
      }
    }
  }
}

/**
 * Classify HTML reports that have no reportType yet.
 * Uses the filename + cached searchableText as context for the LLM call.
 * Persists results back to DynamoDB (same lazy-backfill pattern as searchableText).
 */
async function classifyUnlabeledReports(result: Record<string, any>, chatbotDb: ChatbotDB): Promise<void> {
  const CONCURRENCY = 5;

  const filesToClassify: Array<{ file: any; executionId: string; sessionId?: string }> = [];
  for (const task of Object.values(result) as any[]) {
    for (const execution of task.executions || []) {
      for (const file of execution.result_files || []) {
        if (!file.reportType && file.is_html) {
          filesToClassify.push({ file, executionId: execution.executionId, sessionId: file.sessionId });
        }
      }
    }
  }

  if (filesToClassify.length === 0) return;

  for (let i = 0; i < filesToClassify.length; i += CONCURRENCY) {
    const batch = filesToClassify.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async ({ file }) => {
      try {
        file.reportType = await classifyReport(file.filename || '', file.searchableText || '');
      } catch {
        // Non-fatal
      }
    }));
  }

  // Persist back — group by session (agent-mode) or execution (task)
  const sessionUpdates = new Map<string, Array<{ url: string; reportType: ReportType }>>();
  const executionUpdates = new Map<string, any[]>();

  for (const { file, executionId, sessionId } of filesToClassify) {
    if (!file.reportType) continue;
    if (sessionId) {
      if (!sessionUpdates.has(sessionId)) sessionUpdates.set(sessionId, []);
      sessionUpdates.get(sessionId)!.push({ url: file.url, reportType: file.reportType });
    } else {
      if (!executionUpdates.has(executionId)) executionUpdates.set(executionId, []);
      executionUpdates.get(executionId)!.push(file);
    }
  }

  for (const [sessionId, updates] of sessionUpdates) {
    chatbotDb.persistReportTypes(sessionId, updates).catch(() => {});
  }
  for (const [execId, files] of executionUpdates) {
    for (const task of Object.values(result) as any[]) {
      const exec = (task.executions || []).find((e: any) => e.executionId === execId);
      if (exec) {
        taskDb.updateTaskExecutionResultFiles(execId, exec.result_files).catch(() => {});
        break;
      }
    }
  }
}

/**
 * Scan messages in a single pass and extract all asset types.
 * Returns arrays of discovered images, videos, and HTML reports.
 */
function scanMessagesForAssets(
  messages: any[],
  session: ChatSession
): { images: Array<{ url: string; filename: string; generatedAt: string }>; videos: Array<{ url: string; filename: string; generatedAt: string }>; htmlReports: Array<{ url: string; filename: string; generatedAt: string; searchableText?: string; reportType?: 'creative' | 'research' | 'performance' }> } {
  const images: Array<{ url: string; filename: string; generatedAt: string }> = [];
  const videos: Array<{ url: string; filename: string; generatedAt: string }> = [];
  const htmlReports: Array<{ url: string; filename: string; generatedAt: string; searchableText?: string; reportType?: 'creative' | 'research' | 'performance' }> = [];

  const htmlUrlRegex = /(https?:\/\/[^\s"]+\.amazonaws\.com\/[^\s"]+\.html)/gi;
  const seenUrls = new Set<string>();

  let lastAssistantTimestamp: string | undefined;

  for (const message of messages) {
    const ownTimestamp = message.timestamp || message.metadata?.timestamp;

    if (message.role === 'assistant' && ownTimestamp) {
      lastAssistantTimestamp = ownTimestamp;
    }

    const timestamp = ownTimestamp || lastAssistantTimestamp || session.updatedAt || session.createdAt;

    if (!message.metadata?.toolCalls) {
      // Still check message content for HTML URLs
      if (typeof message.content === 'string') {
        htmlUrlRegex.lastIndex = 0;
        let match;
        while ((match = htmlUrlRegex.exec(message.content)) !== null) {
          const url = match[1];
          if (!seenUrls.has(url)) {
            seenUrls.add(url);
            htmlReports.push({ url, filename: url.split('/').pop() || 'report.html', generatedAt: timestamp });
          }
        }
      }
      continue;
    }

    for (const toolCall of message.metadata.toolCalls) {
      // Images
      if ((toolCall.name === 'generate_image' || toolCall.name === 'upload_image') && toolCall.result?.success && toolCall.result?.imageUrl) {
        const url = toolCall.result.imageUrl;
        if (!seenUrls.has(url)) {
          seenUrls.add(url);
          images.push({
            url,
            filename: toolCall.result.filename || 'generated-image.png',
            generatedAt: timestamp,
          });
        }
      }

      // Videos
      if ((toolCall.name === 'generate_video' || toolCall.name === 'upload_video') && toolCall.result?.success && toolCall.result?.videoUrl) {
        const url = toolCall.result.videoUrl;
        if (!seenUrls.has(url)) {
          seenUrls.add(url);
          videos.push({
            url,
            filename: toolCall.result.filename || 'generated-video.mp4',
            generatedAt: timestamp,
          });
        }
      }

      // HTML reports from tool call results
      const toolResult = toolCall?.result || {};
      const urlCandidates = [
        toolResult.s3_url,
        toolResult.file_url,
        toolResult.htmlUrl,
        toolResult.blog_html_url
      ].filter(Boolean);

      for (const url of urlCandidates) {
        if ((url.toLowerCase().endsWith('.html') || url.toLowerCase().endsWith('.htm')) && !seenUrls.has(url)) {
          seenUrls.add(url);
          htmlReports.push({
            url,
            filename: toolResult.filename || toolResult.file_name || toolResult.versioned_filename || url.split('/').pop() || 'report.html',
            generatedAt: timestamp,
          });
        }
      }
    }

    // Also check message content for HTML URLs
    if (typeof message.content === 'string') {
      htmlUrlRegex.lastIndex = 0;
      let match;
      while ((match = htmlUrlRegex.exec(message.content)) !== null) {
        const url = match[1];
        if (!seenUrls.has(url)) {
          seenUrls.add(url);
          htmlReports.push({ url, filename: url.split('/').pop() || 'report.html', generatedAt: timestamp });
        }
      }
    }
  }

  return { images, videos, htmlReports };
}

/**
 * Add cached image/video assets to the result, applying favorites/archives/feedbacks from session.
 */
function addCachedAssetsToResult(
  result: Record<string, any>,
  sessionKey: string,
  session: ChatSession,
  assets: Array<{ url: string; filename: string; generatedAt: string }>,
  type: 'images' | 'videos'
): void {
  const urlField = type === 'images' ? 'imageUrl' : 'videoUrl';
  const executionSuffix = type === 'images' ? '-images' : '-videos';

  for (const asset of assets) {
    const isArchived = session.archives?.[asset.url] || false;
    if (isArchived) continue;

    const isFavorited = session.favorites?.[asset.url] || false;
    const feedback = session.feedbacks?.[asset.url];

    if (!result[sessionKey]) {
      result[sessionKey] = {
        taskId: sessionKey,
        taskName: session.title || 'Agent Mode Session',
        createdAt: session.createdAt,
        source: 'agent-mode',
        sessionId: session.sessionId,
        executions: []
      };
    }

    const executionId = `${session.sessionId}${executionSuffix}`;
    let execution = result[sessionKey].executions.find((exec: any) => exec.executionId === executionId);

    if (!execution) {
      execution = {
        executionId,
        startTime: asset.generatedAt,
        result_files: []
      };
      result[sessionKey].executions.push(execution);
    } else if (asset.generatedAt && (!execution.startTime || asset.generatedAt > execution.startTime)) {
      execution.startTime = asset.generatedAt;
    }

    // Avoid duplicates
    if (!execution.result_files.some((f: any) => f.url === asset.url)) {
      execution.result_files.push({
        url: asset.url,
        filename: asset.filename,
        token: '',
        source: 'agent-mode',
        sessionId: session.sessionId,
        generatedAt: asset.generatedAt,
        is_favorited: isFavorited,
        is_archived: false,
        feedback,
      });
    }
  }
}

/**
 * Add cached HTML report assets to the result, including publish status annotation.
 */
function addCachedHtmlReportsToResult(
  result: Record<string, any>,
  sessionKey: string,
  session: ChatSession,
  assets: Array<{ url: string; filename: string; generatedAt: string; searchableText?: string; reportType?: 'creative' | 'research' | 'performance' }>,
  messages: any[]
): void {
  for (const asset of assets) {
    const isArchived = session.archives?.[asset.url] || false;
    if (isArchived) continue;

    const isFavorited = session.favorites?.[asset.url] || false;
    const feedback = session.feedbacks?.[asset.url];

    if (!result[sessionKey]) {
      result[sessionKey] = {
        taskId: sessionKey,
        taskName: session.title || 'Agent Mode Session',
        createdAt: session.createdAt,
        source: 'agent-mode',
        sessionId: session.sessionId,
        executions: []
      };
    }

    const executionId = `${session.sessionId}-html`;
    let execution = result[sessionKey].executions.find((exec: any) => exec.executionId === executionId);

    if (!execution) {
      execution = {
        executionId,
        startTime: asset.generatedAt,
        result_files: []
      };
      result[sessionKey].executions.push(execution);
    } else if (asset.generatedAt && (!execution.startTime || asset.generatedAt > execution.startTime)) {
      execution.startTime = asset.generatedAt;
    }

    if (!execution.result_files.some((f: any) => f.url === asset.url)) {
      execution.result_files.push({
        url: asset.url,
        filename: asset.filename,
        token: '',
        source: 'agent-mode',
        sessionId: session.sessionId,
        generatedAt: asset.generatedAt,
        is_html: true,
        is_favorited: isFavorited,
        is_archived: false,
        feedback,
        ...(asset.searchableText ? { searchableText: asset.searchableText } : {}),
        ...(asset.reportType ? { reportType: asset.reportType } : {}),
      });
    }
  }

  // Annotate publish statuses from messages (publish_blog_article tool calls)
  if (result[sessionKey] && messages.length > 0) {
    for (const message of messages) {
      if (!message.metadata?.toolCalls) continue;
      for (const toolCall of message.metadata.toolCalls) {
        if (toolCall.name !== 'publish_blog_article') continue;
        const blogHtmlUrl = toolCall.arguments?.blog_html_url;
        if (!blogHtmlUrl) continue;

        const publishStatus = toolCall.result?.data?.status || toolCall.arguments?.status || 'draft';
        const isSuccess = toolCall.result?.success !== undefined ? toolCall.result.success : !toolCall.error;
        if (!isSuccess) continue;

        for (const execution of result[sessionKey].executions) {
          const matchingFile = execution.result_files.find((file: any) => file.url === blogHtmlUrl);
          if (matchingFile) {
            matchingFile.publishStatus = publishStatus;
            break;
          }
        }
      }
    }
  }

  // Apply session-level publish statuses (set by publish-direct button)
  if (result[sessionKey] && session.publishStatuses) {
    for (const execution of result[sessionKey].executions) {
      for (const file of execution.result_files) {
        if (session.publishStatuses[file.url] && !file.publishStatus) {
          file.publishStatus = session.publishStatuses[file.url];
        }
      }
    }
  }
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
    // Strip searchableText from the response payload without mutating result in-place.
    // In-place deletion would race with the background enrichment that also writes
    // file.searchableText on the same objects (microtask ordering puts the route
    // handler continuation between the enrichment's fetch batch and its persist
    // section). Using JSON round-trip creates a separate serialized copy so the
    // live result objects used by enrichment/classify are untouched.
    const responsePayload = JSON.parse(JSON.stringify(result));
    for (const task of Object.values(responsePayload) as any[]) {
      for (const execution of task.executions || []) {
        for (const file of execution.result_files || []) {
          delete file.searchableText;
        }
      }
    }
    res.json(responsePayload);
  } catch (error) {
    console.error('Error getting executions with HTML reports:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Manually set reportType for an HTML report file
router.post('/executions/:executionId/report-type', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { executionId } = req.params;
    const { reportUrl, reportType } = req.body;
    const userId = (req as AuthenticatedRequest).user?.userId;

    if (!userId) return res.status(401).json({ message: 'Unauthorized' });
    if (!reportUrl || !reportType) return res.status(400).json({ message: 'reportUrl and reportType are required' });
    if (!['creative', 'research', 'performance'].includes(reportType)) {
      return res.status(400).json({ message: 'reportType must be creative, research, or performance' });
    }

    const isAgentModeHtml = executionId.endsWith('-html');
    const agentSessionId = isAgentModeHtml ? executionId.replace('-html', '') : null;

    if (agentSessionId) {
      const chatbotDb = new ChatbotDB();
      const session = await chatbotDb.getChatSession(agentSessionId);
      if (!session) return res.status(404).json({ message: 'Session not found' });
      if (session.userId !== userId && !(req as AuthenticatedRequest).user?.isAdmin) {
        return res.status(403).json({ message: 'Not authorized' });
      }
      await chatbotDb.persistReportTypes(agentSessionId, [{ url: reportUrl, reportType }], true);
      return res.json({ success: true });
    }

    const execution = await taskDb.getTaskExecutionById(executionId);
    if (!execution) return res.status(404).json({ message: 'Execution not found' });
    if (execution.userId !== userId && !(req as AuthenticatedRequest).user?.isAdmin) {
      return res.status(403).json({ message: 'Not authorized' });
    }

    const updatedFiles = (execution.result_files || []).map((file: ResultFile) => {
      if (file.url === reportUrl) return { ...file, reportType };
      return file;
    });

    await taskDb.updateTaskExecutionResultFiles(executionId, updatedFiles);
    return res.json({ success: true });
  } catch (error) {
    console.error('Error updating report type:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

// Toggle favorite status for an image in a task execution or agent mode session
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

    // Check if this is an agent mode asset (executionId pattern: ${sessionId}-images, -videos, or -html)
    const isAgentModeImage = executionId.endsWith('-images');
    const isAgentModeVideo = executionId.endsWith('-videos');
    const isAgentModeHtml = executionId.endsWith('-html');
    const isAgentModeAsset = isAgentModeImage || isAgentModeVideo || isAgentModeHtml;
    const agentSessionId = isAgentModeAsset 
      ? (isAgentModeImage
        ? executionId.replace('-images', '')
        : isAgentModeVideo
          ? executionId.replace('-videos', '')
          : executionId.replace('-html', ''))
      : null;

    if (agentSessionId) {
      // Handle agent mode image or video - update session favorites field
      const chatbotDb = new ChatbotDB();
      const session = await chatbotDb.getChatSession(agentSessionId);
      
      if (!session) {
        return res.status(404).json({ message: 'Session not found' });
      }

      // Verify the user owns this session
      if (session.userId !== userId && !(req as AuthenticatedRequest).user?.isAdmin) {
        return res.status(403).json({ message: 'Not authorized to modify this session' });
      }

      // Update favorites field (Record<string, boolean> where key is imageUrl)
      const currentFavorites: Record<string, boolean> = session.favorites || {};
      const currentStatus = currentFavorites[imageUrl] || false;
      const newFavoriteStatus = !currentStatus;

      const updatedFavorites: Record<string, boolean> = {
        ...currentFavorites,
        [imageUrl]: newFavoriteStatus
      };

      // If unfavoriting, remove the key instead of setting to false
      if (!newFavoriteStatus) {
        delete updatedFavorites[imageUrl];
      }

      // Also update feedbacks: favoriting stores a "like" feedback, unfavoriting removes it
      const currentFeedbacks = session.feedbacks || {};
      const updatedFeedbacks = { ...currentFeedbacks };
      if (newFavoriteStatus) {
        updatedFeedbacks[imageUrl] = {
          type: 'like',
          timestamp: new Date().toISOString(),
          userId: userId!,
        };
      } else {
        delete updatedFeedbacks[imageUrl];
      }

      // Update the session with the modified favorites and feedbacks
      const params = {
        TableName: `${TABLE_PREFIX}AW-ChatSessions`,
        Key: { sessionId: agentSessionId },
        UpdateExpression: "SET favorites = :favorites, feedbacks = :feedbacks, updatedAt = :updatedAt",
        ExpressionAttributeValues: {
          ":favorites": updatedFavorites,
          ":feedbacks": updatedFeedbacks,
          ":updatedAt": new Date().toISOString()
        }
      };

      await dynamodb.update(params).promise();

      const likeFeedback = newFavoriteStatus ? updatedFeedbacks[imageUrl] : undefined;

      res.json({
        success: true,
        is_favorited: newFavoriteStatus,
        feedback: likeFeedback,
      });
      return;
    }

    // Handle regular task execution
    // Get the execution to verify ownership and get current result_files
    const execution = await taskDb.getTaskExecutionById(executionId);
    if (!execution) {
      return res.status(404).json({ message: 'Execution not found' });
    }

    // Verify the user owns this execution
    if (execution.userId !== userId && !(req as AuthenticatedRequest).user?.isAdmin) {
      return res.status(403).json({ message: 'Not authorized to modify this execution' });
    }

    // Find the image in result_files and toggle its favorite status + update feedback
    const updatedResultFiles = execution.result_files?.map((file: ResultFile) => {
      if (file.url === imageUrl) {
        const newFavorited = !file.is_favorited;
        return {
          ...file,
          is_favorited: newFavorited,
          feedback: newFavorited
            ? { type: 'like' as const, timestamp: new Date().toISOString(), userId: userId! }
            : undefined,
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
      is_favorited: updatedFile?.is_favorited || false,
      feedback: updatedFile?.feedback,
    });

  } catch (error) {
    console.error('Error toggling image favorite status:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Archive an image in a task execution or agent mode session
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

    // Check if this is an agent mode asset (executionId pattern: ${sessionId}-images, -videos, or -html)
    const isAgentModeImage = executionId.endsWith('-images');
    const isAgentModeVideo = executionId.endsWith('-videos');
    const isAgentModeHtml = executionId.endsWith('-html');
    const isAgentModeAsset = isAgentModeImage || isAgentModeVideo || isAgentModeHtml;
    const agentSessionId = isAgentModeAsset 
      ? (isAgentModeImage
        ? executionId.replace('-images', '')
        : isAgentModeVideo
          ? executionId.replace('-videos', '')
          : executionId.replace('-html', ''))
      : null;

    if (agentSessionId) {
      // Handle agent mode image or video - update session archives field
      const chatbotDb = new ChatbotDB();
      const session = await chatbotDb.getChatSession(agentSessionId);
      
      if (!session) {
        return res.status(404).json({ message: 'Session not found' });
      }

      // Verify the user owns this session
      if (session.userId !== userId && !(req as AuthenticatedRequest).user?.isAdmin) {
        return res.status(403).json({ message: 'Not authorized to modify this session' });
      }

      // Update archives field (Record<string, boolean> where key is imageUrl)
      const currentArchives = session.archives || {};
      const updatedArchives = {
        ...currentArchives,
        [imageUrl]: true
      };

      // Update the session with the modified archives
      const params = {
        TableName: `${TABLE_PREFIX}AW-ChatSessions`,
        Key: { sessionId: agentSessionId },
        UpdateExpression: "SET archives = :archives, updatedAt = :updatedAt",
        ExpressionAttributeValues: {
          ":archives": updatedArchives,
          ":updatedAt": new Date().toISOString()
        }
      };

      await dynamodb.update(params).promise();

      res.json({ 
        success: true, 
        message: 'Image archived successfully' 
      });
      return;
    }

    // Handle regular task execution
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

// Submit feedback (like/dislike with reasons) for a specific image
router.post('/executions/:executionId/image-feedback', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { executionId } = req.params;
    const { imageUrl, type, reasons, comment } = req.body;
    const userId = (req as AuthenticatedRequest).user?.userId;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    if (!executionId || !imageUrl) {
      return res.status(400).json({ message: 'Execution ID and image URL are required' });
    }

    if (!type || (type !== 'like' && type !== 'dislike')) {
      return res.status(400).json({ message: 'Invalid feedback type. Must be "like" or "dislike"' });
    }

    if (comment && comment.length > 500) {
      return res.status(400).json({ message: 'Comment too long. Maximum 500 characters' });
    }

    const feedback = {
      type: type as 'like' | 'dislike',
      reasons: type === 'dislike' && reasons?.length ? reasons : undefined,
      comment: comment || undefined,
      timestamp: new Date().toISOString(),
      userId,
    };

    // Check if this is an agent mode asset
    const isAgentModeImage = executionId.endsWith('-images');
    const isAgentModeVideo = executionId.endsWith('-videos');
    const isAgentModeHtml = executionId.endsWith('-html');
    const isAgentModeAsset = isAgentModeImage || isAgentModeVideo || isAgentModeHtml;
    const agentSessionId = isAgentModeAsset
      ? (isAgentModeImage
        ? executionId.replace('-images', '')
        : isAgentModeVideo
          ? executionId.replace('-videos', '')
          : executionId.replace('-html', ''))
      : null;

    if (agentSessionId) {
      const chatbotDb = new ChatbotDB();
      const session = await chatbotDb.getChatSession(agentSessionId);

      if (!session) {
        return res.status(404).json({ message: 'Session not found' });
      }

      if (session.userId !== userId && !(req as AuthenticatedRequest).user?.isAdmin) {
        return res.status(403).json({ message: 'Not authorized to modify this session' });
      }

      // Store feedback in session.feedbacks
      const currentFeedbacks = session.feedbacks || {};
      const updatedFeedbacks = {
        ...currentFeedbacks,
        [imageUrl]: feedback,
      };

      const params = {
        TableName: `${TABLE_PREFIX}AW-ChatSessions`,
        Key: { sessionId: agentSessionId },
        UpdateExpression: "SET feedbacks = :feedbacks, updatedAt = :updatedAt",
        ExpressionAttributeValues: {
          ":feedbacks": updatedFeedbacks,
          ":updatedAt": new Date().toISOString()
        }
      };
      await dynamodb.update(params).promise();

      // If dislike, inject a system message into the session for Emma to learn
      if (type === 'dislike') {
        const filename = imageUrl.split('/').pop() || 'image';
        const reasonsText = reasons?.length ? reasons.join(', ') : 'No specific reasons';
        const commentText = comment ? ` Comment: "${comment}".` : '';
        const systemContent = `[Image Feedback] The user disliked the image "${filename}". Reasons: ${reasonsText}.${commentText} Please take this feedback into account for future image generations.`;

        try {
          await chatbotDb.addMessageToSession(agentSessionId, {
            role: 'system',
            content: systemContent,
            metadata: {
              timestamp: new Date().toISOString(),
              isContextMessage: true,
            },
          });
        } catch (msgError: any) {
          // Don't fail the whole request if system message fails (e.g. session at message limit)
          console.warn('Failed to inject image feedback system message:', msgError.message);
        }
      }

      res.json({ success: true, feedback });
      return;
    }

    // Handle regular task execution
    const execution = await taskDb.getTaskExecutionById(executionId);
    if (!execution) {
      return res.status(404).json({ message: 'Execution not found' });
    }

    if (execution.userId !== userId && !(req as AuthenticatedRequest).user?.isAdmin) {
      return res.status(403).json({ message: 'Not authorized to modify this execution' });
    }

    const updatedResultFiles = execution.result_files?.map((file: ResultFile) => {
      if (file.url === imageUrl) {
        return { ...file, feedback };
      }
      return file;
    }) || [];

    await taskDb.updateTaskExecution(executionId, {
      result_files: updatedResultFiles,
    });

    res.json({ success: true, feedback });

  } catch (error) {
    console.error('Error submitting image feedback:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

export default router;
export { scanMessagesForAssets };
