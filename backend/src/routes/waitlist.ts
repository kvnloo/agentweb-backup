import express from 'express';
import { waitlistDb } from '../services/db';

const router = express.Router();

router.post('/', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ message: 'Email is required' });
    }

    // Check if email is already in waitlist
    const existingEntry = await waitlistDb.getByEmail(email);
    if (existingEntry) {
      return res.status(400).json({ message: 'Email is already on the waitlist' });
    }

    // Add to waitlist
    await waitlistDb.add({
      email,
      joinedAt: new Date().toISOString()
    });

    res.status(201).json({ message: 'Successfully joined the waitlist' });
  } catch (error) {
    console.error('Error in waitlist signup:', error);
    res.status(500).json({ message: 'Error joining waitlist' });
  }
});

export default router; 