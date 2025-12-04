import express, { Request, Response } from 'express';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { crmDb } from '../services/db';
import multer from 'multer';
import { parse } from 'csv-parse/sync';

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
});

// Apply authentication middleware to all routes
router.use(authenticateToken);

// Lead List Routes

/**
 * @route GET /api/crm/lists
 * @desc Get all lead lists for the authenticated user
 * @access Private
 */
router.get('/lists', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const lists = await crmDb.getLeadListsByUserId(userId);
    res.json(lists);
  } catch (error: any) {
    console.error('Error fetching lead lists:', error);
    res.status(500).json({ message: error.message || 'Failed to fetch lead lists' });
  }
});

/**
 * @route POST /api/crm/lists
 * @desc Create a new lead list
 * @access Private
 */
router.post('/lists', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { name, description } = req.body;

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({ message: 'List name is required' });
    }

    const list = await crmDb.createLeadList(userId, name.trim(), description?.trim());
    res.status(201).json(list);
  } catch (error: any) {
    console.error('Error creating lead list:', error);
    res.status(500).json({ message: error.message || 'Failed to create lead list' });
  }
});

/**
 * @route GET /api/crm/lists/:listId
 * @desc Get a specific lead list
 * @access Private
 */
router.get('/lists/:listId', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    const { listId } = req.params;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const list = await crmDb.getLeadListById(listId);

    if (!list) {
      return res.status(404).json({ message: 'Lead list not found' });
    }

    // Verify ownership
    if (list.userId !== userId) {
      return res.status(403).json({ message: 'Access denied' });
    }

    res.json(list);
  } catch (error: any) {
    console.error('Error fetching lead list:', error);
    res.status(500).json({ message: error.message || 'Failed to fetch lead list' });
  }
});

/**
 * @route PUT /api/crm/lists/:listId
 * @desc Update a lead list
 * @access Private
 */
router.put('/lists/:listId', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    const { listId } = req.params;
    const { name, description, displayFields } = req.body;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    // Verify ownership
    const list = await crmDb.getLeadListById(listId);
    if (!list) {
      return res.status(404).json({ message: 'Lead list not found' });
    }

    if (list.userId !== userId) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const updates: { name?: string; description?: string; displayFields?: string[] } = {};
    if (name !== undefined) {
      if (typeof name !== 'string' || name.trim().length === 0) {
        return res.status(400).json({ message: 'List name cannot be empty' });
      }
      updates.name = name.trim();
    }

    if (description !== undefined) {
      updates.description = typeof description === 'string' ? description.trim() : '';
    }

    if (displayFields !== undefined) {
      if (Array.isArray(displayFields)) {
        updates.displayFields = displayFields;
      } else {
        return res.status(400).json({ message: 'displayFields must be an array' });
      }
    }

    const updatedList = await crmDb.updateLeadList(listId, updates);
    res.json(updatedList);
  } catch (error: any) {
    console.error('Error updating lead list:', error);
    res.status(500).json({ message: error.message || 'Failed to update lead list' });
  }
});

/**
 * @route DELETE /api/crm/lists/:listId
 * @desc Delete a lead list and all its leads
 * @access Private
 */
router.delete('/lists/:listId', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    const { listId } = req.params;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    // Verify ownership
    const list = await crmDb.getLeadListById(listId);
    if (!list) {
      return res.status(404).json({ message: 'Lead list not found' });
    }

    if (list.userId !== userId) {
      return res.status(403).json({ message: 'Access denied' });
    }

    await crmDb.deleteLeadList(listId);
    res.json({ success: true, message: 'Lead list deleted successfully' });
  } catch (error: any) {
    console.error('Error deleting lead list:', error);
    res.status(500).json({ message: error.message || 'Failed to delete lead list' });
  }
});

// Lead Routes

/**
 * @route GET /api/crm/lists/:listId/leads
 * @desc Get leads in a list with pagination
 * @access Private
 * @query page - Page number (default: 1, 1-indexed)
 * @query limit - Number of items per page (default: 50, max: 100)
 */
