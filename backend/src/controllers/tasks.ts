import { Request, Response } from 'express';
import { taskDb } from '../services/db';
import { userDb } from '../services/db';
import { scheduleDb } from '../services/db';
import AWS from 'aws-sdk';
import { taskTemplateDb } from '../services/db';
import crypto from 'crypto';

interface AuthRequest extends Request {
  user?: { userId: string; email: string };
}

interface UserInteraction {
  id: string;
  question: string;
  response?: string;
  status: 'pending' | 'answered';
  timestamp: number;
}

export const createTask = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { 
      name, 
      prompt, 
      isInteractive, 
      isDeepResearch, 
      emailNotification, 
      templateId, 
      parameterValues, 
      isComplexTask, 
      extractPageContent, 
      category,
      description,
      outputAsJson,
      outputAsHtml,
      selectedLLMs,
      useSharedBrowser
    } = req.body;
    
    // If templateId is provided, fetch the template and use its values
    if (templateId) {
      try {
        const template = await taskTemplateDb.getTemplateById(templateId);
        
        // Check if template exists
        if (!template) {
          return res.status(404).json({ message: 'Template not found' });
        }
        
        // Check if user has access to the template (either owns it or it's published)
        if (template.userId !== userId && !template.published) {
          return res.status(403).json({ message: 'Access denied to this template' });
        }
        
        // Frontend already processes name and prompt with parameters.
        // Values from req.body (name, prompt, isInteractive, etc.) are used directly or as overrides.

        // For deep research tasks, email notification is automatically enabled or taken from request.
        const finalEmailNotification = emailNotification !== undefined 
          ? emailNotification 
          : isDeepResearch !== undefined 
            ? isDeepResearch 
            : template.isDeepResearch;
        
        // Create task using template values, allowing overrides from request body for most fields.
        // name and prompt from req.body are already fully processed by the frontend.
        const task = {
          taskId: Date.now().toString(),
          userId,
          name: name, // Use name from req.body (already processed by frontend)
          prompt: prompt, // Use prompt from req.body (already processed by frontend)
          status: 'active',
          emailNotification: finalEmailNotification,
          isInteractive: isInteractive !== undefined ? Boolean(isInteractive) : template.isInteractive,
          isDeepResearch: isDeepResearch !== undefined ? Boolean(isDeepResearch) : template.isDeepResearch,
          isComplexTask: isComplexTask !== undefined ? Boolean(isComplexTask) : template.isComplexTask,
          extractPageContent: extractPageContent !== undefined ? Boolean(extractPageContent) : template.extractPageContent, // Uses template.extractPageContent if extractPageContent is undefined in req.body
          outputAsJson: outputAsJson !== undefined ? Boolean(outputAsJson) : template.outputAsJson,
          outputAsHtml: outputAsHtml !== undefined ? Boolean(outputAsHtml) : template.outputAsHtml,
          useSharedBrowser: useSharedBrowser !== undefined ? Boolean(useSharedBrowser) : template.useSharedBrowser,
          createdAt: new Date().toISOString(),
          llmName: req.body.llmName || null,
          category: category || template.category,
          description: description || template.description,
          templateId: templateId,
          selectedLLMs: selectedLLMs || template.selectedLLMs || null
        };

        const createdTask = await taskDb.createTask(task);
        return res.status(201).json(createdTask);
      } catch (error) {
        console.error('Error fetching template:', error);
        return res.status(500).json({ message: 'Error fetching template' });
      }
    }
    
    // Regular task creation without template
    if (!name || !prompt) {
      return res.status(400).json({ message: 'Name and prompt are required' });
    }

    const task = {
      taskId: Date.now().toString(),
      userId,
      name,
      prompt,
      status: 'active',
      emailNotification: emailNotification ?? isDeepResearch,  // Use provided value or default to isDeepResearch
      isInteractive: Boolean(isInteractive),  // Convert to boolean
      isDeepResearch: Boolean(isDeepResearch),  // Convert to boolean
      isComplexTask: Boolean(isComplexTask),  // Convert to boolean
      extractPageContent: extractPageContent ?? isDeepResearch,  // Convert to boolean
      outputAsJson: Boolean(outputAsJson),
      outputAsHtml: Boolean(outputAsHtml),
      useSharedBrowser: Boolean(useSharedBrowser),
      createdAt: new Date().toISOString(),
      llmName: req.body.llmName || null,
      category: category,
      description: description,
      selectedLLMs: selectedLLMs || null
    };

    const createdTask = await taskDb.createTask(task);
    res.status(201).json(createdTask);
  } catch (error) {
    console.error('Error in createTask:', error);
    res.status(500).json({ message: 'Error creating task' });
  }
};

