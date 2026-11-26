/**
 * Emma API Routes — REST endpoints for AI operations that were previously
 * only accessible through direct MCP tool calls. These routes go through
 * authenticateToken middleware so MCP tools can self-call them via HTTP.
 */

import { Router, Request, Response } from 'express';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { requireEmmaTokenBudget } from '../middleware/emmaTokenBudget';
import { MCP_ENGAGEMENTS_PER_LEAD, MCP_ENGAGEMENT_MAX_LEAD_BYTES } from '../utils/agentEngagementLimits';
import { chatbotDb } from '../services/chatbotService';
import { publishRevalidationForForwardedRun, publishWithdrawnMidFlight, SCHEDULED_SESSION_HEADER } from '../utils/scheduledPublishConsentGuard';
import { getMetaAdsMetricsArgsSchema } from '../utils/metaCampaignIds';
import { assertModelInOwnerPlan } from '../services/agentMode/modelAccessInstance';
import { buildModelUnavailableBody, isModelUnavailableError, ModelUnavailableError } from '../services/agentMode/modelUnavailable';
import { isAgentWebModelId } from '../services/agentMode/agentWebModelRouter';

/**
 * ENG-669: a model named in the request body runs on the caller's account, so it must be in the caller's plan (the
 * tier model allowlist; switch off => no read). Answers the shared 422 and returns false when refused.
 */
async function modelInCallerPlan(req: Request, res: Response, rawModel: unknown): Promise<boolean> {
  if (typeof rawModel !== 'string' || !rawModel.trim()) return true;
  // ENG-669 PR-C: these routes call one model directly (no resolver, no router), so the AgentWeb Model can never run
  // here; refused visibly (with the switch on or off) instead of silently running a default model.
  if (isAgentWebModelId(rawModel)) {
    res.status(422).json(buildModelUnavailableBody(new ModelUnavailableError(rawModel.trim(), 'not_selectable')));
    return false;
  }
  try {
    await assertModelInOwnerPlan({ ownerUserId: userId(req), model: rawModel });
    return true;
  } catch (error) {
    if (!isModelUnavailableError(error)) throw error;
    const svc = await getAgentModeService();
    res.status(422).json(buildModelUnavailableBody(error, svc.getModelDisplayName?.(error.requestedModel)));
    return false;
  }
}

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

/**
 * Session-access gate for routes that act on a chat session named by `session_id` in the body.
 *
 * These routes are thin delegates to agentModeService, whose implementations load the session by
 * id and read or write it (work plan, review metadata, transcript, cost) without knowing who is
 * asking. The rule is the one agentModeController.getSession / generateResponse apply to the same
 * sessions: the owner, or an admin. Delegate (support) tokens resolve `req.user` to the TARGET
 * account in middleware/auth.ts, so a delegate passes on exactly the chats it can open and run.
 *
 * A missing session and a session the caller may not access both answer 404, so the response
 * never confirms that another account's session id exists. Reads the session record only
 * (getChatSessionRecord), never the message table, so a refused caller triggers no transcript read.
 *
 * `required`: the route cannot do anything without a session (400 when absent). Otherwise an
 * absent/empty session_id keeps the route's existing no-session behaviour (MCP self-calls send none).
 * Returns false when it has already answered the request.
 */
async function sessionAccessAllowed(req: Request, res: Response, sessionId: unknown, required: boolean): Promise<boolean> {
  if (sessionId === undefined || sessionId === null || sessionId === '') {
    if (!required) return true;
    res.status(400).json({ message: 'session_id is required' });
    return false;
  }
  if (typeof sessionId !== 'string') {
    res.status(400).json({ message: 'session_id must be a string' });
    return false;
  }
  const user = (req as AuthenticatedRequest).user;
  // Strongly consistent: a session created just before this call must not read as missing (false 404).
  const session = await chatbotDb.getChatSessionRecord(sessionId, true);
  if (!session || (session.userId !== user.userId && !user.isAdmin)) {
    res.status(404).json({ message: 'Session not found' });
    return false;
  }
  return true;
}

// ─── Search & Research ──────────────────────────────────────────────────────

