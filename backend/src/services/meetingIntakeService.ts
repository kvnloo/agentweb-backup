/**
 * Meeting Intake Service
 *
 * Processes meeting transcripts and routes action items to the correct systems:
 *   - eng-task       → Notion sprint board
 *   - delivery-task  → ClickUp CEO board
 *   - feature-request → Featurebase feature board
 *   - ignore         → skipped
 *
 * Classification is keyword/pattern-based for speed (no LLM call).
 * Deduplication uses simple bigram similarity (>80% → skip).
 */

import axios from 'axios';
import {
  CreateFeaturebasePostParams,
  CreateFeaturebasePostResult,
  createFeaturebasePost,
} from './featurebaseService';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ClassifiedItem {
  description: string;
  type: 'eng-task' | 'delivery-task' | 'feature-request' | 'ignore';
  priority: 'High' | 'Medium' | 'Low';
  assignee?: string;
  client_account?: string;
  raw_text: string;
}

export interface MeetingData {
  meetingTitle: string;
  timestamp: string;
  participants: string[];
  actionItems: string[];
}

export interface CreatedTaskResult {
  description: string;
  type: ClassifiedItem['type'];
  destination: 'notion' | 'clickup' | 'featurebase';
  externalId?: string;
}

export interface SkippedItemResult {
  description: string;
  reason: 'ignored' | 'duplicate';
}

export interface RoutingResult {
  meetingTitle: string;
  processedAt: string;
  created: CreatedTaskResult[];
  skipped: SkippedItemResult[];
}

// ---------------------------------------------------------------------------
// Dependency injection for external APIs (allows test mocking)
// ---------------------------------------------------------------------------

interface NotionTaskPayload {
  title: string;
  status: string;
  priority: string;
  source: string;
  tags: string[];
  planned: string;
  assigneeId: string;
  meetingTitle: string;
  meetingTimestamp: string;
}

interface ClickUpTaskPayload {
  name: string;
  description: string;
  priority: string;
  listId: string;
  meetingTitle: string;
  meetingTimestamp: string;
}

interface ExistingTask {
  title: string;
}

interface Deps {
  createNotionTask: (payload: NotionTaskPayload) => Promise<{ id: string }>;
  createClickUpTask: (payload: ClickUpTaskPayload) => Promise<{ id: string }>;
  createFeaturebasePost: (payload: CreateFeaturebasePostParams) => Promise<CreateFeaturebasePostResult>;
  searchExistingTasks: () => Promise<ExistingTask[]>;
}

// Default implementations that call real APIs
// TODO: Wire up real Notion API integration once credentials are available from backend
const defaultCreateNotionTask = async (payload: NotionTaskPayload): Promise<{ id: string }> => {
  // TODO: Implement real Notion API call
  // POST https://api.notion.com/v1/pages
  // with parent: { database_id: '2bf09247-c951-812a-bd0a-000bd4c05bbf' }
  // Properties: Name, Status, Priority Level, Source, Tags, Planned
  // Assign to Harsha: 1c8d872b-594c-8168-8c1b-00022b54e40d
  console.log('[MeetingIntake] Would create Notion task:', payload.title);
  return { id: 'notion-placeholder' };
};

const defaultCreateClickUpTask = async (payload: ClickUpTaskPayload): Promise<{ id: string }> => {
  // TODO: Wire up real ClickUp API call using clickupService
  // POST https://api.clickup.com/api/v2/list/901326192089/task
  console.log('[MeetingIntake] Would create ClickUp task:', payload.name);
  return { id: 'clickup-placeholder' };
};

const defaultCreateFeaturebasePost = async (
  payload: CreateFeaturebasePostParams,
): Promise<CreateFeaturebasePostResult> => createFeaturebasePost(payload);

const defaultSearchExistingTasks = async (): Promise<ExistingTask[]> => {
  // TODO: Query Notion Master Table view for existing task titles
  // Use view://2bf09247-c951-81c2-bfc0-000cf28e3775
  console.log('[MeetingIntake] Would search existing Notion tasks');
  return [];
};

/**
 * Exported so tests can override via jest.mock.
 * In production code, these are the real implementations.
 */
export const _deps: Deps = {
  createNotionTask: defaultCreateNotionTask,
  createClickUpTask: defaultCreateClickUpTask,
  createFeaturebasePost: defaultCreateFeaturebasePost,
  searchExistingTasks: defaultSearchExistingTasks,
};

// ---------------------------------------------------------------------------
// Classification — keyword/pattern-based
// ---------------------------------------------------------------------------

/** Keywords that signal an engineering task — matched as whole words */
const ENG_KEYWORDS = [
  'code', 'bug', 'fix', 'build', 'deploy', 'api', 'endpoint', 'test',
  'database', 'migration', 'backend', 'frontend', 'ui component',
  'refactor', 'lint', 'pipeline', 'merge', 'branch', 'commit',
  'schema', 'query', 'index', 'performance', 'cache', 'debug',
];

