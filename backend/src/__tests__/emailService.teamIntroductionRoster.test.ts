import { emailService } from '../services/emailService';
import { resendService } from '../services/resendService';

jest.mock('../services/resendService', () => ({
  resendService: {
    sendEmail: jest.fn().mockResolvedValue(undefined),
  },
}));

const mockSendEmail = resendService.sendEmail as jest.Mock;

/**
 * ENG-832 / GROW-91 — the signup welcome email's founder roster.
 *
 * A real signup on 2026-08-01 received "A personal note from the AgentWeb founders"
 * still naming a departed founder in both the first-person roster and the signature.
 * It survived because sendTeamIntroductionEmail was only ever *mocked* in tests;
 * its rendered body was never asserted anywhere. These tests assert the body.
 */
describe('sendTeamIntroductionEmail — founder roster', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSendEmail.mockResolvedValue(undefined);
  });

  const render = async () => {
    await emailService.sendTeamIntroductionEmail('newsignup@example.com', 'Casey Rivera');
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    const { html, text, subject } = mockSendEmail.mock.calls[0][0];
    return { html: html as string, text: text as string, subject: subject as string };
  };

  it('renders the approved roster in the HTML body and signature', async () => {
    const { html } = await render();

    expect(html).toContain("We're Harsha, Fangfang, and Matthew");
    expect(html).toContain('— Harsha, Fangfang &amp; Matthew');
  });

  it('renders the approved roster in the plaintext body and signature', async () => {
    const { text } = await render();

    expect(text).toContain("We're Harsha, Fangfang, and Matthew");
    expect(text).toContain('— Harsha, Fangfang & Matthew');
  });

  it('never names a departed founder in either body', async () => {
    const { html, text } = await render();

    // Word-boundary match so an unrelated substring cannot mask a real regression.
    expect(html).not.toMatch(/\bRui\b/);
    expect(text).not.toMatch(/\bRui\b/);
  });

  it('leaves the rest of the email untouched', async () => {
    const { html, text, subject } = await render();

    expect(subject).toBe('A personal note from the AgentWeb founders');
    expect(html).toContain('Hi Casey, welcome to AgentWeb!');
    expect(html).toContain('Just reply to this email');
    expect(text).toContain('Need help or found an issue?');
  });
});
