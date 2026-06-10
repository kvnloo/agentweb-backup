import { WebClient } from '@slack/web-api';
import { isDispatched, markDispatched } from './loopDispatchTracker';
import { getNotionCredentials, getSprintTasksDatabaseId } from './notionService';

/** Harsha's Slack user ID. The only user the reaction handler dispatches for. */
const LOOP_APPROVAL_USER_ID = process.env.LOOP_APPROVAL_SLACK_USER_ID || 'U08TM4QFQ1L';

/** All digest DMs that advertise this footer opt into the shared approval path. */
const LOOP_DISPATCH_FOOTER = 'React ✅ to dispatch all to cloud-dev';

/** Back-compat marker for the AI Readiness parser while loop digests are text-only. */
const AI_READINESS_DM_MARKER = 'AI Readiness Funnel — daily run';

/** Sprint Tasks data source ID, matches notionDigestTool.ts. */
const SPRINT_TASKS_DATA_SOURCE = '2bf09247-c951-812a-bd0a-000bd4c05bbf';

interface ReactionItem {
  type?: string;
  channel?: string;
  ts?: string;
}

export interface ReactionAddedEvent {
  type: 'reaction_added';
  reaction?: string;
  user?: string;
  item?: ReactionItem;
}

interface ReactedMessage {
  text: string;
  user?: string;
  bot_id?: string;
}

interface LoopDispatchTask {
  id: string;
  title: string;
  body: string;
  sourceLabel: string;
}

interface DispatchResult {
  title: string;
  ok: boolean;
  url?: string;
  error?: string;
}

// Cached Emma bot user ID (fetched lazily via auth.test on first use).
let emmaBotUserId: string | null = null;

export function _resetLoopApprovalForTesting(): void {
  emmaBotUserId = null;
}

export async function getEmmaBotUserId(): Promise<string | null> {
  if (emmaBotUserId) return emmaBotUserId;
  try {
    const slackClient = new WebClient(process.env.SLACK_BOT_TOKEN);
    const authResult = await slackClient.auth.test();
    emmaBotUserId = (authResult.user_id as string) ?? null;
    console.log('🤖 Emma bot user ID cached:', emmaBotUserId);
  } catch (err) {
    console.warn('⚠️ Could not fetch Emma bot user ID:', err);
  }
  return emmaBotUserId;
}

/**
 * Extract Notion page IDs from a Slack DM body. Notion URLs render in Slack as
 * `<https://www.notion.so/<slug>-<32-hex-id>|<label>>`; the final 32-hex
 * segment before `|` is the page id, dashes stripped.
 */