router.get('/lists/:listId/leads', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    const { listId } = req.params;
    const page = req.query.page ? parseInt(req.query.page as string, 10) : 1;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    // Verify list ownership
    const list = await crmDb.getLeadListById(listId);
    if (!list) {
      return res.status(404).json({ message: 'Lead list not found' });
    }

    if (list.userId !== userId) {
      return res.status(403).json({ message: 'Access denied' });
    }

    // Validate inputs
    const validPage = Math.max(1, page);
    const validLimit = Math.min(Math.max(1, limit), 100); // Between 1 and 100

    // For page-based pagination, we need to fetch all previous pages to get to the desired page
    // This is not ideal for DynamoDB but necessary for page number navigation
    let lastEvaluatedKey = undefined;
    if (validPage > 1) {
      // Fetch pages 1 through (page - 1) to get the cursor for the desired page
      for (let p = 1; p < validPage; p++) {
        const prevResult = await crmDb.getLeadsByListId(listId, validLimit, lastEvaluatedKey);
        lastEvaluatedKey = prevResult.lastEvaluatedKey;
        if (!lastEvaluatedKey) {
          // We've reached the end, return empty results
          return res.json({
            leads: [],
            page: validPage,
            limit: validLimit,
            totalPages: p,
            hasMore: false,
          });
        }
      }
    }

    const result = await crmDb.getLeadsByListId(listId, validLimit, lastEvaluatedKey);
    
    // Calculate total pages (approximate - we don't know the exact total without scanning all)
    // For now, we'll indicate if there are more pages
    const totalPages = result.hasMore ? validPage + 1 : validPage;

    res.json({
      leads: result.items,
      page: validPage,
      limit: validLimit,
      totalPages: result.hasMore ? null : validPage, // null means unknown total
      hasMore: result.hasMore,
    });
  } catch (error: any) {
    console.error('Error fetching leads:', error);
    res.status(500).json({ message: error.message || 'Failed to fetch leads' });
  }
});

/**
 * @route POST /api/crm/lists/:listId/leads
 * @desc Create a new lead in a list
 * @access Private
 */
router.post('/lists/:listId/leads', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    const { listId } = req.params;
    const leadData = req.body;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    // Verify list ownership
    const list = await crmDb.getLeadListById(listId);
    if (!list) {
      return res.status(404).json({ message: 'Lead list not found' });
    }

    if (list.userId !== userId) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const lead = await crmDb.createLead(listId, leadData);
    res.status(201).json(lead);
  } catch (error: any) {
    console.error('Error creating lead:', error);
    res.status(500).json({ message: error.message || 'Failed to create lead' });
  }
});

/**
 * @route GET /api/crm/lists/:listId/leads/:leadId
 * @desc Get a specific lead
 * @access Private
 */
router.get('/lists/:listId/leads/:leadId', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    const { listId, leadId } = req.params;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    // Verify list ownership
    const list = await crmDb.getLeadListById(listId);
    if (!list) {
      return res.status(404).json({ message: 'Lead list not found' });
    }

    if (list.userId !== userId) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const lead = await crmDb.getLeadById(listId, leadId);
    if (!lead) {
      return res.status(404).json({ message: 'Lead not found' });
    }

    res.json(lead);
  } catch (error: any) {
    console.error('Error fetching lead:', error);
    res.status(500).json({ message: error.message || 'Failed to fetch lead' });
  }
});

/**
 * @route PUT /api/crm/lists/:listId/leads/:leadId
 * @desc Update a lead
 * @access Private
 */
router.put('/lists/:listId/leads/:leadId', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    const { listId, leadId } = req.params;
    const updates = req.body;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    // Verify list ownership
    const list = await crmDb.getLeadListById(listId);
    if (!list) {
      return res.status(404).json({ message: 'Lead list not found' });
    }

    if (list.userId !== userId) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const updateData = updates;

    const updatedLead = await crmDb.updateLead(listId, leadId, updateData);
    res.json(updatedLead);
  } catch (error: any) {
    console.error('Error updating lead:', error);
    res.status(500).json({ message: error.message || 'Failed to update lead' });
  }
});

