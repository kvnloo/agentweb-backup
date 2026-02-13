import express, { Request, Response } from 'express';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { dripCampaignDb, crmDb, userDb } from '../services/db';
import { emailEventsDb } from '../services/emailEventsDb';
import { v4 as uuidv4 } from 'uuid';

const router = express.Router();

// Apply authentication middleware to all routes
router.use(authenticateToken);

// Create a new drip campaign
router.post('/campaigns', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const { listId, name, description, emails, stopConditions } = req.body;

    // Validate required fields
    if (!listId || !name || !emails || emails.length === 0) {
      return res.status(400).json({
        error: 'Missing required fields: listId, name, and at least one email step'
      });
    }

    // Validate list exists and belongs to user
    const list = await crmDb.getLeadListById(listId);
    if (!list) {
      return res.status(404).json({ error: 'Lead list not found' });
    }
    if (list.userId !== userId) {
      return res.status(403).json({ error: 'Access denied to this lead list' });
    }

    // Validate email steps
    for (let i = 0; i < emails.length; i++) {
      const email = emails[i];
      if (!email.subject || !email.aiPrompt) {
        return res.status(400).json({
          error: `Email step ${i + 1} missing required fields: subject and aiPrompt`
        });
      }
      if (!email.stepId) {
        email.stepId = uuidv4();
      }
      if (!email.stepNumber) {
        email.stepNumber = i + 1;
      }
      if (email.timingType === 'relative' && email.delayDays === undefined && email.delayHours === undefined) {
        return res.status(400).json({
          error: `Email step ${i + 1} with relative timing must have delayDays or delayHours`
        });
      }
      if (email.timingType === 'absolute' && !email.sendDate) {
        return res.status(400).json({
          error: `Email step ${i + 1} with absolute timing must have sendDate`
        });
      }
    }

    const campaignId = uuidv4();
    const campaign = await dripCampaignDb.createCampaign({
      campaignId,
      userId,
      listId,
      name,
      description,
      status: 'draft',
      emails,
      stopConditions: stopConditions || {
        stopOnReply: false,
        stopOnUnsubscribe: true,
        stopOnBounce: true,
      },
    });

    res.json(campaign);
  } catch (error) {
    console.error('Error creating drip campaign:', error);
    res.status(500).json({ error: 'Failed to create drip campaign' });
  }
});

// Get all campaigns for a user
router.get('/campaigns', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const campaigns = await dripCampaignDb.listCampaignsByUserId(userId);
    res.json(campaigns);
  } catch (error) {
    console.error('Error fetching drip campaigns:', error);
    res.status(500).json({ error: 'Failed to fetch drip campaigns' });
  }
});

// Get a specific campaign
router.get('/campaigns/:campaignId', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const { campaignId } = req.params;

    const campaign = await dripCampaignDb.getCampaign(campaignId);
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    if (campaign.userId !== userId) {
      return res.status(403).json({ error: 'Access denied to this campaign' });
    }

    res.json(campaign);
  } catch (error) {
    console.error('Error fetching drip campaign:', error);
    res.status(500).json({ error: 'Failed to fetch drip campaign' });
  }
});

// Update a campaign
router.put('/campaigns/:campaignId', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const { campaignId } = req.params;
    const updates = req.body;

    // Check campaign exists and belongs to user
    const campaign = await dripCampaignDb.getCampaign(campaignId);
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    if (campaign.userId !== userId) {
      return res.status(403).json({ error: 'Access denied to this campaign' });
    }

    // Don't allow updating userId, campaignId, or createdAt
    delete updates.userId;
    delete updates.campaignId;
    delete updates.createdAt;

    const updatedCampaign = await dripCampaignDb.updateCampaign(campaignId, updates);
    res.json(updatedCampaign);
  } catch (error) {
    console.error('Error updating drip campaign:', error);
    res.status(500).json({ error: 'Failed to update drip campaign' });
  }
});

// Delete a campaign
router.delete('/campaigns/:campaignId', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const { campaignId } = req.params;

    // Check campaign exists and belongs to user
    const campaign = await dripCampaignDb.getCampaign(campaignId);
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    if (campaign.userId !== userId) {
      return res.status(403).json({ error: 'Access denied to this campaign' });
    }

    // Check for active enrollments
    const enrollments = await dripCampaignDb.listEnrollmentsByCampaign(campaignId);
    const activeEnrollments = enrollments.filter(e => e.status === 'active');

    if (activeEnrollments.length > 0) {
      // Require confirmation to delete campaign with active enrollments
      const { confirm } = req.query;
      if (confirm !== 'true') {
        return res.status(400).json({
          error: `Campaign has ${activeEnrollments.length} active enrollments. Add ?confirm=true to delete anyway.`,
          activeEnrollments: activeEnrollments.length,
          totalEnrollments: enrollments.length
        });
      }
    }

    // Delete all enrollments for this campaign
    for (const enrollment of enrollments) {
      await dripCampaignDb.deleteEnrollment(enrollment.enrollmentId);
    }

    await dripCampaignDb.deleteCampaign(campaignId);
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting drip campaign:', error);
    res.status(500).json({ error: 'Failed to delete drip campaign' });
  }
});

