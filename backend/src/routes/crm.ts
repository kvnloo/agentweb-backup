import express, { Request, Response } from 'express';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { crmDb, taskDb, subscriberDb, userDb, orgDb } from '../services/db';
import {
  canAccessCrmList,
  canDestructiveCrmList,
  CRM_EDITOR_REQUIRED_MESSAGE,
  CRM_SHARING_DISABLED_MESSAGE,
  getReadableOrgMemberIds,
} from '../services/crmAccessControl';
import { settingsService } from '../services/settingsService';
import { resendService } from '../services/resendService';
import { leadListAlertService } from '../services/leadListAlertService';
import { meterUsageFromResponse } from '../utils/llmClients';
import { substituteVariables, extractVariables, leadHasVariable, injectUnsubscribeUrl, checkEmailFormat, injectColorSchemeMeta } from '../utils/emailVariables';
import axios from 'axios';
import { assertPublicHostname, SsrfBlockedError } from '../utils/ssrfGuard';
import { signUnsubscribeUrl } from '../utils/unsubscribeUrl';
import multer from 'multer';
import { parse } from 'csv-parse/sync';
import AdmZip from 'adm-zip';
import { emailEventsDb } from '../services/emailEventsDb';
import { dynamodb } from '../config/aws';
import { io } from '../server';
import { isDoNotContact } from '../utils/leadContactStatus';
import { syncContact, SyncInput } from '../services/contactSyncService';
import { enrichContact, defaultEnrichmentCache, EnrichmentDeps } from '../services/internalEnrichmentService';
import { dedupContactsForUser } from '../services/contactDedupService';
import {
  dealDb,
  DealAuthError,
  DealNotFoundError,
  DEAL_STAGES,
  DealStage,
  ContactRef,
} from '../services/dealDb';
import Stripe from 'stripe';
import { createStripeClient } from '../services/stripeClientFactory';
import {
  buildBuiltInPresets,
  validateCreateInput,
  generateViewId,
  VALID_SCOPES,
  isPresetViewId,
  SavedView as SavedViewUtil,
  SavedViewScope as SavedViewScopeUtil,
} from '../utils/savedViews';
import { externalCrmSyncService } from '../services/externalCrmSyncService';
import { normalizeAttribution } from '../types/attribution';
import {
  EnrichmentInputError,
  validateFieldDescriptions,
  validateFieldName,
  validateGoal,
  validateInstruction,
  validateOptionalTemplate,
  validateOutputFields,
  validateSources,
  validateSourcesPerField,
} from '../utils/enrichmentValidation';
import { dripSequenceDb } from '../services/dripSequenceDb';
import {
  getEnrichmentConfig as svcGetEnrichmentConfig,
  setEnrichmentConfig as svcSetEnrichmentConfig,
  suggestFieldTypes as svcSuggestFieldTypes,
} from '../services/enrichmentConfigService';
import { buildConfigServiceDeps } from '../services/enrichmentConfigDeps';
import { runEnrichment as svcRunEnrichmentV3 } from '../services/crmEnrichmentServiceV3';
import { buildOrchestratorDeps as buildV3OrchestratorDeps } from '../services/enrichmentV3RealDeps';
import { sanitizeLeadForResponse } from '../utils/enrichmentMetadataPresentation';
import { getHubspotConnection, getMappedAgentwebFields, mappedFieldChanged, resolveSyncStatus } from '../utils/leadSyncStatus';

const d1StripeSecretKey = process.env.STRIPE_SECRET_KEY;

const enrichmentConfigDeps = buildConfigServiceDeps();
const d1StripeClient = d1StripeSecretKey
  ? createStripeClient(d1StripeSecretKey)
  : null;

const TABLE_PREFIX = process.env.NODE_ENV === 'development' ? 'Dev-' : '';

/**
 * Fire-and-forget: enroll a single newly created lead into any sequences that
 * have autoEnrollListIds containing this list. Errors are logged but never surfaced.
 */
async function autoEnrollLeadInSequences(
  userId: string,
  listId: string,
  leadId: string,
  leadEmail: string,
): Promise<void> {
  if (!leadEmail) return;
  try {
    const sequences = await dripSequenceDb.getSequencesByAutoEnrollList(userId, listId);
    for (const seq of sequences) {
      await dripSequenceDb.bulkEnroll([{
        sequenceId: seq.sequenceId,
        userId,
        listId,
        leadId,
        leadEmail,
      }]);
    }
  } catch (err) {
    console.error('[crm] autoEnrollLeadInSequences error:', err);
  }
}

/**
 * Fire-and-forget: after a bulk import, re-run bulkEnroll for all current leads
 * in the list against any sequences watching it. The bulkEnroll dedup ensures
 * already-enrolled leads are skipped; only genuinely new leads get added.
 */
async function autoEnrollListIntoSequences(userId: string, listId: string): Promise<void> {
  try {
    const sequences = await dripSequenceDb.getSequencesByAutoEnrollList(userId, listId);
    if (sequences.length === 0) return;

    const leadsResult = await crmDb.getLeadsByListId(listId);
    const leads = Array.isArray(leadsResult)
      ? leadsResult
      : ((leadsResult as any).items ?? (leadsResult as any).leads ?? []);

    for (const seq of sequences) {
      const inputs = leads
        .filter((l: any) => l.email)
        .map((l: any) => ({
          sequenceId: seq.sequenceId,
          userId,
          listId,
          leadId: l.leadId,
          leadEmail: l.email,
        }));
      if (inputs.length > 0) {
        await dripSequenceDb.bulkEnroll(inputs);
      }
    }
  } catch (err) {
    console.error('[crm] autoEnrollListIntoSequences error:', err);
  }
}

// In-memory cache for CRM data files uploaded to S3
// Key: `${userId}:${listId}`, Value: { leadsUrl, eventsUrl, expiresAt }
const crmDataFileCache = new Map<string, { leadsUrl: string; eventsUrl: string; expiresAt: number }>();
const CRM_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Normalize LinkedIn URL to standard format: https://www.linkedin.com/in/<username>
 * Strips trailing slashes, query parameters, fragments, and ensures consistent protocol
 */
function normalizeLinkedInUrl(url: string): string {
  if (!url) return '';

  try {
    // Remove whitespace and convert to lowercase
    let normalized = url.trim().toLowerCase();

    // Add https:// if missing
    if (!normalized.startsWith('http://') && !normalized.startsWith('https://')) {
      normalized = 'https://' + normalized;
    }

    // Parse URL
    const urlObj = new URL(normalized);

    // Only accept linkedin.com domains
    if (!urlObj.hostname.endsWith('linkedin.com')) {
      return '';
    }

    // Extract pathname and clean it
    let pathname = urlObj.pathname;

    // Remove trailing slash
    pathname = pathname.replace(/\/$/, '');

    // Only accept /in/ profile URLs (not company pages, etc.)
    const match = pathname.match(/^\/in\/([a-zA-Z0-9_-]+)/);
    if (!match) {
      return '';
    }

    const username = match[1];

    // Return canonical format
    return `https://www.linkedin.com/in/${username}`;
  } catch {
    return '';
  }
}

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB limit
  },
});

// Apply authentication middleware to all routes
router.use(authenticateToken);

// enrich.so routes (validate-email, lookup-by-email) live in their own
// sub-router so they can be unit-tested without mocking all of crm.ts.
import enrichSoSubRouter from './crmEnrichSo';
import { validateLeadEmailInBackground, validateLeadsInBackground } from '../services/enrichSoLeadValidation';
router.use(enrichSoSubRouter);

// Apollo people-enrichment routes (lookup-by-linkedin, reveal-phone, bulk
// enrich, and the /webhooks/apollo callback). The webhook handler attaches
// its own express.raw body parser before HMAC verification — keep this
// mounted before any global JSON body parser if we add one in the future.
import apolloSubRouter from './crmApollo';
import {
  loadSenderConfig,
  serializeSender,
  validateSender,
  senderSettingName,
  resolveSenderForSend,
  normalizeSender,
} from '../services/crmSenderService';
import { MAILBOX_PROVIDERS, CrmSender, isMailboxSender } from '../services/crmSenderTypes';
import { sendAsSender } from '../services/sendAsSender';
router.use(apolloSubRouter);

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
  const config = await loadSenderConfig(userId);
  return config.senders.map((sender) => sender.id).filter(Boolean);
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

const leadMatchesSearch = (lead: any, rawSearchQuery: string): boolean => {
  const searchQuery = rawSearchQuery.trim().toLowerCase();
  if (!searchQuery) {
    return true;
  }

  const standardFieldValues = [
    lead.email,
    lead.firstName,
    lead.lastName,
    `${lead.firstName || ''} ${lead.lastName || ''}`.trim(),
    lead.company,
    lead.phone,
    lead.title,
    lead.notes,
    lead.linkedin,
  ];

  if (
    standardFieldValues.some((value) =>
      String(value || '').toLowerCase().includes(searchQuery)
    )
  ) {
    return true;
  }

  const customFields = lead.customFields && typeof lead.customFields === 'object'
    ? lead.customFields
    : {};

  const customFieldValueMatch = Object.values(customFields).some((value) =>
    String(value || '').toLowerCase().includes(searchQuery)
  );
  if (customFieldValueMatch) {
    return true;
  }

  return Object.keys(customFields).some((key) =>
    key.toLowerCase().includes(searchQuery)
  );
};

const ENGAGED_EVENT_KEYWORDS = ['clicked', 'replied', 'received'];

const textIncludesEngagementKeyword = (value: any): boolean => {
  const normalized = String(value || '').toLowerCase();
  return ENGAGED_EVENT_KEYWORDS.some((keyword) => normalized.includes(keyword));
};

const leadHasManualEngagedEvents = (lead: any): boolean => {
  const manualEngagements = Array.isArray(lead?.engagements) ? lead.engagements : [];
  return manualEngagements.some((engagement: any) =>
    textIncludesEngagementKeyword(engagement?.eventType) ||
    textIncludesEngagementKeyword(JSON.stringify(engagement?.eventData || {}))
  );
};

const buildEngagedLeadLookup = async (listId: string, userId: string): Promise<{
  engagedEmails: Set<string>;
  engagedLinkedinUrls: Set<string>;
}> => {
  const engagedEmails = new Set<string>();
  const engagedLinkedinUrls = new Set<string>();

  try {
    const user = await userDb.getUserById(userId);
    const userEmailDomain = user?.emailDomain?.trim();

    if (userEmailDomain) {
      const domainEvents = await emailEventsDb.getEventsByEmailDomain(userEmailDomain);
      for (const event of domainEvents) {
        if (
          textIncludesEngagementKeyword(event?.eventType) ||
          textIncludesEngagementKeyword(JSON.stringify(event?.data || {}))
        ) {
          const leadEmail = String(event?.leadEmail || '').trim().toLowerCase();
          if (leadEmail) {
            engagedEmails.add(leadEmail);
          }
        }
      }
    }

    const linkedInEvents = await emailEventsDb.getEventsByEmailDomain(`linkedin-${listId}`);
    for (const event of linkedInEvents) {
      if (
        textIncludesEngagementKeyword(event?.eventType) ||
        textIncludesEngagementKeyword(JSON.stringify(event?.data || {}))
      ) {
        const linkedInUrl = String(event?.leadEmail || '').trim().toLowerCase();
        if (linkedInUrl) {
          engagedLinkedinUrls.add(linkedInUrl);
        }
      }
    }
  } catch (error) {
    console.error(`Error building engaged lead lookup for list ${listId}:`, error);
  }

  return {
    engagedEmails,
    engagedLinkedinUrls,
  };
};

const leadMatchesEngagedLookup = (
  lead: any,
  lookup: { engagedEmails: Set<string>; engagedLinkedinUrls: Set<string> }
): boolean => {
  if (leadHasManualEngagedEvents(lead)) {
    return true;
  }

  const normalizedEmail = String(lead?.email || '').trim().toLowerCase();
  if (normalizedEmail && lookup.engagedEmails.has(normalizedEmail)) {
    return true;
  }

  const normalizedLinkedIn = String(lead?.linkedin || '').trim().toLowerCase();
  if (normalizedLinkedIn && lookup.engagedLinkedinUrls.has(normalizedLinkedIn)) {
    return true;
  }

  const manualEngagements = Array.isArray(lead?.engagements) ? lead.engagements : [];
  return manualEngagements.some((engagement: any) =>
      textIncludesEngagementKeyword(engagement?.eventType) ||
      textIncludesEngagementKeyword(JSON.stringify(engagement?.eventData || {}))
    );
};

const leadMatchesICPFlag = (lead: any): boolean => {
  if (lead?.isICP !== undefined && lead?.isICP !== null) {
    return Number(lead.isICP) === 1;
  }
  return lead?.icpMatch?.isMatch === true;
};

const leadMatchesEngagedFlag = (
  lead: any,
  lookup?: { engagedEmails: Set<string>; engagedLinkedinUrls: Set<string> } | null
): boolean => {
  if (lead?.isEngaged !== undefined && lead?.isEngaged !== null) {
    return Number(lead.isEngaged) === 1;
  }
  if (lookup) {
    return leadMatchesEngagedLookup(lead, lookup);
  }
  return leadHasManualEngagedEvents(lead);
};

const updateLeadFlag = async (listId: string, leadId: string, updates: { isICP?: 0 | 1; isEngaged?: 0 | 1 }) => {
  const expressions: string[] = [];
  const values: Record<string, any> = {
    ':updatedAt': new Date().toISOString(),
  };

  if (updates.isICP !== undefined) {
    expressions.push('isICP = :isICP');
    values[':isICP'] = updates.isICP;
  }
  if (updates.isEngaged !== undefined) {
    expressions.push('isEngaged = :isEngaged');
    values[':isEngaged'] = updates.isEngaged;
  }
  if (expressions.length === 0) {
    return;
  }
  expressions.push('updatedAt = :updatedAt');

  await dynamodb.update({
    TableName: `${TABLE_PREFIX}AW-Leads`,
    Key: { listId, leadId },
    UpdateExpression: `SET ${expressions.join(', ')}`,
    ExpressionAttributeValues: values,
  }).promise();
};

const ensureLeadICPFlags = async (listId: string) => {
  let lastKey: any = undefined;
  do {
    const batch = await crmDb.getLeadsByListId(listId, 200, lastKey);
    const leadsToUpdate = batch.items.filter((lead: any) => {
      const targetValue = lead?.icpMatch?.isMatch === true ? 1 : 0;
      const currentValue = lead?.isICP === undefined || lead?.isICP === null
        ? null
        : Number(lead.isICP);
      return currentValue !== targetValue;
    });
    await Promise.all(
      leadsToUpdate.map((lead: any) =>
        updateLeadFlag(listId, lead.leadId, { isICP: lead?.icpMatch?.isMatch === true ? 1 : 0 })
      )
    );
    lastKey = batch.lastEvaluatedKey;
  } while (lastKey);
};

const ensureLeadEngagedFlags = async (listId: string, userId: string) => {
  const lookup = await buildEngagedLeadLookup(listId, userId);
  let lastKey: any = undefined;
  do {
    const batch = await crmDb.getLeadsByListId(listId, 200, lastKey);
    const leadsToUpdate = batch.items.filter((lead: any) => {
      const targetValue = leadMatchesEngagedLookup(lead, lookup) ? 1 : 0;
      const currentValue = lead?.isEngaged === undefined || lead?.isEngaged === null
        ? null
        : Number(lead.isEngaged);
      return currentValue !== targetValue;
    });
    await Promise.all(
      leadsToUpdate.map((lead: any) =>
        updateLeadFlag(listId, lead.leadId, {
          isEngaged: leadMatchesEngagedLookup(lead, lookup) ? 1 : 0,
        })
      )
    );
    lastKey = batch.lastEvaluatedKey;
  } while (lastKey);
};

const fetchAllLeadsByList = async (listId: string, pageSize: number): Promise<any[]> => {
  let lastKey: any = undefined;
  const items: any[] = [];
  do {
    const result = await crmDb.getLeadsByListId(listId, pageSize, lastKey);
    items.push(...result.items);
    lastKey = result.lastEvaluatedKey;
  } while (lastKey);
  return items;
};

const fetchAllLeadsByFlagIndex = async (
  listId: string,
  flagType: 'icp' | 'engaged',
  pageSize: number
): Promise<any[]> => {
  let lastKey: any = undefined;
  const items: any[] = [];
  try {
    do {
      const result = flagType === 'icp'
        ? await crmDb.getLeadsByICPFlag(listId, 1, pageSize, lastKey)
        : await crmDb.getLeadsByEngagedFlag(listId, 1, pageSize, lastKey);
      items.push(...result.items);
      lastKey = result.lastEvaluatedKey;
    } while (lastKey);
    return items;
  } catch (error: any) {
    console.warn(`Falling back from ${flagType} index for list ${listId}:`, error?.message || error);
    return fetchAllLeadsByList(listId, pageSize);
  }
};

const fetchAllLeadsByStatusIndex = async (
  listId: string,
  status: string,
  pageSize: number
): Promise<any[]> => {
  let lastKey: any = undefined;
  const items: any[] = [];
  try {
    do {
      const result = await crmDb.getLeadsByStatus(listId, status, pageSize, lastKey);
      items.push(...result.items);
      lastKey = result.lastEvaluatedKey;
    } while (lastKey);
    return items;
  } catch (error: any) {
    console.warn(`Falling back from status index for list ${listId}:`, error?.message || error);
    return fetchAllLeadsByList(listId, pageSize);
  }
};

// ──────────────────────────────────────────────────────────────────────────────

// Lead List Routes

/**
 * @route POST /api/crm/sync
 * @desc Unified sync endpoint — the single entry point for all inbound CRM
 *       signals (signup, Stripe, lead_form, emma_session, fathom, manual).
 *       Enforces idempotency, identity resolution, event logging, and score
 *       recompute. See `contactSyncService.ts` for details.
 * @access Private (JWT)
 */
router.post('/sync', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user?.userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const body = req.body as Partial<SyncInput>;

    if (!body || !body.source || !body.sourceRecordId || !body.eventType || !body.identity) {
      return res.status(400).json({
        message:
          'Invalid body. Required: source, sourceRecordId, eventType, identity.',
      });
    }

    // IDOR guard: tenantId is the partition for downstream contact storage.
    // If a client supplies a tenantId that doesn't match their auth identity,
    // they're attempting to write into another tenant's timeline. Reject.
    // If absent, stamp it from the authenticated user (or the delegation
    // target — req.user.userId is already the customer in delegated sessions).
    if (body.tenantId && body.tenantId !== authReq.user.userId) {
      return res.status(403).json({ message: 'tenantId mismatch' });
    }
    body.tenantId = authReq.user.userId;

    const result = await syncContact(body as SyncInput);
    return res.json(result);
  } catch (error: any) {
    console.error('Error in POST /api/crm/sync:', error);
    const msg = typeof error?.message === 'string' ? error.message : 'Sync failed';
    const status = /required|no email|no sourceRecordId/i.test(msg) ? 400 : 500;
    return res.status(status).json({ message: msg });
  }
});

/**
 * @route POST /api/crm/registration-status
 * @desc  Join a batch of emails against AW-Users to learn which ones registered
 *        for an AgentWeb account and which became premium (active/trialing)
 *        users. Powers the internal funnel report's signup/premium attribution
 *        without duplicating user data onto lead records. Read-only.
 * @access Admin only — this queries the platform-wide AW-Users table for
 *         arbitrary emails (an account-enumeration surface). It is an
 *         admin/founder funnel concern, not a per-tenant capability.
 * @body  { emails: string[] }  (1..1000 emails)
 * @returns { statuses: RegistrationStatus[], summary: { total, registered, premium } }
 */
const REGISTRATION_STATUS_MAX_EMAILS = 1000;
router.post('/registration-status', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user?.userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }
    if (!authReq.user?.isAdmin) {
      return res.status(403).json({ message: 'Admin access required' });
    }

    const body = (req.body as { emails?: unknown; includeChatSessionCount?: unknown }) ?? {};
    const emails = body.emails;
    if (!Array.isArray(emails) || emails.length === 0) {
      return res.status(400).json({ message: 'Invalid body. Required: emails (non-empty array of strings).' });
    }
    if (emails.length > REGISTRATION_STATUS_MAX_EMAILS) {
      return res.status(400).json({
        message: `Too many emails. Max ${REGISTRATION_STATUS_MAX_EMAILS} per request.`,
      });
    }

    const includeChatSessionCount = body.includeChatSessionCount === true;
    const statuses = await userDb.getRegistrationStatusByEmails(emails as string[], {
      includeChatSessionCount,
    });
    const summary = {
      total: statuses.length,
      registered: statuses.filter((s) => s.registered).length,
      premium: statuses.filter((s) => s.isPremium).length,
    };

    return res.json({ statuses, summary });
  } catch (error: any) {
    console.error('Error in POST /api/crm/registration-status:', error);
    return res.status(500).json({ message: error?.message || 'Failed to resolve registration status' });
  }
});

// --------------------------------------------------------------------------
// Saved Views (H1) — user-customized filter/sort combos over /crm tabs.
// Built-in presets are returned from code (can't be edited/deleted); user
// views are persisted on the User record via db.ts User.savedViews.
// Pure logic (validation, preset shapes, id gen) lives in utils/savedViews.ts
// and is unit-tested there.
// --------------------------------------------------------------------------

/**
 * @route GET /api/crm/saved-views
 * @desc Return built-in presets + user's saved views.
 * @access Private
 */
router.get('/saved-views', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }
    const user = await userDb.getUserById(userId);
    const userViews: SavedViewUtil[] = Array.isArray(user?.savedViews)
      ? user!.savedViews!.map((v) => ({
          viewId: v.viewId,
          name: v.name,
          scope: v.scope,
          filters: v.filters,
          sort: v.sort,
          isPreset: false,
          createdAt: v.createdAt,
        }))
      : [];
    const presets = buildBuiltInPresets(userId);
    return res.json({ views: [...presets, ...userViews] });
  } catch (error: any) {
    console.error('Error in GET /api/crm/saved-views:', error);
    return res.status(500).json({ message: error?.message || 'Failed to fetch saved views' });
  }
});

/**
 * @route POST /api/crm/saved-views
 * @desc Create a new user-saved view.
 * @access Private
 */
router.post('/saved-views', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsed = validateCreateInput(req.body || {});
    if (!parsed.ok) {
      return res.status(400).json({ message: parsed.error });
    }

    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const newView = {
      viewId: generateViewId(),
      name: parsed.value.name,
      scope: parsed.value.scope as SavedViewScopeUtil,
      filters: parsed.value.filters,
      sort: parsed.value.sort,
      isPreset: false as const,
      createdAt: new Date().toISOString(),
    };

    const existingViews = Array.isArray(user.savedViews) ? user.savedViews : [];
    const nextViews = [...existingViews, newView];
    await userDb.updateUser(userId, { savedViews: nextViews } as any);
    return res.status(201).json(newView);
  } catch (error: any) {
    console.error('Error in POST /api/crm/saved-views:', error);
    return res.status(500).json({ message: error?.message || 'Failed to create saved view' });
  }
});

/**
 * @route PUT /api/crm/saved-views/:viewId
 * @desc Update a user-saved view. Presets are immutable (returns 400).
 * @access Private
 */
router.put('/saved-views/:viewId', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }
    const { viewId } = req.params;
    if (isPresetViewId(viewId)) {
      return res.status(400).json({ message: 'Built-in presets cannot be modified' });
    }

    const { name, scope, filters, sort } = req.body || {};
    if (scope !== undefined && !VALID_SCOPES.includes(scope)) {
      return res.status(400).json({ message: `scope must be one of ${VALID_SCOPES.join(', ')}` });
    }

    const user = await userDb.getUserById(userId);
    const existingViews = Array.isArray(user?.savedViews) ? user!.savedViews! : [];
    const idx = existingViews.findIndex((v) => v.viewId === viewId);
    if (idx === -1) {
      return res.status(404).json({ message: 'View not found' });
    }
    const updated = {
      ...existingViews[idx],
      ...(name !== undefined ? { name: String(name).trim() } : {}),
      ...(scope !== undefined ? { scope } : {}),
      ...(filters !== undefined ? { filters } : {}),
      ...(sort !== undefined ? { sort } : {}),
    };
    const nextViews = [...existingViews];
    nextViews[idx] = updated;
    await userDb.updateUser(userId, { savedViews: nextViews } as any);
    return res.json(updated);
  } catch (error: any) {
    console.error('Error in PUT /api/crm/saved-views/:viewId:', error);
    return res.status(500).json({ message: error?.message || 'Failed to update saved view' });
  }
});

/**
 * @route DELETE /api/crm/saved-views/:viewId
 * @desc Delete a user-saved view. Presets are immutable (returns 400).
 * @access Private
 */
router.delete('/saved-views/:viewId', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }
    const { viewId } = req.params;
    if (isPresetViewId(viewId)) {
      return res.status(400).json({ message: 'Built-in presets cannot be deleted' });
    }
    const user = await userDb.getUserById(userId);
    const existingViews = Array.isArray(user?.savedViews) ? user!.savedViews! : [];
    const idx = existingViews.findIndex((v) => v.viewId === viewId);
    if (idx === -1) {
      return res.status(404).json({ message: 'View not found' });
    }
    const nextViews = existingViews.filter((v) => v.viewId !== viewId);
    await userDb.updateUser(userId, { savedViews: nextViews } as any);
    return res.json({ success: true, viewId });
  } catch (error: any) {
    console.error('Error in DELETE /api/crm/saved-views/:viewId:', error);
    return res.status(500).json({ message: error?.message || 'Failed to delete saved view' });
  }
});

/**
 * @route GET /api/crm/leads/:leadId/enrichment
 * @desc Internal enrichment endpoint (D1) — joins AW-Users + Stripe for a
 *       single Contact at read time. Caches per-email for 1h.
 *       Requires ?listId=<id> because AW-Leads composite key is (listId, leadId).
 * @access Private (owner only)
 */
