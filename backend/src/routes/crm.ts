import express, { Request, Response } from 'express';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { crmDb, taskDb, subscriberDb } from '../services/db';
import { settingsService } from '../services/settingsService';
import { resendService } from '../services/resendService';
import { leadListAlertService } from '../services/leadListAlertService';
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

const normalizeAlertEvents = (alertEvents: any) => {
  if (alertEvents === undefined) {
    return undefined;
  }
  if (!Array.isArray(alertEvents)) {
    throw new Error('alertEvents must be an array');
  }
  const normalized = alertEvents
    .map((event) => (typeof event === 'string' ? event.trim().toLowerCase() : ''))
    .filter(Boolean);
  return Array.from(new Set(normalized));
};

const getCrmSenderIds = async (userId: string) => {
  const settingName = `crm_sender_emails_${userId}`;
  const setting = await settingsService.getSetting(settingName);
  if (!setting?.settingValue) {
    return [];
  }
  try {
    const config = JSON.parse(setting.settingValue);
    const senders = Array.isArray(config?.senders) ? config.senders : [];
    return senders.map((sender: any) => sender.id).filter(Boolean);
  } catch (error) {
    console.error('Error parsing CRM sender emails:', error);
    return [];
  }
};

const normalizeSenderId = (senderId: any) => {
  if (senderId === null || senderId === undefined || senderId === '') {
    return null;
  }
  if (typeof senderId !== 'string') {
    return senderId;
  }
  return senderId.trim();
};

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

    const { name, description, alertEvents, listSenderId } = req.body;

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({ message: 'List name is required' });
    }

    let normalizedAlertEvents: string[] | undefined;
    try {
      normalizedAlertEvents = normalizeAlertEvents(alertEvents);
    } catch (error: any) {
      return res.status(400).json({ message: error.message || 'Invalid alertEvents' });
    }

    const normalizedListSenderId = normalizeSenderId(listSenderId);
    if (normalizedListSenderId !== null && typeof normalizedListSenderId !== 'string') {
      return res.status(400).json({ message: 'listSenderId must be a string or null' });
    }
    if (normalizedListSenderId) {
      const senderIds = await getCrmSenderIds(userId);
      if (!senderIds.includes(normalizedListSenderId)) {
        return res.status(400).json({ message: 'listSenderId must reference a configured sender' });
      }
    }

    const list = await crmDb.createLeadList(
      userId,
      name.trim(),
      description?.trim(),
      normalizedAlertEvents,
      normalizedListSenderId
    );
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
    const { name, description, displayFields, sortConfig, alertEvents, listSenderId } = req.body;

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

    const updates: {
      name?: string;
      description?: string;
      displayFields?: string[];
      sortConfig?: { column: string; direction: 'asc' | 'desc' } | null;
      alertEvents?: string[];
      listSenderId?: string | null;
    } = {};
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

    if (sortConfig !== undefined) {
      if (sortConfig === null) {
        updates.sortConfig = null;
      } else if (typeof sortConfig === 'object' && !Array.isArray(sortConfig)) {
        const column = typeof sortConfig.column === 'string' ? sortConfig.column.trim() : '';
        const direction = typeof sortConfig.direction === 'string' ? sortConfig.direction.toLowerCase() : '';
        if (!column) {
          return res.status(400).json({ message: 'sortConfig.column is required' });
        }
        if (direction !== 'asc' && direction !== 'desc') {
          return res.status(400).json({ message: 'sortConfig.direction must be "asc" or "desc"' });
        }
        updates.sortConfig = { column, direction: direction as 'asc' | 'desc' };
      } else {
        return res.status(400).json({ message: 'sortConfig must be an object or null' });
      }
    }

    if (alertEvents !== undefined) {
      try {
        updates.alertEvents = normalizeAlertEvents(alertEvents) || [];
      } catch (error: any) {
        return res.status(400).json({ message: error.message || 'Invalid alertEvents' });
      }
    }

    if (listSenderId !== undefined) {
      const normalizedListSenderId = normalizeSenderId(listSenderId);
      if (normalizedListSenderId !== null && typeof normalizedListSenderId !== 'string') {
        return res.status(400).json({ message: 'listSenderId must be a string or null' });
      }
      if (normalizedListSenderId) {
        const senderIds = await getCrmSenderIds(userId);
        if (!senderIds.includes(normalizedListSenderId)) {
          return res.status(400).json({ message: 'listSenderId must reference a configured sender' });
        }
      }
      updates.listSenderId = normalizedListSenderId;
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
    
    // Add engagement counts to each lead
    const leadsWithCounts = await Promise.all(
      result.items.map(async (lead: any) => {
        const engagementCounts = await crmDb.getLeadEngagementCount(listId, lead.leadId, userId);
        return {
          ...lead,
          engagementCount: engagementCounts.total,
          engagementCountLast7Days: engagementCounts.last7Days,
        };
      })
    );
    
    // Calculate total pages (approximate - we don't know the exact total without scanning all)
    // For now, we'll indicate if there are more pages
    const totalPages = result.hasMore ? validPage + 1 : validPage;

    res.json({
      leads: leadsWithCounts,
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
    if (leadData?.selectedSenderId !== undefined) {
      const normalizedSenderId = normalizeSenderId(leadData.selectedSenderId);
      if (normalizedSenderId !== null && typeof normalizedSenderId !== 'string') {
        return res.status(400).json({ message: 'selectedSenderId must be a string or null' });
      }
      if (normalizedSenderId) {
        const senderIds = await getCrmSenderIds(userId);
        if (!senderIds.includes(normalizedSenderId)) {
          return res.status(400).json({ message: 'selectedSenderId must reference a configured sender' });
        }
      }
      leadData.selectedSenderId = normalizedSenderId;
    }

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

    if (updates?.selectedSenderId !== undefined) {
      const normalizedSenderId = normalizeSenderId(updates.selectedSenderId);
      if (normalizedSenderId !== null && typeof normalizedSenderId !== 'string') {
        return res.status(400).json({ message: 'selectedSenderId must be a string or null' });
      }
      if (normalizedSenderId) {
        const senderIds = await getCrmSenderIds(userId);
        if (!senderIds.includes(normalizedSenderId)) {
          return res.status(400).json({ message: 'selectedSenderId must reference a configured sender' });
        }
      }
      updates.selectedSenderId = normalizedSenderId;
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
    try {
      await leadListAlertService.notifyLeadListOwnerIfConfigured(
        list,
        updatedLead,
        eventType,
        eventData,
        createdAt
      );
    } catch (alertError) {
      console.error('Failed to send lead list alert email:', alertError);
    }
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

/**
 * @route GET /api/crm/sender-emails
 * @desc Get CRM sender emails configuration for the authenticated user
 * @access Private
 */
router.get('/sender-emails', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const settingName = `crm_sender_emails_${userId}`;
    const setting = await settingsService.getSetting(settingName);

    if (!setting) {
      return res.json({ senders: [], defaultSenderId: null });
    }

    try {
      const config = JSON.parse(setting.settingValue);
      res.json({
        senders: config.senders || [],
        defaultSenderId: config.defaultSenderId || null
      });
    } catch (parseError) {
      console.error('Error parsing CRM sender emails:', parseError);
      res.json({ senders: [], defaultSenderId: null });
    }
  } catch (error: any) {
    console.error('Error fetching CRM sender emails:', error);
    res.status(500).json({ message: error.message || 'Failed to fetch CRM sender emails' });
  }
});

/**
 * @route POST /api/crm/sender-emails
 * @desc Save CRM sender emails configuration for the authenticated user
 * @access Private
 */
router.post('/sender-emails', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { senders, defaultSenderId } = req.body;

    // Validate senders array
    if (!Array.isArray(senders)) {
      return res.status(400).json({ message: 'Senders must be an array' });
    }

    // Validate each sender
    for (const sender of senders) {
      if (!sender.email || !sender.fromName) {
        return res.status(400).json({ message: 'Each sender must have email and fromName' });
      }
      // Remove description if present (no longer supported)
      delete sender.description;
      if (!/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(sender.email)) {
        return res.status(400).json({ message: `Invalid email format: ${sender.email}` });
      }
      // Notes is optional, but if provided, it should be a string
      if (sender.notes !== undefined && typeof sender.notes !== 'string') {
        return res.status(400).json({ message: 'Notes must be a string if provided' });
      }
    }

    // Validate defaultSenderId if provided
    if (defaultSenderId !== null && defaultSenderId !== undefined) {
      const defaultSenderExists = senders.some((s: any, index: number) => 
        s.id === defaultSenderId || index.toString() === defaultSenderId
      );
      if (!defaultSenderExists && senders.length > 0) {
        return res.status(400).json({ message: 'defaultSenderId must reference an existing sender' });
      }
    }

    const settingName = `crm_sender_emails_${userId}`;
    const config = {
      senders: senders.map((s: any, index: number) => ({
        id: s.id || index.toString(),
        email: s.email.trim(),
        fromName: s.fromName.trim(),
        notes: s.notes ? s.notes.trim() : undefined
      })),
      defaultSenderId: defaultSenderId || (senders.length > 0 ? senders[0].id || '0' : null)
    };

    await settingsService.setSetting(
      settingName,
      JSON.stringify(config),
      'CRM sender emails configuration',
      authReq.user?.email || 'system'
    );

    res.json({ message: 'CRM sender emails saved successfully', ...config });
  } catch (error: any) {
    console.error('Error saving CRM sender emails:', error);
    res.status(500).json({ message: error.message || 'Failed to save CRM sender emails' });
  }
});

