/**
 * ENG-2650: send_for_review issues the reviewer link with the per-session
 * capability token, and every untrusted value it interpolates into the emails
 * (trigger args are public input; subject/content_url come from the model) is
 * escaped.
 */
jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getChatSession: jest.fn(),
    getMessagesFromMessagesTable: jest.fn(),
    updateSessionResultEndpointMetadata: jest.fn(),
  },
}));

jest.mock('../services/emailService', () => ({
  emailService: { sendEmail: jest.fn().mockResolvedValue(true) },
}));

jest.mock('../services/resendService', () => ({
  resendService: { sendEmail: jest.fn().mockResolvedValue({ id: 'resend-1' }) },
}));

jest.mock('../config', () => ({
  RESEND_SYSTEM_EMAIL: 'no-reply@updates.agentweb.pro',
  RESEND_SYSTEM_NAME: 'AgentWeb',
}));

import { chatbotDb } from '../services/chatbotService';
import { emailService } from '../services/emailService';
import { resendService } from '../services/resendService';
import { sendForReview } from '../emma/impl/workPlans';
import { verifyReviewToken } from '../services/resultEndpointReview';

const mockedDb = chatbotDb as jest.Mocked<typeof chatbotDb>;
const mockedEmail = emailService.sendEmail as jest.Mock;
const mockedResend = resendService.sendEmail as jest.Mock;

const XSS = '"><script>alert(1)</script>';

function useSession(overrides: Record<string, unknown> = {}) {
  mockedDb.getChatSession.mockResolvedValue({
    sessionId: 'sess-r1',
    resultEndpointMetadata: {
      resultName: 'gtm',
      resultTitle: `Plan ${XSS}`,
      leadEmail: `lead@example.com${XSS}`,
      reviewerEmail: 'reviewer@example.com',
      outputFormat: 'html',
      args: { [`Company ${XSS}`]: `Acme ${XSS}` },
      ...overrides,
    },
  } as any);
  (mockedDb as any).getMessagesFromMessagesTable.mockResolvedValue([]);
  mockedDb.updateSessionResultEndpointMetadata.mockResolvedValue({} as any);
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.CUSTOMER_FRONTEND_URL = 'https://app.example.com';
});

describe('send_for_review reviewer email', () => {
  it('links to the review page with a valid reviewer token in the fragment', async () => {
    useSession();
    const result = await sendForReview('Subject', 'sess-r1', 'anon_1', 'https://s3.example.com/r.html');
    expect(result.success).toBe(true);

    const html: string = mockedEmail.mock.calls[0][3];
    const match = html.match(/href="https:\/\/app\.example\.com\/review\/sess-r1#token=([A-Za-z0-9_-]+)"/);
    expect(match).not.toBeNull();
    expect(verifyReviewToken('sess-r1', match![1])).toBe(true);
  });

  it('escapes trigger args, lead email, title, subject and content URL', async () => {
    useSession();
    await sendForReview(`Subject ${XSS}`, 'sess-r1', 'anon_1', `https://s3.example.com/r.html${XSS}`);
    const html: string = mockedEmail.mock.calls[0][3];
    expect(html).not.toContain('<script>');
    expect(html).toContain('Company &quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('Acme &quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('lead@example.com&quot;&gt;&lt;script&gt;');
    expect(html).toContain('Review: Subject &quot;&gt;&lt;script&gt;');
    expect(html).toContain('href="https://s3.example.com/r.html&quot;&gt;&lt;script&gt;');
  });
});

describe('send_for_review skipReview auto-send', () => {
  it('escapes the result title and asset URL in the lead email', async () => {
    useSession({ skipReview: true, leadEmail: 'lead@example.com' });
    await sendForReview('Subject', 'sess-r1', 'anon_1', `https://s3.example.com/image${XSS}`);
    const html: string = mockedResend.mock.calls[0][0].html;
    expect(html).not.toContain('<script>');
    expect(html).toContain('Plan &quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('src="https://s3.example.com/image&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"');
  });
});

describe('send_for_review header and recipient hardening', () => {
  it('strips CR/LF from the reviewer and lead subjects', async () => {
    useSession({ leadEmail: 'lead@example.com' });
    await sendForReview('Hi\r\nBcc: x@evil.com', 'sess-r1', 'anon_1');
    expect(mockedEmail.mock.calls[0][1]).toBe('Review: Hi Bcc: x@evil.com');

    mockedEmail.mockClear();
    useSession({ skipReview: true, leadEmail: 'lead@example.com', contentSubject: 'Yo\r\nBcc: x@evil.com' });
    await sendForReview('S', 'sess-r1', 'anon_1');
    expect(mockedResend.mock.calls[0][0].subject).toBe('Yo Bcc: x@evil.com');
  });

  it('never auto-sends to a malformed lead address; falls back to the review email', async () => {
    useSession({ skipReview: true, leadEmail: 'a@b.co, victim@x.com' });
    await sendForReview('S', 'sess-r1', 'anon_1');
    expect(mockedResend).not.toHaveBeenCalled();
    expect(mockedEmail).toHaveBeenCalledTimes(1);
  });
});
