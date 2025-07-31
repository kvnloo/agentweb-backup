import { Request, Response } from 'express';
import { taskDb } from '../services/db';
import { userDb } from '../services/db';
import { scheduleDb } from '../services/db';
import AWS from 'aws-sdk';
import { taskTemplateDb } from '../services/db';
import crypto from 'crypto';
import { S3 } from 'aws-sdk';

const s3 = new S3();

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
      useSharedBrowser,
      turnOffHeadless,
      useKnowledgeBase,
      updateKnowledgeBase,
      updateLeadList,
      createVideo
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
          turnOffHeadless: turnOffHeadless !== undefined ? Boolean(turnOffHeadless) : template.turnOffHeadless,
          useKnowledgeBase: useKnowledgeBase !== undefined ? Boolean(useKnowledgeBase) : template.useKnowledgeBase,
          updateKnowledgeBase: req.body.updateKnowledgeBase !== undefined ? Boolean(req.body.updateKnowledgeBase) : template.updateKnowledgeBase,
          updateLeadList: req.body.updateLeadList !== undefined ? Boolean(req.body.updateLeadList) : template.updateLeadList,
          createVideo: req.body.createVideo !== undefined ? Boolean(req.body.createVideo) : template.createVideo,
          knowledgeBaseType: 'private', // Default to private for new tasks
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
      turnOffHeadless: Boolean(turnOffHeadless),
      useKnowledgeBase: Boolean(useKnowledgeBase),
      updateKnowledgeBase: Boolean(req.body.updateKnowledgeBase),
      updateLeadList: Boolean(req.body.updateLeadList),
      createVideo: Boolean(req.body.createVideo),
      knowledgeBaseType: 'private', // Default to private for new tasks
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

    if (req.body.turnOffHeadless !== undefined) {
      updates.turnOffHeadless = Boolean(req.body.turnOffHeadless);
    }

    if (req.body.useKnowledgeBase !== undefined) {
      updates.useKnowledgeBase = Boolean(req.body.useKnowledgeBase);
    }

    if (req.body.updateKnowledgeBase !== undefined) {
      updates.updateKnowledgeBase = Boolean(req.body.updateKnowledgeBase);
    }

    if (req.body.updateLeadList !== undefined) {
      updates.updateLeadList = Boolean(req.body.updateLeadList);
    }

    if (req.body.createVideo !== undefined) {
      updates.createVideo = Boolean(req.body.createVideo);
    }

    if (req.body.leadListIdentifier !== undefined) {
      updates.leadListIdentifier = req.body.leadListIdentifier;
    }

    if (req.body.knowledgeBaseType !== undefined) {
      updates.knowledgeBaseType = req.body.knowledgeBaseType;
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
    const { feedback } = req.body;
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
      startTime: new Date().toISOString(),
      feedback: feedback || undefined // Store feedback if provided
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
    
    // Skip task existence check for temporary task IDs
    if (!taskId.startsWith('task-')) {
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
    const customerFrontendUrl = process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174';
    const landingSiteUrl = process.env.LANDING_SITE_URL || 'https://agentweb.pro';
    const taskUrl = `${siteDomain}/tasks/${taskId}`;
    const executionUrl = `${customerFrontendUrl}/tasks/${taskId}/executions/${executionId}/result`;

    // Create execution start/end time strings
    const startTime = execution.startTime ? new Date(execution.startTime).toLocaleString() : 'Not available';
    const completedTime = execution.completedAt ? new Date(execution.completedAt).toLocaleString() : 'Not available';
    
    // Calculate execution duration if both start and end times are available
    let durationStr = '';
    if (execution.startTime && execution.completedAt) {
      const start = new Date(execution.startTime).getTime();
      const end = new Date(execution.completedAt).getTime();
      const durationMs = end - start;
      const durationMinutes = Math.floor(durationMs / 60000);
      const durationSeconds = Math.floor((durationMs % 60000) / 1000);
      
      if (durationMinutes > 0) {
        durationStr = `<p><strong>Duration:</strong> ${durationMinutes} minutes ${durationSeconds} seconds</p>`;
      } else {
        durationStr = `<p><strong>Duration:</strong> ${durationSeconds} seconds</p>`;
      }
    }
    
    // Fetch HTML content from result_files
    let htmlContentFromFile = '';
    if (execution.result_files && execution.result_files.length > 0) {
      for (const file of execution.result_files) {
        if ((file.is_html || file.view_type === 'html') && file.url) {
          try {
            // Import fetch
            const fetch = require('node-fetch');
            const response = await fetch(file.url);
            
            if (response.ok) {
              const fetchedHtmlContent = await response.text();
              htmlContentFromFile = `
                <div class="html-result">
                  <h3>HTML Result File:</h3>
                  ${fetchedHtmlContent}
                </div>
              `;
              console.log(`Successfully fetched HTML content from ${file.url}`);
              break; // Use the first HTML file found
            } else {
              console.error(`Failed to fetch HTML content from ${file.url}: ${response.statusText}`);
              htmlContentFromFile = `
                <div class="html-result">
                  <h3>HTML Result File:</h3>
                  <p><i>Error fetching HTML content: ${response.statusText}</i></p>
                </div>
              `;
            }
          } catch (error) {
            console.error(`Error fetching HTML content from ${file.url}:`, error);
            htmlContentFromFile = `
              <div class="html-result">
                <h3>HTML Result File:</h3>
                <p><i>Error fetching HTML content</i></p>
              </div>
            `;
          }
          break; // Process only the first HTML file found, even if error
        }
      }
    }
    
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
              margin: 0;
              padding: 0;
              background-color: #fff;
            }
            .container {
              padding: 20px;
              background-color: #fdfdfd;
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
              border-bottom: 2px solid #ecf0f1;
              padding-bottom: 8px;
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
              font-family: monospace;
              font-size: 0.9em;
            }
            .html-result {
              border: 1px solid #ddd;
              padding: 10px;
              margin-top: 15px;
              border-radius: 5px;
              overflow: auto;
            }
            .html-result h3 {
              margin-top: 0;
              font-size: 1.2em;
              border-bottom: 2px solid #ecf0f1;
              padding-bottom: 8px;
              color: #34495e;
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
          <div class="container">
            <div class="header">
              <h2 style="margin:0;padding:0;font-size:24px;">Task Run Results: ${task.name}</h2>
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
                      <span class="status status-${execution.status.toLowerCase()}">${execution.status.toUpperCase()}</span>
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
                  ${durationStr ? `
                  <tr>
                    <th>Duration</th>
                    <td>${durationStr.replace(/<\/?p>|<\/?strong>/g, '')}</td>
                  </tr>` : ''}
                </table>
              </div>
              
              ${execution.result ? `
              <div class="section">
                <h3>Results Summary</h3>
                <div class="pre-content">${execution.result}</div>
              </div>
              ` : ''}
              
              ${execution.error ? `
              <div class="section">
                <h3>Error Details</h3>
                <div class="pre-content" style="color:#c62828">${execution.error}</div>
              </div>
              ` : ''}
              
              ${htmlContentFromFile ? `
              <div class="section">
                ${htmlContentFromFile}
              </div>
              ` : ''}
              
              <div class="section" style="text-align: center;">
                <a href="${executionUrl}" class="button">View Full Details</a>
              </div>
            </div>
            <div class="footer">
              <p>This email was sent from AgentWeb. You can reply directly to this email if you have any questions.</p>
              <p>View <a href="${customerFrontendUrl}/tasks/${taskId}">task details</a> or go to <a href="${landingSiteUrl}">AgentWeb</a>.</p>
            </div>
          </div>
        </body>
      </html>
    `;

    // Import emailService
    const { emailService } = require('../services/emailService');
    
    // Send the email
    await emailService.sendEmail(
      email,
      `AgentWeb - Task Run Results: ${task.name}`,
      `Task: ${task.name}\nStatus: ${execution.status.toUpperCase()}\nView details: ${executionUrl}`,
      html
    );
    
    res.json({ message: `Execution details sent to ${email}` });
  } catch (error) {
    console.error('Error sending execution email:', error);
    res.status(500).json({ message: 'Error sending execution email' });
  }
}; 

export const uploadImageToExecution = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const taskId = req.params.id;
    const file = (req as any).file;

    if (!file) {
      return res.status(400).json({ message: 'No file uploaded' });
    }

    // Verify task exists and user has access
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

    // Get the latest execution for this task
    const executions = await taskDb.getTaskExecutions(taskId);
    if (!executions || executions.length === 0) {
      return res.status(404).json({ message: 'No executions found for this task' });
    }

    // Sort by startTime to get the latest execution
    const latestExecution = executions.sort((a, b) => 
      new Date(b.startTime).getTime() - new Date(a.startTime).getTime()
    )[0];

    // Upload file to S3
    const randomToken = Array.from(crypto.getRandomValues(new Uint8Array(16)))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    const key = `tasks/${taskId}/executions/${latestExecution.executionId}/uploads/${Date.now()}-${randomToken}-${file.originalname}`;

    await s3
      .putObject({
        Bucket: process.env.AWS_S3_BUCKET || "agentweb-user-files",
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype,
      })
      .promise();

    const url = `https://${
      process.env.AWS_S3_BUCKET || "agentweb-user-files"
    }.s3.${process.env.AWS_REGION || "us-west-2"}.amazonaws.com/${key}`;

    // Create new result file entry
    const newResultFile = {
      url,
      filename: file.originalname,
      token: randomToken,
      is_html: false
    };

    // Get current result_files and append the new file
    const currentResultFiles = latestExecution.result_files || [];
    const updatedResultFiles = [...currentResultFiles, newResultFile];

    // Update the execution with the new result file
    await taskDb.updateTaskExecution(latestExecution.executionId, {
      result_files: updatedResultFiles
    });

    res.status(200).json({
      message: 'Image uploaded successfully',
      resultFile: newResultFile
    });
  } catch (error) {
    console.error('Error in uploadImageToExecution:', error);
    res.status(500).json({ message: 'Error uploading image' });
  }
}; 