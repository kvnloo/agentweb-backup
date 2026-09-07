/**
 * ENG-1723 — the real dependencies for `autoCreateOutreachSchedule`.
 *
 * Kept separate from the decision module so that module stays free of I/O and
 * environment reads and can be tested exhaustively without mocking DynamoDB,
 * the subscription service, or the connected-accounts store.
 */

import {
  autoCreateOutreachSchedule,
  type AutoCreateResult,
} from './outreachScheduleAutoCreate';

export async function runOutreachScheduleAutoCreate(params: {
  userId: string;
  leadListId?: string | null;
  icpDescription?: string | null;
  dryRun?: boolean;
}): Promise<AutoCreateResult> {
  const [
    { getAccountsByUserId },
    { isSubscriptionFeatureEnabled, getAllowedConnectedAccounts, SUBSCRIPTION_FEATURES },
    { scheduleDb, scheduleTemplateDb },
    { LINKEDIN_OUTREACH_TEMPLATE_NAME },
  ] = await Promise.all([
    import('../connectedAccountsDb'),
    import('../subscriptionService'),
    import('../db'),
    import('../../scripts/seed-eng1609-linkedin-outreach-template'),
  ]);

  return autoCreateOutreachSchedule({
    userId: params.userId,
    leadListId: params.leadListId,
    icpDescription: params.icpDescription,
    dryRun: params.dryRun,
    deps: {
      // The customer's OWN accounts. An org-shared account belongs to someone
      // else, and auto-enrolling a colleague's LinkedIn into unattended outreach
      // is exactly the consent this feature must not assume.
      listOwnUnipileAccountIds: async (userId) =>
        ((await getAccountsByUserId(userId)) || [])
          .filter((a: any) => a?.platform === 'unipile')
          .map((a: any) => a.account_id)
          .filter(Boolean),
      scheduledChatsEnabled: (userId) =>
        isSubscriptionFeatureEnabled(userId, SUBSCRIPTION_FEATURES.SCHEDULED_CHATS),
      allowedConnectedAccounts: (userId) => getAllowedConnectedAccounts(userId),
      findTemplate: async () => {
        const systemTemplates = (await scheduleTemplateDb.getTemplatesByVisibility('system')) || [];
        const match = (systemTemplates as any[]).find((t) => t?.name === LINKEDIN_OUTREACH_TEMPLATE_NAME);
        return match ? (match as any) : null;
      },
      findExistingSchedule: async (userId, templateId) => {
        const schedules = (await scheduleDb.getSchedulesByUserId(userId)) || [];
        const match = (schedules as any[]).find((s) => s?.autoCreatedFromTemplateId === templateId);
        return match ? String(match.scheduleId) : null;
      },
      createSchedule: (schedule) => scheduleDb.createSchedule(schedule as any),
      countTemplateUse: (templateId) => scheduleTemplateDb.incrementUsageCount(templateId),
    },
  });
}