/**
 * @route DELETE /api/crm/lists/:listId/leads/:leadId
 * @desc Delete a lead
 * @access Private
 */
router.delete('/lists/:listId/leads/:leadId', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    const { listId, leadId } = req.params;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    // Verify list ownership
    const list = await crmDb.getLeadListById(listId);
    if (!list) {
      return res.status(404).json({ message: 'Lead list not found' });
    }

    if (list.userId !== userId) {
      return res.status(403).json({ message: 'Access denied' });
    }

    await crmDb.deleteLead(listId, leadId);
    res.json({ success: true, message: 'Lead deleted successfully' });
  } catch (error: any) {
    console.error('Error deleting lead:', error);
    res.status(500).json({ message: error.message || 'Failed to delete lead' });
  }
});

/**
 * @route POST /api/crm/lists/:listId/leads/import
 * @desc Import leads from CSV file
 * @access Private
 */
router.post('/lists/:listId/leads/import', upload.single('file'), async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    const { listId } = req.params;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    // Verify list ownership
    const list = await crmDb.getLeadListById(listId);
    if (!list) {
      return res.status(404).json({ message: 'Lead list not found' });
    }

    if (list.userId !== userId) {
      return res.status(403).json({ message: 'Access denied' });
    }

    if (!req.file) {
      return res.status(400).json({ message: 'CSV file is required' });
    }

    // Parse CSV file
    const fileContent = req.file.buffer.toString('utf-8');
    let records: any[];
    
    try {
      records = parse(fileContent, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        relax_column_count: true,
      });
    } catch (parseError: any) {
      return res.status(400).json({ message: `Failed to parse CSV: ${parseError.message}` });
    }

    if (records.length === 0) {
      return res.status(400).json({ message: 'CSV file is empty or has no valid rows' });
    }

    // Map CSV records to lead data
    const leads = records.map((record, index) => {
      // Only normalize email field for deduplication, all other fields pass through as-is
      const standardFields = ['firstName', 'lastName', 'phone', 'company', 'title', 'notes', 'linkedin'];
      
      // Find and normalize email field (for deduplication)
      let email = '';
      Object.keys(record).forEach(key => {
        const lower = key.toLowerCase().trim();
        if (['email', 'e-mail', 'e_mail'].includes(lower)) {
          email = record[key]?.trim() || '';
        }
      });

      // Extract standard fields if they match exactly (case-insensitive)
      const leadData: Record<string, any> = {};
      const customFields: Record<string, any> = {};
      
      Object.keys(record).forEach(key => {
        const lower = key.toLowerCase().trim();
        const value = record[key]?.trim() || '';
        
        // Skip email (already extracted)
        if (['email', 'e-mail', 'e_mail'].includes(lower)) {
          return;
        }
        
        // Check if it matches a standard field name (case-insensitive)
        const matchingStandardField = standardFields.find(sf => 
          sf.toLowerCase() === lower
        );
        
        if (matchingStandardField && value) {
          leadData[matchingStandardField] = value;
        } else if (value) {
          // All other fields go to customFields with original column name
          customFields[key] = value;
        }
      });

      return {
        email: email,
        firstName: leadData.firstName || '',
        lastName: leadData.lastName || '',
        phone: leadData.phone || '',
        company: leadData.company || '',
        title: leadData.title || '',
        notes: leadData.notes || '',
        linkedin: leadData.linkedin || '',
        customFields: Object.keys(customFields).length > 0 ? customFields : undefined,
      };
    });

    // Batch create leads
    const results = await crmDb.batchCreateLeads(listId, leads);

    res.json({
      success: true,
      successCount: results.successCount,
      errorCount: results.errorCount,
      errors: results.errors,
      message: `Imported ${results.successCount} leads${results.errorCount > 0 ? `, ${results.errorCount} errors` : ''}`,
    });
  } catch (error: any) {
    console.error('Error importing leads:', error);
    res.status(500).json({ message: error.message || 'Failed to import leads' });
  }
});