router.get('/leads/:leadId/enrichment', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { leadId } = req.params;
    const listId = typeof req.query.listId === 'string' ? req.query.listId : '';
    if (!listId) {
      return res.status(400).json({ message: 'listId query parameter is required' });
    }

    const list = await crmDb.getLeadListById(listId);
    if (!list) {
      return res.status(404).json({ message: 'Lead list not found' });
    }
    if (!(await canAccessCrmList(userId, list))) {
      return res.status(403).json({ message: CRM_SHARING_DISABLED_MESSAGE });
    }

    const lead = await crmDb.getLeadById(listId, leadId);
    if (!lead) {
      return res.status(404).json({ message: 'Lead not found' });
    }

    const email = lead.email ? String(lead.email).toLowerCase().trim() : '';
    if (!email) {
      return res.json({
        isUser: false,
        signupDate: null,
        subscriptionType: null,
        stripeStatus: null,
        mrr: 0,
        currentPeriodEnd: null,
        stripeCustomerId: null,
      });
    }

    const deps: EnrichmentDeps = {
      getUserByEmail: async (e: string) => {
        const u = await userDb.getUserByEmail(e);
        return u ? (u as any) : null;
      },
      getStripeSubscriptionForCustomer: async (customerId: string) => {
        try {
          if (!d1StripeClient) return null;
          const subs = await d1StripeClient.subscriptions.list({
            customer: customerId,
            status: 'all',
            limit: 10,
          });
          if (!subs.data || subs.data.length === 0) return null;
          const statusPriority: Record<string, number> = {
            active: 0, trialing: 1, past_due: 2, canceled: 3,
          };
          const sorted = [...subs.data].sort(
            (a: any, b: any) =>
              (statusPriority[a.status] ?? 99) - (statusPriority[b.status] ?? 99)
          );
          const sub: any = sorted[0];
          const priceId = sub.items?.data?.[0]?.price?.id;
          const price = sub.items?.data?.[0]?.price;
          const mrrCents = price?.unit_amount
            ? (price.recurring?.interval === 'year'
                ? Math.round(price.unit_amount / 12)
                : price.unit_amount)
            : 0;
          const cpe = (sub as any).current_period_end;
          const currentPeriodEnd = cpe
            ? new Date(typeof cpe === 'number' ? cpe * 1000 : cpe).toISOString()
            : null;
          return {
            id: sub.id,
            status: sub.status,
            currentPeriodEnd,
            mrrCents,
            priceId,
          };
        } catch (err) {
          console.warn('[enrichment] Stripe list failed:', (err as any)?.message);
          return null;
        }
      },
    };

    const result = await enrichContact(email, deps, defaultEnrichmentCache);
    return res.json(result);
  } catch (error: any) {
    console.error('Error in GET /api/crm/leads/:leadId/enrichment:', error);
    return res.status(500).json({ message: error.message || 'Enrichment failed' });
  }
});

/**
 * @route GET /api/crm/org-members
 * @desc Return org members for the current user's org (for account owner dropdown)
 * @access Private
 */
router.get('/org-members', async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthenticatedRequest).user?.userId;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const user = await userDb.getUserById(userId);
    if (!user) return res.status(401).json({ message: 'Unauthorized' });

    if (!user.orgId) {
      // No org — return just the current user as the only member
      return res.json({
        success: true,
        members: [{ userId: user.userId, email: user.email, displayName: user.displayName ?? null }],
      });
    }

    const members = await orgDb.getOrgMembers(user.orgId);
    const safeMembers = members.map((m) => ({
      userId: m.userId,
      email: m.email,
      displayName: m.displayName ?? null,
    }));

    return res.json({ success: true, members: safeMembers });
  } catch (err) {
    console.error('[CRM] GET /org-members error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

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

    const ownLists = await crmDb.getLeadListsByUserId(userId);

    // Also include org members' lists — gated on shareSettings.crm.enabled
    // (ENG-686 follow-up: this route pre-dated the org-share model and
    // unconditionally merged in every member's lists regardless of the
    // toggle; found via live QA).
    const memberIds = await getReadableOrgMemberIds(userId);
    if (memberIds.length > 0) {
      const memberListArrays = await Promise.all(
        memberIds.map((id) => crmDb.getLeadListsByUserId(id))
      );
      const memberLists = memberListArrays.flat().filter(Boolean).map((l) => ({ ...l, fromOrgMember: true }));
      return res.json([...(ownLists || []), ...memberLists]);
    }

    res.json(ownLists);
  } catch (error: any) {
    console.error('Error fetching lead lists:', error);
    res.status(500).json({ message: error.message || 'Failed to fetch lead lists' });
  }
});

/**
 * @route GET /api/crm/contacts
 * @desc Return all of the user's leads deduped by lowercased email.
 *       Powers the /crm Inbox tab — replaces client-side per-list fetch+dedup
 *       which was 30-90s on 5000+ lead accounts.
 * @access Private
 * @query listType? "sales" | "customers" — restrict to a list type (default: all)
 * @query listIds? comma-separated listIds to restrict to a subset
 * @query limit? max deduped rows to return (default: all)
 * @query sort? "heat" | "recent" (default: heat)
 */
router.get('/contacts', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { listType, listIds, limit, sort, cursor } = req.query as Record<string, string | undefined>;

    if (listType !== undefined && listType !== 'sales' && listType !== 'customers') {
      return res.status(400).json({ message: 'listType must be "sales" or "customers"' });
    }

    if (sort !== undefined && sort !== 'heat' && sort !== 'recent') {
      return res.status(400).json({ message: 'sort must be "heat" or "recent"' });
    }

    let parsedLimit: number | undefined;
    if (limit !== undefined) {
      const n = Number(limit);
      if (!Number.isFinite(n) || n < 1 || n > 10000) {
        return res.status(400).json({ message: 'limit must be a number between 1 and 10000' });
      }
      parsedLimit = Math.floor(n);
    }

    if (cursor !== undefined) {
      try {
        const parsed = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8'));
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error();
      } catch {
        return res.status(400).json({ message: 'Invalid cursor' });
      }
    }

    const parsedListIds = listIds
      ? listIds.split(',').map((s) => s.trim()).filter(Boolean)
      : undefined;

    // Collect userIds to dedup across: own + readable org members — gated on
    // shareSettings.crm.enabled (ENG-686 follow-up: this route pre-dated the
    // org-share model and unconditionally merged in every member's contacts
    // regardless of the toggle; found via live QA).
    const userIdsToDedup: string[] = [userId];
    {
      const memberIds = await getReadableOrgMemberIds(userId);
      userIdsToDedup.push(...memberIds);
    }

    const started = Date.now();
    const perUserResults = await Promise.all(
      userIdsToDedup.map((uid) =>
        dedupContactsForUser({
          userId: uid,
          listType: listType as 'sales' | 'customers' | undefined,
          listIds: uid === userId ? parsedListIds : undefined,
          limit: parsedLimit,
          sort: sort as 'heat' | 'recent' | undefined,
          cursor: uid === userId ? cursor : undefined,
          rawFetchLimit: 5000,
        })
      )
    );

    // Merge deduped contacts across users, re-dedup by email
    const contactMap = new Map<string, any>();
    let rawCount = 0;
    let listsCount = 0;
    for (const r of perUserResults) {
      rawCount += r.rawCount;
      listsCount += r.listsCount;
      for (const c of r.contacts) {
        const key = c.email?.toLowerCase() ?? '';
        if (!contactMap.has(key)) contactMap.set(key, c);
      }
    }

    let contacts = Array.from(contactMap.values());
    // Re-sort
    if (!sort || sort === 'heat') {
      contacts.sort((a, b) => (b.heatScore ?? 0) - (a.heatScore ?? 0) || new Date(b.lastContactAt ?? 0).getTime() - new Date(a.lastContactAt ?? 0).getTime());
    } else {
      contacts.sort((a, b) => new Date(b.lastContactAt ?? 0).getTime() - new Date(a.lastContactAt ?? 0).getTime());
    }
    const total = contacts.length;
    if (parsedLimit !== undefined) contacts = contacts.slice(0, parsedLimit);

    const result = { contacts, total, rawCount, listsCount };
    const durationMs = Date.now() - started;
    const primaryResult = perUserResults[0];

    return res.json({
      contacts: result.contacts,
      total: result.total,
      rawCount: result.rawCount,
      listsCount: result.listsCount,
      durationMs,
      ...(primaryResult?.nextCursor !== undefined && { nextCursor: primaryResult.nextCursor }),
      ...(primaryResult?.hasMore !== undefined && { hasMore: primaryResult.hasMore }),
    });
  } catch (error: any) {
    console.error('Error in /api/crm/contacts:', error?.message || error);
    return res.status(500).json({ message: error?.message || 'Failed to load contacts' });
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

    const { name, description, alertEvents, alertCcEmails, listSenderId, autoDraftEnabled, statusConfig, listType } = req.body;

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({ message: 'List name is required' });
    }

    if (listType !== undefined && listType !== 'sales' && listType !== 'customers') {
      return res.status(400).json({ message: 'listType must be "sales" or "customers"' });
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

    if (autoDraftEnabled !== undefined && typeof autoDraftEnabled !== 'boolean') {
      return res.status(400).json({ message: 'autoDraftEnabled must be a boolean' });
    }

    let normalizedCcEmails: string[] | undefined;
    if (alertCcEmails !== undefined) {
      if (!Array.isArray(alertCcEmails)) {
        return res.status(400).json({ message: 'alertCcEmails must be an array' });
      }
      if (alertCcEmails.length > 10) {
        return res.status(400).json({ message: 'alertCcEmails cannot have more than 10 entries' });
      }
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      for (const email of alertCcEmails) {
        if (typeof email !== 'string' || !emailRegex.test(email.trim())) {
          return res.status(400).json({ message: `Invalid email in alertCcEmails: ${email}` });
        }
      }
      normalizedCcEmails = alertCcEmails.map((e: string) => e.trim().toLowerCase());
    }

    const list = await crmDb.createLeadList(
      userId,
      name.trim(),
      description?.trim(),
      normalizedAlertEvents,
      normalizedListSenderId,
      autoDraftEnabled === true,
      undefined, // autoDraftInstruction
      undefined, // autoSendEnabled
      statusConfig,
      listType
    );

    if (normalizedCcEmails && normalizedCcEmails.length > 0) {
      await crmDb.updateLeadList(list.listId, { alertCcEmails: normalizedCcEmails });
      (list as any).alertCcEmails = normalizedCcEmails;
    }

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
    if (!(await canAccessCrmList(userId, list))) {
      return res.status(403).json({ message: CRM_SHARING_DISABLED_MESSAGE });
    }

    res.json(list);
  } catch (error: any) {
    console.error('Error fetching lead list:', error);
    res.status(500).json({ message: error.message || 'Failed to fetch lead list' });
  }
});

/**
 * @route GET /api/crm/lists/:listId/metrics
 * @desc Get aggregate email metrics (sent, delivered, opened, clicked, bounced, unsubscribed + rates)
 *       for all leads in the list. Computed on demand by joining lead emails with AW-EmailEvents.
 * @access Private
 */
router.get('/lists/:listId/metrics', async (req: Request, res: Response) => {
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

    if (!(await canAccessCrmList(userId, list))) {
      return res.status(403).json({ message: CRM_SHARING_DISABLED_MESSAGE });
    }

    // Resolve the owner userId (org member lists use list.userId, not authReq.user.userId)
    const ownerId = list.userId ?? userId;
    const owner = await userDb.getUserById(ownerId);
    const emailDomain = owner?.emailDomain;

    if (!emailDomain) {
      return res.json({ sent: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0, unsubscribed: 0, openRate: null, clickRate: null, bounceRate: null });
    }

    // Collect all lead emails in this list (paginate through all pages)
    const leadEmails = new Set<string>();
    let lastKey: any = undefined;
    do {
      const batch = await crmDb.getLeadsByListId(listId, 200, lastKey);
      for (const lead of batch.items as any[]) {
        if (lead.email) leadEmails.add(lead.email.toLowerCase());
      }
      lastKey = batch.lastEvaluatedKey;
    } while (lastKey);

    if (leadEmails.size === 0) {
      return res.json({ sent: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0, unsubscribed: 0, openRate: null, clickRate: null, bounceRate: null });
    }

    // Fetch all email events for this domain, then filter to leads in this list
    const allEvents = await emailEventsDb.getEventsByEmailDomain(emailDomain);
    const listEvents = allEvents.filter(e => e.leadEmail && leadEmails.has(e.leadEmail.toLowerCase()));

    // Unique-recipient sets per event type (avoid double-counting multiple opens/clicks)
    const deliveredRecipients = new Set<string>();
    const openedRecipients = new Set<string>();
    const clickedRecipients = new Set<string>();
    let bounced = 0;
    let unsubscribed = 0;

    // Count sent emails per emailId→recipient (each unique emailId+leadEmail pair = 1 sent)
    const sentPairs = new Set<string>();

    // Per-subject breakdown (subject from event.data.subject)
    type SubjectStats = {
      sentPairs: Set<string>;
      deliveredRecipients: Set<string>;
      openedRecipients: Set<string>;
      clickedRecipients: Set<string>;
      bounced: number;
      unsubscribed: number;
    };
    const bySubject = new Map<string, SubjectStats>();

    const getSubjectStats = (subject: string): SubjectStats => {
      if (!bySubject.has(subject)) {
        bySubject.set(subject, {
          sentPairs: new Set(),
          deliveredRecipients: new Set(),
          openedRecipients: new Set(),
          clickedRecipients: new Set(),
          bounced: 0,
          unsubscribed: 0,
        });
      }
      return bySubject.get(subject)!;
    };

    for (const event of listEvents) {
      const recipient = event.leadEmail!.toLowerCase();
      const subject = (event.data as any)?.subject || 'Unknown';
      const ss = getSubjectStats(subject);

      switch (event.eventType) {
        case 'email.delivered':
          deliveredRecipients.add(recipient);
          sentPairs.add(`${event.emailId}|${recipient}`);
          ss.deliveredRecipients.add(recipient);
          ss.sentPairs.add(`${event.emailId}|${recipient}`);
          break;
        case 'email.opened':
          openedRecipients.add(recipient);
          ss.openedRecipients.add(recipient);
          break;
        case 'email.clicked':
          clickedRecipients.add(recipient);
          ss.clickedRecipients.add(recipient);
          break;
        case 'email.bounced':
          bounced++;
          sentPairs.add(`${event.emailId}|${recipient}`);
          ss.bounced++;
          ss.sentPairs.add(`${event.emailId}|${recipient}`);
          break;
        case 'email.unsubscribed':
          unsubscribed++;
          ss.unsubscribed++;
          break;
      }
    }

    const sent = sentPairs.size;
    const delivered = deliveredRecipients.size;
    const opened = openedRecipients.size;
    const clicked = clickedRecipients.size;

    const openRate = delivered > 0 ? Math.round((opened / delivered) * 1000) / 10 : null;
    const clickRate = delivered > 0 ? Math.round((clicked / delivered) * 1000) / 10 : null;
    const bounceRate = sent > 0 ? Math.round((bounced / sent) * 1000) / 10 : null;

    // Build per-subject metrics array sorted by sent desc
    const subjects = Array.from(bySubject.entries()).map(([subject, ss]) => {
      const sSent = ss.sentPairs.size;
      const sDelivered = ss.deliveredRecipients.size;
      const sOpened = ss.openedRecipients.size;
      const sClicked = ss.clickedRecipients.size;
      return {
        subject,
        sent: sSent,
        delivered: sDelivered,
        opened: sOpened,
        clicked: sClicked,
        bounced: ss.bounced,
        unsubscribed: ss.unsubscribed,
        openRate: sDelivered > 0 ? Math.round((sOpened / sDelivered) * 1000) / 10 : null,
        clickRate: sDelivered > 0 ? Math.round((sClicked / sDelivered) * 1000) / 10 : null,
        bounceRate: sSent > 0 ? Math.round((ss.bounced / sSent) * 1000) / 10 : null,
      };
    }).sort((a, b) => b.sent - a.sent);

    return res.json({ sent, delivered, opened, clicked, bounced, unsubscribed, openRate, clickRate, bounceRate, subjects });
  } catch (error: any) {
    console.error('Error fetching list email metrics:', error);
    res.status(500).json({ message: error.message || 'Failed to fetch list metrics' });
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
    const { name, description, displayFields, sortConfig, alertEvents, alertCcEmails, listSenderId, linkedInAccountId, icpsOnly, engagedOnly, autoDraftEnabled, statusConfig, listType } = req.body;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    // Verify ownership
    const list = await crmDb.getLeadListById(listId);
    if (!list) {
      return res.status(404).json({ message: 'Lead list not found' });
    }

    if (!(await canDestructiveCrmList(userId, list))) {
      return res.status(403).json({ message: CRM_EDITOR_REQUIRED_MESSAGE });
    }

    const updates: {
      name?: string;
      description?: string;
      displayFields?: string[];
      sortConfig?: { column: string; direction: 'asc' | 'desc' } | null;
      alertEvents?: string[];
      alertCcEmails?: string[];
      listSenderId?: string | null;
      linkedInAccountId?: string | null;
      autoDraftEnabled?: boolean;
      icpsOnly?: boolean;
      engagedOnly?: boolean;
      statusConfig?: Array<{ value: string; label: string; color: string; type: 'active' | 'won' | 'lost' | 'churned' }>;
      listType?: 'sales' | 'customers';
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

    if (alertCcEmails !== undefined) {
      if (!Array.isArray(alertCcEmails)) {
        return res.status(400).json({ message: 'alertCcEmails must be an array' });
      }
      if (alertCcEmails.length > 10) {
        return res.status(400).json({ message: 'alertCcEmails cannot have more than 10 entries' });
      }
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      for (const email of alertCcEmails) {
        if (typeof email !== 'string' || !emailRegex.test(email.trim())) {
          return res.status(400).json({ message: `Invalid email in alertCcEmails: ${email}` });
        }
      }
      updates.alertCcEmails = alertCcEmails.map((e: string) => e.trim().toLowerCase());
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

    if (linkedInAccountId !== undefined) {
      if (linkedInAccountId !== null && typeof linkedInAccountId !== 'string') {
        return res.status(400).json({ message: 'linkedInAccountId must be a string or null' });
      }
      if (linkedInAccountId) {
        const { getAccountsByUserId } = await import('../services/connectedAccountsDb');
        const accounts = await getAccountsByUserId(userId);
        const ownedIds = accounts
          .filter((a: any) => a.platform === 'unipile')
          .map((a: any) => a.config?.unipile_account_id || a.account_id)
          .filter(Boolean);
        if (!ownedIds.includes(linkedInAccountId)) {
          return res.status(400).json({ message: 'linkedInAccountId must reference one of your connected LinkedIn accounts' });
        }
      }
      updates.linkedInAccountId = linkedInAccountId;
    }

    if (icpsOnly !== undefined) {
      if (typeof icpsOnly !== 'boolean') {
        return res.status(400).json({ message: 'icpsOnly must be a boolean' });
      }
      if (icpsOnly === true && list.icpsOnly !== true) {
        await ensureLeadICPFlags(listId);
      }
      updates.icpsOnly = icpsOnly;
    }

    if (engagedOnly !== undefined) {
      if (typeof engagedOnly !== 'boolean') {
        return res.status(400).json({ message: 'engagedOnly must be a boolean' });
      }
      if (engagedOnly === true && list.engagedOnly !== true) {
        await ensureLeadEngagedFlags(listId, userId);
      }
      updates.engagedOnly = engagedOnly;
    }

    if (autoDraftEnabled !== undefined) {
      if (typeof autoDraftEnabled !== 'boolean') {
        return res.status(400).json({ message: 'autoDraftEnabled must be a boolean' });
      }
      updates.autoDraftEnabled = autoDraftEnabled;
    }

    if (statusConfig !== undefined) {
      if (!Array.isArray(statusConfig)) {
        return res.status(400).json({ message: 'statusConfig must be an array' });
      }
      for (const entry of statusConfig) {
        if (!entry.value || !entry.label || !entry.color || !entry.type) {
          return res.status(400).json({ message: 'Each statusConfig entry must have value, label, color, and type' });
        }
        if (!['active', 'won', 'lost', 'churned'].includes(entry.type)) {
          return res.status(400).json({ message: 'statusConfig type must be one of: active, won, lost, churned' });
        }
      }
      updates.statusConfig = statusConfig;
    }

    if (listType !== undefined) {
      if (listType !== 'sales' && listType !== 'customers') {
        return res.status(400).json({ message: 'listType must be "sales" or "customers"' });
      }
      if (list.listType) {
        return res.status(400).json({ message: 'listType is already set and cannot be changed' });
      }
      updates.listType = listType;
    }

    const updatedList = await crmDb.updateLeadList(listId, updates);
    res.json(updatedList);
  } catch (error: any) {
    console.error('Error updating lead list:', error);
    res.status(500).json({ message: error.message || 'Failed to update lead list' });
  }
});

/**
 * @route GET /api/crm/lists/:listId/enrichment-config
 * @desc Read the v3.1 enrichment config for a list. Returns the stored config
 *       or a default built from the list's field schema (with isDefault: true).
 * @access Private
 */
router.get('/lists/:listId/enrichment-config', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const { listId } = req.params;
    const list = await crmDb.getLeadListById(listId);
    if (!list) return res.status(404).json({ message: 'Lead list not found' });
    if (!(await canAccessCrmList(userId, list))) {
      return res.status(403).json({ message: CRM_SHARING_DISABLED_MESSAGE });
    }

    const result = await svcGetEnrichmentConfig({ listId, userId }, enrichmentConfigDeps);
    return res.json(result);
  } catch (error) {
    console.error('[crm] GET enrichment-config failed:', error);
    return res.status(500).json({ message: 'Failed to read enrichment config' });
  }
});

/**
 * @route PUT /api/crm/lists/:listId/enrichment-config
 * @desc Save the v3.1 enrichment config for a list. Server stamps
 *       updatedAt / updatedBy regardless of client-provided values.
 * @access Private
 */
router.put('/lists/:listId/enrichment-config', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const { listId } = req.params;
    const list = await crmDb.getLeadListById(listId);
    if (!list) return res.status(404).json({ message: 'Lead list not found' });
    if (!(await canDestructiveCrmList(userId, list))) {
      return res.status(403).json({ message: CRM_EDITOR_REQUIRED_MESSAGE });
    }

    const config = req.body;
    try {
      const { config: saved, warnings } = await svcSetEnrichmentConfig(
        { listId, userId, config },
        enrichmentConfigDeps,
      );
      return res.json({ config: saved, isDefault: false, warnings });
    } catch (validationError: any) {
      if (validationError?.name === 'ConfigValidationError') {
        return res.status(400).json({ message: validationError.message });
      }
      throw validationError;
    }
  } catch (error) {
    console.error('[crm] PUT enrichment-config failed:', error);
    return res.status(500).json({ message: 'Failed to save enrichment config' });
  }
});

/**
 * @route POST /api/crm/lists/:listId/enrichment-config/suggest-types
 * @desc Suggest a field type for each newly-added field. Phase 1 uses a
 *       name-based heuristic; LLM upgrade in Phase 1.5.
 * @access Private
 */
router.post('/lists/:listId/enrichment-config/suggest-types', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const { listId } = req.params;
    const list = await crmDb.getLeadListById(listId);
    if (!list) return res.status(404).json({ message: 'Lead list not found' });
    if (!(await canAccessCrmList(userId, list))) {
      return res.status(403).json({ message: CRM_SHARING_DISABLED_MESSAGE });
    }

    const fields = Array.isArray(req.body?.fields) ? req.body.fields : [];
    const types = await svcSuggestFieldTypes({ fields }, enrichmentConfigDeps);
    return res.json({ types });
  } catch (error) {
    console.error('[crm] POST suggest-types failed:', error);
    return res.status(500).json({ message: 'Failed to suggest field types' });
  }
});

/**
 * @route POST /api/crm/lists/:listId/leads/enrich-v3?mode=preview|enrich
 * @desc Run the v3.1 enrichment waterfall on all leads in the list using the
 *       saved per-list config. Synchronous in Phase 1a — returns the final
 *       run report directly. Phase 1b will switch this to async + Socket.IO
 *       progress for larger lists.
 *
 *       Phase 1a scope: identity resolution + Apollo direct-map + writes work
 *       with real services. Web tier and LLM extraction are stubbed (fields
 *       not covered by Apollo will appear as `missing` in the report).
 * @access Private
 */
