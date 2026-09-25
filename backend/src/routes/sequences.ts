/**
 * /api/crm/sequences — drip sequence CRUD + enrollment management
 *
 * All routes require authentication.  Users can only access their own sequences.
 */

import express, { Request, Response } from 'express';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import {
  dripSequenceDb,
  SequenceNotFoundError,
  SequenceAuthError,
  CreateSequenceInput,
  UpdateSequenceInput,
} from '../services/dripSequenceDb';
import { crmDb } from '../services/db';
import { resolveSenderForSend } from '../services/crmSenderService';
import { CrmSender } from '../services/crmSenderTypes';
import { sendAsSender } from '../services/sendAsSender';
import axios from 'axios';
import { extractVariables, leadHasVariable, isSupportedVariable, injectUnsubscribeUrl, inlineEmailStyles, rewriteS3ImageUrls, normalizeYoutubeUrls } from '../utils/emailVariables';
import { LLMService } from '../utils/llmService';
import { LEAD_LIFECYCLES, defaultStatusConfigFor } from '../utils/leadSchema';

/**
 * ENG-2127: the by-list enrol accepts a `lifecycle` filter and hands it to
 * crmDb.getLeadsByStatus, which queries the `status` attribute on listId-status-index and
 * never reads `lifecycle` at all. The two vocabularies are disjoint — measured against
 * production, `status` holds contacted/new/qualified/open/lost/closed/won/… while
 * `lifecycle` holds inbox/signed_up — so a lifecycle-filtered enrol can never match
 * anything. It returns an empty array, which is a legitimate result, so the caller reports
 * "0 leads enrolled" and nothing anywhere says why.
 *
 * Fixing it properly means deciding what the filter should mean (a listId-lifecycle-index,
 * or dropping the control) and is tracked on ENG-2127. Until then this at least refuses to
 * fail silently.
 */
const LIFECYCLE_STAGES: ReadonlySet<string> = new Set<string>(LEAD_LIFECYCLES);

const router = express.Router();

/**
 * Which channels a sequence will actually try to use. A step with no `channel` is email
 * (backwards compatibility — see SequenceStep).
 */
function requiredChannels(sequence: any): Set<string> {
  const steps = sequence?.steps ?? [];
  // No sequence in hand (the listId-only verify call) means no channel evidence. Default
  // to email rather than to the empty set, which would mean "reachable on no channels" —
  // i.e. filter nothing — and silently widen the population this screen reports on.
  if (steps.length === 0) return new Set<string>(['email']);
  return new Set<string>(steps.map((st: any) => String(st?.channel ?? 'email')));
}

/**
 * Can this sequence reach this lead on EVERY channel it uses?
 *
 * The first version of this guard tested `lead.email` only, which was wrong: sequences are
 * not email-only. `SequenceChannel = 'email' | 'linkedin'`, and dripSequenceWorker's
 * sendLinkedInStep reaches the lead through `lead.linkedin` after loading it by leadId —
 * it never touches the address. So a LinkedIn-only lead in a LinkedIn sequence WAS being
 * messaged, and an email-only test excluded it from enrolment entirely.
 *
 * Every channel, not any: a step whose channel the lead cannot receive throws in the
 * worker and is retried forever, which is the failure this guard exists to prevent.
 */
function leadIsReachable(lead: any, channels: Set<string>): boolean {
  if (channels.has('email') && !String(lead?.email ?? '').trim()) return false;
  if (channels.has('linkedin') && !String(lead?.linkedin ?? '').trim()) return false;
  return true;
}

/**
 * The enrollment's dedup identity. `leadEmail` is the partition key of
 * `leadEmail-index`, which getExistingEnrollment queries — an empty one makes the row
 * invisible to the dedup check, so it is re-created on every run and the lead is
 * messaged again each time. For a lead with no address the LinkedIn URL is the stable
 * identity; dripSequenceWorker already treats the field that way at its reply-exit check.
 */
function enrollmentIdentity(lead: any): string {
  return String(lead?.email ?? '').trim() || String(lead?.linkedin ?? '').trim();
}

// ─── Sequences CRUD ───────────────────────────────────────────────────────────

// GET /api/crm/sequences
router.get('/', authenticateToken, async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  try {
    const sequences = await dripSequenceDb.listSequences(authReq.user!.userId);
    res.json({ sequences });
  } catch (err) {
    console.error('[sequences] listSequences error:', err);
    res.status(500).json({ error: 'Failed to fetch sequences' });
  }
});

