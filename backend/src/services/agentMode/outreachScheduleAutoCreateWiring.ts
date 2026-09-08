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
    { LINKEDIN_OUTREACH_TEMPLATE_ID, LINKEDIN_OUTREACH_TEMPLATE_NAME },
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
        // Looked up by the seed's STABLE id rather than by name (ENG-1722 gave the
        // template a fixed `templateId`). A name lookup had to list every system
        // template and would silently stop matching the moment anyone renamed the
        // row — which the update route explicitly allows. The visibility is still
        // checked: this must only ever auto-create from the platform template, not
        // from some private row that happened to take the id.
        const found: any = await scheduleTemplateDb.getTemplateById(LINKEDIN_OUTREACH_TEMPLATE_ID);
        if (!found || found.visibility !== 'system') return null;
        if (found.name !== LINKEDIN_OUTREACH_TEMPLATE_NAME) {
          console.warn(
            `[outreachScheduleAutoCreate] template ${LINKEDIN_OUTREACH_TEMPLATE_ID} is named `
            + `"${found.name}", not "${LINKEDIN_OUTREACH_TEMPLATE_NAME}" — using it anyway, since the id is the identity.`,
          );
        }
        return found;
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