/** Multi-word phrases for engineering (checked via includes) */
const ENG_PHRASES = [
  'pull request', 'unit test', 'ci/cd',
];

/** Keywords that signal a delivery/business task — matched as whole words */
const DELIVERY_KEYWORDS = [
  'send', 'email', 'schedule', 'post', 'update content', 'client deliverable',
  'report', 'follow up', 'follow-up', 'reach out', 'proposal', 'invoice',
  'presentation', 'demo', 'onboard',
];

/** Patterns that signal a feature request */
const FEATURE_PATTERNS = [
  /would be nice/i,
  /can we add/i,
  /feature/i,
  /request/i,
  /wish we had/i,
  /should support/i,
  /integrate with/i,
  /it.d be great/i,
  /we need a/i,
  /we should have/i,
];

/** Patterns that indicate a non-actionable statement (override delivery/eng matches) */
const IGNORE_PATTERNS = [
  /^(great|good|nice|awesome|thanks|thank you|sounds good|yeah|yes|ok|okay)\b/i,
  /^(let'?s talk|see you|talk soon|have a good|bye)/i,
  /that makes sense/i,
  /^(sure|absolutely|definitely|agreed|perfect|cool)\b/i,
];

/** High-priority signal words */
const HIGH_PRIORITY_KEYWORDS = [
  'critical', 'urgent', 'asap', 'blocker', 'production', 'p0', 'hotfix',
  'broken', 'down', 'outage', 'immediately',
];

/** Low-priority signal words */
const LOW_PRIORITY_KEYWORDS = [
  'someday', 'nice to have', 'nice-to-have', 'when we get a chance',
  'low priority', 'eventually', 'backlog', 'would be nice',
];

/**
 * Check if a keyword appears as a whole word in the text.
 * Multi-word keywords use simple includes.
 */
function matchesKeyword(text: string, keyword: string): boolean {
  if (keyword.includes(' ')) {
    // Multi-word: use includes
    return text.includes(keyword);
  }
  // Single word: use word boundary regex
  const re = new RegExp(`\\b${keyword}\\b`, 'i');
  return re.test(text);
}

/**
 * Classify a single action item string into a type and priority.
 */
export function classifyActionItem(text: string): ClassifiedItem {
  const lower = text.toLowerCase();

  // Check feature request patterns first (they're more specific)
  const isFeatureRequest = FEATURE_PATTERNS.some((p) => p.test(lower));

  // Check keyword matches with word-boundary awareness
  const engScore =
    ENG_KEYWORDS.filter((kw) => matchesKeyword(lower, kw)).length +
    ENG_PHRASES.filter((kw) => lower.includes(kw)).length;
  const deliveryScore = DELIVERY_KEYWORDS.filter((kw) => matchesKeyword(lower, kw)).length;

  // Check for non-actionable patterns first (pleasantries, confirmations)
  const isIgnored = IGNORE_PATTERNS.some((p) => p.test(lower));

  // Determine type
  let type: ClassifiedItem['type'];
  if (isIgnored && engScore === 0 && !isFeatureRequest) {
    // If it matches an ignore pattern and has no strong eng/feature signal, skip it
    type = 'ignore';
  } else if (isFeatureRequest && engScore <= 1) {
    type = 'feature-request';
  } else if (engScore > deliveryScore && engScore > 0) {
    type = 'eng-task';
  } else if (deliveryScore > 0 && !isIgnored) {
    type = 'delivery-task';
  } else if (isFeatureRequest) {
    type = 'feature-request';
  } else {
    type = 'ignore';
  }

  // Determine priority
  let priority: ClassifiedItem['priority'] = 'Medium';
  if (HIGH_PRIORITY_KEYWORDS.some((kw) => lower.includes(kw))) {
    priority = 'High';
  } else if (LOW_PRIORITY_KEYWORDS.some((kw) => lower.includes(kw))) {
    priority = 'Low';
  } else if (type === 'feature-request') {
    // Feature requests default to Low unless urgent
    priority = 'Low';
  }

  return {
    description: text,
    type,
    priority,
    raw_text: text,
  };
}

// ---------------------------------------------------------------------------
// Similarity — bigram-based (Dice coefficient)
// ---------------------------------------------------------------------------

function bigrams(str: string): Set<string> {
  const s = str.toLowerCase().trim();
  const result = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) {
    result.add(s.substring(i, i + 2));
  }
  return result;
}

/**
 * Compute Dice coefficient similarity between two strings.
 * Returns a value between 0 and 1.
 */