// POST /api/crm/sequences
router.post('/', authenticateToken, async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const { name, description, campaignType, enrollmentTrigger, enrollmentCondition, exitConditions, steps, status } = req.body;
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }

  try {
    const input: CreateSequenceInput = {
      userId: authReq.user!.userId,
      name: name.trim(),
      description,
      campaignType,
      enrollmentTrigger,
      enrollmentCondition,
      exitConditions,
      steps,
      status,
    };
    const sequence = await dripSequenceDb.createSequence(input);
    res.status(201).json({ sequence });
  } catch (err) {
    console.error('[sequences] createSequence error:', err);
    res.status(500).json({ error: 'Failed to create sequence' });
  }
});

// GET /api/crm/sequences/:sequenceId
router.get('/:sequenceId', authenticateToken, async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  try {
    const sequence = await dripSequenceDb.getSequence(req.params.sequenceId);
    if (!sequence) return res.status(404).json({ error: 'Sequence not found' });
    if (sequence.userId !== authReq.user!.userId) return res.status(403).json({ error: 'Forbidden' });
    res.json({ sequence });
  } catch (err) {
    console.error('[sequences] getSequence error:', err);
    res.status(500).json({ error: 'Failed to fetch sequence' });
  }
});

// PUT /api/crm/sequences/:sequenceId
router.put('/:sequenceId', authenticateToken, async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const { name, description, campaignType, enrollmentTrigger, enrollmentCondition, exitConditions, autoEnrollListIds, steps, status } = req.body;
  try {
    const input: UpdateSequenceInput = {
      name,
      description,
      campaignType,
      enrollmentTrigger,
      enrollmentCondition,
      exitConditions,
      autoEnrollListIds,
      steps,
      status,
    };
    const sequence = await dripSequenceDb.updateSequence(
      req.params.sequenceId,
      authReq.user!.userId,
      input,
    );
    res.json({ sequence });
  } catch (err: any) {
    if (err instanceof SequenceNotFoundError) return res.status(404).json({ error: err.message });
    if (err instanceof SequenceAuthError) return res.status(403).json({ error: err.message });
    console.error('[sequences] updateSequence error:', err);
    res.status(500).json({ error: 'Failed to update sequence' });
  }
});

// DELETE /api/crm/sequences/:sequenceId
router.delete('/:sequenceId', authenticateToken, async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  try {
    await dripSequenceDb.deleteSequence(req.params.sequenceId, authReq.user!.userId);
    res.json({ success: true });
  } catch (err: any) {
    if (err instanceof SequenceNotFoundError) return res.status(404).json({ error: err.message });
    if (err instanceof SequenceAuthError) return res.status(403).json({ error: err.message });
    console.error('[sequences] deleteSequence error:', err);
    res.status(500).json({ error: 'Failed to delete sequence' });
  }
});

// ─── Enrollments ──────────────────────────────────────────────────────────────

// GET /api/crm/sequences/:sequenceId/enrollments
router.get(
  '/:sequenceId/enrollments',
  authenticateToken,
  async (req: Request, res: Response) => {
    const authReq = req as AuthenticatedRequest;
    try {
      const sequence = await dripSequenceDb.getSequence(req.params.sequenceId);
      if (!sequence) return res.status(404).json({ error: 'Sequence not found' });
      if (sequence.userId !== authReq.user!.userId) return res.status(403).json({ error: 'Forbidden' });

      const status = req.query.status as any;
      const enrollments = await dripSequenceDb.listEnrollmentsForSequence(
        req.params.sequenceId,
        status,
      );
      const stats = await dripSequenceDb.getEnrollmentStats(req.params.sequenceId);
      res.json({ enrollments, stats });
    } catch (err) {
      console.error('[sequences] listEnrollments error:', err);
      res.status(500).json({ error: 'Failed to fetch enrollments' });
    }
  },
);

