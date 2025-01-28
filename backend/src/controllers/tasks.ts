import { Request, Response } from 'express';
import { taskDb } from '../services/db';
import { userDb } from '../services/db';

interface AuthRequest extends Request {
  user?: { userId: string; email: string };
}

export const createTask = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { name, prompt } = req.body;
    
    if (!name || !prompt) {
      return res.status(400).json({ message: 'Name and prompt are required' });
    }

    const task = {
      taskId: Date.now().toString(),
      userId,
      name,
      prompt,
      status: 'active',
      emailNotification: false,  // Initialize to false
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
    console.log('emailNotification in request:', req.body.emailNotification, typeof req.body.emailNotification);

    const task = await taskDb.getTaskById(taskId);
    console.log('Current task:', task);

    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    // Verify task belongs to user
    if (task.userId !== userId) {
      return res.status(403).json({ message: 'Access denied' });
    }

    // Only send emailNotification field
    const updates = {
      emailNotification: Boolean(req.body.emailNotification)
    };
    console.log('Updates to apply:', updates);

    await taskDb.updateTask(taskId, updates);
    
    // Get and return the updated task
    const updatedTask = await taskDb.getTaskById(taskId);
    console.log('Updated task:', updatedTask);
    if (updatedTask) {
      console.log('emailNotification in updated task:', updatedTask.emailNotification, typeof updatedTask.emailNotification);
    }
    
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

    await taskDb.deleteTask(taskId);
    res.status(204).send();
  } catch (error) {
    console.error('Error in deleteTask:', error);
    res.status(500).json({ message: 'Error deleting task' });
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

    // Verify task belongs to user
    if (task.userId !== userId) {
      return res.status(403).json({ message: 'Access denied' });
    }

    // Create a new task execution record
    const execution = {
      executionId: Date.now().toString(),
      taskId,
      userId,
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