import express, { Request, RequestHandler, Response } from 'express';
import { createTask, getTasks, getTask, updateTask, deleteTask, executeTask, getTaskExecutions, updateTaskExecution, respondToInteraction, getTaskExecution, getExecutionLog, generateShareToken, getExecutionWithToken, sendExecutionEmail } from '../controllers/tasks';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { taskDb, subscriberDb } from '../services/db';
import multer from 'multer';
import { RequestHandler as ExpressRequestHandler } from 'express-serve-static-core';
import { isAdmin } from '../middleware/admin';
import { userDb } from '../services/db';
import { emailService } from '../services/emailService';
import { Storage } from '@google-cloud/storage';
import OpenAI from 'openai';
import axios from 'axios';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

// Initialize GCS with service account credentials
// For Elastic Beanstalk deployment:
// 1. Replace all newlines in the private key with [NEWLINE]
// 2. Example format:
//    -----BEGIN PRIVATE KEY-----[NEWLINE]MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC9QFi67K6Z...[NEWLINE]...[NEWLINE]-----END PRIVATE KEY-----[NEWLINE]
const privateKey = process.env.GCS_PRIVATE_KEY?.replace(/\[NEWLINE\]/g, '\n');

const storage = new Storage({
  projectId: process.env.GCS_PROJECT_ID,
  credentials: {
    client_email: process.env.GCS_CLIENT_EMAIL,
    private_key: privateKey
  }
});

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
const BUCKET_NAME = process.env.GCS_BUCKET || 'agentweb-knowledge-base-dev';

type FileRequest = AuthenticatedRequest & {
  file?: Express.Multer.File;
};

interface ResultFile {
  url: string;
  filename: string;
  token: string;
  is_html?: boolean;
}

// Public routes (no authentication required)
router.get('/execution/:executionId/token/:token', getExecutionWithToken);
router.get('/:id/executions/:executionId/log', getExecutionLog);

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

    const bucket = storage.bucket(BUCKET_NAME);
    const filePath = `tasks/${taskId}/knowledge-base.txt`;
    const file = bucket.file(filePath);

    // Check if file exists
    const [exists] = await file.exists();
    
    // If file doesn't exist and no knowledge base link exists, create a new one
    if (!exists && !task.knowledgeBase) {
      // Create empty file
      await file.save('', {
        contentType: 'text/plain',
        metadata: {
          taskId,
          userId,
          createdAt: new Date().toISOString()
        }
      });

      // Get the public URL
      const [url] = await file.getSignedUrl({
        action: 'read',
        expires: '03-01-2500' // Far future expiration
      });

      // Update task with the new knowledge base link
      await taskDb.updateTask(taskId, { knowledgeBase: url, knowledgeBaseSize: 0 });

      return res.json({ content: '', url });
    }

    // If file exists, get the content
    if (exists) {
      const [content] = await file.download();
      const contentStr = content.toString();
      res.json({ content: contentStr, url: task.knowledgeBase });
    } else {
      // If file doesn't exist but task has a knowledge base link, return 404
      res.status(404).json({ message: 'Knowledge base file not found' });
    }
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

    const bucket = storage.bucket(BUCKET_NAME);
    const filePath = `tasks/${taskId}/knowledge-base.txt`;
    const file = bucket.file(filePath);

    // Save content to file
    await file.save(contentToSave, {
      contentType: 'text/plain',
      metadata: {
        taskId,
        userId,
        updatedAt: new Date().toISOString()
      }
    });

    // Get the public URL if it's a new file
    if (!task.knowledgeBase) {
      const [url] = await file.getSignedUrl({
        action: 'read',
        expires: '03-01-2500' // Far future expiration
      });
      
      // Update task with the new knowledge base link
      await taskDb.updateTask(taskId, { knowledgeBase: url, knowledgeBaseSize: Buffer.byteLength(contentToSave, 'utf8') });
      
      res.json({ content: contentToSave, url });
    } else {
      res.json({ content: contentToSave, url: task.knowledgeBase });
    }
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

    // Get the current knowledge base content
    const bucket = storage.bucket(BUCKET_NAME);
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

    // Update the task with knowledge base size
    await taskDb.updateTask(taskId, {
      knowledgeBaseSize
    });

    // Update the execution record with knowledge base update info
    await taskDb.updateTaskExecution(executionId, {
      knowledge_base_updated_at: new Date().toISOString()
    });

    res.json({ 
      content: updatedContent,
      url: task.knowledgeBase,
      message: 'Knowledge base updated successfully',
      size: knowledgeBaseSize
    });
  } catch (error) {
    console.error('Error updating knowledge base from execution:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

export default router; 