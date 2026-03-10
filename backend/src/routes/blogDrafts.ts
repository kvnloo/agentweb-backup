import express from 'express';
import { authenticateToken } from '../middleware/auth';
import { isAdmin } from '../middleware/admin';
import { BlogPostGenerator } from '../services/blogPostGenerator';

const router = express.Router();

const generator = new BlogPostGenerator({
  systemUserId: process.env.BLOG_DRAFT_USER_ID || 'system',
});

/**
 * POST /api/blog-drafts/generate
 * Generate a draft blog post from a feature PR's context.
 * Admin-only endpoint.
 *
 * Body: {
 *   feature_name: string (required),
 *   pr_title: string (required),
 *   pr_url: string (required),
 *   steps?: string[],
 *   screenshot_urls?: string[],
 *   notion_task_url?: string,
 *   description?: string,
 * }
 */
router.post(
  '/generate',
  authenticateToken,
  isAdmin,
  async (req, res) => {
    try {
      const {
        feature_name,
        pr_title,
        pr_url,
        steps,
        screenshot_urls,
        notion_task_url,
        description,
      } = req.body;

      if (!feature_name || !pr_title || !pr_url) {
        res.status(400).json({
          error: 'feature_name, pr_title, and pr_url are required',
        });
        return;
      }

      const result = await generator.generate({
        feature_name,
        pr_title,
        pr_url,
        steps,
        screenshot_urls,
        notion_task_url,
        description,
      });

      res.json({
        status: result.status,
        sessionId: result.sessionId,
        draft: result.draft,
      });
    } catch (error: any) {
      console.error('Blog draft generation failed:', error.message);
      res.status(500).json({ error: error.message });
    }
  },
);

export default router;
