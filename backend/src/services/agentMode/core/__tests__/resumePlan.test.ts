import { planScheduledRunResume, ResumeMessage } from '../resumePlan';

/**
 * ENG-657: safe-boundary decision for resuming a scheduled run whose instance was
 * terminated mid-flight by an EB deploy. Resume ONLY when the persisted transcript
 * ends on a settled, balanced boundary — never when a tool_use is dangling (the
 * run may have died mid-side-effect, and re-driving it could double-apply).
 */
describe('planScheduledRunResume', () => {
  const sys: ResumeMessage = { role: 'system', content: 'You are an automated scheduled run.' };
  const user: ResumeMessage = { role: 'user', content: 'Enrich the CRM leads and draft outreach.' };
  const jobIncomplete: ResumeMessage = {
    role: 'assistant',
    content: "This scheduled run stopped before it could produce a response.",
    metadata: { jobIncomplete: true, isErrorMessage: true } as any,
  };

  // Mirrors the real prod shape (a6c1e2d5 / f71b5271): assistant fires N tool_calls,
  // every one gets a persisted tool result, then the process dies → reconciler
  // appends the jobIncomplete placeholder.
  const enrichThenResults = (): ResumeMessage[] => [
    sys,
    user,
    { role: 'assistant', content: 'Firing all 5 enrichment jobs now.', tool_calls: [
      { id: 'c1', function: { name: 'enrich_leads_execute' } },
      { id: 'c2', function: { name: 'enrich_leads_execute' } },
    ] },
    { role: 'tool', tool_call_id: 'c1', content: '{"mode":"enrich","processedCount":5}' },
    { role: 'tool', tool_call_id: 'c2', content: '{"mode":"enrich","processedCount":38}' },
  ];

  it('FAIL-CASE (invalid): empty transcript is not resumable', () => {
    const plan = planScheduledRunResume([]);
    expect(plan.resumable).toBe(false);
    expect(plan.reason).toBe('no_progress');
    expect(plan.resumeHistory).toBeUndefined();
  });

  it('FAIL-CASE (invalid): turnless crash ([system,user] only) is not resumable', () => {
    const plan = planScheduledRunResume([sys, user]);
    expect(plan.resumable).toBe(false);
    expect(plan.reason).toBe('no_progress');
  });

  it('FAIL-CASE (boundary): a dangling tool_use with no persisted result is NOT resumable', () => {
    // Died mid-tool-execution: assistant requested two tools, only one has a result.
    const msgs: ResumeMessage[] = [
      sys,
      user,
      { role: 'assistant', content: 'Enriching…', tool_calls: [
        { id: 'c1', function: { name: 'enrich_leads_execute' } },
        { id: 'c2', function: { name: 'enrich_leads_execute' } },
      ] },
      { role: 'tool', tool_call_id: 'c1', content: '{"mode":"enrich","processedCount":5}' },
      // c2 never got a result — the instance died here.
    ];
    const plan = planScheduledRunResume(msgs);
    expect(plan.resumable).toBe(false);
    expect(plan.reason).toBe('dangling_tool_call');
    expect(plan.resumeHistory).toBeUndefined();
  });

  it('FAIL-CASE (boundary): a fully-settled final assistant text turn is not resumable', () => {
    const msgs: ResumeMessage[] = [
      sys,
      user,
      { role: 'assistant', content: 'Here are the 10 recommended leads and 2 follow-ups. Done.' },
    ];
    const plan = planScheduledRunResume(msgs);
    expect(plan.resumable).toBe(false);
    expect(plan.reason).toBe('already_settled');
  });

  it('SUCCESS: transcript ending on a balanced tool result is resumable (the reported case)', () => {
    const msgs = enrichThenResults();
    const plan = planScheduledRunResume(msgs);
    expect(plan.resumable).toBe(true);
    expect(plan.reason).toBe('resumable_tool_boundary');
    expect(plan.resumeHistory).toEqual(msgs); // no trailing placeholder to strip
  });

  it('SUCCESS: strips the trailing reconciler jobIncomplete placeholder before resuming', () => {
    const msgs = [...enrichThenResults(), jobIncomplete];
    const plan = planScheduledRunResume(msgs);
    expect(plan.resumable).toBe(true);
    expect(plan.reason).toBe('resumable_tool_boundary');
    // The placeholder must NOT be part of the history fed back to the model.
    expect(plan.resumeHistory).toHaveLength(msgs.length - 1);
    expect(plan.resumeHistory!.some((m) => m.metadata?.jobIncomplete)).toBe(false);
    expect(plan.resumeHistory![plan.resumeHistory!.length - 1].role).toBe('tool');
  });

  it('SUCCESS: strips an ENG-473 isRunFailureNotice placeholder too', () => {
    const notice: ResumeMessage = {
      role: 'assistant',
      content: "This run didn't finish — please retry.",
      metadata: { isRunFailureNotice: true } as any,
    };
    const plan = planScheduledRunResume([...enrichThenResults(), notice]);
    expect(plan.resumable).toBe(true);
    expect(plan.resumeHistory!.some((m) => m.metadata?.isRunFailureNotice)).toBe(false);
  });

  it('SUCCESS: transcript ending on an unanswered injected user prompt is resumable', () => {
    const msgs: ResumeMessage[] = [
      sys,
      user,
      { role: 'assistant', content: 'Firing enrichment.', tool_calls: [{ id: 'c1', function: { name: 'enrich_leads_execute' } }] },
      { role: 'tool', tool_call_id: 'c1', content: '{"processedCount":5}' },
      { role: 'user', content: '[SYSTEM] Continue with the next step.' },
    ];
    const plan = planScheduledRunResume(msgs);
    expect(plan.resumable).toBe(true);
    expect(plan.reason).toBe('resumable_user_prompt');
  });

  it('handles tool calls mirrored under metadata.toolCalls (balanced) as resumable', () => {
    const msgs: ResumeMessage[] = [
      sys,
      user,
      { role: 'assistant', content: 'Enriching…', metadata: { toolCalls: [{ id: 'c1', function: { name: 'enrich_leads_execute' } }] } as any },
      { role: 'tool', tool_call_id: 'c1', content: '{"processedCount":5}' },
    ];
    const plan = planScheduledRunResume(msgs);
    expect(plan.resumable).toBe(true);
    expect(plan.reason).toBe('resumable_tool_boundary');
  });

  it('a placeholder-only session (no real progress) is not resumable after stripping', () => {
    const plan = planScheduledRunResume([sys, user, jobIncomplete]);
    expect(plan.resumable).toBe(false);
    expect(plan.reason).toBe('no_progress');
  });
});
