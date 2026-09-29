/**
 * ENG-2189: instruction-adherence graders (requested length, requested format, acting when told
 * to) over real turn structure. Fixtures are synthetic; no customer data.
 */
import {
  adherenceRates,
  gradeAdherence,
  gradeFormatAdherence,
  gradeLengthAdherence,
  gradePermissionAdherence,
  gradeSession,
  isActInstruction,
  parseFormatRequest,
  parseLengthRequest,
  permissionRequest,
  type GraderTurn,
  type SessionForGrading,
} from '../loops/eval/agentGraders';
import { toTurns, buildLoadedSession } from '../loops/eval/agentGraderLoader';
import type { ResumeMessage } from '../services/agentMode/core/resumePlan';
import { wilsonInterval } from '../loops/eval/agreement';
import { getGrader, mayGate } from '../loops/eval/evalRegistry';

const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');
const turn = (userText: string, replyText?: string, toolNames: string[] = []): GraderTurn => ({
  userText,
  ...(replyText !== undefined ? { replyText } : {}),
  toolNames,
});

describe('parseLengthRequest', () => {
  it.each([
    ['Summarize this in 3 sentences.', { max: 3, unit: 'sentence' }],
    ['Explain it in one paragraph', { max: 1, unit: 'paragraph' }],
    ['Keep it under 100 words please', { max: 100, unit: 'word' }],
    ['Condense this down to maximum of 2 pages.', { max: 2, unit: 'page' }],
    ['no more than two paragraphs', { max: 2, unit: 'paragraph' }],
    ['Give me a 150-word summary of the report', { max: 150, unit: 'word' }],
    ['in a couple of sentences, what changed?', { max: 2, unit: 'sentence' }],
  ])('reads %p', (text, expected) => {
    expect(parseLengthRequest(text)).toEqual(expected);
  });

  it.each([
    'keep it short',
    'be concise and brief',
    'Write 3 LinkedIn posts, each under 100 words',
    'Give me 5 headline options in under 10 words',
    'in a word, yes',
    'what is the first sentence of the page?',
    `Task brief:\n${'- Research the market. '.repeat(50)}\n- Summarize the findings in one sentence.`,
  ])('ignores vague, per-item or non-limit text: %p', (text) => {
    expect(parseLengthRequest(text)).toBeUndefined();
  });
});

