import express from "express";
import { authenticateToken } from "../middleware/auth";
import { resendService } from "../services/resendService";
import { userDb } from "../services/db";
import { settingsService } from "../services/settingsService";
import { uploadScreenshotToS3, presignS3Url } from "../utils/s3Utils";
import { RESEND_SYSTEM_EMAIL, RESEND_SYSTEM_NAME } from "../config";
import { getUserFunnelStatusIssueTags, getUserFunnelStatusLabel } from "../utils/userFunnelStatus";

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

// Report types the in-app feedback button can submit. The pipeline (screenshot
// → S3 → sprint board item → product-team email) is identical across types;
// only the label, Notion tag, email subject, and accent color differ.
type ReportTypeConfig = {
  tag: string;          // Notion tag (in addition to "Customer Reported")
  titlePrefix: string;  // sprint item / email title prefix
  subjectLabel: string; // email subject bracket label
  headerLabel: string;  // email header heading
  accent: { border: string; bg: string; heading: string };
};

const REPORT_TYPES: Record<string, ReportTypeConfig> = {
  // Default. The button lives in the UI, so a bug is reported with a page
  // screenshot — hence the "UI Bug" title — but the tag is the broader "Bug".
  bug: {
    tag: "Bug",
    titlePrefix: "UI Bug",
    subjectLabel: "Bug",
    headerLabel: "Bug Report",
    accent: { border: "#ef4444", bg: "#fef2f2", heading: "#b91c1c" },
  },
  feature_request: {
    tag: "Feature Request",
    titlePrefix: "Feature Request",
    subjectLabel: "Feature Request",
    headerLabel: "Feature Request",
    accent: { border: "#6366f1", bg: "#eef2ff", heading: "#4338ca" },
  },
  improvement: {
    tag: "Improvement",
    titlePrefix: "Improvement",
    subjectLabel: "Improvement",
    headerLabel: "Improvement Suggestion",
    accent: { border: "#3b82f6", bg: "#eff6ff", heading: "#1d4ed8" },
  },
  feedback: {
    tag: "Feedback",
    titlePrefix: "Feedback",
    subjectLabel: "Feedback",
    headerLabel: "General Feedback",
    accent: { border: "#64748b", bg: "#f8fafc", heading: "#334155" },
  },
};