export const getTasks = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const tasks = await taskDb.getTasksByUserId(userId);
    res.json(tasks);
  } catch (error) {
    console.error('Error in getTasks:', error);
    res.status(500).json({ message: 'Error fetching tasks' });
  }
};

export const getTask = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const taskId = req.params.id;
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

    res.json(task);
  } catch (error) {
    console.error('Error in getTask:', error);
    res.status(500).json({ message: 'Error fetching task' });
  }
};

export const updateTask = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const taskId = req.params.id;
    console.log('Updating task:', taskId);
    console.log('Request body:', req.body);

    const task = await taskDb.getTaskById(taskId);
    console.log('Current task:', task);

    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    // Get user to check if admin
    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(401).json({ message: 'User not found' });
    }

    // Verify task belongs to user or user is admin
    if (!user.isAdmin && task.userId !== userId) {
      return res.status(403).json({ message: 'Access denied' });
    }

    // Build updates object based on what's provided
    const updates: any = {};
    
    if (req.body.emailNotification !== undefined) {
      updates.emailNotification = Boolean(req.body.emailNotification);
    }
    
    if (req.body.prompt !== undefined) {
      updates.prompt = req.body.prompt;
    }

    if (req.body.name !== undefined) {
      updates.name = req.body.name;
    }

    if (req.body.isInteractive !== undefined) {
      updates.isInteractive = Boolean(req.body.isInteractive);
    }

    if (req.body.isDeepResearch !== undefined) {
      updates.isDeepResearch = Boolean(req.body.isDeepResearch);
    }

    if (req.body.isComplexTask !== undefined) {
      updates.isComplexTask = Boolean(req.body.isComplexTask);
    }

    if (req.body.extractPageContent !== undefined) {
      updates.extractPageContent = Boolean(req.body.extractPageContent);
    }

    if (req.body.useSharedBrowser !== undefined) {
      updates.useSharedBrowser = Boolean(req.body.useSharedBrowser);
    }

    // Handle outputAsJson and outputAsHtml mutual exclusivity
    if (req.body.outputAsJson !== undefined) {
      updates.outputAsJson = Boolean(req.body.outputAsJson);
      if (updates.outputAsJson) {
        updates.outputAsHtml = false; // If JSON is true, HTML must be false
      }
    }
    if (req.body.outputAsHtml !== undefined) {
      updates.outputAsHtml = Boolean(req.body.outputAsHtml);
      if (updates.outputAsHtml) {
        updates.outputAsJson = false; // If HTML is true, JSON must be false
      }
    }

    if (req.body.llmName !== undefined) {
      updates.llmName = req.body.llmName || null;  // Convert empty string to null
    }
    if (req.body.validateOutput !== undefined) {
      updates.validateOutput = Boolean(req.body.validateOutput);
    }

    if (req.body.status !== undefined) {
      updates.status = req.body.status;
    }

    if (req.body.isAgenticDevMode !== undefined) {
      updates.isAgenticDevMode = Boolean(req.body.isAgenticDevMode);
    }
    
    // Check if we're unarchiving a task (changing status from 'archived' to 'active')
    const isUnarchiving = task.status === 'archived' && updates.status === 'active';

    await taskDb.updateTask(taskId, updates);
    
    // If unarchiving, reactivate schedules that were disabled when the task was archived
    if (isUnarchiving) {
      console.log('Unarchiving task, reactivating schedules...');
      const schedules = await taskDb.getTaskSchedules(taskId);
      console.log('Found schedules:', schedules);
      
      if (schedules && schedules.length > 0) {
        for (const schedule of schedules) {
          console.log('Reactivating schedule:', schedule.scheduleId);
          try {
            await scheduleDb.updateSchedule(schedule.scheduleId, { status: 'active' });
            console.log('Schedule reactivated successfully');
          } catch (scheduleError) {
            console.error('Error reactivating schedule:', scheduleError);
          }
        }
      } else {
        console.log('No schedules found for this task');
      }
    }
    
    // Get and return the updated task
    const updatedTask = await taskDb.getTaskById(taskId);

    res.json(updatedTask);
  } catch (error) {
    console.error('Error in updateTask:', error);
    res.status(500).json({ message: 'Error updating task' });
  }
};

