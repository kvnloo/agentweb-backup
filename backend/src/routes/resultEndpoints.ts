import express from 'express';
import { handleResult, getResultEndpointConfigs } from '../controllers/resultEndpointController';
import { chatbotDb } from '../services/chatbotService';
import { resendService } from '../services/resendService';
import { RESEND_SYSTEM_EMAIL, RESEND_SYSTEM_NAME } from '../config';

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

// GET status for polling from the waiting page
router.get('/:resultName/status/:sessionId', async (req, res) => {
  try {
    const { resultName, sessionId } = req.params;

    // Verify the endpoint exists
    const configs = await getResultEndpointConfigs();
    const config = configs.find(c => c.name === resultName);
    if (!config) {
      return res.status(404).json({ error: `Result endpoint "${resultName}" not found` });
    }

    // Load session
    const session = await chatbotDb.getChatSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const metadata = session.resultEndpointMetadata;
    const isCompleted = !!(metadata?.contentUrl || metadata?.contentHtml);

    const response: Record<string, any> = {
      status: isCompleted ? 'completed' : 'pending',
      resultTitle: config.resultTitle || config.name,
      waitingContent: config.waitingContent || null,
    };

    if (isCompleted) {
      if (metadata?.contentUrl) {
        response.reportUrl = metadata.contentUrl;
      }
      response.contentHtml = metadata?.contentHtml || null;
      response.leadEmail = metadata?.leadEmail || null;
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

// GET review data: collects ALL assets from session messages + metadata
reviewRouter.get('/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = await chatbotDb.getChatSession(sessionId);
    if (!session?.resultEndpointMetadata) {
      return res.status(404).json({ error: 'Session not found or has no result metadata' });
    }
    const metadata = session.resultEndpointMetadata;

    // Collect all assets by scanning session messages
    const messages = await chatbotDb.getMessagesFromMessagesTable(sessionId);
    const assets: Array<{
      type: 'image' | 'video' | 'html' | 'file';
      url: string;
      filename?: string;
      toolName?: string;
      subject?: string;
      generatedAt?: string;
      sendHistory: Array<{ recipientEmail: string; customMessage?: string; sentAt: string }>;
    }> = [];
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

// POST send a specific asset via email
reviewRouter.post('/:sessionId/send', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { recipientEmail, customMessage, assetUrl } = req.body;

    if (!recipientEmail || typeof recipientEmail !== 'string' || !recipientEmail.trim()) {
      return res.status(400).json({ error: 'recipientEmail is required' });
    }
    if (!assetUrl || typeof assetUrl !== 'string') {
      return res.status(400).json({ error: 'assetUrl is required' });
    }

    const session = await chatbotDb.getChatSession(sessionId);
    if (!session?.resultEndpointMetadata) {
      return res.status(404).json({ error: 'Session not found or has no result metadata' });
    }

    const metadata = session.resultEndpointMetadata;
    const resultLabel = metadata.resultTitle || metadata.resultName || 'your report';
    const subject = metadata.contentSubject || `Your ${resultLabel} is ready`;

    // Build asset-specific content block
    let assetBlock = '';
    if (assetUrl === '__inline_html__' && metadata.contentHtml) {
      assetBlock = metadata.contentHtml;
    } else if (assetUrl.match(/\.(png|jpg|jpeg|gif|webp)$/i) || assetUrl.includes('image')) {
      assetBlock = `<p style="text-align: center;"><img src="${assetUrl}" alt="${resultLabel}" style="max-width: 100%; border-radius: 8px;" /></p>`;
    } else if (assetUrl.match(/\.(mp4|webm|mov)$/i) || assetUrl.includes('video')) {
      assetBlock = `
        <div style="text-align: center; margin: 20px 0;">
          <a href="${assetUrl}"
             style="background: linear-gradient(90deg, #643B7E 0%, #6F3DFD 100%); color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: bold;">
            Watch Video
          </a>
        </div>`;
    } else {
      assetBlock = `
        <div style="text-align: center; margin: 20px 0;">
          <a href="${assetUrl}"
             style="background: linear-gradient(90deg, #643B7E 0%, #6F3DFD 100%); color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: bold;">
            View Your Result
          </a>
        </div>`;
    }

    // Custom message block (if provided)
    const customMessageBlock = customMessage && customMessage.trim()
      ? `<div style="background: #fff; padding: 20px; border-radius: 6px; border-left: 4px solid #643B7E; margin: 20px 0;">
           <p style="margin: 0; color: #333; line-height: 1.6; white-space: pre-wrap;">${customMessage.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>
         </div>`
      : '';

    // Determine reply-to address for display in the email body
    const replyToEmail = metadata.reviewerEmail || RESEND_SYSTEM_EMAIL;

    // Build formal email HTML matching AgentWeb welcome email style
    const emailHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="text-align: center; margin-bottom: 30px;">
          <h1 style="color: #1B2549; margin: 0;">AgentWeb</h1>
          <p style="color: #666; margin: 5px 0;">${resultLabel}</p>
        </div>

        <div style="background: #f8f9fa; padding: 30px; border-radius: 8px; margin-bottom: 20px;">
          <h2 style="color: #1B2549; margin-top: 0;">Your ${resultLabel} is Ready!</h2>
          <p style="color: #333; line-height: 1.6;">
            We're excited to send you the requested ${resultLabel}. Our team has prepared this content specifically for you.
          </p>

          ${customMessageBlock}

          ${assetBlock}

          <p style="color: #333; line-height: 1.6; margin-top: 20px;">
            If you have any questions or would like to request changes, simply reply to this email or reach out to us at
            <a href="mailto:${replyToEmail}" style="color: #643B7E; text-decoration: none;">${replyToEmail}</a>
            and we'll be happy to assist.
          </p>
        </div>

        <div style="text-align: center; color: #666; font-size: 12px;">
          <p>Powered by <a href="https://agentweb.pro" style="color: #643B7E; text-decoration: none;">AgentWeb</a></p>
        </div>
      </div>`;

    // Send via Resend, CC reviewer
    const fromAddress = `${RESEND_SYSTEM_NAME} <${RESEND_SYSTEM_EMAIL}>`;
    const ccEmail = metadata.reviewerEmail && metadata.reviewerEmail !== recipientEmail.trim()
      ? metadata.reviewerEmail
      : undefined;
    await resendService.sendEmail({
      from: fromAddress,
      to: recipientEmail.trim(),
      subject,
      html: emailHtml,
      cc: ccEmail,
      replyTo: replyToEmail,
    });

    // Record send history on session metadata
    const updatedSendHistory = [...(metadata.sendHistory || []), {
      assetUrl,
      recipientEmail: recipientEmail.trim(),
      customMessage: customMessage?.trim() || undefined,
      sentAt: new Date().toISOString(),
    }];
    await chatbotDb.updateSessionResultEndpointMetadata(sessionId, {
      ...metadata,
      sendHistory: updatedSendHistory,
    });

    return res.json({
      success: true,
      message: `Result sent to ${recipientEmail.trim()}`,
      sendHistoryEntry: {
        assetUrl,
        recipientEmail: recipientEmail.trim(),
        customMessage: customMessage?.trim() || undefined,
        sentAt: updatedSendHistory[updatedSendHistory.length - 1].sentAt,
      },
    });
  } catch (error) {
    console.error('Error sending result:', error);
    return res.status(500).json({ error: 'Failed to send result' });
  }
});
