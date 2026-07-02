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
import { getNotionCredentials } from '../../../services/notionService';
import type { AiEvalProposalPayload } from './rules';
import { aiEvalManifest } from './manifest';
import { enrichWithRCA, type RcaEnrichment } from './rcaEnricher';

const NOTION_API_URL = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

// Sprint Tasks data source (Argusoft). Matches the destination used for the
// manually-created cloud-dev tasks during this session.
const SPRINT_TASKS_DATA_SOURCE = '2bf09247-c951-812a-bd0a-000bd4c05bbf';

interface NotionDigestToolOptions {
  /** Override the Notion API token. Defaults to loading from
   * `prod/AgentWeb/Notion` / `dev/AgentWeb/Notion` via Secrets Manager —
   * same pattern as `services/notionService.ts`. */
  token?: string;
  /** Override the data-source ID. */
  dataSourceId?: string;
  /** Inject a custom RCA enricher (used by tests). Defaults to the real
   * Bedrock-backed `enrichWithRCA`. */
  enricher?: (
    proposal: MutationProposal<AiEvalProposalPayload>,
    mutationSurface: readonly { key: string; kind: string }[],
  ) => Promise<RcaEnrichment>;
}

export class NotionDigestTool implements MutationTools<AiEvalProposalPayload> {
  private readonly tokenOverride: string | undefined;
  private readonly dataSourceId: string;
  private readonly enricher: NonNullable<NotionDigestToolOptions['enricher']>;

  constructor(options: NotionDigestToolOptions = {}) {
    this.tokenOverride = options.token;
    this.dataSourceId = options.dataSourceId ?? SPRINT_TASKS_DATA_SOURCE;
    this.enricher = options.enricher ?? enrichWithRCA;
  }

  private async getToken(): Promise<string | null> {
    if (this.tokenOverride) return this.tokenOverride;
    try {
      const { apiToken } = await getNotionCredentials();
      return apiToken;
    } catch (err) {
      console.error('[NotionDigestTool] Failed to load Notion credentials:', String(err));
      return null;
    }
  }

  async apply(proposal: MutationProposal<AiEvalProposalPayload>): Promise<Mutation> {
    const mutationId = asMutationId(`${proposal.proposalId}:mutation`);
    const token = await this.getToken();
    if (!token) {
      return {
        mutationId,
        proposalId: proposal.proposalId,
        kind: proposal.kind,
        artifact: {},
        error: 'Notion credentials not available (prod/AgentWeb/Notion or dev/AgentWeb/Notion secret missing/empty)',
      };
    }

    const title = this.buildTitle(proposal);

    // Dedup: the loop fires the same rule every cron tick, so without this it
    // files a fresh Notion task for (e.g.) capture-broken every single day.
    // If an OPEN task already exists for this rule, skip — return a pointer to
    // it instead of creating a duplicate. Done so BEFORE RCA enrichment to also
    // save the Bedrock call. (Best-effort: a search failure falls through to
    // create — better a rare duplicate than a dropped task.)
    const existing = await this.findOpenDuplicate(proposal.sourceRuleId, token);
    if (existing) {
      return {
        mutationId,
        proposalId: proposal.proposalId,
        kind: proposal.kind,
        artifact: {
          notionPageId: existing.id,
          notionUrl: existing.url,
          title,
          deduped: true,
        },
      };
    }

    // Enrich with RCA BEFORE building the body. The enricher never throws —
    // it returns a graceful error envelope on any failure path, so the Notion
    // task is always created (the failure mode is "task body says RCA
    // unavailable", not "no task created").
    const enrichment = await this.enricher(proposal, aiEvalManifest.mutationSurface);
    const body = this.buildBody(proposal, enrichment);

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
            Authorization: `Bearer ${token}`,
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
          // Thread the RCA enrichment back to the cron so the Slack DM can
          // render the top-fix line without re-calling Bedrock.
          rcaEnrichment: enrichment,
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
        artifact: { title, rcaEnrichment: enrichment },
        error: errorText,
      };
    }
  }

  /** Find an OPEN (non-Done) task already filed for this rule, so we don't file
   * a duplicate every cron tick. Matches on the stable title prefix
   * `fix(ai-eval-funnel): <ruleId> `. Returns null on no match OR on any search
   * error (dedup must never block task creation). A previously-Done task does
   * NOT count — if the issue recurs after being fixed, a fresh task is wanted. */
  private async findOpenDuplicate(
    ruleId: string,
    token: string,
  ): Promise<{ id: string; url: string } | null> {
    try {
      const resp = await axios.post(
        `${NOTION_API_URL}/data_sources/${this.dataSourceId}/query`,
        {
          filter: { property: 'Name', title: { contains: `fix(ai-eval-funnel): ${ruleId} ` } },
          page_size: 20,
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'Notion-Version': NOTION_VERSION,
            'Content-Type': 'application/json',
          },
          timeout: 15_000,
        },
      );
      const results = ((resp.data as { results?: unknown[] })?.results ?? []) as Array<{
        id?: string;
        url?: string;
        properties?: { Status?: { status?: { name?: string } | null } };
      }>;
      const open = results.find((p) => p.properties?.Status?.status?.name !== 'Done');
      if (open) {
        return {
          id: open.id ?? '',
          url: open.url ?? `https://www.notion.so/${(open.id ?? '').replace(/-/g, '')}`,
        };
      }
      return null;
    } catch (err) {
      console.warn('[NotionDigestTool] dedup search failed (creating anyway):', String(err));
      return null;
    }
  }

  private buildTitle(p: MutationProposal<AiEvalProposalPayload>): string {
    const first = p.hypothesis.split(/[.!?]\s/)[0].slice(0, 80);
    return `fix(ai-eval-funnel): ${p.sourceRuleId} — ${first}`;
  }

  private priorityFor(p: MutationProposal<AiEvalProposalPayload>): string {
    if (p.sourceRuleId === 'eval-failing') return 'High';
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

  private buildBody(p: MutationProposal<AiEvalProposalPayload>, enrichment?: RcaEnrichment): string {
    const lines: string[] = [
      `**Auto-generated by the ai-eval-funnel closed-loop cron run ${new Date().toISOString()}.**`,
      ``,
      `## Summary`,
      p.hypothesis,
      ``,
    ];

    // RCA section: rendered between Summary and Triggering data when enrichment
    // is present. Acceptance criteria #1 + #2 + #4 on the Notion task.
    if (enrichment) {
      if (enrichment.error) {
        lines.push(`## RCA unavailable`, enrichment.error, ``);
      } else {
        lines.push(`## Root cause hypotheses`);
        for (const h of enrichment.topHypotheses) {
          lines.push(`- ${h}`);
        }
        lines.push(``);
        lines.push(`## Ranked fixes`);
        enrichment.rankedFixes.forEach((fix, i) => {
          lines.push(
            `**${i + 1}. ${fix.title}** — impact: ${fix.impact}, confidence: ${fix.confidence}, cost: ${fix.cost_sp} SP. ${fix.why_this_rank}`,
          );
        });
        lines.push(``);
      }
    }

    lines.push(
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
    );
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