router.post('/you-search-web', async (req: Request, res: Response) => {
  try {
    const svc = await getAgentModeService();
    const result = await svc.youSearchWeb(req.body.query, req.body.max_results || 10, undefined, undefined, userId(req));
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

router.post('/you-search-news', async (req: Request, res: Response) => {
  try {
    const svc = await getAgentModeService();
    const result = await svc.youSearchNews(req.body.query, req.body.max_results || 10, req.body.freshness, userId(req));
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

router.post('/google-search-web', async (req: Request, res: Response) => {
  try {
    const svc = await getAgentModeService();
    const result = await svc.googleSearchWeb(req.body.query, req.body.max_results || 10, userId(req));
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
    if (!(await sessionAccessAllowed(req, res, session_id, false))) return;
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
    if (!(await sessionAccessAllowed(req, res, session_id, false))) return;
    const result = await svc.generateVideo(prompt, filename, userId(req), session_id, video_model, start_frame, end_frame);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

router.post('/describe-media', async (req: Request, res: Response) => {
  try {
    const svc = await getAgentModeService();
    const { type, url, prompt, llm_model, return_transcript, return_scenes, start_time, end_time, session_id } = req.body;
    if (type !== 'video' && !(await modelInCallerPlan(req, res, llm_model))) return;
    let result;
    if (type === 'video') {
      // ENG-1961: carry the session too, so analysis run through this API is
      // traceable to its chat the same way the tool path is (the sibling
      // /generate-video route already takes session_id).
      result = await svc.describeVideo(url, prompt, {
        return_transcript, return_scenes, start_time, end_time,
        userId: userId(req), sessionId: session_id,
      });
    } else {
      // ENG-1858: meter to the API caller instead of "system".
      result = await svc.describeImage(llm_model || 'gpt-4o', url, prompt, {
        userId: userId(req), sessionId: session_id, feature: 'describe_image',
      });
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

const MAX_GET_MESSAGE_IDS = 50;

router.post('/email', async (req: Request, res: Response) => {
  try {
    const { bootstrapEmailProviders, resolveEmailAccount, withAccessGuard } = await import('../services/emailProviderService');
    await bootstrapEmailProviders();
    // ownerUserId, not the caller: an org-shared mailbox lives in the teammate's
    // record, and that is where the provider reads (and refreshes) its tokens.
    // A send is resolved as a write, so it is refused on a teammate's mailbox.
    const operation = req.body.action === 'send' ? 'send' : 'read';
    const resolved = await resolveEmailAccount(userId(req), req.body.account_id, operation);
    const { provider, ownerUserId } = resolved;
    // External MCP read_email sets own_mailbox_only: the caller's own mailbox is
    // the only one an external API key may read — never a teammate's shared one.
    if (req.body.own_mailbox_only === true && ownerUserId !== userId(req)) {
      return res.status(403).json({ message: 'This mailbox is shared by a teammate and cannot be read by external clients. Only your own connected accounts are available.' });
    }
    // Every provider call runs inside withAccessGuard: a teammate's shared
    // mailbox is re-checked immediately before the call AND before the result is
    // returned, so a share revoked mid-read discloses nothing.
    const guarded = <T,>(read: () => Promise<T>) => withAccessGuard(userId(req), resolved, operation, read);

    const { action } = req.body;
    let result;
    switch (action) {
      case 'search': {
        const maxResults = Math.min(req.body.max_results || 10, 50);
        const emails = await guarded(() => provider.searchEmails(ownerUserId, req.body.account_id, req.body.query, maxResults));
        result = { emails, count: emails.length };
        break;
      }
      case 'list': {
        const maxResults = Math.min(req.body.max_results || 20, 50);
        const emails = await guarded(() => provider.listEmails(ownerUserId, req.body.account_id, req.body.folder || 'INBOX', maxResults));
        result = { emails, count: emails.length };
        break;
      }
      case 'get': {
        const ids: string[] = Array.isArray(req.body.message_ids) ? req.body.message_ids : [];
        if (ids.length > MAX_GET_MESSAGE_IDS || ids.some((id) => typeof id !== 'string')) {
          return res.status(400).json({ message: `message_ids must be at most ${MAX_GET_MESSAGE_IDS} strings` });
        }
        const emails = await guarded(() => provider.getEmails(ownerUserId, req.body.account_id, ids));
        result = { emails, count: emails.length };
        break;
      }
      case 'send': {
        // ENG-673: an address-only send must not reach a contact marked do-not-contact.
        const { blockedRecipients, blockedMessage } = await import('../services/contactGuard');
        let blocked: string[];
        try {
          blocked = await blockedRecipients([userId(req), ownerUserId], req.body.to, req.body.cc, req.body.bcc);
        } catch (e) {
          console.error('[emmaApi] do-not-contact check failed, not sending:', e);
          return res.status(503).json({ code: 'do_not_contact_unverified', message: 'Could not check whether the recipient is marked do-not-contact, so nothing was sent.' });
        }
        if (blocked.length > 0) return res.status(409).json({ code: 'do_not_contact', message: blockedMessage(blocked), blocked });
        const sendResult = await provider.sendEmail(ownerUserId, req.body.account_id, {
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
  return publishRevalidationForForwardedRun(req, 'post_on_connected_account');
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
      undefined, toolContext,
      req.body.save_as_draft === true || req.body.in_reply_to_post_id
        ? { ...(req.body.save_as_draft === true ? { saveAsDraft: true } : {}), ...(typeof req.body.in_reply_to_post_id === 'string' && req.body.in_reply_to_post_id ? { inReplyToPostId: req.body.in_reply_to_post_id } : {}) }
        : undefined
    );
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// ENG-1005: authenticated, metered counterparts of the internal blog tools.
// Keep the existing service behavior and carry scheduled consent to the CMS write.
router.post('/create-blog-article', async (req: Request, res: Response) => {
  try {
    const args = req.body;
    if (![args.title_draft, args.content_draft].every(value => typeof value === 'string' && value.trim())) {
      return res.status(400).json({ message: 'title_draft and content_draft are required.' });
    }
    const svc = await getAgentModeService();
    const result = await svc.createBlogArticle(
      args.title_draft, args.content_draft, args.length || 'medium',
      args.researchContext || '', args.requirements || '',
      userId(req), req.header(SCHEDULED_SESSION_HEADER) || '',
      args.style || 'default', args.deep_research === true
    );
    return res.json(result);
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
});

router.post('/publish-blog-article', async (req: Request, res: Response) => {
  try {
    const args = req.body;
    if (![args.title, args.description, args.hero_image_url, args.blog_html_url].every(value => typeof value === 'string' && value.trim())) {
      return res.status(400).json({ message: 'title, description, hero_image_url, and blog_html_url are required.' });
    }
    const status = args.status ?? 'draft';
    if (status !== 'draft' && status !== 'published') return res.status(400).json({ message: 'status must be draft or published.' });
    const publishContext = status === 'published' ? publishRevalidationForForwardedRun(req, 'publish_blog_article') : undefined;
    const withdrawn = await publishWithdrawnMidFlight(publishContext);
    if (withdrawn) return res.json(withdrawn);
    const svc = await getAgentModeService();
    return res.json(await svc.publishBlogArticle(
      args.title, args.description, args.hero_image_url, args.blog_html_url,
      userId(req), req.header(SCHEDULED_SESSION_HEADER) || '',
      status, args.author, args.categories, publishContext?.assertPublishStillAuthorized
    ));
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
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
    /*
     * ENG-1725: this used to destructure parent_id/entity_id/fields and pass them positionally
     * into callMetaMarketingApi's (campaign_id, ad_set_id, ad_id) slots — none of those names
     * exist anywhere in this tool's own published schema (emma/tools.ts's call_meta_marketing_api
     * definition), which documents campaign_id/ad_set_id/ad_id as the actual field names, and
     * whose `execute()` handler (the path every LLM/agent tool call actually takes) already
     * passes args.campaign_id/args.ad_set_id/args.ad_id straight through correctly. Only this
     * raw REST route was out of sync with its own spec — `fields` in particular was never an id
     * at all, so it could end up silently occupying the ad_id slot. Reading the documented names
     * here instead makes this route consistent with the one path (agent tool-calling) that was
     * already correct, and with anyone who followed the published schema rather than the
     * previously-undocumented parent_id/entity_id/fields shape.
     */
    const { entity_type, action, account_id, campaign_id, ad_set_id, ad_id, params, session_id } = req.body;
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
    const result = await svc.callMetaMarketingApi(userId(req), entity_type, action, account_id, campaign_id, ad_set_id, ad_id, params, session_id);
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
    // Direct HTTP clients historically sent numeric IDs; keep accepting them here
    // while the tool-gateway contract stays string-only.
    const requestBody = Array.isArray(req.body?.campaign_ids)
      ? { ...req.body, campaign_ids: req.body.campaign_ids.map((id: unknown) =>
        (typeof id === 'number' ? String(id) : id)) }
      : req.body;
    const parsed = getMetaAdsMetricsArgsSchema.safeParse(requestBody);
    if (!parsed.success) return res.json({ success: false,
      message: 'campaign_ids is required and must contain at least one campaign ID.', error: 'Invalid campaign_ids' });
    const svc = await getAgentModeService();
    const result = await svc.getMetaAdsMetrics(
      parsed.data.timeframe || '7d',
      userId(req),
      parsed.data.campaign_ids,
      parsed.data.account_id,
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

/**
 * ENG-2840 (W2-7): a caller may narrow a file read (the MCP tool always does): `own_storage_only: true` refuses any URL that is not a file in
 * the caller's own AgentWeb storage before anything is fetched, and `max_bytes` (a whole number from 1 to 50 MB) refuses a larger stored file.
 * Absent (or null), the read is Emma's, as before. Any other value is a 400, never a silent "no limit".
 */
const READ_FILE_MAX_BYTES_CEILING = 50 * 1024 * 1024;
function readFileLimits(body: any): { ownStorageOnly?: true; maxBytes?: number } | string {
  const limits: { ownStorageOnly?: true; maxBytes?: number } = {};
  const own = body?.own_storage_only;
  if (own !== undefined && own !== null) {
    if (typeof own !== 'boolean') return 'own_storage_only must be true or false';
    if (own) limits.ownStorageOnly = true;
  }
  const max = body?.max_bytes;
  if (max !== undefined && max !== null) {
    if (typeof max !== 'number' || !Number.isInteger(max) || max < 1 || max > READ_FILE_MAX_BYTES_CEILING) {
      return `max_bytes must be a whole number from 1 to ${READ_FILE_MAX_BYTES_CEILING}`;
    }
    limits.maxBytes = max;
  }
  return limits;
}

router.post('/read-file', async (req: Request, res: Response) => {
  try {
    const limits = readFileLimits(req.body);
    if (typeof limits === 'string') return res.status(400).json({ message: limits });
    const svc = await getAgentModeService();
    const result = await svc.readFileContent(req.body.file_url, { userId: userId(req), ...limits });
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
    const result = await svc.readFileContent(req.body.url, { userId: userId(req) });
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
    if (!(await sessionAccessAllowed(req, res, req.body.session_id, false))) return;
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
    if (!(await modelInCallerPlan(req, res, req.body.llm_model))) return;
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
    if (!(await sessionAccessAllowed(req, res, req.body.session_id, false))) return;
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
    if (!(await sessionAccessAllowed(req, res, req.body.session_id, true))) return;
    const svc = await getAgentModeService();
    const result = await svc.createWorkPlan(req.body.title, req.body.steps, req.body.session_id);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

router.put('/work-plans', async (req: Request, res: Response) => {
  try {
    if (!(await sessionAccessAllowed(req, res, req.body.session_id, true))) return;
    const svc = await getAgentModeService();
    const result = await svc.modifyWorkPlan(req.body.steps, req.body.remove_step_counts || [], req.body.session_id);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

router.patch('/work-plans/status', async (req: Request, res: Response) => {
  try {
    if (!(await sessionAccessAllowed(req, res, req.body.session_id, true))) return;
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
    if (!(await sessionAccessAllowed(req, res, req.body.session_id, true))) return;
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
    if (!(await sessionAccessAllowed(req, res, session_id, false))) return;
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
    if (!(await sessionAccessAllowed(req, res, session_id, false))) return;
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
    if (!(await sessionAccessAllowed(req, res, session_id, false))) return;
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

// ─── CRM (lead readback, ENG-3021) ──────────────────────────────────────────
// Reads only: nothing in a lead or a list changes (an engagement read can store a fetched email body, a cache, in the event table).
// The same handlers Emma's get_leads / get_lead_details / get_lead_engagements / get_lead_list_statuses tools call, reachable
// without a model run so a verifier can read stored fields (contactStatus and the
// unsubscribe evidence) back. The caller is always the authenticated user; the
// handlers enforce list access, so nothing here trusts an identity from the body.

const isId = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

/**
 * ENG-2840 (W2-5a): a caller may bound how many email bodies one history read fetches from the mail provider (`max_content_fetches`, a
 * whole number 0 to 50). The MCP lead tools always send it; without it (Emma's own tools, the readback verifier) a read fetches every body
 * that is not stored yet, as before. Any other value is a 400.
 */
const MAX_CONTENT_FETCHES_CEILING = 50;
const INVALID_CONTENT_FETCHES = `max_content_fetches must be a whole number from 0 to ${MAX_CONTENT_FETCHES_CEILING}`;
const INVALID_RECOVER_STALE_LIST = 'recover_stale_list must be true or false';
/** Absent (or null): no allowance. A whole number 0 to 50: the allowance. Anything else is 'invalid': the route answers 400, never a silent "no cap". */
function contentFetchOptions(value: unknown): { maxContentFetches: number } | undefined | 'invalid' {
  if (value === undefined || value === null) return undefined;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_CONTENT_FETCHES_CEILING ? { maxContentFetches: value } : 'invalid';
}

router.post('/leads', async (req: Request, res: Response) => {
  const body = req.body ?? {};
  if (!isId(body.list_id)) return res.status(400).json({ message: 'list_id is required' });
  try {
    const svc = await getAgentModeService();
    const options = {
      ...(typeof body.limit === 'number' ? { limit: body.limit } : {}),
      ...(typeof body.cursor === 'string' ? { cursor: body.cursor } : {}),
      ...(typeof body.status === 'string' ? { status: body.status } : {}),
      ...(typeof body.search === 'string' ? { search: body.search } : {}),
      ...(body.include_all_fields === true ? { includeAllFields: true } : {}),
    };
    res.json(await svc.getLeads(body.list_id, userId(req), options));
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

router.post('/lead-details', async (req: Request, res: Response) => {
  const body = req.body ?? {};
  if (!isId(body.list_id) || !isId(body.lead_id)) return res.status(400).json({ message: 'list_id and lead_id are required' });
  try {
    const svc = await getAgentModeService();
    const fetchOptions = contentFetchOptions(body.max_content_fetches);
    if (fetchOptions === 'invalid') return res.status(400).json({ message: INVALID_CONTENT_FETCHES });
    // `recover_stale_list: false` skips the search of the caller's other lists (the MCP tool always sends it); `true`, null or absent keep it
    if (body.recover_stale_list !== undefined && body.recover_stale_list !== null && typeof body.recover_stale_list !== 'boolean') {
      return res.status(400).json({ message: INVALID_RECOVER_STALE_LIST });
    }
    const options = fetchOptions || body.recover_stale_list === false
      ? { ...(fetchOptions ?? {}), ...(body.recover_stale_list === false ? { recoverStaleList: false } : {}) }
      : undefined;
    res.json(options ? await svc.getLeadDetails(body.list_id, body.lead_id, userId(req), options) : await svc.getLeadDetails(body.list_id, body.lead_id, userId(req)));
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// ENG-2840 (W2-5a): the engagement history of one lead and the pipeline stages of one list, for the MCP tools of the same names.
// Same handlers as Emma's tools (list access is checked inside them); a refusal is HTTP 200 `{ success: false, message }`, as above.
router.post('/lead-engagements', async (req: Request, res: Response) => {
  const body = req.body ?? {};
  if (!isId(body.list_id) || !isId(body.lead_id)) return res.status(400).json({ message: 'list_id and lead_id are required' });
  try {
    const svc = await getAgentModeService();
    const limit = typeof body.limit === 'number' ? body.limit : undefined;
    const options = contentFetchOptions(body.max_content_fetches);
    if (options === 'invalid') return res.status(400).json({ message: INVALID_CONTENT_FETCHES });
    res.json(options ? await svc.getLeadEngagements(body.list_id, body.lead_id, userId(req), limit, options) : await svc.getLeadEngagements(body.list_id, body.lead_id, userId(req), limit));
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// ENG-2840 (W2-7): record one event on a lead, for the MCP tool `add_lead_engagement`. Emma's own handler (list access checked inside it, a
// refusal is HTTP 200 `{ success: false, message }`), always with the outside-agent limits: the event is stamped `channel: 'mcp'`, a lead holds
// at most MCP_ENGAGEMENTS_PER_LEAD of them, a lead whose record is nearly full takes none, and an `idempotency_key` already on the lead
// records nothing. No owner alert is sent (the CRM route's alert is not called). The shape of `event_data` is checked by the MCP tool.
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{8,64}$/;
router.post('/add-lead-engagement', async (req: Request, res: Response) => {
  const body = req.body ?? {};
  if (!isId(body.list_id) || !isId(body.lead_id)) return res.status(400).json({ message: 'list_id and lead_id are required' });
  if (typeof body.event_type !== 'string' || body.event_type.trim() === '') return res.status(400).json({ message: 'event_type is required' });
  if (body.event_data !== undefined && body.event_data !== null && (typeof body.event_data !== 'object' || Array.isArray(body.event_data))) {
    return res.status(400).json({ message: 'event_data must be an object' });
  }
  if (body.event_date !== undefined && body.event_date !== null && typeof body.event_date !== 'string') {
    return res.status(400).json({ message: 'event_date must be an ISO 8601 date-time' });
  }
  if (body.idempotency_key !== undefined && body.idempotency_key !== null && (typeof body.idempotency_key !== 'string' || !IDEMPOTENCY_KEY_RE.test(body.idempotency_key))) {
    return res.status(400).json({ message: 'idempotency_key must be 8 to 64 letters, digits, - or _' });
  }
  try {
    const svc = await getAgentModeService();
    res.json(await svc.addLeadEngagement(body.list_id, body.lead_id, body.event_type, userId(req), body.event_data ?? undefined, body.event_date ?? undefined, {
      channel: 'mcp',
      maxChannelEvents: MCP_ENGAGEMENTS_PER_LEAD,
      maxLeadBytes: MCP_ENGAGEMENT_MAX_LEAD_BYTES,
      ...(typeof body.idempotency_key === 'string' ? { idempotencyKey: body.idempotency_key } : {}),
    }));
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// ENG-2840 (W2-6a): the organization's lead-notification settings for the MCP tool of the same name. Unlike Emma's own read, it requires
// org:configure (the view holds Slack channel and user ids), as the hot-lead call settings read does. Refusals are real 4xx answers.
router.get('/lead-notification-settings', async (req: Request, res: Response) => {
  try {
    const { readLeadNotificationSettings } = await import('../emma/leadNotificationTools');
    const { OrgMembershipRequiredError } = await import('../emma/orgCaller');
    try {
      res.json(await readLeadNotificationSettings({ userId: userId(req) }, { requireConfigure: true }));
    } catch (err: any) {
      if (err instanceof OrgMembershipRequiredError) return res.status(404).json({ message: 'Organization membership required' });
      if (String(err?.message).startsWith('Only org owners and admins')) return res.status(403).json({ message: 'Only organization owners and admins can read the lead notification settings' });
      if (err?.message === 'Organization not found') return res.status(404).json({ message: 'Organization not found' });
      console.error('lead-notification-settings read failed:', err?.message);
      res.status(500).json({ message: 'The lead notification settings could not be read' });
    }
  } catch (err: any) {
    res.status(500).json({ message: 'The lead notification settings could not be read' });
  }
});

router.post('/lead-list-statuses', async (req: Request, res: Response) => {
  const body = req.body ?? {};
  if (!isId(body.list_id)) return res.status(400).json({ message: 'list_id is required' });
  try {
    const svc = await getAgentModeService();
    res.json(await svc.getLeadListStatuses(body.list_id, userId(req)));
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
