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
import { getMcpUsageByUser, hasZomaFunnelRow, recordZomaBillingFunnel, type McpUserUsage } from '../services/mcpUsageEventsService';
import type { ZomaUserRecord } from '../services/zomaScoreboard';
import { getBackendUrl } from './oauth/authChallenge';
import { ZOMA_PAL, zomaLeadClassification } from './zomaAdsExperience';

const DAY_MS = 24 * 60 * 60 * 1000;
/** The usage window (calls and changes): the 7 x 24 hours before the send. */
const USAGE_DAYS = 7;
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
  /** Safety cap on emails claimed in one pass. */
  maxPerPass: number;
  /** Canary: when set, only these user ids are ever emailed. */
  onlyUserIds: string[] | null;
}

function boundedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  return raw !== undefined && raw.trim() !== '' && Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

export function getZomaWeeklyReportConfig(env: NodeJS.ProcessEnv = process.env): ZomaWeeklyReportConfig {
  const only = (env.ZOMA_WEEKLY_REPORT_ONLY_USER_IDS ?? '').split(',').map((v) => v.trim()).filter(Boolean);
  return {
    enabled: env.ZOMA_WEEKLY_REPORT_ENABLED === 'true',
    weekday: boundedInt(env.ZOMA_WEEKLY_REPORT_WEEKDAY, 1, 0, 6),
    hour: boundedInt(env.ZOMA_WEEKLY_REPORT_HOUR, 15, 0, 23),
    maxPerPass: boundedInt(env.ZOMA_WEEKLY_REPORT_MAX_PER_PASS, 200, 1, 1000),
    onlyUserIds: only.length ? only : null,
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
const PLATFORM_COLOR: Record<AdPlatform, string> = { meta: '#1877f2', google_ads: '#34a853' };
const WRITE_PLATFORM_LABEL: Record<string, string> = { meta: 'Meta', google_ads: 'Google Ads' };
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** One day of the week's chart. A day with no delivery is present with zeros. */
export interface DailyPoint {
  date: string; // YYYY-MM-DD
  spend: number;
  conversions: number;
}

export interface WeekTotals {
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
}

export interface TopCampaign {
  name: string;
  spend: number;
  conversions: number;
}

/** One ad account's last full 7 days, with the 7 days before for comparison. */
export interface ZomaAdsWeek extends WeekTotals {
  currency?: string;
  /** Return on ad spend (Meta only); null when there is none. */
  roas: number | null;
  /** The conversion event the numbers count (Meta only). */
  conversionEvent: string | null;
  /** Exactly 7 entries, oldest first, gaps filled with zeros. */
  daily: DailyPoint[];
  /** Totals for the 7 days before; undefined when that week could not be read. */
  previous?: WeekTotals;
  /** Up to 3 campaigns by spend; empty when there was nothing to rank or the read failed. */
  topCampaigns: TopCampaign[];
}

/** What the report can say about one connected ad platform. */
export type PlatformWeek =
  | { platform: AdPlatform; status: 'delivered'; ads: ZomaAdsWeek }
  | { platform: AdPlatform; status: 'no_delivery' }
  | { platform: AdPlatform; status: 'unreadable' };

// ---- dates -----------------------------------------------------------------------------------

const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * The ad windows for a report that ends at `endMs`: the last 7 COMPLETE days (ending yesterday, so a
 * half-finished day never skews the chart or the comparison) and the 7 days before them.
 */
export type AdsWindows = { since: string; until: string; prevSince: string; prevUntil: string };
export function adsWindows(endMs: number): AdsWindows {
  const until = endMs - DAY_MS;
  const since = until - 6 * DAY_MS;
  const prevUntil = since - DAY_MS;
  const prevSince = prevUntil - 6 * DAY_MS;
  return { since: isoDate(since), until: isoDate(until), prevSince: isoDate(prevSince), prevUntil: isoDate(prevUntil) };
}

/** Every date from `since` to `until` inclusive. */
export function eachDate(since: string, until: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${since}T00:00:00Z`); t <= Date.parse(`${until}T00:00:00Z`); t += DAY_MS) out.push(isoDate(t));
  return out;
}

const longDate = (iso: string) => `${MONTH[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;
const weekdayOf = (iso: string) => WEEKDAY[new Date(`${iso}T00:00:00Z`).getUTCDay()];

// ---- numbers ---------------------------------------------------------------------------------

const int = (n: number) => Math.round(n).toLocaleString('en-US');
const money = (n: number, currency?: string) =>
  `${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${currency ? ` ${currency}` : ''}`;
/** A count that may be fractional (Meta attributes partial conversions): 12, or 0.4. */
const count = (n: number) => (Math.abs(n - Math.round(n)) < 0.05 ? int(n) : n.toFixed(1));
/** "onsite_conversion.lead_grouped" -> "lead grouped": never show Meta's raw action type. */
const eventLabel = (e: string) => e.replace(/^(offsite_conversion\.fb_pixel_|onsite_conversion\.|omni_)/, '').replace(/[._]+/g, ' ').trim();

/** Whole-percent change from `prev` to `cur`; undefined when there is no usable baseline. */
export function pctChange(cur: number, prev: number | undefined): number | undefined {
  if (prev === undefined || !(prev > 0)) return undefined;
  return Math.round(((cur - prev) / prev) * 100);
}

const costPerConversion = (t: Pick<WeekTotals, 'spend' | 'conversions'>) => (t.conversions > 0 ? t.spend / t.conversions : undefined);

export interface Chip {
  label: string;
  value: string;
  /** 'up 12% vs last week', 'down 6% vs last week', 'about the same as last week' or undefined. */
  deltaText?: string;
  arrow?: '▲' | '▼';
  tone: 'good' | 'bad' | 'neutral';
}

function deltaOf(pct: number | undefined, higherIsGood: boolean | null): Pick<Chip, 'deltaText' | 'arrow' | 'tone'> {
  if (pct === undefined) return { tone: 'neutral' };
  if (Math.abs(pct) < 2) return { deltaText: 'about the same as last week', tone: 'neutral' };
  const up = pct > 0;
  const tone: Chip['tone'] = higherIsGood === null ? 'neutral' : up === higherIsGood ? 'good' : 'bad';
  return { deltaText: `${up ? 'up' : 'down'} ${Math.abs(pct)}% vs last week`, arrow: up ? '▲' : '▼', tone };
}

/** The headline numbers for one platform, each with its change against last week where there is one. */
export function weekChips(ads: ZomaAdsWeek): Chip[] {
  const prev = ads.previous;
  const cpc = costPerConversion(ads);
  const prevCpc = prev ? costPerConversion(prev) : undefined;
  const chips: Chip[] = [
    { label: 'Spend', value: money(ads.spend, ads.currency), ...deltaOf(pctChange(ads.spend, prev?.spend), null) },
    { label: 'Conversions', value: count(ads.conversions) + (ads.conversionEvent ? ` (${eventLabel(ads.conversionEvent)})` : ''), ...deltaOf(pctChange(ads.conversions, prev?.conversions), true) },
    { label: 'Cost per conversion', value: cpc === undefined ? 'none yet' : money(cpc, ads.currency), ...(cpc !== undefined ? deltaOf(pctChange(cpc, prevCpc), false) : { tone: 'neutral' as const }) },
    { label: 'Clicks', value: int(ads.clicks), ...deltaOf(pctChange(ads.clicks, prev?.clicks), true) },
  ];
  if (ads.roas !== null && ads.roas > 0) chips.push({ label: 'Return on ad spend', value: `${ads.roas}x`, tone: 'neutral' });
  return chips;
}

/**
 * One factual sentence about the week, or undefined when there is nothing safe to say. Deterministic: no
 * model, no guessing about causes. It needs spend this week and last week; it only talks about
 * conversions and cost per conversion when both weeks have conversions.
 */
export function weekInsight(ads: ZomaAdsWeek): string | undefined {
  const prev = ads.previous;
  const spendPct = pctChange(ads.spend, prev?.spend);
  if (!prev || spendPct === undefined || !(ads.spend > 0)) return undefined;
  const move = (pct: number) => (Math.abs(pct) < 2 ? 'about the same' : `${pct > 0 ? 'up' : 'down'} ${Math.abs(pct)}%`);
  const convPct = pctChange(ads.conversions, prev.conversions);
  if (convPct !== undefined && ads.conversions > 0) {
    const cpcPct = pctChange(costPerConversion(ads)!, costPerConversion(prev));
    const tail = cpcPct === undefined || Math.abs(cpcPct) < 5 ? '' : `, so each conversion cost ${Math.abs(cpcPct)}% ${cpcPct < 0 ? 'less' : 'more'}`;
    return `Spend is ${move(spendPct)} and conversions are ${move(convPct)} compared with last week${tail}.`;
  }
  return `Spend is ${move(spendPct)} compared with last week.`;
}

// ---- escaping, signing -----------------------------------------------------------------------

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
const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/** A campaign name is user-typed text: keep it to one short line of printable characters. */
const cleanName = (s: unknown) => truncate(String(s ?? '').replace(/[\r\n\t]+/g, ' ').replace(/[^\P{C}]/gu, '').trim() || 'Untitled campaign', 40);

/** "update campaign (Meta)" from a recorded write; letters, digits, underscore and space only. */
function describeWrite(w: McpUserUsage['recentWrites'][number]): string {
  const clean = (v: unknown) => String(v ?? '').toLowerCase().replace(/[^a-z0-9_ ]/g, '').replace(/_/g, ' ').trim().slice(0, 40);
  const what = [clean(w.action), clean(w.entityType)].filter(Boolean).join(' ') || 'change';
  const where = WRITE_PLATFORM_LABEL[String(w.platform ?? '')];
  return where ? `${what} (${where})` : what;
}

// ---- the email -------------------------------------------------------------------------------

const TONE_COLOR: Record<Chip['tone'], string> = { good: '#188038', bad: '#c5221f', neutral: '#5f6368' };
const NO_ACCOUNT_LINE = 'No ad account is connected to Zoma yet. Ask your agent to run zoma_status for the connect link.';

function chipsHtml(chips: Chip[]): string {
  const cells = chips
    .map((c) => {
      const delta = c.deltaText
        ? `<div style="font-size:12px;color:${TONE_COLOR[c.tone]}">${c.arrow ? `${c.arrow} ` : ''}${escapeHtml(c.deltaText)}</div>`
        : '';
      return `<td valign="top" width="${Math.floor(100 / chips.length)}%" style="padding:10px 10px;background:#f6f8fa"><div style="font-size:11px;color:#5f6368">${escapeHtml(c.label)}</div><div style="font-size:17px;font-weight:600;color:#111">${escapeHtml(c.value)}</div>${delta}</td><td width="6"></td>`;
    })
    .join('');
  return `<table width="100%" cellpadding="0" cellspacing="0" style="margin:10px 0"><tr>${cells}</tr></table>`;
}

const BAR_AREA_PX = 110;

/** Seven bars drawn with table cells (no images, no scripts), so they render in every mail client. */
function dailyBarsHtml(daily: DailyPoint[], color: string, currency?: string): string {
  const max = Math.max(...daily.map((d) => d.spend), 0);
  const cols = daily
    .map((d) => {
      const h = max > 0 && d.spend > 0 ? Math.max(2, Math.round((d.spend / max) * BAR_AREA_PX)) : 0;
      const bar = h > 0
        ? `<table cellpadding="0" cellspacing="0" width="28"><tr><td height="${h}" bgcolor="${color}" style="font-size:0;line-height:0">&nbsp;</td></tr></table>`
        : `<table cellpadding="0" cellspacing="0" width="28"><tr><td height="1" bgcolor="#dadce0" style="font-size:0;line-height:0">&nbsp;</td></tr></table>`;
      return `<td align="center" valign="bottom" style="padding:0 3px"><div style="font-size:11px;color:#5f6368;padding-bottom:3px">${escapeHtml(d.spend >= 100 ? int(d.spend) : d.spend.toFixed(d.spend >= 10 ? 0 : 1))}</div>${bar}<div style="font-size:11px;color:#5f6368;padding-top:4px">${escapeHtml(weekdayOf(d.date))}</div></td>`;
    })
    .join('');
  return `<div style="font-size:12px;color:#5f6368;margin:12px 0 4px">Spend per day${currency ? ` (${escapeHtml(currency)})` : ''}</div><table cellpadding="0" cellspacing="0" style="margin:0 auto"><tr>${cols}</tr></table>`;
}

function campaignBarsHtml(top: TopCampaign[], color: string, currency?: string): string {
  const max = Math.max(...top.map((c) => c.spend), 0);
  const rows = top
    .map((c) => {
      const w = max > 0 ? Math.max(2, Math.round((c.spend / max) * 100)) : 0;
      return `<tr><td style="padding:5px 0;font-size:13px;color:#202124;width:190px">${escapeHtml(cleanName(c.name))}</td><td style="padding:5px 8px"><table cellpadding="0" cellspacing="0" width="100%"><tr><td width="${w}%" height="12" bgcolor="${color}" style="font-size:0;line-height:0">&nbsp;</td><td></td></tr></table></td><td align="right" style="padding:5px 0;font-size:12px;color:#202124;white-space:nowrap">${escapeHtml(money(c.spend, currency))} &middot; ${escapeHtml(count(c.conversions))} conv.</td></tr>`;
    })
    .join('');
  return `<div style="font-size:12px;color:#5f6368;margin:14px 0 2px">Top campaigns by spend</div><table width="100%" cellpadding="0" cellspacing="0">${rows}</table>`;
}

function platformHtml(week: PlatformWeek): string {
  const label = escapeHtml(PLATFORM_LABEL[week.platform]);
  const head = `<h3 style="margin:22px 0 2px;color:#111;border-left:4px solid ${PLATFORM_COLOR[week.platform]};padding-left:8px">${label}</h3>`;
  if (week.status === 'no_delivery') return `${head}<p style="margin:6px 0;color:#202124">No ad delivery was recorded on your ${label} account this week.</p>`;
  if (week.status === 'unreadable') return `${head}<p style="margin:6px 0;color:#202124">We could not read your ${label} account this week. It may need to be reconnected: ask your agent to run zoma_status.</p>`;
  const { ads } = week;
  const insight = weekInsight(ads);
  const top = ads.topCampaigns.length
    ? campaignBarsHtml(ads.topCampaigns, PLATFORM_COLOR[week.platform], ads.currency)
    : '';
  const topShare = ads.topCampaigns[0] && ads.spend > 0 ? ` Top campaign: ${escapeHtml(cleanName(ads.topCampaigns[0].name))} (${Math.round((ads.topCampaigns[0].spend / ads.spend) * 100)}% of spend).` : '';
  return `${head}${insight || topShare ? `<p style="margin:6px 0;color:#202124"><b>${escapeHtml(insight ?? '')}</b>${topShare}</p>` : ''}${chipsHtml(weekChips(ads))}${dailyBarsHtml(ads.daily, PLATFORM_COLOR[week.platform], ads.currency)}${top}`;
}

function platformText(week: PlatformWeek): string[] {
  const label = PLATFORM_LABEL[week.platform];
  if (week.status === 'no_delivery') return [label, `No ad delivery was recorded on your ${label} account this week.`];
  if (week.status === 'unreadable') return [label, `We could not read your ${label} account this week. It may need to be reconnected: ask your agent to run zoma_status.`];
  const { ads } = week;
  const insight = weekInsight(ads);
  const lines = [label, ...(insight ? [insight] : [])];
  for (const c of weekChips(ads)) lines.push(`${c.label}: ${c.value}${c.deltaText ? ` (${c.deltaText})` : ''}`);
  lines.push(`Spend per day${ads.currency ? ` (${ads.currency})` : ''}: ${ads.daily.map((d) => `${weekdayOf(d.date)} ${money(d.spend)}`).join(', ')}`);
  if (ads.topCampaigns.length) {
    lines.push('Top campaigns by spend:');
    ads.topCampaigns.forEach((c, i) => lines.push(`${i + 1}. ${cleanName(c.name)}: ${money(c.spend, ads.currency)}, ${count(c.conversions)} conversion${count(c.conversions) === '1' ? '' : 's'}`));
  }
  return lines;
}

export interface WeeklyReportEmailInput {
  usage: McpUserUsage;
  /** One entry per connected ad platform; empty when no usable ad account is connected. */
  platforms: PlatformWeek[];
  /** The usage window (7 x 24 hours). The ad numbers cover the last 7 complete days before its end. */
  range: { start: string; end: string };
  unsubscribeUrl: string;
}

export function weeklyReportEmail(input: WeeklyReportEmailInput): { subject: string; text: string; html: string } {
  const { usage, platforms, range, unsubscribeUrl } = input;
  const win = adsWindows(Date.parse(range.end));
  const period = `${longDate(win.since)} to ${longDate(win.until)}`;
  const { total, confirmed } = usage.writes;
  const unconfirmed = total - confirmed;
  const changes = total === 0
    ? 'No changes were made through Zoma this week.'
    : unconfirmed === 0
      ? `Changes made through Zoma: ${confirmed} (each one confirmed by reading it back).`
      : `Changes sent through Zoma: ${total}. ${confirmed} confirmed by reading them back, ${unconfirmed} could not be confirmed.`;
  const recent = usage.recentWrites.slice().reverse();
  const recentLine = (w: McpUserUsage['recentWrites'][number]) =>
    `${longDate(w.ts.slice(0, 10))}: ${describeWrite(w)}, ${w.verification === 'CONFIRMED' ? 'confirmed' : 'not confirmed'}`;
  const recentLines = recent.length ? ['Latest changes:', ...recent.map((w) => `- ${recentLine(w)}`)] : [];
  const callLine = `Your agent made ${usage.toolCalls.toLocaleString('en-US')} successful Zoma call${usage.toolCalls === 1 ? '' : 's'} in the past 7 days.`;
  const subject = 'Your Zoma week in ads';

  const perfText = platforms.length ? platforms.flatMap((p, i) => [...(i ? [''] : []), ...platformText(p)]) : [NO_ACCOUNT_LINE];
  const text = [
    `Your Zoma week in ads, ${period}.`,
    '',
    ...perfText,
    '',
    'What happened in Zoma',
    changes,
    ...recentLines,
    callLine,
    '',
    `Questions? Reply to this email or write to ${SUPPORT_EMAIL}. Docs: ${DOCS_URL}`,
    '',
    `Stop this weekly email: ${unsubscribeUrl}`,
  ].join('\n');

  const perfHtml = platforms.length ? platforms.map(platformHtml).join('') : `<p style="color:#202124">${escapeHtml(NO_ACCOUNT_LINE)}</p>`;
  const html = [
    `<div style="max-width:600px;margin:0 auto;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;color:#202124">`,
    `<h2 style="margin:0 0 2px;color:#111">Your Zoma week in ads</h2>`,
    `<div style="color:#5f6368;font-size:13px">${escapeHtml(period)}</div>`,
    perfHtml,
    `<h3 style="margin:26px 0 4px;color:#111">What happened in Zoma</h3>`,
    `<p style="margin:6px 0">${escapeHtml(changes)}</p>`,
    recent.length ? `<div style="font-size:12px;color:#5f6368;margin-top:8px">Latest changes</div><ul style="margin:4px 0;padding-left:18px">${recent.map((w) => `<li>${escapeHtml(recentLine(w))}</li>`).join('')}</ul>` : '',
    `<p style="margin:6px 0">${escapeHtml(callLine)}</p>`,
    `<p style="margin:20px 0 6px;color:#5f6368;font-size:13px">Questions? Reply to this email or write to <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>. <a href="${DOCS_URL}">Zoma docs</a></p>`,
    `<p style="color:#80868b;font-size:12px"><a href="${escapeHtml(unsubscribeUrl)}" style="color:#80868b">Stop this weekly email</a></p>`,
    `</div>`,
  ].join('');

  return { subject, text, html };
}

// ---------------------------------------------------------------------------------------------
// The job (all I/O injectable)
// ---------------------------------------------------------------------------------------------

export interface ZomaWeeklyReportDeps {
  config: () => ZomaWeeklyReportConfig;
  listUsers: () => Promise<ZomaUserRecord[]>;
  /**
   * A fresh, consistent read of the account right before the send: where to send and whether they opted out.
   * `undefined` when the account cannot be resolved (deleted, tombstoned, index lagging): then nobody is emailed.
   */
  freshRecipient: (userId: string) => Promise<{ email: string; optedOut: boolean } | undefined>;
  hasClaimed: (userId: string, week: string) => Promise<boolean>;
  /** Conditional write: true for the one caller that claims (user, week). */
  claim: (userId: string, week: string) => Promise<boolean>;
  /** Zoma-product usage of EVERY user over the window, from one query. A user with no calls is absent. */
  getUsageByUser: (range: { start: string; end: string }) => Promise<Map<string, McpUserUsage>>;
  /**
   * One entry per connected ad platform (empty when none is connected). A permanent failure is reported as
   * `unreadable`. A transient one THROWS (the user is retried next tick) until `final`, the last tick of the send
   * window, when it is reported as `unreadable` so the user still hears from us.
   */
  getAdsWeeks: (userId: string, win: AdsWindows, opts: { final: boolean }) => Promise<PlatformWeek[]>;
  sendEmail: (to: string, subject: string, text: string, html: string, headers?: Record<string, string>) => Promise<'sent' | 'suppressed' | 'failed' | void>;
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

/** RFC 8058 one-click unsubscribe: mail clients show their own button and POST to the same signed link. */
export function unsubscribeHeaders(unsubscribeUrl: string): Record<string, string> {
  return { 'List-Unsubscribe': `<${unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' };
}

export async function runZomaWeeklyReports(deps: ZomaWeeklyReportDeps = defaultZomaWeeklyReportDeps): Promise<WeeklyReportRunResult> {
  const cfg = deps.config();
  const result: WeeklyReportRunResult = { checked: 0, sent: 0, failed: 0 };
  if (!cfg.enabled) return result;
  const now = deps.now();
  if (!inSendWindow(now, cfg)) return result;
  const week = isoWeekKey(now);
  const range = { start: new Date(now - USAGE_DAYS * DAY_MS).toISOString(), end: new Date(now).toISOString() };
  const win = adsWindows(now);
  // The last hourly tick of the window: from here on a platform that still cannot be read is reported as such.
  const final = new Date(now).getUTCHours() === 23;

  const users = await deps.listUsers();
  // ONE range query for every user, instead of one per user per tick.
  const usageByUser = await deps.getUsageByUser(range);
  let claimedThisPass = 0;
  for (const user of users) {
    if (claimedThisPass >= cfg.maxPerPass) {
      console.warn(`[zoma-weekly-report] cap of ${cfg.maxPerPass} emails reached for ${week}; the rest wait for the next pass`);
      break;
    }
    try {
      if (user.userId.startsWith('deleted_')) continue;
      if (cfg.onlyUserIds && !cfg.onlyUserIds.includes(user.userId)) continue;
      if (!isReportRecipient(user)) continue;
      result.checked += 1;
      if (user.zomaWeeklyReportOptOutAt) continue;
      // The "made a Zoma call" rule, from memory: no Dynamo, ads or email work for users with no calls.
      const usage = usageByUser.get(user.userId);
      if (!usage || usage.toolCalls < 1) continue;
      if (await deps.hasClaimed(user.userId, week)) continue;
      // A transient failure here skips the user for this pass (nothing claimed, retried next hour) instead of
      // sending an email that claims "no ad account" or "could not read".
      const platforms = await deps.getAdsWeeks(user.userId, win, { final });
      // The scan row can be stale: re-read the account, consistently, right before claiming.
      const fresh = await deps.freshRecipient(user.userId);
      if (!fresh || fresh.optedOut) continue;
      // Build everything BEFORE the claim: a failure here must not burn the week.
      const unsubscribeUrl = zomaUnsubscribeUrl(user.userId, deps);
      const email = weeklyReportEmail({ usage, platforms, range, unsubscribeUrl });
      // Claim BEFORE sending: a concurrent or repeated pass loses the conditional write and sends nothing.
      if (!(await deps.claim(user.userId, week))) continue;
      claimedThisPass += 1;
      const outcome = await deps.sendEmail(fresh.email, email.subject, email.text, email.html, unsubscribeHeaders(unsubscribeUrl));
      if (outcome === 'failed') {
        result.failed += 1;
        console.error(`[zoma-weekly-report] not delivered for ${user.userId} (${week}); not retried this week`);
        continue;
      }
      // 'suppressed' is the non-prod mail guard: nothing left the box, so it is done but not counted.
      if (outcome === 'sent') result.sent += 1;
    } catch (error) {
      console.error(`[zoma-weekly-report] failed for ${user.userId}:`, error instanceof Error ? error.message : error);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// Opt-out (used by the unsubscribe routes)
// ---------------------------------------------------------------------------------------------

/** The exact error `userDb.updateUser` throws for an account that does not exist. */
const NO_SUCH_USER = /^User with ID '.*' not found or has no email\.$/;

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
    if (error instanceof Error && NO_SUCH_USER.test(error.message)) return false;
    throw error;
  }
}

async function defaultSetOptOut(userId: string, at: string): Promise<void> {
  const { userDb } = await import('../services/db');
  await userDb.updateUser(userId, { zomaWeeklyReportOptOutAt: at });
}

// ---------------------------------------------------------------------------------------------
// Ad numbers: pure assembly (testable) and the two platform readers
// ---------------------------------------------------------------------------------------------

const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const round2 = (n: number) => Math.round(n * 100) / 100;

export interface DailyInputRow {
  date: string;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  conversion_value?: number;
}

const emptyTotals = (): WeekTotals => ({ spend: 0, impressions: 0, clicks: 0, conversions: 0 });
const addInto = (t: WeekTotals, r: DailyInputRow) => {
  t.spend += r.spend;
  t.impressions += r.impressions;
  t.clicks += r.clicks;
  t.conversions += r.conversions;
};

/**
 * Build one platform's week from a daily series that covers BOTH the last 7 complete days and the 7 before.
 * Returns null when the last 7 days had no delivery (no spend and no impressions). Days the platform did not
 * return a row for are filled with zeros.
 */
export function weekFromDaily(
  rows: DailyInputRow[],
  win: AdsWindows,
  extra: { currency?: string; conversionEvent: string | null; topCampaigns: TopCampaign[] },
): ZomaAdsWeek | null {
  const totals = emptyTotals();
  const previous = emptyTotals();
  const byDate = new Map<string, DailyPoint>();
  let value = 0;
  for (const r of rows) {
    if (r.date >= win.since && r.date <= win.until) {
      addInto(totals, r);
      value += r.conversion_value ?? 0;
      const day = byDate.get(r.date) ?? { date: r.date, spend: 0, conversions: 0 };
      day.spend += r.spend;
      day.conversions += r.conversions;
      byDate.set(r.date, day);
    } else if (r.date >= win.prevSince && r.date <= win.prevUntil) {
      addInto(previous, r);
    }
  }
  if (!(totals.spend > 0 || totals.impressions > 0)) return null;
  return {
    ...(extra.currency ? { currency: extra.currency } : {}),
    ...totals,
    roas: value > 0 && totals.spend > 0 ? round2(value / totals.spend) : null,
    conversionEvent: extra.conversionEvent,
    daily: eachDate(win.since, win.until).map((date) => byDate.get(date) ?? { date, spend: 0, conversions: 0 }),
    previous,
    topCampaigns: extra.topCampaigns,
  };
}

/** Errors that will not fix themselves by the next tick: the connection or its permissions are the problem. */
export function isPermanentReadError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /expired or was revoked|expired or revoked|reconnect|no usable access token|permission|not authori[sz]ed|unauthori[sz]ed|invalid_grant|oauthexception|code 190\b|PERMISSION_DENIED|UNAUTHENTICATED|AUTHENTICATION_ERROR|invalid authentication credentials|CUSTOMER_NOT_ENABLED|HTTP 40[13]\b/i.test(msg);
}

const topThree = (list: TopCampaign[]): TopCampaign[] =>
  list.filter((c) => c.spend > 0).sort((a, b) => b.spend - a.spend).slice(0, 3);

async function metaWeek(account: any, accountId: string, win: AdsWindows): Promise<PlatformWeek> {
  const { runZomaAdsDaily, runZomaAdsReport } = await import('./zomaAdsReport');
  const daily = await runZomaAdsDaily(account, accountId, { since: win.prevSince, until: win.until });
  const base = { currency: daily.currency, conversionEvent: daily.conversion_event };
  const week = weekFromDaily(daily.rows, win, { ...base, topCampaigns: [] });
  if (!week) return { platform: 'meta', status: 'no_delivery' };
  // Campaign ranking is a bonus: if it cannot be read the rest of the report still goes out.
  try {
    const report = await runZomaAdsReport(account, accountId, { level: 'campaign', since: win.since, until: win.until, ...(daily.conversion_event ? { conversion_event: daily.conversion_event } : {}) });
    week.topCampaigns = topThree(report.rows.map((r) => ({ name: r.campaign_name ?? '', spend: r.spend, conversions: r.conversions })));
  } catch (error) {
    console.error('[zoma-weekly-report] meta campaign breakdown skipped:', error instanceof Error ? error.message : error);
  }
  return { platform: 'meta', status: 'delivered', ads: week };
}

async function googleWeek(userId: string, customerId: string, win: AdsWindows): Promise<PlatformWeek> {
  const { googleAdsService } = await import('../services/googleAdsService');
  const rows: any[] = await googleAdsService.queryReporting(
    userId,
    customerId,
    `SELECT segments.date, customer.currency_code, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions FROM customer WHERE segments.date BETWEEN '${win.prevSince}' AND '${win.until}'`,
  );
  let currency: string | undefined;
  const daily: DailyInputRow[] = [];
  for (const r of rows ?? []) {
    const date = r?.segments?.date;
    if (typeof date !== 'string') continue;
    const m = r?.metrics ?? {};
    daily.push({ date, spend: num(m.costMicros ?? m.cost_micros) / 1_000_000, impressions: num(m.impressions), clicks: num(m.clicks), conversions: num(m.conversions) });
    currency = currency ?? r?.customer?.currencyCode ?? r?.customer?.currency_code;
  }
  const week = weekFromDaily(daily, win, { currency, conversionEvent: null, topCampaigns: [] });
  if (!week) return { platform: 'google_ads', status: 'no_delivery' };
  try {
    const camps: any[] = await googleAdsService.queryReporting(
      userId,
      customerId,
      `SELECT campaign.name, metrics.cost_micros, metrics.conversions FROM campaign WHERE segments.date BETWEEN '${win.since}' AND '${win.until}' AND metrics.cost_micros > 0 ORDER BY metrics.cost_micros DESC LIMIT 3`,
    );
    week.topCampaigns = topThree((camps ?? []).map((r) => ({ name: r?.campaign?.name ?? '', spend: num(r?.metrics?.costMicros ?? r?.metrics?.cost_micros) / 1_000_000, conversions: num(r?.metrics?.conversions) })));
  } catch (error) {
    console.error('[zoma-weekly-report] google campaign breakdown skipped:', error instanceof Error ? error.message : error);
  }
  return { platform: 'google_ads', status: 'delivered', ads: week };
}

// ---------------------------------------------------------------------------------------------
// Production wiring
// ---------------------------------------------------------------------------------------------

/**
 * The claim row lives in the loop-events table, whose name is the same in EVERY environment while the users are
 * cloned into dev: a claim written by a non-production deployment must never be mistaken for production's.
 */
export function claimKey(userId: string, week: string, env: NodeJS.ProcessEnv = process.env): string {
  return `${env.NODE_ENV === 'production' ? '' : 'nonprod#'}${userId}#${week}`;
}

export const defaultZomaWeeklyReportDeps: ZomaWeeklyReportDeps = {
  config: () => getZomaWeeklyReportConfig(),
  async listUsers() {
    const { defaultScoreboardDeps } = await import('../services/zomaScoreboard');
    return defaultScoreboardDeps().listZomaUsers();
  },
  async freshRecipient(userId) {
    const { userDb } = await import('../services/db');
    const user = await userDb.getUserByIdConsistent(userId);
    return user?.email ? { email: user.email, optedOut: !!user.zomaWeeklyReportOptOutAt } : undefined;
  },
  hasClaimed: (userId, week) => hasZomaFunnelRow(userId, 'weekly_report_claimed', claimKey(userId, week)),
  claim: (userId, week) => recordZomaBillingFunnel({ userId, step: 'weekly_report_claimed', dedupeKey: claimKey(userId, week) }),
  // Only the Zoma toolkit's rows: Emma's own MCP writes the same event type with product 'emma_mcp'.
  getUsageByUser: (range) => getMcpUsageByUser(range, { product: 'zoma' }),
  async getAdsWeeks(userId, win, opts) {
    const [{ getAccountsByUserIdIncludingOrgShared }, { META_PROVIDER, GOOGLE_ADS_PROVIDER }] = await Promise.all([
      import('../services/connectedAccountsDb'), import('./zomaProviders'),
    ]);
    const now = Date.now();
    const accounts = await getAccountsByUserIdIncludingOrgShared(userId);
    const weeks: PlatformWeek[] = [];
    // Reports the account Zoma itself works on (the first usable one, as zomaProviders resolves it).
    const read = async (platform: AdPlatform, provider: typeof META_PROVIDER, run: (account: any, id: string) => Promise<PlatformWeek>) => {
      const connected = accounts.filter((a) => provider.isAdAccount(a));
      if (!connected.length) return;
      const usable = connected.find((a) => provider.isUsable(a, now));
      const id = usable && provider.accountIds(usable)[0];
      // Connected but expired/revoked: say so, rather than claiming nothing is connected.
      if (!usable || !id) {
        weeks.push({ platform, status: 'unreadable' });
        return;
      }
      try {
        weeks.push(await run(usable, id));
      } catch (error) {
        // Transient: let the next hourly tick try again, until the window's last tick.
        if (!opts.final && !isPermanentReadError(error)) throw error;
        console.error(`[zoma-weekly-report] ${platform} read failed:`, error instanceof Error ? error.message : error);
        weeks.push({ platform, status: 'unreadable' });
      }
    };
    await read('meta', META_PROVIDER, (a, id) => metaWeek(a, id, win));
    await read('google_ads', GOOGLE_ADS_PROVIDER as typeof META_PROVIDER, (_a, id) => googleWeek(userId, id, win));
    return weeks;
  },
  async sendEmail(to, subject, text, html, headers) {
    const { emailService } = await import('../services/emailService');
    return emailService.sendEmail(to, subject, text, html, undefined, headers);
  },
  backendUrl: getBackendUrl,
  secret: () => getJwtSecret(),
  now: () => Date.now(),
};
