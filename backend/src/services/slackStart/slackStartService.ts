/**
 * ENG-2782 S1 — "Get started in Slack" intake orchestration.
 *
 * Flow:
 *   start     validate → IP rate limit → same-key replay? → captcha → website (SSRF) →
 *             domain rate limit → existing account? → atomic intake + domain lock →
 *             provision (user, CRM lead, brand build) → 202 {intakeId, intakeToken}
 *   answer    per-step idempotent save onto intake, user and lead
 *   complete  every answer present → completion lease → provisionOnboardingSlackConnect
 *             (inert while SLACK_CONNECT_ENABLED is off) → honest pending/invited state
 *
 * Security model:
 *   - The intake capability is `intakeToken` = HMAC(secret, intakeId, idempotency-key hash).
 *     It is returned only to the request that created the intake or to a retry that
 *     presents the SAME Idempotency-Key for the SAME email (a secret only that browser
 *     holds). It is never stored, never placed in a URL by the widget, and is compared
 *     in constant time. A missing/wrong token and an unknown intake look identical (404).
 *   - Domain dedupe never reveals the existing intake: a second start for a taken domain
 *     gets 409 domain_in_progress with no id or token.
 *   - An email that already has an AgentWeb account is never attached to an intake
 *     (409 account_exists). The account the intake creates has no usable password: it
 *     can only be claimed by proving the mailbox (password reset / Google sign-in).
 *   - Provisioning is idempotent and resumable: each side effect is stamped on the
 *     intake, the user id and lead id are minted up front, and the brand build is
 *     guarded by a conditional stamp so it fires exactly once.
 */

import { createHash, createHmac, timingSafeEqual } from 'crypto';
import {
  ANSWER_FIELDS,
  type AnswerField,
  type AnswerValue,
  getSlackStartConfig,
  isAnswerField,
  isHighBudget,
  validateAnswer,
} from './slackStartConfig';
import { normalizeWebsite, normalizeWorkEmail } from './slackStartValidation';
import type { CaptchaResult } from './slackStartCaptcha';
import type { IntakeRecord, SlackStartStore } from './slackStartStore';
import type { SlackConnectResult } from '../slackConnectService';

export interface SlackStartDeps {
  store: SlackStartStore;
  verifyCaptcha(token: unknown, remoteIp: string | undefined): Promise<CaptchaResult>;
  assertPublicWebsite?: (url: string) => Promise<void>;
  findUserByEmail(email: string): Promise<{ userId: string } | null | undefined>;
  /** Create the account with a pre-minted id. 'exists' when the email is already taken. */
  createUser(input: { userId: string; email: string }): Promise<'created' | 'exists'>;
  updateUser(userId: string, patch: Record<string, unknown>): Promise<void>;
  /** Idempotent on `leadId`; returns the id of the lead that now represents this person. */
  writeLead(input: {
    leadId: string;
    intakeId: string;
    email: string;
    website: string;
    domain: string;
    utm?: Record<string, string>;
  }): Promise<{ leadId: string }>;
  updateLeadAnswers(leadId: string, customFields: Record<string, unknown>): Promise<void>;
  /** Claim and fire the onboarding brand build (fire-and-forget inside). */
  triggerBrandBuild(userId: string): Promise<void>;
  provisionSlackConnect(input: { userId: string; companyEmail: string; existingChannelId?: string }): Promise<SlackConnectResult>;
  tokenSecret: string | undefined;
  now(): Date;
  randomId(): string;
  rateLimits: { ipPerHour: number; domainPerDay: number };
  allowedOrigins: string[];
  captchaPublic: { provider: 'turnstile'; siteKey: string } | null;
}

export type ServiceResult = { status: number; body: Record<string, unknown> };

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const COMPLETION_LEASE_MS = 60_000;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{16,200}$/;
const UTM_KEYS = ['source', 'medium', 'campaign', 'term', 'content'] as const;
const STEP_FOR_FIELD: Record<AnswerField, number> = { source: 2, role: 3, sector: 4, tools: 5, adSpend: 6 };
const USER_FIELD: Record<AnswerField, string> = {
  source: 'onboardingDiscoverySource',
  role: 'onboardingRole',
  sector: 'onboardingSectors',
  tools: 'onboardingTools',
  adSpend: 'onboardingAdSpend',
};
const LEAD_FIELD: Record<AnswerField, string> = {
  source: 'slackStartSource',
  role: 'slackStartRole',
  sector: 'slackStartSector',
  tools: 'slackStartTools',
  adSpend: 'slackStartAdSpend',
};

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
const errors = () => getSlackStartConfig().errors;
const fail = (status: number, code: string, message?: string, extra: Record<string, unknown> = {}): ServiceResult => ({
  status,
  body: { code, ...(message ? { message } : {}), ...extra },
});
const NOT_FOUND: ServiceResult = { status: 404, body: { code: 'not_found' } };

