import { leadListAlertService } from '../services/leadListAlertService';
import { userDb } from '../services/db';
import { emailService } from '../services/emailService';

// Mock dependencies
jest.mock('../services/db', () => ({
  crmDb: {
    getLeadListsByUserId: jest.fn(),
    getLeadByEmail: jest.fn(),
  },
  userDb: {
    getUserById: jest.fn(),
    getUsersByEmailDomain: jest.fn(),
  },
}));

jest.mock('../services/emailService', () => ({
  emailService: {
    sendEmail: jest.fn(),
    escapeHtml: jest.fn((str) => str),
  },
}));

describe('Lead List Alert Service - API Events', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const mockUser = {
    userId: 'user_123',
    email: 'owner@example.com',
    emailDomain: 'example.com',
  };

  const mockList = {
    listId: 'list_123',
    name: 'Test Lead List',
    userId: 'user_123',
    alertEvents: ['api.lead_added', 'api.lead_updated', 'api.lead_failed'],
  };

  const mockLead = {
    leadId: 'lead_123',
    email: 'john@example.com',
    firstName: 'John',
    lastName: 'Doe',
    company: 'Acme Corp',
    phone: '+1234567890',
  };

  describe('notifyLeadListOwnerIfConfigured - api.lead_added', () => {
    it('should send alert email when api.lead_added event is configured', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);

      await leadListAlertService.notifyLeadListOwnerIfConfigured(
        mockList,
        mockLead,
        'api.lead_added',
        {
          source: 'website_contact_form',
          forwardedAt: '2026-01-18T10:30:45.123Z',
          company: 'Acme Corp',
          phone: '+1234567890',
          autoDraftStatus: 'created',
        },
        '2026-01-18T10:30:45.123Z'
      );

      expect(emailService.sendEmail).toHaveBeenCalledWith(
        'owner@example.com',
        'Lead list alert: api.lead_added',
        expect.stringContaining('api.lead_added'),
        expect.stringContaining('api.lead_added')
      );

      // Verify email contains source and timestamp
      const emailCall = (emailService.sendEmail as jest.Mock).mock.calls[0];
      const textContent = emailCall[2];
      const htmlContent = emailCall[3];

      expect(textContent).toContain('website_contact_form');
      expect(htmlContent).toContain('website_contact_form');
      expect(htmlContent).toContain('Forwarded At');
      expect(textContent).toContain('Auto Draft: Created');
      expect(htmlContent).toContain('Auto Draft');
      expect(htmlContent).toContain('openEngagement=1');
    });

    it('should not send alert when api.lead_added is not configured', async () => {
      const listWithoutAlert = {
        ...mockList,
        alertEvents: ['email.received'], // different event
      };

      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);

      await leadListAlertService.notifyLeadListOwnerIfConfigured(
        listWithoutAlert,
        mockLead,
        'api.lead_added',
        {
          source: 'website_contact_form',
          forwardedAt: '2026-01-18T10:30:45.123Z',
        },
        '2026-01-18T10:30:45.123Z'
      );

      expect(emailService.sendEmail).not.toHaveBeenCalled();
    });

    it('should handle missing user gracefully', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue(null);

      await leadListAlertService.notifyLeadListOwnerIfConfigured(
        mockList,
        mockLead,
        'api.lead_added',
        {
          source: 'website_contact_form',
          forwardedAt: '2026-01-18T10:30:45.123Z',
        },
        '2026-01-18T10:30:45.123Z'
      );

      expect(emailService.sendEmail).not.toHaveBeenCalled();
    });

    it('should include lead details in alert email', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);

      await leadListAlertService.notifyLeadListOwnerIfConfigured(
        mockList,
        mockLead,
        'api.lead_added',
        {
          source: 'website_contact_form',
          forwardedAt: '2026-01-18T10:30:45.123Z',
          company: 'Acme Corp',
          phone: '+1234567890',
        },
        '2026-01-18T10:30:45.123Z'
      );

      const emailCall = (emailService.sendEmail as jest.Mock).mock.calls[0];
      const textContent = emailCall[2];
      const htmlContent = emailCall[3];

      // Verify lead information is included
      expect(textContent).toContain('John Doe');
      expect(textContent).toContain('john@example.com');
      expect(htmlContent).toContain('John Doe');
      expect(htmlContent).toContain('john@example.com');

      // Verify event details
      expect(textContent).toContain('Acme Corp');
      expect(textContent).toContain('+1234567890');
      expect(htmlContent).toContain('Acme Corp');
      expect(htmlContent).toContain('+1234567890');
    });
  });

  describe('notifyLeadListOwnerIfConfigured - api.lead_updated', () => {
    it('should send alert email when api.lead_updated event is configured', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);

      await leadListAlertService.notifyLeadListOwnerIfConfigured(
        mockList,
        mockLead,
        'api.lead_updated',
        {
          source: 'website_contact_form',
          forwardedAt: '2026-01-18T10:30:45.123Z',
          company: 'Acme Corp',
          phone: '+1234567890',
        },
        '2026-01-18T10:30:45.123Z'
      );

      expect(emailService.sendEmail).toHaveBeenCalledWith(
        'owner@example.com',
        'Lead list alert: api.lead_updated',
        expect.stringContaining('api.lead_updated'),
        expect.stringContaining('api.lead_updated')
      );

      const emailCall = (emailService.sendEmail as jest.Mock).mock.calls[0];
      const textContent = emailCall[2];
      const htmlContent = emailCall[3];

      expect(textContent).toContain('website_contact_form');
      expect(htmlContent).toContain('website_contact_form');
      expect(htmlContent).toContain('Updated At');
      expect(textContent).toContain('Acme Corp');
      expect(htmlContent).toContain('Acme Corp');
    });

    it('should not send alert when api.lead_updated is not configured', async () => {
      const listWithoutAlert = {
        ...mockList,
        alertEvents: ['email.received'],
      };

      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);

      await leadListAlertService.notifyLeadListOwnerIfConfigured(
        listWithoutAlert,
        mockLead,
        'api.lead_updated',
        {
          source: 'website_contact_form',
          forwardedAt: '2026-01-18T10:30:45.123Z',
        },
        '2026-01-18T10:30:45.123Z'
      );

      expect(emailService.sendEmail).not.toHaveBeenCalled();
    });
  });

  describe('notifyLeadListOwnerIfConfigured - api.lead_failed', () => {
    it('should send alert email when api.lead_failed event is configured', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);

      const failedLead = {
        leadId: 'failed',
        email: 'john@example.com',
        firstName: 'John',
        lastName: 'Doe',
      };

      await leadListAlertService.notifyLeadListOwnerIfConfigured(
        mockList,
        failedLead,
        'api.lead_failed',
        {
          error: 'Duplicate email address',
          source: 'website_contact_form',
          email: 'john@example.com',
        },
        '2026-01-18T10:30:45.123Z'
      );

      expect(emailService.sendEmail).toHaveBeenCalledWith(
        'owner@example.com',
        'Lead list alert: api.lead_failed',
        expect.stringContaining('api.lead_failed'),
        expect.stringContaining('api.lead_failed')
      );

      // Verify email contains error details
      const emailCall = (emailService.sendEmail as jest.Mock).mock.calls[0];
      const textContent = emailCall[2];
      const htmlContent = emailCall[3];

      expect(textContent).toContain('Duplicate email address');
      expect(textContent).toContain('website_contact_form');
      expect(htmlContent).toContain('Duplicate email address');
      expect(htmlContent).toContain('website_contact_form');
    });

    it('should not send alert when api.lead_failed is not configured', async () => {
      const listWithoutAlert = {
        ...mockList,
        alertEvents: ['email.received'], // different event
      };

      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);

      await leadListAlertService.notifyLeadListOwnerIfConfigured(
        listWithoutAlert,
        mockLead,
        'api.lead_failed',
        {
          error: 'Some error',
          source: 'api',
          email: 'john@example.com',
        },
        '2026-01-18T10:30:45.123Z'
      );

      expect(emailService.sendEmail).not.toHaveBeenCalled();
    });

    it('should handle event type case-insensitively', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);

      await leadListAlertService.notifyLeadListOwnerIfConfigured(
        mockList,
        mockLead,
        'API.LEAD_ADDED', // uppercase
        {
          source: 'website_contact_form',
          forwardedAt: '2026-01-18T10:30:45.123Z',
        },
        '2026-01-18T10:30:45.123Z'
      );

      expect(emailService.sendEmail).toHaveBeenCalled();
    });
  });

  describe('Auto Send status in alerts', () => {
    it('should show success message when auto send succeeds', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);

      await leadListAlertService.notifyLeadListOwnerIfConfigured(
        mockList,
        mockLead,
        'api.lead_added',
        {
          source: 'api',
          forwardedAt: '2026-02-17T10:00:00.000Z',
          autoDraftStatus: 'created',
          autoSendStatus: 'sent',
        },
        '2026-02-17T10:00:00.000Z'
      );

      const emailCall = (emailService.sendEmail as jest.Mock).mock.calls[0];
      const textContent = emailCall[2];
      const htmlContent = emailCall[3];

      expect(textContent).toContain('Auto Send: Email sent to the lead successfully');
      expect(htmlContent).toContain('Email sent to the lead successfully');
      expect(htmlContent).toContain('#15803d'); // green color
    });

    it('should show skipped message when already sent today', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);

      await leadListAlertService.notifyLeadListOwnerIfConfigured(
        mockList,
        mockLead,
        'api.lead_added',
        {
          source: 'api',
          forwardedAt: '2026-02-17T10:00:00.000Z',
          autoDraftStatus: 'created',
          autoSendStatus: 'skipped_already_sent_today',
        },
        '2026-02-17T10:00:00.000Z'
      );

      const emailCall = (emailService.sendEmail as jest.Mock).mock.calls[0];
      const textContent = emailCall[2];

      expect(textContent).toContain('already sent to this lead today');
    });

    it('should show warning when no sender configured', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);

      await leadListAlertService.notifyLeadListOwnerIfConfigured(
        mockList,
        mockLead,
        'api.lead_added',
        {
          source: 'api',
          forwardedAt: '2026-02-17T10:00:00.000Z',
          autoDraftStatus: 'created',
          autoSendStatus: 'skipped_no_sender',
        },
        '2026-02-17T10:00:00.000Z'
      );

      const emailCall = (emailService.sendEmail as jest.Mock).mock.calls[0];
      const textContent = emailCall[2];

      expect(textContent).toContain('no sender email configured');
    });

    it('should show warning when auto send is not enabled (draft only)', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);

      await leadListAlertService.notifyLeadListOwnerIfConfigured(
        mockList,
        mockLead,
        'api.lead_added',
        {
          source: 'api',
          forwardedAt: '2026-02-17T10:00:00.000Z',
          autoDraftStatus: 'created',
          // no autoSendStatus = auto send not enabled
        },
        '2026-02-17T10:00:00.000Z'
      );

      const emailCall = (emailService.sendEmail as jest.Mock).mock.calls[0];
      const textContent = emailCall[2];
      const htmlContent = emailCall[3];

      expect(textContent).toContain('An email has not been sent to the lead');
      expect(htmlContent).toContain('#b45309'); // warning color
    });

    it('should show failure message when auto send fails', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);

      await leadListAlertService.notifyLeadListOwnerIfConfigured(
        mockList,
        mockLead,
        'api.lead_added',
        {
          source: 'api',
          forwardedAt: '2026-02-17T10:00:00.000Z',
          autoDraftStatus: 'created',
          autoSendStatus: 'failed',
        },
        '2026-02-17T10:00:00.000Z'
      );

      const emailCall = (emailService.sendEmail as jest.Mock).mock.calls[0];
      const textContent = emailCall[2];
      const htmlContent = emailCall[3];

      expect(textContent).toContain('Auto send failed');
      expect(htmlContent).toContain('#dc2626'); // red color
    });
  });

  describe('Event details formatting', () => {
    it('should format api.lead_added event details correctly', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);

      await leadListAlertService.notifyLeadListOwnerIfConfigured(
        mockList,
        mockLead,
        'api.lead_added',
        {
          source: 'linkedin_outreach',
          forwardedAt: '2026-01-18T10:30:45.123Z',
          company: 'Tech Corp',
          phone: '+1987654321',
        },
        '2026-01-18T10:30:45.123Z'
      );

      const emailCall = (emailService.sendEmail as jest.Mock).mock.calls[0];
      const htmlContent = emailCall[3];

      // Verify structured formatting
      expect(htmlContent).toContain('<strong>Source:</strong>');
      expect(htmlContent).toContain('linkedin_outreach');
      expect(htmlContent).toContain('<strong>Forwarded At:</strong>');
      expect(htmlContent).toContain('<strong>Company:</strong>');
      expect(htmlContent).toContain('Tech Corp');
      expect(htmlContent).toContain('<strong>Phone:</strong>');
      expect(htmlContent).toContain('+1987654321');
    });

    it('should format api.lead_updated event details correctly', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);

      await leadListAlertService.notifyLeadListOwnerIfConfigured(
        mockList,
        mockLead,
        'api.lead_updated',
        {
          source: 'linkedin_outreach',
          forwardedAt: '2026-01-18T10:30:45.123Z',
          company: 'Updated Corp',
          phone: '+1555555555',
        },
        '2026-01-18T10:30:45.123Z'
      );

      const emailCall = (emailService.sendEmail as jest.Mock).mock.calls[0];
      const htmlContent = emailCall[3];

      expect(htmlContent).toContain('<strong>Source:</strong>');
      expect(htmlContent).toContain('linkedin_outreach');
      expect(htmlContent).toContain('<strong>Updated At:</strong>');
      expect(htmlContent).toContain('<strong>Company:</strong>');
      expect(htmlContent).toContain('Updated Corp');
      expect(htmlContent).toContain('<strong>Phone:</strong>');
      expect(htmlContent).toContain('+1555555555');
    });

    it('should format api.lead_failed event details correctly', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);

      const failedLead = {
        leadId: 'failed',
        email: 'test@example.com',
        firstName: '',
        lastName: '',
      };

      await leadListAlertService.notifyLeadListOwnerIfConfigured(
        mockList,
        failedLead,
        'api.lead_failed',
        {
          error: 'Invalid email format',
          source: 'api',
          email: 'test@example.com',
        },
        '2026-01-18T10:30:45.123Z'
      );

      const emailCall = (emailService.sendEmail as jest.Mock).mock.calls[0];
      const htmlContent = emailCall[3];

      // Verify error details are formatted
      expect(htmlContent).toContain('<strong>Error:</strong>');
      expect(htmlContent).toContain('Invalid email format');
      expect(htmlContent).toContain('<strong>Source:</strong>');
      expect(htmlContent).toContain('api');
      expect(htmlContent).toContain('<strong>Email:</strong>');
      expect(htmlContent).toContain('test@example.com');
    });
  });
});
