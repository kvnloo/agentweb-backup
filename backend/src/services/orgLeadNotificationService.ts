import { createHash } from 'crypto';
import { isSmokeTestLead } from '../utils/smokeTestLead';
import { WebClient, ChatPostMessageArguments } from '@slack/web-api';
import { crmDb, orgDb, userDb } from './db';
import { enqueueJob, markJobComplete, markJobFailed, registerProcessor, startHeartbeat } from './asyncJobQueue';

export interface LeadNotificationsConfig {
  enabled: boolean;
  slackChannelId: string;
  /** Case-insensitive persisted list IDs/names or LP/source identifiers; absent means all. */
  sources?: string[];
  maskPhone?: boolean;
  /** Slack user IDs, not arbitrary mrkdwn. */
  mentions?: string[];
  /** Deprecated; only noemail+*@waterheater.app placeholders are hidden. */
  excludeEmailPatterns?: string[];
}
interface LeadNotificationJob { orgId: string; listId: string; leadId: string; submissionId?: string; submittedAt?: string }
const SOURCE = 'org_lead_notification';
const string = (v: unknown): string => typeof v === 'string' ? v.trim() : '';
const record = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string' && x.trim().length > 0);
const escapeSlack = (v: unknown, limit = 300): string => string(v).slice(0, limit)
  .replace(/[\r\n\t\x00-\x1f\x7f]/g, ' ')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/[*~`]|(?<![a-z0-9])_|_(?![a-z0-9])/gi, c => ({ '*': '＊', '_': '＿', '~': '～', '`': '｀' }[c]!));
const normalizedKey = (key: string): string => key.replace(/[^a-z0-9]/gi, '').toLowerCase();
const SOURCE_KEYS = new Set(['source', 'sourceid', 'landingpageid', 'lpid']);
const OMIT_CUSTOM_KEYS = new Set([
  'name', 'firstname', 'lastname', 'fullname', 'company', 'companyname', 'source',
  'id', 'leadid', 'listid', 'listname', 'userid', 'ownerid', 'orgid', 'tenantid',
  'createdat', 'updatedat', 'forwardedat', 'deletedat', 'customfields', 'connectedaccounts',
  'firsttouch', 'lasttouch', 'attribution', '__proto__', 'constructor', 'prototype',
  'organizationid', 'accountowneruserid', 'selectedsenderid', 'syncmetadata', 'metadata',
  'clientip', 'clientuseragent', 'ipaddress', 'useragent', 'metafbp', 'clickids',
  'status', 'contactstatus', 'contactstatusreason', 'contactstatusnote', 'contactstatusupdatedby',
  'heatscore', 'healthscore', 'namecompanykey', 'ttl', 'pk', 'sk', 'tel',
]);
const MAX_MESSAGE_LENGTH = 12000;
const keyOf = (job: LeadNotificationJob): string => createHash('sha256').update(JSON.stringify([job.orgId, job.listId, job.leadId, ...(job.submissionId ? [job.submissionId] : [])])).digest('hex');
// Slack accepts a caller-generated message UUID; keep it identical across retries/recovery.
const messageIdOf = (job: LeadNotificationJob): string => {
  const hex = keyOf(job);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
const stepOf = (job: LeadNotificationJob): string => `leadNotification_${keyOf(job)}`;

export function maskLeadPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return digits.length > 4 ? `***-***-${digits.slice(-4)}` : '***';
}
function configOf(value: unknown): LeadNotificationsConfig | undefined {
  if (!record(value) || value.enabled !== true || (value.maskPhone !== undefined && typeof value.maskPhone !== 'boolean') ||
      typeof value.slackChannelId !== 'string' || !/^[CG][A-Z0-9]+$/.test(value.slackChannelId)) return;
  for (const field of ['sources', 'mentions', 'excludeEmailPatterns']) {
    if (value[field] !== undefined && (!strings(value[field]) || value[field].length > 50 || value[field].some((entry: string) => entry.length > 254))) return;
  }
  if (value.mentions?.some((id: string) => !/^[UW][A-Z0-9]+$/.test(id))) return;
  return value as unknown as LeadNotificationsConfig;
}

/** All routing comes from persisted list ownership, never lead.userId/tenantId or form input. */
async function routingContext(listId: string, expectedOrgId?: string) {
  const list = await crmDb.getLeadListById(listId);
  if (!list || list.listId !== listId || !string(list.userId)) return;
  const owner = await userDb.getUserById(list.userId);
  if (!owner || owner.userId !== list.userId || !string(owner.orgId) ||
      (expectedOrgId && owner.orgId !== expectedOrgId)) return;
  const org = await orgDb.getOrgById(owner.orgId!);
  if (!org || org.orgId !== owner.orgId) return;
  const config = configOf(org.leadNotifications);
  if (!config) return;
  // Only org-owned connections. No personal-account lookup, global bot, or cross-org fallback.
  const accounts: unknown[] = Array.isArray(org.connected_accounts) ? org.connected_accounts : [];
  const slack = accounts.filter(a => record(a) && a.platform === 'slack');
  if (slack.length !== 1) return; // Ambiguous workspace: fail closed.
  const account = slack[0];
  if (!record(account) || !record(account.config)) return;
  const connection = account.config;
  if (connection.account_type !== 'bot' || !/^xoxb-/.test(string(connection.access_token)) ||
      !/^T[A-Z0-9]+$/.test(string(connection.team_id)) || account.account_id !== connection.team_id) return;
  return { org, config, connection, list };
}

type RoutingContext = NonNullable<Awaited<ReturnType<typeof routingContext>>>;
async function leadContext(routing: RoutingContext, leadId: string) {
  const { list, config } = routing;
  const listId = list.listId;
  const lead = await crmDb.getLeadById(listId, leadId, { consistentRead: true });
  if (!lead || lead.listId !== listId || lead.leadId !== leadId) return;
  if (isSmokeTestLead(lead)) return;
  const customFields = record(lead.customFields) ? lead.customFields : {};
  const source = string(customFields.source) || 'crm';
  const sources = [list.listId, list.name, source,
    ...Object.entries(customFields).filter(([key]) => SOURCE_KEYS.has(normalizedKey(key))).map(([, value]) => value),
  ].map(value => string(value).toLowerCase()).filter(Boolean);
  if (config.sources && !config.sources.some(s => sources.includes(s.trim().toLowerCase()))) return;
  const email = string(lead.email);
  const hideEmail = /^noemail\+[^@]*@waterheater\.app$/i.test(email);
  return { ...routing, lead, source, customFields, hideEmail };
}

async function context(listId: string, leadId: string, expectedOrgId?: string) {
  const routing = await routingContext(listId, expectedOrgId);
  return routing && leadContext(routing, leadId);
}

function message(ctx: NonNullable<Awaited<ReturnType<typeof context>>>, job: LeadNotificationJob) {
  const { config, lead, customFields, hideEmail, list } = ctx;
  const name = [string(lead.firstName), string(lead.lastName)].filter(Boolean).join(' ');
  const phone = string(lead.phone);
  const email = string(lead.email);
  // Custom fields can repeat contact data under a free-text field. Apply the same
  // policy there, before escaping; contact-key aliases are excluded below as well.
  const render = (value: unknown, limit = 300): string => {
    let text = string(value);
    text = text.replace(/(?<![\w.+-])noemail\+[^\s@]*@waterheater\.app(?![\w.-])/gi, '');
    if (config.maskPhone && phone) text = text.split(phone).join(maskLeadPhone(phone));
    return escapeSlack(text, limit);
  };
  const crmUrl = `${(process.env.CUSTOMER_FRONTEND_URL || 'https://app.agentweb.pro').replace(/\/$/, '')}/crm?listId=${encodeURIComponent(job.listId)}&leadId=${encodeURIComponent(job.leadId)}`;
  const fields: string[] = [];
  let length = 0;
  const append = (line: string): boolean => {
    const size = line.length + (fields.length ? 1 : 0);
    if (length + size > MAX_MESSAGE_LENGTH) return false;
    fields.push(line);
    length += size;
    return true;
  };
  append('New lead:');
  if (name) append(`Name: ${render(name, name.length)}`);
  if (phone) append(`Phone: ${config.maskPhone ? maskLeadPhone(phone) : escapeSlack(phone, phone.length)}`);
  if (email && !hideEmail) append(`Email: ${escapeSlack(email, email.length)}`);
  append('');
  if (string(list.name)) append(`Lead list: ${render(list.name)}`);
  if (string(customFields.source)) append(`Source: ${render(customFields.source)}`);
  if (string(lead.company)) append(`Company: ${render(lead.company)}`);
  const timestamp = job.submittedAt || string(lead.createdAt);
  if (timestamp) append(`${job.submittedAt ? 'Submitted' : 'Created'}: ${render(timestamp)}`);
  append(`<${crmUrl}|Open in CRM>`);
  const first = record(lead.firstTouch) ? lead.firstTouch : {};
  const last = record(lead.lastTouch) ? lead.lastTouch : {};
  const touches = job.submissionId ? [last, first] : [first, last];
  const touchValue = (key: string) => touches.map(t => string(t[key])).find(Boolean) || '';
  const touchBag = (key: string): Record<string, string> => Object.fromEntries(
    [...touches].reverse().flatMap(t => record(t[key])
      ? Object.entries(t[key]).filter((entry): entry is [string, string] => !!string(entry[1])) : []),
  );
  const utm = touchBag('utm');
  const attributionFields: Record<string, unknown> = {};
  for (const key of ['source', 'medium', 'campaign', 'term', 'content', 'id']) {
    const fallback = key === 'source' ? lead.utmSource : key === 'medium' ? lead.utmMedium : undefined;
    const value = string(utm[key]) || string(fallback);
    if (value) attributionFields[`utm_${key}`] = value;
  }
  for (const key of ['landingUrl', 'referrer']) {
    if (touchValue(key)) attributionFields[key] = touchValue(key);
  }
  const clickIds = touchBag('clickIds');
  const fallbackClicks = record(lead.clickIds) ? lead.clickIds : {};
  for (const key of ['fbclid', 'gclid']) {
    const value = string(clickIds[key]) || string(fallbackClicks[key]);
    if (value) attributionFields[key] = value;
  }
  const extras = touchBag('extraParams');
  for (const [key, value] of Object.entries(extras)) {
    if (/^(landingpage(name|url|path|id)|campaign(name|id)?|ad(name|id|setname|setid)?|utm(id|campaign|content|term))$/.test(normalizedKey(key)) && string(value)) {
      attributionFields[key] = value;
    }
  }
  for (const key of ['title', 'notes', 'linkedin']) {
    if (string(lead[key])) attributionFields[key] = lead[key];
  }
  const seen = new Set<string>();
  for (const [key, value] of [...Object.entries(attributionFields), ...Object.entries(customFields)]) {
    const normalized = normalizedKey(key);
    if (!normalized || seen.has(normalized) || OMIT_CUSTOM_KEYS.has(normalized) || /^[_$]/.test(key) ||
        /^(internal|system|aws|slack)/.test(normalized) ||
        /email|phone|mobile|telephone|token|password|secret|authorization|apikey/.test(normalized)) continue;
    // Never stringify nested objects/arrays: they can contain unvalidated private data.
    const scalar = typeof value === 'string' ? value :
      typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) ? String(value) : '';
    if (!scalar.trim()) continue;
    const rendered = render(scalar);
    if (!rendered.trim()) continue;
    if (append(`${render(key, 60)}: ${rendered}`)) {
      seen.add(normalized);
    }
  }
  for (const id of config.mentions || []) {
    if (!append(`<@${id}>`)) break;
  }
  return fields.join('\n');
}