router.post('/lists/:listId/leads/enrich-v3', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const { listId } = req.params;
    const list = await crmDb.getLeadListById(listId);
    if (!list) return res.status(404).json({ message: 'Lead list not found' });
    if (!(await canDestructiveCrmList(userId, list))) {
      return res.status(403).json({ message: CRM_EDITOR_REQUIRED_MESSAGE });
    }

    const mode = (req.query.mode === 'preview' ? 'preview' : 'enrich') as 'preview' | 'enrich';

    // Preview accepts a full inline config in body.inlineConfig; enrich uses
    // the persisted per-list config.
    let config: any;
    if (mode === 'preview') {
      if (!req.body?.inlineConfig) {
        return res.status(400).json({ message: 'preview mode requires inlineConfig in request body' });
      }
      config = req.body.inlineConfig;
    } else {
      const stored = await svcGetEnrichmentConfig({ listId, userId }, enrichmentConfigDeps);
      if (stored.isDefault) {
        return res.status(400).json({
          message: 'No enrichment config saved for this list. Open Enrichment Config and save one first.',
        });
      }
      config = stored.config;
    }

    const refreshFields = Array.isArray(req.body?.refreshFields) ? req.body.refreshFields : undefined;
    const leadIds = Array.isArray(req.body?.leadIds)
      ? req.body.leadIds.filter((id: unknown): id is string => typeof id === 'string')
      : undefined;
    const deps = buildV3OrchestratorDeps(userId);
    const socketId = typeof req.body?.socketId === 'string' ? req.body.socketId : undefined;
    console.log(`[v3][route] enrich-v3 POST listId=${listId} userId=${userId} mode=${mode} socketId=${socketId ?? '∅'} leadIds=${leadIds?.length ?? 'all'}`);
    const { buildListContext } = await import('../emma/enrichmentToolRunner');
    const listContext = buildListContext(list);
    const result = await svcRunEnrichmentV3(
      { listId, userId, config, mode, refreshFields, leadIds, listContext },
      deps,
      {
        userId,
        socketId,
        socketEmit: (room, event, payload) => io.to(room).emit(event, payload),
      },
    );
    console.log(`[v3][route] enrich-v3 response listId=${listId} processed=${result.processed} durationMs=${result.durationMs}`);
    return res.json(result);
  } catch (error) {
    console.error('[v3][route] enrich-v3 failed:', error);
    return res.status(500).json({ message: 'Enrichment run failed' });
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

    if (!(await canDestructiveCrmList(userId, list))) {
      return res.status(403).json({ message: CRM_EDITOR_REQUIRED_MESSAGE });
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
 * @query search - Search leads by standard/custom fields (server-side)
 */
router.get('/lists/:listId/leads', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    const { listId } = req.params;
    const page = req.query.page ? parseInt(req.query.page as string, 10) : 1;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const engagedOnlyQuery = req.query.engagedOnly;
    const statusQuery = typeof req.query.status === 'string' ? req.query.status.trim() : '';
    const linkedInConnectedQuery = req.query.linkedInConnected;
    const syncStatusQuery = typeof req.query.syncStatus === 'string' ? req.query.syncStatus.trim() : '';

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    // Verify list ownership
    const list = await crmDb.getLeadListById(listId);
    if (!list) {
      return res.status(404).json({ message: 'Lead list not found' });
    }

    if (!(await canAccessCrmList(userId, list))) {
      return res.status(403).json({ message: CRM_SHARING_DISABLED_MESSAGE });
    }

    // HubSpot connection drives the sync-status filter + per-lead resolution.
    // The syncStatus param is only honored when the list is actually connected.
    const hsConn = getHubspotConnection(list);
    const syncStatusFilter = hsConn.connected ? syncStatusQuery : '';

    // Validate inputs
    const validPage = Math.max(1, page);
    const validLimit = Math.min(Math.max(1, limit), 500); // Between 1 and 500

    let filteredLeads: any[] = [];
    let hasMoreLeads = true;
    let totalFilteredCount: number | null = null;
    let knownTotalPages: number | null = null;

    let effectiveEngagedOnly = list.engagedOnly === true;
    if (engagedOnlyQuery !== undefined) {
      if (engagedOnlyQuery === 'true') {
        effectiveEngagedOnly = true;
      } else if (engagedOnlyQuery === 'false') {
        effectiveEngagedOnly = false;
      } else {
        return res.status(400).json({ message: 'engagedOnly must be "true" or "false"' });
      }
    }

    const linkedInConnectedFilter = linkedInConnectedQuery === 'true';

    if (list.icpsOnly || search || effectiveEngagedOnly || statusQuery || linkedInConnectedFilter || syncStatusFilter) {
      // Filtered mode: use flag indexes when possible, then apply remaining filters in-memory.
      const fetchLimit = Math.max(validLimit, 200);

      let candidateLeads: any[] = [];
      if (list.icpsOnly && effectiveEngagedOnly) {
        candidateLeads = await fetchAllLeadsByFlagIndex(listId, 'engaged', fetchLimit);
      } else if (list.icpsOnly) {
        candidateLeads = await fetchAllLeadsByFlagIndex(listId, 'icp', fetchLimit);
      } else if (effectiveEngagedOnly) {
        candidateLeads = await fetchAllLeadsByFlagIndex(listId, 'engaged', fetchLimit);
      } else if (statusQuery) {
        candidateLeads = await fetchAllLeadsByStatusIndex(listId, statusQuery, fetchLimit);
      } else {
        candidateLeads = await fetchAllLeadsByList(listId, fetchLimit);
      }

      const needsEngagedLookupFallback = effectiveEngagedOnly &&
        candidateLeads.some((lead: any) => lead?.isEngaged === undefined || lead?.isEngaged === null);
      const engagedLookup = needsEngagedLookupFallback
        ? await buildEngagedLeadLookup(listId, userId)
        : null;

      // Build a set of connected LinkedIn URLs if the filter is active
      let connectedLinkedInUrlSet: Set<string> | null = null;
      if (linkedInConnectedFilter) {
        const accountId: string | null = (list as any).linkedInAccountId ?? null;
        if (!accountId) {
          // No account assigned — filter returns nothing
          return res.json({ leads: [], page: validPage, limit: validLimit, totalPages: 0, hasMore: false, totalFilteredCount: 0 });
        }
        const { getAllConnectionsByAccount } = await import('../services/unipileConnectionsDb');
        const connections = await getAllConnectionsByAccount(accountId);
        connectedLinkedInUrlSet = new Set(
          connections.map((c: any) => (c.publicProfileUrl as string || '').trim().toLowerCase().replace(/\/?$/, '/'))
        );
      }

      const allMatchingLeads = candidateLeads.filter((lead: any) => {
        if (list.icpsOnly && !leadMatchesICPFlag(lead)) {
          return false;
        }
        if (effectiveEngagedOnly && !leadMatchesEngagedFlag(lead, engagedLookup)) {
          return false;
        }
        if (search && !leadMatchesSearch(lead, search)) {
          return false;
        }
        if (statusQuery && (lead.status || null) !== statusQuery) {
          return false;
        }
        if (connectedLinkedInUrlSet !== null) {
          if (!lead.linkedin) return false;
          const normalized = (lead.linkedin as string).trim().toLowerCase().replace(/\/?$/, '/');
          if (!connectedLinkedInUrlSet.has(normalized)) return false;
        }
        if (syncStatusFilter && resolveSyncStatus(lead, hsConn.connected) !== syncStatusFilter) {
          return false;
        }
        return true;
      });

      totalFilteredCount = allMatchingLeads.length;
      const targetLeadsToSkip = (validPage - 1) * validLimit;
      const targetLeadsToReturn = validLimit;
      filteredLeads = allMatchingLeads.slice(targetLeadsToSkip, targetLeadsToSkip + targetLeadsToReturn);
      hasMoreLeads = allMatchingLeads.length > targetLeadsToSkip + targetLeadsToReturn;
      knownTotalPages = Math.max(1, Math.ceil(totalFilteredCount / validLimit));

      if (filteredLeads.length === 0 && validPage > 1) {
        return res.json({
          leads: [],
          page: validPage,
          limit: validLimit,
          totalPages: validPage - 1,
          hasMore: false,
          totalFilteredCount,
        });
      }
    } else {
      // No filter, use normal pagination
      let lastEvaluatedKey = undefined;

      // For page > 1, fetch previous pages to get the cursor
      if (validPage > 1) {
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

      // Fetch the current page
      const result = await crmDb.getLeadsByListId(listId, validLimit, lastEvaluatedKey);
      filteredLeads = result.items;
      hasMoreLeads = !!result.lastEvaluatedKey;
    }

    // Add engagement counts to each lead, then strip internal CRM-history
    // audit fields (siblingLeadId/ListId/UserId, remap source) before sending
    // to the customer-portal.
    const leadsWithCounts = await Promise.all(
      filteredLeads.map(async (lead: any) => {
        const engagementCounts = await crmDb.getLeadEngagementCount(listId, lead.leadId, userId);
        return {
          ...sanitizeLeadForResponse({
            ...lead,
            engagementCount: engagementCounts.total,
            engagementCountLast7Days: engagementCounts.last7Days,
            totalAllMessages: engagementCounts.totalAllMessages,
          }),
          syncStatus: resolveSyncStatus(lead, hsConn.connected),
        };
      })
    );

    // Calculate total pages (approximate - we don't know the exact total without scanning all)
    // For now, we'll indicate if there are more pages
    const totalPages = hasMoreLeads ? validPage + 1 : validPage;

    res.json({
      leads: leadsWithCounts,
      page: validPage,
      limit: validLimit,
      totalPages: knownTotalPages ?? (hasMoreLeads ? null : validPage), // null means unknown total
      hasMore: hasMoreLeads,
      totalFilteredCount, // Total ICP count when icpsOnly is enabled, null otherwise
      hubspotConnected: hsConn.connected,
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

    // Attribution — accept the same `attribution` / legacy `utm` shape as the
    // public forward-lead endpoint so the CRM "quick add" flow preserves source
    // data when a rep pastes in a lead they got from a tracked link.
    const attributionTouch =
      normalizeAttribution(leadData?.attribution) ?? normalizeAttribution(leadData?.utm);
    if (attributionTouch) {
      leadData.firstTouch = attributionTouch;
      leadData.lastTouch = attributionTouch;
    }
    // Strip the top-level `attribution` / `utm` envelopes — createLead doesn't
    // know those keys and DynamoDB rejects extra attributes silently.
    delete leadData.attribution;
    delete leadData.utm;

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

    if (!(await canDestructiveCrmList(userId, list))) {
      return res.status(403).json({ message: CRM_EDITOR_REQUIRED_MESSAGE });
    }

    // Stamp an initial per-lead sync status when this list is connected to
    // HubSpot. If auto-sync is on, the subsequent autoSyncLead push overwrites
    // this with 'synced'/'sync_failed' via the adapter.
    const hsConn = getHubspotConnection(list);
    if (hsConn.connected) {
      leadData.syncMetadata = { ...(leadData.syncMetadata || {}), syncStatus: 'sync_pending' };
    }

    const lead = await crmDb.createLead(listId, leadData);

    void Promise.allSettled([
      externalCrmSyncService.autoSyncLead(userId, listId, lead, 'hubspot', 'created'),
      externalCrmSyncService.autoSyncLead(userId, listId, lead, 'attio', 'created'),
      autoEnrollLeadInSequences(userId, listId, (lead as any).leadId, leadData.email ?? ''),
      // Single-lead create always validates the email in background (locked design).
      // Failures are swallowed so a transient enrich.so outage doesn't block creation.
      validateLeadEmailInBackground(listId, (lead as any).leadId, leadData.email ?? '', userId),
    ]);

    res.status(201).json(lead);
  } catch (error: any) {
    console.error('Error creating lead:', error);
    res.status(500).json({ message: error.message || 'Failed to create lead' });
  }
});

/**
 * @route POST /api/crm/lists/:listId/leads/bulk-import
 * @desc Bulk-import leads from an array (e.g. LinkedIn search results via platform-wide outreach accounts).
 *       Maps linkedin_url → linkedin field. Deduplicates against existing list leads via batchCreateLeads.
 * @access Private
 */
router.post('/lists/:listId/leads/bulk-import', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const { listId } = req.params;
    const { leads } = req.body;

    if (!Array.isArray(leads) || leads.length === 0) {
      return res.status(400).json({ message: 'leads must be a non-empty array' });
    }

    const list = await crmDb.getLeadListById(listId);
    if (!list) return res.status(404).json({ message: 'Lead list not found' });
    if (!(await canDestructiveCrmList(userId, list))) return res.status(403).json({ message: CRM_EDITOR_REQUIRED_MESSAGE });

    // Normalize Unipile search result shape → CRM lead shape
    const normalizedLeads = leads.map((lead: any) => {
      const { name, linkedin_url, public_profile_url, profile_url, public_identifier, current_role, headline, ...rest } = lead;
      const normalized: any = { ...rest };

      // Split Unipile full `name` field into firstName/lastName if not already split
      if (name && !normalized.firstName && !normalized.lastName) {
        const parts = (name as string).trim().split(/\s+/);
        normalized.firstName = parts[0] || '';
        normalized.lastName = parts.slice(1).join(' ') || '';
      }

      // Build clean LinkedIn URL — prefer slug over messy profile_url with query params
      if (!normalized.linkedin) {
        if (public_identifier) {
          normalized.linkedin = `https://www.linkedin.com/in/${public_identifier}`;
        } else {
          const rawUrl = linkedin_url || public_profile_url || profile_url;
          if (rawUrl) normalized.linkedin = (rawUrl as string).split('?')[0];
        }
      }

      // Map headline → title
      if (headline && !normalized.title) normalized.title = headline;
      // Flatten current_role
      if (current_role) {
        if (current_role.position && !normalized.title) normalized.title = current_role.position;
        if (current_role.company && !normalized.company) normalized.company = current_role.company;
      }
      return normalized;
    });

    const result = await crmDb.batchCreateLeads(listId, normalizedLeads);

    // Auto-enroll new leads into any sequences watching this list (fire-and-forget)
    if (result.newCount > 0) {
      void autoEnrollListIntoSequences(userId, listId);
    }

    res.status(201).json({
      imported: result.newCount,
      skipped: result.mergedCount,
      errors: result.errors,
      total: leads.length,
    });
  } catch (error: any) {
    console.error('Error bulk importing leads:', error);
    res.status(500).json({ message: error.message || 'Failed to bulk import leads' });
  }
});

/**
 * Normalize the `limit` query/body parameter for the find-leads routes.
 * Guards against NaN, non-finite, non-positive, or non-numeric inputs and
 * caps to 500. Floors fractional values. Returns the default (20) when the
 * input is missing or invalid.
 */
function normalizeFindLeadsLimit(raw: any): number {
  if (raw === undefined || raw === null) return 20;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 20;
  return Math.min(Math.floor(n), 500);
}

/**
 * @route POST /api/crm/lists/:listId/leads/find
 * @desc Search LinkedIn for people using platform-wide outreach accounts and import results into the list.
 * @access Private
 */
router.post('/lists/:listId/leads/find', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const { listId } = req.params;
    const {
      keywords,
      title,
      company,
      search_url,
      location,
      location_id,
      industry,
      industry_id,
      school,
      school_id,
      cursor,
      auto_enrich,
      limit,
    } = req.body;

    // Cursor alone is a valid filter for pagination through a prior search.
    // Same gate as importLeadsFromSearch — see agentModeService.ts.
    if (!keywords && !title && !company && !search_url
      && !location && !industry && !school && !cursor) {
      return res.status(400).json({ message: 'At least one search filter is required: keywords, title, company, search_url, location, industry, school, or cursor' });
    }

    const list = await crmDb.getLeadListById(listId);
    if (!list) return res.status(404).json({ message: 'Lead list not found' });
    if (!(await canDestructiveCrmList(userId, list))) return res.status(403).json({ message: CRM_EDITOR_REQUIRED_MESSAGE });

    const { agentModeService } = await import('../services/agentModeService');
    const result = await agentModeService.importLeadsFromSearch(userId, {
      listId,
      keywords,
      title,
      company,
      search_url,
      location,
      location_id,
      industry,
      industry_id,
      school,
      school_id,
      cursor,
      auto_enrich,
      // Cap at 500 (was 100) to support larger ICP-sourcing runs.
      limit: normalizeFindLeadsLimit(limit),
    });

    if (!result.success) {
      return res.status(400).json({ message: result.error });
    }

    res.status(201).json(result);
  } catch (error: any) {
    console.error('Error finding leads:', error);
    res.status(500).json({ message: error.message || 'Failed to find leads' });
  }
});

/**
 * @route GET /api/crm/icp/filters
 * @desc Preview LLM-extracted LinkedIn search filter VARIANTS for one of
 *       the user's ICP personas (icpResult[]). Returns 1–3 candidate
 *       filter sets — does NOT run a search or import. The frontend uses
 *       this to pre-fill the Find Leads modal; when multiple variants
 *       come back, the modal renders a chip picker so the user chooses
 *       an angle (broad vs. region-focused, etc.) before clicking Find
 *       & Import.
 *
 *       Results are cached per persona on `user.icpResult[i].extractedFilters`
 *       keyed by a hash of the persona content + a code-bumped version.
 *       Cache hits skip the LLM entirely; cache misses regenerate and
 *       persist via userDb.updateUser.
 * @access Private
 */
router.get('/icp/filters', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const raw = req.query?.icpIndex;
    const icpIndex = typeof raw === 'string' ? Number(raw) : NaN;
    if (!Number.isFinite(icpIndex) || !Number.isInteger(icpIndex) || icpIndex < 0) {
      return res.status(400).json({ message: 'icpIndex (non-negative integer) is required' });
    }

    const { userDb, orgDb } = await import('../services/db');
    const user: any = await userDb.getUserById(userId);

    // Resolve the persona list. Three stores hold ICP data and a user may
    // have ICPs in only one of them:
    //   1. user.icpResult — personas generated during onboarding / mirrored
    //      from Emma's brand build. Carries the extractedFilters cache.
    //   2. marketStrategy.icp — personas authored on the /market-strategy
    //      page or by Emma's update_market_strategy tool. For org members
    //      this lives on the ORG (see routes/marketStrategy.ts: "If user is
    //      in an org, always read market strategy from the org"), so an org
    //      owner can have 5 ICPs the user record never sees.
    // Prefer icpResult (it has the cache); otherwise fall back to the
    // marketStrategy.icp store, converting to the icpResult shape with the
    // same mapping Emma's brand-build mirror uses.
    let personas: any[] = Array.isArray(user?.icpResult) ? user.icpResult : [];
    let fromMarketStrategy = false;
    if (personas.length === 0) {
      let marketStrategy: any = user?.marketStrategy;
      if (user?.orgId) {
        const org: any = await orgDb.getOrgById(user.orgId);
        if (org) marketStrategy = org.marketStrategy;
      }
      const marketIcp = Array.isArray(marketStrategy?.icp) ? marketStrategy.icp : [];
      if (marketIcp.length > 0) {
        const { mapMarketIcpToResult } = await import('../services/onboardingBrandBuildService');
        personas = mapMarketIcpToResult(marketIcp);
        fromMarketStrategy = personas.length > 0;
      }
    }

    if (personas.length === 0) {
      return res.status(404).json({ message: 'No ICP personas found. Define your Ideal Customer Profiles in Market Strategy first.' });
    }
    if (icpIndex >= personas.length) {
      return res.status(404).json({ message: `icpIndex ${icpIndex} out of range (have ${personas.length} personas)` });
    }

    const persona = personas[icpIndex];
    const {
      extractIcpFiltersWithLlm,
      personaCacheKey,
      ICP_FILTER_CACHE_VERSION,
    } = await import('../services/icpFilterLlmExtractor');

    const currentKey = personaCacheKey(persona);
    const cached = persona.extractedFilters;
    const cacheHit =
      cached &&
      cached.cacheKey === currentKey &&
      cached.cacheVersion === ICP_FILTER_CACHE_VERSION &&
      Array.isArray(cached.variants) &&
      cached.variants.length > 0;

    if (cacheHit) {
      return res.status(200).json({
        persona: { name: persona.name, index: icpIndex },
        variants: cached.variants,
        cached: true,
      });
    }

    let variants;
    try {
      // userId is passed for shadow usage-metering attribution only.
      variants = await extractIcpFiltersWithLlm(persona, { userId });
    } catch (llmError: any) {
      console.error('Error extracting ICP filters via LLM:', llmError);
      return res.status(503).json({
        message: 'Failed to extract filters with the LLM, please try again.',
      });
    }

    // Persist the extracted filters as a cache — but ONLY for personas that
    // came from user.icpResult. We deliberately do NOT write back when the
    // personas were derived from marketStrategy.icp: materializing them onto
    // user.icpResult would make the user record take precedence over the
    // (possibly org-level) marketStrategy on the next click, so later edits
    // to the org's ICPs would be masked by a stale user-level snapshot. The
    // marketStrategy store stays the source of truth; we just re-run the LLM
    // on each click there (rare, explicit, ~3s).
    if (!fromMarketStrategy) {
      // Re-read user before persisting so we don't clobber concurrent edits
      // made during the ~3s LLM window (e.g., onboarding regenerating
      // personas). Mirrors the pattern in onboardingIcpService.ts: read →
      // long-running work → re-read → write.
      //
      // If the persona at icpIndex is gone, or its content changed (hash
      // mismatch), the LLM result we just produced no longer matches what
      // the user has now — skip the write so the next click can regenerate
      // against the current content. We still return the variants to the
      // caller for the current request.
      const freshUser: any = await userDb.getUserById(userId);
      const freshPersonas: any[] = Array.isArray(freshUser?.icpResult) ? freshUser.icpResult : [];
      const freshPersona = freshPersonas[icpIndex];
      const cacheStillApplies =
        freshPersona && personaCacheKey(freshPersona) === currentKey;

      if (cacheStillApplies) {
        const nextIcpResult = freshPersonas.map((p: any, i: number) =>
          i === icpIndex
            ? {
                ...p,
                extractedFilters: {
                  cacheKey: currentKey,
                  cacheVersion: ICP_FILTER_CACHE_VERSION,
                  variants,
                  generatedAt: new Date().toISOString(),
                },
              }
            : p,
        );
        await userDb.updateUser(userId, { icpResult: nextIcpResult } as any);
      }
    }

    return res.status(200).json({
      persona: { name: persona.name, index: icpIndex },
      variants,
      cached: false,
    });
  } catch (error: any) {
    console.error('Error previewing ICP filters:', error);
    res.status(500).json({ message: error.message || 'Failed to preview ICP filters' });
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

    if (!(await canAccessCrmList(userId, list))) {
      return res.status(403).json({ message: CRM_SHARING_DISABLED_MESSAGE });
    }

    const lead = await crmDb.getLeadById(listId, leadId);
    if (!lead) {
      return res.status(404).json({ message: 'Lead not found' });
    }

    res.json(sanitizeLeadForResponse(lead));
  } catch (error: any) {
    console.error('Error fetching lead:', error);
    res.status(500).json({ message: error.message || 'Failed to fetch lead' });
  }
});

/**
 * @route PUT /api/crm/lists/:listId/leads/bulk-contact-status
 * @desc Bulk update contact status for multiple leads
 * @access Private
 * NOTE: Must be registered BEFORE the :leadId route to avoid Express treating
 * "bulk-contact-status" as a leadId parameter.
 */
router.put('/lists/:listId/leads/bulk-contact-status', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    const { listId } = req.params;
    const { leadIds, contactStatus, contactStatusReason, contactStatusNote } = req.body;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    if (!Array.isArray(leadIds) || leadIds.length === 0) {
      return res.status(400).json({ message: 'leadIds array is required and must not be empty' });
    }

    const validStatuses = ['active', 'do-not-contact', 'unsubscribed'];
    if (!contactStatus || !validStatuses.includes(contactStatus)) {
      return res.status(400).json({ message: `contactStatus must be one of: ${validStatuses.join(', ')}` });
    }

    const validReasons = ['opted-out', 'bounced', 'requested-removal', 'admin-flagged', 'compliance', 'other'];
    if (contactStatusReason && !validReasons.includes(contactStatusReason)) {
      return res.status(400).json({ message: `contactStatusReason must be one of: ${validReasons.join(', ')}` });
    }

    // Verify list ownership
    const list = await crmDb.getLeadListById(listId);
    if (!list) {
      return res.status(404).json({ message: 'Lead list not found' });
    }
    if (!(await canDestructiveCrmList(userId, list))) {
      return res.status(403).json({ message: CRM_EDITOR_REQUIRED_MESSAGE });
    }

    let updated = 0;
    let failed = 0;
    const now = new Date().toISOString();

    for (const leadId of leadIds) {
      try {
        const updates: any = {
          contactStatus,
          contactStatusUpdatedAt: now,
          contactStatusUpdatedBy: userId,
        };
        if (contactStatusReason) {
          updates.contactStatusReason = contactStatusReason;
        }
        if (contactStatusNote) {
          updates.contactStatusNote = contactStatusNote;
        }
        // When setting to active, also clear legacy unsubscribe flag
        if (contactStatus === 'active') {
          updates.unsubscribedFromGroupEmail = false;
          updates.contactStatusReason = null;
          updates.contactStatusNote = null;
        }
        // When setting to unsubscribed/dnc, also set legacy flag for backward compat
        if (contactStatus === 'do-not-contact' || contactStatus === 'unsubscribed') {
          updates.unsubscribedFromGroupEmail = true;
          updates.unsubscribedFromGroupEmailAt = now;
        }
        await crmDb.updateLead(listId, leadId, updates);
        updated++;
      } catch (err) {
        console.error(`Failed to update contact status for lead ${leadId}:`, err);
        failed++;
      }
    }

    return res.json({ updated, failed, total: leadIds.length });
  } catch (error: any) {
    console.error('Error bulk updating contact status:', error);
    return res.status(500).json({ message: error.message || 'Failed to bulk update contact status' });
  }
});

/**
 * @route DELETE /api/crm/lists/:listId/leads/bulk-delete
 * @desc Bulk delete multiple leads from a list
 * @access Private
 * NOTE: Must be registered BEFORE the :leadId route to avoid Express treating
 * "bulk-delete" as a leadId parameter.
 */
router.delete('/lists/:listId/leads/bulk-delete', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    const { listId } = req.params;
    const { leadIds } = req.body;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    if (!Array.isArray(leadIds) || leadIds.length === 0) {
      return res.status(400).json({ message: 'leadIds array is required and must not be empty' });
    }

    // Verify list ownership
    const list = await crmDb.getLeadListById(listId);
    if (!list) {
      return res.status(404).json({ message: 'Lead list not found' });
    }
    if (!(await canDestructiveCrmList(userId, list))) {
      return res.status(403).json({ message: CRM_EDITOR_REQUIRED_MESSAGE });
    }

    let deleted = 0;
    let failed = 0;

    for (const leadId of leadIds) {
      try {
        await crmDb.deleteLead(listId, leadId);
        deleted++;
      } catch (err) {
        console.error(`Failed to delete lead ${leadId}:`, err);
        failed++;
      }
    }

    return res.json({ deleted, failed, total: leadIds.length });
  } catch (error: any) {
    console.error('Error bulk deleting leads:', error);
    return res.status(500).json({ message: error.message || 'Failed to bulk delete leads' });
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

    if (!(await canDestructiveCrmList(userId, list))) {
      return res.status(403).json({ message: CRM_EDITOR_REQUIRED_MESSAGE });
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

    // When this list is connected to HubSpot with auto-sync OFF, a change to a
    // HubSpot-mapped field on an already-synced lead means it needs re-pushing —
    // surface that as update_pending so it shows in the sync filter. With
    // auto-sync ON the adapter sets synced/sync_failed instead, so we skip.
    const hsConnUpd = getHubspotConnection(list);
    if (hsConnUpd.connected && !hsConnUpd.autoSyncEnabled) {
      const existingForSync = await crmDb.getLeadById(listId, leadId);
      if (existingForSync && resolveSyncStatus(existingForSync, true) === 'synced'
          && mappedFieldChanged(existingForSync, updates, getMappedAgentwebFields(hsConnUpd.config))) {
        updates.syncMetadata = { ...(existingForSync.syncMetadata || {}), syncStatus: 'update_pending' };
      }
    }

    const updateData = updates;

    // Auto-create status change engagement if status changed
    if (updates.status !== undefined) {
      const existingLead = await crmDb.getLeadById(listId, leadId);
      if (existingLead && existingLead.status !== updates.status) {
        await crmDb.addLeadEngagement(listId, leadId, {
          eventType: 'status.changed',
          eventData: {
            from: existingLead.status || null,
            to: updates.status,
            dealValue: updates.dealValue ?? existingLead.dealValue ?? null,
            dealCurrency: updates.dealCurrency ?? existingLead.dealCurrency ?? 'USD',
          },
          createdAt: new Date().toISOString(),
        });
      }
    }

    const updatedLead = await crmDb.updateLead(listId, leadId, updateData);

    void Promise.allSettled([
      externalCrmSyncService.autoSyncLead(userId, listId, updatedLead, 'hubspot', 'updated'),
      externalCrmSyncService.autoSyncLead(userId, listId, updatedLead, 'attio', 'updated'),
    ]);

    if (updates.email) {
      void validateLeadEmailInBackground(listId, leadId, updates.email, userId);
    }

    res.json(sanitizeLeadForResponse(updatedLead));
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

    if (!(await canDestructiveCrmList(userId, list))) {
      return res.status(403).json({ message: CRM_EDITOR_REQUIRED_MESSAGE });
    }

    await crmDb.deleteLead(listId, leadId);
    res.json({ success: true, message: 'Lead deleted successfully' });
  } catch (error: any) {
    console.error('Error deleting lead:', error);
    res.status(500).json({ message: error.message || 'Failed to delete lead' });
  }
});

