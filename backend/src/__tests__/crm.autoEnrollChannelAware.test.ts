/**
 * routes/crm.ts's copy of autoEnrollLeadInSequences is channel-aware.
 *
 * Two copies of this function exist — this one and routes/webhooks.ts's — and testing
 * the shared predicates alone left both call sites unpinned, so each needs its own
 * guard. See webhooks.autoEnrollChannelAware.test.ts for the twin.
 *
 * (A dead duplicate `jest.mock('../services/db', ...)` stood here, overridden by the
 * one below, which is why every test hand-assigns its own crmDb fixtures. Removing it
 * changes nothing at runtime; it was only ever misleading. The docstring it carried
 * described an unrelated ENG-1388 enrichment endpoint.)
 */

const mockExecute = jest.fn();
jest.mock('../services/crmEnrichmentService', () => ({
  CrmEnrichmentService: jest.fn().mockImplementation(() => ({ execute: (...a: any[]) => mockExecute(...a) })),
}));

jest.mock('../server', () => ({
  io: { to: jest.fn().mockReturnValue({ emit: jest.fn() }), emit: jest.fn() },
  app: {},
}));

jest.mock('../controllers/templates', () => ({
  createTemplate: jest.fn(),
  getTemplates: jest.fn(),
  getTemplate: jest.fn(),
  updateTemplate: jest.fn(),
  deleteTemplate: jest.fn(),
  publishTemplate: jest.fn(),
}));

const mockSearchWeb = jest.fn();
jest.mock('../services/agentModeService', () => ({
  agentModeService: { youSearchWeb: (...args: any[]) => mockSearchWeb(...args) },
}));

const dynamoScan = jest.fn();
jest.mock('aws-sdk', () => {
  return {
    DynamoDB: Object.assign(
      jest.fn().mockImplementation(() => ({
        createTable: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
        waitFor: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      })),
      {
        DocumentClient: jest.fn().mockImplementation(() => ({
          scan: (...args: any[]) => ({ promise: () => dynamoScan(...args) }),
        })),
      }
    ),
    SecretsManager: jest.fn().mockImplementation(() => ({
      getSecretValue: jest.fn().mockReturnValue({
        promise: jest.fn().mockResolvedValue({ SecretString: '{}' }),
      }),
    })),
  };
});

jest.mock('../config/aws', () => ({
  dynamodb: {
    get: jest.fn().mockReturnValue({ promise: () => Promise.resolve({}) }),
    put: jest.fn().mockReturnValue({ promise: () => Promise.resolve({}) }),
    update: jest.fn().mockReturnValue({ promise: () => Promise.resolve({}) }),
    delete: jest.fn().mockReturnValue({ promise: () => Promise.resolve({}) }),
    query: jest.fn().mockReturnValue({ promise: () => Promise.resolve({ Items: [] }) }),
    scan: jest.fn().mockReturnValue({ promise: () => Promise.resolve({ Items: [] }) }),
  },
}));

const mockGetLeadListById = jest.fn();
const mockGetLeadById = jest.fn();
jest.mock('../services/db', () => ({
  crmDb: {
    getLeadListById: (...a: any[]) => mockGetLeadListById(...a),
    getLeadById: (...a: any[]) => mockGetLeadById(...a),
  },
  taskDb: {},
  subscriberDb: {},
  userDb: {},
  orgDb: {},
}));

jest.mock('../services/dealDb', () => ({
  dealDb: {},
  DealAuthError: class extends Error {},
  DealNotFoundError: class extends Error {},
  DEAL_STAGES: [],
}));

jest.mock('../services/settingsService', () => ({ settingsService: { getSetting: jest.fn(), setSetting: jest.fn() } }));
jest.mock('../services/resendService', () => ({ resendService: { sendEmail: jest.fn() } }));
jest.mock('../services/leadListAlertService', () => ({ leadListAlertService: {} }));
jest.mock('../services/contactSyncService', () => ({ syncContact: jest.fn() }));
jest.mock('../services/internalEnrichmentService', () => ({
  enrichContact: jest.fn(),
  defaultEnrichmentCache: {},
}));
jest.mock('../services/contactDedupService', () => ({ dedupContactsForUser: jest.fn() }));
jest.mock('../services/emailEventsDb', () => ({ emailEventsDb: {} }));
jest.mock('../services/externalCrmSyncService', () => ({ externalCrmSyncService: {} }));
jest.mock('../services/dripSequenceDb', () => ({
  dripSequenceDb: { getSequencesByAutoEnrollList: jest.fn(), bulkEnroll: jest.fn() },
}));

const mockUser: { userId: string; email: string; isAdmin: boolean } = {
  userId: 'user-A',
  email: 'a@acme.io',
  isAdmin: false,
};

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = mockUser.userId
      ? { userId: mockUser.userId, email: mockUser.email, isAdmin: mockUser.isAdmin }
      : undefined;
    next();
  },
  AuthenticatedRequest: {},
}));

import express from 'express';
import request from 'supertest';
import router from '../routes/crm';

const app = express();
app.use(express.json());
app.use('/api/crm', router);

beforeEach(() => {
  jest.clearAllMocks();
  mockUser.userId = 'user-A';
  mockUser.email = 'a@acme.io';
  mockUser.isAdmin = false;
  dynamoScan.mockReset();
});


beforeEach(() => {
  jest.clearAllMocks();
  mockUser.userId = 'user-A';
  mockGetLeadListById.mockResolvedValue({ listId: 'l1', userId: 'user-A' });
  mockGetLeadById.mockResolvedValue({ leadId: 'lead1', listId: 'l1' });
  mockExecute.mockResolvedValue({ processed: 1 });
});


