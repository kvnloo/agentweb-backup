import { Request, Response } from 'express';
import { taskDb } from '../services/db';
import { userDb } from '../services/db';
import { scheduleDb } from '../services/db';
import AWS from 'aws-sdk';

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

    const { name, prompt, isInteractive, isDeepResearch, emailNotification } = req.body;
    
    if (!name || !prompt) {
      return res.status(400).json({ message: 'Name and prompt are required' });
    }

    const task = {
      taskId: Date.now().toString(),
      userId,
      name,
      prompt,
      status: 'active',
      emailNotification: emailNotification ?? false,  // Use provided value or default to false
      isInteractive: Boolean(isInteractive),  // Convert to boolean
      isDeepResearch: Boolean(isDeepResearch),  // Convert to boolean
      createdAt: new Date().toISOString()
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

    if (req.body.llmName !== undefined) {
      updates.llmName = req.body.llmName || null;  // Convert empty string to null
    }
    
    if (req.body.status !== undefined) {
      updates.status = req.body.status;
    }

    console.log('Updates to apply:', updates);
    
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
    console.log('Updated task:', updatedTask);

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

    // Verify task exists and belongs to user
    const task = await taskDb.getTaskById(taskId);
    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }
    if (task.userId !== userId) {
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

    // Verify task exists and belongs to user
    const task = await taskDb.getTaskById(taskId);
    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }
    if (task.userId !== userId) {
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

export const getExecutionLog = async (req: AuthRequest, res: Response) => {
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

    if (!execution.browser_use_log) {
      return res.status(404).json({ message: 'Log file not found' });
    }

    // Extract the S3 key from the URL
    const url = new URL(execution.browser_use_log);
    const s3Key = decodeURIComponent(url.pathname.substring(1)); // Remove leading slash

    // Get the file from S3
    const s3 = new AWS.S3();
    const s3Object = await s3.getObject({
      Bucket: process.env.AWS_S3_BUCKET_NAME || '',
      Key: s3Key
    }).promise();

    // Set content type and send the file content
    res.setHeader('Content-Type', 'text/plain');
    res.send(s3Object.Body);
  } catch (error) {
    console.error('Error fetching execution log:', error);
    res.status(500).json({ message: 'Error fetching execution log' });
  }
}; 