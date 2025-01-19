import { Request, Response } from 'express';

// In-memory task storage for MVP (replace with database in production)
const tasks: { [key: string]: any[] } = {};

interface AuthRequest extends Request {
  user?: { userId: string; email: string };
}

export const createTask = (req: AuthRequest, res: Response) => {
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
      id: Date.now().toString(),
      name,
      prompt,
      status: 'pending',
      createdAt: new Date().toISOString(),
      userId
    };

    if (!tasks[userId]) {
      tasks[userId] = [];
    }
    tasks[userId].push(task);

    res.status(201).json(task);
  } catch (error) {
    res.status(500).json({ message: 'Error creating task' });
  }
};

export const getTasks = (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const userTasks = tasks[userId] || [];
    res.json(userTasks);
  } catch (error) {
    res.status(500).json({ message: 'Error fetching tasks' });
  }
};

export const getTask = (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const taskId = req.params.id;
    const userTasks = tasks[userId] || [];
    const task = userTasks.find(t => t.id === taskId);

    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    res.json(task);
  } catch (error) {
    res.status(500).json({ message: 'Error fetching task' });
  }
};

export const updateTask = (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const taskId = req.params.id;
    const userTasks = tasks[userId] || [];
    const taskIndex = userTasks.findIndex(t => t.id === taskId);

    if (taskIndex === -1) {
      return res.status(404).json({ message: 'Task not found' });
    }

    const updatedTask = {
      ...userTasks[taskIndex],
      ...req.body,
      id: taskId,
      userId
    };

    userTasks[taskIndex] = updatedTask;
    tasks[userId] = userTasks;

    res.json(updatedTask);
  } catch (error) {
    res.status(500).json({ message: 'Error updating task' });
  }
};

export const deleteTask = (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const taskId = req.params.id;
    const userTasks = tasks[userId] || [];
    const taskIndex = userTasks.findIndex(t => t.id === taskId);

    if (taskIndex === -1) {
      return res.status(404).json({ message: 'Task not found' });
    }

    tasks[userId] = userTasks.filter(t => t.id !== taskId);
    res.status(204).send();
  } catch (error) {
    res.status(500).json({ message: 'Error deleting task' });
  }
}; 