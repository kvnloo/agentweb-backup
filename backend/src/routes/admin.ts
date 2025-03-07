import express from 'express';
import { authenticateToken } from '../middleware/auth';
import { isAdmin } from '../middleware/admin';
import { userDb, taskDb, subscriberDb } from '../services/db';
import { waitlistDb } from '../services/waitlistDb';
import { emailService } from '../services/emailService';

const router = express.Router();

// Apply authentication and admin middleware to all routes
router.use(authenticateToken);
router.use(isAdmin);

// Get all users
router.get('/users', async (req, res) => {
  try {
    const users = await userDb.getAllUsers();
    res.json(users);
  } catch (error) {
    console.error('Error getting users:', error);
    res.status(500).json({ message: 'Error fetching users' });
  }
});

// Get a single user by ID
router.get('/users/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const user = await userDb.getUserById(userId);
    
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    res.json(user);
  } catch (error) {
    console.error('Error getting user:', error);
    res.status(500).json({ message: 'Error fetching user' });
  }
});

// Deactivate user
router.post('/users/:userId/deactivate', async (req, res) => {
  try {
    const { userId } = req.params;

    // Check if user exists and is not already deactivated
    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    if (user.isAdmin) {
      return res.status(403).json({ message: 'Cannot deactivate admin users' });
    }

    if (user.isActive === false) {
      return res.status(400).json({ message: 'User is already deactivated' });
    }

    const updatedUser = await userDb.deactivateUser(userId);
    res.json(updatedUser);
  } catch (error) {
    console.error('Error deactivating user:', error);
    res.status(500).json({ message: 'Error deactivating user' });
  }
});

// Get waitlist entries
router.get('/waitlist', async (req, res) => {
  try {
    const { lastEvaluatedKey } = req.query;
    const result = await waitlistDb.list(lastEvaluatedKey as any);
    res.json(result);
  } catch (error) {
    console.error('Error getting waitlist:', error);
    res.status(500).json({ message: 'Error fetching waitlist' });
  }
});

// Update waitlist entry status
router.put('/waitlist/:email/status', async (req, res) => {
  try {
    const { email } = req.params;
    const { status } = req.body;

    if (!email || !status) {
      return res.status(400).json({ message: 'Email and status are required' });
    }

    // Check if user already exists
    const existingUser = await userDb.getUserByEmail(email);
    if (existingUser) {
      return res.status(400).json({ message: 'User already exists' });
    }

    const entry = await waitlistDb.updateStatus(
      email,
      status,
      status === 'invited' ? new Date().toISOString() : undefined
    );

    // Send invitation email if status is 'invited'
    if (status === 'invited') {
      try {
        await emailService.sendInvitation(email);
      } catch (emailError) {
        console.error('Error sending invitation email:', emailError);
        // Revert the status update
        await waitlistDb.updateStatus(email, 'pending');
        return res.status(500).json({ message: 'Failed to send invitation email' });
      }
    }

    res.json(entry);
  } catch (error) {
    console.error('Error updating waitlist status:', error);
    res.status(500).json({ message: 'Error updating waitlist status' });
  }
});

// Get all tasks
router.get('/tasks', async (req, res) => {
  try {
    const tasks = await taskDb.getAllTasks();
    
    // Get latest execution for each task
    const tasksWithLatestExecution = await Promise.all((tasks || []).map(async (task) => {
      const executions = await taskDb.getTaskExecutions(task.taskId);
      const latestExecution = executions && executions.length > 0 ? executions[0] : null;
      
      // Count completed and total runs
      const totalRuns = executions ? executions.length : 0;
      const completedRuns = executions ? executions.filter(exec => exec.status === 'completed').length : 0;
      
      return {
        ...task,
        latestRunStatus: latestExecution ? latestExecution.status : 'none',
        latestRunTime: latestExecution ? latestExecution.startTime : null,
        completedRuns,
        totalRuns
      };
    }));
    
    res.json(tasksWithLatestExecution);
  } catch (error) {
    console.error('Error getting tasks:', error);
    res.status(500).json({ message: 'Error fetching tasks' });
  }
});

