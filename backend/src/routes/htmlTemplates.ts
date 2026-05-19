import express from 'express';
import { authenticateToken } from '../middleware/auth';
import { 
  getTemplates, 
  saveTemplate, 
  deleteTemplate, 
  getPreviewTemplate 
} from '../controllers/htmlTemplatesController';

const router = express.Router();

/**
 * Unified HTML Templates Routes
 * Mount point: /api/html-templates
 */

// List all templates (supports filtering by ?type=email|landing_page)
router.get('/', authenticateToken, getTemplates);

// Create or update a template
router.post('/', authenticateToken, saveTemplate);

// Delete a template (requires isPublic query param for public ones)
router.delete('/:templateId', authenticateToken, deleteTemplate);

// Preview a template (legacy path support included)
// This is used for real-time visualization of templates by ID (or default-v2/landing-page-v2).
router.get('/preview/:templateId', authenticateToken, getPreviewTemplate);

export default router;