export const deleteTask = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const taskId = req.params.id;
    const task = await taskDb.getTaskById(taskId);

    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    // Verify task belongs to user
    if (task.userId !== userId) {
      return res.status(403).json({ message: 'Access denied' });
    }

    // Update task status to archived instead of deleting
    await taskDb.updateTask(taskId, { status: 'archived' });
    console.log('Task archived:', taskId);
    
    // Disable all schedules for this task
    const schedules = await taskDb.getTaskSchedules(taskId);
    console.log('Found schedules to disable:', schedules);
    
    if (schedules && schedules.length > 0) {
      for (const schedule of schedules) {
        console.log('Disabling schedule:', schedule.scheduleId);
        try {
          await scheduleDb.updateSchedule(schedule.scheduleId, { status: 'inactive' });
          console.log('Schedule disabled successfully');
        } catch (scheduleError) {
          console.error('Error disabling schedule:', scheduleError);
        }
      }
    } else {
      console.log('No schedules found for this task');
    }

    res.status(200).json({ message: 'Task archived successfully' });
  } catch (error) {
    console.error('Error in archiveTask:', error);
    res.status(500).json({ message: 'Error archiving task' });
  }
};

export const executeTask = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const taskId = req.params.id;
    const task = await taskDb.getTaskById(taskId);

    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    // Get user to check if admin
    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(401).json({ message: 'User not found' });
    }

    // Verify task belongs to user or user is admin
    if (!user.isAdmin && task.userId !== userId) {
      return res.status(403).json({ message: 'Access denied' });
    }

    // Create a new task execution record
    const execution = {
      executionId: Date.now().toString(),
      taskId,
      userId: task.userId, // Use the task owner's ID for execution
      run_user_id: userId !== task.userId ? userId : undefined, // Record who actually ran the task if different from owner
      status: 'pending',
      startTime: new Date().toISOString()
    };

    await taskDb.createTaskExecution(execution);
    res.status(201).json(execution);
  } catch (error) {
    console.error('Error in executeTask:', error);
    res.status(500).json({ message: 'Error executing task' });
  }
};

export const getTaskExecutions = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const taskId = req.params.id;
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

    const executions = await taskDb.getTaskExecutions(taskId);
    res.json(executions);
  } catch (error) {
    console.error('Error in getTaskExecutions:', error);
    res.status(500).json({ message: 'Error fetching task executions' });
  }
};

export const updateTaskExecution = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const taskId = req.params.id;
    const executionId = req.params.executionId;
    const { feedback } = req.body;

    // Verify task exists
    const task = await taskDb.getTaskById(taskId);
    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }
    
    // Get user to check if admin
    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(401).json({ message: 'User not found' });
    }
    
    // Check if user is the task owner or an admin
    if (task.userId !== userId && !user.isAdmin) {
      return res.status(403).json({ message: 'Access denied' });
    }

    // Update execution feedback
    const updatedExecution = await taskDb.updateTaskExecution(executionId, { feedback });
    res.json(updatedExecution);
  } catch (error) {
    console.error('Error in updateTaskExecution:', error);
    res.status(500).json({ message: 'Error updating task execution' });
  }
};