// POST /api/crm/sequences/:sequenceId/enrollments — bulk enroll leads
router.post(
  '/:sequenceId/enrollments',
  authenticateToken,
  async (req: Request, res: Response) => {
    const authReq = req as AuthenticatedRequest;
    const { leads, startAt } = req.body;
    if (!Array.isArray(leads) || leads.length === 0) {
      return res.status(400).json({ error: 'leads array is required' });
    }

    try {
      const sequence = await dripSequenceDb.getSequence(req.params.sequenceId);
      if (!sequence) return res.status(404).json({ error: 'Sequence not found' });
      if (sequence.userId !== authReq.user!.userId) return res.status(403).json({ error: 'Forbidden' });
      if (sequence.steps.length === 0) {
        return res.status(400).json({ error: 'Sequence has no steps' });
      }

      // An enrollment the sequence cannot deliver makes dripSequenceWorker throw and
      // RETHROW, so it retries forever; and an empty leadEmail is invisible to
      // getExistingEnrollment, so the row is re-created on every run. Reported rather than
      // dropped silently — this route takes an explicit lead array, so the caller chose
      // these rows and deserves to know some were not enrollable.
      const channels = requiredChannels(sequence);
      const enrollable = leads.filter((l: any) =>
        leadIsReachable({ email: l.leadEmail ?? l.email, linkedin: l.linkedin }, channels));
      const skippedUnreachable = leads.length - enrollable.length;
      const inputs = enrollable.map((l: any) => ({
        sequenceId: req.params.sequenceId,
        userId: authReq.user!.userId,
        listId: l.listId,
        leadId: l.leadId,
        leadEmail: enrollmentIdentity({ email: l.leadEmail ?? l.email, linkedin: l.linkedin }),
        startAt: startAt ?? undefined,
      }));

      const result = await dripSequenceDb.bulkEnroll(inputs);
      // `skippedNoEmail` kept for an email-only sequence so existing callers still read the
      // field they know; a LinkedIn step makes "no email" the wrong word for it.
      const skipKey = channels.has('linkedin') ? 'skippedUnreachable' : 'skippedNoEmail';
      res.json(skippedUnreachable > 0 ? { ...result, [skipKey]: skippedUnreachable } : result);
    } catch (err: any) {
      if (err instanceof SequenceNotFoundError) return res.status(404).json({ error: err.message });
      if (err instanceof SequenceAuthError) return res.status(403).json({ error: err.message });
      console.error('[sequences] bulkEnroll error:', err);
      res.status(500).json({ error: 'Failed to enroll leads' });
    }
  },
);

