import { isWriteToolCall } from '../../../utils/toolWriteClassification';
import { toolCallNeverExecuted } from '../../../utils/toolCallOutcome';
import { toolResultError } from '../../../utils/toolResultError';

// Only identity fields, never source content, task text, credentials or raw results.
const TARGET_FIELDS = ['page_id', 'pageId', 'landingPageId', 'branch', 'draftBranch', 'file_path', 'filePath', 'path', 'filename', 'filesChanged', 'files_changed', 'previewUrl', 'file_name'];
function identities(value: any, toolName = ''): string[] {
  if (typeof value === 'string') {
    try { return identities(JSON.parse(value), toolName); } catch { return []; }
  }
  if (!value || typeof value !== 'object') return [];
  // `id` only identifies the target for landing-page tools; elsewhere it may be any record id.
  const fields = /landing_?page/i.test(toolName) ? [...TARGET_FIELDS, 'id'] : TARGET_FIELDS;
  return fields.flatMap((key) => {
    const field = value[key];
    const values = Array.isArray(field) ? field : [field];
    return values.filter((v): v is string => typeof v === 'string' && !!v.trim()).map(v => `${key}: ${JSON.stringify(v)}`);
  });
}

/** Deterministic receipt at the loop edge; model synthesis is supplementary, not proof. */
export function buildIterationLimitReport(content: string, calls: any[]): string {
  const completed = new Map<string, number>();
  const uncertain = new Set<string>();
  for (const call of calls) {
    if (!isWriteToolCall(call) || toolCallNeverExecuted(call)) continue;
    const target = [...new Set([...identities(call.arguments, call.name), ...identities(call.result, call.name)])].join(', ');
    const label = `${call.name}${target ? ` (${target})` : ' (target not returned; inspect this session’s tool history)'}`;
    if (call.error !== undefined || toolResultError(call.result)) uncertain.add(label);
    else completed.set(label, (completed.get(label) || 0) + 1);
  }
  return [
    'Iteration limit reached — this run stopped and will not be automatically retried.',
    '### What changed',
    completed.size ? [...completed].map(([label, count]) => `- Completed tool write: ${label}${count > 1 ? ` — ${count} calls` : ''}`).join('\n') : '- No completed tool writes were recorded in this run.',
    ...(uncertain.size ? ['- Failed/uncertain writes may have partial effects; inspect before repeating:', ...[...uncertain].map(label => `  - ${label}`)] : []),
    '### What remains',
    'The full request and final verification are not confirmed complete. Review the remaining edits and preview before publishing; completed writes above must not be repeated blindly.',
    ...(content.trim() ? ['Model summary (may be partial):', content] : []),
    '### How to resume',
    'Ask Yugo / engineering to review this session and the affected LP/branch above, then explicitly request continuation from the saved state with only the remaining edits and verification. Do not restart the whole task or auto-retry the exhausted run.',
  ].join('\n\n');
}