export const respondToInteraction = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const taskId = req.params.id;
    const executionId = req.params.executionId;
    const interactionId = req.params.interactionId;
    const { response } = req.body;

    if (!response) {
      return res.status(400).json({ message: 'Response is required' });
    }

    // Verify task exists
    const task = await taskDb.getTaskById(taskId);
    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }
    
    // Get user to check if admin
    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(401).json({ message: 'User not found' });
    }
    
    // Check if user is the task owner or an admin
    if (task.userId !== userId && !user.isAdmin) {
      return res.status(403).json({ message: 'Access denied' });
    }

    // Get the execution
    const execution = await taskDb.getTaskExecutionById(executionId);
    if (!execution) {
      return res.status(404).json({ message: 'Execution not found' });
    }

    // Find and update the interaction
    const interactions: UserInteraction[] = execution.userInteractions || [];
    const interactionIndex = interactions.findIndex(i => i.id === interactionId);
    
    if (interactionIndex === -1) {
      return res.status(404).json({ message: 'Interaction not found' });
    }

    if (interactions[interactionIndex].status !== 'pending') {
      return res.status(400).json({ message: 'This interaction has already been answered' });
    }

    // Update the interaction
    interactions[interactionIndex] = {
      ...interactions[interactionIndex],
      response,
      status: 'answered'
    };

    // Update the execution with the modified interactions
    const updatedExecution = await taskDb.updateTaskExecution(executionId, {
      userInteractions: interactions
    });

    res.json(updatedExecution);
  } catch (error) {
    console.error('Error in respondToInteraction:', error);
    res.status(500).json({ message: 'Error responding to interaction' });
  }
};

export const getTaskExecution = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const taskId = req.params.id;
    const executionId = req.params.executionId;
    
    // Get the task to check permissions
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

    // Get the execution
    const execution = await taskDb.getTaskExecutionById(executionId);
    if (!execution) {
      return res.status(404).json({ message: 'Execution not found' });
    }

    // Verify the execution belongs to the task
    if (execution.taskId !== taskId) {
      return res.status(404).json({ message: 'Execution not found for this task' });
    }

    res.json(execution);
  } catch (error) {
    console.error('Error in getTaskExecution:', error);
    res.status(500).json({ message: 'Error fetching task execution' });
  }
};

export const getExecutionLog = async (req: Request, res: Response) => {
  try {
    const taskId = req.params.id;
    const executionId = req.params.executionId;
    const logToken = req.query.token as string;
    
    if (!logToken) {
      return res.status(400).json({ message: 'Log token is required' });
    }
    
    // Get the execution
    const execution = await taskDb.getTaskExecutionById(executionId);
    if (!execution) {
      return res.status(404).json({ message: 'Execution not found' });
    }

    // Verify the execution belongs to the task
    if (execution.taskId !== taskId) {
      return res.status(404).json({ message: 'Execution not found for this task' });
    }

    if (!execution.browser_use_log) {
      return res.status(404).json({ message: 'Log file not found' });
    }

    // Extract the token from the S3 URL to verify
    const urlRegex = new RegExp(`activities_${executionId}_([a-z0-9]{20})\\.log`);
    const match = urlRegex.exec(execution.browser_use_log);
    
    if (!match || match[1] !== logToken) {
      return res.status(403).json({ message: 'Invalid log token' });
    }

    // Fetch the content directly from the URL
    const fetch = require('node-fetch');
    const response = await fetch(execution.browser_use_log);
    
    if (!response.ok) {
      throw new Error(`Failed to fetch log from URL: ${response.status} ${response.statusText}`);
    }
    
    const logContent = await response.text();
    
    // Set CORS headers for public access
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    // Set caching headers
    res.setHeader('Cache-Control', 'no-cache');
    
    // Send as HTML
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(logContent);
  } catch (error) {
    console.error('Error fetching execution log:', error);
    res.status(500).json({ message: 'Error fetching execution log' });
  }
};