// POST /api/crm/sequences/:sequenceId/enrollments/by-list — enroll all leads from a list
router.post(
  '/:sequenceId/enrollments/by-list',
  authenticateToken,
  async (req: Request, res: Response) => {
    const authReq = req as AuthenticatedRequest;
    const { listId, lifecycle, startAt, confirm } = req.body;
    if (!listId) return res.status(400).json({ error: 'listId is required' });

    try {
      const sequence = await dripSequenceDb.getSequence(req.params.sequenceId);
      if (!sequence) return res.status(404).json({ error: 'Sequence not found' });
      if (sequence.userId !== authReq.user!.userId) return res.status(403).json({ error: 'Forbidden' });
      if (sequence.steps.length === 0) {
        return res.status(400).json({ error: 'Sequence has no steps' });
      }

      // Verify the caller owns (or org-shares) the list before reading its leads.
      const list = await crmDb.getLeadListById(listId);
      if (!list) return res.status(404).json({ error: 'List not found' });
      if (!(await crmDb.canOrgMemberAccessList(authReq.user!.userId, list))) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      // Load ALL leads. Lifecycle-filtered enroll keeps its existing path; the
      // default list enroll uses the paginated loader so counts/enrollment are complete.
      let leads: any[];
      if (lifecycle) {
        const r = await crmDb.getLeadsByStatus(listId, lifecycle);
        leads = Array.isArray(r) ? r : ((r as any).items ?? (r as any).leads ?? []);
        // Only complain when the value is a lifecycle stage AND NOT a status this list
        // actually defines. `at_risk` and `churned` are BOTH lifecycle stages and default
        // lead statuses (db.ts:5364), and a list can define any statusConfig it likes — so
        // the first version of this guard answered a perfectly valid `status: churned`
        // filter that happened to match nothing with a 400 telling the caller to "filter by
        // a lead status instead", which is exactly what they had done.
        // A list with no stored statusConfig does not have NO statuses — it falls back to
        // the default set, which contains `churned` (and `at_risk` for a customers list).
        // Reading absent as empty put the original 400 straight back for every list
        // created before createLeadList started persisting a default.
        const storedStatusConfig = (list as any)?.statusConfig;
        const effectiveStatusConfig = Array.isArray(storedStatusConfig) && storedStatusConfig.length > 0
          ? storedStatusConfig
          : defaultStatusConfigFor((list as any)?.listType);
        const listStatuses = new Set(
          effectiveStatusConfig.map((s: any) => String(s?.value)),
        );
        if (leads.length === 0 && LIFECYCLE_STAGES.has(String(lifecycle)) && !listStatuses.has(String(lifecycle))) {
          console.error(
            `[sequences] ENG-2127: lifecycle filter "${lifecycle}" matched 0 leads in list ` +
            `${listId} because getLeadsByStatus queries the \`status\` attribute, not ` +
            `\`lifecycle\`. This filter cannot match; enrolling nothing.`,
          );
          return res.status(400).json({
            error: 'lifecycle_filter_unsupported',
            message:
              `Filtering by lifecycle stage "${lifecycle}" is not supported yet — leads are ` +
              `indexed by status, not lifecycle, so this filter matches nothing. Enrol the ` +
              `whole list, or filter by a lead status instead.`,
            lifecycle,
            enrolled: false,
          });
        }
      } else {
        leads = await crmDb.getAllLeadsByListId(listId);
      }

      // Filtered HERE, before coverage — not at the mapper. leadEmail feeds
      // sendAsSender({ to }) in dripSequenceWorker, which RETHROWS on failure, so an
      // email-less lead does not fail once: the enrollment retries forever. leadEmail is
      // also the leadEmail-index partition key, so the row is invisible to
      // getActiveEnrollment and is re-created on every run. crm.ts's identical mapper has
      // always filtered.
      //
      // Filtering up front rather than at the mapper keeps one population throughout:
      // leadCount, the missing/present warning counts and the confirm gate all describe
      // exactly the leads that will be enrolled. Filtering later made the dialog report a
      // different set than the one it enrolled — and could raise needsConfirmation over
      // variables missing only on leads that were never candidates.
      //
      // Email-less leads were already reachable (LinkedIn imports, the invite mirror);
      // ENG-2082 made a whole new list type produce them.
      // Both counts, deliberately. Filtering silently would shrink leadCount from 100 to 20
      // with nothing on screen to explain where 80 went — the dialog would look like leads
      // had vanished. Reporting the population AND the enrollable subset lets the caller say
      // "20 of 100 leads can be emailed", which is the true statement.
      const totalLeads = leads.length;
      // Channel-aware: the first version tested `l.email` only, which excluded a
      // LinkedIn-only lead from a LinkedIn sequence the worker could actually deliver.
      const channels = requiredChannels(sequence);
      leads = leads.filter((l: any) => leadIsReachable(l, channels));
      const enrollableLeads = leads.length;

      // Variable coverage across all steps + channels (email subject/body + LinkedIn
      // messageText). Warn — but allow override via `confirm` — when a supported
      // variable is missing for any lead, or an unsupported token is referenced.
      const templateText = sequence.steps
        .map((s: any) => `${s.subject ?? ''} ${s.bodyHtml ?? ''} ${s.messageText ?? ''}`)
        .join(' ');
      const vars = extractVariables(templateText)
        .filter((v) => v !== 'senderName' && v !== 'senderEmail');
      const unsupported = vars.filter((v) => !isSupportedVariable(v));
      const supported = vars.filter((v) => isSupportedVariable(v));
      const missing: { variable: string; missing: number; present: number }[] = [];
      for (const v of supported) {
        let miss = 0;
        let pres = 0;
        for (const lead of leads) {
          if (leadHasVariable(lead, v)) pres++;
          else miss++;
        }
        if (miss > 0) missing.push({ variable: v, missing: miss, present: pres });
      }

      if ((unsupported.length > 0 || missing.length > 0) && !confirm) {
        return res.json({
          enrolled: false,
          needsConfirmation: true,
          leadCount: leads.length,
          totalLeads,
          enrollableLeads,
          ...(totalLeads > enrollableLeads ? { skippedNoEmail: totalLeads - enrollableLeads } : {}),
          warnings: { unsupported, missing },
        });
      }

      const inputs = leads
        .map((l: any) => ({
          sequenceId: req.params.sequenceId,
          userId: authReq.user!.userId,
          listId,
          leadId: l.leadId,
          leadEmail: enrollmentIdentity(l),
          startAt: startAt ?? undefined,
        }));

      const result = await dripSequenceDb.bulkEnroll(inputs);
      const counts = {
        totalLeads,
        enrollableLeads,
        ...(totalLeads > enrollableLeads ? { skippedNoEmail: totalLeads - enrollableLeads } : {}),
      };

      // Auto-enroll is on by default: add listId to sequence's autoEnrollListIds
      // unless it's already there. This means new leads added to this list later
      // will be automatically enrolled.
      const existing = sequence.autoEnrollListIds ?? [];
      if (!existing.includes(listId)) {
        void dripSequenceDb.updateSequence(req.params.sequenceId, authReq.user!.userId, {
          autoEnrollListIds: [...existing, listId],
        }).catch((e) => console.error('[sequences] autoEnrollListIds update error:', e));
      }

      res.json({ ...result, ...counts });
    } catch (err: any) {
      if (err instanceof SequenceNotFoundError) return res.status(404).json({ error: err.message });
      if (err instanceof SequenceAuthError) return res.status(403).json({ error: err.message });
      console.error('[sequences] enrollByList error:', err);
      res.status(500).json({ error: 'Failed to enroll leads from list' });
    }
  },
);

