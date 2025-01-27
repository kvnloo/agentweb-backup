import express from 'express';
import { authenticateToken } from '../middleware/auth';
import { isAdmin } from '../middleware/admin';
import { userDb, taskDb } from '../services/db';
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

export default router; 