// Get task analytics
router.get('/analytics/tasks', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const analytics = await taskDb.getTaskAnalytics(
      startDate as string,
      endDate as string
    );
    res.json(analytics);
  } catch (error) {
    console.error('Error getting task analytics:', error);
    res.status(500).json({ message: 'Error fetching task analytics' });
  }
});

// Get user analytics
router.get('/analytics/users', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const analytics = await userDb.getUserAnalytics(
      startDate as string,
      endDate as string
    );
    res.json(analytics);
  } catch (error) {
    console.error('Error getting user analytics:', error);
    res.status(500).json({ message: 'Error fetching user analytics' });
  }
});

// Get single task details
router.get('/tasks/:id', async (req, res) => {
  try {
    const taskId = req.params.id;
    const task = await taskDb.getTaskById(taskId);
    
    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    res.json(task);
  } catch (error) {
    console.error('Error getting task:', error);
    res.status(500).json({ message: 'Error fetching task' });
  }
});

// Get task executions
router.get('/tasks/:id/executions', async (req, res) => {
  try {
    const taskId = req.params.id;
    const task = await taskDb.getTaskById(taskId);
    
    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    const executions = await taskDb.getTaskExecutions(taskId);
    res.json(executions);
  } catch (error) {
    console.error('Error getting task executions:', error);
    res.status(500).json({ message: 'Error fetching task executions' });
  }
});

// Get task subscribers
router.get('/tasks/:taskId/subscribers', async (req, res) => {
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
router.post('/tasks/:taskId/subscribers', async (req, res) => {
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
router.delete('/tasks/:taskId/subscribers/:email', async (req, res) => {
  try {
    const { taskId, email } = req.params;
    await subscriberDb.removeSubscriber(taskId, email);
    res.status(204).send();
  } catch (error: any) {
    console.error('Error removing subscriber:', error);
    res.status(500).json({ message: error.message });
  }
});

// Send announcement to all users
router.post('/announcements/send', async (req, res) => {
  try {
    const { title, message } = req.body;
    if (!message || !title) {
      return res.status(400).json({ message: 'Title and message are required' });
    }

    // Get all active users
    const users = await userDb.getAllUsers();
    const activeEmails = users
      .filter(user => user.isActive !== false) // Filter out deactivated users
      .map(user => user.email)
      .filter(Boolean);

    // Send announcement email to all active users
    await Promise.all(
      activeEmails.map(email => 
        emailService.sendEmail(
          email,
          title,
          // Plain text version - strip HTML tags and decode entities
          message.replace(/<[^>]*>/g, '')
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .trim(),
          // HTML version with improved formatting
          `<!DOCTYPE html>
          <html>
            <head>
              <meta charset="utf-8">
              <meta name="viewport" content="width=device-width, initial-scale=1.0">
              <style>
                body {
                  font-family: Arial, sans-serif;
                  line-height: 1.6;
                  color: #333;
                  max-width: 600px;
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
                .content p {
                  margin: 0 0 1em 0;
                }
                .content p:last-child {
                  margin-bottom: 0;
                }
                .footer {
                  text-align: center;
                  margin-top: 20px;
                  color: #666;
                  font-size: 0.9em;
                }
              </style>
            </head>
            <body>
              <div class="header">
                <h2 style="margin:0;padding:0;font-size:24px;">${title}</h2>
              </div>
              <div class="content">
                ${message}
              </div>
              <div class="footer">
                <p>This is an official announcement from AgentWeb</p>
              </div>
            </body>
          </html>`
        )
      )
    );

    res.json({ message: `Announcement sent to ${activeEmails.length} active users` });
  } catch (error) {
    console.error('Error sending announcement:', error);
    res.status(500).json({ message: 'Error sending announcement' });
  }
});

export default router; 