export function computeSimilarity(a: string, b: string): number {
  const aNorm = a.toLowerCase().trim();
  const bNorm = b.toLowerCase().trim();

  if (aNorm === bNorm) return 1.0;
  if (aNorm.length === 0 || bNorm.length === 0) return 0;

  const aBigrams = bigrams(aNorm);
  const bBigrams = bigrams(bNorm);

  if (aBigrams.size === 0 && bBigrams.size === 0) return 1.0;

  let intersection = 0;
  for (const bg of aBigrams) {
    if (bBigrams.has(bg)) intersection++;
  }

  return (2 * intersection) / (aBigrams.size + bBigrams.size);
}

// ---------------------------------------------------------------------------
// Main processing function
// ---------------------------------------------------------------------------

const DEDUP_THRESHOLD = 0.8;

/**
 * Process meeting action items: classify, deduplicate, and route to
 * Notion or ClickUp.
 */
export async function processActionItems(meeting: MeetingData): Promise<RoutingResult> {
  const result: RoutingResult = {
    meetingTitle: meeting.meetingTitle,
    processedAt: new Date().toISOString(),
    created: [],
    skipped: [],
  };

  if (!meeting.actionItems || meeting.actionItems.length === 0) {
    return result;
  }

  // Fetch existing tasks for dedup
  let existingTasks: ExistingTask[] = [];
  try {
    existingTasks = await _deps.searchExistingTasks();
  } catch (err) {
    console.warn('[MeetingIntake] Failed to fetch existing tasks for dedup:', err);
  }

  for (const rawItem of meeting.actionItems) {
    const classified = classifyActionItem(rawItem);

    // Skip ignored items
    if (classified.type === 'ignore') {
      result.skipped.push({ description: rawItem, reason: 'ignored' });
      continue;
    }

    // Dedup check
    const isDuplicate = existingTasks.some(
      (existing) => computeSimilarity(existing.title, classified.description) >= DEDUP_THRESHOLD
    );
    if (isDuplicate) {
      result.skipped.push({ description: rawItem, reason: 'duplicate' });
      console.log(`[MeetingIntake] Skipped duplicate: "${rawItem}"`);
      continue;
    }

    // Route based on type
    try {
      if (classified.type === 'eng-task') {
        const taskResult = await _deps.createNotionTask({
          title: classified.description,
          status: 'To-do',
          priority: classified.priority,
          source: 'Human',
          tags: ['Improvement'],
          planned: '__NO__',
          assigneeId: '1c8d872b-594c-8168-8c1b-00022b54e40d', // Harsha
          meetingTitle: meeting.meetingTitle,
          meetingTimestamp: meeting.timestamp,
        });

        result.created.push({
          description: classified.description,
          type: 'eng-task',
          destination: 'notion',
          externalId: taskResult.id,
        });
      } else if (classified.type === 'delivery-task') {
        const taskResult = await _deps.createClickUpTask({
          name: classified.description,
          description: `From meeting: ${meeting.meetingTitle} (${meeting.timestamp})\nParticipants: ${meeting.participants.join(', ')}`,
          priority: classified.priority,
          listId: '901326192089',
          meetingTitle: meeting.meetingTitle,
          meetingTimestamp: meeting.timestamp,
        });

        result.created.push({
          description: classified.description,
          type: 'delivery-task',
          destination: 'clickup',
          externalId: taskResult.id,
        });
      } else if (classified.type === 'feature-request') {
        const taskResult = await _deps.createFeaturebasePost({
          title: classified.description,
          description: `From meeting: ${meeting.meetingTitle} (${meeting.timestamp})\nParticipants: ${meeting.participants.join(', ')}`,
          kind: 'feature',
          priority: classified.priority,
          tags: ['Customer Request', 'feature-request', `priority:${classified.priority}`],
          reporter: {
            userId: 'meeting-intake',
            name: 'Meeting intake',
          },
          context: {
            'Meeting Title': meeting.meetingTitle,
            'Meeting Timestamp': meeting.timestamp,
            Participants: meeting.participants.join(', ') || 'N/A',
          },
        });

        result.created.push({
          description: classified.description,
          type: 'feature-request',
          destination: 'featurebase',
          externalId: taskResult.postId,
        });
      }

      console.log(
        `[MeetingIntake] Created ${classified.type} → ${classified.type === 'delivery-task' ? 'ClickUp' : classified.type === 'feature-request' ? 'Featurebase' : 'Notion'}: "${classified.description}"`
      );
    } catch (err) {
      console.error(`[MeetingIntake] Failed to create task for "${rawItem}":`, err);
      // Don't add to created, but don't crash the whole process
    }
  }

  console.log(
    `[MeetingIntake] Processed meeting "${meeting.meetingTitle}": ${result.created.length} created, ${result.skipped.length} skipped`
  );

  return result;
}
