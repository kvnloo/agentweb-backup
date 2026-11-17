/**
 * ENG-3133 — the weekly Zoma ad-performance email.
 *
 * Once a week, every Zoma user who used Zoma in the last 7 days gets a short summary: how their
 * connected Meta and Google Ads accounts did over those 7 days, and the changes Zoma made for them.
 * It keeps users in the loop during the trial and after it. Dark until ZOMA_WEEKLY_REPORT_ENABLED=true.
 *
 * Who gets it: a Zoma user who is not an internal/test/admin account or a "pal" lead, who has not
 * unsubscribed, and who made at least one successful Zoma call in the last 7 days. Nobody else.
 * The email always says something true about each connected ad account (numbers, "no delivery", or
 * "could not read it"), or that no ad account is connected yet.
 *
 * Exactly once per user per ISO week, across instances: a conditional write claims (user, ISO week)
 * BEFORE the send, so a repeated or concurrent pass can never send twice. A failed send is logged and
 * not retried that week (a missed weekly email is cheaper than a duplicate).
 *
 * Opt-out is scoped to this email only and lives on the user record (`zomaWeeklyReportOptOutAt`, like
 * `dripUnsubscribed` and `slackShipNotifyDisabled`): it travels with the account, is covered by the
 * users table's point-in-time recovery, and is already on the row the job scans. The unsubscribe link
 * is signed; GET shows a confirm button and changes nothing (mail scanners that open links cannot
 * unsubscribe anyone), POST records it.
 */
import crypto from 'crypto';
import { getJwtSecret } from '../config/jwt';
import { accountFlag } from '../services/journeyProductBackfill';
import { getMcpUserUsage, hasZomaFunnelRow, recordZomaBillingFunnel, type McpUserUsage } from '../services/mcpUsageEventsService';
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

/** Internal/test/admin accounts and "pal" leads never get product email. */
export function isReportRecipient(user: Pick<ZomaUserRecord, 'email' | 'isAdmin' | 'zomaAdsExperience'>): boolean {
  if (!user.email) return false;
  if (accountFlag(user.email, user.isAdmin)) return false;
  return zomaLeadClassification(user.zomaAdsExperience) !== ZOMA_PAL;
}

export type AdPlatform = 'meta' | 'google_ads';
const PLATFORM_LABEL: Record<AdPlatform, string> = { meta: 'Meta ads', google_ads: 'Google Ads' };
const WRITE_PLATFORM_LABEL: Record<string, string> = { meta: 'Meta', google_ads: 'Google Ads' };

/** One ad account's totals for the week. */
export interface ZomaAdsWeek {
  currency?: string;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  /** Meta only; null when there is none. */
  roas: number | null;
  /** Meta only: the conversion event the report counted. */
  conversionEvent: string | null;
}

/** What the report can say about one connected ad platform. */
export type PlatformWeek =
  | { platform: AdPlatform; status: 'delivered'; ads: ZomaAdsWeek }
  | { platform: AdPlatform; status: 'no_delivery' }
  | { platform: AdPlatform; status: 'unreadable' };

const int = (n: number) => Math.round(n).toLocaleString('en-US');
const money = (n: number, currency?: string) => `${n.toFixed(2)}${currency ? ` ${currency}` : ''}`;

/** Plain lines for one platform's delivery: spend and results only. */
export function adsWeekLines(ads: ZomaAdsWeek): string[] {
  return [
    `Spend: ${money(ads.spend, ads.currency)}`,
    `Impressions: ${int(ads.impressions)}`,
    `Clicks: ${int(ads.clicks)}`,
    `Conversions: ${int(ads.conversions)}${ads.conversionEvent ? ` (${ads.conversionEvent})` : ''}`,
    ...(ads.roas !== null && ads.roas > 0 ? [`Return on ad spend: ${ads.roas}x`] : []),
  ];
}

/** The line(s) that describe one platform, or the whole "no account connected" case. */
function platformLines(week: PlatformWeek): string[] {
  const label = PLATFORM_LABEL[week.platform];
  if (week.status === 'delivered') return adsWeekLines(week.ads);
  if (week.status === 'no_delivery') return [`No ad delivery was recorded on your connected ${label} account this week.`];
  return [`We could not read your ${label} account this week. It may need to be reconnected: ask your agent to run zoma_status.`];
}
const NO_ACCOUNT_LINE = 'No ad account is connected to Zoma yet. Ask your agent to run zoma_status for the connect link.';

const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

function signature(userId: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(`${UNSUBSCRIBE_CONTEXT}:${userId}`).digest('base64url');
}

/** `<base64url user id>.<hmac>`. Signed with the JWT secret, like the CRM unsubscribe links. */
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

/** "update campaign (Meta)" from a recorded write; letters, digits, underscore and space only. */
function describeWrite(w: McpUserUsage['recentWrites'][number]): string {
  const clean = (v: unknown) => String(v ?? '').toLowerCase().replace(/[^a-z0-9_ ]/g, '').replace(/_/g, ' ').trim().slice(0, 40);
  const what = [clean(w.action), clean(w.entityType)].filter(Boolean).join(' ') || 'change';
  const where = WRITE_PLATFORM_LABEL[String(w.platform ?? '')];
  return where ? `${what} (${where})` : what;
}

