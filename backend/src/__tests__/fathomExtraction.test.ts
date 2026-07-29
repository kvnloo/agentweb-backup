/**
 * Tests for the deterministic Fathom → ExtractedActionItem extraction layer (ENG-259).
 *
 * The extractor turns a raw Fathom `recording.ready` webhook meeting payload into the
 * structured `FathomMeetingRef` + `ExtractedActionItem[]` the reconciliation engine
 * consumes. It is deliberately deterministic (no LLM): retries of the same payload MUST
 * produce identical output (ids included) so the engine's idempotency rail holds.
 */

import {
  extractMeetingActionItems,
} from '../services/fathomExtraction';

const baseMeeting = {
  id: 42,
  title: 'Baldwin Group weekly sync',
  created_at: '2026-07-28T10:00:00Z',
  url: 'https://fathom.video/calls/42',
  participants: [
    { name: 'Harsha', email: 'harsha@agentweb.pro' },
    { name: 'Jane', email: 'jane@baldwingroup.com' },
  ],
  action_items: [{ text: 'Fix the login bug on the portal' }],
};

describe('fathomExtraction — meeting reference', () => {
  it('throws a clear error when the meeting has no title', () => {
    expect(() => extractMeetingActionItems({ ...baseMeeting, title: undefined })).toThrow(/title/i);
  });

  it('uses the explicit recordingId param over the meeting id', () => {
    const { meeting } = extractMeetingActionItems(baseMeeting, 101);
    expect(meeting.recordingId).toBe('101');
  });

  it('falls back to the meeting id when no recordingId param is given', () => {
    const { meeting } = extractMeetingActionItems(baseMeeting);
    expect(meeting.recordingId).toBe('42');
  });

  it('derives a stable hash id when neither recordingId nor meeting id exist', () => {
    const noId = { ...baseMeeting, id: undefined };
    const a = extractMeetingActionItems(noId);
    const b = extractMeetingActionItems(noId);
    expect(a.meeting.recordingId).toBeTruthy();
    // Deterministic across retries — the idempotency invariant.
    expect(a.meeting.recordingId).toBe(b.meeting.recordingId);
  });

  it('maps title, url, date, and participants', () => {
    const { meeting } = extractMeetingActionItems(baseMeeting);
    expect(meeting.title).toBe('Baldwin Group weekly sync');
    expect(meeting.url).toBe('https://fathom.video/calls/42');
    expect(meeting.date).toBe('2026-07-28T10:00:00Z');
    expect(meeting.participants).toEqual(['harsha@agentweb.pro', 'jane@baldwingroup.com']);
  });

  it('handles string participants and participants without email', () => {
    const { meeting } = extractMeetingActionItems({
      ...baseMeeting,
      participants: ['someone@example.com', { name: 'John' }],
    });
    expect(meeting.participants).toEqual(['someone@example.com', 'John']);
  });
});

describe('fathomExtraction — action item ids (idempotency)', () => {
  it('uses the Fathom action-item id when present', () => {
    const { items } = extractMeetingActionItems({
      ...baseMeeting,
      action_items: [{ id: 'ai-9', text: 'Fix the login bug' }],
    });
    expect(items[0].id).toBe('ai-9');
  });

  it('falls back to a deterministic positional id', () => {
    const { items } = extractMeetingActionItems({
      ...baseMeeting,
      action_items: [{ text: 'Fix the login bug' }, { text: 'Send the onboarding email' }],
    });
    expect(items[0].id).toBe('item-0');
    expect(items[1].id).toBe('item-1');
  });

  it('keeps positional ids stable when an empty item is dropped', () => {
    const { items } = extractMeetingActionItems({
      ...baseMeeting,
      action_items: [{ text: '   ' }, { text: 'Send the onboarding email' }],
    });
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('item-1');
  });

  it('accepts plain-string action items', () => {
    const { items } = extractMeetingActionItems({
      ...baseMeeting,
      action_items: ['Fix the login bug'],
    });
    expect(items[0].action).toBe('Fix the login bug');
  });
});

describe('fathomExtraction — actionability (Harsha-owned or unassigned only)', () => {
  it('marks items assigned to someone other than Harsha as non-actionable FYI', () => {
    const { items } = extractMeetingActionItems({
      ...baseMeeting,
      action_items: [{ text: 'Fix the login bug', assignee: { name: 'Manan', email: 'manan@argusoft.com' } }],
    });
    expect(items[0].actionable).toBe(false);
  });

  it('keeps items explicitly assigned to Harsha actionable', () => {
    const { items } = extractMeetingActionItems({
      ...baseMeeting,
      action_items: [{ text: 'Fix the login bug', assignee: { name: 'Harsha', email: 'harsha@agentweb.pro' } }],
    });
    expect(items[0].actionable).toBe(true);
    expect(items[0].owner).toBe('Harsha');
  });

  it('keeps unassigned items actionable (Harsha-PM default)', () => {
    const { items } = extractMeetingActionItems(baseMeeting);
    expect(items[0].actionable).toBe(true);
  });

  it('marks pleasantries and confirmations as non-actionable', () => {
    const { items } = extractMeetingActionItems({
      ...baseMeeting,
      action_items: [{ text: 'Thanks, sounds good' }, { text: 'Great call everyone' }],
    });
    expect(items.every((i) => i.actionable === false)).toBe(true);
  });

  it('marks already-completed Fathom items as non-actionable', () => {
    const { items } = extractMeetingActionItems({
      ...baseMeeting,
      action_items: [{ text: 'Fix the login bug', completed: true }],
    });
    expect(items[0].actionable).toBe(false);
  });
});