export interface SlackStartService {
  config(): ServiceResult;
  start(input: { body: unknown; idempotencyKey: unknown; ip: string | undefined }): Promise<ServiceResult>;
  read(intakeId: string, bearer: string | undefined): Promise<ServiceResult>;
  answer(intakeId: string, bearer: string | undefined, body: unknown): Promise<ServiceResult>;
  complete(intakeId: string, bearer: string | undefined): Promise<ServiceResult>;
}

export function createSlackStartService(deps: SlackStartDeps): SlackStartService {
  const iso = () => deps.now().toISOString();

  const tokenFor = (intake: Pick<IntakeRecord, 'intakeId' | 'idempotencyKeyHash'>): string =>
    createHmac('sha256', deps.tokenSecret as string)
      .update(`slack-start:v1:${intake.intakeId}:${intake.idempotencyKeyHash}`)
      .digest('base64url');

  async function authorize(intakeId: string, bearer: string | undefined): Promise<IntakeRecord | null> {
    if (!deps.tokenSecret || !bearer || typeof intakeId !== 'string' || intakeId.length > 100) return null;
    const intake = await deps.store.getIntake(intakeId);
    if (!intake) return null;
    const expected = Buffer.from(tokenFor(intake));
    const given = Buffer.from(bearer);
    return expected.length === given.length && timingSafeEqual(expected, given) ? intake : null;
  }

  const accepted = (intake: IntakeRecord): ServiceResult => ({
    status: 202,
    body: { intakeId: intake.intakeId, intakeToken: tokenFor(intake), status: intake.status },
  });

  /** Idempotent, resumable side effects of a start. Returns a failure to surface, or null. */
  async function provision(intakeId: string): Promise<ServiceResult | null> {
    let intake = await deps.store.getIntake(intakeId);
    if (!intake) return fail(503, 'provisioning_failed', errors().generic);
    if (intake.accountConflictAt) return fail(409, 'account_exists', errors().accountExists);

    if (!intake.userCreatedAt) {
      try {
        const existing = await deps.findUserByEmail(intake.email);
        if (existing && existing.userId !== intake.userId) return await markConflict(intake);
        if (!existing) {
          const outcome = await deps.createUser({ userId: intake.userId, email: intake.email });
          if (outcome === 'exists') {
            const owner = await deps.findUserByEmail(intake.email);
            if (!owner || owner.userId !== intake.userId) return await markConflict(intake);
          }
        }
        await deps.updateUser(intake.userId, {
          companyUrl: intake.website,
          signupSource: 'slack_start',
          slackStartIntakeId: intake.intakeId,
          ...(intake.utm ? { slackStartUtm: intake.utm } : {}),
        });
        await deps.store.updateIntake(intakeId, { userCreatedAt: iso(), updatedAt: iso() });
      } catch (err) {
        console.error('[slack-start] account provisioning failed', { intakeId, error: (err as Error)?.message });
        return fail(503, 'provisioning_failed', errors().generic);
      }
    }

    if (!intake.leadWrittenAt) {
      try {
        const { leadId } = await deps.writeLead({
          leadId: intake.leadId,
          intakeId: intake.intakeId,
          email: intake.email,
          website: intake.website,
          domain: intake.domain,
          ...(intake.utm ? { utm: intake.utm } : {}),
        });
        await deps.store.updateIntake(intakeId, { leadId, leadWrittenAt: iso(), leadWriteError: null, updatedAt: iso() });
      } catch (err) {
        // The intake row is itself a durable record of this lead, so the visitor keeps going;
        // the failure is loud in logs and on the intake for the follow-up to repair.
        const message = (err as Error)?.message ?? String(err);
        console.error('[slack-start] CRM lead write failed', { intakeId, error: message });
        await deps.store.updateIntake(intakeId, { leadWriteError: message.slice(0, 500), updatedAt: iso() });
      }
    }

    intake = (await deps.store.getIntake(intakeId)) ?? intake;
    if (!intake.brandBuildTriggeredAt) {
      const claimed = await deps.store.updateIntake(intakeId, { brandBuildTriggeredAt: iso() }, { ifNotExists: 'brandBuildTriggeredAt' });
      if (claimed) {
        deps.triggerBrandBuild(intake.userId).catch((err) =>
          console.error('[slack-start] brand build trigger failed', { intakeId, error: (err as Error)?.message }),
        );
      }
    }
    return null;
  }

  async function markConflict(intake: IntakeRecord): Promise<ServiceResult> {
    await deps.store.updateIntake(intake.intakeId, { accountConflictAt: iso(), updatedAt: iso() });
    return fail(409, 'account_exists', errors().accountExists);
  }

  async function replayIfSameRequest(domain: string, keyHash: string, email: string): Promise<ServiceResult | 'no-lock' | 'other'> {
    const lock = await deps.store.getDomainLock(domain);
    if (!lock) return 'no-lock';
    if (lock.idempotencyKeyHash !== keyHash) return 'other';
    const intake = await deps.store.getIntake(lock.intakeId);
    if (!intake || intake.email !== email) return 'other';
    return (await provision(intake.intakeId)) ?? accepted((await deps.store.getIntake(intake.intakeId)) ?? intake);
  }

  return {
    config() {
      return { status: 200, body: { ...getSlackStartConfig(), captcha: deps.captchaPublic } };
    },

    async start({ body, idempotencyKey, ip }) {
      if (!deps.tokenSecret) {
        console.error('[slack-start] no token secret configured (SLACK_START_TOKEN_SECRET/JWT_SECRET) — refusing intake');
        return fail(503, 'unavailable', errors().generic);
      }
      if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
        return fail(400, 'idempotency_key_required', errors().generic);
      }
      const email = normalizeWorkEmail(body?.email);
      if (!email.ok) return fail(400, email.code, email.code === 'personal_email' ? errors().personalEmail : errors().invalidEmail);
      const utm = parseUtm(body?.utm);
      if (utm === 'invalid') return fail(400, 'invalid_utm', errors().generic);
      const keyHash = sha256(idempotencyKey);

      if (!(await deps.store.consumeRate('ip', sha256(ip || 'unknown'), deps.rateLimits.ipPerHour, HOUR_MS, deps.now()))) {
        return fail(429, 'rate_limited', errors().rateLimited);
      }

      const replay = await replayIfSameRequest(email.domain, keyHash, email.email);
      if (typeof replay === 'object') return replay;

      const captcha = await deps.verifyCaptcha(body?.captchaToken, ip);
      if (!captcha.ok) {
        return captcha.reason === 'unconfigured' || captcha.reason === 'unavailable'
          ? fail(503, 'captcha_unavailable', errors().captcha)
          : fail(403, 'captcha_failed', errors().captcha);
      }

      const website = await normalizeWebsite(body?.website, { assertPublic: deps.assertPublicWebsite });
      if (!website.ok) return fail(400, 'invalid_website', errors().invalidWebsite);

      if (!(await deps.store.consumeRate('domain', sha256(email.domain), deps.rateLimits.domainPerDay, DAY_MS, deps.now()))) {
        return fail(429, 'rate_limited', errors().rateLimited);
      }

      if (replay === 'no-lock' && (await deps.findUserByEmail(email.email))) {
        return fail(409, 'account_exists', errors().accountExists);
      }

      const now = iso();
      const intakeId = deps.randomId();
      const intake: IntakeRecord = {
        intakeId,
        email: email.email,
        domain: email.domain,
        website: website.url,
        websiteHost: website.host,
        ...(utm ? { utm } : {}),
        idempotencyKeyHash: keyHash,
        userId: deps.randomId(),
        leadId: `slackstart-${intakeId}`,
        status: 'open',
        createdAt: now,
        updatedAt: now,
        answers: {},
        stepSavedAt: {},
        lastStep: 1,
        furthestStep: 1,
      };
      const created = await deps.store.createIntake(intake, {
        domain: email.domain,
        intakeId,
        idempotencyKeyHash: keyHash,
        createdAt: now,
      });
      if (!created.created) {
        // Lost a race. Only the request that owns the lock (same key + same email) may see it.
        const again = await replayIfSameRequest(email.domain, keyHash, email.email);
        if (typeof again === 'object') return again;
        return fail(409, 'domain_in_progress', errors().domainInProgress);
      }
      return (await provision(intakeId)) ?? accepted(intake);
    },

    async read(intakeId, bearer) {
      const intake = await authorize(intakeId, bearer);
      if (!intake) return NOT_FOUND;
      return {
        status: 200,
        body: {
          intakeId,
          status: intake.status,
          answers: intake.answers ?? {},
          furthestStep: intake.furthestStep ?? 1,
          email: intake.email,
          website: intake.website,
        },
      };
    },

    async answer(intakeId, bearer, body) {
      const intake = await authorize(intakeId, bearer);
      if (!intake) return NOT_FOUND;
      const raw = body?.answers;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length === 0) {
        return fail(400, 'invalid_answer', errors().generic);
      }
      const accepted: Partial<Record<AnswerField, AnswerValue>> = {};
      for (const [field, value] of Object.entries(raw)) {
        if (!isAnswerField(field)) return fail(400, 'invalid_answer', errors().generic, { field });
        const check = validateAnswer(field, value);
        if (!check.ok) return fail(400, 'invalid_answer', errors().generic, { field });
        accepted[field] = check.value;
      }
      const fields = Object.keys(accepted) as AnswerField[];
      const step = body?.step === undefined ? Math.max(...fields.map((f) => STEP_FOR_FIELD[f])) : body.step;
      if (!Number.isInteger(step) || step < 1 || step > 6) return fail(400, 'invalid_step', errors().generic);

      const now = iso();
      const furthestStep = Math.max(intake.furthestStep ?? 1, step);
      const set: Record<string, unknown> = { updatedAt: now, lastStep: step, furthestStep };
      for (const f of fields) {
        set[`answers.${f}`] = accepted[f];
        set[`stepSavedAt.${f}`] = now;
      }
      await deps.store.updateIntake(intakeId, set);

      if (intake.userCreatedAt) {
        await deps.updateUser(
          intake.userId,
          Object.fromEntries(fields.map((f) => [USER_FIELD[f], accepted[f]])),
        );
      }
      if (intake.leadWrittenAt) {
        try {
          await deps.updateLeadAnswers(intake.leadId, Object.fromEntries(fields.map((f) => [LEAD_FIELD[f], accepted[f]])));
        } catch (err) {
          console.error('[slack-start] lead answer mirror failed', { intakeId, error: (err as Error)?.message });
        }
      }
      return { status: 200, body: { intakeId, answers: { ...intake.answers, ...accepted }, furthestStep } };
    },

    async complete(intakeId, bearer) {
      let intake = await authorize(intakeId, bearer);
      if (!intake) return NOT_FOUND;
      const missing = ANSWER_FIELDS.filter((f) => intake!.answers?.[f] === undefined);
      if (missing.length) return fail(422, 'missing_answers', undefined, { missing });
      if (intake.slackConnectStatus === 'created') return completionBody(intake);

      const provisioningFailure = await provision(intakeId);
      if (provisioningFailure) return provisioningFailure;

      const now = deps.now();
      const claimed = await deps.store.updateIntake(
        intakeId,
        {
          completionLeaseUntil: new Date(now.getTime() + COMPLETION_LEASE_MS).toISOString(),
          completionAttempts: (intake.completionAttempts ?? 0) + 1,
        },
        { ifLeaseFree: { attr: 'completionLeaseUntil', now: now.toISOString() } },
      );
      if (!claimed) return { status: 202, body: { intakeId, status: 'processing' } };

      intake = (await deps.store.getIntake(intakeId)) ?? intake;
      const result = await deps.provisionSlackConnect({
        userId: intake.userId,
        companyEmail: intake.email,
        ...(intake.slackConnectChannelId ? { existingChannelId: intake.slackConnectChannelId } : {}),
      });
      const highBudget = isHighBudget(intake.answers.adSpend);
      const done = iso();
      const set: Record<string, unknown> = {
        status: 'completed',
        completedAt: intake.completedAt ?? done,
        updatedAt: done,
        slackConnectStatus: result.status,
        highBudget,
        // Release the lease (epoch sorts before every real timestamp) so a later retry can run.
        completionLeaseUntil: new Date(0).toISOString(),
      };
      if (result.channelId) set.slackConnectChannelId = result.channelId;
      if (highBudget && !intake.franciscoAlertEligibleAt) set.franciscoAlertEligibleAt = done;
      await deps.store.updateIntake(intakeId, set);
      if (result.status === 'failed') {
        console.error('[slack-start] Slack Connect provisioning failed', { intakeId, reason: result.reason });
      }
      await deps.updateUser(intake.userId, {
        slackStartCompletedAt: intake.completedAt ?? done,
        slackStartHighBudget: highBudget,
      });
      return completionBody({ ...intake, slackConnectStatus: result.status });
    },
  };
}

function completionBody(intake: Pick<IntakeRecord, 'intakeId' | 'slackConnectStatus'>): ServiceResult {
  return {
    status: 200,
    body: {
      intakeId: intake.intakeId,
      // "invited" only when a Slack Connect invite really exists; everything else is pending.
      status: intake.slackConnectStatus === 'created' ? 'invited' : 'pending',
      slackConnectStatus: intake.slackConnectStatus,
    },
  };
}

function parseUtm(raw: unknown): Record<string, string> | undefined | 'invalid' {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) return 'invalid';
  const out: Record<string, string> = {};
  for (const key of UTM_KEYS) {
    const v = (raw as Record<string, unknown>)[key];
    if (v === undefined || v === null || v === '') continue;
    if (typeof v !== 'string') return 'invalid';
    out[key] = v.trim().slice(0, 200);
  }
  return Object.keys(out).length ? out : undefined;
}