/**
 * @route POST /api/crm/lists/:listId/leads/import/preview
 * @desc Parse a CSV file and return its headers, the first few sample rows,
 *   and a suggested column→field mapping the wizard renders for the user
 *   to review/override.
 * @access Private
 */
router.post(
  '/lists/:listId/leads/import/preview',
  upload.single('file'),
  async (req: Request, res: Response) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const userId = authReq.user?.userId;
      const { listId } = req.params;

      if (!userId) return res.status(401).json({ message: 'Unauthorized' });

      const list = await crmDb.getLeadListById(listId);
      if (!list) return res.status(404).json({ message: 'Lead list not found' });
      if (!(await canAccessCrmList(userId, list))) {
        return res.status(403).json({ message: CRM_SHARING_DISABLED_MESSAGE });
      }

      if (!req.file) {
        return res.status(400).json({ message: 'CSV file is required' });
      }

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

      const headers = Object.keys(records[0]);
      const { suggestColumnMapping } = await import('../services/csvColumnMatcher');
      const standardLeadFields = ['email', 'firstName', 'lastName', 'phone', 'company', 'title', 'linkedin', 'companyLinkedin', 'notes'];
      const existingCustomFields = ((list as any).fieldNames as string[] || []).filter(
        (f: string) => !standardLeadFields.includes(f),
      );
      const suggestedMapping = suggestColumnMapping(headers, existingCustomFields);

      // A required field is satisfied if any column maps to email or linkedin
      // (we'll re-validate at import time with the user's final choices).
      const mappedFields = new Set(
        Object.values(suggestedMapping).map((s) => s.field),
      );
      const requiredFieldsSatisfied = mappedFields.has('email') || mappedFields.has('linkedin');

      return res.json({
        headers,
        sampleRows: records.slice(0, 5),
        totalRows: records.length,
        suggestedMapping,
        requiredFieldsSatisfied,
        savedMapping: (list as any).lastImportMapping,
      });
    } catch (error: any) {
      if (error.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ message: 'File too large. Maximum CSV size is 50 MB.' });
      }
      console.error('Error previewing CSV:', error);
      return res.status(500).json({ message: error.message || 'Failed to preview CSV' });
    }
  },
);

type ColumnMappingTarget =
  | 'email'
  | 'firstName'
  | 'lastName'
  | 'phone'
  | 'company'
  | 'title'
  | 'linkedin'
  | 'companyLinkedin'
  | 'notes'
  | 'skip'
  | { customField: string }
  | { splitFullName: true | 'first' | 'last' };

const STANDARD_LEAD_FIELDS: ReadonlyArray<string> = [
  'email', 'firstName', 'lastName', 'phone', 'company', 'title', 'linkedin', 'companyLinkedin', 'notes',
];

/**
 * Cap on the user-supplied column mapping before persisting it on the list.
 * The list row already carries csvExportHistory/lastImportMapping/etc., so
 * we leave plenty of headroom under the 400KB DDB item limit. Returns an
 * error message string when the mapping is too large, null when it's fine.
 */
const MAX_MAPPING_KEYS = 500;
const MAX_MAPPING_JSON_BYTES = 64 * 1024;
function validateColumnMappingSize(mapping: Record<string, any>): string | null {
  const keyCount = Object.keys(mapping).length;
  if (keyCount > MAX_MAPPING_KEYS) {
    return `columnMapping has too many entries (${keyCount}); maximum is ${MAX_MAPPING_KEYS}.`;
  }
  const serializedBytes = Buffer.byteLength(JSON.stringify(mapping), 'utf8');
  if (serializedBytes > MAX_MAPPING_JSON_BYTES) {
    return `columnMapping exceeds ${MAX_MAPPING_JSON_BYTES} bytes (got ${serializedBytes}).`;
  }
  return null;
}

/**
 * Project a CSV record through a user-supplied column mapping into a lead
 * shape ready for batchCreateLeads. Falls back to header-name auto-detect
 * when no mapping is provided (legacy behavior, preserved so old clients keep
 * working).
 */
/**
 * S11: per-value/per-key caps for CSV import. Adversarial CSVs with multi-MB
 * cells or hundreds of columns shouldn't push the lead row past the DDB
 * 400KB item limit. Truncation is silent — users importing a 10KB blob into
 * a single field weren't going to render it sensibly anyway.
 */
const MAX_CUSTOM_FIELD_VALUE_BYTES = 8 * 1024;
const MAX_CUSTOM_FIELDS_PER_LEAD = 100;
function truncateForLead(value: string): string {
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes <= MAX_CUSTOM_FIELD_VALUE_BYTES) return value;
  // Slice by JS char index — close enough; we'd rather under-truncate by a
  // few multibyte chars than introduce a fast utf8 byte-walker for this.
  const approxCharCap = Math.floor(MAX_CUSTOM_FIELD_VALUE_BYTES / 2);
  return value.slice(0, approxCharCap);
}

function projectRecordWithMapping(
  record: Record<string, any>,
  mapping: Record<string, ColumnMappingTarget> | null,
): Record<string, any> {
  const lead: Record<string, any> = {
    email: '',
    firstName: '',
    lastName: '',
    phone: '',
    company: '',
    title: '',
    notes: '',
    linkedin: '',
    companyLinkedin: '',
  };
  const customFields: Record<string, any> = {};

  if (mapping) {
    for (const [csvHeader, target] of Object.entries(mapping)) {
      const raw = record[csvHeader];
      const value = typeof raw === 'string' ? raw.trim() : raw == null ? '' : String(raw);
      if (!value) continue;

      if (target === 'skip') continue;

      if (typeof target === 'string' && STANDARD_LEAD_FIELDS.includes(target)) {
        lead[target] = target === 'email' ? value.toLowerCase() : value;
        continue;
      }

      if (typeof target === 'object' && target !== null) {
        if ('customField' in target && target.customField) {
          if (Object.keys(customFields).length >= MAX_CUSTOM_FIELDS_PER_LEAD) continue;
          customFields[target.customField] = truncateForLead(value);
          continue;
        }
        if ('splitFullName' in target) {
          // "Jane Marie Doe" → first="Jane", last="Marie Doe". For the
          // "first" / "last" sub-directives we only emit one half, used when
          // the wizard maps two columns ("Full Name" + something else) — but
          // typically both halves come from one column with the boolean form.
          const parts = value.split(/\s+/);
          const first = parts[0] || '';
          const rest = parts.slice(1).join(' ');
          if (target.splitFullName === 'last') {
            lead.lastName = lead.lastName || rest;
          } else if (target.splitFullName === 'first') {
            lead.firstName = lead.firstName || first;
          } else {
            lead.firstName = lead.firstName || first;
            lead.lastName = lead.lastName || rest;
          }
          continue;
        }
      }
    }
  } else {
    // Legacy auto-detect — match column name case-insensitively to standard field.
    Object.keys(record).forEach((key) => {
      const lower = key.toLowerCase().trim();
      const raw = record[key];
      const value = typeof raw === 'string' ? raw.trim() : raw == null ? '' : String(raw);
      if (!value) return;

      if (['email', 'e-mail', 'e_mail'].includes(lower)) {
        lead.email = value.toLowerCase();
        return;
      }
      const matching = STANDARD_LEAD_FIELDS.find((sf) => sf.toLowerCase() === lower);
      if (matching) {
        lead[matching] = value;
      } else {
        if (Object.keys(customFields).length >= MAX_CUSTOM_FIELDS_PER_LEAD) return;
        customFields[key] = truncateForLead(value);
      }
    });
  }

  if (Object.keys(customFields).length > 0) {
    lead.customFields = customFields;
  }
  return lead;
}

/**
 * @route POST /api/crm/lists/:listId/leads/import
 * @desc Import leads from CSV file. Optionally accepts a `columnMapping`
 *   field (multipart string, JSON-encoded) that controls how each CSV
 *   column maps to a Lead field. When omitted, falls back to header-name
 *   auto-detect for backwards compatibility.
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

    if (!(await canDestructiveCrmList(userId, list))) {
      return res.status(403).json({ message: CRM_EDITOR_REQUIRED_MESSAGE });
    }

    if (!req.file) {
      return res.status(400).json({ message: 'CSV file is required' });
    }

    // Parse columnMapping if provided. Multipart bodies arrive as strings.
    let columnMapping: Record<string, ColumnMappingTarget> | null = null;
    if (req.body?.columnMapping) {
      try {
        columnMapping =
          typeof req.body.columnMapping === 'string'
            ? JSON.parse(req.body.columnMapping)
            : req.body.columnMapping;
      } catch (err: any) {
        return res
          .status(400)
          .json({ message: `Invalid columnMapping JSON: ${err.message}` });
      }
    }

    if (columnMapping) {
      // C7: cap mapping size before doing anything with it. The mapping is
      // persisted on the list row via lastImportMapping; without bounds, a
      // pathological CSV (5000 columns) could push the lead-list DDB item
      // past the 400KB limit and cause silent updateLeadList failures.
      const mappingValidationError = validateColumnMappingSize(columnMapping);
      if (mappingValidationError) {
        return res.status(400).json({ message: mappingValidationError });
      }

      // Required fields: at least one of email or linkedin must be mapped, or
      // we have no way to dedup or message the lead.
      const mappedFields = Object.values(columnMapping)
        .map((t) => (typeof t === 'string' ? t : ''))
        .filter(Boolean);
      const hasEmailOrLinkedIn =
        mappedFields.includes('email') || mappedFields.includes('linkedin');
      if (!hasEmailOrLinkedIn) {
        return res.status(400).json({
          message:
            'At least one column must be mapped to Email or LinkedIn — these are required for deduplication.',
        });
      }
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

    const leads = records.map((record) => projectRecordWithMapping(record, columnMapping));

    // Batch create leads
    const results = await crmDb.batchCreateLeads(listId, leads);

    if (results.newCount > 0) {
      void autoEnrollListIntoSequences(userId, listId);
    }

    // Persist the successful mapping so the next import of the same template
    // is one-click. Best-effort — failing to save the mapping shouldn't fail
    // the import the user already paid for.
    if (columnMapping) {
      try {
        await crmDb.updateLeadList(listId, { lastImportMapping: columnMapping });
      } catch (err) {
        console.warn('Failed to persist lastImportMapping for list', listId, err);
      }
    }

    res.json({
      success: true,
      successCount: results.successCount,
      mergedCount: results.mergedCount,
      errorCount: results.errorCount,
      errors: results.errors,
      message: `Imported ${results.successCount} leads${results.errorCount > 0 ? `, ${results.errorCount} errors` : ''}`,
    });
  } catch (error: any) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ message: 'File too large. Maximum CSV size is 50 MB.' });
    }
    console.error('Error importing leads:', error);
    res.status(500).json({ message: error.message || 'Failed to import leads' });
  }
});

/**
 * @route POST /api/crm/lists/:listId/leads/export
 * @desc Export leads to CSV and upload to S3
 * @access Private
 */
