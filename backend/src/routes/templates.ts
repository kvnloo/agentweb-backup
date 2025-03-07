import express from 'express';
import { createTemplate, getTemplates, getTemplate, updateTemplate, deleteTemplate } from '../controllers/templates';
import { authenticateToken } from '../middleware/auth';

const router = express.Router();

// All template routes require authentication
router.use(authenticateToken);

// Create a new template
router.post('/', createTemplate);

// Get all templates for the authenticated user
router.get('/', getTemplates);

// Get a specific template by ID
router.get('/:id', getTemplate);

// Update a template
router.put('/:id', updateTemplate);

// Delete a template
router.delete('/:id', deleteTemplate);

export default router; 