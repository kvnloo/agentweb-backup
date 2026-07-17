/**
 * Tests for `emailService.sendEmailStrict` — the non-silent variant used by
 * audited senders (e.g. the lifecycle drip executor).
 *
 * The regular `sendEmail` swallows send errors by design; `strict` does not.
 * These tests lock that contract so the drip audit log cannot lie about a
 * delivery that never happened.
 *
 * ENG-164: the SMTP transporter is gone — both variants now route through
 * resendService, and the returned messageId is the Resend email id.
 */

const mockResendSendEmail = jest.fn();

jest.mock("../services/resendService", () => ({
  resendService: {
    sendEmail: (...args: any[]) => mockResendSendEmail(...args),
  },
}));

import { emailService } from "../services/emailService";
import { RESEND_SYSTEM_EMAIL, RESEND_SYSTEM_NAME } from "../config";

describe("emailService.sendEmailStrict", () => {
  beforeEach(() => {
    mockResendSendEmail.mockReset();
  });

  it("returns the real Resend id as messageId on a successful send", async () => {
    mockResendSendEmail.mockResolvedValueOnce({ id: "resend-abc-123" });

    const result = await emailService.sendEmailStrict(
      "alice@example.com",
      "Hello",
      "plain text",
      "<p>html</p>",
    );

    expect(result).toEqual({ messageId: "resend-abc-123" });
    expect(mockResendSendEmail).toHaveBeenCalledTimes(1);
    const opts = mockResendSendEmail.mock.calls[0][0];
    expect(opts.to).toBe("alice@example.com");
    expect(opts.subject).toBe("Hello");
    expect(opts.from).toBe(`${RESEND_SYSTEM_NAME} <${RESEND_SYSTEM_EMAIL}>`);
    expect(opts.replyTo).toBe("support@agentweb.pro");
  });

  it("throws when the Resend send fails (does NOT swallow like sendEmail)", async () => {
    mockResendSendEmail.mockRejectedValueOnce(new Error("Resend API error: boom"));

    await expect(
      emailService.sendEmailStrict(
        "alice@example.com",
        "Hello",
        "text",
        "<p>html</p>",
      ),
    ).rejects.toThrow("Resend API error: boom");
  });

  it("throws when Resend resolves without an id", async () => {
    // Defensive — the audit row cannot honestly claim status='sent' without
    // a real provider handle, so we refuse to proceed.
    mockResendSendEmail.mockResolvedValueOnce({} as any);

    await expect(
      emailService.sendEmailStrict(
        "alice@example.com",
        "Hello",
        "text",
        "<p>html</p>",
      ),
    ).rejects.toThrow(/no messageId/);
  });

  it("throws when Resend resolves with a non-string id", async () => {
    mockResendSendEmail.mockResolvedValueOnce({ id: 12345 } as any);

    await expect(
      emailService.sendEmailStrict(
        "alice@example.com",
        "Hello",
        "text",
        "<p>html</p>",
      ),
    ).rejects.toThrow(/no messageId/);
  });

  it("passes cc through to Resend", async () => {
    mockResendSendEmail.mockResolvedValueOnce({ id: "resend-cc-1" });

    await emailService.sendEmailStrict(
      ["a@example.com", "b@example.com"],
      "Subject",
      "text",
      "<p>html</p>",
      "cc@example.com",
    );

    const opts = mockResendSendEmail.mock.calls[0][0];
    expect(opts.to).toEqual(["a@example.com", "b@example.com"]);
    expect(opts.cc).toBe("cc@example.com");
  });

  it("regular sendEmail still swallows failures (best-effort contract preserved)", async () => {
    mockResendSendEmail.mockRejectedValueOnce(new Error("Resend API error: down"));

    await expect(
      emailService.sendEmail("bob@example.com", "Hi", "text", "<p>html</p>"),
    ).resolves.toBeUndefined();
    expect(mockResendSendEmail).toHaveBeenCalledTimes(1);
  });
});
