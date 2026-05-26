/**
 * notionDigestTool — implements MutationTools for the lander loop's
 * production path. For each proposal, creates a real Notion task in the
 * Sprint Tasks DB tagged for cloud-dev pickup, with the triggering data +
 * proposed change spec inline.
 *
 * Sibling to SpecOutputTool (in core/) — that one is generic + produces a
 * JSON blob; this one is loop-specific + makes the real API call. Lives in
 * `instances/ai-eval-funnel/` because the cloud-dev integration is
 * agentweb-specific (Notion DB ID, tag names, etc).
 *
 * Errors degrade gracefully: a Notion API outage produces a mutation
 * artifact with `error` set, the orchestrator records it in the
 * LearningStore, and the next cron run retries.
 */

import axios from 'axios';
import type { Mutation, MutationProposal, MutationTools } from '../../core/types';
import { asMutationId } from '../../core/types';
import type { AiEvalProposalPayload } from './rules';

const NOTION_API_URL = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

// Sprint Tasks data source (Argusoft). Matches the destination used for the
// manually-created cloud-dev tasks during this session.
const SPRINT_TASKS_DATA_SOURCE = '2bf09247-c951-812a-bd0a-000bd4c05bbf';

interface NotionDigestToolOptions {
  /** Override the Notion API token. Defaults to NOTION_API_KEY env var. */
  token?: string;
  /** Override the data-source ID. */
  dataSourceId?: string;
}

export class NotionDigestTool implements MutationTools<AiEvalProposalPayload> {
  private readonly token: string | undefined;
  private readonly dataSourceId: string;

  constructor(options: NotionDigestToolOptions = {}) {
    this.token = options.token ?? process.env.NOTION_API_KEY;
    this.dataSourceId = options.dataSourceId ?? SPRINT_TASKS_DATA_SOURCE;
  }

  async apply(proposal: MutationProposal<AiEvalProposalPayload>): Promise<Mutation> {
    const mutationId = asMutationId(`${proposal.proposalId}:mutation`);
    if (!this.token) {
      return {
        mutationId,
        proposalId: proposal.proposalId,
        kind: proposal.kind,
        artifact: {},
        error: 'NOTION_API_KEY env var missing — Notion task not created',
      };
    }

    const title = this.buildTitle(proposal);
    const body = this.buildBody(proposal);

    try {
      const resp = await axios.post(
        `${NOTION_API_URL}/pages`,
        {
          parent: { type: 'data_source_id', data_source_id: this.dataSourceId },
          properties: {
            Name: { title: [{ text: { content: title.slice(0, 200) } }] },
            'Priority Level': { select: { name: this.priorityFor(proposal) } },
            'Risk Level': { select: { name: this.riskFor(proposal) } },
            Source: { select: { name: 'Human' } },
            'Sprint Points': { number: this.spFor(proposal) },
            Tags: { multi_select: [{ name: 'Landing Site' }] },
            Status: { status: { name: 'To-do' } },
          },
          children: this.buildChildren(body),
        },
        {
          headers: {
            Authorization: `Bearer ${this.token}`,
            'Notion-Version': NOTION_VERSION,
            'Content-Type': 'application/json',
          },
          timeout: 15_000,
        },
      );

      const page = resp.data as { id?: string; url?: string };
      return {
        mutationId,
        proposalId: proposal.proposalId,
        kind: proposal.kind,
        artifact: {
          notionPageId: page.id ?? '',
          notionUrl: page.url ?? `https://www.notion.so/${(page.id ?? '').replace(/-/g, '')}`,
          title,
        },
      };
    } catch (err) {
      const e = err as { response?: { status?: number; data?: unknown }; message?: string };
      const errorText =
        e.response?.status != null
          ? `Notion API ${e.response.status}: ${JSON.stringify(e.response.data).slice(0, 300)}`
          : e.message ?? String(err);
      return {
        mutationId,
        proposalId: proposal.proposalId,
        kind: proposal.kind,
        artifact: { title },
        error: errorText,
      };
    }
  }

  private buildTitle(p: MutationProposal<AiEvalProposalPayload>): string {
    const first = p.hypothesis.split(/[.!?]\s/)[0].slice(0, 80);
    return `fix(ai-eval-funnel): ${p.sourceRuleId} — ${first}`;
  }

  private priorityFor(p: MutationProposal<AiEvalProposalPayload>): string {
    if (p.sourceRuleId === 'eval-failing' || p.sourceRuleId === 'complaint-received') return 'High';
    if (p.sourceRuleId === 'top-of-funnel-cold' || p.sourceRuleId === 'capture-broken') return 'High';
    if (p.sourceRuleId === 'wait-too-long') return 'Medium';
    return 'Medium';
  }

  private riskFor(p: MutationProposal<AiEvalProposalPayload>): string {
    return p.kind === 'code_change' ? 'Medium' : 'Low';
  }

  private spFor(p: MutationProposal<AiEvalProposalPayload>): number {
    return p.kind === 'code_change' ? 3 : 2;
  }

  private buildBody(p: MutationProposal<AiEvalProposalPayload>): string {
    const lines: string[] = [
      `**Auto-generated by the ai-eval-funnel closed-loop cron run ${new Date().toISOString()}.**`,
      ``,
      `## Summary`,
      p.hypothesis,
      ``,
      `## Triggering data`,
      '```json',
      JSON.stringify(p.triggeringStats, null, 2),
      '```',
      ``,
      `## Proposed change`,
      '```json',
      JSON.stringify(p.payload, null, 2),
      '```',
      ``,
      `## How Harsha decides`,
      `React on the daily Slack DM (✅ ship / ❌ skip / 🛑 pause loop) or reply in thread.`,
      `If the proposal is autoShipSafe=true and no response by 6pm PT cutoff, the watchdog auto-ships.`,
    ];
    return lines.join('\n');
  }

  /** Convert markdown body to a flat list of Notion paragraph + code blocks. */
  private buildChildren(body: string): Array<Record<string, unknown>> {
    const children: Array<Record<string, unknown>> = [];
    const lines = body.split('\n');
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (line.startsWith('```')) {
        const lang = line.slice(3).trim() || 'plain text';
        const codeLines: string[] = [];
        i++;
        while (i < lines.length && !lines[i].startsWith('```')) {
          codeLines.push(lines[i]);
          i++;
        }
        i++;
        children.push({
          object: 'block',
          type: 'code',
          code: {
            rich_text: [{ type: 'text', text: { content: codeLines.join('\n').slice(0, 2000) } }],
            language: lang === 'json' ? 'json' : 'plain text',
          },
        });
      } else if (line.startsWith('## ')) {
        children.push({
          object: 'block',
          type: 'heading_2',
          heading_2: { rich_text: [{ type: 'text', text: { content: line.slice(3).slice(0, 200) } }] },
        });
        i++;
      } else if (line.trim() === '') {
        i++;
      } else {
        children.push({
          object: 'block',
          type: 'paragraph',
          paragraph: { rich_text: [{ type: 'text', text: { content: line.slice(0, 2000) } }] },
        });
        i++;
      }
    }
    return children;
  }
}
