/**
 * ENG-2782 S1 — production adapters for the Slack-start service.
 *
 * Env:
 *   SLACK_START_LEAD_LIST_ID          CRM list (owned by the AgentWeb account) intakes land in
 *   SLACK_START_TOKEN_SECRET          HMAC secret for intake tokens (falls back to JWT_SECRET)
 *   SLACK_START_ALLOWED_ORIGINS       extra exact CORS origins for third-party embeds
 *   SLACK_START_RATE_IP_PER_HOUR      starts per visitor IP per hour (default 10)
 *   SLACK_START_RATE_DOMAIN_PER_DAY   starts per company domain per day (default 5)
 *   SLACK_START_TURNSTILE_SECRET_KEY / SLACK_START_TURNSTILE_SITE_KEY  (slackStartCaptcha)
 *   SLACK_CONNECT_ENABLED             unchanged; provisioning stays inert while it is off
 */

import { randomUUID } from 'crypto';
import { userDb, crmDb } from '../db';
import { getTierConfig, DEFAULT_PAGES } from '../subscriptionService';
import { claimBrandBuildRun, triggerBrandBuildForUser } from '../onboardingBrandBuildService';
import { provisionOnboardingSlackConnect } from '../slackConnectService';
import { assertPublicHostname } from '../../utils/ssrfGuard';
import { captchaPublicConfig, verifySlackStartCaptcha } from './slackStartCaptcha';
import { createDynamoSlackStartStore } from './slackStartStore';
import type { SlackStartDeps } from './slackStartService';

type Env = Record<string, string | undefined>;

/**
 * Not a bcrypt hash, so bcrypt.compare can never match it: the account cannot be
 * signed into with a password until the mailbox owner sets one via reset or signs
 * in with Google. Same pattern as the Fathom draft accounts.
 */
export const SLACK_START_DISABLED_PASSWORD = '!disabled-slack-start-intake-account!';

const positiveInt = (raw: string | undefined, fallback: number) => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

export function buildProductionSlackStartDeps(env: Env = process.env): SlackStartDeps {
  const leadListId = env.SLACK_START_LEAD_LIST_ID?.trim();
  const requireListId = () => {
    if (!leadListId) throw new Error('SLACK_START_LEAD_LIST_ID is not configured — slack-start lead not written');
    return leadListId;
  };

  return {
    store: createDynamoSlackStartStore(),
    verifyCaptcha: (token, ip) => verifySlackStartCaptcha(token, ip, { env }),
    assertPublicWebsite: assertPublicHostname,
    findUserByEmail: async (email) => {
      const user = await userDb.getUserByEmail(email);
      return user ? { userId: user.userId } : null;
    },
    async createUser({ userId, email }) {
      try {
        await userDb.createUser(email, userId, SLACK_START_DISABLED_PASSWORD, false, false, ['customer'], email.split('@')[0]);
      } catch (err: any) {
        if (err?.code !== 'ConditionalCheckFailedException') throw err;
        const own = await userDb.getUserByIdConsistent(userId);
        if (!own || own.email !== email) return 'exists';
      }
      // Same Free-tier defaults /api/auth/register applies to a new account.
      const free = await getTierConfig('Free');
      await userDb.updateUser(userId, {
        subscriptionType: 'Free',
        allowedPages: free?.allowedPages ?? [...DEFAULT_PAGES],
        allowedSkills: free?.allowedSkills ?? [],
      } as any);
      return 'created';
    },
    updateUser: async (userId, patch) => {
      await userDb.updateUser(userId, patch as any);
    },
    async writeLead({ leadId, intakeId, email, website, domain, utm }) {
      const listId = requireListId();
      const list = await crmDb.getLeadListById(listId);
      if (!list) throw new Error(`slack-start lead list ${listId} not found`);
      const utmFields = Object.fromEntries(Object.entries(utm ?? {}).map(([k, v]) => [`utm_${k}`, v]));
      try {
        const created: any = await crmDb.createLead(listId, {
          leadId,
          failIfExists: true,
          email,
          website,
          domain,
          company: domain,
          userId: list.userId,
          ...(utm?.source ? { utmSource: utm.source } : {}),
          ...(utm?.medium ? { utmMedium: utm.medium } : {}),
          customFields: { signupSource: 'slack_start', slackStartIntakeId: intakeId, ...utmFields },
        });
        return { leadId: created?.leadId ?? leadId };
      } catch (err: any) {
        if (err?.leadAlreadyExists) return { leadId };
        if (err?.duplicateEmail && err.existingLead?.leadId) return { leadId: err.existingLead.leadId };
        throw err;
      }
    },
    async updateLeadAnswers(leadId, customFields) {
      await crmDb.updateLead(requireListId(), leadId, { customFields, customFieldsKeyMerge: true });
    },
    async triggerBrandBuild(userId) {
      const claim = await claimBrandBuildRun(userId);
      if (!claim) return;
      void triggerBrandBuildForUser(userId, { expectedStartedAt: claim.brandBuildStartedAt, skipSlackConnect: true }).catch((err) =>
        console.error('[slack-start] brand build failed', { userId, error: (err as Error)?.message }),
      );
    },
    provisionSlackConnect: (input) => provisionOnboardingSlackConnect(input),
    tokenSecret: env.SLACK_START_TOKEN_SECRET?.trim() || env.JWT_SECRET?.trim() || undefined,
    now: () => new Date(),
    randomId: () => randomUUID(),
    rateLimits: {
      ipPerHour: positiveInt(env.SLACK_START_RATE_IP_PER_HOUR, 10),
      domainPerDay: positiveInt(env.SLACK_START_RATE_DOMAIN_PER_DAY, 5),
    },
    allowedOrigins: (env.SLACK_START_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    captchaPublic: captchaPublicConfig(env),
  };
}
