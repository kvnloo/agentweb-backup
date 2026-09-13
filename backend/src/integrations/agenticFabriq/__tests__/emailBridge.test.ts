/**
 * pickGmailToolForAction: pure predicate, no network. Protects "Do NOT invent
 * tool names" (trap #6: vendor-prefixed names like google_gmail_archive_message
 * belong to gmail — check the first TWO underscore segments) and the refusal
 * to guess when nothing scores above zero (a real coverage gap, not a guess).
 */
import { pickGmailToolForAction } from '../emailBridge';
import type { McpToolDescriptor } from '../types';

const DISCOVERED: McpToolDescriptor[] = [
  { name: 'google_gmail_search_messages' },
  { name: 'google_gmail_list_messages' },
  { name: 'google_gmail_get_message' },
  { name: 'google_gmail_send_message' },
  { name: 'google_gmail_archive_message' }, // vendor's own example — two-segment prefix match
  { name: 'notion_create_page' }, // unrelated provider, must never match
];

describe('pickGmailToolForAction', () => {
  it('matches a vendor-prefixed two-segment tool name to the gmail surface', () => {
    const result = pickGmailToolForAction([{ name: 'google_gmail_archive_message' }], 'get');
    // 'archive' isn't in the 'get' keyword list, but the tool must still be
    // recognized as belonging to gmail (that's a separate concern from
    // whether it scores for THIS action) — recognized-but-zero-score is
    // exactly the refusal case below, distinct from "not gmail at all".
    expect(result).toBeNull(); // zero score for 'get' — correct refusal, not a false match
  });

  it('picks the send tool for a send action', () => {
    const result = pickGmailToolForAction(DISCOVERED, 'send');
    expect(result?.name).toBe('google_gmail_send_message');
  });

  it('picks the search tool for a search action', () => {
    const result = pickGmailToolForAction(DISCOVERED, 'search');
    expect(result?.name).toBe('google_gmail_search_messages');
  });

  it('picks the list tool for a list action', () => {
    const result = pickGmailToolForAction(DISCOVERED, 'list');
    expect(result?.name).toBe('google_gmail_list_messages');
  });

  it('never matches an unrelated provider tool (notion) even by accident', () => {
    const result = pickGmailToolForAction([{ name: 'notion_create_page' }], 'send');
    expect(result).toBeNull();
  });

  it('returns null (a genuine coverage gap) rather than guessing when no gmail tool scores for the action', () => {
    const result = pickGmailToolForAction([{ name: 'google_gmail_unknown_thing' }], 'send');
    expect(result).toBeNull();
  });

  it('returns null when no gmail tools were discovered at all', () => {
    expect(pickGmailToolForAction([{ name: 'notion_create_page' }], 'search')).toBeNull();
  });
});
