/**
 * Real content for the ENG-1312 replay fixtures, fetched at run time (ENG-2135, decision D2).
 *
 * agentModeReplayFixtures.ts stays pure and keeps its synthetic placeholders in git. This module
 * swaps a fixture's `turns` for the real production turn when the golden-set store holds an agent
 * case linked to that fixture (`replay: { fixtureId, messageIndex }`): the user message at
 * `messageIndex` plus the assistant messages that answer it, read from AW-ChatMessages. The
 * threshold, `pending` flag and checker are untouched, so the harness semantics do not change.
 *
 * Falls back to the synthetic fixture (with a note saying why) when the store is not
 * provisioned, no case or more than one case links the fixture, or the turn cannot be read. Real content lives only in
 * memory for the run; nothing is written anywhere.
 */

import AWS from 'aws-sdk';
import { REPLAY_FIXTURES, type JudgeReplayFixture } from './agentModeReplayFixtures';
import type { GoldenSetStore } from './goldenSetStore';

export interface ReplayMessage {
  messageIndex: number;
  role: string;
  content: string;
}

/** Messages of a session from `fromIndex` on, in index order. May stop early once it has read
 * past the next user message. */
export type ReplayMessageFetcher = (sessionId: string, fromIndex: number) => Promise<ReplayMessage[]>;

export interface LoadedReplayFixtures {
  fixtures: JudgeReplayFixture[];
  /** One line per fixture that kept its placeholder, and why. */
  notes: string[];
}

/** The user turn at `messageIndex` and the assistant turns answering it, or null if absent. */
export function extractReplayTurns(messages: readonly ReplayMessage[], messageIndex: number): JudgeReplayFixture['turns'] | null {
  const ordered = [...messages].sort((a, b) => a.messageIndex - b.messageIndex);
  const start = ordered.findIndex((m) => m.messageIndex === messageIndex);
  if (start < 0 || ordered[start].role !== 'user') return null;
  const turns: JudgeReplayFixture['turns'] = [{ role: 'user', content: ordered[start].content }];
  for (const m of ordered.slice(start + 1)) {
    if (m.role === 'user') break;
    if (m.role === 'assistant' && m.content) turns.push({ role: 'assistant', content: m.content });
  }
  return turns.length > 1 ? turns : null;
}

export async function loadReplayFixtures(deps: {
  store: GoldenSetStore;
  fetchMessages?: ReplayMessageFetcher;
  base?: readonly JudgeReplayFixture[];
}): Promise<LoadedReplayFixtures> {
  const base = deps.base ?? REPLAY_FIXTURES;
  if (!deps.store.isProvisioned()) {
    return { fixtures: [...base], notes: ['golden-set store not provisioned: every fixture uses its synthetic placeholder'] };
  }
  const fetchMessages = deps.fetchMessages ?? chatMessagesFetcher();
  const links = new Map<string, Array<{ sessionId: string; messageIndex: number }>>();
  for (const c of await deps.store.listCases('agent')) {
    if (!c.replay) continue;
    const list = links.get(c.replay.fixtureId) ?? [];
    list.push({ sessionId: c.sourceRef.id, messageIndex: c.replay.messageIndex });
    links.set(c.replay.fixtureId, list);
  }

  const notes: string[] = [];
  const fixtures: JudgeReplayFixture[] = [];
  for (const fixture of base) {
    const candidates = links.get(fixture.id) ?? [];
    if (candidates.length !== 1) {
      // Two links would make the checked session depend on store order; fix the store instead.
      notes.push(
        candidates.length === 0
          ? `${fixture.id}: no golden case links this fixture, placeholder kept`
          : `${fixture.id}: linked by ${candidates.length} golden cases, expected one; placeholder kept`,
      );
      fixtures.push(fixture);
      continue;
    }
    const link = candidates[0];
    try {
      const turns = extractReplayTurns(await fetchMessages(link.sessionId, link.messageIndex), link.messageIndex);
      if (!turns) {
        notes.push(`${fixture.id}: linked message is not a user turn with an assistant reply, placeholder kept`);
        fixtures.push(fixture);
      } else {
        fixtures.push({ ...fixture, turns, isPlaceholder: false });
      }
    } catch (error) {
      notes.push(`${fixture.id}: could not read the linked session (${error instanceof Error ? error.message : String(error)}), placeholder kept`);
      fixtures.push(fixture);
    }
  }
  return { fixtures, notes };
}

interface ChatMessageItem {
  messageIndex: number;
  message?: { role?: string; content?: unknown };
}

/** Read-only AW-ChatMessages query (`Dev-` under NODE_ENV=development). Reads the table directly
 * rather than through chatbotDb.getChatSession, which can migrate or repair messages. */
export function chatMessagesFetcher(client: AWS.DynamoDB.DocumentClient = new AWS.DynamoDB.DocumentClient()): ReplayMessageFetcher {
  const table = `${process.env.NODE_ENV === 'development' ? 'Dev-' : ''}AW-ChatMessages`;
  return async (sessionId, fromIndex) => {
    const out: ReplayMessage[] = [];
    let startKey: AWS.DynamoDB.DocumentClient.Key | undefined;
    do {
      const page = await client
        .query({
          TableName: table,
          KeyConditionExpression: 'sessionId = :s AND messageIndex >= :from',
          ExpressionAttributeValues: { ':s': sessionId, ':from': fromIndex },
          Limit: 50,
          ...(startKey ? { ExclusiveStartKey: startKey } : {}),
        })
        .promise();
      for (const item of (page.Items ?? []) as ChatMessageItem[]) {
        const content = item.message?.content;
        out.push({ messageIndex: item.messageIndex, role: item.message?.role ?? '', content: typeof content === 'string' ? content : '' });
      }
      startKey = page.LastEvaluatedKey;
      // Enough once a later user turn closes the reply.
      if (out.some((m) => m.messageIndex > fromIndex && m.role === 'user')) break;
    } while (startKey);
    return out;
  };
}