export const generateShareToken = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const taskId = req.params.id;
    const executionId = req.params.executionId;
    
    // Get the task to check permissions
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

    // Get the execution
    const execution = await taskDb.getTaskExecutionById(executionId);
    if (!execution) {
      return res.status(404).json({ message: 'Execution not found' });
    }

    // Verify the execution belongs to the task
    if (execution.taskId !== taskId) {
      return res.status(404).json({ message: 'Execution not found for this task' });
    }

    // If a share token already exists, use it; otherwise, generate a new one
    let shareToken = execution.shareToken;
    
    if (!shareToken) {
      // Generate a random token (16 characters)
      shareToken = crypto.randomBytes(8).toString('hex');
      
      // Save the token to the execution record
      await taskDb.updateTaskExecution(executionId, { shareToken });
    }
    
    res.json({ shareToken });
  } catch (error) {
    console.error('Error generating share token:', error);
    res.status(500).json({ message: 'Error generating share token' });
  }
};

export const getExecutionWithToken = async (req: Request, res: Response) => {
  try {
    const { executionId, token } = req.params;
    
    if (!executionId || !token) {
      return res.status(400).json({ message: 'Execution ID and token are required' });
    }
    
    // Get the execution
    const execution = await taskDb.getTaskExecutionById(executionId);
    if (!execution) {
      return res.status(404).json({ message: 'Execution not found' });
    }
    
    // Verify the token matches
    if (execution.shareToken !== token) {
      return res.status(403).json({ message: 'Invalid token' });
    }
    
    // Get the task for additional context
    const task = await taskDb.getTaskById(execution.taskId);
    
    // Return the execution with minimal task info
    res.json({
      execution,
      task: task ? {
        taskId: task.taskId,
        name: task.name,
        prompt: task.prompt
      } : null
    });
  } catch (error) {
    console.error('Error fetching execution with token:', error);
    res.status(500).json({ message: 'Error fetching execution' });
  }
};

