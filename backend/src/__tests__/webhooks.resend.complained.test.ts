import request from 'supertest';
import express from 'express';
import webhookRouter from '../routes/webhooks';
import { crmDb, userDb } from '../services/db';
import { emailEventsDb } from '../services/emailEventsDb';
import { leadListAlertService } from '../services/leadListAlertService';

jest.mock('../services/db', () => ({
  crmDb: {
    getLeadListsByUserId: jest.fn(),
    getLeadByEmail: jest.fn(),
    updateLead: jest.fn(),
  },
  userDb: {
    getUsersByEmailDomain: jest.fn(),
  },
  tempEmailDb: {
    save: jest.fn(),
  },
}));

jest.mock('../services/webhookService', () => ({
  webhookService: {
    initialize: jest.fn(),
    verifyWebhook: jest.fn(),
    extractEmailDomain: jest.fn().mockReturnValue('updates.example.com'),
    generateEventId: jest.fn().mockReturnValue('evt_complained_001'),
  },
}));

jest.mock('../services/emailEventsDb', () => ({
  emailEventsDb: {
    eventExists: jest.fn().mockResolvedValue(false),
    getEventById: jest.fn().mockResolvedValue(null),
    addEmailEvent: jest.fn().mockResolvedValue({ eventId: 'evt_complained_001' }),
    clearHardBounceFlagPending: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../services/leadListAlertService', () => ({
  leadListAlertService: {
    notifyForEmailEvent: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../services/emmaEmailService', () => ({
  emmaEmailService: {
    isEmmaRelatedEvent: jest.fn().mockReturnValue(false),
    isEmmaEmail: jest.fn().mockReturnValue(false),
  },
}));

jest.mock('../services/resendService', () => ({
  resendService: {
    getReceivedEmailContent: jest.fn(),
  },
}));

const app = express();
app.use(express.json());
app.use('/api/webhooks', webhookRouter);

const { webhookService } = require('../services/webhookService');

function makeComplainedEvent(overrides: Record<string, any> = {}) {
  return {
    type: 'email.complained',
    created_at: '2026-04-30T10:00:00Z',
    data: {
      email_id: 'email_abc123',
      from: 'sender@updates.example.com',
      to: ['lead@prospect.com'],
      subject: 'Check out our offer',
      complaint: {
        type: 'spam',
        reason: 'spam',
        timestamp: '2026-04-30T10:00:00Z',
      },
      ...overrides,
    },
  };
}

describe('POST /api/webhooks/resend — email.complained', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (emailEventsDb.eventExists as jest.Mock).mockResolvedValue(false);
    (emailEventsDb.getEventById as jest.Mock).mockResolvedValue(null);
    (emailEventsDb.addEmailEvent as jest.Mock).mockResolvedValue({ eventId: 'evt_complained_001' });
    (leadListAlertService.notifyForEmailEvent as jest.Mock).mockResolvedValue(undefined);
    (userDb.getUsersByEmailDomain as jest.Mock).mockResolvedValue([]);
  });

  it('returns 200 and stores the event', async () => {
    webhookService.verifyWebhook.mockReturnValue(makeComplainedEvent());

    const res = await request(app).post('/api/webhooks/resend').send({});

    expect(res.status).toBe(200);
    expect(emailEventsDb.addEmailEvent).toHaveBeenCalledTimes(1);
  });

  it('skips duplicate events', async () => {
    webhookService.verifyWebhook.mockReturnValue(makeComplainedEvent());
    (emailEventsDb.getEventById as jest.Mock).mockResolvedValue({ eventId: 'evt_complained_001', eventType: 'email.complained' });

    const res = await request(app).post('/api/webhooks/resend').send({});

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/duplicate/i);
    expect(emailEventsDb.addEmailEvent).not.toHaveBeenCalled();
  });

  it('auto-flags matching lead as do-not-contact with reason "complained"', async () => {
    webhookService.verifyWebhook.mockReturnValue(makeComplainedEvent());

    const mockUser = { userId: 'user_1' };
    const mockList = { listId: 'list_1' };
    const mockLead = { leadId: 'lead_1', contactStatus: 'active' };

    (userDb.getUsersByEmailDomain as jest.Mock).mockResolvedValue([mockUser]);
    (crmDb.getLeadListsByUserId as jest.Mock).mockResolvedValue([mockList]);
    (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue(mockLead);
    (crmDb.updateLead as jest.Mock).mockResolvedValue(undefined);

    const res = await request(app).post('/api/webhooks/resend').send({});
    expect(res.status).toBe(200);

    // Give the async fire-and-forget time to complete
    await new Promise(r => setTimeout(r, 50));

    expect(crmDb.updateLead).toHaveBeenCalledWith('list_1', 'lead_1', expect.objectContaining({
      contactStatus: 'do-not-contact',
      contactStatusReason: 'complained',
      contactStatusUpdatedBy: 'system',
      unsubscribedFromGroupEmail: true,
    }));
  });

  it('does not flag a lead already marked do-not-contact', async () => {
    webhookService.verifyWebhook.mockReturnValue(makeComplainedEvent());

    const mockUser = { userId: 'user_1' };
    const mockList = { listId: 'list_1' };
    const mockLead = { leadId: 'lead_1', contactStatus: 'do-not-contact' };

    (userDb.getUsersByEmailDomain as jest.Mock).mockResolvedValue([mockUser]);
    (crmDb.getLeadListsByUserId as jest.Mock).mockResolvedValue([mockList]);
    (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue(mockLead);

    const res = await request(app).post('/api/webhooks/resend').send({});
    expect(res.status).toBe(200);

    await new Promise(r => setTimeout(r, 50));

    expect(crmDb.updateLead).not.toHaveBeenCalled();
  });

  it('does not flag when no matching lead exists', async () => {
    webhookService.verifyWebhook.mockReturnValue(makeComplainedEvent());

    const mockUser = { userId: 'user_1' };
    const mockList = { listId: 'list_1' };

    (userDb.getUsersByEmailDomain as jest.Mock).mockResolvedValue([mockUser]);
    (crmDb.getLeadListsByUserId as jest.Mock).mockResolvedValue([mockList]);
    (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue(null);

    const res = await request(app).post('/api/webhooks/resend').send({});
    expect(res.status).toBe(200);

    await new Promise(r => setTimeout(r, 50));

    expect(crmDb.updateLead).not.toHaveBeenCalled();
  });

  it('includes the complaint reason in the contactStatusNote', async () => {
    webhookService.verifyWebhook.mockReturnValue(makeComplainedEvent({ complaint: { type: 'spam', reason: 'spam', timestamp: '2026-04-30T10:00:00Z' } }));

    const mockUser = { userId: 'user_1' };
    const mockList = { listId: 'list_1' };
    const mockLead = { leadId: 'lead_1', contactStatus: 'active' };

    (userDb.getUsersByEmailDomain as jest.Mock).mockResolvedValue([mockUser]);
    (crmDb.getLeadListsByUserId as jest.Mock).mockResolvedValue([mockList]);
    (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue(mockLead);
    (crmDb.updateLead as jest.Mock).mockResolvedValue(undefined);

    await request(app).post('/api/webhooks/resend').send({});
    await new Promise(r => setTimeout(r, 50));

    expect(crmDb.updateLead).toHaveBeenCalledWith('list_1', 'lead_1', expect.objectContaining({
      contactStatusNote: expect.stringContaining('spam'),
    }));
  });
});