// DELETE /api/crm/sequences/:sequenceId/enrollments/:enrollmentId — manual exit
router.delete(
  '/:sequenceId/enrollments/:enrollmentId',
  authenticateToken,
  async (req: Request, res: Response) => {
    const authReq = req as AuthenticatedRequest;
    try {
      const sequence = await dripSequenceDb.getSequence(req.params.sequenceId);
      if (!sequence) return res.status(404).json({ error: 'Sequence not found' });
      if (sequence.userId !== authReq.user!.userId) return res.status(403).json({ error: 'Forbidden' });

      await dripSequenceDb.exitEnrollment(req.params.enrollmentId, 'manual');
      res.json({ success: true });
    } catch (err) {
      console.error('[sequences] exitEnrollment error:', err);
      res.status(500).json({ error: 'Failed to exit enrollment' });
    }
  },
);

// ─── Step Utilities ───────────────────────────────────────────────────────────

/**
 * @route POST /api/crm/sequences/:sequenceId/steps/test-email
 * @desc Send a test email for a specific step's content
 */
router.post(
  '/:sequenceId/steps/test-email',
  authenticateToken,
  async (req: Request, res: Response) => {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    const { senderId, senderEmail, senderName, subject, htmlContent, recipients } = req.body;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    if (!senderEmail || !senderName || !subject || !htmlContent) {
      return res.status(400).json({ message: 'senderEmail, senderName, subject, and htmlContent are required' });
    }

    if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
      return res.status(400).json({ message: 'At least one recipient email is required' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const validEmails = recipients.filter((e: string) => emailRegex.test(e.trim()));

    if (validEmails.length === 0) {
      return res.status(400).json({ message: 'No valid email addresses provided' });
    }

    const CUSTOMER_FRONTEND_URL = process.env.CUSTOMER_FRONTEND_URL || 'https://app.agentweb.pro';
    const testUnsubscribeUrl = `${CUSTOMER_FRONTEND_URL}/crm-unsubscribe?listId=TEST&leadId=TEST&email=${encodeURIComponent(recipients[0]?.trim() || 'test@example.com')}`;

    const testBanner = `<div style="background-color: #ff9800; color: white; padding: 10px; text-align: center; font-weight: bold; margin-bottom: 20px;">TEST EMAIL - This is a test sequence step email</div>`;

    // Inject banner: inside <body> for full HTML documents, or prepend for fragments
    const withBanner = /<body\b/i.test(htmlContent)
      ? htmlContent.replace(/<body([^>]*)>/i, `<body$1>${testBanner}`)
      : testBanner + htmlContent;
    // Rewrite S3 image URLs through the asset proxy (same as production send path).
    // Use EMAIL_ASSET_BASE_URL so URLs in emails are publicly accessible even when
    // the test send originates from a dev environment with a private BACKEND_URL.
    const assetBaseUrl = process.env.EMAIL_ASSET_BASE_URL || 'https://api.agentweb.pro';
    const withRewrittenImages = rewriteS3ImageUrls(withBanner, assetBaseUrl);
    const withNormalizedUrls = normalizeYoutubeUrls(withRewrittenImages);
    // Wire up unsubscribe URL with the real portal domain
    const testHtml = injectUnsubscribeUrl(withNormalizedUrls, testUnsubscribeUrl);

    // ENG-266 Part 3: route through the sender's real provider (same fallback pattern
    // as the crm.ts send sites).
    const resolvedSender = await resolveSenderForSend(userId, senderId, senderEmail);
    const sender: CrmSender = resolvedSender ?? {
      id: '__adhoc__',
      email: senderEmail,
      fromName: senderName,
      senderProvider: 'resend',
    };

    let sent = 0;
    let failedCount = 0;
    const failedEmails: string[] = [];
    const failureReasons: Array<{ email: string; reason: string }> = [];

    for (const email of validEmails) {
      try {
        await sendAsSender(userId, sender, {
          to: email.trim(),
          subject: `[TEST] ${subject}`,
          html: testHtml,
        });
        sent++;
      } catch (err: any) {
        const reason = err.message || String(err);
        console.error(`[sequences] Failed to send test email to ${email}:`, reason);
        failedCount++;
        failedEmails.push(email);
        failureReasons.push({ email, reason });
      }
    }

    return res.json({
      total: validEmails.length,
      sent,
      failed: failedCount,
      failedEmails,
      failureReasons,
    });
  },
);

/**
 * @route POST /api/crm/sequences/:sequenceId/steps/spam-check
 * @desc Use Claude to analyse the email for spam/deliverability issues
 */
router.post(
  '/:sequenceId/steps/spam-check',
  authenticateToken,
  async (req: Request, res: Response) => {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    const { subject, htmlContent, senderEmail } = req.body;

    if (!userId) return res.status(401).json({ message: 'Unauthorized' });
    if (!subject || !htmlContent) return res.status(400).json({ message: 'subject and htmlContent are required' });

    try {
      const llm = new LLMService('anthropic.claude-sonnet-4-6', 0, 2000);
      const systemPrompt = `You are an email deliverability expert. Analyse the provided marketing email for spam and deliverability issues.

Return a JSON object with this exact shape:
{
  "passed": boolean,
  "issues": [
    {
      "severity": "error or warning",
      "code": "SNAKE_CASE_CODE",
      "message": "One-sentence description of the issue and why it matters."
    }
  ]
}

Severity rules:
- "error": will definitely cause spam filtering (broken/missing unsubscribe link, deceptive content, URL mismatch)
- "warning": reduces deliverability score (spam trigger words, missing physical address, external font loading, HTML-only with no text alternative, suspicious sender domain)

IMPORTANT — template variables: This is a drip sequence template. Placeholders like {{unsubscribeUrl}}, {{firstName}}, {{email}}, {{companyName}} are intentional template variables that will be replaced with real values at send time. Do NOT flag these as broken links or missing content.

IMPORTANT — image hosting: Images hosted on api.agentweb.pro/asset/ are served through our own domain proxy and are fine. Flag images whose src domain does not match the sending domain AND is not api.agentweb.pro (e.g. raw S3 URLs, external CDNs).

Be precise. Only report genuine issues. If the email looks clean, return an empty issues array.`;

      const userPrompt = `Sender email: ${senderEmail ?? 'not provided'}\nSubject: ${subject}\n\nHTML:\n${htmlContent}`;

      const parsed = await llm.generateJsonRobust<{ passed: boolean; issues: any[] }>(systemPrompt, userPrompt, undefined, {
        userId,
        feature: 'content_gen',
      });
      const issues = Array.isArray(parsed.issues) ? parsed.issues : [];
      const errors = issues.filter((i: any) => i.severity === 'error');
      return res.json({
        passed: errors.length === 0,
        issues,
        errorCount: errors.length,
        warningCount: issues.length - errors.length,
      });
    } catch (err: any) {
      console.error('[spam-check] LLM error:', err.message || err);
      return res.status(500).json({ message: 'Spam check failed' });
    }
  },
);

/**
 * @route POST /api/crm/sequences/:sequenceId/steps/spam-repair
 * @desc Use Claude to fix all spam/deliverability issues in the email.
 *
 * Body:
 *   subject      — current subject line
 *   htmlContent  — current email HTML
 *   issues       — the issues array returned by spam-check
 *   context      — optional free-text user context (e.g. "company is Acme Corp, address is 123 Main St")
 */
router.post(
  '/:sequenceId/steps/spam-repair',
  authenticateToken,
  async (req: Request, res: Response) => {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    const { subject, htmlContent, issues, context = '' } = req.body as {
      subject: string;
      htmlContent: string;
      issues: Array<{ severity: string; code: string; message: string }>;
      context?: string;
    };

    if (!userId) return res.status(401).json({ message: 'Unauthorized' });
    if (!htmlContent || !Array.isArray(issues) || issues.length === 0) {
      return res.status(400).json({ message: 'htmlContent and issues[] are required' });
    }

    try {
      const llm = new LLMService('anthropic.claude-sonnet-4-6', 0, 16000);
      const issueList = issues.map(i => `- [${i.severity.toUpperCase()}] ${i.code}: ${i.message}`).join('\n');
      const contextSection = context.trim() ? `\nUser-provided context:\n${context.trim()}\n` : '';

      const systemPrompt = `You are an expert email developer fixing spam and deliverability issues in a marketing email.

Fix EVERY issue listed below. Rules:
1. For unsubscribe links: use {{unsubscribeUrl}} as the href — do NOT invent a URL. If there is no unsubscribe link at all, add a simple unsubscribe footer before </body>.
2. For external font loading (Google Fonts <link> tags, @import url()): remove them entirely from the HTML.
3. For missing physical address: add it to the footer using the user-provided context. If no address is given in context, add a placeholder "[Company Name, Street Address, City, State ZIP]" styled as small grey text.
4. For spam trigger words in the subject: rewrite the subject to communicate the same intent without the triggering words.
5. Preserve the email's visual design, brand, and all content exactly — only make the targeted fixes.

Return your response in this exact format:
<subject>updated subject line here</subject>
<html_content>complete fixed HTML here</html_content>`;

      const userPrompt = `Issues to fix:\n${issueList}\n${contextSection}\nSubject: ${subject}\n\nHTML:\n${htmlContent}`;

      const rawText = await llm.generateRaw(systemPrompt, userPrompt, undefined, {
        userId,
        feature: 'content_gen',
      });

      const htmlMatch = rawText.match(/<html_content>([\s\S]*?)<\/html_content>/i);
      const subjectMatch = rawText.match(/<subject>([\s\S]*?)<\/subject>/i);

      if (!htmlMatch) {
        console.error('[spam-repair] LLM did not return expected tags. Raw:', rawText.slice(0, 500));
        return res.status(500).json({ message: 'Repair failed: model did not return expected format' });
      }

      return res.json({
        subject: subjectMatch ? subjectMatch[1].trim() : subject,
        htmlContent: htmlMatch[1].trim(),
      });
    } catch (err: any) {
      console.error('[spam-repair] LLM error:', err.message || err);
      return res.status(500).json({ message: 'Repair failed' });
    }
  },
);

/**
 * @route POST /api/crm/sequences/:sequenceId/steps/verify-variables
 * @desc Verify template variables in subject+html are covered by leads in enrolled lists
 */
router.post(
  '/:sequenceId/steps/verify-variables',
  authenticateToken,
  async (req: Request, res: Response) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const userId = authReq.user?.userId;
      const { subject, htmlContent, listId } = req.body;

      if (!userId) {
        return res.status(401).json({ message: 'Unauthorized' });
      }

      const allTemplate = (subject || '') + (htmlContent || '');
      const variables = extractVariables(allTemplate);

      let leads: any[] = [];
      let verifyTotalLeads = 0;
      if (listId) {
        const leadsResult = await crmDb.getLeadsByListId(listId);
        leads = Array.isArray(leadsResult)
          ? leadsResult
          : ((leadsResult as any).items ?? (leadsResult as any).leads ?? []);
        // Same population the enrol routes use. Without this, this screen reported variable
        // coverage over leads enrol-by-list will never enrol — two screens, same list,
        // contradictory numbers, and coverage warnings raised over rows that were never
        // candidates. ENG-2082 made address-less leads common enough to diverge visibly.
        verifyTotalLeads = leads.length;
        // Mirrors the enrol routes exactly — including their channel awareness, or this
        // screen reports coverage over a different population again.
        const verifyChannels = requiredChannels(
          req.params.sequenceId && req.params.sequenceId !== 'test'
            ? await dripSequenceDb.getSequence(req.params.sequenceId).catch(() => null)
            : null,
        );
        leads = leads.filter((l: any) => leadIsReachable(l, verifyChannels));
      } else if (req.params.sequenceId && req.params.sequenceId !== 'test') {
        // Verify against the sequence's enrolled leads
        const enrollments = await dripSequenceDb.listEnrollmentsForSequence(req.params.sequenceId);
        const leadFetches = enrollments.map((e) =>
          crmDb.getLeadById(e.listId, e.leadId).catch(() => null),
        );
        leads = (await Promise.all(leadFetches)).filter(Boolean);
      }

      const variableCoverage: Record<string, { present: number; missing: number }> = {};
      for (const v of variables) {
        variableCoverage[v] = { present: 0, missing: 0 };
      }

      for (const lead of leads) {
        for (const v of variables) {
          if (leadHasVariable(lead, v)) {
            variableCoverage[v].present++;
          } else {
            variableCoverage[v].missing++;
          }
        }
      }

      return res.json({
        variables,
        variableCoverage,
        leadCount: leads.length,
        ...(verifyTotalLeads > leads.length
          ? { totalLeads: verifyTotalLeads, skippedNoEmail: verifyTotalLeads - leads.length }
          : {}),
      });
    } catch (error) {
      console.error('[sequences] verify-variables error:', error);
      return res.status(500).json({ message: 'Failed to verify variables' });
    }
  },
);