// Report a product issue from the in-app feedback button. Supports bugs,
// feature requests, improvement suggestions, and general feedback. The client
// auto-captures a screenshot; here we upload it, create a tracked item on the
// engineering sprint board, and notify the product team — the same pipeline
// used by Emma's report_product_issues tool.
router.post("/report-ui-bug", async (req, res) => {
  try {
    const authenticatedReq = req as any;
    const userId = authenticatedReq.user.userId;
    const { description, pageUrl, screenshot, reportType, sessionId } = req.body;

    if (!description || !description.trim()) {
      return res.status(400).json({ message: "Description is required" });
    }

    // Resolve the report type, defaulting to "bug" for backward compatibility
    // (older clients omit reportType).
    const typeKey = typeof reportType === "string" && REPORT_TYPES[reportType] ? reportType : "bug";
    const config = REPORT_TYPES[typeKey];

    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Upload the screenshot (if provided) to S3. Degrade gracefully — a failed
    // upload should never block the report itself.
    let screenshotUrl: string | null = null;
    if (typeof screenshot === "string" && screenshot.startsWith("data:image")) {
      const uploaded = await uploadScreenshotToS3(screenshot, userId);
      screenshotUrl = uploaded?.url ?? null;
    }
    const screenshotContext = screenshot
      ? (screenshotUrl || "Upload failed")
      : "Not provided";

    const isDelegated = authenticatedReq.delegateInfo?.isDelegated === true;
    const adminEmail: string | undefined = authenticatedReq.delegateInfo?.adminEmail;

    // ENG-289 Desired behavior #1: an INTERNAL submitter (admin, delegated-admin session, or an
    // @agentweb.pro reporter) gets the canonical Linear link back in the response; external customers
    // still only receive their Featurebase tracking link. The internal team email always gets it.
    const reporterIsInternal = user.isAdmin === true || isDelegated || /@agentweb\.pro$/i.test(user.email || "");

    const title = `${config.titlePrefix}: ${description.trim().slice(0, 80)}`;

    const issueContext: Record<string, any> = {
      "User Name": user.displayName || user.email,
      "User Email": user.email,
      "User ID": userId,
      "Page URL": pageUrl || "N/A",
      "Screenshot": screenshotContext,
    };
    const funnelStatusLabel = getUserFunnelStatusLabel(user.funnelStatus);
    const funnelStatusTags = getUserFunnelStatusIssueTags(user.funnelStatus);
    if (funnelStatusLabel) {
      issueContext["User Status"] = funnelStatusLabel;
    }
    if (isDelegated && adminEmail) {
      issueContext["Reported By (Admin)"] = adminEmail;
    }

    // File the user-reported issue. Behind FEATUREBASE_INTAKE this dedups and creates a
    // public, votable canonical in Linear (Featurebase-mirrored); flag off -> Notion. Same
    // shared path as Emma's report_product_issues tool.
    const reportItemType: 'feature_request' | 'bug' = typeKey === 'bug' ? 'bug' : 'feature_request';
    const { fileUserIssue } = await import('../services/intakeService');
    const filed = await fileUserIssue({
      type: reportItemType,
      title,
      description: description.trim(),
      userEmail: user.email,
      userName: user.displayName || user.email,
      reportedByAdmin: isDelegated && adminEmail ? adminEmail : undefined,
      sessionId: typeof sessionId === "string" ? sessionId : undefined,
      // Linear-side triage enrichment (ENG-187): stage labels + priority/state/assignee defaults.
      funnelStatus: user.funnelStatus,
      notionTags: ["Customer Reported", config.tag, ...funnelStatusTags],
      notionContext: issueContext,
    });
    const issueId = filed.pageId ? `AGW-${filed.pageId}` : undefined;

    // Presign the screenshot so the email can render an inline preview that the
    // recipient can actually load (the bucket is private).
    const previewUrl = screenshotUrl ? presignS3Url(screenshotUrl) : null;

    const delegationNote = isDelegated && adminEmail
      ? `<div style="background-color: #fff3cd; border-left: 4px solid #ffc107; padding: 10px; margin-bottom: 15px;">
           <strong>⚠️ Note:</strong> Submitted via admin delegation by ${adminEmail}
         </div>`
      : "";

    const emailHtml = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; line-height: 1.6; color: #333;">
  <div style="max-width: 640px; margin: 0 auto; padding: 20px;">
    <div style="background-color: ${config.accent.bg}; padding: 16px 20px; border-radius: 8px; margin-bottom: 20px; border-left: 4px solid ${config.accent.border};">
      <h2 style="margin: 0; color: ${config.accent.heading}; font-size: 18px;">${config.headerLabel}</h2>
    </div>

    ${delegationNote}

    <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
      <tr><td style="padding: 6px 0; color: #666; width: 140px; vertical-align: top;"><strong>Reported by</strong></td><td style="padding: 6px 0;"><a href="mailto:${user.email}" style="color: #4F46E5;">${user.displayName || user.email}</a> (${user.email})</td></tr>
      ${funnelStatusLabel ? `<tr><td style="padding: 6px 0; color: #666; vertical-align: top;"><strong>User status</strong></td><td style="padding: 6px 0;">${funnelStatusLabel}</td></tr>` : ""}
      ${issueId ? `<tr><td style="padding: 6px 0; color: #666; vertical-align: top;"><strong>Issue ID</strong></td><td style="padding: 6px 0; font-family: monospace;">${issueId}</td></tr>` : ""}
      ${filed.trackerUrl ? `<tr><td style="padding: 6px 0; color: #666; vertical-align: top;"><strong>${filed.tracker}</strong></td><td style="padding: 6px 0;"><a href="${filed.trackerUrl}" style="color: #4F46E5; font-weight: 600;">→ Open in ${filed.tracker}</a></td></tr>` : ""}
      ${filed.canonicalUrl ? `<tr><td style="padding: 6px 0; color: #666; vertical-align: top;"><strong>Linear canonical</strong></td><td style="padding: 6px 0;"><a href="${filed.canonicalUrl}" style="color: #4F46E5; font-weight: 600;">→ Open canonical in Linear</a></td></tr>` : ""}
      ${pageUrl ? `<tr><td style="padding: 6px 0; color: #666; vertical-align: top;"><strong>Page URL</strong></td><td style="padding: 6px 0;"><a href="${pageUrl}" style="color: #4F46E5;">${pageUrl}</a></td></tr>` : ""}
    </table>

    <div style="background-color: #fff; border-left: 4px solid ${config.accent.border}; padding: 15px; border-radius: 0 4px 4px 0;">
      <div style="font-weight: 600; margin-bottom: 8px; color: #333;">What the user reported</div>
      <div style="color: #444; line-height: 1.6;">${description.trim().replace(/\n/g, "<br>")}</div>
    </div>

    ${previewUrl ? `<div style="margin-top: 20px;"><div style="font-weight: 600; margin-bottom: 8px; color: #333;">Screenshot</div><a href="${previewUrl}"><img src="${previewUrl}" alt="Screenshot" style="max-width: 100%; border: 1px solid #e5e7eb; border-radius: 6px;"></a><div style="font-size: 12px; color: #9ca3af; margin-top: 4px;">This preview link expires in ~1 hour.</div></div>` : ""}

    <div style="margin-top: 20px; padding-top: 16px; border-top: 1px solid #e5e7eb; font-size: 12px; color: #9ca3af;">
      Reply to this email to respond directly to the customer.
    </div>
  </div>
</body>
</html>
    `;

    const productIssueEmails = await settingsService.getJsonArraySetting("product_issue_emails", ["founders@agentweb.pro"]);
    const recipients = isDelegated && adminEmail
      ? [...productIssueEmails, adminEmail]
      : productIssueEmails;

    await resendService.sendEmail({
      from: `${RESEND_SYSTEM_NAME} Support <${RESEND_SYSTEM_EMAIL}>`,
      to: recipients,
      subject: `[${config.subjectLabel}] ${title} — reported by ${user.email}`,
      html: emailHtml,
      replyTo: user.email,
    });

    res.json({
      success: true,
      // When deduped, tell the user it's a known request (and that they'll be notified) so the
      // client can show the right copy + a link to track it.
      message: filed.deduped
        ? "Thanks — this is already a known request. We've added your report and you'll be notified when it's resolved."
        : "Report submitted successfully",
      issueId,
      trackingUrl: filed.userUrl, // public link to the user's request on the feedback board
      // Internal reporters (teammates) also get the canonical Linear link (ENG-289 #1); external
      // customers do not — it stays an internal, eng-facing link routed to the team email only.
      canonicalUrl: reporterIsInternal ? filed.canonicalUrl : undefined,
      deduped: filed.deduped,
    });
  } catch (error) {
    console.error("Error submitting product report:", error);
    res.status(500).json({ message: "Failed to submit report" });
  }
});

export default router;
