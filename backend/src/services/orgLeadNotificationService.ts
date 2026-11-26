import { allowsLeadOrigin, configOf, LeadOrigin } from './leadNotificationConfig';
export type { LeadOrigin, LeadNotificationsConfig } from './leadNotificationConfig';
import { attributionValues, fieldKey, humanizeField, resolveNotificationNames, slackAttributionUrl, submittedPacific } from './leadNotificationAttribution';
import { createHash } from 'crypto';
import { judgeLeadFit } from './leadFitGate';
import { isSmokeTestLead } from '../utils/smokeTestLead';
import { suppressLeadSideEffects } from '../utils/sessionList';
import { WebClient, ChatPostMessageArguments } from '@slack/web-api';
import { crmDb, orgDb, userDb } from './db';
import { dispatchHotLeadCall } from './hotLeadCallService';
import { enqueueJob, markJobComplete, markJobFailed, registerProcessor, startHeartbeat } from './asyncJobQueue';

interface LeadNotificationJob { origin?: LeadOrigin; orgId: string; listId: string; leadId: string; submissionId?: string; submittedAt?: string }
const SOURCE = 'org_lead_notification';
const string = (v: unknown): string => typeof v === 'string' ? v.trim() : '';
const record = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
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

/** Case-insensitive: "@domain" matches the exact domain or its subdomains; anything else is a substring match. */
export function emailExcluded(email: string, patterns?: string[]): boolean {
  const value = email.trim().toLowerCase();
  if (!value || !patterns?.length) return false;
  const domain = value.slice(value.lastIndexOf('@') + 1);
  return patterns.some(raw => {
    const pattern = raw.trim().toLowerCase();
    if (!pattern) return false;
    if (pattern.startsWith('@')) return domain === pattern.slice(1) || domain.endsWith(`.${pattern.slice(1)}`);
    return value.includes(pattern);
  });
}

/** All routing comes from persisted list ownership, never lead.userId/tenantId or form input. */
async function routingContext(listId: string, expectedOrgId?: string) {
  const list = await crmDb.getLeadListById(listId);
  if (!list || list.listId !== listId || !string(list.userId)) return;
  // ENG-2311: a session list's rows are per-visit telemetry. This is the one chokepoint for
  // every Slack lead notification (db.createLead / batch import / webhook resubmission /
  // queue recovery), so gating here covers them all without a read the others would not do.
  if (suppressLeadSideEffects(list)) return;
  const owner = await userDb.getUserById(list.userId);
  if (!owner || owner.userId !== list.userId || !string(owner.orgId) ||
      (expectedOrgId && owner.orgId !== expectedOrgId)) return;
  const org = await orgDb.getOrgById(owner.orgId!);
  if (!org || org.orgId !== owner.orgId) return;
  const config = configOf(org.leadNotifications);
  if (!config?.enabled) return;
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
  // Progressive email capture is a draft; notify only after the form advances.
  if (customFields.stage === 'email') return;
  const source = string(customFields.source) || 'crm';
  const sources = [list.listId, list.name, source,
    ...Object.entries(customFields).filter(([key]) => SOURCE_KEYS.has(normalizedKey(key))).map(([, value]) => value),
  ].map(value => string(value).toLowerCase()).filter(Boolean);
  if (config.sources && !config.sources.some(s => sources.includes(s.trim().toLowerCase()))) return;
  const email = string(lead.email);
  if (emailExcluded(email, config.excludeEmailPatterns)) return;
  const hideEmail = /^noemail\+[^@]*@waterheater\.app$/i.test(email);
  return { ...routing, lead, source, customFields, hideEmail };
}

async function context(listId: string, leadId: string, expectedOrgId?: string) {
  const routing = await routingContext(listId, expectedOrgId);
  return routing && leadContext(routing, leadId);
}