// Activate a campaign (starts enrolling leads)
router.post('/campaigns/:campaignId/activate', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const { campaignId } = req.params;

    const campaign = await dripCampaignDb.getCampaign(campaignId);
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    if (campaign.userId !== userId) {
      return res.status(403).json({ error: 'Access denied to this campaign' });
    }

    // Validate campaign has at least one email
    if (!campaign.emails || campaign.emails.length === 0) {
      return res.status(400).json({ error: 'Campaign must have at least one email step' });
    }

    // Validate email step timing
    for (const email of campaign.emails) {
      if (!email.timingType) {
        return res.status(400).json({
          error: `Email step ${email.stepNumber} must have a timing type (relative or absolute)`
        });
      }
      if (email.timingType === 'relative') {
        if ((email.delayDays === undefined || email.delayDays < 0) &&
            (email.delayHours === undefined || email.delayHours < 0)) {
          return res.status(400).json({
            error: `Email step ${email.stepNumber} with relative timing must have non-negative delayDays or delayHours`
          });
        }
      } else if (email.timingType === 'absolute') {
        if (!email.sendDate) {
          return res.status(400).json({
            error: `Email step ${email.stepNumber} with absolute timing must have a sendDate`
          });
        }
      }
    }

    // Get user and validate email configuration
    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    if (!user.emailDomain) {
      return res.status(400).json({
        error: 'Email domain not configured. Please configure your email domain in settings before activating campaigns.'
      });
    }

    // Get leads from the list
    const list = await crmDb.getLeadListById(campaign.listId);
    if (!list) {
      return res.status(404).json({ error: 'Lead list not found' });
    }

    const leadsResult = await crmDb.getLeadsByListId(campaign.listId, 1000);
    const leads = leadsResult.items;

    // Validate list is not empty
    if (leads.length === 0) {
      return res.status(400).json({
        error: 'Lead list is empty. Add leads to the list before activating the campaign.'
      });
    }

    // Create enrollments for each lead
    let enrolledCount = 0;
    for (const lead of leads) {
      // Skip if lead is already enrolled in this campaign
      const existingEnrollments = await dripCampaignDb.listEnrollmentsByCampaign(campaignId);
      const alreadyEnrolled = existingEnrollments.some(e => e.leadId === lead.leadId);
      if (alreadyEnrolled) {
        continue;
      }

      // Calculate next send time based on first email's timing
      const firstEmail = campaign.emails[0];
      let nextSendTime: string | undefined;

      if (firstEmail.timingType === 'relative') {
        const delayMs = (firstEmail.delayDays || 0) * 24 * 60 * 60 * 1000 +
                       (firstEmail.delayHours || 0) * 60 * 60 * 1000;
        nextSendTime = new Date(Date.now() + delayMs).toISOString();
      } else if (firstEmail.timingType === 'absolute') {
        nextSendTime = firstEmail.sendDate;
      } else {
        // If no timing specified, send immediately
        nextSendTime = new Date().toISOString();
      }

      await dripCampaignDb.createEnrollment({
        enrollmentId: uuidv4(),
        campaignId,
        leadId: lead.leadId,
        listId: campaign.listId,
        userId,
        status: 'active',
        currentStep: 0,
        nextSendTime,
      });

      enrolledCount++;
    }

    // Update campaign status to active
    const updatedCampaign = await dripCampaignDb.updateCampaign(campaignId, {
      status: 'active',
      stats: {
        ...campaign.stats,
        totalEnrolled: (campaign.stats?.totalEnrolled || 0) + enrolledCount,
        active: (campaign.stats?.active || 0) + enrolledCount,
      }
    });

    res.json({
      success: true,
      campaign: updatedCampaign,
      enrolledCount
    });
  } catch (error) {
    console.error('Error activating drip campaign:', error);
    res.status(500).json({ error: 'Failed to activate drip campaign' });
  }
});