describe('gradeLengthAdherence', () => {
  it('is not applicable without an explicit length request', () => {
    expect(gradeLengthAdherence([turn('How are my ads doing?', words(900))])).toEqual({
      verdict: 'not_applicable',
      reason: 'no_length_request',
      applicableTurns: 0,
    });
  });

  it('passes within 1.5x the limit plus slack, and fails beyond it', () => {
    // 100 words -> fails above 175.
    expect(gradeLengthAdherence([turn('Answer in under 100 words', words(170))])).toMatchObject({ verdict: 'pass', reason: 'within_requested_length' });
    const over = gradeLengthAdherence([turn('Answer in under 100 words', words(240))]);
    expect(over).toEqual({
      verdict: 'fail',
      reason: 'exceeded_requested_length',
      applicableTurns: 1,
      detail: 'turn 1: 240 words vs <= 100 words (fails above 175)',
    });
  });

  it('measures pages as words (the ENG-1312 "maximum of 2 pages" case)', () => {
    expect(gradeLengthAdherence([turn('Condense this down to maximum of 2 pages.', words(1600))]).verdict).toBe('fail');
    expect(gradeLengthAdherence([turn('Condense this down to maximum of 2 pages.', words(1000))]).verdict).toBe('pass');
  });

  it('counts sentences and paragraphs in markdown and HTML replies', () => {
    const oneSentence = 'Your CTR rose 12% week over week.';
    const bulletDump = '## Summary\n- CTR rose.\n- CPC fell.\n- Spend flat.\n- Leads up.\n\nWant more detail?';
    expect(gradeLengthAdherence([turn('In one sentence, how did we do?', oneSentence)]).verdict).toBe('pass');
    expect(gradeLengthAdherence([turn('In one sentence, how did we do?', bulletDump)]).verdict).toBe('fail');
    const html = '<p>First.</p><p>Second.</p><ul><li>alpha beta</li><li>gamma delta</li></ul>';
    expect(gradeLengthAdherence([turn('in one sentence please', html)]).verdict).toBe('fail');
  });

  it('fails the session when any applicable turn fails, and never puts message text in the detail', () => {
    const r = gradeLengthAdherence([
      turn('Answer in under 100 words', words(50)),
      turn('now what?', words(2000)),
      turn('Answer in 2 sentences', 'One. Two. Three. Four. Five. Six.'),
    ]);
    expect(r).toMatchObject({ verdict: 'fail', reason: 'exceeded_requested_length', applicableTurns: 2 });
    expect(r.detail).toBe('turn 3: 6 sentences vs <= 2 sentences (fails above 5)');
  });

  it('is not applicable when the requested turn got no reply', () => {
    expect(gradeLengthAdherence([turn('Answer in under 100 words')])).toMatchObject({ verdict: 'not_applicable', reason: 'no_reply' });
  });

  it('checks every bound when the user gives more than one, failing if either is broken (CodeRabbit PR #3136, thread 4130329024)', () => {
    // Satisfies the sentence bound (2 <= 3) but breaks the word bound (240 > 75).
    const tooManyWords = gradeLengthAdherence([turn('Answer in 3 sentences and under 50 words.', 'One sentence here. ' + words(240))]);
    expect(tooManyWords).toMatchObject({ verdict: 'fail', reason: 'exceeded_requested_length' });
    expect(tooManyWords.detail).toContain('words vs <= 50 words');
    // Breaks the sentence bound (8 > 6, allowed for max 3) even though the word count is fine.
    const tooManySentences = gradeLengthAdherence([turn('Answer in 3 sentences and under 50 words.', 'One. Two. Three. Four. Five. Six. Seven. Eight.')]);
    expect(tooManySentences).toMatchObject({ verdict: 'fail', reason: 'exceeded_requested_length' });
    expect(tooManySentences.detail).toContain('sentences vs <= 3 sentences');
    // Satisfies both.
    expect(gradeLengthAdherence([turn('Answer in 3 sentences and under 50 words.', 'One. Two. Three.')]).verdict).toBe('pass');
  });

  // Adversarial pass beyond the CodeRabbit finding:
  it('is exact-boundary tolerant: right at the allowed slack passes, one word over fails', () => {
    // 10 words -> allowed = floor(10*1.5)+25 = 40.
    expect(gradeLengthAdherence([turn('Answer in under 10 words', words(40))]).verdict).toBe('pass');
    expect(gradeLengthAdherence([turn('Answer in under 10 words', words(41))]).verdict).toBe('fail');
  });

  it('does not conflate an unrelated number in the reply with the bound (only the user text is parsed)', () => {
    // The reply mentions "3 sentences" but the actual instruction was a word limit; only the
    // user's own text is ever parsed for a bound, never the reply.
    expect(gradeLengthAdherence([turn('Answer in under 100 words', 'I found 3 sentences worth flagging. ' + words(50))]).verdict).toBe('pass');
  });

  it('counts every 3 <p> elements as 3 paragraphs, not 1 (CodeRabbit PR #3136, thread 4130329030)', () => {
    const threeParagraphs = '<p>Spend rose.</p><p>CTR held steady.</p><p>CPC fell slightly.</p>';
    expect(gradeLengthAdherence([turn('keep it to one paragraph', threeParagraphs)])).toMatchObject({ verdict: 'fail', reason: 'exceeded_requested_length' });
    // 2+ consecutive <br> is also a paragraph break, not just a line break.
    const brParagraphs = 'Spend rose.<br><br>CTR held steady.<br><br>CPC fell slightly.';
    expect(gradeLengthAdherence([turn('keep it to one paragraph', brParagraphs)])).toMatchObject({ verdict: 'fail', reason: 'exceeded_requested_length' });
    // A lone <br> is still just a line break within one paragraph.
    const oneParagraphSoftBreaks = 'Spend rose,<br>CTR held steady,<br>and CPC fell slightly.';
    expect(gradeLengthAdherence([turn('keep it to one paragraph', oneParagraphSoftBreaks)]).verdict).toBe('pass');
  });

  // Adversarial pass beyond the CodeRabbit finding:
  it('combines paragraph and word bounds in one instruction, both satisfied', () => {
    const html = '<p>Spend rose 12% this week.</p><p>CTR held at 3.1%.</p>';
    expect(gradeLengthAdherence([turn('in 2 paragraphs and under 30 words', html)]).verdict).toBe('pass');
  });
});

