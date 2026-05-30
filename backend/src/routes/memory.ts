import express from 'express';
import { authenticateToken } from '../middleware/auth';
import { accountMemoryDb, userDb } from '../services/db';
import { embedText } from '../utils/embeddings';

const router = express.Router();

router.use(authenticateToken);

// GET /api/memory/settings — get memory enabled status
router.get('/settings', async (req, res) => {
  try {
    const userId = (req as any).user.userId;
    const user = await userDb.getUserById(userId);
    res.json({ memoryEnabled: user?.memoryEnabled !== false });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to get memory settings' });
  }
});

// PUT /api/memory/settings — toggle memory on/off
router.put('/settings', async (req, res) => {
  try {
    const userId = (req as any).user.userId;
    const { memoryEnabled } = req.body;

    if (typeof memoryEnabled !== 'boolean') {
      return res.status(400).json({ error: 'memoryEnabled must be a boolean' });
    }

    await userDb.updateUser(userId, { memoryEnabled });
    res.json({ memoryEnabled });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to update memory settings' });
  }
});

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

    // Embed at write time so the memory can later be retrieved by relevance. Best-effort:
    // a failure here must not block saving the memory (it falls back to recency on read).
    const embedding = (await embedText(content)) ?? undefined;
    const memory = await accountMemoryDb.addMemory(userId, category, content, sourceSessionId, embedding);
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