router.post('/lists/:listId/leads/export', async (req: Request, res: Response) => {
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
    if (!(await canDestructiveCrmList(userId, list))) {
      return res.status(403).json({ message: CRM_EDITOR_REQUIRED_MESSAGE });
    }

    // Fetch all leads by paginating
    const allLeads: any[] = [];
    let lastKey: any = undefined;
    do {
      const result = await crmDb.getLeadsByListId(listId, 200, lastKey);
      allLeads.push(...result.items);
      lastKey = result.lastEvaluatedKey;
    } while (lastKey);

    if (allLeads.length === 0) {
      return res.status(400).json({ message: 'No leads to export' });
    }

    // Build columns: standard fields + custom fields from fieldNames and lead data
    const standardFields = ['email', 'firstName', 'lastName', 'phone', 'company', 'title', 'linkedin', 'companyLinkedin', 'notes'];
    const customFieldSet = new Set<string>();

    if (list.fieldNames && Array.isArray(list.fieldNames)) {
      for (const f of list.fieldNames) {
        if (!standardFields.includes(f)) {
          customFieldSet.add(f);
        }
      }
    }

    for (const lead of allLeads) {
      if (lead.customFields && typeof lead.customFields === 'object') {
        for (const key of Object.keys(lead.customFields)) {
          customFieldSet.add(key);
        }
      }
    }

    const customFields = Array.from(customFieldSet).sort();
    const allColumns = [...standardFields, ...customFields];

    // Helper to escape a CSV cell value
    const escapeCell = (value: any): string => {
      if (value === null || value === undefined) return '';
      const str = String(value);
      if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
        return '"' + str.replace(/"/g, '""') + '"';
      }
      return str;
    };

    // Build CSV
    const headerRow = allColumns.map(escapeCell).join(',');
    const dataRows = allLeads.map(lead => {
      return allColumns.map(col => {
        if (standardFields.includes(col)) {
          return escapeCell(lead[col]);
        }
        return escapeCell(lead.customFields?.[col]);
      }).join(',');
    });
    const csvContent = [headerRow, ...dataRows].join('\n');

    // Upload to S3
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeListName = (list.name || 'leads').replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 50);
    const filename = `${safeListName}_export_${timestamp}.csv`;

    const { uploadFileToS3 } = await import('../utils/s3Utils');
    const uploadResult = await uploadFileToS3(Buffer.from(csvContent, 'utf-8'), filename, userId, 'text/csv');

    if (!uploadResult.success || !uploadResult.url) {
      return res.status(500).json({ message: 'Failed to upload CSV to storage' });
    }

    // Create export entry
    const exportEntry = {
      exportId: `exp_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
      recordCount: allLeads.length,
      exportedAt: new Date().toISOString(),
      fileUrl: uploadResult.url,
      filename,
    };

    // Prepend to history, cap at 50
    const existingHistory = list.csvExportHistory || [];
    const updatedHistory = [exportEntry, ...existingHistory].slice(0, 50);
    await crmDb.updateLeadList(listId, { csvExportHistory: updatedHistory });

    res.json({ success: true, export: exportEntry });
  } catch (error: any) {
    console.error('Error exporting leads:', error);
    res.status(500).json({ message: error.message || 'Failed to export leads' });
  }
});

/**
 * @route GET /api/crm/lists/:listId/export-history
 * @desc Get CSV export history for a lead list
 * @access Private
 */
router.get('/lists/:listId/export-history', async (req: Request, res: Response) => {
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
    if (!(await canAccessCrmList(userId, list))) {
      return res.status(403).json({ message: CRM_SHARING_DISABLED_MESSAGE });
    }

    res.json({ history: list.csvExportHistory || [] });
  } catch (error: any) {
    console.error('Error fetching export history:', error);
    res.status(500).json({ message: error.message || 'Failed to fetch export history' });
  }
});

/**
 * @route POST /api/crm/lists/:listId/leads/import-linkedin
 * @desc Import or preview LinkedIn data export
 * @access Private
 * @query mode - "preview" (default) or "import"
 */
router.post('/lists/:listId/leads/import-linkedin', upload.single('file'), async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    const { listId } = req.params;
    const mode = (req.query.mode as string || 'preview').toLowerCase(); // Default to preview

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    // Verify list ownership
    const list = await crmDb.getLeadListById(listId);
    if (!list) {
      return res.status(404).json({ message: 'Lead list not found' });
    }

    if (!(await canDestructiveCrmList(userId, list))) {
      return res.status(403).json({ message: CRM_EDITOR_REQUIRED_MESSAGE });
    }

    if (!req.file) {
      return res.status(400).json({ message: 'ZIP file is required' });
    }

    const userLinkedInUrl = normalizeLinkedInUrl(req.body.userLinkedInUrl || '');
    if (!userLinkedInUrl) {
      return res.status(400).json({ message: 'Your LinkedIn profile URL is required' });
    }

    // Validate that it's a proper LinkedIn /in/ profile URL
    if (!userLinkedInUrl.includes('linkedin.com/in/')) {
      return res.status(400).json({ message: 'Please provide a valid LinkedIn profile URL (https://www.linkedin.com/in/your-profile)' });
    }

    const socketId = req.body.socketId; // Optional socket ID for progress updates

    // Helper function to emit progress
    const emitProgress = (message: string, progress?: number) => {
      if (socketId && mode === 'import') {
        io.to(socketId).emit('import-progress', { message, progress });
      }
    };

    // Parse ZIP file
    let zip: AdmZip;
    try {
      zip = new AdmZip(req.file.buffer);
    } catch (error: any) {
      return res.status(400).json({ message: 'Invalid ZIP file' });
    }

    const zipEntries = zip.getEntries();

    // Find Connections.csv
    const connectionsEntry = zipEntries.find(e => e.entryName === 'Connections.csv');
    if (!connectionsEntry) {
      return res.status(400).json({ message: 'Connections.csv not found in ZIP file' });
    }

    // Parse Connections.csv
    let connectionsRecords: any[];
    try {
      const connectionsContent = connectionsEntry.getData().toString('utf-8');
      connectionsRecords = parse(connectionsContent, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        from_line: 4,
        relax_column_count: true,
      });
    } catch (parseError: any) {
      return res.status(400).json({ message: `Failed to parse Connections.csv: ${parseError.message}` });
    }

    // Filter connections with URLs and normalize them
    const validConnections = connectionsRecords
      .filter(c => c.URL)
      .map(c => ({
        ...c,
        URL: normalizeLinkedInUrl(c.URL),
      }))
      .filter(c => c.URL); // Remove any that failed normalization

    // Get existing leads to check for duplicates (paginate through all results)
    const existingLeads: any[] = [];
    let leadsLastKey: any = undefined;

    do {
      const existingLeadsResult = await crmDb.getLeadsByListId(listId, undefined, leadsLastKey);
      existingLeads.push(...(existingLeadsResult.items || []));
      leadsLastKey = existingLeadsResult.lastEvaluatedKey;
    } while (leadsLastKey);

    const existingEmails = new Set(existingLeads.map((l: any) => l.email?.toLowerCase()).filter(Boolean));
    const existingLinkedIns = new Set(existingLeads.map((l: any) => normalizeLinkedInUrl(l.linkedin || '')).filter(Boolean));

    // Debug logging


    // Count duplicates
    let duplicateCount = 0;
    const newConnections: any[] = [];
    const sampleConnections: any[] = [];

    for (const connection of validConnections) {
      const email = connection['Email Address']?.trim().toLowerCase();
      const linkedin = connection.URL; // Already normalized

      const emailMatch = email && existingEmails.has(email);
      const linkedinMatch = linkedin && existingLinkedIns.has(linkedin);
      const isDuplicate = emailMatch || linkedinMatch;

      if (isDuplicate) {
        duplicateCount++;
      } else {
        newConnections.push(connection);
        if (sampleConnections.length < 10) {
          sampleConnections.push({
            firstName: connection['First Name'] || '',
            lastName: connection['Last Name'] || '',
            company: connection.Company || '',
            position: connection.Position || '',
            email: connection['Email Address'] || '',
            linkedin: connection.URL || '',
            connectedOn: connection['Connected On'] || '',
          });
        }
      }
    }

    // Debug summary for connections
  

    // Parse messages if available
    const messagesEntry = zipEntries.find(e => e.entryName === 'messages.csv');
    let totalMessagesInFile = 0;
    let newMessagesCount = 0;
    let duplicateMessagesCount = 0;
    let messagesSuccessCount = 0;
    let messagesFailedCount = 0;

    // Declare connections import tracking variables
    let connectionsSuccessCount = 0;
    let connectionsErrorCount = 0;
    let connectionsErrors: string[] = [];

    if (messagesEntry) {
      try {
        const messagesContent = messagesEntry.getData().toString('utf-8');
        const messagesRecords = parse(messagesContent, {
          columns: true,
          skip_empty_lines: true,
          trim: true,
          relax_column_count: true,
        });

        // Filter valid messages (exclude drafts that haven't been sent)
        const validMessages = messagesRecords.filter((m: any) => {
          // Must have conversation ID and date
          if (!m['CONVERSATION ID'] || !m.DATE) return false;

          // Skip messages marked as drafts (IS MESSAGE DRAFT = "Yes")
          const isDraft = m['IS MESSAGE DRAFT']?.trim().toLowerCase() === 'yes';
          if (isDraft) return false;

          return true;
        });
        totalMessagesInFile = validMessages.length;

        // Get existing email events to check for duplicates
        // Use EmailDomainIndex to get all events for this domain
        const existingEventKeys = new Set<string>();
        let lastEvaluatedKey: any = undefined;

        do {
          const existingEventsParams: any = {
            TableName: `${TABLE_PREFIX}AW-EmailEvents`,
            IndexName: 'EmailDomainIndex',
            KeyConditionExpression: 'emailDomain = :domain',
            ExpressionAttributeValues: {
              ':domain': `linkedin-${listId}`,
            },
          };

          if (lastEvaluatedKey) {
            existingEventsParams.ExclusiveStartKey = lastEvaluatedKey;
          }

          const existingEventsResult = await dynamodb.query(existingEventsParams).promise();

          (existingEventsResult.Items || []).forEach((item: any) => {
            const conversationId = item.data?.conversationId || item.emailId || '';
            const date = item.data?.date || item.createdAt || '';
            existingEventKeys.add(`${conversationId}-${date}`);
          });

          lastEvaluatedKey = existingEventsResult.LastEvaluatedKey;
        } while (lastEvaluatedKey);

        // Debug logging


        // Count new vs duplicate messages, and filter for messages involving the user
        const newMessages: any[] = [];
        for (const message of validMessages) {
          const conversationId = message['CONVERSATION ID'];
          const date = message.DATE;
          const senderProfileUrl = normalizeLinkedInUrl(message['SENDER PROFILE URL'] || '');
          const recipientProfileUrls = message['RECIPIENT PROFILE URLS'] || '';

          // Normalize recipient URLs (comma-separated list)
          const normalizedRecipientUrls = recipientProfileUrls
            .split(',')
            .map((url: string) => normalizeLinkedInUrl(url.trim()))
            .filter(Boolean);

          // Determine if this message involves the user
          const senderIsUser = senderProfileUrl === userLinkedInUrl;
          const recipientIsUser = normalizedRecipientUrls.some((url: string) => url === userLinkedInUrl);

          // Only process messages where one party is the user
          if (!senderIsUser && !recipientIsUser) {
            continue; // Skip messages that don't involve the user
          }

          // Determine the lead LinkedIn URL (whoever is NOT the user)
          let leadLinkedInUrl: string;
          let messageDirection: 'sent' | 'received';

          if (senderIsUser) {
            // User sent this message to lead(s)
            messageDirection = 'sent';
            // Filter out the user from recipients and pick first lead
            // (handles group chats where user might be in recipient list)
            const leadRecipients = normalizedRecipientUrls.filter((url: string) => url !== userLinkedInUrl);
            leadLinkedInUrl = leadRecipients[0]; // Use first non-user recipient
          } else {
            // Lead sent this message to user (sender is the lead)
            messageDirection = 'received';
            leadLinkedInUrl = senderProfileUrl;
          }

          if (!leadLinkedInUrl) {
            continue; // Skip if we can't identify the lead
          }

          const eventKey = `${conversationId}-${date}`;

          if (existingEventKeys.has(eventKey)) {
            duplicateMessagesCount++;
          } else {
            newMessagesCount++;
            newMessages.push({
              ...message,
              leadLinkedInUrl,
              messageDirection,
            });
          }
        }

        // If mode is import, actually import the messages using batch
        if (mode === 'import') {
          emitProgress(`Importing ${newMessages.length} messages...`, 20);

          // Prepare all events for batch import
          const eventsToImport = newMessages.map((message, index) => {
            const conversationId = message['CONVERSATION ID'];
            const date = message.DATE;
            const from = message.FROM;
            const senderProfileUrl = normalizeLinkedInUrl(message['SENDER PROFILE URL'] || '');
            const content = message.CONTENT;
            const subject = message.SUBJECT;
            const leadLinkedInUrl = message.leadLinkedInUrl;
            const messageDirection = message.messageDirection;

            return {
              event: {
                type: messageDirection === 'sent' ? 'linkedin.message.sent' : 'linkedin.message.received',
                created_at: date,
                data: {
                  email_id: conversationId,
                  conversationId,
                  from,
                  senderProfileUrl,
                  content,
                  subject,
                  date,
                  to: message.TO || '',
                  recipientProfileUrls: message['RECIPIENT PROFILE URLS'] || '',
                  folder: message.FOLDER || 'INBOX',
                  direction: messageDirection,
                } as any,
              },
              emailDomain: `linkedin-${listId}`,
              eventId: `linkedin-${listId}-${conversationId}-${index}-${Date.now()}`,
              overrideLeadEmail: leadLinkedInUrl,
            };
          });

          // Batch import messages in chunks of 100 for progress updates
          const batchSize = 100;

          for (let i = 0; i < eventsToImport.length; i += batchSize) {
            const batch = eventsToImport.slice(i, i + batchSize);
            const batchResult = await emailEventsDb.addEmailEvents(batch);

            messagesSuccessCount += batchResult.successCount;
            messagesFailedCount += batchResult.failedCount;

            // Calculate progress: 20% to 60% of overall progress
            const messagesProgress = Math.round(20 + ((i + batch.length) / eventsToImport.length) * 40);
            emitProgress(`Imported ${messagesSuccessCount} of ${eventsToImport.length} messages`, messagesProgress);
          }

          if (messagesFailedCount > 0) {
            console.warn(`Failed to import ${messagesFailedCount} messages`);
          }
        }
      } catch (error) {
        console.error('Error processing messages:', error);
        // Continue with 0 message counts if there's an error
      }
    }

    // Return response based on mode
    if (mode === 'preview') {
      res.json({
        success: true,
        preview: {
          totalConnectionsInFile: validConnections.length,
          newConnectionsCount: newConnections.length,
          duplicateConnectionsCount: duplicateCount,
          totalMessagesInFile,
          newMessagesCount,
          duplicateMessagesCount,
          sampleConnections,
        },
      });
    } else if (mode === 'import') {
      emitProgress('Starting import...', 0);

      // Import the connections in chunks of 100 for progress updates
      emitProgress(`Importing ${newConnections.length} connections...`, 65);
      const leads = newConnections.map(connection => ({
        email: connection['Email Address']?.trim() || '',
        firstName: connection['First Name']?.trim() || '',
        lastName: connection['Last Name']?.trim() || '',
        phone: '',
        company: connection.Company?.trim() || '',
        title: connection.Position?.trim() || '',
        notes: `Connected on: ${connection['Connected On'] || 'Unknown'}`,
        linkedin: connection.URL || '', // Already normalized
        customFields: {
          'Connected On': connection['Connected On']?.trim() || '',
          'LinkedIn URL': connection.URL || '', // Already normalized
        },
      }));

      const leadBatchSize = 100;

      for (let i = 0; i < leads.length; i += leadBatchSize) {
        const batch = leads.slice(i, i + leadBatchSize);
        const results = await crmDb.batchCreateLeads(listId, batch);

        connectionsSuccessCount += results.successCount;
        connectionsErrorCount += results.errorCount;
        if (results.errors.length > 0) {
          connectionsErrors.push(...results.errors);
        }

        // Calculate progress: 65% to 90% of overall progress
        const connectionsProgress = Math.round(65 + ((i + batch.length) / leads.length) * 25);
        emitProgress(`Imported ${connectionsSuccessCount} of ${leads.length} connections`, connectionsProgress);
      }

      // Emit final progress
      emitProgress('Import complete!', 100);

      if (connectionsSuccessCount > 0) {
        void autoEnrollListIntoSequences(userId, listId);
      }

      res.json({
        success: true,
        successCount: connectionsSuccessCount,
        errorCount: connectionsErrorCount,
        errors: connectionsErrors,
        messagesImported: messagesSuccessCount,
        message: `Imported ${connectionsSuccessCount} connections${messagesSuccessCount > 0 ? ` and ${messagesSuccessCount} message events` : ''}${connectionsErrorCount > 0 ? `, ${connectionsErrorCount} errors` : ''}`,
      });
    } else {
      res.status(400).json({ message: 'Invalid mode parameter. Use "preview" or "import"' });
    }
  } catch (error: any) {
    console.error('Error processing LinkedIn import:', error);
    res.status(500).json({ message: error.message || 'Failed to process LinkedIn import' });
  }
});

/**
 * @route POST /api/crm/lists/:listId/leads/match-icps
 * @desc Match leads against ICPs using AI
 * @access Private
 * @query mode - "preview" (default) or "match"
 */
router.post('/lists/:listId/leads/match-icps', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    const { listId } = req.params;
    const mode = (req.query.mode as string || 'preview').toLowerCase();
    const socketId = req.body.socketId;
    const forceRematch = req.body.forceRematch === true;
    const leadIds: string[] | undefined = Array.isArray(req.body.leadIds) ? req.body.leadIds : undefined;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    // Verify list ownership
    const list = await crmDb.getLeadListById(listId);
    if (!list) {
      return res.status(404).json({ message: 'Lead list not found' });
    }

    if (!(await canDestructiveCrmList(userId, list))) {
      return res.status(403).json({ message: CRM_EDITOR_REQUIRED_MESSAGE });
    }

    // Helper function to emit progress
    const emitProgress = (message: string, progress: number) => {
      if (socketId) {
        io.to(socketId).emit('icp-match-progress', {
          message,
          progress: Math.round(progress),
        });
      }
    };

    // Get user settings to fetch market strategy
    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const marketStrategyData = user.marketStrategy;
    if (!marketStrategyData) {
      return res.status(400).json({ message: 'Market strategy not found. Please set up your market strategy in /market-strategy first.' });
    }

    // Check if ICPs are defined
    if (!marketStrategyData.icp || marketStrategyData.icp.length === 0) {
      return res.status(400).json({ message: 'ICPs not defined. Please define your Ideal Customer Profiles in /market-strategy before proceeding.' });
    }

    // Format market strategy into readable text
    const marketStrategy = JSON.stringify(marketStrategyData, null, 2);

    // Get all leads in the list (paginate through all)
    const allLeads: any[] = [];
    let lastKey: any = undefined;

    do {
      const result = await crmDb.getLeadsByListId(listId, undefined, lastKey);
      allLeads.push(...(result.items || []));
      lastKey = result.lastEvaluatedKey;
    } while (lastKey);

    // Filter by specific leadIds if provided
    const leadPool = leadIds && leadIds.length > 0
      ? allLeads.filter(lead => leadIds.includes(lead.leadId))
      : allLeads;

    // Filter leads based on forceRematch flag
    const leadsToProcess = forceRematch
      ? leadPool // Process all leads if force rematch
      : leadPool.filter(lead => !lead.icpMatch); // Only unmatched leads by default

    const unmatchedLeads = leadPool.filter(lead => !lead.icpMatch);


    if (mode === 'preview') {
      return res.json({
        success: true,
        totalLeads: leadPool.length,
        unmatchedLeads: unmatchedLeads.length,
        matchedLeads: leadPool.length - unmatchedLeads.length,
        leadsToProcess: leadsToProcess.length,
        forceRematch,
      });
    } else if (mode === 'match') {
      if (leadsToProcess.length === 0) {
        return res.json({
          success: true,
          message: 'No leads to process',
          processedCount: 0,
        });
      }

      // Import LLMService
      const { createLLMService } = await import('../utils/llmService');

      emitProgress('Starting ICP matching...', 0);

      // Split leads into 5 chunks for parallel processing
      const parallelism = 20;
      const chunkSize = Math.ceil(leadsToProcess.length / parallelism);
      const chunks: any[][] = [];

      for (let i = 0; i < leadsToProcess.length; i += chunkSize) {
        chunks.push(leadsToProcess.slice(i, i + chunkSize));
      }


      // Shared progress tracking
      let totalProcessedCount = 0;
      const progressLock = { value: 0 }; // Simple object to share progress state

      // Process each chunk in parallel
      const chunkProcessors = chunks.map(async (chunk, chunkIndex) => {
        // Create separate LLM service instance for each parallel task
        const llmService = createLLMService('gpt-5.2-chat', 1);

        const batchSize = 10;
        let chunkProcessedCount = 0;

        for (let i = 0; i < chunk.length; i += batchSize) {
          const batch = chunk.slice(i, i + batchSize);

          // Prepare batch data for LLM
          const leadsData = batch.map((lead, index) => {
            const data: any = {
              index: i + index + 1,
              name: `${lead.firstName || ''} ${lead.lastName || ''}`.trim() || 'N/A',
              email: lead.email || 'N/A',
              company: lead.company || 'N/A',
              title: lead.title || 'N/A',
              phone: lead.phone || 'N/A',
              linkedin: lead.linkedin || 'N/A',
              notes: lead.notes || 'N/A',
            };

            // Include previous match result if this is a rematch
            if (lead.icpMatch) {
              data.previousMatch = {
                isMatch: lead.icpMatch.isMatch,
                score: lead.icpMatch.score,
                reason: lead.icpMatch.reason,
                matchedAt: lead.icpMatch.matchedAt,
              };
            }

            return data;
          });

          const systemPrompt = `You are an expert business analyst helping to identify Ideal Customer Profile (ICP) matches.

Your task is to analyze each lead and determine if they match the provided market strategy and ICP criteria.

For each lead, provide:
1. "isMatch": boolean (true if the lead matches the ICP, false otherwise)
2. "reason": string (concise explanation of why they match or don't match, 1-2 sentences)
3. "score": number (0-100, confidence score of the match)

Consider factors like:
- Job title and seniority level
- Company size and industry
- Geographic location (if relevant)
- Technology stack or interests (from LinkedIn/notes)
- Budget indicators
- Pain points alignment

IMPORTANT: Some leads may include a "previousMatch" field with a prior analysis. If present, consider this previous assessment but make your own independent judgment. You may agree or disagree with the previous analysis based on the current ICP criteria.

Return your analysis as a JSON array with the exact structure:
[
  {
    "index": 1,
    "isMatch": true,
    "score": 85,
    "reason": "Senior decision-maker in target industry with clear pain points"
  },
  ...
]`;

          const userPrompt = `Market Strategy and ICP Criteria:
${marketStrategy}

Leads to Analyze:
${JSON.stringify(leadsData, null, 2)}

Please analyze each lead and return a JSON array with your assessment.`;

          try {
            // Escape curly braces for LangChain template parser
            const escapeBraces = (str: string) => str.replace(/{/g, '{{').replace(/}/g, '}}');
            const escapedSystemPrompt = escapeBraces(systemPrompt);
            const escapedUserPrompt = escapeBraces(userPrompt);

            // Call LLM
            const response = await llmService.generateJSONContent<Array<{
              index: number;
              isMatch: boolean;
              score: number;
              reason: string;
            }>>(escapedSystemPrompt, escapedUserPrompt, 'json', undefined, {
              userId,
              feature: 'enrichment',
            });

            // Update each lead with ICP match result
            for (const result of response) {
              const leadIndex = result.index - 1;
              if (leadIndex >= 0 && leadIndex < chunk.length) {
                const lead = chunk[leadIndex];

                // Update lead in DynamoDB
                await crmDb.updateLead(listId, lead.leadId, {
                  icpMatch: {
                    isMatch: result.isMatch,
                    score: result.score,
                    reason: result.reason,
                    matchedAt: new Date().toISOString(),
                  },
                });

                chunkProcessedCount++;
                totalProcessedCount++;
              }
            }
          } catch (error) {
            console.error(`[ICP Match] Error processing chunk ${chunkIndex + 1}, batch ${i / batchSize + 1}:`, error);
            // Continue with next batch even if one fails
          }

          // Update progress (thread-safe-ish for Node.js single-threaded event loop)
          const progress = Math.min((totalProcessedCount / leadsToProcess.length) * 100, 100);
          emitProgress(`Processed ${totalProcessedCount} of ${leadsToProcess.length} leads`, progress);
        }

        return chunkProcessedCount;
      });

      // Wait for all parallel chunks to complete
      const chunkResults = await Promise.all(chunkProcessors);
      const processedCount = chunkResults.reduce((sum, count) => sum + count, 0);

      emitProgress('ICP matching complete!', 100);

      res.json({
        success: true,
        message: `Successfully matched ${processedCount} leads`,
        processedCount,
        totalLeadsProcessed: leadsToProcess.length,
      });
    } else {
      res.status(400).json({ message: 'Invalid mode parameter. Use "preview" or "match"' });
    }
  } catch (error: any) {
    console.error('Error matching ICPs:', error);
    res.status(500).json({ message: error.message || 'Failed to match ICPs' });
  }
});

/**
 * @route POST /api/crm/lists/:listId/leads/enrich-web
 * @desc Enrich leads with web company info using web search + AI
 * @access Private
 * @query mode - "preview" (default) or "enrich"
 */
router.post('/lists/:listId/leads/enrich-web', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    const { listId } = req.params;
    const mode = (req.query.mode as string || 'preview').toLowerCase();
    const socketId = req.body.socketId;
    const forceEnrich = req.body.forceEnrich === true;
    const leadIds: string[] | undefined = Array.isArray(req.body.leadIds) ? req.body.leadIds : undefined;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const list = await crmDb.getLeadListById(listId);
    if (!list) {
      return res.status(404).json({ message: 'Lead list not found' });
    }

    if (!(await canDestructiveCrmList(userId, list))) {
      return res.status(403).json({ message: CRM_EDITOR_REQUIRED_MESSAGE });
    }

    if (mode === 'suggest') {
      let goal: string;
      try {
        goal = validateGoal(req.body.goal);
      } catch (err: any) {
        if (err instanceof EnrichmentInputError) {
          return res.status(400).json({ message: err.message });
        }
        throw err;
      }
      try {
        const { CrmEnrichmentService } = await import('../services/crmEnrichmentService');
        // Sample up to 20 leads to find commonly empty standard fields
        const STANDARD_FIELDS = ['email', 'firstName', 'lastName', 'company', 'phone', 'title', 'linkedin', 'notes'];
        let commonlyEmptyFields: string[] = [];
        try {
          const samplePage = await crmDb.getLeadsByListId(listId, undefined, undefined);
          const sampleLeads = (samplePage.items || []).slice(0, 20);
          if (sampleLeads.length > 0) {
            commonlyEmptyFields = STANDARD_FIELDS.filter(field => {
              const populated = sampleLeads.filter((l: any) => l[field] && String(l[field]).trim()).length;
              return (populated / sampleLeads.length) < 0.5;
            });
          }
        } catch {
          // Non-fatal — proceed without stats
        }

        const result = await CrmEnrichmentService.suggestEnrichment(goal, {
          listId,
          existingStandardFields: STANDARD_FIELDS,
          existingCustomFields: Array.isArray(list.fieldNames) ? list.fieldNames as string[] : [],
          commonlyEmptyFields,
        }, userId);
        return res.json({
          success: true,
          instruction: result.instruction,
          outputFields: result.outputFields,
          fieldDescriptions: result.fieldDescriptions,
          linkedinSearchTemplate: result.linkedinSearchTemplate,
          sourcesPerField: result.sourcesPerField,
          sources: result.sources,
        });
      } catch (err: any) {
        console.error('[CRM] suggestEnrichment failed:', err.message);
        return res.status(502).json({ message: 'AI suggestion failed. Please try again.' });
      }
    }

    const defaultInstruction = 'Write a 3-6 sentence company profile covering what they do, their industry, products, and notable context. If no good company information is available, return "Company information not found".';
    let instruction: string;
    let outputFields: string[];
    let sources: ('web_search' | 'linkedin' | 'existing_data')[];
    let webSearchTemplate: string | undefined;
    let linkedinSearchTemplate: string | undefined;
    let sourcesPerField: Record<string, ('web_search' | 'linkedin' | 'existing_data')[]> | undefined;
    let fieldDescriptions: Record<string, string> | undefined;
    try {
      instruction = validateInstruction(req.body.instruction, defaultInstruction);
      outputFields = req.body.outputFields !== undefined
        ? validateOutputFields(req.body.outputFields)
        : ['web_company_info'];
      sources = validateSources(req.body.sources, ['web_search']) as typeof sources;
      webSearchTemplate = validateOptionalTemplate(req.body.webSearchTemplate, 'webSearchTemplate');
      linkedinSearchTemplate = validateOptionalTemplate(req.body.linkedinSearchTemplate, 'linkedinSearchTemplate');
      sourcesPerField = validateSourcesPerField(req.body.sourcesPerField) as typeof sourcesPerField;
      fieldDescriptions = validateFieldDescriptions(req.body.fieldDescriptions);
    } catch (err: any) {
      if (err instanceof EnrichmentInputError) {
        return res.status(400).json({ message: err.message });
      }
      throw err;
    }

    const { CrmEnrichmentService } = await import('../services/crmEnrichmentService');

    let responseBody: object;

    if (mode === 'preview') {
      const service = new CrmEnrichmentService();
      const result = await service.preview({
        listId,
        userId,
        instruction,
        outputFields,
        sources,
        forceOverwrite: forceEnrich,
        leadIds,
        webSearchTemplate,
        linkedinSearchTemplate,
        sourcesPerField,
        fieldDescriptions,
      });
      responseBody = {
        success: true,
        totalLeads: result.totalLeads,
        leadsToProcess: result.leadsToProcess,
        alreadyEnrichedCount: result.alreadyEnriched,
        sampleResults: result.samples.map(s => ({
          leadId: s.leadId,
          leadName: [s.lead.firstName, s.lead.lastName].filter(Boolean).join(' ') || s.lead.email || s.leadId,
          fieldResults: s.enrichedFields,
        })),
      };
    } else if (mode === 'enrich') {
      const service = new CrmEnrichmentService();
      const result = await service.execute({
        listId,
        userId,
        instruction,
        outputFields,
        sources,
        forceOverwrite: forceEnrich,
        leadIds,
        webSearchTemplate,
        linkedinSearchTemplate,
        sourcesPerField,
        fieldDescriptions,
      }, socketId);
      responseBody = {
        success: true,
        message: result.failedCount > 0
          ? `Enrichment completed with ${result.processedCount} enriched and ${result.failedCount} failed`
          : result.processedCount === 0
            ? 'No leads to process'
            : `Successfully enriched ${result.processedCount} leads`,
        processedCount: result.processedCount,
        failedCount: result.failedCount,
        skippedCount: result.skippedCount,
        totalLeadsProcessed: result.totalToProcess,
        failureBreakdown: result.failureBreakdown,
      };
    } else {
      return res.status(400).json({ message: 'Invalid mode parameter. Use "preview" or "enrich"' });
    }

    // Persist config (fire-and-forget) so settings are restored when the dialog reopens.
    // `searchQueryTemplates` (per-field map) is deprecated in favour of the top-level
    // webSearchTemplate / linkedinSearchTemplate fields; {} intentionally clears it.
    crmDb.updateSearchQueryTemplates(
      listId,
      {},
      sourcesPerField,
      instruction,
      outputFields,
      webSearchTemplate,
      linkedinSearchTemplate,
      sources,
      fieldDescriptions,
    ).catch((err: unknown) => console.warn(`[CRM] enrich-web ${mode}: failed to save config:`, err));

    return res.json(responseBody);
  } catch (error: any) {
    console.error('Error enriching leads with web company info:', error);
    return res.status(500).json({ message: error.message || 'Failed to enrich leads with web company info' });
  }
});

const TECH_STACK_INSTRUCTION = `Research what software tools, platforms, and services this company uses across their tech stack. Search for: (1) their job postings mentioning required tools/technologies, (2) their website's integrations, apps, or plugins page, (3) any public case studies, partner badges, or technology partnership listings.
For each category, list the specific tool names found (comma-separated), for example "Google Analytics, Mixpanel". If nothing is found for a category, return "Unknown".
- tech_stack_analytics: Analytics and visitor-tracking tools (e.g. Google Analytics, Mixpanel, Heap, Segment)
- tech_stack_cms: CMS or e-commerce platform (e.g. WordPress, Shopify, Webflow, Magento)
- tech_stack_marketing: Marketing automation, email, and CRM tools (e.g. HubSpot, Klaviyo, Mailchimp, Marketo)
- tech_stack_infrastructure: Hosting, CDN, and cloud infrastructure (e.g. AWS, Cloudflare, Netlify, Azure)
- tech_stack_integrations: Other notable integrations and tools (e.g. Stripe, Zendesk, Intercom, Zapier)`;

const TECH_STACK_OUTPUT_FIELDS = [
  'tech_stack_analytics',
  'tech_stack_cms',
  'tech_stack_marketing',
  'tech_stack_infrastructure',
  'tech_stack_integrations',
];

/**
 * @route POST /api/crm/lists/:listId/leads/enrich-tech-stack
 * @desc Discover tech stack for leads via LLM + web search (job postings, integration pages)
 * @access Private
 * @query mode - "preview" (default) or "enrich"
 */
router.post('/lists/:listId/leads/enrich-tech-stack', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    const { listId } = req.params;
    const mode = (req.query.mode as string || 'preview').toLowerCase();
    const forceEnrich = req.body.forceEnrich === true;
    const socketId = typeof req.body.socketId === 'string' ? req.body.socketId : undefined;
    const leadIds: string[] | undefined = Array.isArray(req.body.leadIds) ? req.body.leadIds : undefined;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const list = await crmDb.getLeadListById(listId);
    if (!list) {
      return res.status(404).json({ message: 'Lead list not found' });
    }
    if (!(await canDestructiveCrmList(userId, list))) {
      return res.status(403).json({ message: CRM_EDITOR_REQUIRED_MESSAGE });
    }

    const { CrmEnrichmentService } = await import('../services/crmEnrichmentService');
    const service = new CrmEnrichmentService();
    const spec = {
      listId,
      userId,
      instruction: TECH_STACK_INSTRUCTION,
      outputFields: TECH_STACK_OUTPUT_FIELDS,
      sources: ['web_search' as const],
      forceOverwrite: forceEnrich,
      leadIds,
      apolloTechStack: true,
    };

    if (mode === 'preview') {
      const result = await service.preview(spec);
      const sampleResults = result.samples.map(s => ({
        leadId: s.leadId,
        leadName: [s.lead.firstName, s.lead.lastName].filter(Boolean).join(' ') || s.lead.company || s.lead.email || s.leadId,
        fieldResults: s.enrichedFields,
      }));
      return res.json({
        success: true,
        totalLeads: result.totalLeads,
        leadsToProcess: result.leadsToProcess,
        alreadyEnrichedCount: result.alreadyEnriched,
        sampleResults,
      });
    }

    if (mode === 'enrich') {
      const result = await service.execute(spec, socketId, {
        progressEvent: 'crm-tech-stack-progress',
        completeEvent: 'crm-tech-stack-complete',
      });
      return res.json({
        success: true,
        message: result.failedCount > 0
          ? `Completed: ${result.processedCount} enriched, ${result.failedCount} failed`
          : `Successfully enriched ${result.processedCount} leads`,
        processedCount: result.processedCount,
        failedCount: result.failedCount,
        nodomainCount: 0,
      });
    }

    return res.status(400).json({ message: 'Invalid mode. Use "preview" or "enrich"' });
  } catch (error: any) {
    console.error('[CRM] enrich-tech-stack error:', error);
    return res.status(500).json({ message: error.message || 'Failed to enrich tech stack' });
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

    if (!(await canAccessCrmList(userId, list))) {
      return res.status(403).json({ message: CRM_SHARING_DISABLED_MESSAGE });
    }

    const result = await crmDb.getLeadEngagements(listId, leadId, userId);
    res.json(result);
  } catch (error: any) {
    console.error('Error fetching lead engagements:', error);
    res.status(500).json({ message: error.message || 'Failed to fetch lead engagements' });
  }
});

/**
 * @route POST /api/crm/lists/:listId/leads/:leadId/sync-linkedin-messages
 * @desc Sync LinkedIn messages from Unipile for a lead into CRM engagement history
 * @access Private
 */
router.post('/lists/:listId/leads/:leadId/sync-linkedin-messages', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    const { listId, leadId } = req.params;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const list = await crmDb.getLeadListById(listId);
    if (!list) {
      return res.status(404).json({ message: 'Lead list not found' });
    }

    if (!(await canDestructiveCrmList(userId, list as any))) {
      return res.status(403).json({ message: CRM_EDITOR_REQUIRED_MESSAGE });
    }

    const lead = await crmDb.getLeadById(listId, leadId);
    if (!lead) {
      return res.status(404).json({ message: 'Lead not found' });
    }

    const leadLinkedIn = (lead.linkedin as string | undefined)?.toLowerCase();
    if (!leadLinkedIn) {
      return res.status(400).json({ message: 'Lead has no LinkedIn URL — add a LinkedIn profile URL to this lead first' });
    }

    const { linkedInOutreachService } = await import('../services/linkedInOutreachService');
    // Prefer the account explicitly assigned to this list (its LinkedIn relationships
    // live there); fall back to the user's OWN connected account. Do NOT fall back to
    // the site-wide shared pool — syncing must run from a LinkedIn sender the user
    // actually configured, otherwise it would read messages from an unrelated account.
    const accountId = (list as any).linkedInAccountId || await linkedInOutreachService.resolveUserOwnedAccountId(userId);
    if (!accountId) {
      return res.status(400).json({ message: 'No LinkedIn account connected. Connect a LinkedIn account in Settings first.' });
    }

    // Only sync message history for leads who are genuine 1st-degree connections of this
    // account. For non-connected attendees Unipile resolves to an unrelated chat, which
    // would otherwise dump hundreds of messages from other conversations onto this lead
    // (observed: a non-connected lead showing the user's entire multi-year sent history).
    // The connection cache is refreshed every ~10 min by linkedInConnectionSyncCron, which
    // matches the panel's 10-min auto-sync throttle.
    const { getConnectionByProfileUrlAndAccount } = await import('../services/unipileConnectionsDb');
    const connection = await getConnectionByProfileUrlAndAccount(leadLinkedIn, accountId);
    if (!connection) {
      // Stamp syncAt so the panel's auto-sync does not re-hit Unipile on every open.
      const skippedAt = new Date().toISOString();
      await crmDb.updateLeadLinkedInSyncAt(listId, leadId, skippedAt);
      return res.json({ synced: 0, connected: false, syncedAt: skippedAt });
    }

    const providerId = await linkedInOutreachService.resolveProviderId(leadLinkedIn, true, accountId);
    // Pass accountId so Unipile can identify which side is is_sender=1 (outbound vs inbound).
    // Key eventId on msg.provider_id (stable) not msg.id (ephemeral) to prevent duplicate rows on re-sync.
    const messages = await linkedInOutreachService.getMessagesWithContact(providerId, accountId);

    const { emailEventsDb } = await import('../services/emailEventsDb');
    const emailDomain = `linkedin-${listId}`;
    const syncAt = new Date().toISOString();

    await Promise.all([
      ...messages.map((msg: any) => emailEventsDb.addLinkedInMessageEvent({
        eventId: `linkedin_msg_${msg.provider_id}`,
        emailDomain,
        leadEmail: leadLinkedIn,
        eventType: msg.is_sender === 1 ? 'linkedin.message.sent' : 'linkedin.message.received',
        text: msg.text ?? null,
        timestamp: msg.timestamp,
        senderId: msg.sender_id,
        messageProviderId: msg.provider_id,
      })),
      crmDb.updateLeadLinkedInSyncAt(listId, leadId, syncAt),
    ]);

    return res.json({ synced: messages.length, connected: true, syncedAt: syncAt });
  } catch (error: any) {
    console.error('Error syncing LinkedIn messages:', error);
    return res.status(500).json({ message: error.message || 'Failed to sync LinkedIn messages' });
  }
});

/**
 * @route POST /api/crm/lists/:listId/leads/:leadId/sync-linkedin-connection
 * @desc Check whether this lead has accepted our LinkedIn connection request and activate
 *       any awaiting_connection enrollment for this lead.
 * @access Private
 */
router.post('/lists/:listId/leads/:leadId/sync-linkedin-connection', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    const { listId, leadId } = req.params;

    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const list = await crmDb.getLeadListById(listId);
    if (!list || !(await canDestructiveCrmList(userId, list as any))) {
      return res.status(404).json({ message: 'Lead list not found' });
    }

    const lead = await crmDb.getLeadById(listId, leadId);
    if (!lead) return res.status(404).json({ message: 'Lead not found' });

    const leadLinkedIn = (lead.linkedin as string | undefined)?.trim().toLowerCase();
    if (!leadLinkedIn) {
      return res.status(400).json({ message: 'Lead has no LinkedIn URL' });
    }

    const accountId: string | null = (list as any).linkedInAccountId ?? null;
    if (!accountId) {
      return res.status(400).json({ message: 'No LinkedIn account assigned to this list' });
    }

    const { syncConnectionsForAccount } = await import('../cron/linkedInConnectionSyncCron');
    const { getConnectionByProfileUrlAndAccount } = await import('../services/unipileConnectionsDb');

    // Refresh the cache for this account (quick, not full sync)
    await syncConnectionsForAccount(accountId);

    // Check if this specific lead is now connected — scoped to the list's assigned account only
    const connection = await getConnectionByProfileUrlAndAccount(leadLinkedIn, accountId);
    const isConnected = !!connection;

    return res.json({ isConnected, syncedAt: new Date().toISOString() });
  } catch (error: any) {
    console.error('Error syncing LinkedIn connection:', error);
    return res.status(500).json({ message: error.message || 'Failed to sync LinkedIn connection' });
  }
});

/**
 * @route POST /api/crm/check-linkedin-connections
 * @desc User-level variant — no listId required. Returns which LinkedIn profile URLs
 *       are 1st-degree connections. Used by the Inbox view which spans all lists.
 * @body { urls: string[] }
 * @access Private
 */
router.post('/check-linkedin-connections', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    const { urls, listId: inboxListId } = req.body;

    if (!userId) return res.status(401).json({ message: 'Unauthorized' });
    if (!Array.isArray(urls) || urls.length === 0) return res.json({ connected: [], invited: [] });

    // InboxView spans multiple lists — use the linkedInAccountId from the first list
    // that has one configured. If none of the user's lists have one, return empty.
    let accountId: string | null = null;
    if (inboxListId) {
      const inboxList = await crmDb.getLeadListById(inboxListId);
      accountId = (inboxList as any)?.linkedInAccountId ?? null;
    }
    if (!accountId) {
      const userLists = await crmDb.getLeadListsByUserId(userId);
      for (const l of userLists as any[]) {
        if (l.linkedInAccountId) { accountId = l.linkedInAccountId; break; }
      }
    }
    if (!accountId) return res.json({ connected: [], invited: [] });

    const { getConnectionByProfileUrlAndAccount } = await import('../services/unipileConnectionsDb');
    const { getSentInvitationByProfileUrlAndAccount } = await import('../services/unipileSentInvitationsDb');

    const connected: Array<{ url: string; connectedAt: number | null }> = [];
    const invited: Array<{ url: string; sentAt: string | null }> = [];
    await Promise.all(urls.map(async (url: string) => {
      const normalizedUrl = url.trim().toLowerCase().replace(/\/?$/, '/');
      const conn = await getConnectionByProfileUrlAndAccount(url, accountId!).catch(() => null);
      if (conn) {
        connected.push({ url: normalizedUrl, connectedAt: conn.connectedAt ?? null });
        return;
      }
      const inv = await getSentInvitationByProfileUrlAndAccount(url, accountId!).catch(() => null);
      if (inv) invited.push({ url: normalizedUrl, sentAt: inv.sentAt ?? null });
    }));

    return res.json({ connected, invited });
  } catch (error: any) {
    console.error('Error checking LinkedIn connections:', error);
    return res.status(500).json({ message: error.message || 'Failed to check LinkedIn connections' });
  }
});

/**
 * @route POST /api/crm/lists/:listId/check-linkedin-connections
 * @desc Given a list of LinkedIn profile URLs, returns which ones are already 1st-degree
 *       connections in the AW-UnipileConnections cache. Used to render connection status
 *       indicators on leads in the CRM table.
 * @body { urls: string[] }
 * @access Private
 */
router.post('/lists/:listId/check-linkedin-connections', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    const { listId } = req.params;
    const { urls } = req.body;

    if (!userId) return res.status(401).json({ message: 'Unauthorized' });
    if (!Array.isArray(urls) || urls.length === 0) return res.json({ connected: [] });

    const list = await crmDb.getLeadListById(listId);
    if (!list || !(await canAccessCrmList(userId, list as any))) {
      return res.status(404).json({ message: 'Lead list not found' });
    }

    // Only check connections using the LinkedIn account explicitly assigned to this list.
    // No fallback to user-level or site-wide accounts.
    const accountId: string | null = (list as any).linkedInAccountId ?? null;
    if (!accountId) return res.json({ connected: [], invited: [] });

    const { getConnectionByProfileUrlAndAccount } = await import('../services/unipileConnectionsDb');
    const { getSentInvitationByProfileUrlAndAccount } = await import('../services/unipileSentInvitationsDb');

    const connected: Array<{ url: string; connectedAt: number | null }> = [];
    const invited: Array<{ url: string; sentAt: string | null }> = [];
    await Promise.all(urls.map(async (url: string) => {
      const normalizedUrl = url.trim().toLowerCase().replace(/\/?$/, '/');
      const conn = await getConnectionByProfileUrlAndAccount(url, accountId).catch(() => null);
      if (conn) {
        connected.push({ url: normalizedUrl, connectedAt: conn.connectedAt ?? null });
        return; // already connected — pending-invite state is irrelevant
      }
      const inv = await getSentInvitationByProfileUrlAndAccount(url, accountId).catch(() => null);
      if (inv) invited.push({ url: normalizedUrl, sentAt: inv.sentAt ?? null });
    }));

    return res.json({ connected, invited });
  } catch (error: any) {
    console.error('Error checking LinkedIn connections:', error);
    return res.status(500).json({ message: error.message || 'Failed to check LinkedIn connections' });
  }
});

/**
 * @route POST /api/crm/lists/:listId/sync-linkedin-connections
 * @desc Full resync of LinkedIn connections for this list — checks all awaiting_connection
 *       enrollments in the list and activates any whose lead has connected.
 * @access Private
 */
router.post('/lists/:listId/sync-linkedin-connections', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    const { listId } = req.params;

    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const list = await crmDb.getLeadListById(listId);
    if (!list || !(await canDestructiveCrmList(userId, list as any))) {
      return res.status(404).json({ message: 'Lead list not found' });
    }

    const { linkedInOutreachService } = await import('../services/linkedInOutreachService');
    const accountId = await linkedInOutreachService.resolveAccountId(userId);
    if (!accountId) {
      return res.status(400).json({ message: 'No LinkedIn account connected' });
    }

    const { syncConnectionsForAccount } = await import('../cron/linkedInConnectionSyncCron');

    // Full sync — paginate through all connections for this account
    const synced = await syncConnectionsForAccount(accountId, { fullSync: true });

    return res.json({ synced: synced.length, syncedAt: new Date().toISOString() });
  } catch (error: any) {
    console.error('Error syncing LinkedIn connections for list:', error);
    return res.status(500).json({ message: error.message || 'Failed to sync LinkedIn connections' });
  }
});

/**
 * @route POST /api/crm/lists/:listId/leads/:leadId/send-linkedin-message
 * @desc Send a LinkedIn direct message to a lead via Unipile
 * @access Private
 */
router.post('/lists/:listId/leads/:leadId/send-linkedin-message', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    const { listId, leadId } = req.params;
    const { message, accountId: requestedAccountId } = req.body;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ message: 'message is required' });
    }

    const list = await crmDb.getLeadListById(listId);
    if (!list || !(await canDestructiveCrmList(userId, list as any))) {
      return res.status(404).json({ message: 'Lead list not found' });
    }

    const lead = await crmDb.getLeadById(listId, leadId);
    if (!lead) {
      return res.status(404).json({ message: 'Lead not found' });
    }

    const leadLinkedIn = (lead.linkedin as string | undefined)?.trim();
    if (!leadLinkedIn) {
      return res.status(400).json({ message: 'Lead has no LinkedIn URL — add a LinkedIn profile URL first' });
    }

    const { linkedInOutreachService } = await import('../services/linkedInOutreachService');
    // Use the caller-specified account (user's configured default) if provided, otherwise auto-resolve
    const accountId = (requestedAccountId && typeof requestedAccountId === 'string')
      ? requestedAccountId
      : await linkedInOutreachService.resolveAccountId(userId);
    if (!accountId) {
      return res.status(400).json({ message: 'No LinkedIn account connected. Connect LinkedIn outreach in Settings first.' });
    }

    await linkedInOutreachService.sendMessage(accountId, leadLinkedIn, true, message.trim());

    // Record the engagement
    const { emailEventsDb } = await import('../services/emailEventsDb');
    const emailDomain = `linkedin-${listId}`;
    const leadLinkedInKey = leadLinkedIn.toLowerCase();
    await emailEventsDb.addLinkedInMessageEvent({
      eventId: `linkedin_sent_${Date.now()}_${leadId}`,
      emailDomain,
      leadEmail: leadLinkedInKey,
      eventType: 'linkedin.message.sent',
      text: message.trim(),
      timestamp: new Date().toISOString(),
      senderId: accountId,
      messageProviderId: '',
    });

    return res.json({ success: true });
  } catch (error: any) {
    console.error('Error sending LinkedIn message:', error);
    if (error.message?.startsWith('Cannot send message:')) {
      return res.status(400).json({ message: error.message });
    }
    return res.status(500).json({ message: error.message || 'Failed to send LinkedIn message' });
  }
});

/**
 * @route POST /api/crm/lists/:listId/leads/:leadId/send-linkedin-invite
 * @desc Send a LinkedIn connection invitation to a lead via Unipile, with an optional personalised note.
 *       Records linkedInInviteSentAt on the lead so the UI can show "invite sent" state.
 * @access Private
 */
router.post('/lists/:listId/leads/:leadId/send-linkedin-invite', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    const { listId, leadId } = req.params;
    const { message, accountId: requestedAccountId, on_note_quota: onNoteQuotaDecision } = req.body;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const list = await crmDb.getLeadListById(listId);
    if (!list || !(await canDestructiveCrmList(userId, list as any))) {
      return res.status(404).json({ message: 'Lead list not found' });
    }

    const lead = await crmDb.getLeadById(listId, leadId);
    if (!lead) {
      return res.status(404).json({ message: 'Lead not found' });
    }

    const leadLinkedIn = (lead.linkedin as string | undefined)?.trim();
    if (!leadLinkedIn) {
      return res.status(400).json({ message: 'Lead has no LinkedIn URL — add a LinkedIn profile URL first' });
    }

    const { linkedInOutreachService } = await import('../services/linkedInOutreachService');
    // Use the caller-specified account if provided, then the list-assigned account,
    // then the user's OWN connected account. Do NOT fall back to the site-wide shared
    // pool — an invite must be sent from a LinkedIn sender the user actually configured,
    // never silently from a shared account they never connected.
    const accountId = (requestedAccountId && typeof requestedAccountId === 'string')
      ? requestedAccountId
      : ((list as any).linkedInAccountId || await linkedInOutreachService.resolveUserOwnedAccountId(userId));
    if (!accountId) {
      return res.status(400).json({ message: 'No LinkedIn account connected. Connect LinkedIn outreach in Settings first.' });
    }

    const note = message && typeof message === 'string' && message.trim() ? message.trim() : undefined;
    // Premium accounts allow 300-char invites; free accounts 200. Resolve per-account.
    const inviteCharLimit = await linkedInOutreachService.getInviteCharLimitForAccount(userId, accountId);

    // Note-quota policy (ENG-213). By default we HOLD rather than silently drop a note
    // the customer deliberately wrote: if the monthly note quota is spent, the service
    // throws `noteQuotaExceeded` and we return a decision gate so the UI can ask
    // "send without note / cancel". The customer's answer comes back as
    // `on_note_quota: 'send_without_note'`, which authorizes the note-less send.
    const onNoteQuota: 'send_without_note' | 'skip' =
      onNoteQuotaDecision === 'send_without_note' ? 'send_without_note' : 'skip';

    let inviteResult: any;
    try {
      inviteResult = await linkedInOutreachService.sendInvitation(
        accountId, leadLinkedIn, true, note, inviteCharLimit, { onNoteQuota },
      );
    } catch (inviteErr: any) {
      if (inviteErr?.noteQuotaExceeded) {
        // Held — nothing was sent and the lead is NOT marked invited. Ask the customer.
        return res.json({
          success: false,
          noteQuotaExceeded: true,
          message: inviteErr.message || 'LinkedIn note quota reached — the personalized note could not be attached.',
        });
      }
      throw inviteErr;
    }
    // When the customer authorized a note-less send, the note was NOT delivered — don't
    // record it as sent, or the cache/UI would falsely imply the personalization went out.
    const noteDropped = !!(inviteResult && (inviteResult as any).note_dropped);

    const sentAt = new Date().toISOString();
    // Unipile's own id for this invitation — the stable identity the CRM mirror and
    // the pending-invite cache both key on, so a later re-mirror of the same still
    // pending invite is recognised rather than logged again.
    const sentInvitationId = (inviteResult && (inviteResult.invitation_id || inviteResult.id)) || '';
    // ENG-787: mirror the invite back into the CRM as a lead-level record — mark the
    // lead 'contacted', stamp linkedInInviteSentAt, and log a linkedin.invite.sent
    // engagement so contact volume is attributed and follow-up cadence can fire.
    // Best-effort: a CRM write must never fail an invite Unipile already accepted.
    try {
      const { mirrorLinkedInInviteToCrm } = await import('../services/linkedInInviteCrmMirror');
      await mirrorLinkedInInviteToCrm({
        userId,
        listId,
        leadId,
        linkedinUrl: leadLinkedIn,
        firstName: lead.firstName as string | undefined,
        lastName: lead.lastName as string | undefined,
        company: lead.company as string | undefined,
        title: lead.title as string | undefined,
        note: noteDropped ? undefined : note,
        accountId,
        invitationId: sentInvitationId,
        sentAt,
      });
    } catch (mirrorErr) {
      console.warn('Failed to mirror LinkedIn invite to CRM (non-fatal):', mirrorErr);
      // Fall back to at least stamping the timestamp so the UI still shows "invite sent".
      await crmDb.updateLead(listId, leadId, { linkedInInviteSentAt: sentAt }).catch(() => {});
    }

    // Record the pending invitation in the cache immediately so the UI shows
    // "Invitation pending" and suppresses re-inviting without waiting for the
    // ~10-min cron. The cron later reconciles (prunes once accepted/withdrawn).
    try {
      const { upsertSentInvitation } = await import('../services/unipileSentInvitationsDb');
      const { normalizeLinkedInUrl } = await import('../services/unipileConnectionsDb');
      const normalized = normalizeLinkedInUrl(leadLinkedIn);
      const publicId = normalized.replace(/\/$/, '').split('/in/')[1] || normalized;
      await upsertSentInvitation({
        accountId,
        invitedUserPublicId: publicId,
        publicProfileUrl: normalized,
        invitationId: sentInvitationId,
        invitedUserName: [lead.firstName, lead.lastName].filter(Boolean).join(' ') || '',
        invitationText: noteDropped ? '' : (note ?? ''),
        sentAt,
        syncedAt: sentAt,
      });
    } catch (cacheErr) {
      console.warn('Failed to cache sent invitation (non-fatal):', cacheErr);
    }

    return res.json({ success: true, linkedInInviteSentAt: sentAt, noteDropped });
  } catch (error: any) {
    console.error('Error sending LinkedIn invite:', error);
    return res.status(500).json({ message: error.message || 'Failed to send LinkedIn invite' });
  }
});

/**
 * @route POST /api/crm/lists/:listId/leads/:leadId/draft-invite-note
 * @desc Generate a LinkedIn connection invite note (≤300 chars) using Gemini.
 *       Does NOT require an email draft — drafts directly from lead profile + brand guidelines.
 * @access Private
 */
router.post('/lists/:listId/leads/:leadId/draft-invite-note', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    const { listId, leadId } = req.params;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const list = await crmDb.getLeadListById(listId);
    if (!list || !(await canAccessCrmList(userId, list as any))) {
      return res.status(404).json({ message: 'Lead list not found' });
    }

    const lead = await crmDb.getLeadById(listId, leadId);
    if (!lead) {
      return res.status(404).json({ message: 'Lead not found' });
    }

    // Resolve the LinkedIn account that will send this invite (same precedence as
    // send-linkedin-invite) so the note is drafted to the right char limit: 300 for
    // Premium accounts, 200 for free. Falls back to 200 when no account resolves.
    const { linkedInOutreachService, LinkedInOutreachService } = await import('../services/linkedInOutreachService');
    const { accountId: requestedAccountId } = req.body || {};
    const inviteAccountId = (requestedAccountId && typeof requestedAccountId === 'string')
      ? requestedAccountId
      : ((list as any).linkedInAccountId || await linkedInOutreachService.resolveUserOwnedAccountId(userId));
    const inviteCharLimit = inviteAccountId
      ? await linkedInOutreachService.getInviteCharLimitForAccount(userId, inviteAccountId)
      : 200;

    const { agentModeService } = await import('../services/agentModeService');

    // Get brand guidelines for context
    const brandGuidelines = await agentModeService.readBrandGuidelines(userId);
    const brandContext = brandGuidelines?.exists && brandGuidelines?.content
      ? `\nSender context: ${String(brandGuidelines.content).slice(0, 500)}`
      : '';

    const firstName = (lead as any).firstName || '';
    const lastName = (lead as any).lastName || '';
    const title = (lead as any).title || '';
    const company = (lead as any).company || '';
    const notes = (lead as any).notes || '';
    const leadName = [firstName, lastName].filter(Boolean).join(' ') || 'this person';

    const leadDesc = [leadName !== 'this person' ? leadName : null, title, company ? `at ${company}` : null].filter(Boolean).join(', ');
    const notesLine = notes ? `\nWhat we know about them: ${notes.slice(0, 300)}` : '';
    const senderContext = brandContext ? `\nSender context: ${brandContext.replace('\nSender context: ', '').slice(0, 400)}` : '';

    const prompt = `You are writing a LinkedIn connection request note. The goal is to get the recipient to accept.

Recipient: ${leadDesc}${notesLine}${senderContext}

Write a note that:
- Leads with something specific and genuine about THEIR work, role, or company — show you actually looked them up
- Explains briefly WHY you want to connect in a way that's relevant to them (shared space, complementary work, genuine curiosity)
- Sounds like one human writing to another — warm, direct, no corporate speak
- Is under ${inviteCharLimit} characters total (hard LinkedIn limit for this account)
- Opens with their first name naturally (e.g. "John, saw your work on..." or "Sarah —")
- Does NOT start with Hi or Hello
- Does NOT have a call to action or ask ("would love to chat", "let's connect")
- Does NOT use: synergy, opportunity, exciting, leverage, passionate, innovative, value-add
- No emojis

Bad example: "Your work in enterprise security is impressive. Would love to connect and explore potential synergies."
Good example: "Sarah, Island's browser-isolation approach is one of the smarter takes on shadow IT I've seen — solves the problem without blocking employees."

Reply with ONLY valid JSON, nothing else: {"content": "the note text"}`;

    const geminiClient = await agentModeService.getGeminiClient();
    const completion = await (geminiClient as any).chat.completions.create({
      model: 'gemini-3.5-flash',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.8,
      max_tokens: 2048,
    });
    // Meter this direct Gemini draft generation (bypasses callLLM): shadow analytics +
    // the per-user cap, matching the invite-note shortener path for the same feature.
    meterUsageFromResponse({
      userId,
      model: 'gemini-3.5-flash',
      provider: 'gemini',
      feature: 'invite_note_generate',
    }, completion);

    const raw = completion.choices[0].message.content || '';
    let rawNote = '';
    // Strip markdown fences
    let cleaned = raw.replace(/```json\s*/g, '').replace(/\s*```/g, '').trim();
    // If truncated mid-JSON (ends with a quote but no closing brace), complete it
    if (cleaned.includes('"content"') && !cleaned.endsWith('}')) {
      if (!cleaned.endsWith('"')) cleaned += '"';
      cleaned += '}';
    }
    const braceStart = cleaned.indexOf('{');
    const braceEnd = cleaned.lastIndexOf('}');
    if (braceStart !== -1 && braceEnd > braceStart) {
      try {
        const parsed = JSON.parse(cleaned.slice(braceStart, braceEnd + 1));
        let val = String(parsed.content || '');
        // Gemini sometimes double-encodes: the value is itself JSON like {"content":"..."}
        if (val.startsWith('{') && val.includes('"content"')) {
          try { val = String(JSON.parse(val).content || val); } catch { /* keep val */ }
        }
        rawNote = val;
      } catch {
        // Still can't parse — extract the text between the first " and last "
        const firstQ = cleaned.indexOf('"', cleaned.indexOf('"content"') + 10);
        const lastQ = cleaned.lastIndexOf('"');
        if (firstQ !== -1 && lastQ > firstQ) {
          rawNote = cleaned.slice(firstQ + 1, lastQ).replace(/\\"/g, '"');
        }
      }
    }

    if (!rawNote) {
      return res.status(500).json({ message: 'Failed to generate invite note' });
    }

    // Layer 2: if the draft is over the limit, ask the model to rewrite it shorter (capped),
    // then Layer 3: hard-trim on a sentence/word boundary (surrogate-safe) as the guarantee —
    // the same trimInviteMessage() sendInvitation uses, so every invite-note path is consistent.
    if (rawNote.length > inviteCharLimit) {
      const { shortenInviteNoteToLimit } = await import('../services/inviteNoteShortener');
      rawNote = await shortenInviteNoteToLimit(geminiClient, rawNote, inviteCharLimit, 2);
    }
    const content = LinkedInOutreachService.trimInviteMessage(rawNote, inviteCharLimit);

    if (!content) {
      return res.status(500).json({ message: 'Failed to generate invite note' });
    }

    return res.json({ success: true, content });
  } catch (error: any) {
    console.error('Error drafting invite note:', error);
    return res.status(500).json({ message: error.message || 'Failed to draft invite note' });
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

    if (!(await canDestructiveCrmList(userId, list))) {
      return res.status(403).json({ message: CRM_EDITOR_REQUIRED_MESSAGE });
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
    res.json({ success: true, lead: sanitizeLeadForResponse(updatedLead) });
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

    if (!(await canDestructiveCrmList(userId, list))) {
      return res.status(403).json({ message: CRM_EDITOR_REQUIRED_MESSAGE });
    }

    const engagement = {
      eventType,
      eventData: eventData || {},
      createdAt,
    };

    const updatedLead = await crmDb.updateLeadEngagement(listId, leadId, eventId, engagement);
    res.json({ success: true, lead: sanitizeLeadForResponse(updatedLead) });
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

    if (!(await canDestructiveCrmList(userId, list))) {
      return res.status(403).json({ message: CRM_EDITOR_REQUIRED_MESSAGE });
    }

    const updatedLead = await crmDb.deleteLeadEngagement(listId, leadId, eventId);
    res.json({ success: true, lead: sanitizeLeadForResponse(updatedLead) });
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

    // Connected mailboxes the frontend can offer as sender options.
    // `connectedEmailAccounts` covers every mailbox provider; `connectedGmailAccounts`
    // is kept so the existing portal build keeps working until it migrates.
    let connectedEmailAccounts: Array<{ account_id: string; account_name: string; email: string; platform: string }> = [];
    try {
      const user = await userDb.getUserById(userId);
      connectedEmailAccounts = (user?.connected_accounts || [])
        .filter((a: any) => MAILBOX_PROVIDERS.includes(a.platform))
        .map((a: any) => ({
          account_id: a.account_id,
          account_name: a.account_name,
          email: a.config?.email || a.account_id,
          platform: a.platform,
        }));
    } catch (_) {
      // Non-fatal — proceed without connected accounts
    }
    const connectedGmailAccounts = connectedEmailAccounts
      .filter((a) => a.platform === 'gmail')
      .map(({ platform, ...rest }) => rest);

    const config = await loadSenderConfig(userId);

    // Emit both shapes: the legacy keys (senderType / gmailAccountId) so the
    // current portal keeps rendering, and the neutral ones the new UI reads.
    const senders = config.senders.map((s) => ({
      ...serializeSender(s),
      senderProvider: s.senderProvider,
      connectedAccountId: s.connectedAccountId,
    }));

    res.json({
      senders,
      defaultSenderId: config.defaultSenderId,
      defaultLinkedInAccountId: config.defaultLinkedInAccountId,
      connectedEmailAccounts,
      connectedGmailAccounts,
    });
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

    const { senders, defaultSenderId, defaultLinkedInAccountId } = req.body;

    // Validate senders array
    if (!Array.isArray(senders)) {
      return res.status(400).json({ message: 'Senders must be an array' });
    }

    // Mailbox senders are validated against the user's connected accounts: the
    // provider sends as the authenticated mailbox, so a mismatched From would be
    // silently ignored on the wire. Reject it here, where we can say so.
    let userConnectedAccounts: any[] = [];
    try {
      const user = await userDb.getUserById(userId);
      userConnectedAccounts = user?.connected_accounts || [];
    } catch (_) {
      // Non-fatal — validateSender will reject mailbox senders if we can't confirm the account
    }

    // Grandfather in senders that are unchanged from what's already persisted.
    // The frontend always posts the FULL sender list on every save (not a diff),
    // so without this, one stale sender (e.g. a disconnected account left over
    // from before) would permanently block adding or editing ANY other sender —
    // a real dead end with no recovery path (ENG-266 friction, found in live
    // testing). Only senders that are new or genuinely modified get re-validated.
    const existingConfig = await loadSenderConfig(userId);
    const existingById = new Map(existingConfig.senders.map((s) => [s.id, s]));

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

      const existing = sender.id ? existingById.get(sender.id) : undefined;
      const unchanged = existing && JSON.stringify(normalizeSender(sender)) === JSON.stringify(existing);
      if (unchanged) {
        continue;
      }

      const validation = validateSender(sender, userConnectedAccounts);
      if (!validation.ok) {
        return res.status(400).json({ message: validation.error });
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

    // Validate defaultLinkedInAccountId if provided
    if (defaultLinkedInAccountId !== null && defaultLinkedInAccountId !== undefined) {
      if (typeof defaultLinkedInAccountId !== 'string') {
        return res.status(400).json({ message: 'defaultLinkedInAccountId must be a string' });
      }
    }

    const settingName = senderSettingName(userId);
    const config: any = {
      senders: senders.map((s: any, index: number) =>
        serializeSender({
          id: s.id || index.toString(),
          email: s.email.trim(),
          fromName: s.fromName.trim(),
          notes: s.notes ? s.notes.trim() : undefined,
          senderProvider: s.senderProvider ?? s.senderType ?? 'resend',
          connectedAccountId: s.connectedAccountId ?? s.gmailAccountId,
        }),
      ),
      defaultSenderId: defaultSenderId || (senders.length > 0 ? senders[0].id || '0' : null),
      defaultLinkedInAccountId: defaultLinkedInAccountId || null
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
 * @route POST /api/crm/email-domain
 * @desc Create (register) an email domain in Resend for the authenticated user
 * @access Private
 */
router.post('/email-domain', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { domain } = req.body;

    if (!domain || typeof domain !== 'string') {
      return res.status(400).json({ message: 'Domain is required' });
    }

    const normalizedDomain = domain.trim().toLowerCase();

    // Validate domain format
    if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(normalizedDomain)) {
      return res.status(400).json({ message: 'Invalid domain format' });
    }

    // Check if another user already has this domain
    const usersWithDomain = await userDb.getUsersByEmailDomain(normalizedDomain);
    const otherUserWithDomain = usersWithDomain.find(u => u.userId !== userId);
    if (otherUserWithDomain) {
      return res.status(409).json({ message: 'This domain is already in use by another account' });
    }

    // Check if domain already exists in Resend
    const existingDomains = await resendService.listDomains();
    const existingDomain = existingDomains.find(d => d.name === normalizedDomain);

    if (existingDomain) {
      // Domain already exists in Resend — return its current status and records
      const domainDetails = await resendService.getDomain(existingDomain.id);
      if (!domainDetails) {
        return res.status(500).json({ message: 'Failed to retrieve existing domain details' });
      }

      // Save the resend domain ID and domain to the user record
      await userDb.updateUser(userId, {
        emailDomain: normalizedDomain,
        resendDomainId: existingDomain.id,
      });

      return res.json({
        message: 'Domain already registered in Resend',
        domain: domainDetails,
        alreadyExists: true,
      });
    }

    // Create new domain in Resend
    const result = await resendService.createDomain(normalizedDomain);
    if (!result) {
      return res.status(500).json({ message: 'Failed to create domain in Resend' });
    }

    // Save the resend domain ID and domain to the user record
    await userDb.updateUser(userId, {
      emailDomain: normalizedDomain,
      resendDomainId: result.id,
    });

    res.json({
      message: 'Domain created successfully. Add the DNS records below to verify.',
      domain: result,
    });
  } catch (error: any) {
    console.error('Error creating email domain:', error);
    res.status(500).json({ message: error.message || 'Failed to create email domain' });
  }
});

/**
 * @route DELETE /api/crm/email-domain
 * @desc Reset (clear) the user's email domain so they can register a different one
 * @access Private
 */
router.delete('/email-domain', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const user = await userDb.getUserById(userId);
    if (!user?.resendDomainId && !user?.emailDomain) {
      return res.status(400).json({ message: 'No domain configured to reset' });
    }

    // Clear domain fields from user record (don't delete from Resend — may be shared or reused)
    await userDb.updateUser(userId, {
      emailDomain: '',
      resendDomainId: '',
    });

    res.json({ message: 'Email domain reset. You can now register a different domain.' });
  } catch (error: any) {
    console.error('Error resetting email domain:', error);
    res.status(500).json({ message: error.message || 'Failed to reset email domain' });
  }
});

/**
 * @route POST /api/crm/email-domain/verify
 * @desc Trigger domain verification in Resend
 * @access Private
 */
router.post('/email-domain/verify', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const user = await userDb.getUserById(userId);
    if (!user?.resendDomainId) {
      return res.status(400).json({ message: 'No domain configured. Please add a domain first.' });
    }

    // Trigger verification
    await resendService.verifyDomain(user.resendDomainId);

    // Fetch updated domain status
    const domainDetails = await resendService.getDomain(user.resendDomainId);
    if (!domainDetails) {
      return res.status(500).json({ message: 'Failed to retrieve domain status after verification' });
    }

    res.json({
      message: domainDetails.status === 'verified'
        ? 'Domain verified successfully!'
        : 'Verification triggered. DNS records may take a few minutes to propagate.',
      domain: domainDetails,
    });
  } catch (error: any) {
    console.error('Error verifying email domain:', error);
    res.status(500).json({ message: error.message || 'Failed to verify email domain' });
  }
});

/**
 * @route GET /api/crm/email-domain/status
 * @desc Get email domain status and DNS records for the authenticated user
 * @access Private
 */
router.get('/email-domain/status', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const user = await userDb.getUserById(userId);

    if (!user?.resendDomainId) {
      return res.json({
        hasEmailDomain: !!user?.emailDomain,
        emailDomain: user?.emailDomain || null,
        resendDomainId: null,
        domainStatus: null,
        records: [],
      });
    }

    const domainDetails = await resendService.getDomain(user.resendDomainId);

    res.json({
      hasEmailDomain: true,
      emailDomain: user.emailDomain,
      resendDomainId: user.resendDomainId,
      domainStatus: domainDetails?.status || null,
      records: domainDetails?.records || [],
    });
  } catch (error: any) {
    console.error('Error fetching email domain status:', error);
    res.status(500).json({ message: error.message || 'Failed to fetch email domain status' });
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
    const { senderId, senderEmail, senderName, subject, htmlContent, textContent } = req.body;

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
    if (!list || !(await canDestructiveCrmList(userId, list))) {
      return res.status(403).json({ message: CRM_EDITOR_REQUIRED_MESSAGE });
    }

    // ENG-266 Part 3: route through the sender's real provider. If senderId/senderEmail
    // don't resolve to a configured sender (an older client, or an ad-hoc address),
    // fall back to a synthesized resend sender from the raw fields — same as before.
    const resolvedSender = await resolveSenderForSend(userId, senderId, senderEmail);
    const sender: CrmSender = resolvedSender ?? {
      id: '__adhoc__',
      email: senderEmail,
      fromName: senderName,
      senderProvider: 'resend',
    };

    let sendResult;
    try {
      sendResult = await sendAsSender(userId, sender, {
        to: lead.email,
        subject,
        html: htmlContent,
        text: textContent,
      });
    } catch (error: any) {
      console.error('Error sending email:', error);
      return res.status(500).json({ message: error.message || 'Failed to send email' });
    }

    // Remove the email draft after successfully sending
    await crmDb.updateLead(listId, leadId, {
      emailDraft: null
    });

    res.json({
      message: 'Email sent successfully',
      emailId: sendResult.messageId
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
    const { senderId, senderEmail, senderName, subject, htmlContent, messageId } = req.body;

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
    if (!list || !(await canDestructiveCrmList(userId, list))) {
      return res.status(403).json({ message: CRM_EDITOR_REQUIRED_MESSAGE });
    }

    // ENG-266 Part 3: route through the sender's real provider, same fallback as send-email.
    // messageId here is best-effort (see sendAsSender's replyToMessageId docs) — it only
    // "worked" as an RFC In-Reply-To before because every send was hardcoded to Resend.
    const resolvedSender = await resolveSenderForSend(userId, senderId, senderEmail);
    const sender: CrmSender = resolvedSender ?? {
      id: '__adhoc__',
      email: senderEmail,
      fromName: senderName,
      senderProvider: 'resend',
    };

    let sendResult;
    try {
      sendResult = await sendAsSender(userId, sender, {
        to: lead.email,
        subject,
        html: htmlContent,
        replyToMessageId: messageId,
      });
    } catch (error: any) {
      console.error('Error sending reply email:', error);
      return res.status(500).json({ message: error.message || 'Failed to send reply email' });
    }

    res.json({
      message: 'Reply email sent successfully',
      emailId: sendResult.messageId
    });
  } catch (error: any) {
    console.error('Error sending reply email:', error);
    res.status(500).json({ message: error.message || 'Failed to send reply email' });
  }
});

/**
 * @route PUT /api/crm/lists/:listId/public-access
 * @desc Enable or disable public access for a lead list
 * @access Private
 */
router.put('/lists/:listId/public-access', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    const { listId } = req.params;
    const { enabled } = req.body;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ message: 'enabled must be a boolean' });
    }

    // Verify list ownership
    const list = await crmDb.getLeadListById(listId);
    if (!list) {
      return res.status(404).json({ message: 'Lead list not found' });
    }

    if (!(await canDestructiveCrmList(userId, list))) {
      return res.status(403).json({ message: CRM_EDITOR_REQUIRED_MESSAGE });
    }

    const updatedList = await crmDb.updateLeadList(listId, {
      publicAccessEnabled: enabled
    });

    if (!updatedList) {
      return res.status(404).json({ message: 'Lead list not found' });
    }

    res.json({
      success: true,
      publicAccessEnabled: updatedList.publicAccessEnabled,
      message: `Public access ${enabled ? 'enabled' : 'disabled'} successfully`
    });
  } catch (error: any) {
    console.error('Error updating public access:', error);
    res.status(500).json({ message: error.message || 'Failed to update public access' });
  }
});

/**
 * @route PUT /api/crm/lists/:listId/auto-draft
 * @desc Enable or disable auto draft for API-forwarded leads on a lead list
 * @access Private
 */
router.put('/lists/:listId/auto-draft', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    const { listId } = req.params;
    const { enabled, instruction, autoSendEnabled } = req.body;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ message: 'enabled must be a boolean' });
    }

    if (instruction !== undefined && typeof instruction !== 'string') {
      return res.status(400).json({ message: 'instruction must be a string' });
    }

    if (autoSendEnabled !== undefined && typeof autoSendEnabled !== 'boolean') {
      return res.status(400).json({ message: 'autoSendEnabled must be a boolean' });
    }

    const normalizedInstruction = typeof instruction === 'string' ? instruction.trim() : undefined;
    if (normalizedInstruction !== undefined && normalizedInstruction.length > 2000) {
      return res.status(400).json({ message: 'instruction must be 2000 characters or fewer' });
    }

    const list = await crmDb.getLeadListById(listId);
    if (!list) {
      return res.status(404).json({ message: 'Lead list not found' });
    }

    if (!(await canDestructiveCrmList(userId, list))) {
      return res.status(403).json({ message: CRM_EDITOR_REQUIRED_MESSAGE });
    }

    const updatedList = await crmDb.updateLeadList(listId, {
      autoDraftEnabled: enabled,
      ...(normalizedInstruction !== undefined ? { autoDraftInstruction: normalizedInstruction } : {}),
      ...(autoSendEnabled !== undefined ? { autoSendEnabled } : {})
    });

    if (!updatedList) {
      return res.status(404).json({ message: 'Lead list not found' });
    }

    res.json({
      success: true,
      autoDraftEnabled: updatedList.autoDraftEnabled === true,
      autoDraftInstruction: typeof updatedList.autoDraftInstruction === 'string' ? updatedList.autoDraftInstruction : '',
      autoSendEnabled: updatedList.autoSendEnabled === true,
      message: `Auto draft ${enabled ? 'enabled' : 'disabled'} successfully`
    });
  } catch (error: any) {
    console.error('Error updating auto draft:', error);
    res.status(500).json({ message: error.message || 'Failed to update auto draft' });
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

// ============================================================
// Group Email Endpoints
// ============================================================

/**
 * Helper: fetch all leads in a list (paginated)
 */
const fetchAllLeadsForGroupEmail = async (listId: string): Promise<any[]> => {
  let lastKey: any = undefined;
  const items: any[] = [];
  do {
    const result = await crmDb.getLeadsByListId(listId, 200, lastKey);
    items.push(...result.items);
    lastKey = result.lastEvaluatedKey;
  } while (lastKey);
  return items;
};

/**
 * @route POST /api/crm/lists/:listId/group-email/preview
 * @desc Get recipient counts before sending a group email
 */
router.post('/lists/:listId/group-email/preview', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    const { listId } = req.params;
    const { leadIds } = req.body;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const list = await crmDb.getLeadListById(listId);
    if (!list) {
      return res.status(404).json({ message: 'Lead list not found' });
    }
    if (!(await canAccessCrmList(userId, list))) {
      return res.status(403).json({ message: CRM_SHARING_DISABLED_MESSAGE });
    }

    let leads = await fetchAllLeadsForGroupEmail(listId);

    // Filter by leadIds if provided
    if (Array.isArray(leadIds) && leadIds.length > 0) {
      const idSet = new Set(leadIds);
      leads = leads.filter((l: any) => idSet.has(l.leadId));
    }

    const totalLeads = leads.length;
    const doNotContactCount = leads.filter((l: any) => isDoNotContact(l)).length;
    const noEmailCount = leads.filter((l: any) => !l.email).length;
    // Email-deliverability buckets — surfaces risky/undeliverable in the UI so
    // the user can decide before sending. Undeliverable is blocked by default
    // in the send endpoint; user can override per-address.
    const validationStatus = (l: any): string | undefined => l?.customFields?.email_validation?.status;
    const undeliverableLeadsList = leads.filter((l: any) => l.email && validationStatus(l) === 'undeliverable');
    const riskyLeadsList = leads.filter((l: any) => l.email && validationStatus(l) === 'risky');
    const undeliverableCount = undeliverableLeadsList.length;
    const riskyCount = riskyLeadsList.length;
    // Eligibility = has email && not DNC && not undeliverable. Single boolean
    // filter (not arithmetic subtraction) so overlapping categories don't
    // produce negative counts.
    const eligibleLeads = leads.filter((l: any) =>
      l.email && !isDoNotContact(l) && validationStatus(l) !== 'undeliverable',
    ).length;

    // Return small samples (first 50) of email lists so the UI modals can show
    // exactly which addresses fall in each bucket. Cap at 50 to keep payload tight.
    const undeliverableEmails = undeliverableLeadsList.slice(0, 50).map((l: any) => l.email);
    const riskyEmails = riskyLeadsList.slice(0, 50).map((l: any) => l.email);

    return res.json({
      totalLeads,
      eligibleLeads,
      unsubscribedCount: doNotContactCount,
      doNotContactCount,
      noEmailCount,
      undeliverableCount,
      riskyCount,
      undeliverableEmails,
      riskyEmails,
    });
  } catch (error) {
    console.error('Error previewing group email:', error);
    return res.status(500).json({ message: 'Failed to preview group email' });
  }
});

/**
 * @route POST /api/crm/lists/:listId/group-email/prepare
 * @desc Check readiness of leads for sending — validates variable coverage
 */
router.post('/lists/:listId/group-email/prepare', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    const { listId } = req.params;
    const { subject, htmlContent } = req.body;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    if (!subject && !htmlContent) {
      return res.status(400).json({ message: 'subject or htmlContent is required' });
    }

    const list = await crmDb.getLeadListById(listId);
    if (!list) {
      return res.status(404).json({ message: 'Lead list not found' });
    }
    if (!(await canDestructiveCrmList(userId, list))) {
      return res.status(403).json({ message: CRM_EDITOR_REQUIRED_MESSAGE });
    }

    // Extract all variables from subject + htmlContent
    const allTemplate = (subject || '') + (htmlContent || '');
    const variables = extractVariables(allTemplate);

    let leads = await fetchAllLeadsForGroupEmail(listId);

    // Only consider eligible leads (have email, not do-not-contact/unsubscribed)
    const eligibleLeads = leads.filter((l: any) => l.email && !isDoNotContact(l));
    const eligibleCount = eligibleLeads.length;

    // Auto-fix dark mode: inject color-scheme opt-out before format check so
    // the warning doesn't fire for issues we've already resolved.
    const processedHtml = injectColorSchemeMeta(htmlContent || '');
    const formatWarnings = checkEmailFormat(processedHtml);

    if (variables.length === 0) {
      // No variables used — all eligible leads are ready
      return res.json({
        eligibleCount,
        readyCount: eligibleCount,
        notReadyCount: 0,
        variables: [],
        variableCoverage: {},
        formatWarnings,
      });
    }

    // Check each eligible lead for variable coverage
    const variableCoverage: Record<string, { present: number; missing: number }> = {};
    for (const v of variables) {
      variableCoverage[v] = { present: 0, missing: 0 };
    }

    let readyCount = 0;
    for (const lead of eligibleLeads) {
      let allPresent = true;
      for (const v of variables) {
        if (leadHasVariable(lead, v)) {
          variableCoverage[v].present++;
        } else {
          variableCoverage[v].missing++;
          allPresent = false;
        }
      }
      if (allPresent) readyCount++;
    }

    return res.json({
      eligibleCount,
      readyCount,
      notReadyCount: eligibleCount - readyCount,
      variables,
      variableCoverage,
      formatWarnings,
    });
  } catch (error) {
    console.error('Error preparing group email:', error);
    return res.status(500).json({ message: 'Failed to prepare group email' });
  }
});

/**
 * @route POST /api/crm/lists/:listId/group-email/send
 * @desc Send a group email to leads in a list
 */
router.post('/lists/:listId/group-email/send', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    const { listId } = req.params;
    const { socketId, senderId, senderEmail, senderName, subject, htmlContent, textContent, leadIds, unsubscribeFooterHtml, includeUndeliverable, includeUndeliverableEmails } = req.body;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    if (!senderEmail || !senderName || !subject || !htmlContent) {
      return res.status(400).json({ message: 'senderEmail, senderName, subject, and htmlContent are required' });
    }

    // ENG-266 Part 3: route through the sender's real provider. senderId is preferred and
    // unambiguous; senderEmail is the legacy fallback for older clients — falls back to a
    // synthesized resend sender if nothing configured matches (same as before).
    const resolvedSender = await resolveSenderForSend(userId, senderId, senderEmail);
    const sender: CrmSender = resolvedSender ?? {
      id: '__adhoc__',
      email: senderEmail,
      fromName: senderName,
      senderProvider: 'resend',
    };

    const list = await crmDb.getLeadListById(listId);
    if (!list) {
      return res.status(404).json({ message: 'Lead list not found' });
    }
    if (!(await canDestructiveCrmList(userId, list))) {
      return res.status(403).json({ message: CRM_EDITOR_REQUIRED_MESSAGE });
    }

    let leads = await fetchAllLeadsForGroupEmail(listId);

    // Filter by leadIds if provided
    if (Array.isArray(leadIds) && leadIds.length > 0) {
      const idSet = new Set(leadIds);
      leads = leads.filter((l: any) => idSet.has(l.leadId));
    }

    // Separate eligible leads from skipped ones (do-not-contact includes unsubscribed + DNC)
    const skippedDoNotContact = leads.filter((l: any) => isDoNotContact(l)).length;
    let eligibleLeads = leads.filter((l: any) => l.email && !isDoNotContact(l));

    // Filter undeliverable emails. Two override modes:
    //   - includeUndeliverableEmails: string[]  → per-address whitelist (Proposal B)
    //   - includeUndeliverable: true            → blanket override (legacy/Emma)
    // Default: block all undeliverable.
    let skippedUndeliverable = 0;
    if (!includeUndeliverable) {
      const whitelist = new Set<string>(
        Array.isArray(includeUndeliverableEmails)
          ? includeUndeliverableEmails.map((e: string) => String(e).trim().toLowerCase()).filter(Boolean)
          : [],
      );
      const beforeCount = eligibleLeads.length;
      eligibleLeads = eligibleLeads.filter((l: any) => {
        const status = l?.customFields?.email_validation?.status;
        if (status !== 'undeliverable') return true;
        return whitelist.has(String(l.email ?? '').trim().toLowerCase());
      });
      skippedUndeliverable = beforeCount - eligibleLeads.length;
    }

    // Apply dark-mode fix once before per-lead substitution.
    const sendHtml = injectColorSchemeMeta(htmlContent || '');

    // Filter out leads missing required variable values
    const allTemplate = (subject || '') + (sendHtml || '');
    const variables = extractVariables(allTemplate);
    let skippedMissingVars = 0;
    if (variables.length > 0) {
      const beforeCount = eligibleLeads.length;
      eligibleLeads = eligibleLeads.filter((lead: any) =>
        variables.every((v) => leadHasVariable(lead, v))
      );
      skippedMissingVars = beforeCount - eligibleLeads.length;
    }

    const total = eligibleLeads.length;

    // ENG-266 Part 3: a mailbox send (Gmail/Graph) has no shared queue like Resend's, and
    // budgets ~600ms/send (round-trip + throttle) — 50 leads keeps one HTTP request
    // comfortably inside a 60s ALB timeout. Reject up front rather than partway through.
    const MAILBOX_SENDER_LEAD_CAP = 50;
    if (isMailboxSender(sender) && total > MAILBOX_SENDER_LEAD_CAP) {
      return res.status(400).json({
        message: `Sending from a connected mailbox is limited to ${MAILBOX_SENDER_LEAD_CAP} recipients per campaign. This list has ${total} eligible leads.`,
        code: 'MAILBOX_SENDER_LEAD_CAP_EXCEEDED',
      });
    }

    const CUSTOMER_FRONTEND_URL = process.env.CUSTOMER_FRONTEND_URL || 'https://app.agentweb.pro';

    let sent = 0;
    let failed = 0;
    const failedEmails: string[] = [];
    const failureReasons: Array<{ email: string; reason: string }> = [];

    for (const lead of eligibleLeads) {
      try {
        // Substitute variables in subject and content
        const personalizedSubject = substituteVariables(subject, lead);
        let personalizedHtml = substituteVariables(sendHtml, lead);
        const personalizedText = textContent ? substituteVariables(textContent, lead) : undefined;

        // Inject unsubscribe URL — updates existing link or appends footer if none found
        // Signed URL — see backend/src/utils/unsubscribeUrl.ts. Verifier in
        // routes/crmPublic.ts accepts the legacy unsigned form as a fallback
        // for emails sent before this change.
        const unsubscribeUrl = signUnsubscribeUrl({
          baseUrl: CUSTOMER_FRONTEND_URL,
          listId,
          leadId: lead.leadId,
          email: lead.email,
        });
        personalizedHtml = injectUnsubscribeUrl(personalizedHtml, unsubscribeUrl, unsubscribeFooterHtml);

        await sendAsSender(userId, sender, {
          to: lead.email,
          subject: personalizedSubject,
          html: personalizedHtml,
          text: personalizedText,
        });
        sent++;
      } catch (err: any) {
        const reason = err.message || String(err);
        console.error(`Failed to send group email to ${lead.email}:`, reason);
        failed++;
        failedEmails.push(lead.email);
        failureReasons.push({ email: lead.email, reason });
      }

      // Emit progress
      if (socketId) {
        io.to(socketId).emit('group-email-progress', { sent, failed, total });
      }
    }

    return res.json({
      total,
      sent,
      failed,
      failedEmails,
      failureReasons,
      skippedUnsubscribed: skippedDoNotContact,
      skippedDoNotContact,
      skippedMissingVars,
      skippedUndeliverable,
    });
  } catch (error) {
    console.error('Error sending group email:', error);
    return res.status(500).json({ message: 'Failed to send group email' });
  }
});

/**
 * @route POST /api/crm/lists/:listId/group-email/test
 * @desc Send a test group email to specific addresses
 */
router.post('/lists/:listId/group-email/test', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    const { listId } = req.params;
    const { senderId, senderEmail, senderName, subject, htmlContent, textContent, recipients, unsubscribeFooterHtml } = req.body;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    if (!senderEmail || !senderName || !subject || !htmlContent) {
      return res.status(400).json({ message: 'senderEmail, senderName, subject, and htmlContent are required' });
    }

    if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
      return res.status(400).json({ message: 'At least one recipient email is required' });
    }

    const list = await crmDb.getLeadListById(listId);
    if (!list) {
      return res.status(404).json({ message: 'Lead list not found' });
    }
    if (!(await canDestructiveCrmList(userId, list))) {
      return res.status(403).json({ message: CRM_EDITOR_REQUIRED_MESSAGE });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const validEmails = recipients.filter((e: string) => emailRegex.test(e.trim()));

    if (validEmails.length === 0) {
      return res.status(400).json({ message: 'No valid email addresses provided' });
    }

    const CUSTOMER_FRONTEND_URL_TEST = process.env.CUSTOMER_FRONTEND_URL || 'https://app.agentweb.pro';
    const testUnsubscribeUrl = signUnsubscribeUrl({
      baseUrl: CUSTOMER_FRONTEND_URL_TEST,
      listId,
      leadId: 'TEST',
      email: recipients[0]?.trim() || 'test@example.com',
    });

    const testBanner = `<div style="background-color: #ff9800; color: white; padding: 10px; text-align: center; font-weight: bold; margin-bottom: 20px;">TEST EMAIL - This is a test group email</div>`;

    const testBaseHtml = injectColorSchemeMeta(htmlContent);
    // Inject banner: inside <body> for full HTML documents, or prepend for fragments
    const withBanner = /<body\b/i.test(testBaseHtml)
      ? testBaseHtml.replace(/<body([^>]*)>/i, `<body$1>${testBanner}`)
      : testBanner + testBaseHtml;
    // Wire up unsubscribe URL with the real portal domain
    const testHtml = injectUnsubscribeUrl(withBanner, testUnsubscribeUrl, unsubscribeFooterHtml);

    // ENG-266 Part 3: route through the sender's real provider (same fallback as the
    // other send sites). No lead cap here — test sends are inherently small.
    const resolvedSender = await resolveSenderForSend(userId, senderId, senderEmail);
    const sender: CrmSender = resolvedSender ?? {
      id: '__adhoc__',
      email: senderEmail,
      fromName: senderName,
      senderProvider: 'resend',
    };

    let sent = 0;
    let failedCount = 0;
    const failedEmails: string[] = [];
    const failureReasons: Array<{ email: string; reason: string }> = [];

    for (const email of validEmails) {
      try {
        await sendAsSender(userId, sender, {
          to: email.trim(),
          subject: `[TEST] ${subject}`,
          html: testHtml,
          text: textContent,
        });
        sent++;
      } catch (err: any) {
        const reason = err.message || String(err);
        console.error(`Failed to send test group email to ${email}:`, reason);
        failedCount++;
        failedEmails.push(email);
        failureReasons.push({ email, reason });
      }
    }

    return res.json({
      total: validEmails.length,
      failureReasons,
      sent,
      failed: failedCount,
      failedEmails,
    });
  } catch (error) {
    console.error('Error sending test group email:', error);
    return res.status(500).json({ message: 'Failed to send test group email' });
  }
});

/**
 * @route POST /api/crm/lists/:listId/group-email/load-from-url
 * @desc Load HTML content from a URL for group email
 */
router.post('/lists/:listId/group-email/load-from-url', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    const { listId } = req.params;
    const { url } = req.body;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const list = await crmDb.getLeadListById(listId);
    if (!list) {
      return res.status(404).json({ message: 'Lead list not found' });
    }
    if (!(await canDestructiveCrmList(userId, list))) {
      return res.status(403).json({ message: CRM_EDITOR_REQUIRED_MESSAGE });
    }

    if (!url || typeof url !== 'string') {
      return res.status(400).json({ message: 'URL is required and must be a string' });
    }

    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      return res.status(400).json({ message: 'Invalid URL format. Must be HTTP or HTTPS.' });
    }

    // SSRF guard: refuse hostnames that resolve to private/internal IPs
    // (RFC1918, loopback, cloud metadata, link-local, broadcast, multicast).
    try {
      await assertPublicHostname(url);
    } catch (ssrfErr) {
      if (ssrfErr instanceof SsrfBlockedError) {
        return res.status(400).json({ message: 'URL resolves to a private/internal address' });
      }
      return res.status(400).json({ message: 'URL is not safe to fetch' });
    }

    // SSRF defence-in-depth: refuse to follow redirects. assertPublicHostname
    // only validates the user-supplied URL; if axios follows a 302 to e.g.
    // http://169.254.169.254/, the guard is bypassed. maxRedirects:0 makes
    // axios surface the redirect as an error instead. validateStatus accepts
    // only 2xx so 3xx becomes an error. The `as any` cast routes around the
    // legacy @types/axios shim installed in this repo that doesn't carry
    // maxRedirects/validateStatus on its config interface.
    const response = await axios.get(url, {
      timeout: 15000,
      responseType: 'text',
      headers: { 'User-Agent': 'AgentWeb-Backend/1.0' },
      maxRedirects: 0,
      validateStatus: (s: number) => s >= 200 && s < 300,
    } as any);

    const html = response.data as string;

    // Extract title
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    let extractedTitle = titleMatch ? titleMatch[1].trim() : '';
    if (!extractedTitle) {
      const h1Match = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
      extractedTitle = h1Match ? h1Match[1].trim() : 'Newsletter';
    }
    extractedTitle = extractedTitle
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'");

    let bodyContent = '';

    // If this is a complete HTML email document, preserve it as-is (only strip scripts).
    // Stripping <style> or collapsing whitespace destroys email formatting.
    const isFullHtmlDocument = /<html[\s>]/i.test(html);
    if (isFullHtmlDocument) {
      bodyContent = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '');
    } else {
      // For plain HTML fragments, extract body content and clean up
      const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
      bodyContent = bodyMatch ? bodyMatch[1] : html;

      bodyContent = bodyContent
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '');

      const mainContentSelectors = [
        /<main[^>]*>([\s\S]*?)<\/main>/i,
        /<article[^>]*>([\s\S]*?)<\/article>/i,
        /<div[^>]*class="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
      ];
      for (const selector of mainContentSelectors) {
        const match = bodyContent.match(selector);
        if (match && match[1].trim().length > 50) {
          bodyContent = match[1];
          break;
        }
      }

      bodyContent = bodyContent
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/\s+/g, ' ')
        .replace(/>\s+</g, '><')
        .trim();
    }

    if (bodyContent.length > 200000) {
      bodyContent = bodyContent.substring(0, 200000);
    }

    return res.json({
      success: true,
      title: extractedTitle,
      message: bodyContent,
    });
  } catch (error: any) {
    console.error('Error loading HTML from URL:', error.message || error);
    return res.status(500).json({ message: 'Failed to load content from URL' });
  }
});

/**
 * @route POST /api/crm/lists/:listId/analyze
 * @desc Analyze CRM lead data and email events using Gemini code execution.
 *       Fetches all leads + email events, serializes to CSV, uploads to S3 (cached
 *       for 30 min per user+list), then delegates to performDataAnalysis.
 */
router.post('/lists/:listId/analyze', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    const { listId } = req.params;
    const { instruction, time_range_days } = req.body;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }
    if (!instruction || typeof instruction !== 'string') {
      return res.status(400).json({ message: 'instruction is required' });
    }

    // Verify list ownership
    const list = await crmDb.getLeadListById(listId);
    if (!list) {
      return res.status(404).json({ message: 'Lead list not found' });
    }
    if (!(await canAccessCrmList(userId, list))) {
      return res.status(403).json({ message: CRM_SHARING_DISABLED_MESSAGE });
    }

    // Check cache
    const cacheKey = `${userId}:${listId}`;
    const cached = crmDataFileCache.get(cacheKey);
    let leadsUrl: string;
    let eventsUrl: string;

    if (cached && cached.expiresAt > Date.now()) {
      leadsUrl = cached.leadsUrl;
      eventsUrl = cached.eventsUrl;
    } else {
      // Fetch all leads (paginated)
      const allLeads: any[] = [];
      let lastKey: any = undefined;
      do {
        const result = await crmDb.getLeadsByListId(listId, 100, lastKey);
        allLeads.push(...result.items);
        lastKey = result.lastEvaluatedKey;
      } while (lastKey);

      // Build leads CSV — include all fields from all lead records dynamically
      const leadKeySet = new Set<string>();
      for (const lead of allLeads) {
        for (const key of Object.keys(lead)) {
          // Skip large nested objects (e.g. emailDraft HTML) that inflate the payload
          const val = lead[key];
          if (val !== null && typeof val === 'object' && !Array.isArray(val)) continue;
          leadKeySet.add(key);
        }
      }
      // Put core identity fields first for readability, then remaining fields alphabetically
      const coreFields = ['leadId', 'email', 'firstName', 'lastName', 'company', 'title', 'status', 'stage'];
      const remainingFields = [...leadKeySet].filter(k => !coreFields.includes(k)).sort();
      const leadHeaders = [...coreFields.filter(k => leadKeySet.has(k)), ...remainingFields];

      const escapeCell = (v: any): string => {
        if (v === undefined || v === null) return '';
        const str = Array.isArray(v) ? JSON.stringify(v) : String(v);
        return str.includes(',') || str.includes('"') || str.includes('\n') ? `"${str.replace(/"/g, '""')}"` : str;
      };
      const leadRows = allLeads.map(lead => leadHeaders.map(h => escapeCell(lead[h])).join(','));
      const leadsCsv = [leadHeaders.join(','), ...leadRows].join('\n');

      // Fetch email events for this user's domain
      const user = await userDb.getUserById(userId);
      const emailDomain = user?.emailDomain?.trim();

      let eventsCsv: string;
      if (emailDomain) {
        const timeCutoff = time_range_days
          ? new Date(Date.now() - Number(time_range_days) * 24 * 60 * 60 * 1000).toISOString()
          : null;

        const allEvents = await emailEventsDb.getEventsByEmailDomain(emailDomain);
        const filtered = timeCutoff
          ? allEvents.filter(e => e.createdAt >= timeCutoff!)
          : allEvents;

        const eventHeaders = ['eventId', 'leadEmail', 'eventType', 'emailId', 'createdAt'];
        const eventRows = filtered.map(ev =>
          eventHeaders.map(h => {
            const v = (ev as any)[h];
            if (v === undefined || v === null) return '';
            const str = String(v);
            return str.includes(',') || str.includes('"') || str.includes('\n') ? `"${str.replace(/"/g, '""')}"` : str;
          }).join(',')
        );
        eventsCsv = [eventHeaders.join(','), ...eventRows].join('\n');
      } else {
        eventsCsv = 'eventId,leadEmail,eventType,emailId,createdAt\n(no email domain configured)';
      }

      // Upload both CSVs to S3
      const { uploadFileToS3 } = await import('../utils/s3Utils');
      const [leadsUpload, eventsUpload] = await Promise.all([
        uploadFileToS3(Buffer.from(leadsCsv, 'utf-8'), `crm_leads_${listId}.csv`, userId, 'text/csv'),
        uploadFileToS3(Buffer.from(eventsCsv, 'utf-8'), `crm_email_events_${listId}.csv`, userId, 'text/csv'),
      ]);

      if (!leadsUpload.success || !eventsUpload.success) {
        return res.status(500).json({ message: 'Failed to upload CRM data files for analysis' });
      }

      leadsUrl = leadsUpload.url!;
      eventsUrl = eventsUpload.url!;

      // Store in cache
      crmDataFileCache.set(cacheKey, {
        leadsUrl,
        eventsUrl,
        expiresAt: Date.now() + CRM_CACHE_TTL_MS,
      });
    }

    // Delegate to Gemini code execution
    const { agentModeService } = await import('../services/agentModeService');
    const result = await agentModeService.performDataAnalysis(
      [leadsUrl, eventsUrl],
      `You are analyzing CRM data for the lead list "${list.name}".\n\nFile 1 (crm_leads_*.csv): leads with fields leadId, email, firstName, lastName, company, title, status, stage, isICP, engagementCount, createdAt.\nFile 2 (crm_email_events_*.csv): email events with fields eventId, leadEmail, eventType (email.sent, email.delivered, email.opened, email.clicked, email.bounced), emailId, createdAt.\n\nUser instruction: ${instruction}`,
      userId
    );

    return res.json(result);
  } catch (error: any) {
    console.error('Error in CRM analyze endpoint:', error.message || error);
    return res.status(500).json({ message: 'Failed to analyze CRM data' });
  }
});