describe('format adherence', () => {
  it.each([
    ['Show me the results in a table', 'table'],
    ['can you put this in a comparison table?', 'table'],
    ['Give me the key points as bullet points', 'list'],
    ['summarize in bullets', 'list'],
  ])('reads %p', (text, kind) => {
    expect(parseFormatRequest(text)).toBe(kind);
  });

  it.each([
    'Add the rows to the table in my Google Sheet',
    'Create a table in Airtable for leads',
    'no bullet points please, just prose',
    "don't use a table",
    'What is a table stakes feature?',
    `${'Context line. '.repeat(80)} Show me the results in a table`,
  ])('ignores negated or external-target requests: %p', (text) => {
    expect(parseFormatRequest(text)).toBeUndefined();
  });

  const table = '| Campaign | CTR |\n| --- | --- |\n| A | 2% |';

  it('passes a markdown or HTML table and a markdown or HTML list', () => {
    expect(gradeFormatAdherence([turn('Show me the results in a table', `Here you go:\n\n${table}`)])).toMatchObject({ verdict: 'pass', reason: 'format_followed' });
    expect(gradeFormatAdherence([turn('in a table please', '<table><tr><td>A</td></tr></table>')]).verdict).toBe('pass');
    expect(gradeFormatAdherence([turn('as bullet points', '- one\n- two')]).verdict).toBe('pass');
    expect(gradeFormatAdherence([turn('as bullet points', '<ul><li>one</li></ul>')]).verdict).toBe('pass');
  });

  it('fails when the requested format is missing', () => {
    expect(gradeFormatAdherence([turn('Show me the results in a table', 'Campaign A had a 2% CTR and B had 3%.')])).toEqual({
      verdict: 'fail',
      reason: 'table_missing',
      applicableTurns: 1,
      detail: 'turn 1',
    });
    expect(gradeFormatAdherence([turn('as bullet points', 'Just one paragraph of prose.')]).reason).toBe('list_missing');
  });

  it('is not applicable when a content-producing tool delivered the output', () => {
    expect(gradeFormatAdherence([turn('Show me the results in a table', 'Done, see the sheet.', ['create_google_sheet'])])).toMatchObject({
      verdict: 'not_applicable',
      reason: 'delivered_via_tool',
    });
    // A read-only tool does not deliver the format; the reply still must.
    expect(gradeFormatAdherence([turn('Show me the results in a table', 'CTR was 2%.', ['call_google_ads_reporting_api'])]).verdict).toBe('fail');
  });
});