/**
 * @route GET /api/crm/lists/:listId/leads/:leadId/engagements
 * @desc Get engagements for a lead
 * @access Private
 */
router.get('/lists/:listId/leads/:leadId/engagements', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    const { listId, leadId } = req.params;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    // Verify list ownership
    const list = await crmDb.getLeadListById(listId);
    if (!list) {
      return res.status(404).json({ message: 'Lead list not found' });
    }

    if (list.userId !== userId) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const result = await crmDb.getLeadEngagements(listId, leadId, userId);
    res.json(result);
  } catch (error: any) {
    console.error('Error fetching lead engagements:', error);
    res.status(500).json({ message: error.message || 'Failed to fetch lead engagements' });
  }
});

/**
 * @route POST /api/crm/lists/:listId/leads/:leadId/engagements
 * @desc Add a custom engagement event to a lead
 * @access Private
 */
router.post('/lists/:listId/leads/:leadId/engagements', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    const { listId, leadId } = req.params;
    const { eventType, eventData, createdAt } = req.body;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    if (!eventType || !createdAt) {
      return res.status(400).json({ message: 'eventType and createdAt are required' });
    }

    // Verify eventType starts with "custom."
    if (!eventType.startsWith('custom.')) {
      return res.status(400).json({ message: 'Event type must start with "custom."' });
    }

    // Verify list ownership
    const list = await crmDb.getLeadListById(listId);
    if (!list) {
      return res.status(404).json({ message: 'Lead list not found' });
    }

    if (list.userId !== userId) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const engagement = {
      eventType,
      eventData: eventData || {},
      createdAt,
    };

    const updatedLead = await crmDb.addLeadEngagement(listId, leadId, engagement);
    res.json({ success: true, lead: updatedLead });
  } catch (error: any) {
    console.error('Error adding lead engagement:', error);
    res.status(500).json({ message: error.message || 'Failed to add lead engagement' });
  }
});

/**
 * @route PUT /api/crm/lists/:listId/leads/:leadId/engagements/:eventId
 * @desc Update a custom engagement event for a lead
 * @access Private
 */
router.put('/lists/:listId/leads/:leadId/engagements/:eventId', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    const { listId, leadId, eventId } = req.params;
    const { eventType, eventData, createdAt } = req.body;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    if (!eventType || !createdAt) {
      return res.status(400).json({ message: 'eventType and createdAt are required' });
    }

    // Verify eventType starts with "custom."
    if (!eventType.startsWith('custom.')) {
      return res.status(400).json({ message: 'Event type must start with "custom."' });
    }

    // Verify list ownership
    const list = await crmDb.getLeadListById(listId);
    if (!list) {
      return res.status(404).json({ message: 'Lead list not found' });
    }

    if (list.userId !== userId) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const engagement = {
      eventType,
      eventData: eventData || {},
      createdAt,
    };

    const updatedLead = await crmDb.updateLeadEngagement(listId, leadId, eventId, engagement);
    res.json({ success: true, lead: updatedLead });
  } catch (error: any) {
    console.error('Error updating lead engagement:', error);
    res.status(500).json({ message: error.message || 'Failed to update lead engagement' });
  }
});

/**
 * @route DELETE /api/crm/lists/:listId/leads/:leadId/engagements/:eventId
 * @desc Delete a custom engagement event from a lead
 * @access Private
 */
router.delete('/lists/:listId/leads/:leadId/engagements/:eventId', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    const { listId, leadId, eventId } = req.params;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    // Verify list ownership
    const list = await crmDb.getLeadListById(listId);
    if (!list) {
      return res.status(404).json({ message: 'Lead list not found' });
    }

    if (list.userId !== userId) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const updatedLead = await crmDb.deleteLeadEngagement(listId, leadId, eventId);
    res.json({ success: true, lead: updatedLead });
  } catch (error: any) {
    console.error('Error deleting lead engagement:', error);
    res.status(500).json({ message: error.message || 'Failed to delete lead engagement' });
  }
});

export default router;

