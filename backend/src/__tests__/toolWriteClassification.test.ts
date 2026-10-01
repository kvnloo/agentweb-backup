import { isReadOnlyToolName, isWriteToolCall } from '../utils/toolWriteClassification';

describe('isReadOnlyToolName', () => {
  it('recognizes exact-name read-only tools whose names do not lead with a read verb', () => {
    expect(isReadOnlyToolName('you_search_web')).toBe(true);
    expect(isReadOnlyToolName('web_search')).toBe(true);
    expect(isReadOnlyToolName('perform_data_analysis')).toBe(true);
    expect(isReadOnlyToolName('account_summary')).toBe(true);
  });

  it('recognizes read-verb-prefixed tools', () => {
    expect(isReadOnlyToolName('get_marketing_tips')).toBe(true);
    expect(isReadOnlyToolName('read_knowledge_base_files')).toBe(true);
    expect(isReadOnlyToolName('list_schedules')).toBe(true);
    expect(isReadOnlyToolName('search_leads')).toBe(true);
    expect(isReadOnlyToolName('analyze_competitors')).toBe(true);
  });

  it('treats an unrecognized name as a write (fail-safe default)', () => {
    expect(isReadOnlyToolName('post_on_connected_account')).toBe(false);
    expect(isReadOnlyToolName('generate_image')).toBe(false);
    expect(isReadOnlyToolName('notify_session')).toBe(false);
    expect(isReadOnlyToolName('some_future_tool')).toBe(false);
  });

  it('does not mistake a write tool that merely CONTAINS a read word for a read', () => {
    expect(isReadOnlyToolName('add_leads_to_list')).toBe(false);
    expect(isReadOnlyToolName('create_lead_list')).toBe(false);
  });
});

describe('isWriteToolCall', () => {
  it('is true for a write tool call', () => {
    expect(isWriteToolCall({ name: 'post_on_connected_account' })).toBe(true);
  });

  it('is false for a read-only tool call', () => {
    expect(isWriteToolCall({ name: 'you_search_web' })).toBe(false);
  });

  it('is false for a malformed/nameless call', () => {
    expect(isWriteToolCall({})).toBe(false);
    expect(isWriteToolCall(null)).toBe(false);
  });
});