async function message(ctx: NonNullable<Awaited<ReturnType<typeof context>>>, job: LeadNotificationJob) {
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
  const footer = `<${crmUrl}|Open in CRM>`;
  const fields: string[] = [];
  // Keep room for the CRM link even when attribution URLs are unusually long.
  let length = footer.length + 2;
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
  const timestamp = job.submittedAt || string(lead.createdAt);
  const values = attributionValues(lead, !!job.submissionId);
  const value = (...keys: string[]) => keys.map(k => values.get(fieldKey(k)) || '').find(Boolean) || '';
  const attribution = await resolveNotificationNames(list.userId, values, timestamp, ctx.org.connected_accounts);
  append('Attribution:');
  const detail = (label: string, text: string) => {
    if (text) append(`${label}: ${render(text)}`);
  };
  const landing = [render(attribution.landingName), slackAttributionUrl(attribution.landingUrl)].filter(Boolean).join(' — ');
  if (landing) append(`Landing page: ${landing}`);
  detail('Lead list', string(list.name));
  detail('Campaign', attribution.campaign);
  detail('Ad set', attribution.adSet);
  detail('Ad', attribution.ad);
  detail('Source / Medium', [value('utm_source', 'source'), value('utm_medium', 'medium')].filter(Boolean).join(' / '));
  const referrer = slackAttributionUrl(value('referrer'));
  if (referrer) append(`Referrer: ${referrer}`);
  detail('Submitted', submittedPacific(timestamp));
  const answerFields: Record<string, unknown> = {};
  for (const key of ['company', 'title', 'notes', 'linkedin']) {
    if (string(lead[key])) answerFields[key] = lead[key];
  }
  // ENG-2936: repeat submissions append notes oldest-first, and render() keeps the first 300
  // chars, so a long earlier note hid the newest one. For a repeat-submission alert, show the
  // newest end of the notes instead.
  const notesText = string(answerFields.notes);
  if (job.submissionId && notesText.length > 300) answerFields.notes = `…${notesText.slice(-299)}`;
  let hasAnswers = false;
  const seen = new Set<string>();
  for (const [key, value] of [...Object.entries(answerFields), ...Object.entries(customFields)]) {
    const normalized = normalizedKey(key);
    if (!normalized || seen.has(normalized) || (OMIT_CUSTOM_KEYS.has(normalized) && !(normalized === 'company' && key in answerFields)) ||
        /^(utm(source|medium|campaign|content|term|id)|landingpage(name|title|url|id|path)?|landingurl|campaign(name|id)?|adset(name|id)?)$/.test(normalized) ||
        ['ad', 'adname', 'adid', 'fbclid', 'gclid', 'referrer', 'medium', 'stage', 'submittedat', 'sourceid', 'lpid'].includes(normalized) || /^[_$]/.test(key) ||
        /^(internal|system|aws|slack)/.test(normalized) ||
        /email|phone|mobile|telephone|token|password|secret|authorization|apikey/.test(normalized)) continue;
    // Never stringify nested objects/arrays: they can contain unvalidated private data.
    const scalar = typeof value === 'string' ? value :
      typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) ? String(value) : '';
    if (!scalar.trim()) continue;
    const rendered = render(scalar);
    if (!rendered.trim()) continue;
    const line = `${render(humanizeField(key), 60)}: ${rendered}`;
    if (!hasAnswers) {
      if (length + line.length + '\n\nForm answers:\n'.length > MAX_MESSAGE_LENGTH) continue;
      append(''); append('Form answers:'); hasAnswers = true;
    }
    if (append(line)) {
      seen.add(normalized);
    }
  }
  length -= footer.length + 2;
  append('');
  append(footer);
  for (const id of config.mentions || []) {
    if (!append(`<@${id}>`)) break;
  }
  return fields.join('\n');
}

/** Immediate bounded retries; the existing queue recovers interrupted/exhausted jobs, not lead polling. */
export async function processLeadNotificationJob(job: LeadNotificationJob): Promise<void> {
  if (!record(job) || !string(job.orgId) || !string(job.listId) || !string(job.leadId)) throw new Error('Invalid lead notification job');
  const ctx = await context(job.listId, job.leadId, job.orgId);
  if (!ctx || !allowsLeadOrigin(ctx.config, job.origin)) return;
  await deliverLeadNotification(job, ctx);
}

