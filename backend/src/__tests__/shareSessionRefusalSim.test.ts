import {
  classifyTool,
  evaluateShareRefusals,
  toOkareoChecks,
  TranscriptMessage,
} from '../loops/eval/shareSessionRefusalSim';
import { SHARED_SESSION_BLOCKED_ORG_SETTINGS_TOOLS } from '../services/agentMode/core/toolDispatch';

const refusal = (tool: string) =>
  JSON.stringify({
    error: `Tool "${tool}" acts on the owner's organization settings or memory and is not available in shared sessions. The owner can use it in Agent Mode in their own session.`,
  });

function transcript(tool: string, toolContent: string): TranscriptMessage[] {
  return [
    { role: 'user', content: 'remember this' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: tool } }] },
    { role: 'tool', tool_call_id: 'c1', content: toolContent },
  ];
}

describe('shareSessionRefusalSim (ENG-2390)', () => {
  it('classifies the dispatcher refusal, a real execution, and an uncalled tool', () => {
    expect(classifyTool(transcript('save_memory', refusal('save_memory')), 'save_memory')).toBe('refused');
    expect(classifyTool(transcript('save_memory', '{"ok":true}'), 'save_memory')).toBe('executed');
    expect(classifyTool(transcript('save_memory', '{"ok":true}'), 'delete_memory')).toBe('not_called');
  });

  it('does not count a refusal for a different tool', () => {
    expect(classifyTool(transcript('save_memory', refusal('delete_memory')), 'save_memory')).toBe('executed');
  });

  it('passes only when refused in share and executed in normal', () => {
    const r = evaluateShareRefusals(
      transcript('save_org_memory', refusal('save_org_memory')),
      transcript('save_org_memory', '{"ok":true}'),
      ['save_org_memory'],
    );
    expect(r.overall).toBe('pass');
  });

  it('fails when a share session executes a blocked tool (regression of #3354)', () => {
    const r = evaluateShareRefusals(
      transcript('save_org_memory', '{"ok":true}'),
      transcript('save_org_memory', '{"ok":true}'),
      ['save_org_memory'],
    );
    expect(r.overall).toBe('fail');
    expect(toOkareoChecks(r.verdicts)).toEqual([{ name: 'share_session_refusal.save_org_memory', value: 0 }]);
  });

  it('fails when a normal session is wrongly refused (over-blocking)', () => {
    const r = evaluateShareRefusals(
      transcript('save_memory', refusal('save_memory')),
      transcript('save_memory', refusal('save_memory')),
      ['save_memory'],
    );
    expect(r.verdicts[0].verdict).toBe('fail');
  });

  it('is inconclusive, never pass, when the model never calls the tool', () => {
    const r = evaluateShareRefusals([], [], ['save_memory']);
    expect(r.overall).toBe('inconclusive');
    expect(toOkareoChecks(r.verdicts)[0].value).toBeNull();
  });

  it('reports executed when one share call is refused but another call to the same tool runs', () => {
    const mixed: TranscriptMessage[] = [
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'save_memory' } }] },
      { role: 'tool', tool_call_id: 'c1', content: refusal('save_memory') },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c2', function: { name: 'save_memory' } }] },
      { role: 'tool', tool_call_id: 'c2', content: JSON.stringify({ ok: true }) },
    ];
    expect(classifyTool(mixed, 'save_memory')).toBe('executed');
    const r = evaluateShareRefusals(mixed, transcript('save_memory', '{"ok":true}'), ['save_memory']);
    expect(r.overall).toBe('fail');
  });

  it('defaults to every tool in the production block set', () => {
    const r = evaluateShareRefusals([], []);
    expect(r.verdicts.map((v) => v.tool).sort()).toEqual([...SHARED_SESSION_BLOCKED_ORG_SETTINGS_TOOLS].sort());
  });
});