/**
 * @route POST /api/crm/lists/:listId/leads/:leadId/send-email
 * @desc Send email draft to a lead using Resend
 * @access Private
 */
router.post('/lists/:listId/leads/:leadId/send-email', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    const { listId, leadId } = req.params;
    const { senderEmail, senderName, subject, htmlContent, textContent } = req.body;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    // Validate required fields - need either htmlContent or textContent
    if (!senderEmail || !senderName || !subject || (!htmlContent && !textContent)) {
      return res.status(400).json({ message: 'Missing required fields: senderEmail, senderName, subject, and either htmlContent or textContent' });
    }

    // Get the lead to get the recipient email
    const lead = await crmDb.getLeadById(listId, leadId);
    if (!lead) {
      return res.status(404).json({ message: 'Lead not found' });
    }

    if (!lead.email) {
      return res.status(400).json({ message: 'Lead does not have an email address' });
    }

    // Verify the lead belongs to the user's list
    const list = await crmDb.getLeadListById(listId);
    if (!list || list.userId !== userId) {
      return res.status(403).json({ message: 'Access denied' });
    }

    // Send email via Resend
    const from = `${senderName} <${senderEmail}>`;
    const result = await resendService.sendEmail({
      from,
      to: lead.email,
      subject,
      html: htmlContent,
      text: textContent
    });

    if (!result) {
      return res.status(500).json({ message: 'Failed to send email via Resend' });
    }

    // Remove the email draft after successfully sending
    await crmDb.updateLead(listId, leadId, {
      emailDraft: null
    });

    res.json({
      message: 'Email sent successfully',
      emailId: result.id
    });
  } catch (error: any) {
    console.error('Error sending email:', error);
    res.status(500).json({ message: error.message || 'Failed to send email' });
  }
});