/**
 * @route POST /api/crm/sequences/load-from-url
 * @desc Load HTML content from a URL for use in sequence step editing
 */
router.post('/load-from-url', authenticateToken, async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    const { url } = req.body;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    if (!url || typeof url !== 'string') {
      return res.status(400).json({ message: 'URL is required and must be a string' });
    }

    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      return res.status(400).json({ message: 'Invalid URL format. Must be HTTP or HTTPS.' });
    }

    const response = await axios.get(url, {
      timeout: 15000,
      responseType: 'text',
      headers: { 'User-Agent': 'AgentWeb-Backend/1.0' },
    });

    const html = response.data as string;

    // Extract title
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    let extractedTitle = titleMatch ? titleMatch[1].trim() : '';
    if (!extractedTitle) {
      const h1Match = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
      extractedTitle = h1Match ? h1Match[1].trim() : 'Newsletter';
    }
    extractedTitle = extractedTitle
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'");

    let bodyContent = '';

    // If this is a complete HTML email document, preserve it as-is (only strip scripts).
    // Stripping <style> or collapsing whitespace destroys email formatting.
    const isFullHtmlDocument = /<html[\s>]/i.test(html);
    if (isFullHtmlDocument) {
      bodyContent = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '');
    } else {
      // For plain HTML fragments, extract body content and clean up
      const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
      bodyContent = bodyMatch ? bodyMatch[1] : html;

      bodyContent = bodyContent
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '');

      // Try to extract main content from semantic tags
      const mainContentSelectors = [
        /<main[^>]*>([\s\S]*?)<\/main>/i,
        /<article[^>]*>([\s\S]*?)<\/article>/i,
        /<div[^>]*class="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
      ];
      for (const selector of mainContentSelectors) {
        const match = bodyContent.match(selector);
        if (match && match[1].trim().length > 50) {
          bodyContent = match[1];
          break;
        }
      }

      bodyContent = bodyContent
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/\s+/g, ' ')
        .replace(/>\s+</g, '><')
        .trim();
    }

    if (bodyContent.length > 200000) {
      bodyContent = bodyContent.substring(0, 200000);
    }

    // Convert class-based CSS to inline styles now so the stored HTML is email-client-safe.
    // Doing this at import time avoids the LLM call at every test-send or real send.
    // ENG-1961: the inlining LLM call is this user's import, not "system".
    const { html: inlinedContent } = await inlineEmailStyles(bodyContent, { userId });

    return res.json({
      success: true,
      title: extractedTitle,
      message: inlinedContent,
    });
  } catch (error: any) {
    console.error('[sequences] load-from-url error:', error.message || error);
    return res.status(500).json({ message: 'Failed to load content from URL' });
  }
});

export default router;
