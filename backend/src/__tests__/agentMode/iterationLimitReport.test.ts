import { buildIterationLimitReport } from '../../services/agentMode/core/iterationLimitReport';

describe('iteration-limit receipt', () => {
  it('keeps all LP/branch identities and file paths, deduplicating repeated writes', () => {
    const write = { name: 'coding_agent', arguments: { page_id: 'lp-a' }, result: { success: true, branch: 'draft/a', filesChanged: ['src/App.tsx'] } };
    const text = buildIterationLimitReport('Still missing mobile verification.', [write, write, {
      name: 'update_html_file', arguments: { page_id: 'lp-b', file_path: 'index.html' }, result: { success: true, branch: 'draft/b' },
    }]);
    for (const id of ['lp-a', 'lp-b', 'draft/a', 'draft/b', 'src/App.tsx', 'index.html', '2 calls', 'mobile verification']) expect(text).toContain(id);
  });

  it('does not claim deferred, duplicate, failed, or read calls as completed writes', () => {
    const text = buildIterationLimitReport('', [
      { name: 'coding_agent', arguments: { page_id: 'deferred' }, result: { deferred: true } },
      { name: 'coding_agent', arguments: { page_id: 'duplicate' }, duplicateOf: 'original' },
      { name: 'coding_agent', arguments: { page_id: 'failed-lp' }, result: { success: false, branch: 'draft/partial' } },
      { name: 'read_html_file', arguments: { page_id: 'read-only' }, result: { success: true } },
    ]);
    expect(text).toContain('No completed tool writes');
    expect(text).toContain('Failed/uncertain writes may have partial effects');
    expect(text).toContain('draft/partial');
    expect(text).not.toContain('page_id: "deferred"');
    expect(text).not.toContain('page_id: "duplicate"');
    expect(text).not.toContain('read-only');
  });

  it('does not dump tool payloads and explicitly identifies unknown targets', () => {
    const text = buildIterationLimitReport('', [{ name: 'update_html_file', arguments: { html: 'SECRET-CONTENT' }, result: { success: true } }]);
    expect(text).not.toContain('SECRET-CONTENT');
    expect(text).toContain('target not returned');
    expect(text).toContain('How to resume');
  });
});