describe('fathomExtraction — team classification (deterministic keywords)', () => {
  const itemFor = (text: string, extra: Record<string, unknown> = {}) => {
    const { items } = extractMeetingActionItems({
      ...baseMeeting,
      crm_matches: [],
      participants: [{ name: 'Harsha', email: 'harsha@agentweb.pro' }],
      action_items: [{ text }],
      ...extra,
    });
    return items[0];
  };

  it('classifies engineering work to ENG', () => {
    expect(itemFor('Fix the login bug in the API').team).toBe('ENG');
  });

  it('classifies marketing/demand-gen work to GROW', () => {
    expect(itemFor('Launch the retargeting campaign and refresh ad creative').team).toBe('GROW');
  });

  it('classifies customer-success work to CS', () => {
    expect(itemFor('Finish the onboarding walkthrough for the new account').team).toBe('CS');
  });

  it('classifies vendor/admin work to OPS', () => {
    expect(itemFor('Send the vendor invoice and renew the contract').team).toBe('OPS');
  });

  it('defaults to CS when no keywords match but a customer is resolved', () => {
    const { items } = extractMeetingActionItems({
      ...baseMeeting,
      crm_matches: [{ company: 'Baldwin Group' }],
      action_items: [{ text: 'Circle back with Jane next week' }],
    });
    expect(items[0].team).toBe('CS');
  });

  it('defaults to ENG when no keywords match and no customer is resolved', () => {
    expect(itemFor('Circle back next week').team).toBe('ENG');
  });

  it('records the matched keywords as workflow nouns for dedup matching', () => {
    const item = itemFor('Fix the login bug in the API');
    expect(item.workflowNouns).toEqual(expect.arrayContaining(['bug', 'api']));
  });
});

describe('fathomExtraction — customer resolution', () => {
  it('uses a single CRM match as the customer', () => {
    const { items } = extractMeetingActionItems({
      ...baseMeeting,
      crm_matches: [{ company: 'Baldwin Group' }],
    });
    expect(items[0].customer).toBe('Baldwin Group');
    expect(items[0].customerAmbiguous).toBeFalsy();
  });

  it('flags multiple distinct CRM companies as ambiguous (Needs PM, no write)', () => {
    const { items } = extractMeetingActionItems({
      ...baseMeeting,
      crm_matches: [{ company: 'Baldwin Group' }, { company: 'Haven AI' }],
    });
    expect(items[0].customerAmbiguous).toBe(true);
    expect(items[0].customer).toBeUndefined();
  });

  it('treats duplicate CRM entries for one company as unambiguous', () => {
    const { items } = extractMeetingActionItems({
      ...baseMeeting,
      crm_matches: [{ company: 'Baldwin Group' }, { name: 'baldwin group' }],
    });
    expect(items[0].customer).toBe('Baldwin Group');
    expect(items[0].customerAmbiguous).toBeFalsy();
  });

  it('falls back to a single external corporate participant domain', () => {
    const { items } = extractMeetingActionItems({ ...baseMeeting, crm_matches: undefined });
    expect(items[0].customer).toBe('baldwingroup');
  });

  it('does not guess when multiple external domains attend (undefined, not ambiguous)', () => {
    const { items } = extractMeetingActionItems({
      ...baseMeeting,
      crm_matches: undefined,
      participants: [
        { name: 'Harsha', email: 'harsha@agentweb.pro' },
        { name: 'Jane', email: 'jane@baldwingroup.com' },
        { name: 'Hugo', email: 'hugo@rankai.com' },
      ],
    });
    expect(items[0].customer).toBeUndefined();
    expect(items[0].customerAmbiguous).toBeFalsy();
  });

  it('ignores free-mail and internal domains in the fallback', () => {
    const { items } = extractMeetingActionItems({
      ...baseMeeting,
      crm_matches: undefined,
      participants: [
        { name: 'Harsha', email: 'harsha@agentweb.pro' },
        { name: 'H2', email: 'harsha@usethread.io' },
        { name: 'Someone', email: 'someone@gmail.com' },
      ],
    });
    expect(items[0].customer).toBeUndefined();
  });
});

describe('fathomExtraction — grounding and related issues', () => {
  it('extracts explicitly referenced Linear issue ids across all four boards', () => {
    const { items } = extractMeetingActionItems({
      ...baseMeeting,
      action_items: [{ text: 'Fold this into grow-6 and relate eng-236 for the API fix' }],
    });
    expect(items[0].relatedIssueIds).toEqual(['GROW-6', 'ENG-236']);
  });

  it('passes through a per-item timestamped grounding url when Fathom provides one', () => {
    const { items } = extractMeetingActionItems({
      ...baseMeeting,
      action_items: [{ text: 'Fix the login bug', recording_timestamp_url: 'https://fathom.video/calls/42?t=120' }],
    });
    expect(items[0].groundingUrl).toBe('https://fathom.video/calls/42?t=120');
  });

  it('returns no items for a meeting without action items', () => {
    const { items } = extractMeetingActionItems({ ...baseMeeting, action_items: undefined });
    expect(items).toEqual([]);
  });
});