// ============================================================================
// Deals Routes (CRM Unification v1 — A2)
// ============================================================================

/**
 * Helper: translate dealDb errors to HTTP responses. Keeps route bodies tight.
 */
function handleDealError(res: Response, err: any): Response {
  if (err instanceof DealNotFoundError) {
    return res.status(404).json({ message: err.message });
  }
  if (err instanceof DealAuthError) {
    return res.status(403).json({ message: err.message });
  }
  if (err instanceof Error && /Invalid|required|must be|cannot be empty/i.test(err.message)) {
    return res.status(400).json({ message: err.message });
  }
  console.error('Deals route error:', err);
  return res.status(500).json({ message: 'Internal error' });
}

// GET /api/crm/deals — list deals owned by the current user, optional filters
router.get('/deals', async (req: Request, res: Response) => {
  const authReq = req as unknown as AuthenticatedRequest;
  const userId = authReq.user?.userId;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  try {
    const { companyDomain, stage, limit } = req.query as Record<string, string | undefined>;
    const lim = limit ? Math.min(parseInt(limit, 10) || 100, 500) : 100;

    if (companyDomain) {
      if (stage && !DEAL_STAGES.includes(stage as DealStage)) {
        return res.status(400).json({ message: `Invalid stage: ${stage}` });
      }
      const deals = await dealDb.getDealsByDomain(companyDomain, {
        stage: stage as DealStage | undefined,
        limit: lim,
      });
      // Scope to the caller's own deals — domain lookups cross tenants otherwise.
      const mine = deals.filter(
        d => d.ownerUserId === userId || d.accountOwnerUserId === userId
      );
      return res.json({ deals: mine });
    }

    const deals = await dealDb.getDealsByOwner(userId, { limit: lim });
    const filtered = stage ? deals.filter(d => d.stage === stage) : deals;
    return res.json({ deals: filtered });
  } catch (err) {
    return handleDealError(res, err);
  }
});