export const sendExecutionEmail = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const taskId = req.params.id;
    const executionId = req.params.executionId;
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({ message: 'Email address is required' });
    }
    
    // Get the task to check permissions
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

    // Get the execution
    const execution = await taskDb.getTaskExecutionById(executionId);
    if (!execution) {
      return res.status(404).json({ message: 'Execution not found' });
    }

    // Verify the execution belongs to the task
    if (execution.taskId !== taskId) {
      return res.status(404).json({ message: 'Execution not found for this task' });
    }

    // Prepare email content
    const siteDomain = process.env.FRONTEND_URL || 'http://localhost:5173';
    const taskUrl = `${siteDomain}/tasks/${taskId}`;
    const executionUrl = `${siteDomain}/tasks/${taskId}/executions/${executionId}`;

    // Create execution start/end time strings
    const startTime = execution.startTime ? new Date(execution.startTime).toLocaleString() : 'Not available';
    const completedTime = execution.completedAt ? new Date(execution.completedAt).toLocaleString() : 'Not available';
    
    // Create HTML content for the email
    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <style>
            body {
              font-family: Arial, sans-serif;
              line-height: 1.6;
              color: #333;
              max-width: 800px;
              margin: 0 auto;
              padding: 20px;
            }
            .header {
              background-color: #1976d2;
              color: white;
              padding: 20px;
              text-align: center;
              border-radius: 4px 4px 0 0;
            }
            .content {
              padding: 20px;
              background: #fff;
              border: 1px solid #ddd;
              border-radius: 0 0 4px 4px;
            }
            .section {
              margin-bottom: 20px;
              padding-bottom: 20px;
              border-bottom: 1px solid #eee;
            }
            .section:last-child {
              border-bottom: none;
            }
            .section h3 {
              margin-top: 0;
              color: #1976d2;
            }
            .details-table {
              width: 100%;
              border-collapse: collapse;
              margin-bottom: 20px;
            }
            .details-table th, .details-table td {
              padding: 8px;
              text-align: left;
              border-bottom: 1px solid #ddd;
            }
            .details-table th {
              background-color: #f5f5f5;
            }
            .status {
              padding: 4px 8px;
              border-radius: 4px;
              font-weight: bold;
              display: inline-block;
            }
            .status-completed {
              background-color: #e8f5e9;
              color: #2e7d32;
            }
            .status-failed {
              background-color: #ffebee;
              color: #c62828;
            }
            .status-running {
              background-color: #e3f2fd;
              color: #1565c0;
            }
            .status-pending {
              background-color: #fff8e1;
              color: #f57f17;
            }
            .pre-content {
              background-color: #f5f5f5;
              padding: 15px;
              border-radius: 4px;
              overflow-x: auto;
              white-space: pre-wrap;
              word-break: break-word;
            }
            .footer {
              text-align: center;
              margin-top: 20px;
              color: #666;
              font-size: 0.9em;
            }
            .button {
              display: inline-block;
              padding: 10px 20px;
              background-color: #1976d2;
              color: white;
              text-decoration: none;
              border-radius: 4px;
              font-weight: bold;
            }
          </style>
        </head>
        <body>
          <div class="header">
            <h2 style="margin:0;padding:0;font-size:24px;">Task Execution Details: ${task.name}</h2>
          </div>
          <div class="content">
            <div class="section">
              <h3>Task Information</h3>
              <table class="details-table">
                <tr>
                  <th>Task Name</th>
                  <td>${task.name}</td>
                </tr>
                <tr>
                  <th>Task ID</th>
                  <td>${taskId}</td>
                </tr>
                <tr>
                  <th>Execution ID</th>
                  <td>${executionId}</td>
                </tr>
                <tr>
                  <th>Status</th>
                  <td>
                    <span class="status status-${execution.status.toLowerCase()}">${execution.status}</span>
                  </td>
                </tr>
                <tr>
                  <th>Started</th>
                  <td>${startTime}</td>
                </tr>
                <tr>
                  <th>Completed</th>
                  <td>${completedTime}</td>
                </tr>
                ${execution.llmName ? `
                <tr>
                  <th>LLM Used</th>
                  <td>${execution.llmName}</td>
                </tr>` : ''}
              </table>
            </div>
            
            <div class="section">
              <h3>Prompt</h3>
              <div class="pre-content">${execution.prompt || 'No prompt available'}</div>
            </div>
            
            <div class="section">
              <h3>Result</h3>
              <div class="pre-content">
                ${execution.error 
                  ? `<span style="color:#c62828">${execution.error}</span>` 
                  : execution.result 
                    ? execution.result
                    : 'No result available'}
              </div>
            </div>
            
            ${execution.result_files && execution.result_files.length > 0 ? `
            <div class="section">
              <h3>Result Files</h3>
              <ul>
                ${execution.result_files.map((file: { url: string; filename: string }) => `
                  <li><a href="${file.url}">${file.filename}</a></li>
                `).join('')}
              </ul>
            </div>` : ''}
            
            <div class="section" style="text-align: center;">
              <a href="${executionUrl}" class="button">View Full Details</a>
            </div>
          </div>
          <div class="footer">
            <p>This email was sent from AgentWeb. Please do not reply to this email.</p>
            <p>View <a href="${taskUrl}">task details</a> or go to <a href="${siteDomain}">AgentWeb</a>.</p>
          </div>
        </body>
      </html>
    `;

    // Import emailService
    const { emailService } = require('../services/emailService');
    
    // Send the email
    await emailService.sendEmail(
      email,
      `AgentWeb - Task Execution Details: ${task.name}`,
      `Task: ${task.name}\nStatus: ${execution.status}\nView details: ${executionUrl}`,
      html
    );
    
    res.json({ message: `Execution details sent to ${email}` });
  } catch (error) {
    console.error('Error sending execution email:', error);
    res.status(500).json({ message: 'Error sending execution email' });
  }
}; 