import { Router } from "express";
import { authenticateToken } from "../middleware/auth";
import {
  generateBlogPost,
  generateImage,
  publishBlogPost,
  getCmsCategories,
  publishBlogDirect
} from "../controllers/blog";

const router = Router();

/**
 * Blog Routes
 * All routes are prefixed with /api/blog
 */

// Generate blog post content
router.post("/generate", authenticateToken, generateBlogPost);

// Generate hero image for blog post
router.post("/generate-image", authenticateToken, generateImage);

// Publish blog post to BaseHub
router.post("/publish", authenticateToken, publishBlogPost);

// Get CMS categories for the authenticated user
router.get("/categories", authenticateToken, getCmsCategories);

// Publish a blog article directly from an HTML report URL
router.post("/publish-direct", authenticateToken, publishBlogDirect);

export default router;
