/**
 * Emma API Routes — REST endpoints for AI operations that were previously
 * only accessible through direct MCP tool calls. These routes go through
 * authenticateToken middleware so MCP tools can self-call them via HTTP.
 */

import { Router, Request, Response } from 'express';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { requireEmmaTokenBudget } from '../middleware/emmaTokenBudget';
import { chatbotDb } from '../services/chatbotService';
import { attachPublishRevalidation } from '../utils/scheduledPublishConsentGuard';

const router = Router();

// All routes require authentication
router.use(authenticateToken);

// ENG-973: every route that performs work is subject to the monthly token quota.
// Classification lives in EMMA_ROUTE_BUDGET; a route with no entry is treated as
// metered, and a contract test fails if a registered route is left unclassified.
router.use(requireEmmaTokenBudget);

// ─── Lazy service imports ───────────────────────────────────────────────────

async function getAgentModeService() {
  const { agentModeService } = await import('../services/agentModeService');
  return agentModeService;
}

// ─── Helper ─────────────────────────────────────────────────────────────────

function userId(req: Request): string {
  return (req as AuthenticatedRequest).user.userId;
}

// ─── Search & Research ──────────────────────────────────────────────────────

router.post('/you-search-web', async (req: Request, res: Response) => {
  try {
    const svc = await getAgentModeService();
    const result = await svc.youSearchWeb(req.body.query, req.body.max_results || 10);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

router.post('/you-search-news', async (req: Request, res: Response) => {
  try {
    const svc = await getAgentModeService();
    const result = await svc.youSearchNews(req.body.query, req.body.max_results || 10, req.body.freshness);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

router.post('/google-search-web', async (req: Request, res: Response) => {
  try {
    const svc = await getAgentModeService();
    const result = await svc.googleSearchWeb(req.body.query, req.body.max_results || 10);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

router.post('/deep-research', async (req: Request, res: Response) => {
  try {
    const svc = await getAgentModeService();
    const { topic, prompt, tone, depth, focus_areas } = req.body;
    const result = await svc.performDeepResearchTool(topic, prompt, tone, depth, focus_areas, userId(req));
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// ─── Knowledge Base ─────────────────────────────────────────────────────────

router.get('/knowledge-bases', async (req: Request, res: Response) => {
  try {
    const svc = await getAgentModeService();
    const options = {
      modified_after: req.query.modified_after as string | undefined,
      modified_before: req.query.modified_before as string | undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
      offset: req.query.offset ? parseInt(req.query.offset as string, 10) : undefined,
      kb_type: req.query.kb_type as string | undefined,
    };
    const result = await svc.listKnowledgeBaseFiles(userId(req), options);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

router.post('/search-knowledge-base', async (req: Request, res: Response) => {
  try {
    const svc = await getAgentModeService();
    const result = await svc.searchKnowledgeBase(req.body.query, req.body.max_results || 5, userId(req));
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

router.post('/search-ads-knowledge-base', async (req: Request, res: Response) => {
  try {
    const svc = await getAgentModeService();
    const result = await svc.searchForeplayAds(req.body.query, req.body.max_results || 5, userId(req));
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

router.post('/search-foreplay-discovery', async (req: Request, res: Response) => {
  try {
    const svc = await getAgentModeService();
    const { query, company_name, max_results, format, platform, niche, live, sort } = req.body;
    const result = await svc.searchForeplayDiscovery(query, { maxResults: max_results || 10, companyName: company_name, format, platform, niche, live, sort }, userId(req));
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

router.post('/read-knowledge-base-files', async (req: Request, res: Response) => {
  try {
    const svc = await getAgentModeService();
    const result = await svc.readKnowledgeBaseFiles(req.body.files, userId(req));
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

router.post('/create-knowledge-base', async (req: Request, res: Response) => {
  try {
    const svc = await getAgentModeService();
    const { name, content, knowledge_base_type, session_id } = req.body;
    const result = await svc.createKnowledgeBase(name, content, knowledge_base_type || 'private', userId(req), session_id || '');
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

router.post('/update-knowledge-base-file', async (req: Request, res: Response) => {
  try {
    const svc = await getAgentModeService();
    const { task_id, file_name, content, mode, session_id } = req.body;
    const result = await svc.updateKnowledgeBaseFile(task_id, file_name, content, mode || 'append', userId(req), session_id || '');
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

router.post('/attach-knowledge-base-files', async (req: Request, res: Response) => {
  try {
    const svc = await getAgentModeService();
    const { task_id, files, session_id } = req.body;
    const result = await svc.attachKnowledgeBaseFiles(task_id, files, userId(req), session_id || '');
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// ─── Media Generation & Description ─────────────────────────────────────────

router.post('/generate-image', async (req: Request, res: Response) => {
  try {
    const svc = await getAgentModeService();
    const { prompt, filename, size, quality, input_images, session_id, image_model, logo_image, category } = req.body;
    const result = await svc.generateImage(
      prompt, filename, size || '1024x1024', quality || 'medium',
      input_images || [], userId(req), session_id || '',
      image_model, logo_image, undefined, category
    );
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

router.post('/generate-video', async (req: Request, res: Response) => {
  try {
    const svc = await getAgentModeService();
    const { prompt, filename, session_id, video_model, start_frame, end_frame } = req.body;
    const result = await svc.generateVideo(prompt, filename, userId(req), session_id, video_model, start_frame, end_frame);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

router.post('/describe-media', async (req: Request, res: Response) => {
  try {
    const svc = await getAgentModeService();
    const { type, url, prompt, llm_model, return_transcript, return_scenes, start_time, end_time } = req.body;
    let result;
    if (type === 'video') {
      result = await svc.describeVideo(url, prompt, { return_transcript, return_scenes, start_time, end_time, userId: userId(req) });
    } else {
      result = await svc.describeImage(llm_model || 'gpt-4o', url, prompt);
    }
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

router.post('/remove-c2pa', async (req: Request, res: Response) => {
  try {
    const svc = await getAgentModeService();
    const result = await svc.removeC2PAFromImage(req.body.image_url, req.body.filename, userId(req));
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// ─── Email ──────────────────────────────────────────────────────────────────

router.post('/email', async (req: Request, res: Response) => {
  try {
    const { bootstrapEmailProviders, resolveEmailAccount } = await import('../services/emailProviderService');
    await bootstrapEmailProviders();
    const { provider } = await resolveEmailAccount(userId(req), req.body.account_id);

    const { action } = req.body;
    let result;
    switch (action) {
      case 'search': {
        const maxResults = Math.min(req.body.max_results || 10, 50);
        const emails = await provider.searchEmails(userId(req), req.body.account_id, req.body.query, maxResults);
        result = { emails, count: emails.length };
        break;
      }
      case 'list': {
        const maxResults = Math.min(req.body.max_results || 20, 50);
        const emails = await provider.listEmails(userId(req), req.body.account_id, req.body.folder || 'INBOX', maxResults);
        result = { emails, count: emails.length };
        break;
      }
      case 'get': {
        const ids: string[] = Array.isArray(req.body.message_ids) ? req.body.message_ids : [];
        const emails = await provider.getEmails(userId(req), req.body.account_id, ids);
        result = { emails, count: emails.length };
        break;
      }
      case 'send': {
        const sendResult = await provider.sendEmail(userId(req), req.body.account_id, {
          to: req.body.to,
          subject: req.body.subject,
          body: req.body.body,
          cc: req.body.cc,
          bcc: req.body.bcc,
          replyToMessageId: req.body.reply_to_message_id,
          isHtml: req.body.is_html,
        });
        result = { success: true, messageId: sendResult.messageId, threadId: sendResult.threadId };
        break;
      }
      default:
        return res.status(400).json({ message: `Unknown action "${action}"` });
    }
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// ─── Social Media ───────────────────────────────────────────────────────────

router.post('/social-posts', async (req: Request, res: Response) => {
  try {
    const svc = await getAgentModeService();
    const result = await svc.createSocialMediaPosts(req.body.posts, userId(req), req.body.session_id);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

router.post('/linkedin-outreach', async (req: Request, res: Response) => {
  try {
    const svc = await getAgentModeService();
    const result = await svc.linkedinOutreach(userId(req), req.body);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

/**
 * ENG-827: rebuild the scheduled run's publish re-check on the far side of a self-call.
 *
 * The hook is a closure, so it cannot cross an HTTP boundary — only the session id it
 * is keyed on can. `attachPublishRevalidation` remakes the identical hook here, which
 * means the adapters re-read live consent immediately before the write no matter which
 * side of the boundary the tool call started on.
 */
function buildScheduledPublishContext(req: Request): any {
  const sessionId = req.header('X-AgentWeb-Session');
  if (!sessionId) return undefined;
  return attachPublishRevalidation('post_on_connected_account', { sessionId });
}

router.post('/post-on-account', async (req: Request, res: Response) => {
  try {
    const svc = await getAgentModeService();
    // ENG-827 (Greptile, security): the caller checked consent before making this
    // self-call, but the irreversible work — media upload, Instagram's container,
    // YouTube's transfer — happens here, minutes later. Rebuild the run's re-check
    // hook from the session it forwarded so the adapters bind the write to consent
    // as it stands at the write. No session header means an ordinary interactive
    // call, which is not gated and gets no hook.
    const toolContext = buildScheduledPublishContext(req);
    const result = await svc.postOnConnectedAccount(
      userId(req), req.body.account_id, req.body.content, req.body.media_urls || [],
      undefined, toolContext
    );
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

router.get('/connected-account-posts', async (req: Request, res: Response) => {
  try {
    const svc = await getAgentModeService();
    const result = await svc.loadConnectedAccountPosts(userId(req), req.query.account_id as string, {
      limit: req.query.limit ? Number(req.query.limit) : undefined,
      include_metrics: req.query.include_metrics === 'true',
    });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

router.get('/connected-account-metrics', async (req: Request, res: Response) => {
  try {
    const svc = await getAgentModeService();
    const parseDate = (val: string | undefined): Date | undefined => {
      if (!val) return undefined;
      const d = new Date(val);
      if (isNaN(d.getTime())) throw new Error(`Invalid date: "${val}"`);
      return d;
    };
    const startDate = parseDate(req.query.start_date as string | undefined);
    const endDate = parseDate(req.query.end_date as string | undefined);
    const result = await svc.loadConnectedAccountMetrics(userId(req), req.query.account_id as string, startDate, endDate);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

router.post('/linkedin-comment', async (req: Request, res: Response) => {
  try {
    const svc = await getAgentModeService();
    const result = await svc.commentOnLinkedInPost(userId(req), req.body.account_id, req.body.post_urn, req.body.comment_text);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

router.post('/linkedin-react', async (req: Request, res: Response) => {
  try {
    const svc = await getAgentModeService();
    const result = await svc.reactToLinkedInPost(userId(req), req.body.account_id, req.body.post_urn, req.body.reaction_type || 'LIKE');
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// ─── Meta Ads ───────────────────────────────────────────────────────────────

router.get('/meta-ads/campaigns', async (req: Request, res: Response) => {
  try {
    const svc = await getAgentModeService();
    const result = await svc.listMetaAdsCampaigns(userId(req));
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

router.post('/meta-ads/marketing-api', async (req: Request, res: Response) => {
  try {
    const { entity_type, action, account_id, parent_id, entity_id, fields, params, session_id } = req.body;
    // Greptile P1/security ("Session does not bind authorization"): session_id
    // feeds the objective gate's confirmation check (a prior answer, or the
    // transcript for an explicit-statement quote) — an authenticated caller
    // supplying ANOTHER user's session_id must not be able to have that
    // session's confirmation applied to their own write.
    if (session_id) {
      const session = await chatbotDb.getChatSession(session_id);
      if (!session || session.userId !== userId(req)) {
        return res.status(403).json({ message: 'session_id does not belong to the authenticated user.' });
      }
    }
    const svc = await getAgentModeService();
    const result = await svc.callMetaMarketingApi(userId(req), entity_type, action, account_id, parent_id, entity_id, fields, params, session_id);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

router.post('/meta-ads/insights', async (req: Request, res: Response) => {
  try {
    const svc = await getAgentModeService();
    const result = await svc.callMetaAdsInsightsApiWrapper(userId(req), req.body);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

router.post('/meta-ads/metrics', async (req: Request, res: Response) => {
  try {
    const svc = await getAgentModeService();
    const result = await svc.getMetaAdsMetrics(
      req.body.timeframe || '7d',
      userId(req),
      req.body.campaign_ids,
      req.body.account_id,
    );
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

router.post('/post-analytics', async (req: Request, res: Response) => {
  try {
    const svc = await getAgentModeService();
    const result = await svc.getPostAnalytics(userId(req), req.body.account_id, req.body.post_ids);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// ─── Data Analysis ──────────────────────────────────────────────────────────

router.post('/data-analysis', async (req: Request, res: Response) => {
  try {
    const svc = await getAgentModeService();
    const result = await svc.performDataAnalysis(req.body.file_urls, req.body.analysis_instruction, userId(req));
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// ─── File Operations ────────────────────────────────────────────────────────

router.post('/read-file', async (req: Request, res: Response) => {
  try {
    const svc = await getAgentModeService();
    const result = await svc.readFileContent(req.body.file_url);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

router.post('/read-page', async (req: Request, res: Response) => {
  try {
    const svc = await getAgentModeService();
    if (req.body.extract_css) {
      const result = await svc.extractCSSFromURL(req.body, userId(req));
      return res.json(result);
    }
    const result = await svc.readFileContent(req.body.url);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

router.post('/save-file', async (req: Request, res: Response) => {
  try {
    const svc = await getAgentModeService();
    const result = await svc.saveFile(req.body.file_name, req.body.file_content, userId(req), req.body.session_id || '');
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// ─── HTML ───────────────────────────────────────────────────────────────────

router.post('/create-html', async (req: Request, res: Response) => {
  try {
    const svc = await getAgentModeService();
    const result = await svc.createHtmlFile(
      req.body.title, req.body.content_draft,
      req.body.format_requirements || '', userId(req), req.body.session_id || '',
      req.body.document_type === 'email' ? 'email' : 'document'
    );
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

router.get('/html-templates', async (req: Request, res: Response) => {
  try {
    const svc = await getAgentModeService();
    const result = await svc.listHtmlTemplates(userId(req));
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

router.post('/create-html-from-template', async (req: Request, res: Response) => {
  try {
    const svc = await getAgentModeService();
    const result = await svc.createHtmlFromTemplate(
      req.body.llm_model, req.body.template_id,
      req.body.variable_values, req.body.array_variable_values,
      userId(req), req.body.session_id || ''
    );
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

router.post('/create-html-template', async (req: Request, res: Response) => {
  try {
    const svc = await getAgentModeService();
    const result = await svc.createHtmlTemplate(
      req.body.html_source, req.body.template_id,
      req.body.template_name,
      req.body.subject, req.body.additional_instructions || '',
      userId(req), req.body.session_id || ''
    );
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// Supports CSS-selector, full, and legacy part modes
router.post('/update-html-file', async (req: Request, res: Response) => {
  try {
    const svc = await getAgentModeService();
    const result = await svc.updateHtmlFile(
      req.body.file_url, req.body.update_type,
      req.body.operations || req.body.replacement_instructions,
      userId(req), req.body.session_id || ''
    );
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// ─── Books ──────────────────────────────────────────────────────────────────

router.get('/books', async (req: Request, res: Response) => {
  try {
    const svc = await getAgentModeService();
    const result = await svc.listBooks(userId(req), req.query.type as string, req.query.status as string);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

router.get('/books/:bookId', async (req: Request, res: Response) => {
  try {
    const svc = await getAgentModeService();
    const result = await svc.getBookDetails(req.params.bookId, userId(req));
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

router.get('/books/:bookId/content', async (req: Request, res: Response) => {
  try {
    const svc = await getAgentModeService();
    const result = await svc.getBookContent(
      req.params.bookId, req.query.section_id as string,
      req.query.chapter_id as string, userId(req)
    );
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

router.post('/books', async (req: Request, res: Response) => {
  try {
    const svc = await getAgentModeService();
    const { title, description, type, author, language, genre, tags } = req.body;
    const result = await svc.createBook(title, description, type, author, language, genre, tags || [], userId(req));
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

router.put('/books/:bookId/content', async (req: Request, res: Response) => {
  try {
    const svc = await getAgentModeService();
    const { section_id, chapter_id, replacement_instructions } = req.body;
    const result = await svc.updateBookContent(
      req.params.bookId, section_id, chapter_id,
      replacement_instructions, userId(req)
    );
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

router.post('/books/:bookId/generate-content', async (req: Request, res: Response) => {
  try {
    const svc = await getAgentModeService();
    const { section_id, chapter_id, content_description, length, imagine, research_url } = req.body;
    const result = await svc.generateBookContent(
      req.params.bookId, section_id, chapter_id,
      content_description, length, imagine, userId(req), research_url
    );
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

router.post('/books/:bookId/outline', async (req: Request, res: Response) => {
  try {
    const svc = await getAgentModeService();
    const result = await svc.createBookOutline(req.params.bookId, req.body.outline_json, userId(req));
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

router.post('/books/:bookId/characters', async (req: Request, res: Response) => {
  try {
    const svc = await getAgentModeService();
    const result = await svc.addCharacters(req.params.bookId, req.body.characters_json, userId(req));
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// ─── Work Plans ─────────────────────────────────────────────────────────────

router.post('/work-plans', async (req: Request, res: Response) => {
  try {
    const svc = await getAgentModeService();
    const result = await svc.createWorkPlan(req.body.title, req.body.steps, req.body.session_id);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

router.put('/work-plans', async (req: Request, res: Response) => {
  try {
    const svc = await getAgentModeService();
    const result = await svc.modifyWorkPlan(req.body.steps, req.body.remove_step_counts || [], req.body.session_id);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

router.patch('/work-plans/status', async (req: Request, res: Response) => {
  try {
    const svc = await getAgentModeService();
    const result = await svc.setWorkPlanStatus(req.body.updates, req.body.session_id);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// ─── Review ─────────────────────────────────────────────────────────────────

router.post('/send-for-review', async (req: Request, res: Response) => {
  try {
    const svc = await getAgentModeService();
    const result = await svc.sendForReview(
      req.body.subject, req.body.session_id || '',
      userId(req), req.body.content_url, req.body.content_html
    );
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// ─── Task Templates ─────────────────────────────────────────────────────────

router.get('/task-templates', async (req: Request, res: Response) => {
  try {
    const svc = await getAgentModeService();
    const result = await svc.listTaskTemplates();
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

router.post('/task-from-template', async (req: Request, res: Response) => {
  try {
    const svc = await getAgentModeService();
    const { template_id, parameters_json, session_id, attach_previous_task_results, attached_file_urls } = req.body;
    const result = await svc.createTaskFromTemplate(
      template_id, parameters_json, userId(req), session_id || '',
      attach_previous_task_results, attached_file_urls || [], req.body.async ?? false
    );
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

router.post('/task-from-prompt', async (req: Request, res: Response) => {
  try {
    const svc = await getAgentModeService();
    const { task_name, prompt, category, session_id, attach_previous_task_results, attached_file_urls } = req.body;
    const result = await svc.createTaskFromPrompt(
      task_name, prompt, category, userId(req), session_id || '',
      attach_previous_task_results, attached_file_urls || [], req.body.async ?? false
    );
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

router.post('/image-task-from-prompt', async (req: Request, res: Response) => {
  try {
    const svc = await getAgentModeService();
    const { task_name, prompt, category, session_id, attach_previous_task_results } = req.body;
    const result = await svc.createImageTaskFromPrompt(
      task_name, prompt, category, userId(req), session_id || '',
      attach_previous_task_results
    );
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

router.post('/revision', async (req: Request, res: Response) => {
  try {
    const svc = await getAgentModeService();
    const { task_id, execution_id, revision_prompt, target_result_name } = req.body;
    const result = await svc.createRevision(task_id, execution_id, revision_prompt, userId(req), target_result_name);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

router.get('/task-subscriber-metrics', async (req: Request, res: Response) => {
  try {
    const svc = await getAgentModeService();
    const result = await svc.getTaskSubscriberMetrics(req.query.task_id as string, userId(req));
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

router.get('/task-subscriber-engagement', async (req: Request, res: Response) => {
  try {
    const svc = await getAgentModeService();
    const result = await svc.getTaskSubscriberEngagementEvents(
      req.query.task_id as string,
      req.query.email_subject as string,
      userId(req)
    );
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// ─── CRM (structured search) ────────────────────────────────────────────────

router.post('/search-leads', async (req: Request, res: Response) => {
  try {
    const svc = await getAgentModeService();
    const result = await svc.searchLeads(req.body.list_id, req.body.filters, userId(req), req.body.limit);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// ─── Emma Autonomous Actions Log (G5) ───────────────────────────────────────
// Read-only feed of events Emma initiated on behalf of the user. Reuses
// AW-ContactEvents as the source of truth; filters by source='emma_session'.
// Every row is shown with an affected-entity link and a (currently disabled)
// Revert action — v1 keeps it read-only as a safety-rail/visibility surface.

router.get('/actions', async (req: Request, res: Response) => {
  try {
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || '50'), 10) || 50, 1), 200);
    const { dynamodb } = await import('../config/aws');
    const TABLE_PREFIX = process.env.NODE_ENV === 'development' ? 'Dev-' : '';
    const TABLE_NAME = `${TABLE_PREFIX}AW-ContactEvents`;

    // Scan-with-filter is acceptable at current volume — Emma-initiated events
    // are a small fraction of total events and this route is user-triggered,
    // not hot-path. Upgrade to a source-index GSI if traffic grows.
    const result = await dynamodb
      .scan({
        TableName: TABLE_NAME,
        FilterExpression: '#src = :src AND tenantId = :uid',
        ExpressionAttributeNames: { '#src': 'source' },
        ExpressionAttributeValues: { ':src': 'emma_session', ':uid': userId(req) },
        Limit: limit * 4, // overscan because filter is applied post-read
      })
      .promise();

    const items = (result.Items || []) as Array<Record<string, unknown>>;
    // Sort newest-first by eventTimestamp
    items.sort((a, b) => String(b.eventTimestamp).localeCompare(String(a.eventTimestamp)));
    const trimmed = items.slice(0, limit);

    res.json({
      actions: trimmed.map((e: any) => ({
        eventId: e.eventId,
        eventTimestamp: e.eventTimestamp,
        eventType: e.eventType,
        contactId: e.contactId,
        dealId: e.dealId || null,
        payload: e.payload || {},
        sourceRecordId: e.sourceRecordId,
        // v1: revert disabled for every row. Keep a declarative flag so UI can
        // show a reason tooltip without having to re-derive it.
        revertible: false,
        revertDisabledReason: 'Revert not yet implemented — coming in a follow-up PR.',
      })),
      count: trimmed.length,
    });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// ─── Blog (additional routes) ───────────────────────────────────────────────

router.post('/repair-blog', async (req: Request, res: Response) => {
  try {
    const svc = await getAgentModeService();
    const result = await svc.repairBlogArticle(
      req.body.article_url, userId(req), req.body.session_id || ''
    );
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

export default router;