export interface WeeklyReportEmailInput {
  usage: McpUserUsage;
  /** One entry per connected ad platform; empty when no usable ad account is connected. */
  platforms: PlatformWeek[];
  range: { start: string; end: string };
  unsubscribeUrl: string;
}

export function weeklyReportEmail(input: WeeklyReportEmailInput): { subject: string; text: string; html: string } {
  const { usage, platforms, range, unsubscribeUrl } = input;
  const day = (iso: string) => iso.slice(0, 10);
  const confirmed = usage.writes.confirmed;
  const recent = usage.recentWrites.filter((w) => w.verification === 'CONFIRMED').slice(-5).reverse();
  const changes = confirmed > 0
    ? `Zoma made ${confirmed} confirmed change${confirmed === 1 ? '' : 's'} to your ads this week.`
    : 'Zoma made no changes to your ads this week.';
  const recentLines = recent.map((w) => `- ${day(w.ts)}: ${describeWrite(w)}`);
  const callLine = `Your agent made ${usage.toolCalls.toLocaleString('en-US')} successful Zoma call${usage.toolCalls === 1 ? '' : 's'} this week.`;
  const subject = 'Your Zoma week in ads';

  const perfText = platforms.length
    ? platforms.flatMap((p, i) => [...(i ? [''] : []), PLATFORM_LABEL[p.platform], ...platformLines(p)])
    : [NO_ACCOUNT_LINE];

  const text = [
    `Here is your Zoma week, ${day(range.start)} to ${day(range.end)}.`,
    '',
    'How your ads did',
    ...perfText,
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

  const perfHtml = platforms.length
    ? platforms
        .map((p) => {
          const lines = platformLines(p);
          const body = p.status === 'delivered'
            ? `<ul>${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>`
            : `<p>${escapeHtml(lines[0])}</p>`;
          return `<h4>${escapeHtml(PLATFORM_LABEL[p.platform])}</h4>${body}`;
        })
        .join('')
    : `<p>${escapeHtml(NO_ACCOUNT_LINE)}</p>`;

  const html = [
    `<p>Here is your Zoma week, ${escapeHtml(day(range.start))} to ${escapeHtml(day(range.end))}.</p>`,
    `<h3>How your ads did</h3>${perfHtml}`,
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
  /** A fresh, consistent read of the user's opt-out, right before the send. */
  hasOptedOut: (userId: string) => Promise<boolean>;
  hasClaimed: (userId: string, week: string) => Promise<boolean>;
  /** Conditional write: true for the one caller that claims (user, week). */
  claim: (userId: string, week: string) => Promise<boolean>;
  recordSent: (userId: string, week: string) => Promise<unknown>;
  getUsage: (userId: string, range: { start: string; end: string }) => Promise<McpUserUsage>;
  /**
   * One entry per connected ad platform (empty when none is connected). Must report a failed read as
   * `unreadable` rather than as "no delivery", and must not throw for a single platform's failure.
   */
  getAdsWeeks: (userId: string, range: { start: string; end: string }) => Promise<PlatformWeek[]>;
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
      if (user.zomaWeeklyReportOptOutAt) continue;
      if (await deps.hasClaimed(user.userId, week)) continue;
      const usage = await deps.getUsage(user.userId, range);
      if (usage.toolCalls < 1) continue;
      // A failure here skips the user for this pass (nothing claimed, retried next hour) instead of
      // sending an email that claims "no ad account".
      const platforms = await deps.getAdsWeeks(user.userId, range);
      // The scan row can be stale: re-read the opt-out, consistently, right before claiming.
      if (await deps.hasOptedOut(user.userId)) continue;
      // Claim BEFORE sending: a concurrent or repeated pass loses the conditional write and sends nothing.
      if (!(await deps.claim(user.userId, week))) continue;
      claimedThisPass += 1;
      const email = weeklyReportEmail({ usage, platforms, range, unsubscribeUrl: zomaUnsubscribeUrl(user.userId, deps) });
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

/**
 * Record the opt-out on the user record. Idempotent. Returns false when there is no such user (a deleted
 * account has nothing to stop); any other failure is thrown so the caller can tell the user to retry.
 */
export async function recordWeeklyReportOptOut(
  userId: string,
  setOptOut: (userId: string, at: string) => Promise<void> = defaultSetOptOut,
  now: () => Date = () => new Date(),
): Promise<boolean> {
  try {
    await setOptOut(userId, now().toISOString());
    return true;
  } catch (error) {
    if (error instanceof Error && /not found/i.test(error.message)) return false;
    throw error;
  }
}

async function defaultSetOptOut(userId: string, at: string): Promise<void> {
  const { userDb } = await import('../services/db');
  await userDb.updateUser(userId, { zomaWeeklyReportOptOutAt: at });
}

// ---------------------------------------------------------------------------------------------
// Production wiring
// ---------------------------------------------------------------------------------------------

const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

async function metaWeek(account: any, accountId: string, range: { start: string; end: string }): Promise<PlatformWeek> {
  const { runZomaAdsReport } = await import('./zomaAdsReport');
  const report = await runZomaAdsReport(account, accountId, { level: 'account', since: range.start.slice(0, 10), until: range.end.slice(0, 10) });
  const t = report.totals;
  if (!(t.spend > 0 || t.impressions > 0)) return { platform: 'meta', status: 'no_delivery' };
  return {
    platform: 'meta',
    status: 'delivered',
    ads: { currency: report.currency, spend: t.spend, impressions: t.impressions, clicks: t.clicks, conversions: t.conversions, roas: t.roas, conversionEvent: report.conversion_event },
  };
}

/** Account-level Google Ads totals for the exact window, summed over the (single) customer row. */
async function googleWeek(userId: string, customerId: string, range: { start: string; end: string }): Promise<PlatformWeek> {
  const { googleAdsService } = await import('../services/googleAdsService');
  const since = range.start.slice(0, 10);
  const until = range.end.slice(0, 10);
  const rows: any[] = await googleAdsService.queryReporting(
    userId,
    customerId,
    `SELECT customer.currency_code, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions FROM customer WHERE segments.date BETWEEN '${since}' AND '${until}'`,
  );
  let spend = 0, impressions = 0, clicks = 0, conversions = 0;
  let currency: string | undefined;
  for (const r of rows ?? []) {
    const m = r?.metrics ?? {};
    spend += num(m.costMicros ?? m.cost_micros) / 1_000_000;
    impressions += num(m.impressions);
    clicks += num(m.clicks);
    conversions += num(m.conversions);
    currency = currency ?? r?.customer?.currencyCode ?? r?.customer?.currency_code;
  }
  if (!(spend > 0 || impressions > 0)) return { platform: 'google_ads', status: 'no_delivery' };
  return { platform: 'google_ads', status: 'delivered', ads: { currency, spend, impressions, clicks, conversions, roas: null, conversionEvent: null } };
}

export const defaultZomaWeeklyReportDeps: ZomaWeeklyReportDeps = {
  config: () => getZomaWeeklyReportConfig(),
  async listUsers() {
    const { defaultScoreboardDeps } = await import('../services/zomaScoreboard');
    return defaultScoreboardDeps().listZomaUsers();
  },
  async hasOptedOut(userId) {
    const { userDb } = await import('../services/db');
    const user = await userDb.getUserByIdConsistent(userId);
    return !!user?.zomaWeeklyReportOptOutAt;
  },
  hasClaimed: (userId, week) => hasZomaFunnelRow(userId, 'weekly_report_claimed', `${userId}#${week}`),
  claim: (userId, week) => recordZomaBillingFunnel({ userId, step: 'weekly_report_claimed', dedupeKey: `${userId}#${week}` }),
  recordSent: (userId, week) => recordZomaBillingFunnel({ userId, step: 'weekly_report_sent', dedupeKey: `${userId}#${week}` }),
  getUsage: (userId, range) => getMcpUserUsage(userId, range),
  async getAdsWeeks(userId, range) {
    const [{ getAccountsByUserIdIncludingOrgShared }, { META_PROVIDER, GOOGLE_ADS_PROVIDER }] = await Promise.all([
      import('../services/connectedAccountsDb'), import('./zomaProviders'),
    ]);
    const now = Date.now();
    const accounts = await getAccountsByUserIdIncludingOrgShared(userId);
    const weeks: PlatformWeek[] = [];
    const guarded = async (platform: AdPlatform, run: () => Promise<PlatformWeek>) => {
      try {
        weeks.push(await run());
      } catch (error) {
        console.error(`[zoma-weekly-report] ${platform} read failed:`, error instanceof Error ? error.message : error);
        weeks.push({ platform, status: 'unreadable' });
      }
    };
    const meta = accounts.find((a) => META_PROVIDER.isAdAccount(a) && META_PROVIDER.isUsable(a, now));
    const metaId = meta && META_PROVIDER.accountIds(meta)[0];
    if (meta && metaId) await guarded('meta', () => metaWeek(meta, metaId, range));
    const google = accounts.find((a) => GOOGLE_ADS_PROVIDER.isAdAccount(a) && GOOGLE_ADS_PROVIDER.isUsable(a, now));
    const googleId = google && GOOGLE_ADS_PROVIDER.accountIds(google)[0];
    if (google && googleId) await guarded('google_ads', () => googleWeek(userId, googleId, range));
    return weeks;
  },
  async sendEmail(to, subject, text, html) {
    const { emailService } = await import('../services/emailService');
    return emailService.sendEmail(to, subject, text, html);
  },
  backendUrl: getBackendUrl,
  secret: () => getJwtSecret(),
  now: () => Date.now(),
};
