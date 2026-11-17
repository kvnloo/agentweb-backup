/**
 * ENG-3133 — the weekly Zoma ad-performance email.
 *
 * Once a week, every active Zoma user gets a short summary: how their connected Meta ad account
 * did over the last 7 days, and the changes Zoma made for them in that time. It keeps users in the
 * loop during the trial and after it. Dark until ZOMA_WEEKLY_REPORT_ENABLED=true.
 *
 * Who gets it: a Zoma user who is not an internal/test/admin account and not a "pal" lead, who has
 * not unsubscribed, who made at least one successful Zoma call in the last 7 days, and who has
 * something to report (ad delivery on the connected Meta account, or a confirmed change Zoma made).
 * A user with nothing to say gets no email that week.
 *
 * Exactly once per user per ISO week, across instances: a conditional write claims
 * (user, ISO week) BEFORE the send, so a repeated or concurrent pass can never send twice. A failed
 * send is logged and not retried that week (a missed weekly email is cheaper than a duplicate).
 *
 * Opt-out is scoped to this email only. The unsubscribe link is signed and shows a confirm button
 * first (GET never changes anything, so mail scanners that open links cannot unsubscribe anyone).
 * The opt-out is a row in the existing MCP usage-event table (a funnel row with a dedupeKey), not a
 * user-row write: no new table, column or index.
 */
import crypto from 'crypto';
import { getJwtSecret } from '../config/jwt';
import { accountFlag } from '../services/journeyProductBackfill';
import {
  getMcpUserUsage,
  hasZomaFunnelRow,
  recordZomaBillingFunnel,
  type McpUserUsage,
  type ZomaBillingFunnelInput,
} from '../services/mcpUsageEventsService';
import type { ZomaUserRecord } from '../services/zomaScoreboard';
import { getBackendUrl } from './oauth/authChallenge';
import { ZOMA_PAL, zomaLeadClassification } from './zomaAdsExperience';

const DAY_MS = 24 * 60 * 60 * 1000;
const UNSUBSCRIBE_CONTEXT = 'zoma-weekly-report-unsubscribe';
const DOCS_URL = 'https://docs.agentweb.pro/zoma';
const SUPPORT_EMAIL = 'support@agentweb.pro';

// ---------------------------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------------------------

export interface ZomaWeeklyReportConfig {
  enabled: boolean;
  /** UTC weekday the reports go out (0 = Sunday … 6 = Saturday). */
  weekday: number;
  /** UTC hour the send window opens on that weekday; it stays open until the day ends. */
  hour: number;
  lookbackDays: number;
  /** Safety cap on emails claimed in one pass. */
  maxPerPass: number;
}

function boundedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  return raw !== undefined && raw.trim() !== '' && Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

export function getZomaWeeklyReportConfig(env: NodeJS.ProcessEnv = process.env): ZomaWeeklyReportConfig {
  return {
    enabled: env.ZOMA_WEEKLY_REPORT_ENABLED === 'true',
    weekday: boundedInt(env.ZOMA_WEEKLY_REPORT_WEEKDAY, 1, 0, 6),
    hour: boundedInt(env.ZOMA_WEEKLY_REPORT_HOUR, 15, 0, 23),
    lookbackDays: boundedInt(env.ZOMA_WEEKLY_REPORT_LOOKBACK_DAYS, 7, 1, 31),
    maxPerPass: boundedInt(env.ZOMA_WEEKLY_REPORT_MAX_PER_PASS, 200, 1, 1000),
  };
}

// ---------------------------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------------------------

/** ISO-8601 week (UTC) as `YYYY-Www`. The week's Thursday decides the year. */
export function isoWeekKey(ms: number): string {
  const d = new Date(ms);
  const day = d.getUTCDay() || 7;
  const thursday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 4 - day));
  const yearStart = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((thursday.getTime() - yearStart) / DAY_MS + 1) / 7);
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** The send window: the configured UTC weekday, from the configured hour until the day ends. */
export function inSendWindow(ms: number, cfg: Pick<ZomaWeeklyReportConfig, 'weekday' | 'hour'>): boolean {
  const d = new Date(ms);
  return d.getUTCDay() === cfg.weekday && d.getUTCHours() >= cfg.hour;
}

