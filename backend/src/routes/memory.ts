import express from 'express';
import { authenticateToken } from '../middleware/auth';
import { accountMemoryDb } from '../services/db';

const router = express.Router();

router.use(authenticateToken);

// GET /api/memory — list all memories, optionally filtered by category
router.get('/', async (req, res) => {
  try {
    const userId = (req as any).user.userId;
    const category = req.query.category as string | undefined;
    const memories = await accountMemoryDb.getUserMemories(userId, category);
    res.json({ memories });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to fetch memories' });
  }
});

// POST /api/memory — create a new memory
router.post('/', async (req, res) => {
  try {
    const userId = (req as any).user.userId;
    const { content, category, sourceSessionId } = req.body;

    if (!content || typeof content !== 'string') {
      return res.status(400).json({ error: 'content is required and must be a string' });
    }
    if (!category || typeof category !== 'string') {
      return res.status(400).json({ error: 'category is required and must be a string' });
    }

    const memory = await accountMemoryDb.addMemory(userId, category, content, sourceSessionId);
    res.status(201).json({ memory });
  } catch (error: any) {
    const status = error.message?.includes('Invalid category') || error.message?.includes('Content') ? 400 : 500;
    res.status(status).json({ error: error.message || 'Failed to create memory' });
  }
});

// PUT /api/memory/:memoryId — update a memory
router.put('/:memoryId', async (req, res) => {
  try {
    const userId = (req as any).user.userId;
    const { memoryId } = req.params;
    const { content, category } = req.body;

    const updates: { content?: string; category?: string } = {};
    if (content !== undefined) updates.content = content;
    if (category !== undefined) updates.category = category;

    const memory = await accountMemoryDb.updateMemory(userId, memoryId, updates);
    res.json({ memory });
  } catch (error: any) {
    const status = error.message?.includes('Invalid category') || error.message?.includes('Content') ? 400 : 500;
    res.status(status).json({ error: error.message || 'Failed to update memory' });
  }
});

// DELETE /api/memory/:memoryId — delete a memory
router.delete('/:memoryId', async (req, res) => {
  try {
    const userId = (req as any).user.userId;
    const { memoryId } = req.params;
    await accountMemoryDb.deleteMemory(userId, memoryId);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to delete memory' });
  }
});

export default router;