describe('acting when told to', () => {
  it.each(['go ahead', 'Yes, do it', 'ok proceed', "Just do it, don't ask me again", 'You have my approval to change the targeting', 'Stop asking and run the audit'])(
    'reads an act instruction in %p',
    (text) => {
      expect(isActInstruction(text)).toBe(true);
    },
  );

  it.each(['how should we proceed?', "don't go ahead yet", 'before you proceed, tell me the cost', `${words(60)} proceed ${words(10)}`])(
    'ignores %p',
    (text) => {
      expect(isActInstruction(text)).toBe(false);
    },
  );

  it('finds a permission request, but not a which/what clarifying question', () => {
    expect(permissionRequest('Here is the plan. Shall I proceed?')).toBe('Shall I proceed?');
    expect(permissionRequest('Which ad account should I use?')).toBeUndefined();
    // A long deliverable ending in an offer of a next step is not a permission request.
    expect(permissionRequest(`${words(200)}. Want me to schedule it?`)).toBeUndefined();
    expect(permissionRequest('Got it. Want me to build the audience now?')).toBe('Want me to build the audience now?');
  });

  it('fails a turn that ran no work tool and asked permission after being told to act', () => {
    expect(gradePermissionAdherence([turn('go ahead', 'Great! Before I start, should I proceed with the keyword research?', ['create_work_plan'])])).toEqual({
      verdict: 'fail',
      reason: 'asked_permission_after_instruction',
      applicableTurns: 1,
      detail: 'turn 1',
    });
  });

  it('passes when the agent acted, asked only a clarifying question, or confirmed a consequential step', () => {
    expect(gradePermissionAdherence([turn('go ahead', 'Done: 40 keywords researched.', ['you_search_web'])]).reason).toBe('acted_without_asking');
    expect(gradePermissionAdherence([turn('go ahead', 'Which ad account should I use?')]).reason).toBe('acted_without_asking');
    expect(gradePermissionAdherence([turn('go ahead', 'To confirm: should I publish the post now?')]).reason).toBe('confirmed_consequential_action');
    expect(gradePermissionAdherence([turn('go ahead', 'Shall I proceed with raising the daily budget to $80?')]).verdict).toBe('pass');
  });

  it('is not applicable without an act instruction', () => {
    expect(gradePermissionAdherence([turn('what can you do?', 'Shall I proceed?')]).reason).toBe('no_act_instruction');
  });

  it('passes a tool-only turn (the agent acted and gave no separate reply text that turn) instead of no_reply (CodeRabbit PR #3136, thread 4129864014)', () => {
    expect(gradePermissionAdherence([turn('go ahead', undefined, ['create_ad_campaign'])])).toEqual({
      verdict: 'pass',
      reason: 'acted_without_asking',
      applicableTurns: 1,
    });
  });
});

describe('gradeAdherence and rates', () => {
  it('treats a session without turns as not applicable for every check', () => {
    const r = gradeAdherence(undefined);
    expect([r.length.verdict, r.format.verdict, r.permission.verdict]).toEqual(['not_applicable', 'not_applicable', 'not_applicable']);
  });

  it('reports each check with n, passes, a Wilson CI and the not-applicable count', () => {
    const results = [
      gradeAdherence([turn('in under 100 words', words(50))]),
      gradeAdherence([turn('in under 100 words', words(500))]),
      gradeAdherence([turn('in under 100 words', words(80))]),
      gradeAdherence([turn('hello', 'hi')]),
    ];
    const [length, format, permission] = adherenceRates(results);
    expect(length).toEqual({ graderId: 'agent-reply-length-adherence', n: 3, passes: 2, rate: 2 / 3, ci: wilsonInterval(2, 3), notApplicable: 1 });
    expect(format).toMatchObject({ graderId: 'agent-format-adherence', n: 0, rate: null, ci: null, notApplicable: 4 });
    expect(permission.graderId).toBe('agent-act-without-asking');
  });

  it('is part of every graded session and registered, unvalidated, so it cannot gate', () => {
    const session: SessionForGrading = {
      sessionId: 's-1',
      ledger: [],
      events: [],
      endsWithRunFailurePlaceholder: false,
      userTurns: 1,
      turns: [turn('Show me the results in a table', 'CTR was 2%.')],
    };
    expect(gradeSession(session, 'm', undefined).adherence.format.reason).toBe('table_missing');
    for (const id of ['agent-reply-length-adherence', 'agent-format-adherence', 'agent-act-without-asking']) {
      expect(getGrader(id)).toMatchObject({ surface: 'agent', graderType: 'code', modelFamily: 'none' });
      expect(getGrader(id)?.validation).toBeUndefined();
      expect(mayGate(id)).toBe(false);
    }
  });
});

