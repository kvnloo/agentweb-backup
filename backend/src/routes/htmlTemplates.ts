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
router.delete('/:templateName', authenticateToken, deleteTemplate);

// Preview a template (legacy path support included)
// This is used for real-time visualization of templates by name.
router.get('/preview/:templateName', getPreviewTemplate);

export default router;