// POST /api/crm/deals — create a new deal
router.post('/deals', async (req: Request, res: Response) => {
  const authReq = req as unknown as AuthenticatedRequest;
  const userId = authReq.user?.userId;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  try {
    const {
      primaryContactId,
      contactIds,
      accountOwnerUserId,
      companyDomain,
      stage,
      dealValue,
      dealCurrency,
      expectedClose,
      heatScore,
      source,
      notes,
      tenantId,
    } = req.body || {};

    if (!primaryContactId) {
      return res.status(400).json({ message: 'primaryContactId required' });
    }

    const deal = await dealDb.createDeal({
      ownerUserId: userId,
      primaryContactId,
      contactIds,
      accountOwnerUserId,
      companyDomain,
      stage,
      dealValue,
      dealCurrency,
      expectedClose,
      heatScore,
      source,
      notes,
      tenantId,
    });
    return res.status(201).json({ deal });
  } catch (err) {
    return handleDealError(res, err);
  }
});

// GET /api/crm/deals/:dealId
router.get('/deals/:dealId', async (req: Request, res: Response) => {
  const authReq = req as unknown as AuthenticatedRequest;
  const userId = authReq.user?.userId;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  try {
    const deal = await dealDb.getDeal(req.params.dealId);
    if (!deal) return res.status(404).json({ message: 'Deal not found' });
    if (deal.ownerUserId !== userId && deal.accountOwnerUserId !== userId) {
      return res.status(403).json({ message: 'Not authorized to view this deal' });
    }
    return res.json({ deal });
  } catch (err) {
    return handleDealError(res, err);
  }
});