/**
 * @route POST /api/crm/lists/:listId/leads/:leadId/reply-email
 * @desc Reply to an email.received event using Resend
 * @access Private
 */
router.post('/lists/:listId/leads/:leadId/reply-email', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    const { listId, leadId } = req.params;
    const { senderEmail, senderName, subject, htmlContent, messageId } = req.body;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    // Validate required fields
    if (!senderEmail || !senderName || !subject || !htmlContent || !messageId) {
      return res.status(400).json({ message: 'Missing required fields: senderEmail, senderName, subject, htmlContent, messageId' });
    }

    // Get the lead to get the recipient email
    const lead = await crmDb.getLeadById(listId, leadId);
    if (!lead) {
      return res.status(404).json({ message: 'Lead not found' });
    }

    if (!lead.email) {
      return res.status(400).json({ message: 'Lead does not have an email address' });
    }

    // Verify the lead belongs to the user's list
    const list = await crmDb.getLeadListById(listId);
    if (!list || list.userId !== userId) {
      return res.status(403).json({ message: 'Access denied' });
    }

    // Send reply email via Resend with In-Reply-To header
    const from = `${senderName} <${senderEmail}>`;
    const result = await resendService.sendEmail({
      from,
      to: lead.email,
      subject,
      html: htmlContent,
      inReplyTo: messageId
    });

    if (!result) {
      return res.status(500).json({ message: 'Failed to send reply email via Resend' });
    }

    res.json({
      message: 'Reply email sent successfully',
      emailId: result.id
    });
  } catch (error: any) {
    console.error('Error sending reply email:', error);
    res.status(500).json({ message: error.message || 'Failed to send reply email' });
  }
});

