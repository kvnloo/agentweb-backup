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
import { resendService } from '../services/resendService';
import axios from 'axios';
import { extractVariables, leadHasVariable } from '../utils/emailVariables';

const router = express.Router();

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
  const { name, description, campaignType, enrollmentTrigger, exitConditions, steps, status } = req.body;
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
  const { name, description, campaignType, enrollmentTrigger, exitConditions, steps, status } = req.body;
  try {
    const input: UpdateSequenceInput = {
      name,
      description,
      campaignType,
      enrollmentTrigger,
      exitConditions,
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

      const inputs = leads.map((l: any) => ({
        sequenceId: req.params.sequenceId,
        userId: authReq.user!.userId,
        listId: l.listId,
        leadId: l.leadId,
        leadEmail: l.leadEmail,
        startAt: startAt ?? undefined,
      }));

      const result = await dripSequenceDb.bulkEnroll(inputs);
      res.json(result);
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
    const { listId, lifecycle, startAt } = req.body;
    if (!listId) return res.status(400).json({ error: 'listId is required' });

    try {
      const sequence = await dripSequenceDb.getSequence(req.params.sequenceId);
      if (!sequence) return res.status(404).json({ error: 'Sequence not found' });
      if (sequence.userId !== authReq.user!.userId) return res.status(403).json({ error: 'Forbidden' });
      if (sequence.steps.length === 0) {
        return res.status(400).json({ error: 'Sequence has no steps' });
      }

      const leadsResult = lifecycle
        ? await crmDb.getLeadsByStatus(listId, lifecycle)
        : await crmDb.getLeadsByListId(listId);
      const leads = Array.isArray(leadsResult)
        ? leadsResult
        : ((leadsResult as any).items ?? (leadsResult as any).leads ?? []);

      const inputs = leads.map((l: any) => ({
        sequenceId: req.params.sequenceId,
        userId: authReq.user!.userId,
        listId,
        leadId: l.leadId,
        leadEmail: l.email,
        startAt: startAt ?? undefined,
      }));

      const result = await dripSequenceDb.bulkEnroll(inputs);
      res.json(result);
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
    const { senderEmail, senderName, subject, htmlContent, recipients } = req.body;

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

    const testBanner = `<div style="background-color: #ff9800; color: white; padding: 10px; text-align: center; font-weight: bold; margin-bottom: 20px;">TEST EMAIL - This is a test sequence step email</div>`;
    const testHtml = testBanner + htmlContent;
    const from = `${senderName} <${senderEmail}>`;

    let sent = 0;
    let failedCount = 0;
    const failedEmails: string[] = [];

    for (const email of validEmails) {
      try {
        const result = await resendService.sendEmail({
          from,
          to: email.trim(),
          subject: `[TEST] ${subject}`,
          html: testHtml,
        });

        if (result && result.id) {
          sent++;
        } else {
          failedCount++;
          failedEmails.push(email);
        }
      } catch (err: any) {
        console.error(`[sequences] Failed to send test email to ${email}:`, err.message || err);
        failedCount++;
        failedEmails.push(email);
      }
    }

    return res.json({
      total: validEmails.length,
      sent,
      failed: failedCount,
      failedEmails,
    });
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
      if (listId) {
        const leadsResult = await crmDb.getLeadsByListId(listId);
        leads = Array.isArray(leadsResult)
          ? leadsResult
          : ((leadsResult as any).items ?? (leadsResult as any).leads ?? []);
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

    return res.json({
      success: true,
      title: extractedTitle,
      message: bodyContent,
    });
  } catch (error: any) {
    console.error('[sequences] load-from-url error:', error.message || error);
    return res.status(500).json({ message: 'Failed to load content from URL' });
  }
});

export default router;
