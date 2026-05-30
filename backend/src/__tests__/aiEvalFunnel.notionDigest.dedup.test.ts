/**
 * Tests for NotionDigestTool.apply() search-before-create dedup.
 *
 * The ai-eval-funnel loop fires the same rule every cron tick, so without a
 * dedup check it files a fresh Notion task for (e.g.) capture-broken every day.
 * apply() must first search for an OPEN task for the rule and skip creation if
 * one exists — while still creating when none exists, when only a Done task
 * exists (regression), or when the search itself fails (best-effort).
 */

jest.mock('axios', () => ({ __esModule: true, default: { post: jest.fn() } }));

import axios from 'axios';
import { NotionDigestTool } from '../loops/instances/ai-eval-funnel/notionDigestTool';
import type { MutationProposal } from '../loops/core/types';
import { asMutationId } from '../loops/core/types';
import type { AiEvalProposalPayload } from '../loops/instances/ai-eval-funnel/rules';

const mockPost = (axios as unknown as { post: jest.Mock }).post;

function proposal(): MutationProposal<AiEvalProposalPayload> {
  return {
    proposalId: asMutationId('prop-1'),
    sourceRuleId: 'capture-broken',
    hypothesis: 'Lots of /ai-eval landings but very few capture — capture is broken.',
    kind: 'copy',
    payload: { targetKey: 'hero_heading', directive: 'rewrite', autoShipSafe: true },
    triggeringStats: { landed_count: 250, eval_started_count: 8, ratio: 0.032 },
  };
}

describe('NotionDigestTool.apply — search-before-create dedup', () => {
  const enricher = jest.fn().mockResolvedValue({ topHypotheses: ['h'], rankedFixes: [] });

  function tool(): NotionDigestTool {
    return new NotionDigestTool({ token: 'test-token', enricher });
  }

  beforeEach(() => {
    mockPost.mockReset();
    enricher.mockClear();
  });

  it('skips creation when an OPEN task already exists for the rule', async () => {
    mockPost.mockResolvedValueOnce({
      data: {
        results: [
          {
            id: 'existing-1',
            url: 'https://www.notion.so/existing-1',
            properties: { Status: { status: { name: 'To-do' } } },
          },
        ],
      },
    });

    const m = await tool().apply(proposal());

    expect(m.artifact.deduped).toBe(true);
    expect(m.artifact.notionPageId).toBe('existing-1');
    expect(m.error).toBeUndefined();
    // Only the search ran — no create POST, no Bedrock enrichment.
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(String(mockPost.mock.calls[0][0])).toContain('/query');
    expect(enricher).not.toHaveBeenCalled();
  });

  it('creates a task when no existing task is found', async () => {
    mockPost
      .mockResolvedValueOnce({ data: { results: [] } }) // search → none
      .mockResolvedValueOnce({ data: { id: 'new-1', url: 'https://www.notion.so/new-1' } }); // create

    const m = await tool().apply(proposal());

    expect(m.artifact.deduped).toBeUndefined();
    expect(m.artifact.notionPageId).toBe('new-1');
    expect(mockPost).toHaveBeenCalledTimes(2);
    expect(String(mockPost.mock.calls[0][0])).toContain('/query');
    expect(String(mockPost.mock.calls[1][0])).toContain('/pages');
    expect(enricher).toHaveBeenCalledTimes(1);
  });

  it('creates a fresh task when only a Done task exists (issue recurred)', async () => {
    mockPost
      .mockResolvedValueOnce({
        data: {
          results: [{ id: 'done-1', properties: { Status: { status: { name: 'Done' } } } }],
        },
      })
      .mockResolvedValueOnce({ data: { id: 'new-2', url: 'https://www.notion.so/new-2' } });

    const m = await tool().apply(proposal());

    expect(m.artifact.deduped).toBeUndefined();
    expect(m.artifact.notionPageId).toBe('new-2');
    expect(mockPost).toHaveBeenCalledTimes(2);
  });

  it('creates anyway when the dedup search fails (never blocks task creation)', async () => {
    mockPost
      .mockRejectedValueOnce(new Error('Notion API 500')) // search throws
      .mockResolvedValueOnce({ data: { id: 'new-3', url: 'https://www.notion.so/new-3' } });

    const m = await tool().apply(proposal());

    expect(m.artifact.notionPageId).toBe('new-3');
    expect(m.error).toBeUndefined();
    expect(mockPost).toHaveBeenCalledTimes(2);
  });
});
