import express from 'express';
import { waitlistDb } from '../services/waitlistDb';
import { validateEmail } from '../utils/validation';

const router = express.Router();

router.post('/', async (req, res) => {
  try {
    const { email, useCaseInfo } = req.body;

    if (!email || !validateEmail(email)) {
      return res.status(400).json({ message: 'Invalid email address' });
    }

    // Parse the useCaseInfo string into an object
    let parsedUseCaseInfo;
    try {
      parsedUseCaseInfo = JSON.parse(useCaseInfo);
    } catch (error) {
      return res.status(400).json({ message: 'Invalid use case information format' });
    }

    // Validate required fields
    if (!parsedUseCaseInfo.fullName || !parsedUseCaseInfo.companyName) {
      return res.status(400).json({ message: 'Full name and company name are required' });
    }

    // Check if email already exists
    const existing = await waitlistDb.getByEmail(email);
    if (existing) {
      return res.status(409).json({ message: 'Email already registered' });
    }

    // Add to waitlist
    const entry = await waitlistDb.add({
      email,
      joinedAt: new Date().toISOString(),
      fullName: parsedUseCaseInfo.fullName,
      phoneNumber: parsedUseCaseInfo.phoneNumber,
      companyName: parsedUseCaseInfo.companyName,
      requestReport: parsedUseCaseInfo.requestReport,
      useCaseCategories: parsedUseCaseInfo.categories,
      useCaseDescription: parsedUseCaseInfo.description
    });

    res.status(201).json(entry);
  } catch (error) {
    console.error('Error adding to waitlist:', error);
    res.status(500).json({ message: 'Failed to join waitlist' });
  }
});

router.get('/', async (req, res) => {
  try {
    const { lastEvaluatedKey } = req.query;
    const result = await waitlistDb.list(lastEvaluatedKey as any);
    res.json(result);
  } catch (error) {
    console.error('Error listing waitlist:', error);
    res.status(500).json({ message: 'Failed to list waitlist entries' });
  }
});

router.put('/:email/status', async (req, res) => {
  try {
    const { email } = req.params;
    const { status } = req.body;

    if (!email || !status) {
      return res.status(400).json({ message: 'Email and status are required' });
    }

    const entry = await waitlistDb.updateStatus(
      email,
      status,
      status === 'invited' ? new Date().toISOString() : undefined
    );

    res.json(entry);
  } catch (error) {
    console.error('Error updating waitlist status:', error);
    res.status(500).json({ message: 'Failed to update waitlist status' });
  }
});

export default router; 