async function deliverLeadNotification(job: LeadNotificationJob, ctx: NonNullable<Awaited<ReturnType<typeof context>>>) {
  const step = stepOf(job);
  if (ctx.lead.system?.[step] === 'sent') return;
  if (await suppressedByFitGate(job, ctx, step)) return;
  if (!await crmDb.claimLeadStepOnce(job.listId, job.leadId, step)) throw new Error('Lead notification claimed');
  let sent = false;
  try {
    const client = new WebClient(ctx.connection.access_token, {
      timeout: 8000, retryConfig: { retries: 0 }, rejectRateLimitedCalls: true,
    });
    const renderedMessage = await message(ctx, job);
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
          channel: ctx.config.slackChannelId, text: renderedMessage,
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

/**
 * ENG-2876: judged once per delivery key; a recorded verdict is reused on queue retries.
 * Notification-only: the lead stays in the CRM, labeled `leadFit: bad`. Fails open.
 */
async function suppressedByFitGate(job: LeadNotificationJob, ctx: NonNullable<Awaited<ReturnType<typeof context>>>, step: string): Promise<boolean> {
  const gate = ctx.config.fitGate;
  if (!gate?.enabled) return false;
  const fitKey = `${step}_fit`;
  const prior = ctx.lead.system?.[fitKey];
  if (prior === 'bad') return true;
  if (prior === 'good' || prior === 'maybe') return false;
  const result = await judgeLeadFit(ctx.lead, ctx.customFields, gate, ctx.list.userId);
  if (!result) return false;
  try {
    await crmDb.setLeadFields(job.listId, job.leadId, {
      system: { [fitKey]: result.verdict },
      ...(result.verdict === 'bad' ? { customFields: { leadFit: 'bad', leadFitReasons: result.reasons.join('; ') } } : {}),
    });
  } catch {
    console.warn('[leadNotifications] fit verdict not recorded', { listId: job.listId, leadId: job.leadId });
  }
  if (result.verdict === 'bad') {
    console.info('[leadNotifications] suppressed by fit gate', { orgId: job.orgId, listId: job.listId, leadId: job.leadId });
    return true;
  }
  return false;
}

/** Never rejects to a lead saver. Call fire-and-forget immediately after a successful write. */
export async function dispatchLeadCreated(listId: string, leadId: string, origin?: LeadOrigin, submission?: { submissionId: string; submittedAt: string }): Promise<void> {
  // First, so orgs without Slack (dispatchLead returns early) still reach it. Never rejects, never awaited.
  void dispatchHotLeadCall(listId, leadId, origin, submission);
  await dispatchLead(listId, leadId, origin, submission);
}

/** One upfront routing lookup to filter imports; at most five active delivery pipelines. */
export async function dispatchLeadsCreated(listId: string, leadIds: string[], origin?: LeadOrigin): Promise<void> {
  if (!leadIds.length) return;
  try {
    const routing = await routingContext(listId);
    if (!routing || !allowsLeadOrigin(routing.config, origin)) return;
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(5, leadIds.length) }, async () => {
      while (next < leadIds.length) {
        const leadId = leadIds[next++];
        await dispatchLead(listId, leadId, origin, undefined, routing);
      }
    }));
  } catch {
    console.warn('[leadNotifications] batch dispatch failed', { listId });
  }
}

async function dispatchLead(
  listId: string, leadId: string, origin?: LeadOrigin,
  submission?: { submissionId: string; submittedAt: string },
  routing?: RoutingContext,
): Promise<void> {
  try {
    const ctx = routing ? await leadContext(routing, leadId) : await context(listId, leadId);
    if (!ctx || !allowsLeadOrigin(ctx.config, origin)) return;
    const job = { ...submission, orgId: ctx.org.orgId, listId, leadId, origin };
    const key = keyOf(job);
    const queued = await enqueueJob(SOURCE, key, job, { claimImmediately: true });
    if (queued === 'duplicate') return;
    if (queued !== 'enqueued') throw new Error('Lead notification queue unavailable');
    const stop = startHeartbeat(SOURCE, key);
    try {
      // Re-read settings at delivery too, including when an import is already queued.
      await processLeadNotificationJob(job);
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