/**
 * @route POST /api/crm/sync-subscribers
 * @desc Sync task subscribers to a CRM lead list
 * @access Private
 */
router.post('/sync-subscribers', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    const { taskId } = req.body;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    if (!taskId) {
      return res.status(400).json({ message: 'taskId is required' });
    }

    // Get the task to get the task name
    const task = await taskDb.getTaskById(taskId);
    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    // Verify task ownership
    if (task.userId !== userId) {
      return res.status(403).json({ message: 'Access denied' });
    }

    // Get all subscribers for the task (including unsubscribed) so we can update the subscribed field
    const subscribers = await subscriberDb.getAllTaskSubscribers(taskId);
    
    if (!subscribers || subscribers.length === 0) {
      return res.status(400).json({ message: 'No subscribers to sync' });
    }

    // Find or create lead list named "<task_name> Subscribers"
    const listName = `${task.name} Subscribers`;
    let leadList = null;

    // Get all lead lists for the user
    const allLists = await crmDb.getLeadListsByUserId(userId);
    leadList = allLists.find((list: any) => list.name === listName);

    // Create the list if it doesn't exist
    if (!leadList) {
      leadList = await crmDb.createLeadList(
        userId,
        listName,
        `Subscribers synced from task: ${task.name}`
      );
    }

    // Convert subscribers to leads format (subscribers is guaranteed to be defined and non-empty here)
    const leads = (subscribers || []).map((subscriber: any) => {
      const lead: any = {
        email: subscriber.email || '',
        firstName: subscriber.firstName || '',
        lastName: subscriber.lastName || '',
        phone: subscriber.phone || '',
        company: subscriber.company || '',
        title: subscriber.title || '',
        notes: subscriber.notes || '',
        linkedin: subscriber.linkedin || '',
      };

      // Add custom fields - treat all customFields as custom fields
      const customFields: Record<string, any> = {};
      
      // Add subscribed field (yes/no) based on unsubscribed status
      customFields.subscribed = subscriber.unsubscribed ? 'no' : 'yes';
      
      if (subscriber.customFields && typeof subscriber.customFields === 'object') {
        Object.assign(customFields, subscriber.customFields);
      }
      if (Object.keys(customFields).length > 0) {
        lead.customFields = customFields;
      }

      return lead;
    });

    // Batch create/merge leads (always force update)
    const results = await crmDb.batchCreateLeads(leadList.listId, leads);

    res.json({
      success: true,
      listId: leadList.listId,
      listName: leadList.name,
      successCount: results.successCount,
      newCount: results.newCount,
      mergedCount: results.mergedCount,
      errorCount: results.errorCount,
      errors: results.errors,
      message: `Synced ${results.successCount} subscriber(s) to lead list "${listName}"${results.errorCount > 0 ? `, ${results.errorCount} error(s)` : ''}`,
    });
  } catch (error: any) {
    console.error('Error syncing subscribers to CRM:', error);
    res.status(500).json({ message: error.message || 'Failed to sync subscribers to CRM' });
  }
});

export default router;
