import express from 'express';
import { authenticateToken } from '../middleware/auth';
import { orgMemoryDb, orgDb, userDb } from '../services/db';
import { embedText } from '../utils/embeddings';

const router = express.Router();

router.use(authenticateToken);

// Helper: verify requester is an org member and return the org
async function requireOrgMember(userId: string, orgId: string) {
  const user = await userDb.getUserById(userId);
  if (!user || user.orgId !== orgId) {
    return null;
  }
  return user;
}

// GET /api/org/:orgId/memory/settings
router.get('/:orgId/memory/settings', async (req, res) => {
  try {
    const userId = (req as any).user?.userId;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const { orgId } = req.params;
    const member = await requireOrgMember(userId, orgId);
    if (!member) return res.status(403).json({ error: 'Not a member of this organization' });

    const org = await orgDb.getOrgById(orgId);
    if (!org) return res.status(404).json({ error: 'Organization not found' });

    res.json({ orgMemoryEnabled: org.orgMemoryEnabled !== false });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to get org memory settings' });
  }
});

// PUT /api/org/:orgId/memory/settings — owner only
router.put('/:orgId/memory/settings', async (req, res) => {
  try {
    const userId = (req as any).user?.userId;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const { orgId } = req.params;
    const { orgMemoryEnabled } = req.body;

    if (typeof orgMemoryEnabled !== 'boolean') {
      return res.status(400).json({ error: 'orgMemoryEnabled must be a boolean' });
    }

    const org = await orgDb.getOrgById(orgId);
    if (!org) return res.status(404).json({ error: 'Organization not found' });

    if (org.ownerUserId !== userId) {
      return res.status(403).json({ error: 'Only the org owner can change memory settings' });
    }

    await orgDb.updateOrg(orgId, { orgMemoryEnabled });
    res.json({ orgMemoryEnabled });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to update org memory settings' });
  }
});

// GET /api/org/:orgId/memory
router.get('/:orgId/memory', async (req, res) => {
  try {
    const userId = (req as any).user?.userId;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const { orgId } = req.params;
    const member = await requireOrgMember(userId, orgId);
    if (!member) return res.status(403).json({ error: 'Not a member of this organization' });

    const category = req.query.category as string | undefined;
    const memories = await orgMemoryDb.getOrgMemories(orgId, category);
    res.json({ memories });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to fetch org memories' });
  }
});

// POST /api/org/:orgId/memory — any org member can add
router.post('/:orgId/memory', async (req, res) => {
  try {
    const userId = (req as any).user?.userId;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const { orgId } = req.params;
    const member = await requireOrgMember(userId, orgId);
    if (!member) return res.status(403).json({ error: 'Not a member of this organization' });

    const { content, category } = req.body;
    if (!content || typeof content !== 'string') {
      return res.status(400).json({ error: 'content is required and must be a string' });
    }
    if (!category || typeof category !== 'string') {
      return res.status(400).json({ error: 'category is required and must be a string' });
    }

    // Embed at write time so the memory can later be retrieved by relevance (best-effort).
    const embedding = (await embedText(content, { userId, feature: 'embeddings' })) ?? undefined;
    const memory = await orgMemoryDb.addMemory(orgId, category, content, userId, embedding);
    res.status(201).json({ memory });
  } catch (error: any) {
    const status = error.message?.includes('Invalid category') || error.message?.includes('Content') ? 400 : 500;
    res.status(status).json({ error: error.message || 'Failed to create org memory' });
  }
});

// PUT /api/org/:orgId/memory/:memoryId — owner only
router.put('/:orgId/memory/:memoryId', async (req, res) => {
  try {
    const userId = (req as any).user?.userId;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const { orgId, memoryId } = req.params;

    const org = await orgDb.getOrgById(orgId);
    if (!org) return res.status(404).json({ error: 'Organization not found' });

    if (org.ownerUserId !== userId) {
      return res.status(403).json({ error: 'Only the org owner can edit org memories' });
    }

    const { content, category } = req.body;
    const updates: { content?: string; category?: string } = {};
    if (content !== undefined) updates.content = content;
    if (category !== undefined) updates.category = category;

    const memory = await orgMemoryDb.updateMemory(orgId, memoryId, updates);
    res.json({ memory });
  } catch (error: any) {
    const status = error.message?.includes('Invalid category') || error.message?.includes('Content') ? 400 : 500;
    res.status(status).json({ error: error.message || 'Failed to update org memory' });
  }
});

// DELETE /api/org/:orgId/memory/:memoryId — owner only
router.delete('/:orgId/memory/:memoryId', async (req, res) => {
  try {
    const userId = (req as any).user?.userId;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const { orgId, memoryId } = req.params;

    const org = await orgDb.getOrgById(orgId);
    if (!org) return res.status(404).json({ error: 'Organization not found' });

    if (org.ownerUserId !== userId) {
      return res.status(403).json({ error: 'Only the org owner can delete org memories' });
    }

    await orgMemoryDb.deleteMemory(orgId, memoryId);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to delete org memory' });
  }
});

export default router;