/** Immediate bounded retries; the existing queue recovers interrupted/exhausted jobs, not lead polling. */
export async function processLeadNotificationJob(job: LeadNotificationJob): Promise<void> {
  if (!record(job) || !string(job.orgId) || !string(job.listId) || !string(job.leadId)) throw new Error('Invalid lead notification job');
  const ctx = await context(job.listId, job.leadId, job.orgId);
  if (!ctx) return;
  await deliverLeadNotification(job, ctx);
}

async function deliverLeadNotification(job: LeadNotificationJob, ctx: NonNullable<Awaited<ReturnType<typeof context>>>) {
  const step = stepOf(job);
  if (ctx.lead.system?.[step] === 'sent') return;
  if (!await crmDb.claimLeadStepOnce(job.listId, job.leadId, step)) throw new Error('Lead notification claimed');
  let sent = false;
  try {
    const client = new WebClient(ctx.connection.access_token, {
      timeout: 8000, retryConfig: { retries: 0 }, rejectRateLimitedCalls: true,
    });
    let authenticated = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (!authenticated) {
          const auth = await client.auth.test();
          if (!auth.ok || !auth.bot_id || auth.team_id !== ctx.connection.team_id) throw new Error('Slack workspace mismatch');
          authenticated = true;
        }
        // Use the Emma bot's identity; username overrides require chat:write.customize.
        const payload: ChatPostMessageArguments & { client_msg_id: string } = {
          channel: ctx.config.slackChannelId, text: message(ctx, job),
          client_msg_id: messageIdOf(job), unfurl_links: false, unfurl_media: false, parse: 'none',
        };
        const result = await client.chat.postMessage(payload);
        if (!result.ok || !result.ts) throw new Error('Slack rejected lead notification');
        sent = true;
        break;
      } catch (error) {
        if (attempt === 2) throw error;
        // Respect Slack Retry-After. Longer rate limits defer to durable recovery.
        const retryAfter = record(error) && typeof error.retryAfter === 'number' ? error.retryAfter * 1000 : 0;
        if (retryAfter > 10000) throw error;
        await new Promise(resolve => setTimeout(resolve, Math.max(1000 * 2 ** attempt, retryAfter)));
      }
    }
    // Do not retry Slack if only the success-marker write fails.
    for (let attempt = 0; ; attempt++) {
      try {
        await crmDb.setLeadFields(job.listId, job.leadId, { system: { [step]: 'sent' } });
        break;
      } catch (error) {
        if (attempt === 2) {
          // Slack acknowledged delivery. Complete the queue job even if this
          // secondary marker is unavailable; scheduling another send would duplicate it.
          console.warn('[leadNotifications] sent marker unavailable', { listId: job.listId, leadId: job.leadId });
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 200 * 2 ** attempt));
      }
    }
  } catch (error) {
    if (!sent) await crmDb.setLeadFields(job.listId, job.leadId, { removeSystemKeys: [step] });
    throw error;
  }
}