import { autoEnrollLeadInSequences, autoEnrollListIntoSequences } from '../routes/crm';
import { dripSequenceDb } from '../services/dripSequenceDb';
import { crmDb } from '../services/db';

const mockSeqDb = dripSequenceDb as jest.Mocked<typeof dripSequenceDb>;
const mockCrm = crmDb as jest.Mocked<typeof crmDb>;

const linkedInSequence = {
  sequenceId: 'seq-1', userId: 'user-1',
  steps: [{ stepId: 's1', stepNumber: 1, channel: 'linkedin', messageText: 'hi', delayDays: 0 }],
} as any;

beforeEach(() => {
  jest.clearAllMocks();
  (mockSeqDb.getSequencesByAutoEnrollList as jest.Mock).mockResolvedValue([linkedInSequence]);
  (mockSeqDb.bulkEnroll as jest.Mock).mockResolvedValue({ enrolled: 1, skipped: 0 });
});

/*
 * crm.ts must USE the shared predicates, not merely have them available.
 *
 * Testing the predicates alone left both call sites unpinned: a mutation restoring the
 * `.filter(l => l.email)` email-only gate passed the entire suite. Enrolling a
 * LinkedIn-only list adds it to autoEnrollListIds, so that gate meant every lead
 * arriving afterwards was silently dropped — the capability worked once.
 */
describe('crm auto-enroll is channel-aware', () => {
  it('enrols a LinkedIn-only lead that the old email gate dropped', async () => {
    await autoEnrollLeadInSequences('user-1', 'list-1', 'lead-1',
      { email: '', linkedin: 'https://linkedin.com/in/ada' });

    expect(mockSeqDb.bulkEnroll).toHaveBeenCalledWith([
      expect.objectContaining({ leadEmail: 'https://www.linkedin.com/in/ada/' }),
    ]);
  });

  /*
   * Review round 3, finding 15. `identityCandidates:` at this call site was unpinned —
   * deleting it left every test in this file green.
   */
  it('passes identityCandidates through to bulkEnroll', async () => {
    await autoEnrollLeadInSequences('user-1', 'list-1', 'lead-1',
      { email: 'a@x..com', linkedin: 'https://linkedin.com/in/ada' });

    const input = (mockSeqDb.bulkEnroll as jest.Mock).mock.calls[0][0][0];
    expect(input.identityCandidates).toEqual(
      expect.arrayContaining(['https://www.linkedin.com/in/ada/', 'a@x..com']),
    );
  });

  it('refuses an email-only lead for a LinkedIn-only sequence', async () => {
    await autoEnrollLeadInSequences('user-1', 'list-1', 'lead-1',
      { email: 'ada@acme.io', linkedin: '' });

    expect(mockSeqDb.bulkEnroll).not.toHaveBeenCalled();
  });

  it('still accepts the legacy bare-string call shape', async () => {
    (mockSeqDb.getSequencesByAutoEnrollList as jest.Mock).mockResolvedValue([
      { sequenceId: 'seq-2', userId: 'user-1', steps: [{ subject: 'Hi', bodyHtml: 'y' }] } as any,
    ]);

    await autoEnrollLeadInSequences('user-1', 'list-1', 'lead-1', 'ada@acme.io');

    expect(mockSeqDb.bulkEnroll).toHaveBeenCalledWith([
      expect.objectContaining({ leadEmail: 'ada@acme.io' }),
    ]);
  });

  it('list import: filters by reachability and reads the COMPLETE list', async () => {
    (mockCrm.getAllLeadsByListId as jest.Mock) = jest.fn().mockResolvedValue([
      { leadId: 'li', linkedin: 'https://linkedin.com/in/ada' },
      { leadId: 'mail', email: 'ada@acme.io' },
      { leadId: 'junk', linkedin: 'Acme Corp' },
    ]);
    (mockCrm.getLeadsByListId as jest.Mock) = jest.fn();

    await autoEnrollListIntoSequences('user-1', 'list-1');

    // getLeadsByListId returns ONE ~1MB page, so a large import auto-enrolled only the
    // first page and silently skipped the rest.
    expect(mockCrm.getAllLeadsByListId).toHaveBeenCalledWith('list-1');
    expect(mockCrm.getLeadsByListId).not.toHaveBeenCalled();

    const inputs = (mockSeqDb.bulkEnroll as jest.Mock).mock.calls[0][0];
    expect(inputs.map((i: any) => i.leadId)).toEqual(['li']);
    expect(inputs[0].leadEmail).toBe('https://www.linkedin.com/in/ada/');
  });

  /*
   * Review round 3, finding 15. This is the highest-traffic of the four unpinned call
   * sites: autoEnrollListIntoSequences re-runs over the ENTIRE list on every import,
   * which is exactly the path a stale identity has to survive.
   */
  it('list import also passes identityCandidates through to bulkEnroll', async () => {
    (mockCrm.getAllLeadsByListId as jest.Mock) = jest.fn().mockResolvedValue([
      { leadId: 'both', email: 'a@x..com', linkedin: 'https://linkedin.com/in/ada' },
    ]);

    await autoEnrollListIntoSequences('user-1', 'list-1');

    const input = (mockSeqDb.bulkEnroll as jest.Mock).mock.calls[0][0][0];
    expect(input.identityCandidates).toEqual(
      expect.arrayContaining(['https://www.linkedin.com/in/ada/', 'a@x..com']),
    );
  });
});