describe('toTurns (AW-ChatMessages structure)', () => {
  const messages: ResumeMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'Show me the results in a table' },
    { role: 'assistant', content: 'Let me pull the numbers.', tool_calls: [{ id: 't1', function: { name: 'call_google_ads_reporting_api' } }] },
    { role: 'tool', tool_call_id: 't1', name: 'call_google_ads_reporting_api', content: '{"rows":[]}' } as ResumeMessage,
    { role: 'assistant', content: '| A | B |\n| --- | --- |\n| 1 | 2 |', metadata: { toolCalls: [] } },
    { role: 'user', content: [{ type: 'text', text: 'go ahead' }] },
    { role: 'assistant', content: 'Something went wrong, please retry.', metadata: { isRunFailureNotice: true } },
  ];

  it('splits on user messages, keeps the last genuine reply and the tools that ran', () => {
    expect(toTurns(messages)).toEqual([
      { userText: 'Show me the results in a table', replyText: '| A | B |\n| --- | --- |\n| 1 | 2 |', toolNames: ['call_google_ads_reporting_api'] },
      { userText: 'go ahead', toolNames: [] },
    ]);
  });

  it('is loaded onto the session from AW-ChatMessages rows', () => {
    const rows = messages.map((message, messageIndex) => ({ sessionId: 's-1', messageIndex, message }));
    const loaded = buildLoadedSession({ sessionId: 's-1' }, rows, [], undefined);
    expect(loaded.session.turns).toHaveLength(2);
    expect(gradeAdherence(loaded.session.turns).format).toMatchObject({ verdict: 'pass', reason: 'format_followed' });
  });

  it('resolves a missing tool-message name from the id it answers, via the assistant turn\'s tool_calls (CodeRabbit PR #3136, thread 4129864003)', () => {
    const withMissingName: ResumeMessage[] = [
      { role: 'user', content: 'go ahead' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'update_campaign_budget' } }] },
      // The stored tool message has no `name` of its own — ChatMessage.name is optional.
      { role: 'tool', tool_call_id: 'c1', content: '{"status":"ok"}' } as ResumeMessage,
      { role: 'assistant', content: 'Done, budget updated.' },
    ];
    expect(toTurns(withMissingName)).toEqual([
      { userText: 'go ahead', replyText: 'Done, budget updated.', toolNames: ['update_campaign_budget'] },
    ]);
  });

  it('also resolves it from metadata.toolCalls, the other shape a stored assistant turn uses', () => {
    // metadata.toolCalls entries carry `name` directly (see toLedger above), not ResumeMessage's
    // typed `function.name` — the same mismatch that row() sidesteps elsewhere in this suite.
    const withMissingName: ResumeMessage[] = [
      { role: 'user', content: 'go ahead' },
      { role: 'assistant', content: '', metadata: { toolCalls: [{ id: 'c1', name: 'update_campaign_budget' } as unknown as { id?: string; function?: { name?: string } }] } },
      { role: 'tool', tool_call_id: 'c1', content: '{"status":"ok"}' } as ResumeMessage,
      { role: 'assistant', content: 'Done, budget updated.' },
    ];
    expect(toTurns(withMissingName)[0].toolNames).toEqual(['update_campaign_budget']);
  });

  it('keeps a stored tool message name over a same-id assistant tool_call name, when both are present and differ', () => {
    const messages2: ResumeMessage[] = [
      { role: 'user', content: 'go ahead' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'wrong_name' } }] },
      { role: 'tool', tool_call_id: 'c1', name: 'actual_tool', content: '{}' } as ResumeMessage,
    ];
    expect(toTurns(messages2)[0].toolNames).toEqual(['actual_tool']);
  });

  it('credits a work tool run — and so passes an act instruction — even when the tool message itself has no name (downstream of the loader fix, CodeRabbit thread 4129864003)', () => {
    const withMissingName: ResumeMessage[] = [
      { role: 'user', content: 'go ahead' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'update_campaign_budget' } }] },
      { role: 'tool', tool_call_id: 'c1', content: '{"status":"ok"}' } as ResumeMessage,
      { role: 'assistant', content: 'Should I confirm the new budget with you?' },
    ];
    expect(gradePermissionAdherence(toTurns(withMissingName))).toMatchObject({ verdict: 'pass', reason: 'acted_without_asking' });
  });
});