/** A user with no ad delivery and no confirmed change this week has nothing to report. */
export function hasSomethingToReport(usage: Pick<McpUserUsage, 'toolCalls' | 'writes'>, adsSummary: string | undefined): boolean {
  return usage.toolCalls > 0 && (!!adsSummary || usage.writes.confirmed > 0);
}

/** Internal/test/admin accounts and "pal" leads never get product email. */
export function isReportRecipient(user: Pick<ZomaUserRecord, 'email' | 'isAdmin' | 'zomaAdsExperience'>): boolean {
  if (!user.email) return false;
  if (accountFlag(user.email, user.isAdmin)) return false;
  return zomaLeadClassification(user.zomaAdsExperience) !== ZOMA_PAL;
}

const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

function signature(userId: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(`${UNSUBSCRIBE_CONTEXT}:${userId}`).digest('base64url');
}

/** `<base64url user id>.<hmac>`. Never expires: opting out must always work. */
export function signUnsubscribeToken(userId: string, secret: string = getJwtSecret()): string {
  return `${b64url(userId)}.${signature(userId, secret)}`;
}

/** The user id inside a valid token, else null. Constant-time comparison. */
export function verifyUnsubscribeToken(token: unknown, secret: string = getJwtSecret()): string | null {
  if (typeof token !== 'string' || token.length > 300) return null;
  const [encoded, sig, ...rest] = token.split('.');
  if (!encoded || !sig || rest.length) return null;
  let userId: string;
  try {
    userId = Buffer.from(encoded, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  if (!userId || userId.length > 120) return null;
  const expected = Buffer.from(signature(userId, secret));
  const given = Buffer.from(sig);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected) ? userId : null;
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** "update campaign" from a recorded write; letters, digits, underscore and space only. */
function describeWrite(w: McpUserUsage['recentWrites'][number]): string {
  const clean = (v: unknown) => String(v ?? '').toLowerCase().replace(/[^a-z0-9_ ]/g, '').replace(/_/g, ' ').trim().slice(0, 40);
  return [clean(w.action), clean(w.entityType)].filter(Boolean).join(' ') || 'change';
}

export interface WeeklyReportEmailInput {
  usage: McpUserUsage;
  adsSummary?: string;
  range: { start: string; end: string };
  unsubscribeUrl: string;
}

export function weeklyReportEmail(input: WeeklyReportEmailInput): { subject: string; text: string; html: string } {
  const { usage, adsSummary, range, unsubscribeUrl } = input;
  const day = (iso: string) => iso.slice(0, 10);
  const confirmed = usage.writes.confirmed;
  const recent = usage.recentWrites.filter((w) => w.verification === 'CONFIRMED').slice(-5).reverse();
  const perf = adsSummary ?? 'No ad delivery was recorded on your connected Meta ad account this week.';
  const changes = confirmed > 0
    ? `Zoma made ${confirmed} confirmed change${confirmed === 1 ? '' : 's'} to your ads this week.`
    : 'Zoma made no changes to your ads this week.';
  const recentLines = recent.map((w) => `- ${day(w.ts)}: ${describeWrite(w)}`);
  const callLine = `Your agent made ${usage.toolCalls.toLocaleString('en-US')} successful Zoma call${usage.toolCalls === 1 ? '' : 's'} this week.`;
  const subject = 'Your Zoma week in ads';

  const text = [
    `Here is your Zoma week, ${day(range.start)} to ${day(range.end)}.`,
    '',
    'How your ads did',
    perf,
    '',
    'What Zoma changed',
    changes,
    ...recentLines,
    '',
    callLine,
    '',
    `Questions? Reply to this email or write to ${SUPPORT_EMAIL}. Docs: ${DOCS_URL}`,
    '',
    `Stop this weekly email: ${unsubscribeUrl}`,
  ].join('\n');

  const html = [
    `<p>Here is your Zoma week, ${escapeHtml(day(range.start))} to ${escapeHtml(day(range.end))}.</p>`,
    `<h3>How your ads did</h3><p>${escapeHtml(perf)}</p>`,
    `<h3>What Zoma changed</h3><p>${escapeHtml(changes)}</p>`,
    recentLines.length ? `<ul>${recent.map((w) => `<li>${escapeHtml(day(w.ts))}: ${escapeHtml(describeWrite(w))}</li>`).join('')}</ul>` : '',
    `<p>${escapeHtml(callLine)}</p>`,
    `<p>Questions? Reply to this email or write to <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>. <a href="${DOCS_URL}">Zoma docs</a></p>`,
    `<p style="color:#666;font-size:12px"><a href="${escapeHtml(unsubscribeUrl)}">Stop this weekly email</a></p>`,
  ].join('');

  return { subject, text, html };
}

// ---------------------------------------------------------------------------------------------
// The job (all I/O injectable)
// ---------------------------------------------------------------------------------------------

export interface ZomaWeeklyReportDeps {
  config: () => ZomaWeeklyReportConfig;
  listUsers: () => Promise<ZomaUserRecord[]>;
  hasOptedOut: (userId: string) => Promise<boolean>;
  hasClaimed: (userId: string, week: string) => Promise<boolean>;
  /** Conditional write: true for the one caller that claims (user, week). */
  claim: (userId: string, week: string) => Promise<boolean>;
  recordSent: (userId: string, week: string) => Promise<unknown>;
  getUsage: (userId: string, range: { start: string; end: string }) => Promise<McpUserUsage>;
  /** One-line account-level Meta ad performance for the range, or undefined when there was no delivery. */
  getAdsSummary: (userId: string, range: { start: string; end: string }) => Promise<string | undefined>;
  sendEmail: (to: string, subject: string, text: string, html: string) => Promise<'sent' | 'suppressed' | 'failed' | void>;
  backendUrl: () => string;
  secret: () => string;
  now: () => number;
}

export interface WeeklyReportRunResult {
  checked: number;
  sent: number;
  failed: number;
}

export function zomaUnsubscribeUrl(userId: string, deps: Pick<ZomaWeeklyReportDeps, 'backendUrl' | 'secret'>): string {
  return `${deps.backendUrl().replace(/\/+$/, '')}/api/zoma/weekly-report/unsubscribe?t=${encodeURIComponent(signUnsubscribeToken(userId, deps.secret()))}`;
}

export async function runZomaWeeklyReports(deps: ZomaWeeklyReportDeps = defaultZomaWeeklyReportDeps): Promise<WeeklyReportRunResult> {
  const cfg = deps.config();
  const result: WeeklyReportRunResult = { checked: 0, sent: 0, failed: 0 };
  if (!cfg.enabled) return result;
  const now = deps.now();
  if (!inSendWindow(now, cfg)) return result;
  const week = isoWeekKey(now);
  const range = { start: new Date(now - cfg.lookbackDays * DAY_MS).toISOString(), end: new Date(now).toISOString() };

  const users = await deps.listUsers();
  let claimedThisPass = 0;
  for (const user of users) {
    if (claimedThisPass >= cfg.maxPerPass) break;
    try {
      if (!isReportRecipient(user)) continue;
      result.checked += 1;
      if (await deps.hasOptedOut(user.userId)) continue;
      if (await deps.hasClaimed(user.userId, week)) continue;
      const usage = await deps.getUsage(user.userId, range);
      if (usage.toolCalls < 1) continue;
      const adsSummary = await deps.getAdsSummary(user.userId, range).catch((error) => {
        console.error('[zoma-weekly-report] ads summary failed:', error instanceof Error ? error.message : error);
        return undefined;
      });
      if (!hasSomethingToReport(usage, adsSummary)) continue;
      // Claim BEFORE sending: a concurrent or repeated pass loses the conditional write and sends nothing.
      if (!(await deps.claim(user.userId, week))) continue;
      claimedThisPass += 1;
      const email = weeklyReportEmail({ usage, adsSummary, range, unsubscribeUrl: zomaUnsubscribeUrl(user.userId, deps) });
      const outcome = await deps.sendEmail(user.email, email.subject, email.text, email.html);
      if (outcome === 'failed') {
        result.failed += 1;
        console.error(`[zoma-weekly-report] not delivered for ${user.userId} (${week}); not retried this week`);
        continue;
      }
      // 'suppressed' is the non-prod mail guard: nothing left the box, so it is done but not counted.
      if (outcome !== 'sent') continue;
      result.sent += 1;
      await deps.recordSent(user.userId, week).catch((e) => console.error('[zoma-weekly-report] sent row failed:', e instanceof Error ? e.message : e));
    } catch (error) {
      console.error(`[zoma-weekly-report] failed for ${user.userId}:`, error instanceof Error ? error.message : error);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// Opt-out (used by the unsubscribe routes)
// ---------------------------------------------------------------------------------------------

export async function recordWeeklyReportOptOut(
  userId: string,
  record: (input: ZomaBillingFunnelInput) => Promise<boolean> = recordZomaBillingFunnel,
): Promise<boolean> {
  // dedupeKey = userId: one row per user, so a repeated click is a no-op.
  return record({ userId, step: 'weekly_report_opt_out', dedupeKey: userId });
}

// ---------------------------------------------------------------------------------------------
// Production wiring
// ---------------------------------------------------------------------------------------------

export const defaultZomaWeeklyReportDeps: ZomaWeeklyReportDeps = {
  config: () => getZomaWeeklyReportConfig(),
  async listUsers() {
    const { defaultScoreboardDeps } = await import('../services/zomaScoreboard');
    return defaultScoreboardDeps().listZomaUsers();
  },
  hasOptedOut: (userId) => hasZomaFunnelRow(userId, 'weekly_report_opt_out', userId),
  hasClaimed: (userId, week) => hasZomaFunnelRow(userId, 'weekly_report_claimed', `${userId}#${week}`),
  claim: (userId, week) => recordZomaBillingFunnel({ userId, step: 'weekly_report_claimed', dedupeKey: `${userId}#${week}` }),
  recordSent: (userId, week) => recordZomaBillingFunnel({ userId, step: 'weekly_report_sent', dedupeKey: `${userId}#${week}` }),
  getUsage: (userId, range) => getMcpUserUsage(userId, range),
  async getAdsSummary(userId, range) {
    const [{ getAccountsByUserIdIncludingOrgShared }, { META_PROVIDER }, { runZomaAdsReport }] = await Promise.all([
      import('../services/connectedAccountsDb'), import('./zomaProviders'), import('./zomaAdsReport'),
    ]);
    const now = Date.now();
    const account = (await getAccountsByUserIdIncludingOrgShared(userId)).find((a) => META_PROVIDER.isAdAccount(a) && META_PROVIDER.isUsable(a, now));
    const accountId = account && META_PROVIDER.accountIds(account)[0];
    if (!account || !accountId) return undefined;
    const report = await runZomaAdsReport(account, accountId, { level: 'account', since: range.start.slice(0, 10), until: range.end.slice(0, 10) });
    return report.totals.spend > 0 || report.totals.impressions > 0 ? report.summary : undefined;
  },
  async sendEmail(to, subject, text, html) {
    const { emailService } = await import('../services/emailService');
    return emailService.sendEmail(to, subject, text, html);
  },
  backendUrl: getBackendUrl,
  secret: () => getJwtSecret(),
  now: () => Date.now(),
};
