import express from 'express';
import { handleResult, getResultEndpointConfigs } from '../controllers/resultEndpointController';
import { rateLimit } from 'express-rate-limit';
import { chatbotDb, type ChatSession } from '../services/chatbotService';
import { resendService } from '../services/resendService';
import { RESEND_SYSTEM_EMAIL, RESEND_SYSTEM_NAME } from '../config';
import { getUserFromToken } from '../middleware/auth';
import {
  INLINE_HTML_ASSET,
  REVIEW_TOKEN_HEADER,
  buildResultDeliveryEmailHtml,
  isHttpUrl,
  isValidRecipientEmail,
  verifyReviewToken,
} from '../services/resultEndpointReview';

const router = express.Router();

// Public endpoints - no auth middleware

// GET config info (name + resultTitle) for the status page
router.get('/:resultName/info', async (req, res) => {
  try {
    const { resultName } = req.params;
    const configs = await getResultEndpointConfigs();
    const config = configs.find(c => c.name === resultName);
    if (!config) {
      return res.status(404).json({ error: `Result endpoint "${resultName}" not found` });
    }
    return res.json({
      success: true,
      name: config.name,
      resultTitle: config.resultTitle || config.name,
      waitingContent: config.waitingContent || null,
    });
  } catch (error) {
    console.error('Error fetching result endpoint info:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET status for polling from the waiting page.
// ENG-2669: the session id is the only credential here and it sits in the lead's page URL
// (and so in history, referrers and shared links). The route therefore answers only for a
// session that belongs to :resultName, returns the same 404 for "no such session" and
// "not this endpoint's session" (no existence oracle), and exposes just what the lead's
// own waiting page renders: completion + the report link. The lead's email, the generated
// HTML and the iShare chat link stay behind the reviewer token (`/review/*`).
router.get('/:resultName/status/:sessionId', async (req, res) => {
  try {
    const { resultName, sessionId } = req.params;

    // Verify the endpoint exists
    const configs = await getResultEndpointConfigs();
    const config = configs.find(c => c.name === resultName);
    if (!config) {
      return res.status(404).json({ error: `Result endpoint "${resultName}" not found` });
    }

    // Load session; it must be a session this very endpoint created
    const session = await chatbotDb.getChatSession(sessionId);
    const metadata = session?.resultEndpointMetadata;
    if (!session || metadata?.resultName !== resultName) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const isCompleted = !!(metadata.contentUrl || metadata.contentHtml);

    const response: Record<string, any> = {
      status: isCompleted ? 'completed' : 'pending',
      resultTitle: config.resultTitle || config.name,
      waitingContent: config.waitingContent || null,
    };

    if (isCompleted && metadata.contentUrl) {
      response.reportUrl = metadata.contentUrl;
    }

    return res.json(response);
  } catch (error) {
    console.error('Error fetching result endpoint status:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST triggers session creation and generation
router.post('/:resultName/trigger', handleResult);

export default router;

// ─── Review routes (mounted at /review in app.ts) ───

export const reviewRouter = express.Router();

/**
 * ENG-2650: every review route must be opened by the configured reviewer (the
 * per-session capability token from the `send_for_review` link, sent in the
 * X-Review-Token header) or by a real, non-delegated admin. The session id
 * alone is not a credential: it is also handed to the lead. Checked before any
 * session read, so an unauthorized caller cannot probe which sessions exist.
 */
export async function requireReviewAccess(req: express.Request, res: express.Response, next: express.NextFunction) {
  try {
    if (verifyReviewToken(req.params.sessionId, req.get(REVIEW_TOKEN_HEADER))) {
      return next();
    }
    if (req.headers.authorization) {
      const { user, decoded } = await getUserFromToken(req);
      // Same rule as isRealAdmin: a delegate token acts as the target account.
      if (user?.isAdmin && !decoded?.delegateAccess) {
        return next();
      }
    }
    return res.status(401).json({
      error: 'This review link is invalid. Open the link from the latest review email, or sign in as an admin.',
      code: 'review_access_denied',
    });
  } catch (error) {
    console.error('Error authorizing review access:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

type ResultEndpointMetadata = NonNullable<ChatSession['resultEndpointMetadata']>;

interface ReviewAsset {
  type: 'image' | 'video' | 'html' | 'file';
  url: string;
  filename?: string;
  toolName?: string;
  subject?: string;
  generatedAt?: string;
  sendHistory: Array<{ recipientEmail: string; customMessage?: string; sentAt: string }>;
}

/**
 * Collects every asset the session generated (tool results + the metadata
 * contentUrl fallback), with its send history attached. The review page lists
 * exactly these, and POST /send only accepts one of them (ENG-2650).
 */
async function collectReviewAssets(sessionId: string, metadata: ResultEndpointMetadata): Promise<ReviewAsset[]> {
  // Collect all assets by scanning session messages
  const messages = await chatbotDb.getMessagesFromMessagesTable(sessionId);
  const assets: ReviewAsset[] = [];
  const seenUrls = new Set<string>();

  const addAsset = (type: 'image' | 'video' | 'html' | 'file', url: string, opts?: { filename?: string; toolName?: string; generatedAt?: string }) => {
    if (!url || seenUrls.has(url)) return;
    seenUrls.add(url);
    assets.push({ type, url, filename: opts?.filename, toolName: opts?.toolName, generatedAt: opts?.generatedAt, sendHistory: [] });
  };

  // Tools that produce assets we want to collect
  const ASSET_TOOLS = new Set(['generate_image', 'generate_video', 'create_html_file', 'update_html_file', 'create_html_from_template']);
  // Tools to skip (not assets)
  const SKIP_TOOLS = new Set(['search_web', 'you_search_web', 'you_search_news', 'google_search_web', 'read_page_source', 'read_file_content', 'set_work_plan_status', 'send_for_review', 'install_skills']);

  for (const msg of messages) {
    // Scan tool-role messages: these contain the actual JSON results
    if (msg.role === 'tool' && msg.content && msg.name && !SKIP_TOOLS.has(msg.name)) {
      let result: any;
      try {
        result = typeof msg.content === 'string' ? JSON.parse(msg.content) : msg.content;
      } catch {
        continue;
      }
      if (!result || result.success === false) continue;

      const toolName = msg.name;
      const timestamp = msg.metadata?.timestamp || msg.timestamp;

      if (result.imageUrl) {
        addAsset('image', result.imageUrl, { filename: result.filename, toolName, generatedAt: timestamp });
      }
      if (result.videoUrl) {
        addAsset('video', result.videoUrl, { filename: result.filename, toolName, generatedAt: timestamp });
      }
      if (result.s3_url) {
        const isHtml = toolName === 'create_html_file' || toolName === 'update_html_file' || toolName === 'create_html_from_template' || result.s3_url.endsWith('.html');
        addAsset(isHtml ? 'html' : 'file', result.s3_url, { filename: result.filename, toolName, generatedAt: timestamp });
      }
    }

    // Also scan assistant metadata.toolCalls (populated on summary messages)
    if (msg.role === 'assistant' && msg.metadata?.toolCalls) {
      for (const tc of msg.metadata.toolCalls) {
        if (!tc.result || tc.result.success === false || SKIP_TOOLS.has(tc.name)) continue;
        const timestamp = msg.metadata?.timestamp || msg.timestamp;
        if (tc.result.imageUrl) addAsset('image', tc.result.imageUrl, { filename: tc.result.filename, toolName: tc.name, generatedAt: timestamp });
        if (tc.result.videoUrl) addAsset('video', tc.result.videoUrl, { filename: tc.result.filename, toolName: tc.name, generatedAt: timestamp });
        if (tc.result.s3_url) {
          const isHtml = tc.name === 'create_html_file' || tc.name === 'update_html_file' || tc.result.s3_url.endsWith('.html');
          addAsset(isHtml ? 'html' : 'file', tc.result.s3_url, { filename: tc.result.filename, toolName: tc.name, generatedAt: timestamp });
        }
      }
    }
  }

  // Fallback: if no assets found from messages but contentUrl exists in metadata, add it as an asset
  if (assets.length === 0 && metadata.contentUrl) {
    const isHtml = metadata.outputFormat === 'html' || metadata.contentUrl.endsWith('.html');
    addAsset(isHtml ? 'html' : 'file', metadata.contentUrl);
  }

  // Attach send history to matching assets
  const sendHistory = metadata.sendHistory || [];
  for (const entry of sendHistory) {
    const asset = assets.find(a => a.url === entry.assetUrl);
    if (asset) {
      asset.sendHistory.push({
        recipientEmail: entry.recipientEmail,
        customMessage: entry.customMessage,
        sentAt: entry.sentAt,
      });
    }
  }

  return assets;
}

// GET review data: collects ALL assets from session messages + metadata
reviewRouter.get('/:sessionId', requireReviewAccess, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = await chatbotDb.getChatSession(sessionId);
    if (!session?.resultEndpointMetadata) {
      return res.status(404).json({ error: 'Session not found or has no result metadata' });
    }
    const metadata = session.resultEndpointMetadata;

    const assets = await collectReviewAssets(sessionId, metadata);

    // Get ishare URL
    const ishareUrl = await chatbotDb.createOrReuseInteractiveShare(sessionId);

    return res.json({
      success: true,
      resultTitle: metadata.resultTitle || metadata.resultName,
      leadEmail: metadata.leadEmail || '',
      outputFormat: metadata.outputFormat,
      contentHtml: metadata.contentHtml,
      contentSubject: metadata.contentSubject,
      assets,
      ishareUrl,
    });
  } catch (error) {
    console.error('Error fetching review data:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ENG-2650: a reviewer sends a handful of emails per result; this bounds what a
// leaked review link can do with our sending domain. Keyed by session (after
// requireReviewAccess, so unauthorized callers cannot spend a session's budget);
// only successful sends count. In-memory, so the bound is per backend instance.
export const REVIEW_SEND_LIMIT = 10;
export const REVIEW_SEND_WINDOW_MS = 60 * 60 * 1000;
const MAX_CUSTOM_MESSAGE_LENGTH = 5000;

const reviewSendLimiter = rateLimit({
  windowMs: REVIEW_SEND_WINDOW_MS,
  limit: REVIEW_SEND_LIMIT,
  standardHeaders: true,
  legacyHeaders: false,
  skipFailedRequests: true,
  keyGenerator: req => `review-send:${req.params.sessionId}`,
  handler: (_req, res) => {
    res.status(429).json({ error: 'Too many emails have been sent for this result. Please try again later.' });
  },
});

// POST send a specific asset via email
reviewRouter.post('/:sessionId/send', requireReviewAccess, reviewSendLimiter, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { recipientEmail: rawRecipientEmail, customMessage: rawCustomMessage, assetUrl } = req.body ?? {};

    if (!rawRecipientEmail || typeof rawRecipientEmail !== 'string' || !rawRecipientEmail.trim()) {
      return res.status(400).json({ error: 'recipientEmail is required' });
    }
    const recipientEmail = rawRecipientEmail.trim();
    if (!isValidRecipientEmail(recipientEmail)) {
      return res.status(400).json({ error: 'recipientEmail must be a single valid email address' });
    }
    if (!assetUrl || typeof assetUrl !== 'string') {
      return res.status(400).json({ error: 'assetUrl is required' });
    }
    if (rawCustomMessage !== undefined && rawCustomMessage !== null && typeof rawCustomMessage !== 'string') {
      return res.status(400).json({ error: 'customMessage must be a string' });
    }
    const customMessage = typeof rawCustomMessage === 'string' ? rawCustomMessage.trim() : '';
    if (customMessage.length > MAX_CUSTOM_MESSAGE_LENGTH) {
      return res.status(400).json({ error: `customMessage must be at most ${MAX_CUSTOM_MESSAGE_LENGTH} characters` });
    }

    const session = await chatbotDb.getChatSession(sessionId);
    if (!session?.resultEndpointMetadata) {
      return res.status(404).json({ error: 'Session not found or has no result metadata' });
    }

    const metadata = session.resultEndpointMetadata;

    // ENG-2650: only this session's own generated assets can be sent — never a
    // caller-chosen URL.
    const isInlineHtml = assetUrl === INLINE_HTML_ASSET && !!metadata.contentHtml;
    if (!isInlineHtml) {
      const assets = await collectReviewAssets(sessionId, metadata);
      if (!assets.some(a => a.url === assetUrl) || !isHttpUrl(assetUrl)) {
        return res.status(400).json({ error: 'assetUrl is not one of this result\'s assets' });
      }
    }

    const resultLabel = metadata.resultTitle || metadata.resultName || 'your report';
    const subject = (metadata.contentSubject || `Your ${resultLabel} is ready`).replace(/[\r\n]+/g, ' ');

    // Determine reply-to address for display in the email body
    const replyToEmail = metadata.reviewerEmail || RESEND_SYSTEM_EMAIL;

    // Build formal email HTML matching AgentWeb welcome email style
    const emailHtml = buildResultDeliveryEmailHtml({
      resultLabel,
      replyTo: replyToEmail,
      ...(isInlineHtml ? { inlineHtml: metadata.contentHtml } : { assetUrl }),
      customMessage,
    });

    // Send via Resend, CC reviewer
    const fromAddress = `${RESEND_SYSTEM_NAME} <${RESEND_SYSTEM_EMAIL}>`;
    const ccEmail = metadata.reviewerEmail && metadata.reviewerEmail !== recipientEmail
      ? metadata.reviewerEmail
      : undefined;
    await resendService.sendEmail({
      from: fromAddress,
      to: recipientEmail,
      subject,
      html: emailHtml,
      cc: ccEmail,
      replyTo: replyToEmail,
    });

    // Record send history on session metadata
    const updatedSendHistory = [...(metadata.sendHistory || []), {
      assetUrl,
      recipientEmail,
      customMessage: customMessage || undefined,
      sentAt: new Date().toISOString(),
    }];
    await chatbotDb.updateSessionResultEndpointMetadata(sessionId, {
      ...metadata,
      sendHistory: updatedSendHistory,
    });

    return res.json({
      success: true,
      message: `Result sent to ${recipientEmail}`,
      sendHistoryEntry: {
        assetUrl,
        recipientEmail,
        customMessage: customMessage || undefined,
        sentAt: updatedSendHistory[updatedSendHistory.length - 1].sentAt,
      },
    });
  } catch (error) {
    console.error('Error sending result:', error);
    return res.status(500).json({ error: 'Failed to send result' });
  }
});