function extractNotionPageIds(text: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const re = /notion\.so\/[^|>\s]*-([a-f0-9]{32})/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const id = match[1].toLowerCase();
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

/**
 * Look up the reacted-to message via conversations.history (limit=1,
 * inclusive=true on the exact ts). Returns null on any Slack error.
 */
async function fetchReactedMessage(channel: string, ts: string): Promise<ReactedMessage | null> {
  const slackClient = new WebClient(process.env.SLACK_BOT_TOKEN);
  try {
    const resp = await slackClient.conversations.history({
      channel,
      latest: ts,
      oldest: ts,
      limit: 1,
      inclusive: true,
    });
    const msg = resp.messages?.[0] as { text?: string; user?: string; bot_id?: string } | undefined;
    if (!msg) return null;
    return { text: msg.text ?? '', user: msg.user, bot_id: msg.bot_id };
  } catch (err: unknown) {
    const errorObj = err as { data?: { error?: string; needed?: string }; message?: string };
    const slackCode = errorObj?.data?.error;
    if (slackCode === 'missing_scope' || /missing_scope/.test(errorObj?.message ?? '')) {
      console.error(
        `❌ Slack loop approval handler: missing_scope from conversations.history. ` +
          `reactions:read scope required — add via Slack app manifest at ` +
          `api.slack.com/apps/<appId>/oauth?scopes. Needed: ${errorObj?.data?.needed ?? 'reactions:read'}`,
      );
    } else {
      console.error('❌ Slack loop approval handler: conversations.history failed:', err);
    }
    return null;
  }
}

function extractRunId(text: string): string {
  const match = text.match(/Run ID:\s*`?([^`\n]+)`?/i);
  return match?.[1]?.trim() || 'unknown-run';
}

function extractDigestTitle(text: string): string {
  const firstLine = text.split('\n').find((line) => line.trim().length > 0)?.trim() || 'Loop digest';
  return firstLine
    .replace(/^\*|\*$/g, '')
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .trim();
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || 'loop-task';
}

function loopSlugFromTitle(title: string): string {
  const beforeDash = title.split(/\s+[—-]\s+/)[0] || title;
  return slugify(beforeDash);
}

function taskBlocksFromText(text: string): Array<Record<string, unknown>> {
  return text.split('\n').map((line) => ({
    object: 'block',
    type: line.startsWith('- ') ? 'bulleted_list_item' : 'paragraph',
    [line.startsWith('- ') ? 'bulleted_list_item' : 'paragraph']: {
      rich_text: [{ type: 'text', text: { content: line.slice(0, 1900) } }],
    },
  }));
}

function extractAiReadinessDispatchTasks(text: string): LoopDispatchTask[] {
  const runId = extractRunId(text);
  const tasks: LoopDispatchTask[] = [];
  const seen = new Set<string>();

  const lowDataRe =
    /\d+\.\s+`?([a-z0-9-]+)`?\s+[—-]\s+([^\n]+)\n\s*Evidence:\s*([^|]+?)\s*\|\s*Confidence:\s*([^|]+?)\s*\|\s*Needs approval:\s*yes/gi;
  let lowDataMatch: RegExpExecArray | null;
  while ((lowDataMatch = lowDataRe.exec(text)) !== null) {
    const id = lowDataMatch[1].trim();
    if (seen.has(id)) continue;
    seen.add(id);
    const action = lowDataMatch[2].trim();
    const evidence = lowDataMatch[3].trim();
    const confidence = lowDataMatch[4].trim();
    tasks.push({
      id,
      title: `fix(ai-readiness-funnel): ${id}`,
      sourceLabel: 'AI Readiness',
      body: [
        `Auto-generated from AI Readiness Funnel Slack approval.`,
        ``,
        `Run ID: ${runId}`,
        `Decision ID: ${id}`,
        `Evidence: ${evidence}`,
        `Confidence: ${confidence}`,
        ``,
        `Requested change: ${action}`,
        ``,
        `Acceptance criteria:`,
        `- Implement the smallest safe change that addresses the decision evidence.`,
        `- Keep behavior measurable through the existing AI Readiness funnel events.`,
        `- Do not require hundreds of data points; ship a permission-gated startup hypothesis with low-data evidence.`,
        `- Include what was not tested in the PR.`,
      ].join('\n'),
    });
  }

  return tasks;
}

function extractGenericDigestTasks(text: string): LoopDispatchTask[] {
  const title = extractDigestTitle(text);
  const loopSlug = loopSlugFromTitle(title);
  const runId = extractRunId(text);
  const tasks: LoopDispatchTask[] = [];

  const itemRe = /^\s*(\d+)\.\s+([^\n]+)(?:\n((?:\s{3,}.+\n?)+))?/gm;
  let match: RegExpExecArray | null;
  while ((match = itemRe.exec(text)) !== null) {
    const index = Number(match[1]);
    const item = match[2].trim();
    if (/^<https?:\/\/www\.notion\.so\//i.test(item)) continue;

    const details = (match[3] || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const detailText = details.length ? `\n\nDetails:\n${details.map((line) => `- ${line}`).join('\n')}` : '';
    tasks.push({
      id: `${loopSlug}-${runId}-${index}`,
      title: `fix(${loopSlug}): ${item.slice(0, 90)}`,
      sourceLabel: title,
      body: [
        `Auto-generated from ${title} Slack approval.`,
        ``,
        `Run ID: ${runId}`,
        `Digest item: ${item}${detailText}`,
        ``,
        `Requested change: Investigate and implement the smallest safe cloud-dev fix for this loop finding.`,
        ``,
        `Acceptance criteria:`,
        `- Preserve existing loop telemetry and dispatch behavior.`,
        `- Make a useful startup-sized decision from the available evidence; ask Harsha for permission if the change is ambiguous or risky.`,
        `- Include what was not tested in the PR.`,
      ].join('\n'),
    });
  }

  const seen = new Set<string>();
  return tasks.filter((task) => {
    const key = `${task.title}:${task.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return itemSlugIsActionable(task.title);
  });
}

function itemSlugIsActionable(title: string): boolean {
  return slugify(title.replace(/^fix\([^)]+\):\s*/, '')).length > 0;
}

async function createLoopNotionTask(task: LoopDispatchTask): Promise<{ pageId: string; notionUrl: string }> {
  const { apiToken } = await getNotionCredentials();
  const dataSourceId = await getSprintTasksDatabaseId();
  const tags = task.sourceLabel.includes('AI Readiness')
    ? [{ name: 'Landing Site' }, { name: 'AI Readiness' }]
    : [{ name: 'Auto Loop' }];

  const resp = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Notion-Version': '2025-09-03',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      parent: { type: 'data_source_id', data_source_id: dataSourceId },
      properties: {
        Name: { title: [{ text: { content: task.title.slice(0, 200) } }] },
        Status: { status: { name: 'To-do' } },
        'Priority Level': { select: { name: 'Medium' } },
        'Risk Level': { select: { name: 'Low' } },
        Source: { select: { name: 'Human' } },
        'Sprint Points': { number: 2 },
        Tags: { multi_select: tags },
      },
      children: taskBlocksFromText(task.body),
    }),
  });
  const data = await resp.json();
  if (!resp.ok || data.object === 'error') {
    throw new Error(data.message || `Notion API ${resp.status}`);
  }
  const pageId = data.id as string;
  return {
    pageId,
    notionUrl: (data.url as string | undefined) || `https://notion.so/${pageId.replace(/-/g, '')}`,
  };
}

