/**
 * Tests for `emailService.sendEmailStrict` — the non-silent variant used by
 * audited senders (e.g. the lifecycle drip executor).
 *
 * The regular `sendEmail` swallows transporter errors by design; `strict`
 * does not. These tests lock that contract so the drip audit log cannot
 * lie about a delivery that never happened.
 */

// Control the mocked nodemailer transporter from the tests so we can flip
// between success and failure cases.
const sendMailMock = jest.fn();

jest.mock("nodemailer", () => ({
  createTransport: jest.fn(() => ({
    sendMail: sendMailMock,
    verify: jest.fn().mockResolvedValue(true),
  })),
}));

process.env.SMTP_USER = "test-user";
process.env.SMTP_PASS = "test-pass";
process.env.FROM_EMAIL = "drip@example.com";

import { emailService } from "../services/emailService";

describe("emailService.sendEmailStrict", () => {
  beforeEach(() => {
    sendMailMock.mockReset();
  });

  it("returns the real messageId on a successful send", async () => {
    sendMailMock.mockResolvedValueOnce({ messageId: "smtp-abc-123" });

    const result = await emailService.sendEmailStrict(
      "alice@example.com",
      "Hello",
      "plain text",
      "<p>html</p>",
    );

    expect(result).toEqual({ messageId: "smtp-abc-123" });
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    const opts = sendMailMock.mock.calls[0][0];
    expect(opts.to).toBe("alice@example.com");
    expect(opts.subject).toBe("Hello");
    expect(opts.from).toBe("drip@example.com");
    expect(opts.replyTo).toBe("support@agentweb.pro");
  });

  it("throws when the transporter throws (does NOT swallow like sendEmail)", async () => {
    sendMailMock.mockRejectedValueOnce(new Error("SMTP: connection refused"));

    await expect(
      emailService.sendEmailStrict(
        "alice@example.com",
        "Hello",
        "text",
        "<p>html</p>",
      ),
    ).rejects.toThrow("SMTP: connection refused");
  });

  it("throws when the transporter resolves without a messageId", async () => {
    // Defensive — some transports can resolve with undefined/empty info.
    // The audit row cannot honestly claim status='sent' without a real
    // handle, so we refuse to proceed.
    sendMailMock.mockResolvedValueOnce({} as any);

    await expect(
      emailService.sendEmailStrict(
        "alice@example.com",
        "Hello",
        "text",
        "<p>html</p>",
      ),
    ).rejects.toThrow(/no messageId/);
  });

  it("throws when the transporter resolves with a non-string messageId", async () => {
    sendMailMock.mockResolvedValueOnce({ messageId: null } as any);

    await expect(
      emailService.sendEmailStrict(
        "alice@example.com",
        "Hello",
        "text",
        "<p>html</p>",
      ),
    ).rejects.toThrow(/no messageId/);
  });
});
