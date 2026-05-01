import express from "express";
import { authenticateToken } from "../middleware/auth";
import { resendService } from "../services/resendService";
import { userDb } from "../services/db";
import { settingsService } from "../services/settingsService";
import { RESEND_SYSTEM_EMAIL, RESEND_SYSTEM_NAME } from "../config";

const router = express.Router();

// Apply authentication to all routes
router.use(authenticateToken);

// Send help message via email
router.post("/send-help-message", async (req, res) => {
  try {
    const authenticatedReq = req as any;

    // DEBUG: Log what we got from auth middleware
    console.log('=== SUPPORT REQUEST DEBUG ===');
    console.log('req.user:', JSON.stringify(authenticatedReq.user, null, 2));
    console.log('req.delegateInfo:', JSON.stringify(authenticatedReq.delegateInfo, null, 2));

    // This userId is always the actual user's ID (not admin's), even when accessed via delegation
    // The authenticateToken middleware handles delegation and sets req.user to the target user
    const userId = authenticatedReq.user.userId;
    const userEmail = authenticatedReq.user.email;
    const { message, pageUrl } = req.body;

    if (!message) {
      return res.status(400).json({ message: "Message is required" });
    }

    // Get user info - this will be the actual customer's info, not admin's
    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    console.log(`User from DB: ${user.email} (userId: ${userId})`);
    console.log(`User from token: ${userEmail}`);
    console.log(`Sending reply-to: ${user.email}`);

    if (authenticatedReq.delegateInfo?.isDelegated) {
      console.log(`⚠️  Accessed via admin delegation by: ${authenticatedReq.delegateInfo.adminEmail}`);
    }
    console.log('=== END DEBUG ===');

    // Send email to support team using Resend
    const emailSubject = `Help Request from ${user.email}`;

    // Build delegation info if present
    const delegationNote = authenticatedReq.delegateInfo?.isDelegated
      ? `<div style="background-color: #fff3cd; border-left: 4px solid: #ffc107; padding: 10px; margin-bottom: 15px;">
           <strong>⚠️ Note:</strong> This request was submitted via admin delegation by ${authenticatedReq.delegateInfo.adminEmail}
         </div>`
      : '';

    const emailHtml = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin-bottom: 20px; }
    .message-box { background-color: #fff; border-left: 4px solid #4F46E5; padding: 15px; margin: 20px 0; }
    .info-row { margin: 8px 0; }
    .label { font-weight: 600; color: #666; }
    .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #e5e7eb; font-size: 12px; color: #6b7280; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h2 style="margin: 0; color: #111;">Help Request</h2>
    </div>

    ${delegationNote}

    <div class="info-row">
      <span class="label">From:</span> ${user.displayName || user.email} (${user.email})
    </div>
    <div class="info-row">
      <span class="label">User ID:</span> ${userId}
    </div>
    <div class="info-row">
      <span class="label">Page URL:</span> ${pageUrl ? `<a href="${pageUrl}">${pageUrl}</a>` : 'Not provided'}
    </div>

    <div class="message-box">
      <div class="label" style="margin-bottom: 10px;">Message:</div>
      <div>${message.replace(/\n/g, '<br>')}</div>
    </div>

    <div class="footer">
      This is an automated message from AgentWeb Support System. Reply-To is set to the customer's email.
    </div>
  </div>
</body>
</html>
    `;

    const productIssueEmails = await settingsService.getJsonArraySetting('product_issue_emails', ['founders@agentweb.pro']);

    await resendService.sendEmail({
      from: `${RESEND_SYSTEM_NAME} Support <${RESEND_SYSTEM_EMAIL}>`,
      to: productIssueEmails,
      subject: emailSubject,
      html: emailHtml,
      replyTo: user.email
    });

    res.json({ success: true, message: "Help message sent successfully" });
  } catch (error) {
    console.error("Error sending help message:", error);
    res.status(500).json({ message: "Failed to send help message" });
  }
});

// Report a UI error to the support team
router.post("/report-error", async (req, res) => {
  try {
    const authenticatedReq = req as any;
    const userId = authenticatedReq.user.userId;
    const userEmail = authenticatedReq.user.email;
    const { errorMessage, errorCode, sessionId, pageUrl, additionalDetails } = req.body;

    if (!errorMessage || !errorMessage.trim()) {
      return res.status(400).json({ message: "Error message is required" });
    }

    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const emailSubject = `Error Report from ${user.email}`;

    const emailHtml = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background-color: #fef2f2; padding: 20px; border-radius: 8px; margin-bottom: 20px; border-left: 4px solid #ef4444; }
    .message-box { background-color: #fff; border-left: 4px solid #ef4444; padding: 15px; margin: 20px 0; }
    .info-row { margin: 8px 0; }
    .label { font-weight: 600; color: #666; }
    .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #e5e7eb; font-size: 12px; color: #6b7280; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h2 style="margin: 0; color: #b91c1c;">Error Report</h2>
    </div>

    <div class="info-row">
      <span class="label">From:</span> ${user.displayName || user.email} (${user.email})
    </div>
    <div class="info-row">
      <span class="label">User ID:</span> ${userId}
    </div>
    ${sessionId ? `<div class="info-row"><span class="label">Session ID:</span> ${sessionId}</div>` : ''}
    ${errorCode ? `<div class="info-row"><span class="label">Error Code:</span> ${errorCode}</div>` : ''}
    ${pageUrl ? `<div class="info-row"><span class="label">Page URL:</span> <a href="${pageUrl}">${pageUrl}</a></div>` : ''}

    <div class="message-box">
      <div class="label" style="margin-bottom: 10px;">Error Message:</div>
      <div>${errorMessage.replace(/\n/g, '<br>')}</div>
    </div>

    ${additionalDetails ? `
    <div class="message-box" style="border-color: #6b7280;">
      <div class="label" style="margin-bottom: 10px;">Additional Details:</div>
      <div>${additionalDetails.replace(/\n/g, '<br>')}</div>
    </div>` : ''}

    <div class="footer">
      This is an automated error report from AgentWeb. Reply-To is set to the customer's email.
    </div>
  </div>
</body>
</html>
    `;

    const oncallEmails = await settingsService.getJsonArraySetting('oncall_emails', ['ruiw@agentweb.pro']);

    await resendService.sendEmail({
      from: `${RESEND_SYSTEM_NAME} Support <${RESEND_SYSTEM_EMAIL}>`,
      to: oncallEmails,
      subject: emailSubject,
      html: emailHtml,
      replyTo: user.email
    });

    res.json({ success: true, message: "Error report sent successfully" });
  } catch (error) {
    console.error("Error sending error report:", error);
    res.status(500).json({ message: "Failed to send error report" });
  }
});

export default router;
