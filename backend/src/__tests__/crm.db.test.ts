// Unit tests for CRM database service functions
// Mock AWS SDK before importing db.ts (which calls AWS.config.update)
const mockDocumentClientMethods = {
  put: jest.fn(),
  get: jest.fn(),
  query: jest.fn(),
  scan: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
  batchWrite: jest.fn(),
};

jest.mock('aws-sdk', () => {
  return {
    config: {
      update: jest.fn(),
    },
    DynamoDB: {
      DocumentClient: jest.fn(() => mockDocumentClientMethods),
    },
    S3: jest.fn(() => ({
      upload: jest.fn(),
      getObject: jest.fn(),
      deleteObject: jest.fn(),
    })),
  };
});

// Mock emailEventsDb and resendService before importing db.ts
jest.mock('../services/emailEventsDb', () => ({
  emailEventsDb: {
    getEventsByEmailDomainAndLeadEmail: jest.fn(),
    updateEmailEventContent: jest.fn(),
  },
}));

jest.mock('../services/resendService', () => ({
  resendService: {
    getReceivedEmailContent: jest.fn(),
    getDeliveredEmailContent: jest.fn(),
  },
}));

// contactEventsDb is called from createLead when attribution is captured.
const mockLogEvent = jest.fn().mockResolvedValue({ event: {}, deduplicated: false });
jest.mock('../services/contactEventsDb', () => ({
  contactEventsDb: {
    logEvent: (...args: any[]) => mockLogEvent(...args),
  },
  normalizeContactId: (raw: string) => raw.trim().toLowerCase(),
}));

import { crmDb, userDb } from '../services/db';
import AWS from 'aws-sdk';