/** Never rejects to a lead saver. Call fire-and-forget immediately after a successful write. */
export async function dispatchLeadCreated(listId: string, leadId: string, submission?: { submissionId: string; submittedAt: string }): Promise<void> {
  await dispatchLead(listId, leadId, submission);
}

/** One routing lookup and at most five active pipelines for an entire import. */
export async function dispatchLeadsCreated(listId: string, leadIds: string[]): Promise<void> {
  if (!leadIds.length) return;
  try {
    const routing = await routingContext(listId);
    if (!routing) return;
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(5, leadIds.length) }, async () => {
      while (next < leadIds.length) {
        const leadId = leadIds[next++];
        await dispatchLead(listId, leadId, undefined, routing);
      }
    }));
  } catch {
    console.warn('[leadNotifications] batch dispatch failed', { listId });
  }
}

async function dispatchLead(
  listId: string, leadId: string,
  submission?: { submissionId: string; submittedAt: string },
  routing?: RoutingContext,
): Promise<void> {
  try {
    const ctx = routing ? await leadContext(routing, leadId) : await context(listId, leadId);
    if (!ctx) return;
    const job = { orgId: ctx.org.orgId, listId, leadId, ...submission };
    const key = keyOf(job);
    const queued = await enqueueJob(SOURCE, key, job, { claimImmediately: true });
    if (queued === 'duplicate') return;
    if (queued !== 'enqueued') throw new Error('Lead notification queue unavailable');
    const stop = startHeartbeat(SOURCE, key);
    try {
      // Batch delivery reuses its validated routing; recovered jobs always reload it.
      if (routing) await deliverLeadNotification(job, ctx);
      else await processLeadNotificationJob(job);
      await markJobComplete(SOURCE, key);
    } catch {
      // Never put contact details, bot tokens, or raw Slack errors into queue logs.
      await markJobFailed(SOURCE, key, new Error('Lead notification delivery failed'));
    } finally { stop(); }
  } catch {
    console.warn('[leadNotifications] dispatch failed', { listId, leadId });
  }
}
export function registerLeadNotificationProcessor(): void {
  registerProcessor(SOURCE, processLeadNotificationJob, { maxAttempts: 15 });
}