// PUT /api/crm/deals/:dealId
router.put('/deals/:dealId', async (req: Request, res: Response) => {
  const authReq = req as unknown as AuthenticatedRequest;
  const userId = authReq.user?.userId;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  try {
    const deal = await dealDb.updateDeal(req.params.dealId, userId, req.body || {});
    return res.json({ deal });
  } catch (err) {
    return handleDealError(res, err);
  }
});

// DELETE /api/crm/deals/:dealId
router.delete('/deals/:dealId', async (req: Request, res: Response) => {
  const authReq = req as unknown as AuthenticatedRequest;
  const userId = authReq.user?.userId;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  try {
    await dealDb.deleteDeal(req.params.dealId, userId);
    return res.json({ success: true });
  } catch (err) {
    return handleDealError(res, err);
  }
});

// POST /api/crm/deals/:dealId/rotate-primary  { newPrimaryContactId, oldPrimaryRef?, newPrimaryRef? }
router.post('/deals/:dealId/rotate-primary', async (req: Request, res: Response) => {
  const authReq = req as unknown as AuthenticatedRequest;
  const userId = authReq.user?.userId;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  try {
    const { newPrimaryContactId, oldPrimaryRef, newPrimaryRef } = req.body || {};
    if (!newPrimaryContactId) {
      return res.status(400).json({ message: 'newPrimaryContactId required' });
    }
    const refs: { oldPrimary?: ContactRef; newPrimary?: ContactRef } = {};
    if (oldPrimaryRef?.listId && oldPrimaryRef?.leadId) refs.oldPrimary = oldPrimaryRef;
    if (newPrimaryRef?.listId && newPrimaryRef?.leadId) refs.newPrimary = newPrimaryRef;

    const deal = await dealDb.rotatePrimary(
      req.params.dealId,
      userId,
      newPrimaryContactId,
      Object.keys(refs).length > 0 ? refs : undefined
    );
    return res.json({ deal });
  } catch (err) {
    return handleDealError(res, err);
  }
});

/**
 * @route GET /api/crm/lists/:listId/enrichment-history
 * @desc List enrichment jobs for a list (newest first, up to 10)
 */
router.get('/lists/:listId/enrichment-history', async (req: Request, res: Response) => {
  const { listId } = req.params;
  const userId = (req as AuthenticatedRequest).user?.userId;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  try {
    const list = await crmDb.getLeadListById(listId);
    if (!list) return res.status(404).json({ message: 'Lead list not found' });
    if (!(await canAccessCrmList(userId, list as any))) {
      return res.status(403).json({ message: CRM_SHARING_DISABLED_MESSAGE });
    }

    const { jobs } = await crmDb.getEnrichmentJobsByListId(listId, undefined, undefined, 10);
    return res.json({ jobs });
  } catch (error: any) {
    console.error('[CRM] enrichment-history error:', error);
    return res.status(500).json({ message: error.message || 'Failed to fetch enrichment history' });
  }
});

/**
 * @route POST /api/crm/lists/:listId/enrichment-jobs/:jobId/revert
 * @desc Revert an enrichment job, restoring pre-enrichment field values while preserving newer columns
 */
router.post('/lists/:listId/enrichment-jobs/:jobId/revert', async (req: Request, res: Response) => {
  const { listId, jobId } = req.params;
  const userId = (req as AuthenticatedRequest).user?.userId;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  try {
    const list = await crmDb.getLeadListById(listId);
    if (!list) return res.status(404).json({ message: 'Lead list not found' });
    if (!(await canDestructiveCrmList(userId, list as any))) {
      return res.status(403).json({ message: CRM_EDITOR_REQUIRED_MESSAGE });
    }

    const { CrmEnrichmentService } = await import('../services/crmEnrichmentService');
    const service = new CrmEnrichmentService();
    const result = await service.revertJob(jobId, listId);

    return res.json({ success: true, ...result });
  } catch (error: any) {
    console.error('[CRM] enrichment revert error:', error);
    const status = error.message?.includes('No snapshot data') ? 400 : 500;
    return res.status(status).json({ message: error.message || 'Failed to revert enrichment job' });
  }
});

// ── Per-field enrichment actions (item #10) ─────────────────────────────────
//
// verify  → mark a field as user-verified (sets verifiedBy on enrichmentMetadata)
// reject  → null out the field's value (records rejectedReason on metadata)
// refresh → re-run enrichment for a single field (force-refresh that field's cache group)

router.post('/lists/:listId/leads/:leadId/fields/:field/verify', async (req: Request, res: Response) => {
  const { listId, leadId, field } = req.params;
  const userId = (req as AuthenticatedRequest).user?.userId;
  const userEmail = (req as AuthenticatedRequest).user?.email;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  let validatedField: string;
  try {
    validatedField = validateFieldName(field, 'field');
  } catch (err: any) {
    if (err instanceof EnrichmentInputError) {
      return res.status(400).json({ message: err.message });
    }
    throw err;
  }

  try {
    const list = await crmDb.getLeadListById(listId);
    if (!list) return res.status(404).json({ message: 'Lead list not found' });
    if (!(await canDestructiveCrmList(userId, list as any))) {
      return res.status(403).json({ message: CRM_EDITOR_REQUIRED_MESSAGE });
    }
    const lead: any = await crmDb.getLeadById(listId, leadId);
    if (!lead) return res.status(404).json({ message: 'Lead not found' });

    const now = new Date().toISOString();
    const priorMeta = (lead.enrichmentMetadata || {})[validatedField] || {};
    // Strip a prior reject stamp so flipping wrong → verify leaves a clean
    // current state on disk. Reporting queries that ask "is this field
    // currently rejected?" can then check rejectedAt directly without also
    // having to compare timestamps against verifiedBy.at.
    const { rejectedReason: _r, rejectedAt: _ra, ...restPrior } = priorMeta as any;
    const updatedMeta = {
      ...lead.enrichmentMetadata,
      [validatedField]: { ...restPrior, verifiedBy: { userId, at: now } },
    };
    await crmDb.updateLead(listId, leadId, { enrichmentMetadata: updatedMeta });

    return res.json({ success: true, verifiedBy: { userId, email: userEmail, at: now } });
  } catch (error: any) {
    console.error('[CRM] verify field error:', error);
    return res.status(500).json({ message: error.message || 'Failed to verify field' });
  }
});

router.post('/lists/:listId/leads/:leadId/fields/:field/reject', async (req: Request, res: Response) => {
  const { listId, leadId, field } = req.params;
  const reason: string | undefined = (req.body || {}).reason;
  const userId = (req as AuthenticatedRequest).user?.userId;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  let validatedField: string;
  try {
    validatedField = validateFieldName(field, 'field');
  } catch (err: any) {
    if (err instanceof EnrichmentInputError) {
      return res.status(400).json({ message: err.message });
    }
    throw err;
  }

  try {
    const list = await crmDb.getLeadListById(listId);
    if (!list) return res.status(404).json({ message: 'Lead list not found' });
    if (!(await canDestructiveCrmList(userId, list as any))) {
      return res.status(403).json({ message: CRM_EDITOR_REQUIRED_MESSAGE });
    }
    const lead: any = await crmDb.getLeadById(listId, leadId);
    if (!lead) return res.status(404).json({ message: 'Lead not found' });

    const now = new Date().toISOString();

    // Mark the field as rejected in metadata but preserve the value itself, so
    // the data remains visible in the UI and we can still report on it later.
    // Strip a prior verifiedBy stamp so flipping verify → wrong leaves a clean
    // current state on disk (mirror of the verify endpoint's stamp cleanup).
    const priorMeta = (lead.enrichmentMetadata || {})[validatedField] || {};
    const { verifiedBy: _v, ...restPrior } = priorMeta as any;
    const updates: any = {
      enrichmentMetadata: {
        ...lead.enrichmentMetadata,
        [validatedField]: { ...restPrior, rejectedReason: reason || 'user-rejected', rejectedAt: now },
      },
    };
    await crmDb.updateLead(listId, leadId, updates);

    return res.json({ success: true });
  } catch (error: any) {
    console.error('[CRM] reject field error:', error);
    return res.status(500).json({ message: error.message || 'Failed to reject field' });
  }
});

router.post('/lists/:listId/leads/:leadId/fields/:field/refresh', async (req: Request, res: Response) => {
  const { listId, leadId, field } = req.params;
  const userId = (req as AuthenticatedRequest).user?.userId;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  let validatedField: string;
  try {
    validatedField = validateFieldName(field, 'field');
  } catch (err: any) {
    if (err instanceof EnrichmentInputError) {
      return res.status(400).json({ message: err.message });
    }
    throw err;
  }

  try {
    const list = await crmDb.getLeadListById(listId);
    if (!list) return res.status(404).json({ message: 'Lead list not found' });
    if (!(await canDestructiveCrmList(userId, list as any))) {
      return res.status(403).json({ message: CRM_EDITOR_REQUIRED_MESSAGE });
    }
    const lead: any = await crmDb.getLeadById(listId, leadId);
    if (!lead) return res.status(404).json({ message: 'Lead not found' });

    const { CrmEnrichmentService } = await import('../services/crmEnrichmentService');
    const service = new CrmEnrichmentService();
    const result = await service.execute({
      listId,
      userId,
      instruction: (list as any).enrichmentInstruction || `Re-enrich field ${validatedField} for {{firstName}} {{lastName}} at {{company}}`,
      outputFields: [validatedField],
      sources: ['web_search', 'linkedin'],
      leadIds: [leadId],
      forceOverwrite: true,
      forceRefreshCache: true,
    });
    return res.json({ success: true, ...result });
  } catch (error: any) {
    console.error('[CRM] refresh field error:', error);
    return res.status(500).json({ message: error.message || 'Failed to refresh field' });
  }
});

// ── TEMPORARY DEBUG: raw SERP probe ──────────────────────────────────────────
// POST /api/crm/debug/serp { query: string, n?: number }
// Returns the raw Google CSE results so we can iterate on specialist queries
// without redeploying. Remove once enrichment specialists stabilize.
router.post('/debug/serp', async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const userId = authReq.user?.userId;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });
  if (!authReq.user?.isAdmin) {
    return res.status(403).json({ message: 'Admin access required' });
  }
  const query = (req.body?.query || '').toString().trim();
  const n = Math.max(1, Math.min(10, Number(req.body?.n) || 5));
  if (!query) return res.status(400).json({ message: 'query required' });

  const { agentModeService } = await import('../services/agentModeService');
  const result = await agentModeService.youSearchWeb(query, n);
  return res.json({
    query,
    success: result?.success,
    count: Array.isArray(result?.results) ? result.results.length : 0,
    results: result?.results || [],
  });
});

// ── TEMPORARY DEBUG: EnrichmentRawCache table inspection ─────────────────────
// Remove this endpoint once cache behaviour is confirmed working in the test env.
router.get('/debug/enrichment-raw-cache', async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const userId = authReq.user?.userId;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });
  if (!authReq.user?.isAdmin) {
    return res.status(403).json({ message: 'Admin access required' });
  }

  const AWS = require('aws-sdk');
  const TABLE_PREFIX = process.env.NODE_ENV === 'development' ? 'Dev-' : '';
  const tableName = `${TABLE_PREFIX}AW-EnrichmentRawCache`;
  const region = process.env.AWS_REGION || 'us-west-2';
  const dynamo = new AWS.DynamoDB.DocumentClient({ region });
  const ddl = new AWS.DynamoDB({ region });

  // Try scanning first
  try {
    const result = await dynamo.scan({
      TableName: tableName,
      Limit: 10,
      ProjectionExpression: 'canonicalId, fieldGroup, canonicalKey, entityKey, entityType, queryUsed, resultCount, schemaVersion, fetchedAt, expiresAt',
    }).promise();
    return res.json({
      tableName, region,
      count: result.Count,
      scannedCount: result.ScannedCount,
      hasMore: !!result.LastEvaluatedKey,
      items: result.Items,
    });
  } catch (scanErr: any) {
    if (scanErr.code !== 'ResourceNotFoundException') {
      return res.status(500).json({ error: scanErr.code, message: scanErr.message });
    }
  }

  // Table missing — attempt to create it
  try {
    await ddl.createTable({
      TableName: tableName,
      AttributeDefinitions: [
        { AttributeName: 'canonicalId', AttributeType: 'S' },
        { AttributeName: 'fieldGroup',  AttributeType: 'S' },
        { AttributeName: 'entityKey',   AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'canonicalId', KeyType: 'HASH' },
        { AttributeName: 'fieldGroup',  KeyType: 'RANGE' },
      ],
      GlobalSecondaryIndexes: [{
        IndexName: 'entityKey-fieldGroup-index',
        KeySchema: [
          { AttributeName: 'entityKey',  KeyType: 'HASH' },
          { AttributeName: 'fieldGroup', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      }],
      BillingMode: 'PAY_PER_REQUEST',
    }).promise();

    // Wait for table to become ACTIVE
    await ddl.waitFor('tableExists', { TableName: tableName }).promise();
    return res.json({ tableName, region, created: true, message: 'Table created successfully' });
  } catch (createErr: any) {
    if (createErr.code === 'ResourceInUseException') {
      return res.json({ tableName, region, created: false, message: 'Table already exists (race condition)' });
    }
    return res.status(500).json({ createError: createErr.code, message: createErr.message });
  }
});

export default router;