describe('CRM Database Service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset all methods to return promises
    Object.keys(mockDocumentClientMethods).forEach(method => {
      (mockDocumentClientMethods as any)[method].mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      });
    });
  });

  describe('createLeadList', () => {
    it('should create a new lead list', async () => {
      const userId = 'user1';
      const name = 'Test List';
      const description = 'Test Description';

      mockDocumentClientMethods.put.mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      });

      const result = await crmDb.createLeadList(userId, name, description);

      expect(mockDocumentClientMethods.put).toHaveBeenCalled();
      expect(result.listId).toBeDefined();
      expect(result.name).toBe(name);
      expect(result.userId).toBe(userId);
    });

    it('should create list without description if not provided', async () => {
      const userId = 'user1';
      const name = 'Test List';

      mockDocumentClientMethods.put.mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      });

      const result = await crmDb.createLeadList(userId, name);

      expect(mockDocumentClientMethods.put).toHaveBeenCalled();
      expect(result.name).toBe(name);
    });
  });

  describe('getLeadListById', () => {
    it('should retrieve a lead list by ID', async () => {
      const listId = 'list_123';
      const mockList = {
        listId,
        name: 'Test List',
        userId: 'user1',
      };

      mockDocumentClientMethods.get.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Item: mockList }),
      });

      const result = await crmDb.getLeadListById(listId);

      expect(mockDocumentClientMethods.get).toHaveBeenCalledWith(
        expect.objectContaining({
          Key: { listId },
        })
      );
      expect(result).toEqual(mockList);
    });

    it('should return null if list not found', async () => {
      const listId = 'nonexistent';

      mockDocumentClientMethods.get.mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      });

      const result = await crmDb.getLeadListById(listId);

      expect(result).toBeNull();
    });
  });

  describe('getLeadListsByUserId', () => {
    it("dedupes + sorts each list's fieldNames on read (matches getLeadListById behavior)", async () => {
      // The bug this guards against: mergeFieldNames uses list_append, which
      // can leave duplicate entries in storage. getLeadListById dedupes on
      // read but getLeadListsByUserId — which powers /api/crm/lists and the
      // Configure Display Fields dialog — was returning raw items, so the
      // dialog rendered "website" five times.
      mockDocumentClientMethods.query.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Items: [
            { listId: 'l1', userId: 'u1', fieldNames: ['website', 'website', 'tech-stack', 'website'] },
            { listId: 'l2', userId: 'u1', fieldNames: ['a', 'b', 'a'] },
          ],
          LastEvaluatedKey: undefined,
        }),
      });

      const result = await crmDb.getLeadListsByUserId('u1');

      expect(result).toHaveLength(2);
      expect(result[0].fieldNames).toEqual(['tech-stack', 'website']);
      expect(result[1].fieldNames).toEqual(['a', 'b']);
    });

    it('leaves items without fieldNames untouched', async () => {
      mockDocumentClientMethods.query.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Items: [{ listId: 'l1', userId: 'u1' }],
          LastEvaluatedKey: undefined,
        }),
      });

      const result = await crmDb.getLeadListsByUserId('u1');

      expect(result[0].fieldNames).toBeUndefined();
    });
  });

  describe('createLead', () => {
    it('should create a new lead', async () => {
      const listId = 'list_123';
      const leadData = {
        email: 'test@example.com',
        firstName: 'John',
        lastName: 'Doe',
        company: 'Test Company',
      };

      mockDocumentClientMethods.put.mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      });
      mockDocumentClientMethods.get.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Item: { listId, fieldNames: [] } }),
      });
      mockDocumentClientMethods.update.mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      });

      const result = await crmDb.createLead(listId, leadData);

      expect(mockDocumentClientMethods.put).toHaveBeenCalled();
      expect(result.leadId).toBeDefined();
      expect(result.listId).toBe(listId);
      expect(result.email).toBe(leadData.email.toLowerCase());
    });

    it('stores the linkedin field in canonical form so the lookup GSI stays canonical (ENG-787)', async () => {
      const listId = 'list_123';
      // Differently-formatted URL: http scheme, mixed case, trailing slash, tracking query.
      const leadData = {
        firstName: 'Jane',
        linkedin: 'http://LinkedIn.com/in/JaneDoe/?miniProfileUrn=abc',
      };

      mockDocumentClientMethods.put.mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      });
      mockDocumentClientMethods.get.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Item: { listId, fieldNames: [] } }),
      });
      mockDocumentClientMethods.update.mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      });

      await crmDb.createLead(listId, leadData);

      const putCall = mockDocumentClientMethods.put.mock.calls[0][0];
      expect(putCall.Item.linkedin).toBe('https://www.linkedin.com/in/janedoe');
    });

    it('should handle leads without email', async () => {
      const listId = 'list_123';
      const leadData = {
        firstName: 'John',
        lastName: 'Doe',
      };

      mockDocumentClientMethods.put.mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      });
      mockDocumentClientMethods.get.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Item: { listId, fieldNames: [] } }),
      });
      mockDocumentClientMethods.update.mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      });

      const result = await crmDb.createLead(listId, leadData);

      expect(mockDocumentClientMethods.put).toHaveBeenCalled();
      // Email should not be in the item if not provided
      const putCall = mockDocumentClientMethods.put.mock.calls[0][0];
      expect(putCall.Item.email).toBeUndefined();
    });

    it('stamps firstTouch, lastTouch and denormalized utm fields from attribution', async () => {
      const listId = 'list_123';
      const firstTouch = {
        timestamp: '2026-04-19T10:00:00.000Z',
        utm: { source: 'linkedin', medium: 'social', campaign: 'launch' },
        referrer: 'https://linkedin.com/feed',
      };
      const leadData = {
        email: 'attribution@example.com',
        firstName: 'Jane',
        firstTouch,
      };

      mockDocumentClientMethods.put.mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      });
      mockDocumentClientMethods.get.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Item: { listId, fieldNames: [] } }),
      });
      mockDocumentClientMethods.update.mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      });

      await crmDb.createLead(listId, leadData);

      const putCall = mockDocumentClientMethods.put.mock.calls[0][0];
      expect(putCall.Item.firstTouch).toEqual(firstTouch);
      // lastTouch defaults to firstTouch on a fresh lead when not supplied
      expect(putCall.Item.lastTouch).toEqual(firstTouch);
      expect(putCall.Item.utmSource).toBe('linkedin');
      expect(putCall.Item.utmMedium).toBe('social');
    });

    it('leaves attribution fields absent when none supplied (CSV import path)', async () => {
      const listId = 'list_123';
      const leadData = {
        email: 'csv-row@example.com',
        firstName: 'Bob',
      };

      mockDocumentClientMethods.put.mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      });
      mockDocumentClientMethods.get.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Item: { listId, fieldNames: [] } }),
      });
      mockDocumentClientMethods.update.mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      });

      await crmDb.createLead(listId, leadData);

      const putCall = mockDocumentClientMethods.put.mock.calls[0][0];
      expect(putCall.Item.firstTouch).toBeUndefined();
      expect(putCall.Item.lastTouch).toBeUndefined();
      expect(putCall.Item.utmSource).toBeUndefined();
      expect(putCall.Item.utmMedium).toBeUndefined();
    });

    it('accepts distinct firstTouch and lastTouch (repeat-touch scenarios)', async () => {
      const listId = 'list_123';
      const firstTouch = {
        timestamp: '2026-04-01T10:00:00.000Z',
        utm: { source: 'google', medium: 'cpc' },
      };
      const lastTouch = {
        timestamp: '2026-04-19T10:00:00.000Z',
        utm: { source: 'linkedin', medium: 'social' },
      };
      const leadData = { email: 'rt@example.com', firstTouch, lastTouch };

      mockDocumentClientMethods.put.mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      });
      mockDocumentClientMethods.get.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Item: { listId, fieldNames: [] } }),
      });
      mockDocumentClientMethods.update.mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      });

      await crmDb.createLead(listId, leadData);

      const putCall = mockDocumentClientMethods.put.mock.calls[0][0];
      expect(putCall.Item.firstTouch).toEqual(firstTouch);
      expect(putCall.Item.lastTouch).toEqual(lastTouch);
      // Top-level utm* is denormalized from firstTouch (the origin of the lead)
      expect(putCall.Item.utmSource).toBe('google');
      expect(putCall.Item.utmMedium).toBe('cpc');
    });

    it('fires attribution.first_touch event exactly once per lead with attribution', async () => {
      const listId = 'list_123';
      const firstTouch = {
        timestamp: '2026-04-19T10:00:00.000Z',
        utm: { source: 'linkedin', medium: 'social', campaign: 'launch' },
        referrer: 'https://linkedin.com/feed',
        landingUrl: 'https://agentweb.pro/?utm_source=linkedin',
      };
      const leadData = { email: 'event@example.com', firstTouch };

      mockDocumentClientMethods.put.mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      });
      mockDocumentClientMethods.get.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Item: { listId, fieldNames: [] } }),
      });
      mockDocumentClientMethods.update.mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      });

      await crmDb.createLead(listId, leadData);

      expect(mockLogEvent).toHaveBeenCalledTimes(1);
      const payload = mockLogEvent.mock.calls[0][0];
      expect(payload.eventType).toBe('attribution.first_touch');
      expect(payload.source).toBe('lead_form');
      expect(payload.contactId).toBe('event@example.com');
      expect(payload.sourceRecordId).toMatch(/^attribution:lead:lead_/);
      expect(payload.payload.utmSource).toBe('linkedin');
      expect(payload.payload.utmMedium).toBe('social');
      expect(payload.payload.utmCampaign).toBe('launch');
      expect(payload.payload.referrer).toBe('https://linkedin.com/feed');
    });

    it('does NOT fire attribution event when no attribution is provided', async () => {
      const listId = 'list_123';
      const leadData = { email: 'noattr@example.com' };

      mockDocumentClientMethods.put.mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      });
      mockDocumentClientMethods.get.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Item: { listId, fieldNames: [] } }),
      });
      mockDocumentClientMethods.update.mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      });

      await crmDb.createLead(listId, leadData);

      expect(mockLogEvent).not.toHaveBeenCalled();
    });

    it('uses `nocontact:<leadId>` as contactId when email is absent but attribution present', async () => {
      const listId = 'list_123';
      const firstTouch = {
        timestamp: '2026-04-19T10:00:00.000Z',
        utm: { source: 'referral' },
      };
      const leadData = { firstName: 'Anon', firstTouch };

      mockDocumentClientMethods.put.mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      });
      mockDocumentClientMethods.get.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Item: { listId, fieldNames: [] } }),
      });
      mockDocumentClientMethods.update.mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      });

      await crmDb.createLead(listId, leadData);

      expect(mockLogEvent).toHaveBeenCalledTimes(1);
      const payload = mockLogEvent.mock.calls[0][0];
      expect(payload.contactId).toMatch(/^nocontact:lead_/);
    });

    it('does not fail lead creation when attribution event logging throws', async () => {
      const listId = 'list_123';
      const leadData = {
        email: 'resilient@example.com',
        firstTouch: { timestamp: '2026-04-19T10:00:00.000Z', utm: { source: 'google' } },
      };

      mockLogEvent.mockRejectedValueOnce(new Error('ContactEvents table down'));
      mockDocumentClientMethods.put.mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      });
      mockDocumentClientMethods.get.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Item: { listId, fieldNames: [] } }),
      });
      mockDocumentClientMethods.update.mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      });

      // Must not throw — lead creation succeeds even though event log fails
      const result = await crmDb.createLead(listId, leadData);
      expect(result.email).toBe('resilient@example.com');
    });
  });

  describe('getLeadsByListId', () => {
    it('should retrieve leads with pagination', async () => {
      const listId = 'list_123';
      const limit = 50;
      const mockLeads = [
        { leadId: 'lead1', listId, email: 'test1@example.com' },
        { leadId: 'lead2', listId, email: 'test2@example.com' },
      ];

      mockDocumentClientMethods.query.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Items: mockLeads,
          LastEvaluatedKey: { listId, leadId: 'lead2' },
        }),
      });

      const result = await crmDb.getLeadsByListId(listId, limit);

      expect(mockDocumentClientMethods.query).toHaveBeenCalled();
      expect(result.items).toEqual(mockLeads);
      expect(result.hasMore).toBe(true);
    });

    it('should handle lastEvaluatedKey for pagination', async () => {
      const listId = 'list_123';
      const limit = 50;
      const lastEvaluatedKey = { listId, leadId: 'lead1' };

      mockDocumentClientMethods.query.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Items: [],
          LastEvaluatedKey: null,
        }),
      });

      const result = await crmDb.getLeadsByListId(listId, limit, lastEvaluatedKey);

      expect(mockDocumentClientMethods.query).toHaveBeenCalledWith(
        expect.objectContaining({
          ExclusiveStartKey: lastEvaluatedKey,
        })
      );
      expect(result.hasMore).toBe(false);
    });
  });

  describe('updateLead', () => {
    it('should update lead fields', async () => {
      const listId = 'list_123';
      const leadId = 'lead_123';
      const updates = {
        firstName: 'Jane',
        lastName: 'Smith',
        company: 'New Company',
      };

      mockDocumentClientMethods.update.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Attributes: {
            leadId,
            listId,
            ...updates,
          },
        }),
      });

      const result = await crmDb.updateLead(listId, leadId, updates);

      expect(mockDocumentClientMethods.update).toHaveBeenCalled();
      expect(result).toBeTruthy();
      expect(result!.firstName).toBe(updates.firstName);
    });

    it('should handle email updates and normalize to lowercase', async () => {
      const listId = 'list_123';
      const leadId = 'lead_123';
      const updates = {
        email: 'NEWEMAIL@EXAMPLE.COM',
      };

      mockDocumentClientMethods.update.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Attributes: {
            leadId,
            listId,
            email: 'newemail@example.com',
          },
        }),
      });

      const result = await crmDb.updateLead(listId, leadId, updates);

      expect(mockDocumentClientMethods.update).toHaveBeenCalled();
      // Verify email is normalized in the update expression
      const updateCall = mockDocumentClientMethods.update.mock.calls[0][0];
      expect(updateCall.ExpressionAttributeValues[':email']).toBe('newemail@example.com');
    });

    it('canonicalizes the linkedin field so the lookup GSI stays canonical (ENG-787)', async () => {
      const listId = 'list_123';
      const leadId = 'lead_123';
      const updates = {
        linkedin: 'http://LinkedIn.com/in/JaneDoe/?miniProfileUrn=abc',
      };

      mockDocumentClientMethods.update.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Attributes: { leadId, listId },
        }),
      });

      await crmDb.updateLead(listId, leadId, updates);

      const updateCall = mockDocumentClientMethods.update.mock.calls[0][0];
      expect(updateCall.ExpressionAttributeValues[':linkedin']).toBe('https://www.linkedin.com/in/janedoe');
    });

    it('should handle customFields updates', async () => {
      const listId = 'list_123';
      const leadId = 'lead_123';
      const updates = {
        customFields: {
          'Lead Score': '85',
          'Status': 'Active',
        },
      };

      mockDocumentClientMethods.update.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Attributes: {
            leadId,
            listId,
            customFields: updates.customFields,
          },
        }),
      });

      const result = await crmDb.updateLead(listId, leadId, updates);

      expect(mockDocumentClientMethods.update).toHaveBeenCalled();
      expect(result).toBeTruthy();
      expect(result!.customFields).toEqual(updates.customFields);
    });

    it('should handle emailDraft updates', async () => {
      const listId = 'list_123';
      const leadId = 'lead_123';
      const emailDraft = {
        subject: 'Test Subject',
        htmlContent: '<p>Test content</p>',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        sessionId: 'session1',
      };

      mockDocumentClientMethods.update.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Attributes: {
            leadId,
            listId,
            emailDraft,
          },
        }),
      });

      const result = await crmDb.updateLead(listId, leadId, { emailDraft });

      expect(mockDocumentClientMethods.update).toHaveBeenCalled();
      expect(result).toBeTruthy();
      expect(result!.emailDraft).toEqual(emailDraft);
    });

    it('should handle emailDraftFormat updates', async () => {
      const listId = 'list_123';
      const leadId = 'lead_123';

      mockDocumentClientMethods.get.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Item: { leadId, listId },
        }),
      });

      mockDocumentClientMethods.update.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Attributes: {
            leadId,
            listId,
            emailDraftFormat: 'text',
          },
        }),
      });

      const result = await crmDb.updateLead(listId, leadId, { emailDraftFormat: 'text' });

      expect(mockDocumentClientMethods.update).toHaveBeenCalled();
      const updateCall = mockDocumentClientMethods.update.mock.calls[0][0];
      expect(updateCall.ExpressionAttributeValues[':emailDraftFormat']).toBe('text');
      expect(result!.emailDraftFormat).toBe('text');
    });

    it('should handle emailDraft with textContent', async () => {
      const listId = 'list_123';
      const leadId = 'lead_123';

      mockDocumentClientMethods.get.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Item: { leadId, listId },
        }),
      });

      const emailDraft = {
        subject: 'Test Subject',
        textContent: 'Plain text content',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      mockDocumentClientMethods.update.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Attributes: {
            leadId,
            listId,
            emailDraft,
          },
        }),
      });

      const result = await crmDb.updateLead(listId, leadId, { emailDraft });

      expect(mockDocumentClientMethods.update).toHaveBeenCalled();
      expect(result!.emailDraft).toEqual(emailDraft);
      expect(result!.emailDraft!.textContent).toBe('Plain text content');
      expect(result!.emailDraft!.htmlContent).toBeUndefined();
    });

    it('should handle emailDraft with htmlContent', async () => {
      const listId = 'list_123';
      const leadId = 'lead_123';

      mockDocumentClientMethods.get.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Item: { leadId, listId },
        }),
      });

      const emailDraft = {
        subject: 'Test Subject',
        htmlContent: '<p>HTML content</p>',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      mockDocumentClientMethods.update.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Attributes: {
            leadId,
            listId,
            emailDraft,
          },
        }),
      });

      const result = await crmDb.updateLead(listId, leadId, { emailDraft });

      expect(mockDocumentClientMethods.update).toHaveBeenCalled();
      expect(result!.emailDraft).toEqual(emailDraft);
      expect(result!.emailDraft!.htmlContent).toBe('<p>HTML content</p>');
      expect(result!.emailDraft!.textContent).toBeUndefined();
    });

    it('should handle removing emailDraft (setting to null)', async () => {
      const listId = 'list_123';
      const leadId = 'lead_123';

      mockDocumentClientMethods.update.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Attributes: {
            leadId,
            listId,
          },
        }),
      });

      const result = await crmDb.updateLead(listId, leadId, { emailDraft: null });

      expect(mockDocumentClientMethods.update).toHaveBeenCalled();
      // Verify REMOVE clause is used
      const updateCall = mockDocumentClientMethods.update.mock.calls[0][0];
      expect(updateCall.UpdateExpression).toContain('REMOVE');
    });

    it('should skip list fieldNames update when skipFieldNamesUpdate=true', async () => {
      const listId = 'list_123';
      const leadId = 'lead_123';

      mockDocumentClientMethods.update.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Attributes: { leadId, listId } }),
      });

      await crmDb.updateLead(listId, leadId, {
        customFields: { industry: 'SaaS' },
        skipFieldNamesUpdate: true,
      } as any);

      // updateLead always reads the lead row up-front (self-heal pass for
      // legacy empty-string GSI keys). What skipFieldNamesUpdate=true must
      // suppress is the AW-LeadLists read + write that the fieldNames sync
      // would otherwise trigger.
      const listGets = mockDocumentClientMethods.get.mock.calls.filter(
        (call: any) => call[0].TableName === `${process.env.TABLE_PREFIX || ''}AW-LeadLists`
      );
      expect(listGets.length).toBe(0);
      const listUpdates = mockDocumentClientMethods.update.mock.calls.filter(
        (call: any) => call[0].TableName === `${process.env.TABLE_PREFIX || ''}AW-LeadLists`
      );
      expect(listUpdates.length).toBe(0);
    });
  });

  describe('setLeadFields', () => {
    it('writes top-level + metadata + custom field keys with targeted expressions', async () => {
      mockDocumentClientMethods.update.mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      });

      const mergeSpy = jest.spyOn(crmDb, 'mergeFieldNames').mockResolvedValue();
      await crmDb.setLeadFields('list_123', 'lead_123', {
        topLevel: { email: 'a@b.com' },
        enrichmentMetadata: { email: { source: 'web_search' } },
        customFields: { skills: 'TS, Node' },
        removeEnrichmentMetadataKeys: ['old_meta'],
        removeCustomFieldKeys: ['old_custom'],
      });

      // 1: bootstrap parent maps, 2: combined SET/REMOVE expression. The
      // fieldNames sync is spied out — it's covered by its own test.
      expect(mockDocumentClientMethods.update).toHaveBeenCalledTimes(2);
      const second = mockDocumentClientMethods.update.mock.calls[1][0];
      expect(second.UpdateExpression).toContain('SET');
      expect(second.UpdateExpression).toContain('REMOVE');
      expect(second.UpdateExpression).toContain('enrichmentMetadata.#em0 = :em0');
      expect(second.UpdateExpression).toContain('customFields.#cf0 = :cf0');
      expect(second.UpdateExpression).toContain('enrichmentMetadata.#rmem0');
      expect(second.UpdateExpression).toContain('customFields.#rmcf0');
      mergeSpy.mockRestore();
    });

    it('uses if_not_exists in all SET clauses when ifNotExists=true', async () => {
      mockDocumentClientMethods.update.mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      });

      const mergeSpy = jest.spyOn(crmDb, 'mergeFieldNames').mockResolvedValue();
      await crmDb.setLeadFields('list_123', 'lead_123', {
        topLevel: { email: 'a@b.com' },
        enrichmentMetadata: { email: { source: 'web_search' } },
        customFields: { skills: 'TS, Node' },
        ifNotExists: true,
      });

      expect(mockDocumentClientMethods.update).toHaveBeenCalledTimes(2);
      const second = mockDocumentClientMethods.update.mock.calls[1][0];
      expect(second.UpdateExpression).toContain('email = if_not_exists(email, :tl_email)');
      expect(second.UpdateExpression).toContain(
        'enrichmentMetadata.#em0 = if_not_exists(enrichmentMetadata.#em0, :em0)',
      );
      expect(second.UpdateExpression).toContain(
        'customFields.#cf0 = if_not_exists(customFields.#cf0, :cf0)',
      );
      mergeSpy.mockRestore();
    });

    it('registers newly-written customFields keys on the parent list via mergeFieldNames', async () => {
      // The bug this guards against: enrichment writes lead.customFields.Description
      // but the lead-list's fieldNames stays stale, so Configure Display Fields
      // doesn't list "Description" as an available column. Any setLeadFields
      // call that introduces custom keys must keep list.fieldNames in sync.
      mockDocumentClientMethods.update.mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      });
      const getListSpy = jest.spyOn(crmDb, 'getLeadListById')
        .mockResolvedValue({ listId: 'list_123', fieldNames: [] } as any);
      const mergeSpy = jest.spyOn(crmDb, 'mergeFieldNames').mockResolvedValue();

      await crmDb.setLeadFields('list_123', 'lead_123', {
        customFields: { Description: 'Company blurb', funding_round: 'Series C' },
      });

      expect(mergeSpy).toHaveBeenCalledTimes(1);
      expect(mergeSpy.mock.calls[0][0]).toBe('list_123');
      const incoming = mergeSpy.mock.calls[0][1] as Set<string> | string[];
      const keys = incoming instanceof Set ? Array.from(incoming) : incoming;
      expect(new Set(keys)).toEqual(new Set(['Description', 'funding_round']));

      mergeSpy.mockRestore();
      getListSpy.mockRestore();
    });

    it('skips mergeFieldNames append for customFields keys already in list.fieldNames', async () => {
      // The bug this guards against: every per-lead enrichment write was
      // spam-appending shared keys (Description, website, …) into the list's
      // fieldNames array, leaving 5+ copies after enriching 5 leads. Only
      // truly-new keys should be merged in.
      mockDocumentClientMethods.update.mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      });
      const getListSpy = jest.spyOn(crmDb, 'getLeadListById').mockResolvedValue({
        listId: 'list_123',
        fieldNames: ['Description', 'website'],
      } as any);
      const mergeSpy = jest.spyOn(crmDb, 'mergeFieldNames').mockResolvedValue();

      await crmDb.setLeadFields('list_123', 'lead_123', {
        customFields: { Description: 'X', website: 'Y', funding_round: 'Z' },
      });

      // Only the truly-new key gets merged.
      expect(mergeSpy).toHaveBeenCalledTimes(1);
      const keys = mergeSpy.mock.calls[0][1] as string[];
      expect(new Set(keys)).toEqual(new Set(['funding_round']));

      mergeSpy.mockRestore();
      getListSpy.mockRestore();
    });

    it('does not call mergeFieldNames at all when every custom key is already registered', async () => {
      mockDocumentClientMethods.update.mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      });
      const getListSpy = jest.spyOn(crmDb, 'getLeadListById').mockResolvedValue({
        listId: 'list_123',
        fieldNames: ['Description', 'website'],
      } as any);
      const mergeSpy = jest.spyOn(crmDb, 'mergeFieldNames').mockResolvedValue();

      await crmDb.setLeadFields('list_123', 'lead_123', {
        customFields: { Description: 'X', website: 'Y' },
      });

      expect(mergeSpy).not.toHaveBeenCalled();
      mergeSpy.mockRestore();
      getListSpy.mockRestore();
    });

    it('does NOT call mergeFieldNames when only top-level or removal-only fields are written', async () => {
      mockDocumentClientMethods.update.mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      });
      const mergeSpy = jest.spyOn(crmDb, 'mergeFieldNames').mockResolvedValue();

      await crmDb.setLeadFields('list_123', 'lead_123', {
        topLevel: { email: 'a@b.com' },
        removeCustomFieldKeys: ['stale_one'],
      });

      expect(mergeSpy).not.toHaveBeenCalled();
      mergeSpy.mockRestore();
    });

    it('runs bootstrap when only removeCustomFieldKeys is set (no SET keys)', async () => {
      // Regression guard: DynamoDB REMOVE customFields.key throws ValidationException
      // when the customFields map does not exist. Bootstrap must fire even when there
      // are no keys to SET — only REMOVE keys present.
      mockDocumentClientMethods.update.mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      });

      await crmDb.setLeadFields('list_123', 'lead_123', {
        removeCustomFieldKeys: ['tech_stack_analytics', 'tech_stack_cms'],
        removeEnrichmentMetadataKeys: ['tech_stack_analytics', 'tech_stack_cms'],
      });

      // Call 1: bootstrap (if_not_exists both maps)
      // Call 2: combined REMOVE expression
      expect(mockDocumentClientMethods.update).toHaveBeenCalledTimes(2);
      const bootstrap = mockDocumentClientMethods.update.mock.calls[0][0];
      expect(bootstrap.UpdateExpression).toContain('if_not_exists(customFields');
      expect(bootstrap.UpdateExpression).toContain('if_not_exists(enrichmentMetadata');
      const main = mockDocumentClientMethods.update.mock.calls[1][0];
      expect(main.UpdateExpression).toContain('REMOVE');
      expect(main.UpdateExpression).toContain('customFields.#rmcf0');
    });
  });

  describe('mergeFieldNames', () => {
    it('atomically appends via list_append without a read-modify-write', async () => {
      // The previous implementation read-then-set, which loses concurrent writes.
      // The atomic version must NOT call getLeadListById and must use list_append.
      const getSpy = jest.spyOn(crmDb, 'getLeadListById');
      const updateFieldNamesSpy = jest.spyOn(crmDb, 'updateFieldNames');
      mockDocumentClientMethods.update.mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      });

      await crmDb.mergeFieldNames('list_123', new Set(['industry', 'email']));

      // No RMW: the read step is gone.
      expect(getSpy).not.toHaveBeenCalled();
      expect(updateFieldNamesSpy).not.toHaveBeenCalled();

      // Single atomic UpdateItem with list_append.
      expect(mockDocumentClientMethods.update).toHaveBeenCalledTimes(1);
      const call = mockDocumentClientMethods.update.mock.calls[0][0];
      expect(call.UpdateExpression).toMatch(/list_append\(if_not_exists\(fieldNames,\s*:empty\),\s*:incoming\)/);
      // Incoming must be a normalised array (deduped, deterministic order is fine).
      const incoming = call.ExpressionAttributeValues[':incoming'];
      expect(Array.isArray(incoming)).toBe(true);
      expect(new Set(incoming)).toEqual(new Set(['industry', 'email']));
      expect(call.ExpressionAttributeValues[':empty']).toEqual([]);

      getSpy.mockRestore();
      updateFieldNamesSpy.mockRestore();
    });

    it('is a no-op when incoming is empty', async () => {
      mockDocumentClientMethods.update.mockClear();
      await crmDb.mergeFieldNames('list_123', new Set());
      await crmDb.mergeFieldNames('list_123', []);
      expect(mockDocumentClientMethods.update).not.toHaveBeenCalled();
    });
  });

  describe('getLeadListById — fieldNames dedup on read', () => {
    it('dedupes and sorts fieldNames so transient list_append duplicates are hidden', async () => {
      // mergeFieldNames uses list_append, which can leave duplicates in storage
      // under concurrent writes. getLeadListById must clean them on read so all
      // consumers (UI, validators, schema generators) see a clean unique list.
      mockDocumentClientMethods.get.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Item: {
            listId: 'list_123',
            fieldNames: ['industry', 'email', 'industry', 'company_size', 'email'],
          },
        }),
      });

      const result = await crmDb.getLeadListById('list_123');

      expect(result).not.toBeNull();
      expect(result!.fieldNames).toEqual(['company_size', 'email', 'industry']);
    });

    it('leaves an absent fieldNames untouched (does not inject an empty array)', async () => {
      mockDocumentClientMethods.get.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Item: { listId: 'list_456', name: 'No fieldNames yet' },
        }),
      });

      const result = await crmDb.getLeadListById('list_456');
      expect(result).not.toBeNull();
      expect(result).not.toHaveProperty('fieldNames');
    });
  });

  describe('batchCreateLeads', () => {
    it('should batch create leads', async () => {
      const listId = 'list_123';
      const leads = [
        { email: 'test1@example.com', firstName: 'John', lastName: 'Doe' },
        { email: 'test2@example.com', firstName: 'Jane', lastName: 'Smith' },
      ];

      // Mock existing leads query (empty)
      mockDocumentClientMethods.query.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Items: [] }),
      });

      // Mock batch write
      mockDocumentClientMethods.batchWrite.mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      });
      mockDocumentClientMethods.get.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Item: { listId, fieldNames: [] } }),
      });
      mockDocumentClientMethods.update.mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      });

      const result = await crmDb.batchCreateLeads(listId, leads);

      expect(result.successCount).toBe(2);
      expect(result.errorCount).toBe(0);
    });

    it('should merge leads with existing emails', async () => {
      const listId = 'list_123';
      const leads = [
        { email: 'existing@example.com', firstName: 'New', lastName: 'Name' },
      ];

      // Mock existing lead
      mockDocumentClientMethods.query.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Items: [
            { leadId: 'lead1', listId, email: 'existing@example.com', firstName: 'Old' },
          ],
        }),
      });

      mockDocumentClientMethods.update.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Attributes: {
            leadId: 'lead1',
            listId,
            email: 'existing@example.com',
            firstName: 'New',
          },
        }),
      });

      const result = await crmDb.batchCreateLeads(listId, leads);

      expect(result.mergedCount).toBe(1);
      expect(result.newCount).toBe(0);
    });

    it('should skip update if record is identical', async () => {
      const listId = 'list_123';
      const leads = [
        { 
          email: 'existing@example.com', 
          firstName: 'John', 
          lastName: 'Doe',
          customFields: { subscribed: 'yes' }
        },
      ];

      // Mock existing lead with same data
      mockDocumentClientMethods.query.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Items: [
            { 
              leadId: 'lead1', 
              listId, 
              email: 'existing@example.com', 
              firstName: 'John',
              lastName: 'Doe',
              customFields: { subscribed: 'yes' }
            },
          ],
        }),
      });

      mockDocumentClientMethods.get.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Item: { listId, fieldNames: [] } }),
      });

      // updateLead should NOT be called for identical records
      mockDocumentClientMethods.update.mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      });

      const result = await crmDb.batchCreateLeads(listId, leads);

      // Should not count as merged since no update was needed
      expect(result.mergedCount).toBe(0);
      expect(result.newCount).toBe(0);
      expect(result.successCount).toBe(0);
      
      // Verify updateLead was not called for the lead itself
      // (updateFieldNames may still be called to update the list's fieldNames, but that's OK)
      const leadUpdates = mockDocumentClientMethods.update.mock.calls.filter(
        (call: any) => call[0].TableName === `${process.env.TABLE_PREFIX || ''}AW-Leads`
      );
      expect(leadUpdates.length).toBe(0);
    });

    it('should update if customFields are different', async () => {
      const listId = 'list_123';
      const leads = [
        { 
          email: 'existing@example.com', 
          firstName: 'John',
          customFields: { subscribed: 'no' } // Changed from 'yes' to 'no'
        },
      ];

      // Mock existing lead with different subscribed value
      mockDocumentClientMethods.query.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Items: [
            { 
              leadId: 'lead1', 
              listId, 
              email: 'existing@example.com', 
              firstName: 'John',
              customFields: { subscribed: 'yes' }
            },
          ],
        }),
      });

      mockDocumentClientMethods.update.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Attributes: {
            leadId: 'lead1',
            listId,
            email: 'existing@example.com',
            firstName: 'John',
            customFields: { subscribed: 'no' }
          },
        }),
      });

      mockDocumentClientMethods.get.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Item: { listId, fieldNames: [] } }),
      });

      const result = await crmDb.batchCreateLeads(listId, leads);

      expect(result.mergedCount).toBe(1);
      expect(result.successCount).toBe(1);
      expect(mockDocumentClientMethods.update).toHaveBeenCalled();
    });

    it('should update if standard fields are different', async () => {
      const listId = 'list_123';
      const leads = [
        { 
          email: 'existing@example.com', 
          firstName: 'Jane', // Changed from 'John'
          lastName: 'Doe',
        },
      ];

      // Mock existing lead
      mockDocumentClientMethods.query.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Items: [
            { 
              leadId: 'lead1', 
              listId, 
              email: 'existing@example.com', 
              firstName: 'John',
              lastName: 'Doe',
            },
          ],
        }),
      });

      mockDocumentClientMethods.update.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Attributes: {
            leadId: 'lead1',
            listId,
            email: 'existing@example.com',
            firstName: 'Jane',
            lastName: 'Doe',
          },
        }),
      });

      mockDocumentClientMethods.get.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Item: { listId, fieldNames: [] } }),
      });

      const result = await crmDb.batchCreateLeads(listId, leads);

      expect(result.mergedCount).toBe(1);
      expect(result.successCount).toBe(1);
      expect(mockDocumentClientMethods.update).toHaveBeenCalled();
    });

    // Fix 2: dedup against existing leads' LinkedIn URL (in addition to email).
    // Caught in production: Emma's import_leads_from_search produced 21 leads
    // that overlapped with existing list members on LinkedIn URL but had no
    // email — bypassing the email-only dedup and inserting duplicates.
    describe('LinkedIn URL deduplication', () => {
      it('merges incoming lead with existing lead when LinkedIn URLs match (different format)', async () => {
        const listId = 'list_123';
        const leads = [
          // No email; LinkedIn URL with trailing slash + http scheme
          { firstName: 'New', linkedin: 'http://linkedin.com/in/jdoe/' },
        ];

        // Existing lead has the canonical form: https://www.linkedin.com/in/jdoe
        mockDocumentClientMethods.query.mockReturnValue({
          promise: jest.fn().mockResolvedValue({
            Items: [
              { leadId: 'lead1', listId, email: 'old@example.com', linkedin: 'https://www.linkedin.com/in/jdoe', firstName: 'Old' },
            ],
          }),
        });
        mockDocumentClientMethods.update.mockReturnValue({
          promise: jest.fn().mockResolvedValue({
            Attributes: { leadId: 'lead1', listId, firstName: 'New' },
          }),
        });
        mockDocumentClientMethods.get.mockReturnValue({
          promise: jest.fn().mockResolvedValue({ Item: { listId, fieldNames: [] } }),
        });

        const result = await crmDb.batchCreateLeads(listId, leads);

        expect(result.mergedCount).toBe(1);
        expect(result.newCount).toBe(0);
        // No new lead written via batchWrite — would have been a dup
        expect(mockDocumentClientMethods.batchWrite).not.toHaveBeenCalled();
      });

      it('treats two incoming leads with same normalized LinkedIn URL as one (within-batch dedup)', async () => {
        const listId = 'list_123';
        const leads = [
          { firstName: 'A', linkedin: 'https://www.linkedin.com/in/jdoe' },
          { firstName: 'B', linkedin: 'https://linkedin.com/in/jdoe/' },  // same person, different format
        ];

        mockDocumentClientMethods.query.mockReturnValue({
          promise: jest.fn().mockResolvedValue({ Items: [] }),
        });
        mockDocumentClientMethods.batchWrite.mockReturnValue({
          promise: jest.fn().mockResolvedValue({}),
        });
        mockDocumentClientMethods.get.mockReturnValue({
          promise: jest.fn().mockResolvedValue({ Item: { listId, fieldNames: [] } }),
        });

        const result = await crmDb.batchCreateLeads(listId, leads);

        // Only ONE unique lead should be written
        const batchCall = mockDocumentClientMethods.batchWrite.mock.calls[0]?.[0];
        const writes = batchCall?.RequestItems?.[Object.keys(batchCall.RequestItems)[0]] ?? [];
        expect(writes.length).toBe(1);
        expect(result.successCount).toBe(1);
      });

      it('stores the canonical normalized LinkedIn URL on write so future reads are clean', async () => {
        const listId = 'list_123';
        const leads = [
          { firstName: 'A', linkedin: 'http://LinkedIn.com/in/JDoe/?ref=foo' },
        ];

        mockDocumentClientMethods.query.mockReturnValue({
          promise: jest.fn().mockResolvedValue({ Items: [] }),
        });
        mockDocumentClientMethods.batchWrite.mockReturnValue({
          promise: jest.fn().mockResolvedValue({}),
        });
        mockDocumentClientMethods.get.mockReturnValue({
          promise: jest.fn().mockResolvedValue({ Item: { listId, fieldNames: [] } }),
        });

        await crmDb.batchCreateLeads(listId, leads);

        const batchCall = mockDocumentClientMethods.batchWrite.mock.calls[0][0];
        const tableKey = Object.keys(batchCall.RequestItems)[0];
        const stored = batchCall.RequestItems[tableKey][0].PutRequest.Item;
        expect(stored.linkedin).toBe('https://www.linkedin.com/in/jdoe');
      });

      it('does not match leads whose linkedin field is empty', async () => {
        const listId = 'list_123';
        const leads = [
          { firstName: 'A', linkedin: '' },
          { firstName: 'B' },  // no linkedin at all
        ];

        mockDocumentClientMethods.query.mockReturnValue({
          promise: jest.fn().mockResolvedValue({
            Items: [
              { leadId: 'lead1', listId, email: 'x@y.com', linkedin: '' },
            ],
          }),
        });
        mockDocumentClientMethods.batchWrite.mockReturnValue({
          promise: jest.fn().mockResolvedValue({}),
        });
        mockDocumentClientMethods.get.mockReturnValue({
          promise: jest.fn().mockResolvedValue({ Item: { listId, fieldNames: [] } }),
        });

        const result = await crmDb.batchCreateLeads(listId, leads);

        // Both incoming should be inserted — empty-linkedin shouldn't merge to anything
        expect(result.successCount).toBe(2);
      });
    });
  });

  describe('getLeadEngagements', () => {
    it('should retrieve engagements for a lead', async () => {
      const listId = 'list_123';
      const leadId = 'lead_123';
      const userId = 'user1';

      const mockLead = {
        leadId,
        listId,
        email: 'lead@example.com',
        engagements: [
          {
            eventType: 'custom.meeting',
            eventData: { notes: 'Test meeting' },
            createdAt: '2024-01-01T00:00:00Z',
            source: 'manual',
            eventId: 'event1',
          },
        ],
      };

      mockDocumentClientMethods.get.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Item: mockLead }),
      });

      // Mock emailEventsDb
      const { emailEventsDb } = require('../services/emailEventsDb');
      emailEventsDb.getEventsByEmailDomainAndLeadEmail.mockResolvedValue([]);

      // Mock userDb.getUserById (used in getLeadEngagements)
      const { userDb } = require('../services/db');
      jest.spyOn(userDb, 'getUserById').mockResolvedValue({
        userId,
        email: 'user@example.com',
        emailDomain: 'example.com',
      });

      const result = await crmDb.getLeadEngagements(listId, leadId, userId);

      expect(result.engagements).toBeDefined();
      expect(Array.isArray(result.engagements)).toBe(true);
    });

    it('should include email content from engagements', async () => {
      const listId = 'list_123';
      const leadId = 'lead_123';
      const userId = 'user1';

      const mockLead = {
        leadId,
        listId,
        email: 'lead@example.com',
        engagements: [],
      };

      const mockEmailEvent = {
        eventId: 'event1',
        eventType: 'email.received',
        emailDomain: 'example.com',
        leadEmail: 'lead@example.com',
        data: {
          subject: 'Test Email',
          from: 'sender@example.com',
          to: ['lead@example.com'],
          email_id: 'email-123',
        },
        emailContent: {
          html: '<p>Email content</p>',
          text: 'Email content',
        },
        createdAt: '2024-01-01T00:00:00Z',
      };

      mockDocumentClientMethods.get.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Item: mockLead }),
      });

      // Mock emailEventsDb
      const { emailEventsDb } = require('../services/emailEventsDb');
      emailEventsDb.getEventsByEmailDomainAndLeadEmail.mockResolvedValue([mockEmailEvent]);
      emailEventsDb.updateEmailEventContent.mockResolvedValue(undefined);

      // Mock userDb.getUserById
      const { userDb } = require('../services/db');
      jest.spyOn(userDb, 'getUserById').mockResolvedValue({
        userId,
        email: 'user@example.com',
        emailDomain: 'example.com',
      });

      const result = await crmDb.getLeadEngagements(listId, leadId, userId);

      expect(result.engagements).toHaveLength(1);
      // The emailContent should be included from the cached event.emailContent
      const engagement = result.engagements[0];
      expect(engagement).toBeDefined();
      // Since event.emailContent exists, it should be used directly
      expect(engagement.emailContent).toBeDefined();
      expect(engagement.emailContent.html).toBe('<p>Email content</p>');
    });
  });

  describe('addLeadEngagement', () => {
    it('should add a custom engagement to a lead', async () => {
      const listId = 'list_123';
      const leadId = 'lead_123';
      const engagement = {
        eventType: 'custom.meeting',
        eventData: { notes: 'Test meeting' },
        createdAt: '2024-01-01T00:00:00Z',
      };

      const mockLead = {
        leadId,
        listId,
        engagements: [],
      };

      mockDocumentClientMethods.get.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Item: mockLead }),
      });

      mockDocumentClientMethods.update.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Attributes: {
            leadId,
            listId,
            engagements: [{ ...engagement, eventId: 'event1' }],
          },
        }),
      });

      const result = await crmDb.addLeadEngagement(listId, leadId, engagement);

      expect(mockDocumentClientMethods.update).toHaveBeenCalled();
      expect(result).toBeTruthy();
      expect(result!.engagements).toContainEqual(
        expect.objectContaining({
          eventType: 'custom.meeting',
        })
      );
    });

    it('should generate eventId for custom engagements', async () => {
      const listId = 'list_123';
      const leadId = 'lead_123';
      const engagement = {
        eventType: 'custom.meeting',
        eventData: { notes: 'Test meeting' },
        createdAt: '2024-01-01T00:00:00Z',
      };

      const mockLead = {
        leadId,
        listId,
        engagements: [],
      };

      mockDocumentClientMethods.get.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Item: mockLead }),
      });

      mockDocumentClientMethods.update.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Attributes: {
            leadId,
            listId,
            engagements: [{ ...engagement, eventId: 'event1' }],
          },
        }),
      });

      const result = await crmDb.addLeadEngagement(listId, leadId, engagement);

      expect(result).toBeTruthy();
      const addedEngagement = result!.engagements.find(
        (e: any) => e.eventType === 'custom.meeting'
      );
      expect(addedEngagement.eventId).toBeDefined();
    });
  });

  describe('deleteLeadEngagement', () => {
    it('should delete an engagement by eventId', async () => {
      const listId = 'list_123';
      const leadId = 'lead_123';
      const eventId = 'event1';

      const existingEngagements = [
        {
          eventId: 'event1',
          eventType: 'custom.meeting',
          createdAt: '2024-01-01T00:00:00Z',
        },
        {
          eventId: 'event2',
          eventType: 'custom.call',
          createdAt: '2024-01-02T00:00:00Z',
        },
      ];

      mockDocumentClientMethods.get.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Item: {
            leadId,
            listId,
            engagements: existingEngagements,
          },
        }),
      });

      mockDocumentClientMethods.update.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Attributes: {
            leadId,
            listId,
            engagements: [existingEngagements[1]], // Remaining engagement
          },
        }),
      });

      const result = await crmDb.deleteLeadEngagement(listId, leadId, eventId);

      expect(result).toBeTruthy();
      expect(result!.engagements).toHaveLength(1);
      expect(result!.engagements[0].eventId).toBe('event2');
    });
  });

  describe('getLeadEngagementCount', () => {
    it('should return engagement counts', async () => {
      const listId = 'list_123';
      const leadId = 'lead_123';
      const userId = 'user1';

      const mockLead = {
        leadId,
        listId,
        engagements: [
          {
            eventType: 'custom.meeting',
            createdAt: new Date().toISOString(), // Recent
          },
          {
            eventType: 'custom.call',
            createdAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(), // 10 days ago
          },
        ],
      };

      mockDocumentClientMethods.get.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Item: mockLead }),
      });

      mockDocumentClientMethods.query.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Items: [] }),
      });

      // Mock userDb.getUserById
      const { userDb } = require('../services/db');
      jest.spyOn(userDb, 'getUserById').mockResolvedValue({
        userId,
        email: 'user@example.com',
        emailDomain: 'example.com',
      });

      const result = await crmDb.getLeadEngagementCount(listId, leadId, userId);

      expect(result.total).toBeGreaterThanOrEqual(0);
      expect(result.last7Days).toBeGreaterThanOrEqual(0);
    });
  });

  describe('getLeadEngagements - LinkedIn without emailDomain', () => {
    it('should return LinkedIn events even when user has no emailDomain configured', async () => {
      const listId = 'list_123';
      const leadId = 'lead_123';
      const userId = 'user1';

      const mockLead = {
        leadId,
        listId,
        email: null, // No email
        linkedin: 'https://www.linkedin.com/in/testuser',
        engagements: [], // No manual engagements
      };

      const mockLinkedInEvents = [
        {
          eventId: 'linkedin-event1',
          eventType: 'linkedin.message.sent',
          emailDomain: `linkedin-${listId}`,
          leadEmail: 'https://www.linkedin.com/in/testuser',
          data: {
            conversationId: 'conv1',
            from: 'User Name',
            content: 'Test message',
            date: '2024-01-01T00:00:00Z',
          },
          createdAt: '2024-01-01T00:00:00Z',
        },
        {
          eventId: 'linkedin-event2',
          eventType: 'linkedin.message.received',
          emailDomain: `linkedin-${listId}`,
          leadEmail: 'https://www.linkedin.com/in/testuser',
          data: {
            conversationId: 'conv1',
            from: 'Lead Name',
            content: 'Reply message',
            date: '2024-01-02T00:00:00Z',
          },
          createdAt: '2024-01-02T00:00:00Z',
        },
      ];

      mockDocumentClientMethods.get.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Item: mockLead }),
      });

      // Mock emailEventsDb - only LinkedIn query will be called since no email/emailDomain
      const { emailEventsDb } = require('../services/emailEventsDb');
      emailEventsDb.getEventsByEmailDomainAndLeadEmail.mockReset();
      emailEventsDb.getEventsByEmailDomainAndLeadEmail.mockResolvedValue(mockLinkedInEvents);

      // Mock userDb.getUserById - user has NO emailDomain configured
      const { userDb } = require('../services/db');
      jest.spyOn(userDb, 'getUserById').mockResolvedValue({
        userId,
        email: 'user@example.com',
        // emailDomain is NOT set
      });

      const result = await crmDb.getLeadEngagements(listId, leadId, userId);

      // Should return the LinkedIn events even though user has no emailDomain
      expect(result.engagements).toBeDefined();
      expect(result.engagements).toHaveLength(2);
      expect(result.engagements[0].eventType).toMatch(/linkedin\.message\./);
      expect(result.engagements[1].eventType).toMatch(/linkedin\.message\./);

      // Verify that LinkedIn events query was called with correct domain
      expect(emailEventsDb.getEventsByEmailDomainAndLeadEmail).toHaveBeenCalledWith(
        `linkedin-${listId}`,
        'https://www.linkedin.com/in/testuser'
      );
    });

    it('should return both email and LinkedIn events when user has emailDomain', async () => {
      const listId = 'list_123';
      const leadId = 'lead_123';
      const userId = 'user1';

      const mockLead = {
        leadId,
        listId,
        email: 'lead@example.com',
        linkedin: 'https://www.linkedin.com/in/testuser',
        engagements: [],
      };

      const mockEmailEvent = {
        eventId: 'email-event1',
        eventType: 'email.sent',
        emailDomain: 'example.com',
        leadEmail: 'lead@example.com',
        data: {
          subject: 'Test Email',
          email_id: 'email-123',
        },
        createdAt: '2024-01-01T00:00:00Z',
      };

      const mockLinkedInEvent = {
        eventId: 'linkedin-event1',
        eventType: 'linkedin.message.sent',
        emailDomain: `linkedin-${listId}`,
        leadEmail: 'https://www.linkedin.com/in/testuser',
        data: {
          conversationId: 'conv1',
          from: 'User Name',
          content: 'Test message',
        },
        createdAt: '2024-01-02T00:00:00Z',
      };

      mockDocumentClientMethods.get.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Item: mockLead }),
      });

      // Mock emailEventsDb - set up to return different results for different domains
      const { emailEventsDb } = require('../services/emailEventsDb');
      emailEventsDb.getEventsByEmailDomainAndLeadEmail.mockReset();
      emailEventsDb.getEventsByEmailDomainAndLeadEmail.mockImplementation(
        (domain: string, leadEmail: string) => {
          if (domain === 'example.com') {
            return Promise.resolve([mockEmailEvent]);
          } else if (domain === `linkedin-${listId}`) {
            return Promise.resolve([mockLinkedInEvent]);
          }
          return Promise.resolve([]);
        }
      );

      // Mock userDb.getUserById - user HAS emailDomain configured
      const { userDb } = require('../services/db');
      jest.spyOn(userDb, 'getUserById').mockResolvedValue({
        userId,
        email: 'user@example.com',
        emailDomain: 'example.com',
      });

      const result = await crmDb.getLeadEngagements(listId, leadId, userId);

      // Should return both email and LinkedIn events
      expect(result.engagements).toBeDefined();
      expect(result.engagements).toHaveLength(2);

      const eventTypes = result.engagements.map((e: any) => e.eventType);
      expect(eventTypes).toContain('email.sent');
      expect(eventTypes).toContain('linkedin.message.sent');

      // Verify both queries were made
      expect(emailEventsDb.getEventsByEmailDomainAndLeadEmail).toHaveBeenCalledWith(
        'example.com',
        'lead@example.com'
      );
      expect(emailEventsDb.getEventsByEmailDomainAndLeadEmail).toHaveBeenCalledWith(
        `linkedin-${listId}`,
        'https://www.linkedin.com/in/testuser'
      );
    });
  });

  describe('updateLeadList', () => {
    it('should update csvExportHistory on a lead list', async () => {
      const listId = 'list_123';
      const csvExportHistory = [
        {
          exportId: 'exp_1',
          recordCount: 10,
          exportedAt: '2026-02-18T00:00:00.000Z',
          fileUrl: 'https://s3.amazonaws.com/bucket/file.csv',
          filename: 'export.csv',
        },
      ];

      mockDocumentClientMethods.update.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Attributes: { listId, csvExportHistory },
        }),
      });

      const result = await crmDb.updateLeadList(listId, { csvExportHistory });

      expect(mockDocumentClientMethods.update).toHaveBeenCalled();
      const updateCall = mockDocumentClientMethods.update.mock.calls[0][0];
      expect(updateCall.UpdateExpression).toContain('#csvExportHistory = :csvExportHistory');
      expect(updateCall.ExpressionAttributeValues[':csvExportHistory']).toEqual(csvExportHistory);
      expect(result).toEqual({ listId, csvExportHistory });
    });

    it('should update name on a lead list', async () => {
      const listId = 'list_123';

      mockDocumentClientMethods.update.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Attributes: { listId, name: 'New Name' },
        }),
      });

      const result = await crmDb.updateLeadList(listId, { name: 'New Name' });

      expect(mockDocumentClientMethods.update).toHaveBeenCalled();
      const updateCall = mockDocumentClientMethods.update.mock.calls[0][0];
      expect(updateCall.UpdateExpression).toContain('#name = :name');
      expect(updateCall.ExpressionAttributeValues[':name']).toBe('New Name');
    });

    it('should return existing list when no updates are provided', async () => {
      const listId = 'list_123';
      const mockList = { listId, name: 'Test List' };

      mockDocumentClientMethods.get.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Item: mockList }),
      });

      const result = await crmDb.updateLeadList(listId, {});

      expect(mockDocumentClientMethods.update).not.toHaveBeenCalled();
      expect(mockDocumentClientMethods.get).toHaveBeenCalled();
      expect(result).toEqual(mockList);
    });
  });

  // Direct unit coverage for the real org-shared access predicate. PR #1895 routes
  // all 10 AgentModeService CRM-list methods through this helper, but those service
  // tests MOCK it — so this is the only place its actual orgId-matching logic is
  // exercised. The reported bug (Fangfang, a same-org non-owner, denied add_leads)
  // is fixed iff this returns true for a same-org non-owner; that is the first case.
  describe('canOrgMemberAccessList (org-shared access predicate)', () => {
    const OWNER = 'owner-1';
    const list = { listId: 'list-1', userId: OWNER };
    let getUserByIdSpy: jest.SpyInstance;

    const mockUsers = (byId: Record<string, any>) => {
      getUserByIdSpy = jest
        .spyOn(userDb, 'getUserById')
        .mockImplementation(async (id: string) => byId[id] ?? null);
    };

    afterEach(() => {
      getUserByIdSpy?.mockRestore();
    });

    it('returns true for the list owner without any user lookup (owner short-circuit)', async () => {
      mockUsers({});
      const result = await crmDb.canOrgMemberAccessList(OWNER, list);
      expect(result).toBe(true);
      expect(getUserByIdSpy).not.toHaveBeenCalled();
    });

    it('returns true for a same-org non-owner member (the reported Fangfang case)', async () => {
      mockUsers({
        'member-2': { userId: 'member-2', orgId: 'org-A' },
        [OWNER]: { userId: OWNER, orgId: 'org-A' },
      });
      const result = await crmDb.canOrgMemberAccessList('member-2', list);
      expect(result).toBe(true);
    });

    it('returns false for a user in a different org', async () => {
      mockUsers({
        'outsider-3': { userId: 'outsider-3', orgId: 'org-B' },
        [OWNER]: { userId: OWNER, orgId: 'org-A' },
      });
      expect(await crmDb.canOrgMemberAccessList('outsider-3', list)).toBe(false);
    });

    it('returns false when the caller has no orgId', async () => {
      mockUsers({
        'solo-4': { userId: 'solo-4' },
        [OWNER]: { userId: OWNER, orgId: 'org-A' },
      });
      expect(await crmDb.canOrgMemberAccessList('solo-4', list)).toBe(false);
    });

    it('returns false when the list owner has no orgId', async () => {
      mockUsers({
        'member-2': { userId: 'member-2', orgId: 'org-A' },
        [OWNER]: { userId: OWNER },
      });
      expect(await crmDb.canOrgMemberAccessList('member-2', list)).toBe(false);
    });

    it('returns false when both users lack an orgId (no undefined===undefined match)', async () => {
      mockUsers({
        'member-2': { userId: 'member-2' },
        [OWNER]: { userId: OWNER },
      });
      expect(await crmDb.canOrgMemberAccessList('member-2', list)).toBe(false);
    });

    it('returns false when the caller record is missing entirely', async () => {
      mockUsers({ [OWNER]: { userId: OWNER, orgId: 'org-A' } });
      expect(await crmDb.canOrgMemberAccessList('ghost-5', list)).toBe(false);
    });
  });
  // ENG-787: findLeadsByLinkedin caps at 10 items across ALL tenants, so a profile
  // present in many lists could page past the caller's list and be reported absent —
  // which makes the invite mirror create a duplicate lead. findLeadByLinkedinInList
  // filters server-side and pages until it finds the match.
  describe('findLeadByLinkedinInList', () => {
    const LIST = 'list_target';
    const URL = 'https://www.linkedin.com/in/david-yao';

    it('returns null without querying when listId or linkedin is blank', async () => {
      expect(await crmDb.findLeadByLinkedinInList('', URL)).toBeNull();
      expect(await crmDb.findLeadByLinkedinInList(LIST, '   ')).toBeNull();
      expect(mockDocumentClientMethods.query).not.toHaveBeenCalled();
    });

    it('filters on listId server-side rather than post-filtering a capped page', async () => {
      mockDocumentClientMethods.query.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Items: [{ leadId: 'lead_1', listId: LIST }] }),
      });
      const hit = await crmDb.findLeadByLinkedinInList(LIST, URL);
      expect(hit).toEqual({ leadId: 'lead_1', listId: LIST });
      expect(mockDocumentClientMethods.query).toHaveBeenCalledWith(expect.objectContaining({
        IndexName: 'LinkedinLookupIndex',
        KeyConditionExpression: 'linkedin = :linkedin',
        FilterExpression: 'listId = :listId',
        ExpressionAttributeValues: { ':linkedin': URL, ':listId': LIST },
      }));
      // A per-page Limit bounds read units, but unlike the old fixed cap of 10 it
      // does not bound the search — pagination below walks the rest of the partition.
      expect(mockDocumentClientMethods.query.mock.calls[0][0]).toHaveProperty('Limit', 100);
    });

    it('pages past filtered-out matches instead of giving up on the first page', async () => {
      mockDocumentClientMethods.query
        .mockReturnValueOnce({
          promise: jest.fn().mockResolvedValue({ Items: [], LastEvaluatedKey: { k: 1 } }),
        })
        .mockReturnValueOnce({
          promise: jest.fn().mockResolvedValue({ Items: [{ leadId: 'lead_deep', listId: LIST }] }),
        });
      const hit = await crmDb.findLeadByLinkedinInList(LIST, URL);
      expect(hit).toEqual({ leadId: 'lead_deep', listId: LIST });
      expect(mockDocumentClientMethods.query).toHaveBeenCalledTimes(2);
      expect(mockDocumentClientMethods.query.mock.calls[1][0]).toEqual(
        expect.objectContaining({ ExclusiveStartKey: { k: 1 } }),
      );
    });

    it('returns null when the profile exists only in other lists', async () => {
      mockDocumentClientMethods.query.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Items: [] }),
      });
      expect(await crmDb.findLeadByLinkedinInList(LIST, URL)).toBeNull();
    });

    it('stops paging at the bound instead of spinning forever', async () => {
      mockDocumentClientMethods.query.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Items: [], LastEvaluatedKey: { k: 1 } }),
      });
      expect(await crmDb.findLeadByLinkedinInList(LIST, URL)).toBeNull();
      expect(mockDocumentClientMethods.query).toHaveBeenCalledTimes(20);
    });
  });
  // ENG-787 hardening: addLeadEngagement used to read-modify-write the whole
  // engagements array, so two concurrent appends both read the same base and the
  // second silently dropped the first.
  describe('addLeadEngagement', () => {
    const LIST = 'list_1';
    const LEAD = 'lead_1';
    const ev = { eventType: 'linkedin.invite.sent', eventData: { linkedin: 'x' }, createdAt: '2026-07-31T00:00:00.000Z' };

    it('appends server-side with list_append instead of rewriting the array', async () => {
      mockDocumentClientMethods.update.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Attributes: { engagements: [ev] } }),
      });

      await crmDb.addLeadEngagement(LIST, LEAD, ev);

      const params = mockDocumentClientMethods.update.mock.calls[0][0];
      expect(params.UpdateExpression).toContain('list_append(if_not_exists(engagements, :empty), :new)');
      expect(params.ExpressionAttributeValues[':new']).toHaveLength(1);
      expect(params.ExpressionAttributeValues[':new'][0]).toEqual(expect.objectContaining({
        eventType: 'linkedin.invite.sent',
        eventId: expect.any(String),
      }));
      // No pre-read of the lead — existence is enforced by the condition instead.
      expect(params.ConditionExpression).toBe('attribute_exists(leadId)');
      expect(mockDocumentClientMethods.get).not.toHaveBeenCalled();
    });

    it('raises isEngaged for a matching event', async () => {
      mockDocumentClientMethods.update.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Attributes: {} }),
      });
      await crmDb.addLeadEngagement(LIST, LEAD, { ...ev, eventType: 'email.replied' });
      const params = mockDocumentClientMethods.update.mock.calls[0][0];
      expect(params.UpdateExpression).toContain('isEngaged = :isEngaged');
      expect(params.ExpressionAttributeValues[':isEngaged']).toBe(1);
    });

    it('never lowers isEngaged for a non-matching event', async () => {
      mockDocumentClientMethods.update.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Attributes: {} }),
      });
      await crmDb.addLeadEngagement(LIST, LEAD, ev);
      const params = mockDocumentClientMethods.update.mock.calls[0][0];
      expect(params.UpdateExpression).not.toContain('isEngaged');
      expect(params.ExpressionAttributeValues).not.toHaveProperty(':isEngaged');
    });

    it('reports a missing lead when the condition fails', async () => {
      const err: any = new Error('conditional request failed');
      err.code = 'ConditionalCheckFailedException';
      mockDocumentClientMethods.update.mockReturnValue({
        promise: jest.fn().mockRejectedValue(err),
      });
      await expect(crmDb.addLeadEngagement(LIST, LEAD, ev)).rejects.toThrow('Lead not found');
    });

    it('warns when the engagements array approaches the item-size ceiling', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      mockDocumentClientMethods.update.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Attributes: { engagements: new Array(500).fill(ev) } }),
      });
      await crmDb.addLeadEngagement(LIST, LEAD, ev);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('approaching the DynamoDB item-size ceiling'));
      warn.mockRestore();
    });
  });

  // ENG-787 hardening: canonicalization must never discard a value it cannot
  // canonicalize — normalizeLinkedInUrl returns '' for non-personal URLs.
  describe('LinkedIn canonicalization preserves un-canonicalizable values', () => {
    it('createLead keeps a company URL rather than dropping the field', async () => {
      mockDocumentClientMethods.put.mockReturnValue({ promise: jest.fn().mockResolvedValue({}) });
      mockDocumentClientMethods.get.mockReturnValue({ promise: jest.fn().mockResolvedValue({ Item: null }) });
      mockDocumentClientMethods.update.mockReturnValue({ promise: jest.fn().mockResolvedValue({ Attributes: {} }) });

      await crmDb.createLead('list_1', { linkedin: '  https://www.linkedin.com/company/acme  ' });

      const item = mockDocumentClientMethods.put.mock.calls[0][0].Item;
      expect(item.linkedin).toBe('https://www.linkedin.com/company/acme');
    });

    it('updateLead keeps a company URL rather than REMOVEing it', async () => {
      mockDocumentClientMethods.update.mockReturnValue({ promise: jest.fn().mockResolvedValue({ Attributes: {} }) });

      await crmDb.updateLead('list_1', 'lead_1', { linkedin: 'https://www.linkedin.com/company/acme' });

      const params = mockDocumentClientMethods.update.mock.calls[0][0];
      expect(params.UpdateExpression).toContain('linkedin = :linkedin');
      expect(params.UpdateExpression).not.toMatch(/REMOVE[^A-Za-z]*linkedin/);
      expect(params.ExpressionAttributeValues[':linkedin']).toBe('https://www.linkedin.com/company/acme');
    });

    it('updateLead still REMOVEs linkedin when the caller sends an empty value', async () => {
      mockDocumentClientMethods.update.mockReturnValue({ promise: jest.fn().mockResolvedValue({ Attributes: {} }) });

      await crmDb.updateLead('list_1', 'lead_1', { linkedin: '   ' });

      const params = mockDocumentClientMethods.update.mock.calls[0][0];
      expect(params.UpdateExpression).toMatch(/REMOVE/);
      expect(params.ExpressionAttributeValues).not.toHaveProperty(':linkedin');
    });
  });
});