async function dispatchExistingNotionPages(pageIds: string[]): Promise<DispatchResult[]> {
  const { launchEnvironment, getNotionPage, getNotionPageContent } = await import('./devEnvService');
  const results: DispatchResult[] = [];

  for (const pageId of pageIds) {
    let title = pageId;
    try {
      const page = await getNotionPage(pageId);
      title = page.title || pageId;
      const { text } = await getNotionPageContent(pageId);
      await launchEnvironment(pageId, title, text, SPRINT_TASKS_DATA_SOURCE);
      results.push({ title, ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`❌ loop approval reaction: launchEnvironment failed for ${pageId}:`, err);
      results.push({ title, ok: false, error: message });
    }
  }

  return results;
}

async function dispatchCreatedTasks(tasks: LoopDispatchTask[]): Promise<DispatchResult[]> {
  const { launchEnvironment } = await import('./devEnvService');
  const results: DispatchResult[] = [];
  const dataSourceId = await getSprintTasksDatabaseId();

  for (const task of tasks) {
    try {
      const page = await createLoopNotionTask(task);
      await launchEnvironment(page.pageId, task.title, task.body, dataSourceId);
      results.push({ title: task.title, ok: true, url: page.notionUrl });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`❌ loop approval reaction: dispatch failed for ${task.id}:`, err);
      results.push({ title: task.title, ok: false, error: message });
    }
  }

  return results;
}

function parseDispatchableTasks(text: string): LoopDispatchTask[] {
  if (text.includes(AI_READINESS_DM_MARKER)) {
    const aiReadinessTasks = extractAiReadinessDispatchTasks(text);
    if (aiReadinessTasks.length > 0) return aiReadinessTasks;
  }

  return extractGenericDigestTasks(text);
}

async function postThread(channel: string, ts: string, text: string): Promise<void> {
  const slackClient = new WebClient(process.env.SLACK_BOT_TOKEN);
  await slackClient.chat.postMessage({ channel, thread_ts: ts, text });
}

function formatSummary(loopTitle: string, results: DispatchResult[]): string {
  const successCount = results.filter((r) => r.ok).length;
  const lines = [`✅ Launched ${successCount}/${results.length} cloud-dev run${results.length === 1 ? '' : 's'} for ${loopTitle}:`];
  for (const r of results) {
    lines.push(r.ok ? `  • ${r.title} — launching${r.url ? ` (${r.url})` : ''}` : `  • ${r.title} — ⚠️ Failed: ${r.error ?? 'unknown error'}`);
  }
  return lines.join('\n');
}

export async function handleLoopApprovalReaction(event: ReactionAddedEvent): Promise<void> {
  if (event.reaction !== 'white_check_mark') return;
  if (event.user !== LOOP_APPROVAL_USER_ID) return;

  const item = event.item;
  if (!item || item.type !== 'message' || !item.channel || !item.ts) return;
  if (!item.channel.startsWith('D')) return;

  if (isDispatched(item.ts)) {
    console.log(`🔁 loop approval reaction: ${item.ts} already dispatched — skipping`);
    return;
  }

  const message = await fetchReactedMessage(item.channel, item.ts);
  if (!message) return;

  if (!message.bot_id) {
    const botUserId = await getEmmaBotUserId();
    if (!botUserId || message.user !== botUserId) return;
  }

  if (!message.text.includes(LOOP_DISPATCH_FOOTER)) return;

  const loopTitle = extractDigestTitle(message.text);
  const pageIds = extractNotionPageIds(message.text);

  if (pageIds.length > 0) {
    await postThread(item.channel, item.ts, `🚀 Dispatching ${pageIds.length} cloud-dev run${pageIds.length === 1 ? '' : 's'} for ${loopTitle}...`);
    markDispatched(item.ts, pageIds);
    const results = await dispatchExistingNotionPages(pageIds);
    await postThread(item.channel, item.ts, formatSummary(loopTitle, results));
    return;
  }

  const tasks = parseDispatchableTasks(message.text);
  if (tasks.length === 0) {
    await postThread(
      item.channel,
      item.ts,
      `⚠️ I found a loop approval digest (${loopTitle}), but could not parse any dispatchable tasks from it.`,
    );
    return;
  }

  await postThread(item.channel, item.ts, `🚀 Creating ${tasks.length} cloud-dev task${tasks.length === 1 ? '' : 's'} for ${loopTitle}...`);
  markDispatched(item.ts, tasks.map((t) => t.id));
  const results = await dispatchCreatedTasks(tasks);
  await postThread(item.channel, item.ts, formatSummary(loopTitle, results));
}