// Pause a campaign
router.post('/campaigns/:campaignId/pause', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const { campaignId } = req.params;

    const campaign = await dripCampaignDb.getCampaign(campaignId);
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    if (campaign.userId !== userId) {
      return res.status(403).json({ error: 'Access denied to this campaign' });
    }

    const updatedCampaign = await dripCampaignDb.updateCampaign(campaignId, { status: 'paused' });
    res.json(updatedCampaign);
  } catch (error) {
    console.error('Error pausing drip campaign:', error);
    res.status(500).json({ error: 'Failed to pause drip campaign' });
  }
});

// Get enrollments for a campaign
router.get('/campaigns/:campaignId/enrollments', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const { campaignId } = req.params;
    const { status } = req.query;

    const campaign = await dripCampaignDb.getCampaign(campaignId);
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    if (campaign.userId !== userId) {
      return res.status(403).json({ error: 'Access denied to this campaign' });
    }

    const enrollments = await dripCampaignDb.listEnrollmentsByCampaign(
      campaignId,
      status as string | undefined
    );

    // Enrich with lead data
    const enrichedEnrollments = await Promise.all(
      enrollments.map(async (enrollment) => {
        const lead = await crmDb.getLeadById(enrollment.listId, enrollment.leadId);
        return {
          ...enrollment,
          lead: lead ? {
            email: lead.email,
            firstName: lead.firstName,
            lastName: lead.lastName,
            company: lead.company,
          } : null
        };
      })
    );

    res.json(enrichedEnrollments);
  } catch (error) {
    console.error('Error fetching campaign enrollments:', error);
    res.status(500).json({ error: 'Failed to fetch campaign enrollments' });
  }
});

// Stop an enrollment
router.post('/enrollments/:enrollmentId/stop', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const { enrollmentId } = req.params;
    const { reason } = req.body;

    const enrollment = await dripCampaignDb.getEnrollment(enrollmentId);
    if (!enrollment) {
      return res.status(404).json({ error: 'Enrollment not found' });
    }
    if (enrollment.userId !== userId) {
      return res.status(403).json({ error: 'Access denied to this enrollment' });
    }

    const updatedEnrollment = await dripCampaignDb.updateEnrollment(enrollmentId, {
      status: 'stopped',
      stoppedAt: new Date().toISOString(),
      stoppedReason: reason || 'manual',
    });

    // Update campaign stats
    const campaign = await dripCampaignDb.getCampaign(enrollment.campaignId);
    if (campaign) {
      await dripCampaignDb.updateCampaign(enrollment.campaignId, {
        stats: {
          ...campaign.stats,
          active: Math.max(0, (campaign.stats?.active || 0) - 1),
          stopped: (campaign.stats?.stopped || 0) + 1,
        }
      });
    }

    res.json(updatedEnrollment);
  } catch (error) {
    console.error('Error stopping enrollment:', error);
    res.status(500).json({ error: 'Failed to stop enrollment' });
  }
});

// Get analytics for a campaign
router.get('/campaigns/:campaignId/analytics', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const { campaignId } = req.params;

    const campaign = await dripCampaignDb.getCampaign(campaignId);
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    if (campaign.userId !== userId) {
      return res.status(403).json({ error: 'Access denied to this campaign' });
    }

    // Get all enrollments for breakdown
    const enrollments = await dripCampaignDb.listEnrollmentsByCampaign(campaignId);

    // Get email events for this campaign (query CRM email events by metadata)
    const emailEvents = await crmDb.getEmailEventsByCampaign(campaignId);

    // Calculate per-step metrics
    const emailSteps = campaign.emails.map((email: any) => {
      const stepEvents = emailEvents.filter((e: any) =>
        e.metadata?.stepNumber === email.stepNumber
      );

      const sent = stepEvents.filter((e: any) => e.eventType === 'sent').length;
      const delivered = stepEvents.filter((e: any) => e.eventType === 'delivered').length;
      const opened = stepEvents.filter((e: any) => e.eventType === 'opened').length;
      const clicked = stepEvents.filter((e: any) => e.eventType === 'clicked').length;
      const bounced = stepEvents.filter((e: any) => e.eventType === 'bounced').length;
      const replied = stepEvents.filter((e: any) => e.eventType === 'replied').length;

      return {
        stepNumber: email.stepNumber,
        subject: email.subject,
        sent,
        delivered,
        opened,
        clicked,
        bounced,
        replied,
        openRate: delivered > 0 ? (opened / delivered * 100).toFixed(1) : '0',
        clickRate: delivered > 0 ? (clicked / delivered * 100).toFixed(1) : '0',
        bounceRate: sent > 0 ? (bounced / sent * 100).toFixed(1) : '0',
      };
    });

    // Get recent activity (recent enrollments)
    const recentActivity = enrollments
      .sort((a, b) => new Date(b.createdAt || '').getTime() - new Date(a.createdAt || '').getTime())
      .slice(0, 10);

    // Calculate conversion rate (completed / total)
    const conversionRate = campaign.stats?.totalEnrolled > 0
      ? ((campaign.stats?.completed || 0) / campaign.stats.totalEnrolled * 100).toFixed(1)
      : '0';

    res.json({
      campaignId: campaign.campaignId,
      name: campaign.name,
      status: campaign.status,
      stats: campaign.stats || {
        totalEnrolled: 0,
        active: 0,
        completed: 0,
        stopped: 0,
      },
      emailSteps,
      recentActivity,
      conversionRate,
    });
  } catch (error) {
    console.error('Error fetching campaign analytics:', error);
    res.status(500).json({ error: 'Failed to fetch campaign analytics' });
  }
});

