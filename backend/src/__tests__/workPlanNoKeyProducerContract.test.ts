import { readFileSync } from 'fs';
import { join } from 'path';

// ENG-2998: the scheduler consumes an exact marker, not arbitrary prose.
const tools = readFileSync(join(__dirname, '../emma/tools.ts'), 'utf8');
const service = readFileSync(join(__dirname, '../services/agentModeService.ts'), 'utf8');
const statusTool = tools.slice(tools.indexOf("name: 'set_work_plan_status'"), tools.indexOf("name: 'send_for_review'"));

describe('missing-key work-plan producer contract', () => {
  it('documents the exact no-key token on the status tool', () => {
    expect(statusTool).toContain('reason=no_key');
  });
  it('requires the missing-key step to stay pending instead of claiming success', () => {
    expect(statusTool).toContain('keep status pending');
  });
  it('instructs unattended producers to persist the exact marker', () => {
    expect(service).toContain('record reason=no_key in notes');
  });
  it('retains the existing persistence status enum', () => {
    expect(statusTool).toContain("enum: ['pending', 'completed', 'skipped']");
  });
});
