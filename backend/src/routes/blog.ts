import express from "express";
import {
  generateBlogPost,
  publishBlogPost,
  generateImage,
} from "../controllers/blog";
import { authenticateToken } from "../middleware/auth";

const router = express.Router();

/**
 * Blog Routes
 * All routes are prefixed with /api/blog
 */

// Generate blog post content using AI
router.post("/generate", authenticateToken, generateBlogPost);

// Publish blog post to BaseHub
router.post("/publish", authenticateToken, publishBlogPost);

// Generate hero image for blog post
router.post("/generate-image", authenticateToken, generateImage);

export default router;