// Get email performance for a campaign
router.get('/campaigns/:campaignId/email-performance', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const { campaignId } = req.params;

    const campaign = await dripCampaignDb.getCampaign(campaignId);
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    if (campaign.userId !== userId) {
      return res.status(403).json({ error: 'Access denied to this campaign' });
    }

    // Get email events for this campaign
    const emailEvents = await crmDb.getEmailEventsByCampaign(campaignId);

    // Calculate detailed per-step performance
    const performance = campaign.emails.map((email: any) => {
      const stepEvents = emailEvents.filter((e: any) =>
        e.metadata?.stepNumber === email.stepNumber
      );

      const sent = stepEvents.filter((e: any) => e.eventType === 'sent').length;
      const delivered = stepEvents.filter((e: any) => e.eventType === 'delivered').length;
      const opened = stepEvents.filter((e: any) => e.eventType === 'opened').length;
      const clicked = stepEvents.filter((e: any) => e.eventType === 'clicked').length;
      const bounced = stepEvents.filter((e: any) => e.eventType === 'bounced').length;
      const replied = stepEvents.filter((e: any) => e.eventType === 'replied').length;

      return {
        stepNumber: email.stepNumber,
        subject: email.subject,
        metrics: {
          sent,
          delivered,
          opened,
          clicked,
          bounced,
          replied,
          deliveryRate: sent > 0 ? ((delivered / sent) * 100).toFixed(1) + '%' : '0%',
          openRate: delivered > 0 ? ((opened / delivered) * 100).toFixed(1) + '%' : '0%',
          clickRate: delivered > 0 ? ((clicked / delivered) * 100).toFixed(1) + '%' : '0%',
          bounceRate: sent > 0 ? ((bounced / sent) * 100).toFixed(1) + '%' : '0%',
          replyRate: delivered > 0 ? ((replied / delivered) * 100).toFixed(1) + '%' : '0%',
        },
      };
    });

    res.json(performance);
  } catch (error) {
    console.error('Error fetching email performance:', error);
    res.status(500).json({ error: 'Failed to fetch email performance' });
  }
});

// Get overview analytics for user's all campaigns
router.get('/analytics/overview', async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Get all campaigns for user
    const campaigns = await dripCampaignDb.listCampaignsByUserId(userId);

    // Calculate overall stats
    const totalCampaigns = campaigns.length;
    const activeCampaigns = campaigns.filter((c: any) => c.status === 'active').length;
    const draftCampaigns = campaigns.filter((c: any) => c.status === 'draft').length;
    const pausedCampaigns = campaigns.filter((c: any) => c.status === 'paused').length;

    let totalEnrollments = 0;
    let activeEnrollments = 0;
    let completedEnrollments = 0;
    let stoppedEnrollments = 0;

    for (const campaign of campaigns) {
      if (campaign.stats) {
        totalEnrollments += campaign.stats.totalEnrolled || 0;
        activeEnrollments += campaign.stats.active || 0;
        completedEnrollments += campaign.stats.completed || 0;
        stoppedEnrollments += campaign.stats.stopped || 0;
      }
    }

    // Get emails sent today (across all campaigns)
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayISO = today.toISOString();

    let emailsSentToday = 0;
    for (const campaign of campaigns) {
      const emailEvents = await crmDb.getEmailEventsByCampaign(campaign.campaignId);
      emailsSentToday += emailEvents.filter((e: any) =>
        e.eventType === 'sent' && e.timestamp >= todayISO
      ).length;
    }

    res.json({
      totalCampaigns,
      activeCampaigns,
      draftCampaigns,
      pausedCampaigns,
      totalEnrollments,
      activeEnrollments,
      completedEnrollments,
      stoppedEnrollments,
      emailsSentToday,
    });
  } catch (error) {
    console.error('Error fetching analytics overview:', error);
    res.status(500).json({ error: 'Failed to fetch analytics overview' });
  }
});

export default router;
